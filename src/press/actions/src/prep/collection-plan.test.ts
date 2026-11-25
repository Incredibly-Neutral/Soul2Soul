/**
 * prep/collection-plan.ts — the member pages a bundle gains and loses.
 *
 * The plan is pure, so the fixtures are real bodies and a real config: no
 * chain, no IPFS, and no mocked shared helper. `getTaskConfig` and `createPath`
 * are the ones prep uses, which is the point — a member's page must land where
 * the render would write it.
 */
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_MEDIA_TYPE,
  type CollectionBundleFields,
  type S2SCollectionItem,
  type S2SPublicationConfig,
} from '@s2s/soul2soul-shared/lit-actions';
import { planCollectionJobs } from './collection-plan';

const GENESIS = '0x' + 'aa'.repeat(32);

const config = (
  templates: S2SPublicationConfig['mapping']['templateConfig'] = [
    { reference: 'chapter', file: 'chapter.hbs', path: '/chapters/{slug}/' },
    { reference: 'post', file: 'post.hbs', path: '/posts/{slug}/' },
  ],
  localePaths: Record<string, string> = {},
): S2SPublicationConfig => ({
  assetsCid: '',
  contract: '',
  dataGateway: '',
  name: 'test.soul2soul.eth',
  templateCid: '',
  mapping: { templateConfig: templates, ripples: [] },
  localePaths,
});

const item = (
  key: string,
  slug: string,
  postType = 'chapter',
  overrides: Partial<S2SCollectionItem> = {},
): S2SCollectionItem => ({
  key,
  title: key,
  slug,
  content: `${key} body`,
  postType,
  ...overrides,
});

const bundle = (
  items: S2SCollectionItem[],
  overrides: Partial<CollectionBundleFields> = {},
): CollectionBundleFields => ({
  id: GENESIS,
  mediaType: COLLECTION_MEDIA_TYPE,
  postType: 'collection',
  locale: 'en',
  slug: 'genesis',
  title: 'Genesis',
  content: '',
  collection: { slug: 'genesis', items },
  ...overrides,
});

/**
 * What `getOldBody` actually hands prep: the stored body bytes, parsed. No
 * mediaType, no postType, no id — only the collection document and the page
 * fields the author wrote into the body.
 */
const stored = (items: S2SCollectionItem[]): Partial<CollectionBundleFields> => ({
  title: 'Genesis',
  slug: 'genesis',
  content: '',
  collection: { slug: 'genesis', items },
});

describe('planCollectionJobs — a new bundle', () => {
  it('gives every member the job its own template earns', () => {
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('one', 'one'), item('two', 'two')]),
      oldBody: null,
    });

    expect(remove).toEqual([]);
    expect(jobs.map((job) => job.id)).toEqual([`${GENESIS}:one`, `${GENESIS}:two`]);
    expect(jobs.map((job) => job.sourceId)).toEqual([GENESIS, GENESIS]);
    expect(jobs.map((job) => job.collectionKey)).toEqual(['one', 'two']);
    expect(jobs.map((job) => job.path)).toEqual(['/chapters/one/', '/chapters/two/']);
    expect(jobs.map((job) => job.templateConfig.reference)).toEqual(['chapter', 'chapter']);
    // This function plans members only; the bundle's own job is prep's.
    expect(jobs.map((job) => job.id)).not.toContain(GENESIS);
  });

  it('plans nothing for a container with no members', () => {
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([]),
      oldBody: null,
    });

    expect(jobs).toEqual([]);
    expect(remove).toEqual([]);
  });
});

