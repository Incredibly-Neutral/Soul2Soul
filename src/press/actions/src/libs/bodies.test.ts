/**
 * Storage layout v3 — one body per key holder.
 *
 * A v3 item carries `bodies` (key holder name → ciphertext or stringified JSON)
 * and no `body` at all; a v1/v2 item carries the single `body`. Every press
 * reader resolves the body through `storedBody`, so:
 *
 *   - a v3 item and the legacy v2 item with the same signed envelope render to
 *     the same body text;
 *   - a v3 item's own second entry (a publication's key) is not what the press
 *     reads — `s2s` is;
 *   - an item with no `s2s` body at all fails exactly as a body-less item failed
 *     before: 'malformed-item', and 'unavailable' at the read-path boundary;
 *   - the encrypted verdict is unchanged ('unverifiable' / 'encrypted'), so the
 *     plaintextHash check still happens after decryption, and a plaintext item
 *     is still hashed against exactly the bytes in `bodies.s2s`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Wallet, TypedDataEncoder, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';

vi.mock('./evm', () => ({ evmRead: vi.fn() }));
vi.mock('./ipfs.factory', () => ({ catFile: vi.fn() }));

import {
  fetchById,
  fetchItemById,
  readItemByEntry,
  resetIntegrityWarningLatch,
  toBody,
  type Entry,
} from './module.factory';
import { evmRead } from './evm';
import { catFile } from './ipfs.factory';
import {
  inspectItemIntegrity,
  isValidContentItem,
  SKIP_REASON_RE,
  storedBody,
} from './item-integrity';
import { jcs } from '@s2s/soul2soul-shared/lit-actions';
import { buildSigningViewV2 } from '../../../../shared/dist/manuscript/identity/signing-view';
import { S2S_DOMAIN, S2S_TYPES_V2, toDidEthr } from '../../../../shared/dist/manuscript/types';

beforeAll(() => {
  vi.stubGlobal('ethers', {
    utils: {
      _TypedDataEncoder: { hash: TypedDataEncoder.hash },
      recoverAddress,
      keccak256,
      toUtf8Bytes,
    },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const AUTHOR = new Wallet('0x' + '21'.repeat(32));
const GENESIS = '0x' + 'bb'.repeat(32);
const GATEWAY = 'https://ipfs.example';
const PUBLICATION = '0xPubModule';
const entry: Entry = { genesis: GENESIS, author: AUTHOR.address, cid: 'bafyitem', timestamp: 1234 };

const bodyJson = jcs({ title: 'Hello', slug: 'hello', content: 'Hello', custom: {} });
const plaintextHash = keccak256(toUtf8Bytes(bodyJson));

const serve = (item: unknown): void => {
  vi.mocked(evmRead).mockImplementation((async (
    _chain: unknown,
    _module: unknown,
    _abi: unknown,
    method: string,
  ) => {
    if (method === 'getDeals') return [entry];
    if (method === 'getLatest') return entry;
    throw new Error(`unexpected chain read: ${method}`);
  }) as never);
  vi.mocked(catFile).mockResolvedValue(JSON.stringify(item));
};

/** The signed public block shared by the v2 and v3 fixtures (same envelope). */
const publicV2 = {
  specVersion: '2',
  author: toDidEthr(AUTHOR.address),
  postType: 'post',
  mediaType: 'text/markdown',
  parent: '',
  position: '0',
  publication: 'pub',
  locale: 'en',
  base: '',
  tags: [],
  attributes: {},
  creationDate: 1600000000,
  modifiedDate: 1700000100,
  plaintextHash,
};

/** Sign the envelope once, so v2 and v3 fixtures carry the SAME objectId + proof. */
const envelope = () => {
  const digest = TypedDataEncoder.hash(
    S2S_DOMAIN as never,
    S2S_TYPES_V2 as never,
    buildSigningViewV2(publicV2 as never),
  );
  return {
    objectId: digest,
    proof: {
      type: 'eip712' as const,
      signer: AUTHOR.address as `0x${string}`,
      signature: AUTHOR.signingKey.sign(digest).serialized as `0x${string}`,
    },
  };
};

/** Storage v3: `bodies`, no `body`. */
const mkItemV3 = (bodies: Record<string, string> = { s2s: bodyJson }, encryption = false) => ({
  public: publicV2,
  ...envelope(),
  encryption,
  bodies,
});

/** Storage v2: the legacy single `body`, same signed envelope. */
const mkItemV2 = (body = bodyJson, encryption = false) => ({
  public: publicV2,
  ...envelope(),
  encryption,
  body,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetIntegrityWarningLatch();
});

describe('storedBody — one accessor for both layouts', () => {
  it('reads bodies.s2s from a v3 item and body from a legacy item', () => {
    expect(storedBody(mkItemV3())).toBe(bodyJson);
    expect(storedBody(mkItemV2())).toBe(bodyJson);
  });

  it('returns undefined when the s2s entry is absent', () => {
    expect(storedBody(mkItemV3({}))).toBeUndefined();
    expect(storedBody(mkItemV3({ 'pub.eth': 'ciphertext-for-pub' }))).toBeUndefined();
    expect(storedBody({})).toBeUndefined();
  });

  it('falls back to a legacy body when bodies is present but is not a map', () => {
    // The shape gate accepts this on the legacy branch (a stray key beside a
    // body it does not model), so it must read like a legacy item rather than
    // throw out of the accessor.
    expect(storedBody({ body: bodyJson, bodies: null })).toBe(bodyJson);
    expect(storedBody({ body: bodyJson, bodies: 'nonsense' })).toBe(bodyJson);
    expect(storedBody({ body: bodyJson, bodies: [] })).toBe(bodyJson);
    expect(storedBody({ bodies: null })).toBeUndefined();
  });
});

