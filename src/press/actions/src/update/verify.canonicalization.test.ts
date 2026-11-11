/**
 * update/verify.ts provenance gate — canonicalisation selection.
 *
 * Two things must hold at once:
 *   1. Pages already published (no `proof.canonicalization`, signed under the
 *      old stringify-with-key-array scheme) must still verify byte-identically.
 *      A frozen page captured from the pre-change renderer is the oracle.
 *   2. New pages are signed under JCS-RFC8785, so any nested field tamper —
 *      including ones the legacy scheme ignored — invalidates the signature.
 *
 * IPFS is replaced with a local HTTP stub for /api/v0/cat; no network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as ethers from 'ethers5';
import {
  canonicalizeProofPayloadLegacy,
  proofCanonicalizationOf,
  type S2SContentInfo,
  type S2SProtocolInfo,
} from '@s2s/soul2soul-shared/lit-actions';
import { extractHashableHtml } from '@s2s/soul2soul-shared/lit-actions';
import { pageIdentityOf, verifyPathAvailable, verifyProvenance } from './verify';
import { LEGACY_AUTHOR_PREFIX } from '../../../../shared/dist/manuscript/identity/author-address';
import { addAndSignMetadata } from '../render/metadata';
import {
  LEGACY_FIXTURE_HTML,
  LEGACY_FIXTURE_PKP,
  LEGACY_FIXTURE_PROOF_OPTIONS,
  LEGACY_FIXTURE_SCHEMA_WITHOUT_PROOF,
  LEGACY_FIXTURE_TO_SIGN,
} from './fixtures/legacy-page';

// verify.ts reads the Lit-runtime-injected global `ethers`.
(globalThis as unknown as { ethers: unknown }).ethers = ethers;

const PRIV = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('s2s-verify-test-key'));
const PKP = ethers.utils.computeAddress(new ethers.utils.SigningKey(PRIV).publicKey);
(globalThis as unknown as { Lit: unknown }).Lit = {
  Actions: { getPrivateKey: async () => PRIV },
};

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><title>t</title></head><body><h1>Hi</h1></body></html>`;

function jsonLdOf(html: string): Record<string, any> {
  const match = /<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/i.exec(html);
  if (!match) throw new Error('no JSON-LD found');
  return JSON.parse(match[1]) as Record<string, any>;
}

/** Rewrite the JSON-LD block in place (the block lives outside the hashed <html>). */
function rewriteJsonLd(html: string, mutate: (schema: Record<string, any>) => void): string {
  return html.replace(
    /(<script type="application\/ld\+json">\s*)([\s\S]*?)(\s*<\/script>)/i,
    (_all, open: string, body: string, close: string) => {
      const schema = JSON.parse(body) as Record<string, any>;
      mutate(schema);
      return open + JSON.stringify(schema, null, 2) + close;
    },
  );
}

// ── Local IPFS stub ─────────────────────────────────────────────────────────

const pages = new Map<string, string>();
let server: http.Server;
let gateway: string;

