/**
 * Per-key body map (storage layout v3).
 *
 * The envelope is not in play here: these tests pin the storage layout only.
 * A v1/v2 item keeps its single `body` and reads back through the helpers as if
 * it had a map, so one reader serves every item already in the log. A v3 item
 * carries `bodies` and may hold more than the protocol's own body.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { utils, Wallet } from 'ethers';
import {
  S2S_BODIES_KEY,
  bodyForKey,
  itemBodies,
  type AnyS2SContentItem,
  type S2SContentBody,
  type S2SContentItem,
  type S2SContentItemV2,
  type S2SContentItemV3,
  type S2SProof,
} from './types';
import { buildSignedContentItem, noOpEncrypt, type TypedDataSigner } from './identity/sign-content';
import { verifyAuthorship } from './identity/verify-content';

beforeAll(() => {
  (globalThis as { ethers?: unknown }).ethers = { utils };
});

const SIGNER = '0x1234567890123456789012345678901234567890';
const PROOF: S2SProof = {
  type: 'eip712',
  signer: SIGNER,
  signature: `0x${'11'.repeat(65)}`,
};

const V1_ITEM: S2SContentItem = {
  public: {
    specVersion: '1',
    author: '0x1111111111111111111111111111111111111111',
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '',
    publication: 'example.eth',
    locale: 'en',
    createdAt: 1700000000,
    tags: [],
    plaintextHash: `0x${'ab'.repeat(32)}`,
  },
  objectId: `0x${'aa'.repeat(32)}`,
  proof: PROOF,
  encryption: false,
  body: '{"title":"v1"}',
};

const V2_ITEM: S2SContentItemV2 = {
  public: {
    specVersion: '2',
    author: '0x1111111111111111111111111111111111111111',
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '',
    publication: 'example.eth',
    locale: 'en',
    creationDate: 1700000000,
    modifiedDate: 1700000100,
    tags: [],
    plaintextHash: `0x${'ab'.repeat(32)}`,
  },
  objectId: `0x${'bb'.repeat(32)}`,
  proof: PROOF,
  encryption: true,
  body: 'ciphertext-for-s2s',
};

const V3_ITEM: S2SContentItemV3 = {
  public: V2_ITEM.public,
  objectId: `0x${'cc'.repeat(32)}`,
  proof: PROOF,
  encryption: true,
  bodies: { [S2S_BODIES_KEY]: 'ciphertext-for-s2s', 'pub.eth': 'ciphertext-for-pub' },
};

describe('itemBodies', () => {
  it('wraps a v1 body under the protocol key', () => {
    expect(itemBodies(V1_ITEM)).toEqual({ [S2S_BODIES_KEY]: V1_ITEM.body });
  });

  it('wraps a v2 body under the protocol key', () => {
    expect(itemBodies(V2_ITEM)).toEqual({ s2s: 'ciphertext-for-s2s' });
  });

  it('returns the map of a v3 item as it stands', () => {
    expect(itemBodies(V3_ITEM)).toEqual({
      s2s: 'ciphertext-for-s2s',
      'pub.eth': 'ciphertext-for-pub',
    });
  });
});

describe('bodyForKey', () => {
  it('defaults to the protocol key on every layout', () => {
    expect(bodyForKey(V1_ITEM)).toBe(V1_ITEM.body);
    expect(bodyForKey(V2_ITEM)).toBe(V2_ITEM.body);
    expect(bodyForKey(V3_ITEM)).toBe('ciphertext-for-s2s');
  });

  it('returns a publication’s own body when asked for its key', () => {
    expect(bodyForKey(V3_ITEM, 'pub.eth')).toBe('ciphertext-for-pub');
  });

  it('returns undefined for a key holder with no body', () => {
    expect(bodyForKey(V3_ITEM, 'other.eth')).toBeUndefined();
    expect(bodyForKey(V1_ITEM, 'pub.eth')).toBeUndefined();
  });

  it('agrees with the exported key constant', () => {
    expect(S2S_BODIES_KEY).toBe('s2s');
    expect(bodyForKey(V3_ITEM, S2S_BODIES_KEY)).toBe(V3_ITEM.bodies.s2s);
  });

  it('returns undefined for an inherited property name, not the prototype value', () => {
    // On a plain object these resolve through the prototype chain: without an
    // own-key check the caller gets the Object constructor, a function, or an
    // object where a body belongs.
    expect(bodyForKey(V3_ITEM, 'constructor')).toBeUndefined();
    expect(bodyForKey(V3_ITEM, 'toString')).toBeUndefined();
    expect(bodyForKey(V3_ITEM, '__proto__')).toBeUndefined();
    expect(bodyForKey(V1_ITEM, 'constructor')).toBeUndefined();
  });

  it('returns undefined for a v3 item whose map has no protocol body', () => {
    const noProtocolBody: S2SContentItemV3 = {
      ...V3_ITEM,
      bodies: { 'pub.eth': 'ciphertext-for-pub' },
    };

    expect(bodyForKey(noProtocolBody)).toBeUndefined();
    expect(bodyForKey(noProtocolBody, 'pub.eth')).toBe('ciphertext-for-pub');
  });

  it('treats a non-object body map as holding no bodies instead of throwing', () => {
    const malformed = { ...V3_ITEM, bodies: null } as unknown as AnyS2SContentItem;

    expect(itemBodies(malformed)).toEqual({});
    expect(bodyForKey(malformed)).toBeUndefined();
  });

  it('makes verifyAuthorship return false, not throw, on a null body map', async () => {
    const malformed = { ...V3_ITEM, bodies: null } as unknown as AnyS2SContentItem;

    expect(await verifyAuthorship(malformed, async () => 'plaintext')).toBe(false);
  });
});

// ============================================================================
// An unusable `bodies` value beside a legacy `body`
//
// An item in the log can carry a stray `bodies` key that holds nothing usable:
// null, undefined, an array, a string. The schema's body branch strips the key
// and the item renders from `body`, so the helpers must fall back to that body
// rather than read the key's presence as a layout.
// ============================================================================

describe('itemBodies falling back to a legacy body', () => {
  const unusable: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['an array', ['ciphertext']],
    ['a string', 'ciphertext'],
    ['a number', 7],
  ];

  for (const [label, value] of unusable) {
    it(`uses the legacy body when bodies is ${label}`, () => {
      const item = { ...V1_ITEM, bodies: value } as unknown as AnyS2SContentItem;

      expect(itemBodies(item)).toEqual({ [S2S_BODIES_KEY]: V1_ITEM.body });
      expect(bodyForKey(item)).toBe(V1_ITEM.body);
    });
  }

  it('uses a legacy body on a v2 item whose bodies is null', () => {
    const item = { ...V2_ITEM, bodies: null } as unknown as AnyS2SContentItem;

    expect(bodyForKey(item)).toBe(V2_ITEM.body);
  });

  it('returns an empty map when there is neither a usable map nor a body', () => {
    const neither = { ...V3_ITEM, bodies: null, body: undefined } as unknown as AnyS2SContentItem;
    const { body: _body, ...noBody } = V3_ITEM as unknown as Record<string, unknown>;
    const stripped = { ...noBody, bodies: null } as unknown as AnyS2SContentItem;

    expect(itemBodies(neither)).toEqual({});
    expect(itemBodies(stripped)).toEqual({});
    expect(bodyForKey(stripped)).toBeUndefined();
  });

  it('still prefers a usable map over a stray legacy body', () => {
    const item = { ...V3_ITEM, body: 'stale' } as unknown as AnyS2SContentItem;

    expect(bodyForKey(item)).toBe('ciphertext-for-s2s');
    expect(bodyForKey(item, 'pub.eth')).toBe('ciphertext-for-pub');
  });
});

// ============================================================================
// buildSignedContentItem writes the map
// ============================================================================

function signerOf(wallet: Wallet): TypedDataSigner {
  return {
    getAddress: () => wallet.address,
    signTypedData: (domain, types, value) =>
      wallet._signTypedData(domain as never, types as never, value),
  };
}

const BODY: S2SContentBody = { title: 'Hello', slug: 'hello', content: '# Hello' };

describe('buildSignedContentItem storage layout', () => {
  it('emits bodies.s2s and no body key (v2 envelope)', async () => {
    const wallet = new Wallet(`0x${'22'.repeat(32)}`);
    const item = await buildSignedContentItem(
      {
        specVersion: '2',
        postType: 'post',
        mediaType: 'text/markdown',
        parent: '',
        position: '',
        publication: 'example.eth',
        locale: 'en',
        creationDate: 1700000000,
        modifiedDate: 1700000100,
        tags: ['a'],
      },
      BODY,
      signerOf(wallet),
      noOpEncrypt,
      wallet.address,
    );

    // The absence of `.body` is a compile error on the v3 return, not a
    // runtime undefined: assert both halves here.
    expect('body' in item).toBe(false);
    // @ts-expect-error — v3 storage has no `body`; reading one must not compile
    void item.body;
    expect(Object.keys(itemBodies(item))).toEqual([S2S_BODIES_KEY]);
    expect(JSON.parse(bodyForKey(item) as string)).toMatchObject({ title: 'Hello' });
    // The envelope did not move: still specVersion 2.
    expect(item.public.specVersion).toBe('2');
  });

  it('keeps the single body on a v1 envelope', async () => {
    const wallet = new Wallet(`0x${'33'.repeat(32)}`);
    const item = await buildSignedContentItem(
      {
        specVersion: '1',
        postType: 'post',
        mediaType: 'text/markdown',
        parent: '',
        position: '',
        publication: 'example.eth',
        locale: 'en',
        createdAt: 1700000000,
        tags: ['a'],
      },
      BODY,
      signerOf(wallet),
      noOpEncrypt,
      wallet.address,
    );

    // v3 storage is pinned to the v2 envelope: a v1 item is never rewritten,
    // so its frozen layout (a single `body`) is what the writer still emits,
    // and that item reads back through the helpers under the protocol key.
    expect(item.public.specVersion).toBe('1');
    expect(typeof item.body).toBe('string');
    expect('bodies' in item).toBe(false);
    expect(bodyForKey(item)).toBe(item.body);
  });
});
