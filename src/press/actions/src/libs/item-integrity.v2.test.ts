/**
 * v2 envelope — creationDate (genesis) + modifiedDate (this version).
 *
 * A v2 item signs S2SContentV2 (two dates where v1 had a single createdAt),
 * under the same domain. The verdict must pick the struct and the signing view
 * from `public.specVersion`, and the FULL read path must serve the result:
 *
 *   - a v2 item is served by the collection reader and the direct reader, and
 *     its flat body carries both signed dates;
 *   - its digest is NOT the v1 digest of the same values;
 *   - altering either signed date AFTER signing is a mismatch on both readers;
 *   - a v1 item keeps verifying under S2SContent, unchanged.
 *
 * Fixtures are minted exactly like the real mint (JCS body → keccak256 →
 * EIP-712 digest → real signature) and every tamper is applied after signing.
 * The items go through `fetchByPublicationDetailed` / `fetchById`, so the shape
 * gate (`isValidContentItem`, the shared schema union) runs on them too.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Wallet, TypedDataEncoder, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';

vi.mock('./evm', () => ({ evmRead: vi.fn() }));
vi.mock('./ipfs.factory', () => ({ catFile: vi.fn() }));

import {
  ContentIntegrityError,
  fetchById,
  fetchByPublicationDetailed,
  fetchItemById,
  resetIntegrityWarningLatch,
  type Entry,
} from './module.factory';
import { evmRead } from './evm';
import { catFile } from './ipfs.factory';
import { SKIP_REASON_RE, inspectItemIntegrity, isValidContentItem } from './item-integrity';
import { jcs } from '@s2s/soul2soul-shared/lit-actions';
import {
  buildSigningView,
  buildSigningViewV2,
} from '../../../../shared/dist/manuscript/identity/signing-view';
import {
  S2S_DOMAIN,
  S2S_TYPES,
  S2S_TYPES_V2,
  toDidEthr,
} from '../../../../shared/dist/manuscript/types';

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

const AUTHOR = new Wallet('0x' + '11'.repeat(32));
const GENESIS = '0x' + 'aa'.repeat(32);
const entry: Entry = { genesis: GENESIS, author: AUTHOR.address, cid: 'bafyitem', timestamp: 1234 };
const GATEWAY = 'https://ipfs.example';
const PUBLICATION = '0xPubModule';

/** Serve one item over both chain reads: getDeals (collection) and getLatest (direct). */
const serve = (item: unknown, e: Entry = entry): void => {
  vi.mocked(evmRead).mockImplementation((async (
    _chain: unknown,
    _module: unknown,
    _abi: unknown,
    method: string,
  ) => {
    if (method === 'getDeals') return [e];
    if (method === 'getLatest') return e;
    throw new Error(`unexpected chain read: ${method}`);
  }) as never);
  vi.mocked(catFile).mockResolvedValue(JSON.stringify(item));
};

const bodyJson = jcs({ title: 't', slug: 's', content: 'c' });
const plaintextHash = keccak256(toUtf8Bytes(bodyJson));

/** The fields both envelope versions share. */
const commonPublic = {
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
  plaintextHash,
};

const signatureOf = (digest: string) => AUTHOR.signingKey.sign(digest).serialized;

/** Mint a genuine v2 item, then optionally tamper with a signed date. */
const mkItemV2 = (tamper?: 'creationDate' | 'modifiedDate') => {
  const pub: Record<string, unknown> = {
    specVersion: '2',
    ...commonPublic,
    creationDate: 1600000000,
    modifiedDate: 1700000100,
  };
  const digest = TypedDataEncoder.hash(
    S2S_DOMAIN as never,
    S2S_TYPES_V2 as never,
    buildSigningViewV2(pub as never),
  );
  const item = {
    public: pub,
    objectId: digest,
    proof: { type: 'eip712', signer: AUTHOR.address, signature: signatureOf(digest) },
    encryption: false,
    body: bodyJson,
  };
  // Applied AFTER signing: the signature still covers the original dates.
  if (tamper === 'creationDate') pub.creationDate = 1600000000 + 1;
  if (tamper === 'modifiedDate') pub.modifiedDate = 1700000100 + 1;
  return item;
};

