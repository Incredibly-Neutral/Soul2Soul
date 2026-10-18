import { describe, expect, it } from 'vitest';

import { ensLink, ipfsLink, pagePathFor, previewLink } from './links';

describe('authoring/links', () => {
  it('previewLink builds a subdomain-gateway URL with the v1 label', () => {
    const cid = 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354';
    expect(previewLink(cid)).toBe(`https://${cid}.preview.transport-union.dev/`);
    expect(previewLink(cid, '/posts/hello')).toBe(
      `https://${cid}.preview.transport-union.dev/posts/hello`,
    );
  });

  it('ipfsLink builds a raw path URL', () => {
    expect(ipfsLink('QmExample', 'article.json')).toBe(
      'https://ipfs.transport-union.dev/ipfs/QmExample/article.json',
    );
  });

  it('ensLink builds a DNSLink prod URL', () => {
    expect(ensLink('acme.soul2soul.eth', '/posts/hello')).toBe(
      'https://acme.soul2soul.eth.link/posts/hello',
    );
  });

  it('pagePathFor strips a matching /ipfs/<cid> prefix but keeps unrelated paths', () => {
    const cid = 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354';
    expect(pagePathFor(`/ipfs/${cid}/posts/hello`, cid)).toBe('/posts/hello');
    expect(pagePathFor(`/ipfs/${cid}`, cid)).toBe('/');
    expect(pagePathFor('/posts/hello', cid)).toBe('/posts/hello');
  });
});