describe('toBody — v3 and legacy v2 render the same body text', () => {
  it('renders identical flat bodies from the two storage layouts', () => {
    const fromV3 = toBody(entry, mkItemV3());
    const fromV2 = toBody(entry, mkItemV2());

    expect(fromV3.content).toBe('Hello');
    expect(fromV3.title).toBe('Hello');
    expect(fromV3.slug).toBe('hello');
    expect(fromV3.custom).toEqual({});
    expect(fromV3.encryption).toBe(false);

    expect(fromV3).toMatchObject({
      id: fromV2.id,
      author: fromV2.author,
      objectId: fromV2.objectId,
      plaintextHash: fromV2.plaintextHash,
      specVersion: fromV2.specVersion,
      creationDate: fromV2.creationDate,
      modifiedDate: fromV2.modifiedDate,
      encryption: fromV2.encryption,
      content: fromV2.content,
      title: fromV2.title,
      slug: fromV2.slug,
      custom: fromV2.custom,
    });
  });

  it('carries the ciphertext of bodies.s2s for an encrypted v3 item', () => {
    const fromV3 = toBody(entry, mkItemV3({ s2s: 'ciphertext-for-s2s' }, true));
    const fromV2 = toBody(entry, mkItemV2('ciphertext-for-s2s', true));

    expect(fromV3.encryption).toBe(true);
    expect(fromV3.content).toBe('ciphertext-for-s2s');
    expect(fromV3.content).toBe(fromV2.content);
  });

  it('reads the protocol key, never a publication key beside it', () => {
    const item = mkItemV3({ 'pub.eth': 'ciphertext-for-pub', s2s: bodyJson });

    expect(toBody(entry, item).content).toBe('Hello');
  });
});

describe('item-integrity — verdicts unchanged on a v3 item', () => {
  it('a plaintext v3 item verifies against bodies.s2s', () => {
    expect(inspectItemIntegrity(mkItemV3(), AUTHOR.address)).toMatchObject({
      level: 'verified',
      code: 'verified',
    });
  });

  it('an encrypted v3 item stays unverifiable/encrypted, so the hash check is skipped', () => {
    // The body cannot hash to the digest and must not be refused for it: the
    // check moves to just after decryption, exactly as for a v2 item.
    const forged = mkItemV3({ s2s: 'not-the-signed-bytes' }, true);

    expect(inspectItemIntegrity(forged, AUTHOR.address)).toMatchObject({
      level: 'unverifiable',
      code: 'encrypted',
    });
    expect(
      inspectItemIntegrity(mkItemV2('not-the-signed-bytes', true), AUTHOR.address),
    ).toMatchObject({ level: 'unverifiable', code: 'encrypted' });
  });

  it('a plaintext v3 item whose bodies.s2s bytes differ is a hash mismatch', () => {
    expect(inspectItemIntegrity(mkItemV3({ s2s: bodyJson + ' ' }), AUTHOR.address)).toMatchObject({
      level: 'mismatch',
      code: 'hash-mismatch',
    });
  });

  it('rejects an item with an empty or absent s2s body with the existing malformed-item verdict', () => {
    for (const item of [mkItemV3({}), mkItemV3({ 'pub.eth': 'x' })]) {
      expect(inspectItemIntegrity(item, AUTHOR.address)).toMatchObject({
        level: 'mismatch',
        code: 'malformed-item',
      });
    }
    // Same shape a missing `body` always produced.
    expect(
      inspectItemIntegrity({ public: publicV2, encryption: false }, AUTHOR.address),
    ).toMatchObject({ level: 'mismatch', code: 'malformed-item' });
  });

  it('a v3 item is a valid content item, and a body-less one is still unbalanced at the read path', async () => {
    serve(mkItemV3({}));
    expect(isValidContentItem(mkItemV3())).toBe(true);
    // bodies: {} passes the schema (a record), so the refusal comes from the
    // integrity verdict, as 'unavailable' — the same failure a body-less item
    // got before.
    expect(isValidContentItem(mkItemV3({}))).toBe(true);

    const read = await readItemByEntry(entry, GATEWAY);
    expect(read).toMatchObject({ ok: false, kind: 'unavailable' });
    if (!read.ok) {
      expect(read.reason).toMatch(SKIP_REASON_RE);
      expect(SKIP_REASON_RE.exec(read.reason)?.[1]).toBe('unavailable');
      expect(read.reason).toMatch(/malformed-item/);
    }
  });
});

describe('read path — a v3 item is served end to end', () => {
  it('fetchById renders the s2s body of a v3 item', async () => {
    serve(mkItemV3());

    const direct = await fetchById(GENESIS, PUBLICATION, [], GATEWAY);
    expect(direct).toMatchObject({ content: 'Hello', title: 'Hello', slug: 'hello' });
    await expect(fetchItemById(GENESIS, PUBLICATION, [], GATEWAY)).resolves.toBeDefined();
  });

  it('fetchById renders the legacy v2 item to the same body', async () => {
    serve(mkItemV2());

    const direct = await fetchById(GENESIS, PUBLICATION, [], GATEWAY);
    expect(direct).toMatchObject({ content: 'Hello', title: 'Hello', slug: 'hello' });
  });

  it('a v3 item with no s2s body fails the read with the existing unavailable error', async () => {
    serve(mkItemV3({}));

    await expect(fetchById(GENESIS, PUBLICATION, [], GATEWAY)).rejects.toThrow(/unavailable:/);
  });

  it('a legacy item carrying a stray `bodies: null` still serves its body', async () => {
    serve({ ...mkItemV2(), bodies: null });

    const direct = await fetchById(GENESIS, PUBLICATION, [], GATEWAY);
    expect(direct).toMatchObject({ content: 'Hello', title: 'Hello', slug: 'hello' });
  });
});
