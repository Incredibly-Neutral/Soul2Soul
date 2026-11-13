// ============================================================================
// `s2s drafts fetch <ref>` — the row the ref means, the bytes behind it, and
// the note rebuilt from them.
//
// The chain is not here: the log read is the `DraftsSeam` fake `drafts-list`
// uses, the item fetch and the decrypt are seams of their own. What is under
// test is the CLI's own decisions — which row a ref names, which misses are
// errors that name the listing, that a refusal keeps the action's reason and
// nothing else, that a plaintext item is copied without asking Lit, and that the
// note it writes parses back into the item it came from.
// ============================================================================

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSignedContentItem,
  noOpEncrypt,
  parseMarkdownNote,
  bodyForKey,
  toBytes32Id,
  type AnyS2SContentItem,
} from '@s2s/soul2soul-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../src/core/context';
import { resolveDecryptActionCid } from '../src/core/context';
import type { DraftEntry, DraftsSeam, RawDraftEntry } from '../src/core/drafts';
import {
  DRAFT_SLUG_MAX,
  buildDraftNote,
  draftNoteSlug,
  readDraftContent,
  resolveDraftRef,
  type StoredDraftItem,
} from '../src/core/draft-content';
import { noteSigningInputs } from '../src/core/author';
import { runDraftsFetch } from '../src/commands/drafts-fetch';
import { CliError } from '../src/lib/errors';
import type { CliOut } from '../src/lib/out';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as const;
const DRAFTS = '0x0000000000000000000000000000000000000011' as const;
const FACTORY = '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' as const;
const RPC = 'http://127.0.0.1:8545';
const PKP = '0x' + 'ab'.repeat(32);
const AUTHOR = '0x1111111111111111111111111111111111111111' as const;

const BODY_CONTENT = '<p>the draft as the author wrote it</p>';
const BODY_DOCUMENT = JSON.stringify({
  title: 'My Draft',
  slug: 'my-draft',
  content: BODY_CONTENT,
  custom: {},
});
const CIPHERTEXT = JSON.stringify('gAAAAAB' + 'z'.repeat(40));

const GENESIS_0: `0x${string}` = `0x${'01'.repeat(32)}`;
const GENESIS_1: `0x${string}` = `0x${'02'.repeat(32)}`;

/** One row, as the paged read returns it. */
function entry(index: number, overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    genesis: index === 0 ? GENESIS_0 : GENESIS_1,
    cid: `bafy-draft-${String(index)}`,
    author: SAFE,
    timestamp: 1794589140 + index,
    versionCount: 1,
    ...overrides,
  };
}

function raw(index: number, overrides: Partial<RawDraftEntry> = {}): RawDraftEntry {
  const draft = entry(index);
  return {
    genesis: draft.genesis,
    author: SAFE,
    cid: draft.cid,
    timestamp: BigInt(draft.timestamp),
    versionCount: BigInt(draft.versionCount),
    ...overrides,
  };
}

/** The seam `drafts-list` fakes, with the module already enabled. */
function seam(log: RawDraftEntry[] = [raw(0), raw(1)]): DraftsSeam {
  return {
    readEnabled: () =>
      Promise.resolve({
        modules: [DRAFTS],
        byRole: { drafts: [DRAFTS], ownerHistory: [] },
        drafts: DRAFTS,
        ownerHistory: null,
      }),
    readModuleSafe: () => Promise.resolve(SAFE),
    readFactory: () =>
      Promise.resolve({ factory: FACTORY, drafts: null, ownerHistory: null, guard: null }),
    readCount: () => Promise.resolve(BigInt(log.length)),
    readPage: ({ offset, limit }) =>
      Promise.resolve(log.slice(Number(offset), Number(offset + limit))),
    readVersionCount: () => Promise.resolve(0n),
  };
}