describe('planCollectionJobs — removals', () => {
  it('removes the page of a member the new bundle dropped, and nothing else', () => {
    const oldBody = bundle([item('a', 'a'), item('b', 'b'), item('c', 'c')]);
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('a', 'a'), item('b', 'b')]),
      oldBody,
    });

    expect(jobs.map((job) => job.path)).toEqual(['/chapters/a/', '/chapters/b/']);
    expect(remove).toEqual([{ path: '/chapters/c/', replacedBy: GENESIS }]);
  });

  it('removes the old page of a member whose slug changed', () => {
    const oldBody = bundle([item('one', 'old-slug')]);
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('one', 'new-slug')]),
      oldBody,
    });

    expect(jobs.map((job) => job.path)).toEqual(['/chapters/new-slug/']);
    expect(remove).toEqual([{ path: '/chapters/old-slug/', replacedBy: GENESIS }]);
    expect(remove.map((entry) => entry.path)).not.toContain(jobs[0].path);
  });

  it('removes the page of a dropped member when the old body is the raw stored shape', () => {
    // getOldBody parses the stored body bytes, so the old body has a collection
    // document but no mediaType. The document's items are what mark it as a
    // bundle; the item carries the postType that named its template.
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('a', 'a')]),
      oldBody: stored([item('a', 'a'), item('b', 'b')]),
    });

    expect(jobs.map((job) => job.path)).toEqual(['/chapters/a/']);
    expect(remove).toEqual([{ path: '/chapters/b/', replacedBy: GENESIS }]);
  });

  it('removes a dropped member at its own locale prefix', () => {
    // The stored body has no locale of its own, and the shim does not supply
    // one: the item the CLI wrote carries it, so a de member is removed from
    // the de tree and not from the default (en) one.
    const { remove } = planCollectionJobs({
      config: config(undefined, { de: '/de' }),
      body: bundle([]),
      oldBody: stored([item('kapitel', 'kapitel', 'chapter', { locale: 'de' })]),
    });

    expect(remove).toEqual([{ path: '/de/chapters/kapitel/', replacedBy: GENESIS }]);
  });

  it('keeps the template the member rendered with, not the new bundle post type', () => {
    // The member inherits its postType from the old bundle when its item names
    // none; the old page is therefore resolved through the old bundle's
    // template, even though the new bundle carries a different one.
    const oldBody = bundle([{ ...item('one', 'one'), postType: undefined }], {
      postType: 'post',
    });
    const { remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('two', 'two')], { postType: 'collection' }),
      oldBody,
    });

    expect(remove).toEqual([{ path: '/posts/one/', replacedBy: GENESIS }]);
  });
});

describe('planCollectionJobs — an unmapped member', () => {
  it('plans no job and does not throw when its post type has no template', () => {
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('notes', 'notes', 'note')]),
      oldBody: null,
    });

    expect(jobs).toEqual([]);
    expect(remove).toEqual([]);
  });

  it('removes nothing for a member that never had a page', () => {
    const oldBody = bundle([item('notes', 'notes', 'note')]);
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('notes', 'notes', 'note')]),
      oldBody,
    });

    expect(jobs).toEqual([]);
    expect(remove).toEqual([]);
  });
});

describe('planCollectionJobs — a body that is not a container', () => {
  it('plans nothing even when the stored body was a container', () => {
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([], { mediaType: 'text/markdown' }),
      oldBody: bundle([item('a', 'a')]),
    });

    expect(jobs).toEqual([]);
    expect(remove).toEqual([]);
  });
});

describe('planCollectionJobs — removals are deduplicated', () => {
  it('emits one removal when two old members resolved to the same page', () => {
    const oldBody = bundle([item('a', 'shared'), item('b', 'shared')]);
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([]),
      oldBody,
    });

    expect(jobs).toEqual([]);
    expect(remove).toEqual([{ path: '/chapters/shared/', replacedBy: GENESIS }]);
  });

  it('never removes a path a new job occupies', () => {
    // One member moved off `/chapters/a/` while another moved onto it: the
    // removal would delete the page the second member's job is about to write.
    const oldBody = bundle([item('a', 'a')]);
    const { jobs, remove } = planCollectionJobs({
      config: config(),
      body: bundle([item('b', 'a')]),
      oldBody,
    });

    expect(jobs.map((job) => job.path)).toEqual(['/chapters/a/']);
    expect(remove).toEqual([]);
  });

  it('never removes the page the bundle itself is writing', () => {
    // The member that used to sit on the bundle's own page is gone; the bundle
    // job writes that path, so deleting it would erase the bundle.
    const { remove } = planCollectionJobs({
      config: config(),
      body: bundle([]),
      oldBody: bundle([item('a', 'genesis')]),
      bundlePath: '/chapters/genesis/',
    });

    expect(remove).toEqual([]);
  });
});