/** Mint a genuine v1 item (single createdAt) for the no-regression case. */
const mkItemV1 = () => {
  const pub: Record<string, unknown> = { specVersion: '1', ...commonPublic, createdAt: 1700000000 };
  const digest = TypedDataEncoder.hash(
    S2S_DOMAIN as never,
    S2S_TYPES as never,
    buildSigningView(pub as never),
  );
  return {
    public: pub,
    objectId: digest,
    proof: { type: 'eip712', signer: AUTHOR.address, signature: signatureOf(digest) },
    encryption: false,
    body: bodyJson,
  };
};

beforeEach(() => {
  resetIntegrityWarningLatch();
});

describe('v2 envelope — full read path', () => {
  it('serves a genuine v2 item, with both signed dates on the flat body', async () => {
    const item = mkItemV2();
    serve(item);

    const { bodies, items, skips } = await fetchByPublicationDetailed(PUBLICATION, [], GATEWAY);
    expect(skips).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      specVersion: '2',
      creationDate: '1600000000', // genesis signing time
      modifiedDate: '1700000100', // this version's signing time
    });
    // the archive seed carries the same canonical item, unmangled
    expect(items.get(GENESIS)?.public).toMatchObject({ creationDate: 1600000000, modifiedDate: 1700000100 });
    // The shape gate is the shared schema union, so a v2 item passes it as v2
    // (the legacy patch only fires for items with no specVersion).
    expect(isValidContentItem(item)).toBe(true);
    expect(inspectItemIntegrity(item, AUTHOR.address)).toMatchObject({
      level: 'verified',
      code: 'verified',
    });

    const direct = await fetchById(GENESIS, PUBLICATION, [], GATEWAY);
    expect(direct).toMatchObject({ creationDate: '1600000000', modifiedDate: '1700000100' });
    await expect(fetchItemById(GENESIS, PUBLICATION, [], GATEWAY)).resolves.toBeDefined();
  });

  it('a v2 digest is not the v1 digest of the same values', () => {
    // Same key, same values, other struct: the type hash differs, which is what
    // lets v1 and v2 items coexist under one domain.
    const item = mkItemV2();
    const { creationDate, modifiedDate, ...rest } = item.public as Record<string, any>;
    const v1Digest = TypedDataEncoder.hash(
      S2S_DOMAIN as never,
      S2S_TYPES as never,
      buildSigningView({ ...rest, createdAt: modifiedDate } as never),
    );

    expect(item.objectId).not.toBe(v1Digest);
  });

  for (const tamper of ['creationDate', 'modifiedDate'] as const) {
    it(`refuses a v2 item whose signed ${tamper} was altered`, async () => {
      serve(mkItemV2(tamper));

      const { bodies, skips } = await fetchByPublicationDetailed(PUBLICATION, [], GATEWAY);
      expect(bodies).toEqual([]);
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({ genesis: GENESIS, cause: 'integrity' });
      expect(skips[0].reason).toMatch(SKIP_REASON_RE);
      expect(SKIP_REASON_RE.exec(skips[0].reason)?.[2]).toBe('objectid-mismatch');

      await expect(fetchById(GENESIS, PUBLICATION, [], GATEWAY)).rejects.toBeInstanceOf(
        ContentIntegrityError,
      );
    });
  }

  it('a v1 item still verifies, with both flat dates from createdAt', async () => {
    serve(mkItemV1());

    const { bodies, skips } = await fetchByPublicationDetailed(PUBLICATION, [], GATEWAY);
    expect(skips).toEqual([]);
    expect(bodies[0]).toMatchObject({
      specVersion: '1',
      creationDate: '1700000000',
      modifiedDate: '1700000000',
    });
    await expect(fetchItemById(GENESIS, PUBLICATION, [], GATEWAY)).resolves.toBeDefined();
  });
});