/** A stored item: the public block, the encryption flag, the body under `bodies.s2s`. */
function storedItem(options: { encrypted?: boolean; label?: string; body?: string } = {}) {
  const encrypted = options.encrypted ?? true;
  return {
    public: {
      specVersion: '2',
      author: SAFE,
      creationDate: 1700000000,
      modifiedDate: 1700000600,
      ...(options.label === undefined ? {} : { label: options.label }),
    },
    encryption: encrypted,
    bodies: { s2s: options.body ?? (encrypted ? CIPHERTEXT : BODY_DOCUMENT) },
  };
}

/** The public input an upload signs, and the body document it signs with it. */
const PUB_INPUT = {
  specVersion: '2' as const,
  postType: 'post',
  mediaType: 'text/markdown',
  parent: '0',
  position: '0',
  publication: 'test',
  locale: 'en',
  creationDate: 1700000000,
  modifiedDate: 1700000600,
  base: 'my-draft',
  tags: ['s2s', 's2s/test'],
  label: 'My Draft',
};

const BODY_WITH_CUSTOM = JSON.stringify({
  title: 'My Draft',
  slug: 'my-draft',
  content: BODY_CONTENT,
  custom: { summary: '<p>the draft</p>', template: 'essay' },
});

/**
 * The item a real upload of that note produces, signed: the fixture the rebuild
 * is compared against, so the comparison is against the write path's output and
 * not against a hand-written object.
 */
let signedItem: Promise<StoredDraftItem> | undefined;
async function fullItem(): Promise<StoredDraftItem> {
  if (signedItem === undefined) {
    const body = JSON.parse(BODY_WITH_CUSTOM) as {
      title: string;
      slug: string;
      content: string;
      custom: Record<string, string>;
    };
    signedItem = buildSignedContentItem(PUB_INPUT, body, SIGNER, noOpEncrypt, SAFE).then(
      (signed) => signed as unknown as StoredDraftItem,
    );
  }
  return signedItem;
}

/** The signer `buildSignedContentItem` needs; the signature itself is not under test. */
const SIGNER = {
  getAddress: () => AUTHOR,
  signTypedData: () => Promise.resolve(`0x${'33'.repeat(65)}`),
};

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  human: string[];
  warnings: string[];
}

function capture(json = false): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json,
    log: () => undefined,
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) human.push(text);
    },
  };
  return { out, results, human, warnings };
}

interface ContextOptions {
  cap?: Captured;
  items?: Record<string, unknown>;
  decrypt?: (params: unknown) => Promise<string>;
  usageKey?: string | undefined;
}

function context(options: ContextOptions = {}) {
  const cap = options.cap ?? capture();
  const fetchFromKubo = vi.fn((cid: string) => {
    const item = options.items?.[cid];
    return item === undefined
      ? Promise.reject(new Error(`404 from the gateway for ${cid}`))
      : Promise.resolve(item);
  });
  const decrypt = vi.fn(options.decrypt ?? (() => Promise.resolve(BODY_DOCUMENT)));
  const signMessage = vi.fn((_message: string) => Promise.resolve('0xsigned'));

  const ctx = {
    out: cap.out,
    config: {
      author: { name: 'zomi' },
      contracts: { authorFactory: FACTORY },
      lit: { usageKey: 'usageKey' in options ? options.usageKey : 'lit-key' },
    },
    rpcs: { L1: [], L2: [RPC] },
    protocolInfo: { pkp: PKP },
    ipfs: { fetchFromKubo },
    lit: { decrypt },
    signer: { signMessage },
  } as unknown as CliContext;

  return { ctx, cap, fetchFromKubo, decrypt, signMessage };
}

const SAFE_STATE = () => Promise.resolve({ address: SAFE, deployed: true });