/** MFS tree for the path gate (files/read). */
const mfs = new Map<string, string>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/v0/files/read') {
      const body = mfs.get(url.searchParams.get('arg') ?? '');
      if (body === undefined) {
        res.statusCode = 500;
        res.end('no such path');
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(body);
      return;
    }
    if (url.pathname === '/api/v0/cat') {
      const body = pages.get(url.searchParams.get('arg') ?? '');
      if (body === undefined) {
        res.statusCode = 500;
        res.end('no such cid');
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(body);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  gateway = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let cidCounter = 0;
function publish(html: string): string {
  const cid = `bafyverifyfixture${String(++cidCounter).padStart(8, '0')}`;
  pages.set(cid, html);
  return cid;
}

// ── Frozen legacy page ──────────────────────────────────────────────────────

const LEGACY_SCHEMA = jsonLdOf(LEGACY_FIXTURE_HTML);
const LEGACY_GENESIS: string = LEGACY_SCHEMA.identifier;
const legacyCid = publish(LEGACY_FIXTURE_HTML);

describe('legacy pages — byte-identical verification', () => {
  it('the frozen page carries no canonicalization marker', () => {
    expect(LEGACY_SCHEMA.proof).not.toHaveProperty('canonicalization');
    expect(proofCanonicalizationOf(LEGACY_SCHEMA.proof)).toBe('LEGACY');
  });

  it('the legacy helper reproduces the exact bytes the old renderer signed', () => {
    expect(
      canonicalizeProofPayloadLegacy(
        LEGACY_FIXTURE_SCHEMA_WITHOUT_PROOF,
        LEGACY_FIXTURE_PROOF_OPTIONS,
      ),
    ).toBe(LEGACY_FIXTURE_TO_SIGN);
  });

  it('verifyProvenance still accepts an already-published page', async () => {
    await expect(
      verifyProvenance(legacyCid, LEGACY_GENESIS, LEGACY_FIXTURE_PKP, gateway),
    ).resolves.toMatchObject({ signed: true });
  });

  it('documents the legacy blind spot: a nested-only tamper goes undetected', async () => {
    // `dateCreated` never entered the legacy signed bytes, and the JSON-LD block
    // sits outside the hashed <html>…</html>, so nothing catches this.
    const tampered = rewriteJsonLd(LEGACY_FIXTURE_HTML, (schema) => {
      schema.author.dateCreated = '2030-12-31T23:59:59.000Z';
    });
    await expect(
      verifyProvenance(publish(tampered), LEGACY_GENESIS, LEGACY_FIXTURE_PKP, gateway),
    ).resolves.toMatchObject({ signed: true });
  });

  it('rejects a marker-less page carrying a fabricated author.proof (fail closed)', async () => {
    // The reviewer's exploit: the legacy canonicaliser signs a *skeleton* of
    // `author`, so an attacker can graft an arbitrary attestation onto an
    // already-signed page and it verifies. The marker decides the scheme, so a
    // page that carries specVersion-1 terms without it must be refused outright
    // rather than downgraded to the blind path.
    const forged = rewriteJsonLd(LEGACY_FIXTURE_HTML, (schema) => {
      schema.author.proof = {
        type: 'eip712',
        objectId: '0x' + 'de'.repeat(32),
        signer: '0x9999999999999999999999999999999999999999',
        signature: '0xforged',
      };
    });
    await expect(
      verifyProvenance(publish(forged), LEGACY_GENESIS, LEGACY_FIXTURE_PKP, gateway),
    ).rejects.toThrow(/Refusing page carrying specVersion-1 terms/);
  });

  it('rejects a marker-less page carrying an sdContent node (fail closed)', async () => {
    const forged = rewriteJsonLd(LEGACY_FIXTURE_HTML, (schema) => {
      schema.sdContent = {
        '@type': 'CreativeWork',
        identifier: '0x' + 'ab'.repeat(32),
        digestMethod: 'keccak256',
      };
    });
    await expect(
      verifyProvenance(publish(forged), LEGACY_GENESIS, LEGACY_FIXTURE_PKP, gateway),
    ).rejects.toThrow(/Refusing page carrying specVersion-1 terms/);
  });

  it('still accepts the unmodified marker-less page (no specVersion-1 terms)', async () => {
    // Backward compatibility is the whole point of keeping LEGACY around: the
    // fail-closed rule must not reject the pages that are already published.
    await expect(
      verifyProvenance(legacyCid, LEGACY_GENESIS, LEGACY_FIXTURE_PKP, gateway),
    ).resolves.toMatchObject({ signed: true });
  });

  it('rejects the legacy page under the wrong PKP', async () => {
    await expect(verifyProvenance(legacyCid, LEGACY_GENESIS, PKP, gateway)).rejects.toThrow(
      /Provenance sig mismatch/,
    );
  });

  it('rejects the legacy page under the wrong genesis', async () => {
    await expect(
      verifyProvenance(legacyCid, '0x' + '99'.repeat(32), LEGACY_FIXTURE_PKP, gateway),
    ).rejects.toThrow(/Genesis mismatch/);
  });
});

// ── The legacy page as a reusable CARRIER — the update gate ─────────────────
//
// The blind spot above is not merely "a nested field goes unchecked": because
// the body and the author address are outside the legacy signed bytes, a legacy page
// is a reusable carrier. An attacker takes the already-signed page, rewrites the
// body inside the hashed region, recomputes encoding.sha256, repoints
// author.identifier.value at a victim, and verifyProvenance still passes (the
// signature covers a skeleton). update/main.ts takes jobs verbatim behind
// canPublish only, and verifyPathAvailable used to allow a same-genesis
// overwrite — so ANY whitelisted publisher could graft arbitrary content onto a
// page claiming another author's DID.
//
// The gate now refuses to write a legacy-signed page at all: a free path may not
// receive one, and a legacy carrier already at the path may only be replaced by
// a CONTENT-BOUND (JCS) page for the same identifier. These are the reviewer's
// two probes, plus the rules around them.

describe('legacy carrier — the update gate refuses grafted content', () => {
  const DEST = '/pub/some/page/index.html';
  // Never reached by these cases (every rule fires before the hasDeal RPC), but
  // the gate needs a module address.
  const PUB_MODULE = '0x' + '11'.repeat(20);

  /** Recompute the schema's claimed body digest after a body rewrite. */
  const rehash = (html: string): string => {
    const digest = ethers.utils
      .sha256(ethers.utils.toUtf8Bytes(extractHashableHtml(html)))
      .replace('0x', '');
    return rewriteJsonLd(html, (schema) => {
      schema.encoding.sha256 = digest;
    });
  };

  beforeEach(() => {
    mfs.set(DEST, LEGACY_FIXTURE_HTML);
  });

  it('PROBE 1 — verifyProvenance still passes a swapped body (the hole is in verify, not here)', async () => {
    const swapped = rehash(
      LEGACY_FIXTURE_HTML.replace('<h1>Hello</h1>', '<h1>Attacker content</h1>'),
    );
    // The signature covers a skeleton: the body rewrite is invisible to it.
    await expect(
      verifyProvenance(publish(swapped), LEGACY_GENESIS, LEGACY_FIXTURE_PKP, gateway),
    ).resolves.toMatchObject({ signed: true, canonicalization: 'LEGACY' });
  });

  it('PROBE 1 — the gate refuses that body swap', async () => {
    const swapped = rehash(
      LEGACY_FIXTURE_HTML.replace('<h1>Hello</h1>', '<h1>Attacker content</h1>'),
    );
    const incoming = pageIdentityOf(jsonLdOf(swapped));
    await expect(
      verifyPathAvailable(gateway, DEST, LEGACY_GENESIS, PUB_MODULE, [], incoming),
    ).rejects.toThrow(/legacy-signed page/);
  });

  it('PROBE 2 — verifyProvenance still passes an author-address swap', async () => {
    const swappedAuthor = rewriteJsonLd(LEGACY_FIXTURE_HTML, (schema) => {
      schema.author.identifier.value = `${LEGACY_AUTHOR_PREFIX}0x9999999999999999999999999999999999999999`;
    });
    // author.identifier.value is not in the legacy signed bytes either.
    await expect(
      verifyProvenance(publish(swappedAuthor), LEGACY_GENESIS, LEGACY_FIXTURE_PKP, gateway),
    ).resolves.toMatchObject({ signed: true, canonicalization: 'LEGACY' });
  });

  it('PROBE 2 — the gate refuses that author-address swap', async () => {
    const swappedAuthor = rewriteJsonLd(LEGACY_FIXTURE_HTML, (schema) => {
      schema.author.identifier.value = `${LEGACY_AUTHOR_PREFIX}0x9999999999999999999999999999999999999999`;
    });
    const incoming = pageIdentityOf(jsonLdOf(swappedAuthor));
    await expect(
      verifyPathAvailable(gateway, DEST, LEGACY_GENESIS, PUB_MODULE, [], incoming),
    ).rejects.toThrow(/legacy-signed page/);
  });

  it('refuses a DIFFERENT content item over a legacy carrier (no deal check needed)', async () => {
    // A distinct genesis at a path occupied by a legacy page: previously allowed
    // whenever the old genesis had no active deal, i.e. the legacy page could be
    // replaced by arbitrary new content.
    await expect(
      verifyPathAvailable(gateway, DEST, '0x' + '99'.repeat(32), PUB_MODULE, [], null),
    ).rejects.toThrow(/immutable carrier/);
  });

  it('refuses to introduce a legacy-signed page on a FREE path', async () => {
    const incoming = pageIdentityOf(jsonLdOf(LEGACY_FIXTURE_HTML));
    await expect(
      verifyPathAvailable(
        gateway,
        '/pub/empty/page/index.html',
        LEGACY_GENESIS,
        PUB_MODULE,
        [],
        incoming,
      ),
    ).rejects.toThrow(/Refusing to write a legacy-signed page/);
  });

  it('accepts a content-bound (JCS) re-render of the same content item', async () => {
    // The migration path must stay open: a legacy page may be replaced by the
    // SAME content item rendered today (JCS covers identifier, author and body).
    const html = await addAndSignMetadata(LEGACY_GENESIS, PAGE, PROTOCOL_INFO, contentInfo());
    const incoming = pageIdentityOf(jsonLdOf(html));
    expect(incoming.canonicalization).toBe('JCS-RFC8785');
    // The pinned page names the author in the pre-change form (a pre-change
    // artifact); the re-render names it as a bare address. Both are read as the
    // SAME address: the identity is the address, not the term or the form.
    expect(incoming.authorDid).toBe('0x1111111111111111111111111111111111111111');
    expect(pageIdentityOf(jsonLdOf(LEGACY_FIXTURE_HTML)).authorDid).toBe(
      '0x1111111111111111111111111111111111111111',
    );
    await expect(
      verifyPathAvailable(gateway, DEST, LEGACY_GENESIS, PUB_MODULE, [], incoming),
    ).resolves.toBeUndefined();
  });

  it('still allows an ordinary JCS overwrite of an ordinary page (no legacy in play)', async () => {
    const html = await addAndSignMetadata(
      '0x' + '77'.repeat(32),
      PAGE,
      PROTOCOL_INFO,
      contentInfo(),
    );
    mfs.set(DEST, html);
    await expect(
      verifyPathAvailable(
        gateway,
        DEST,
        '0x' + '77'.repeat(32),
        PUB_MODULE,
        [],
        pageIdentityOf(jsonLdOf(html)),
      ),
    ).resolves.toBeUndefined();
  });
});

// ── Fresh JCS pages ─────────────────────────────────────────────────────────

const PROTOCOL_INFO = {
  pkp: PKP,
  litActions: { render: 'ipfs://bafkreirenderaction' },
} as unknown as S2SProtocolInfo;

const contentInfo = (overrides: Partial<S2SContentInfo> = {}): S2SContentInfo => ({
  author: {
    address: '0x1111111111111111111111111111111111111111',
    createdAt: '2025-01-02T03:04:05.000Z',
    proof: {
      type: 'eip712',
      objectId: '0x' + 'de'.repeat(32),
      signer: '0x9999999999999999999999999999999999999999',
      signature: '0xsig',
    },
  },
  publisher: {
    address: '0x2222222222222222222222222222222222222222',
    url: 'https://example.org',
  },
  contentCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  plaintextHash: '0x' + 'ab'.repeat(32),
  mediaType: 'text/markdown',
  specVersion: '1',
  ...overrides,
});

async function renderPage(info: S2SContentInfo): Promise<string> {
  return addAndSignMetadata('0x' + '77'.repeat(32), PAGE, PROTOCOL_INFO, info);
}

describe('JCS pages — render → verify round-trip', () => {
  it('accepts a freshly rendered page', async () => {
    const html = await renderPage(contentInfo());
    expect(jsonLdOf(html).sdContent).toBeDefined();
    await expect(
      verifyProvenance(publish(html), '0x' + '77'.repeat(32), PKP, gateway),
    ).resolves.toMatchObject({ signed: true });
  });

  it('rejects a nested-only tamper (sdContent.identifier)', async () => {
    const html = await renderPage(contentInfo());
    const tampered = rewriteJsonLd(html, (schema) => {
      schema.sdContent.identifier = '0x' + 'ff'.repeat(32);
    });
    await expect(
      verifyProvenance(publish(tampered), '0x' + '77'.repeat(32), PKP, gateway),
    ).rejects.toThrow(/Provenance sig mismatch/);
  });

  it('rejects a nested-only tamper (author.dateCreated)', async () => {
    const html = await renderPage(contentInfo());
    const tampered = rewriteJsonLd(html, (schema) => {
      schema.author.dateCreated = '2030-12-31T23:59:59.000Z';
    });
    await expect(
      verifyProvenance(publish(tampered), '0x' + '77'.repeat(32), PKP, gateway),
    ).rejects.toThrow(/Provenance sig mismatch/);
  });

  it('rejects an author.proof tamper', async () => {
    const html = await renderPage(contentInfo());
    const tampered = rewriteJsonLd(html, (schema) => {
      schema.author.proof.signature = '0xdeadbeef';
    });
    await expect(
      verifyProvenance(publish(tampered), '0x' + '77'.repeat(32), PKP, gateway),
    ).rejects.toThrow(/Provenance sig mismatch/);
  });

  it('accepts a freshly rendered page with no <html> tag', async () => {
    // The signed region and the verified region must be the same bytes even
    // when the whole document is the region (the block is prepended there).
    const html = await addAndSignMetadata(
      '0x' + '77'.repeat(32),
      '<div>fragment</div>',
      PROTOCOL_INFO,
      contentInfo(),
    );
    await expect(
      verifyProvenance(publish(html), '0x' + '77'.repeat(32), PKP, gateway),
    ).resolves.toMatchObject({ signed: true });
  });

  it('accepts a freshly rendered page with a doctype but no <html> tag', async () => {
    const html = await addAndSignMetadata(
      '0x' + '77'.repeat(32),
      '<!DOCTYPE html><body>fragment</body>',
      PROTOCOL_INFO,
      contentInfo(),
    );
    expect(jsonLdOf(html)).toHaveProperty('proof');
    await expect(
      verifyProvenance(publish(html), '0x' + '77'.repeat(32), PKP, gateway),
    ).resolves.toMatchObject({ signed: true });
  });

  it('accepts a page rendered with an undefined optional field', async () => {
    // JCS throws on undefined and the renderer's catch-all would have emitted
    // NO JSON-LD, which the update gate can never accept — so the page would be
    // un-updatable forever. Asserting verification closes that loop.
    const html = await addAndSignMetadata(
      '0x' + '77'.repeat(32),
      PAGE,
      PROTOCOL_INFO,
      contentInfo({
        isBasedOn: {
          genesis: '0x' + '44'.repeat(32),
          timestamp: '2025-01-01T00:00:00.000Z',
        } as unknown as S2SContentInfo['isBasedOn'],
      }),
    );
    await expect(
      verifyProvenance(publish(html), '0x' + '77'.repeat(32), PKP, gateway),
    ).resolves.toMatchObject({ signed: true });
  });

  it('still enforces the html sha256 and genesis gates', async () => {
    const html = await renderPage(contentInfo());
    const cid = publish(html);
    await expect(verifyProvenance(cid, '0x' + '99'.repeat(32), PKP, gateway)).rejects.toThrow(
      /Genesis mismatch/,
    );

    const htmlTampered = html.replace('<h1>Hi</h1>', '<h1>Tampered</h1>');
    await expect(
      verifyProvenance(publish(htmlTampered), '0x' + '77'.repeat(32), PKP, gateway),
    ).rejects.toThrow(/Provenance sig mismatch|Sha256 mismatch/);
  });
});

// ── Page identity — the address is read, not the term ───────────────────────

describe('pageIdentityOf — reads the address whichever term carries it', () => {
  const AUTHOR_SAFE = `0x${'11'.repeat(20)}`;

  it('reads the address from a page rendered today', () => {
    const identity = pageIdentityOf({
      author: {
        '@type': 'Person',
        identifier: {
          '@type': 'PropertyValue',
          propertyID: 'address',
          value: AUTHOR_SAFE,
        },
      },
    });
    expect(identity.authorDid).toBe(AUTHOR_SAFE);
  });

  it('reads the same address from a pinned page (a pre-change artifact)', () => {
    expect(pageIdentityOf(jsonLdOf(LEGACY_FIXTURE_HTML)).authorDid).toBe(AUTHOR_SAFE);
  });

  it('selects the PropertyValue that holds an address, never a sibling holding something else', () => {
    const identity = pageIdentityOf({
      author: {
        '@type': 'Person',
        identifier: [
          { '@type': 'PropertyValue', propertyID: 'other', value: 'not-an-address' },
          { '@type': 'PropertyValue', propertyID: 'address', value: AUTHOR_SAFE },
        ],
      },
    });
    expect(identity.authorDid).toBe(AUTHOR_SAFE);
  });
});