// ===========================================================================
// The ref
// ===========================================================================
describe('resolveDraftRef', () => {
  const drafts = [entry(0), entry(1)];

  it('takes the 1-based order `drafts list` prints', () => {
    expect(resolveDraftRef('2', drafts).entry).toBe(drafts[1]);
    expect(resolveDraftRef('1', drafts).order).toBe(1);
  });

  it('takes a bytes32 genesis', () => {
    expect(resolveDraftRef(GENESIS_1, drafts)).toEqual({ entry: drafts[1], order: 2 });
  });

  it('normalises any other id to the key the log holds', () => {
    const id = toBytes32Id('my-draft') as `0x${string}`;
    const known = [{ ...entry(0), genesis: id }];
    expect(resolveDraftRef('my-draft', known).entry.genesis).toBe(id);
  });

  it('refuses an order past the end, naming the listing', () => {
    expect(() => resolveDraftRef('3', drafts)).toThrow(/^no draft 3 in the author Safe's log/);
    let caught: unknown;
    try {
      resolveDraftRef('3', drafts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('no_such_draft');
    expect((caught as Error).message).toContain('the log holds 2 drafts');
    expect((caught as Error).message).toContain('s2s drafts list');
  });

  it('refuses order 0 and refuses an empty ref as usage', () => {
    expect(() => resolveDraftRef('0', drafts)).toThrow(/the log holds 2 drafts/);
    expect(() => resolveDraftRef('  ', drafts)).toThrow(/the ref is empty/);
  });

  it('refuses a genesis the log does not hold, naming the listing', () => {
    const unknown = `0x${'09'.repeat(32)}`;
    let caught: unknown;
    try {
      resolveDraftRef(unknown, drafts);
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).code).toBe('no_such_draft');
    expect((caught as Error).message).toContain(unknown);
    expect((caught as Error).message).toContain('s2s drafts list');
  });

  it('refuses a genesis the log knows with no versions: a zeroed row is not a draft', () => {
    const zeroed = [{ ...entry(0), versionCount: 0 }];
    expect(() => resolveDraftRef(GENESIS_0, zeroed)).toThrow(/^no draft/);
  });

  it('says the log holds none when it is empty', () => {
    expect(() => resolveDraftRef('1', [])).toThrow(/the log holds no drafts/);
  });
});

// ===========================================================================
// The read
// ===========================================================================
describe('readDraftContent', () => {
  it('signs the personal message, decrypts through the action, and returns the plaintext', async () => {
    const { ctx, decrypt, signMessage } = context({
      items: { 'bafy-draft-0': storedItem() },
    });

    const content = await readDraftContent(ctx, entry(0));

    expect(signMessage).toHaveBeenCalledWith('lit actions auth');
    expect(decrypt).toHaveBeenCalledWith('lit-key', {
      pkpId: PKP,
      genesis: GENESIS_0,
      authorSafe: SAFE,
      signature: '0xsigned',
      rpcs: { L1: [], L2: [RPC] },
    });
    expect(content.plaintext).toBe(BODY_DOCUMENT);
    expect(content.encrypted).toBe(true);
  });

  it('keeps the refusal the action gave, and nothing of the payload', async () => {
    const refusal = new Error(
      'decrypt refused: the signer was not an owner when this version landed',
    );
    const { ctx } = context({
      items: { 'bafy-draft-0': storedItem() },
      decrypt: () => Promise.reject(refusal),
    });

    let caught: unknown;
    try {
      await readDraftContent(ctx, entry(0));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('drafts_decrypt');
    expect((caught as Error).message).toContain('not an owner when this version landed');
    // The row is named, the reason is the action's; the ciphertext never is.
    expect((caught as Error).message).toContain('bafy-draft-0');
    expect((caught as Error).message).not.toContain('z'.repeat(40));
  });

  it('copies a plaintext item without asking the action', async () => {
    const { ctx, decrypt, signMessage } = context({
      items: { 'bafy-draft-0': storedItem({ encrypted: false }) },
    });

    const content = await readDraftContent(ctx, entry(0));

    expect(content.plaintext).toBe(BODY_DOCUMENT);
    expect(content.encrypted).toBe(false);
    expect(decrypt).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('owns a failed gateway read', async () => {
    const { ctx } = context();
    await expect(readDraftContent(ctx, entry(0))).rejects.toMatchObject({ code: 'drafts_item' });
  });

  it('refuses without a usage key, before it asks Lit', async () => {
    const { ctx, decrypt } = context({
      items: { 'bafy-draft-0': storedItem() },
      usageKey: undefined,
    });

    await expect(readDraftContent(ctx, entry(0))).rejects.toThrow(/LIT_USAGE_KEY/);
    expect(decrypt).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// The note
// ===========================================================================
describe('buildDraftNote', () => {
  it('names the note by the label, then the body document title, then the genesis', () => {
    const labelled = buildDraftNote({
      entry: entry(0),
      item: storedItem({ label: 'My Draft: A Story!' }),
      plaintext: BODY_DOCUMENT,
      encrypted: true,
    });
    expect(labelled.title).toBe('My Draft: A Story!');
    expect(labelled.slug).toBe('my-draft-a-story');
    // The heading is the signed title, not the label: the label names the file.
    expect(labelled.body.startsWith('# My Draft\n')).toBe(true);

    // No label: the body document's own title is the name, and it is the heading.
    const unlabelled = buildDraftNote({
      entry: entry(0),
      item: storedItem(),
      plaintext: BODY_DOCUMENT,
      encrypted: true,
    });
    expect(unlabelled.title).toBe('My Draft');
    expect(unlabelled.slug).toBe('my-draft');

    // Nothing names it at all: the file falls back to the genesis, and the note
    // writes no heading rather than inventing a hex one.
    const anonymous = buildDraftNote({
      entry: entry(0),
      item: storedItem(),
      plaintext: JSON.stringify({ slug: 'x', content: BODY_CONTENT }),
      encrypted: true,
    });
    expect(anonymous.title).toBe(GENESIS_0);
    expect(anonymous.body.startsWith('# ')).toBe(false);

    expect(draftNoteSlug('!!!')).toBe('draft');
  });

  it('caps the file stem so a long label cannot outrun the filesystem', () => {
    const slug = draftNoteSlug(`${'a very long title '.repeat(40)}end`);
    expect(slug.length).toBeLessThanOrEqual(DRAFT_SLUG_MAX);
    expect(slug.endsWith('-')).toBe(false);

    const note = buildDraftNote({
      entry: entry(0),
      item: storedItem({ label: 'x'.repeat(300) }),
      plaintext: BODY_DOCUMENT,
      encrypted: true,
    });
    expect(note.slug).toBe('x'.repeat(DRAFT_SLUG_MAX));
    // The title itself is uncut: only the file name is capped.
    expect(note.title).toBe('x'.repeat(300));
  });

  it('carries the frontmatter the uploader reads, in its own writer', () => {
    const note = buildDraftNote({
      entry: entry(0),
      item: storedItem({ label: 'My Draft' }),
      plaintext: BODY_DOCUMENT,
      encrypted: true,
    });

    expect(note.text.startsWith('---\n')).toBe(true);
    const block = note.text.slice(0, note.text.indexOf('\n---\n'));
    expect(block).toContain(`genesis: "${GENESIS_0}"`);
    expect(block).toContain('cid: bafy-draft-0');
    expect(block).toContain(`author: "${SAFE}"`);
    expect(block).toContain('creation_date: 2023-11-14T22:13:20');
    expect(block).toContain('modified_date: 2023-11-14T22:23:20');
    expect(block).toContain('encrypted: true');
    expect(block).not.toContain('kubo_cid');
    expect(note.body.startsWith('# My Draft\n')).toBe(true);
  });

  it('writes the public block and the template bag in the keys the parser reads', async () => {
    const note = buildDraftNote({
      entry: entry(0),
      item: await fullItem(),
      plaintext: BODY_WITH_CUSTOM,
      encrypted: false,
    });
    const block = note.text.slice(0, note.text.indexOf('\n---\n'));

    expect(block).toContain('post_type: post');
    expect(block).toContain('language: en');
    expect(block).toContain('label: My Draft');
    expect(block).toMatch(/tags:\n {2}- s2s\n {2}- s2s\/test/);
    expect(block).toContain('parent: "0"');
    expect(block).toContain('position: "0"');
    expect(block).toContain('summary: <p>the draft</p>');
    expect(block).toContain('template: essay');
  });

  it('parses back into the note the CLI uploads, and re-uploads as the same draft', async () => {
    const note = buildDraftNote({
      entry: entry(0),
      item: storedItem({ label: 'My Draft' }),
      plaintext: BODY_DOCUMENT,
      encrypted: true,
    });

    const parsed = await parseMarkdownNote(note.text, 'my-draft.md');
    expect(parsed.title).toBe('My Draft');
    expect(parsed.slug).toBe('my-draft');
    // The genesis is what makes the next upload an append to this row rather
    // than a new draft, and `encrypted` is what keeps it ciphertext.
    expect(parsed.genesis).toBe(GENESIS_0);
    expect(parsed.encryption).toBe(true);
    expect(parsed.content).toBe(BODY_CONTENT);
    expect(parsed.frontmatter.cid).toBe('bafy-draft-0');
    expect(parsed.custom).toEqual({});

    // And the item the uploader builds from it is the item that was read: the
    // body document is the same bytes, so the plaintext survives the round trip.
    const item = await buildSignedContentItem(
      {
        specVersion: '2',
        postType: parsed.postType,
        mediaType: 'text/markdown',
        parent: String(parsed.parent),
        position: String(parsed.position),
        publication: 'test',
        locale: parsed.locale,
        creationDate: 1700000000,
        modifiedDate: 1700000600,
        base: parsed.slug,
        tags: parsed.tags,
        attributes: undefined,
        label: parsed.label ?? undefined,
      },
      { title: parsed.title, slug: parsed.slug, content: parsed.content, custom: {} },
      {
        getAddress: () => AUTHOR,
        signTypedData: () => Promise.resolve(`0x${'33'.repeat(65)}`),
      },
      noOpEncrypt,
      AUTHOR,
    );
    expect(JSON.parse(bodyForKey(item as AnyS2SContentItem) ?? '')).toEqual(
      JSON.parse(BODY_DOCUMENT),
    );
  });

  it('re-uploads as the item it was read from: same public metadata, same body document', async () => {
    const item = await fullItem();
    const note = buildDraftNote({
      entry: entry(0),
      item,
      plaintext: BODY_WITH_CUSTOM,
      encrypted: false,
    });

    // The write path's own mapping, not a copy of it: parse the rebuilt note the
    // way `upload` parses it, hand the result to the same function `upload`
    // uses, and sign.
    const parsed = await parseMarkdownNote(note.text, `${note.slug}.md`);
    const { pub, body } = noteSigningInputs(parsed, {
      subdomain: PUB_INPUT.publication,
      creationDate: 1700000000,
      modifiedDate: 1700000600,
    });
    const rebuilt = await buildSignedContentItem(pub, body, SIGNER, noOpEncrypt, SAFE);

    // Public metadata: the whole stored block, field for field — post type,
    // locale, tags, parent, position, base, label, and the plaintext hash that
    // gives the manuscript its objectId. Equality here is what says this is the
    // same draft and not a similar one.
    expect(rebuilt.public).toEqual(item.public);
    expect(rebuilt.public.plaintextHash).toBe(item.public.plaintextHash);

    // Body document: title, slug, content and the custom bag, byte for byte.
    const signedBody = JSON.parse(bodyForKey(rebuilt) ?? '') as unknown;
    expect(signedBody).toEqual(JSON.parse(BODY_WITH_CUSTOM));
  });

  it('leaves a plaintext draft plaintext, so a re-upload does not encrypt it', async () => {
    const note = buildDraftNote({
      entry: entry(0),
      item: storedItem({ encrypted: false }),
      plaintext: BODY_DOCUMENT,
      encrypted: false,
    });
    const parsed = await parseMarkdownNote(note.text, 'my-draft.md');
    expect(parsed.encryption).toBe(false);
  });

  it('uses the plaintext as content when it is not a body document', () => {
    const note = buildDraftNote({
      entry: entry(0),
      item: storedItem({ encrypted: false, body: '# From another host\n\nits markdown' }),
      plaintext: '# From another host\n\nits markdown',
      encrypted: false,
    });
    // Its own heading is the title; nothing is prefixed above it.
    expect(note.title).toBe('From another host');
    expect(note.body).toBe('# From another host\n\nits markdown\n');
  });
});

// ===========================================================================
// The command
// ===========================================================================
describe('runDraftsFetch', () => {
  let before: string;
  let dir: string;

  beforeEach(() => {
    before = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 's2s-fetch-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes <title-slug>.md here, prints the path, and puts nothing else on stdout', async () => {
    const { ctx, cap } = context({
      items: { 'bafy-draft-1': storedItem({ label: 'My Draft' }) },
    });

    const result = await runDraftsFetch(ctx, '2', {}, { safeState: SAFE_STATE, seam: seam() });

    expect(result).toEqual({
      action: 'drafts.fetch',
      genesis: GENESIS_1,
      cid: 'bafy-draft-1',
      author: SAFE,
      path: 'my-draft.md',
      bytes: expect.any(Number) as number,
    });
    expect(cap.human).toEqual(['my-draft.md']);
    expect(readFileSync(join(dir, 'my-draft.md'), 'utf8')).toContain(`genesis: "${GENESIS_1}"`);
  });

  it('refuses to replace a note for another draft, and names the file', async () => {
    const elsewhere = `---\ngenesis: "${GENESIS_1}"\ncid: bafy-draft-1\n---\n\n# Theirs\n`;
    writeFileSync(join(dir, 'my-draft.md'), elsewhere);
    const { ctx } = context({ items: { 'bafy-draft-0': storedItem({ label: 'My Draft' }) } });

    await expect(
      runDraftsFetch(ctx, '1', {}, { safeState: SAFE_STATE, seam: seam() }),
    ).rejects.toThrow(/my-draft\.md: it already holds draft 0x/);
    // Nothing of theirs is touched, and --force is what the message names.
    expect(readFileSync(join(dir, 'my-draft.md'), 'utf8')).toBe(elsewhere);
  });

  it('refuses this draft at another version, and names both CIDs', async () => {
    const older = `---\ngenesis: "${GENESIS_0}"\ncid: bafy-older\n---\n\n# Mine, edited\n`;
    writeFileSync(join(dir, 'my-draft.md'), older);
    const { ctx } = context({ items: { 'bafy-draft-0': storedItem({ label: 'My Draft' }) } });

    await expect(
      runDraftsFetch(ctx, '1', {}, { safeState: SAFE_STATE, seam: seam() }),
    ).rejects.toThrow(/bafy-older.*bafy-draft-0/);
    expect(readFileSync(join(dir, 'my-draft.md'), 'utf8')).toBe(older);
  });

  it('overwrites either of them under --force', async () => {
    writeFileSync(join(dir, 'my-draft.md'), '---\ngenesis: "0xdead"\n---\n\n# Theirs\n');
    const { ctx } = context({ items: { 'bafy-draft-0': storedItem({ label: 'My Draft' }) } });

    await runDraftsFetch(ctx, '1', { force: true }, { safeState: SAFE_STATE, seam: seam() });

    expect(readFileSync(join(dir, 'my-draft.md'), 'utf8')).toContain(`genesis: "${GENESIS_0}"`);
  });

  it('rewrites a note that already holds this draft at this version without asking', async () => {
    const same = `---\ngenesis: "${GENESIS_0}"\ncid: bafy-draft-0\n---\n\n# Mine\n`;
    writeFileSync(join(dir, 'my-draft.md'), same);
    const { ctx } = context({ items: { 'bafy-draft-0': storedItem({ label: 'My Draft' }) } });

    await runDraftsFetch(ctx, '1', {}, { safeState: SAFE_STATE, seam: seam() });

    expect(readFileSync(join(dir, 'my-draft.md'), 'utf8')).toContain('# My Draft');
  });

  it('writes the path --out names', async () => {
    const { ctx } = context({ items: { 'bafy-draft-0': storedItem({ label: 'My Draft' }) } });
    const out = join(dir, 'nested', 'draft.md');

    const result = await runDraftsFetch(
      ctx,
      GENESIS_0,
      { out },
      { safeState: SAFE_STATE, seam: seam() },
    );

    expect(result.path).toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  it('prints the body and writes nothing with --stdout', async () => {
    const { ctx, cap } = context({ items: { 'bafy-draft-0': storedItem({ label: 'My Draft' }) } });

    const result = await runDraftsFetch(
      ctx,
      '1',
      { stdout: true },
      { safeState: SAFE_STATE, seam: seam() },
    );

    expect(result.path).toBeNull();
    expect(cap.human[0]).toBe(`# My Draft\n\n${BODY_CONTENT}`);
    expect(cap.results[0]).toMatchObject({ action: 'drafts.fetch', path: null });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses --json with --stdout: one stream cannot be an envelope and a body', async () => {
    const cap = capture(true);
    const { ctx, fetchFromKubo } = context({ cap, items: { 'bafy-draft-0': storedItem() } });

    await expect(
      runDraftsFetch(ctx, '1', { stdout: true }, { safeState: SAFE_STATE, seam: seam() }),
    ).rejects.toThrow(/--json/);
    // Refused before the read: nothing is fetched, nothing printed, nothing written.
    expect(fetchFromKubo).not.toHaveBeenCalled();
    expect(cap.results).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('counts the bytes it printed under --stdout, trailing newline excluded', async () => {
    const cap = capture();
    const { ctx } = context({ cap, items: { 'bafy-draft-0': storedItem() } });

    const result = await runDraftsFetch(
      ctx,
      '1',
      { stdout: true },
      { safeState: SAFE_STATE, seam: seam() },
    );

    expect(result.path).toBeNull();
    expect(result.bytes).toBe(Buffer.byteLength(cap.human[0] ?? '', 'utf8'));
    expect(cap.human[0]?.endsWith('\n')).toBe(false);
  });

  it('refuses --out with --stdout instead of choosing one', async () => {
    const { ctx } = context({ items: { 'bafy-draft-0': storedItem() } });
    await expect(
      runDraftsFetch(
        ctx,
        '1',
        { stdout: true, out: 'x.md' },
        { safeState: SAFE_STATE, seam: seam() },
      ),
    ).rejects.toThrow(/--stdout/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes nothing for a ref the log does not hold', async () => {
    const { ctx, fetchFromKubo } = context();
    await expect(
      runDraftsFetch(ctx, '9', {}, { safeState: SAFE_STATE, seam: seam() }),
    ).rejects.toMatchObject({ code: 'no_such_draft' });
    expect(fetchFromKubo).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ===========================================================================
// The decrypt action CID — config first, then the protocol record
// ===========================================================================
describe('resolveDecryptActionCid', () => {
  const config = (value: string | undefined) => ({ lit: { decryptActionCid: value } }) as never;
  const record = (value: string | undefined) =>
    ({ litActions: { prep: '', render: '', update: '', decrypt: value } }) as unknown as Parameters<
      typeof resolveDecryptActionCid
    >[1];

  it('takes the configured CID over the record', () => {
    expect(resolveDecryptActionCid(config('bafyconfig'), record('bafyrecord'))).toBe('bafyconfig');
  });

  it('falls back to the record, and to nothing when neither is written', () => {
    expect(resolveDecryptActionCid(config(undefined), record('bafyrecord'))).toBe('bafyrecord');
    expect(resolveDecryptActionCid(config(''), record(''))).toBeUndefined();
    expect(resolveDecryptActionCid(config(undefined), record(undefined))).toBeUndefined();
  });
});
