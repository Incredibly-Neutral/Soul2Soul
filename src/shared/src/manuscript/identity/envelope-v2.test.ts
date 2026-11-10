/**
 * Two envelope versions on one signer.
 *
 * v1 is frozen: the golden type hash and digest below were taken from the code
 * before the v2 struct existed, so any drift in S2S_TYPES, the signing view or
 * the domain shows up here as a changed constant. v2 signs the S2SContentV2
 * struct with two dates, and both versions round-trip through verifyAuthorship.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { utils, Wallet } from 'ethers';
import {
  S2S_DOMAIN,
  S2S_TYPES,
  S2S_TYPES_V2,
  type S2SContentBody,
  type S2SPublicContent,
  type S2SPublicContentV2,
  toDidEthr,
} from '../types';
import { buildSigningView, buildSigningViewV2, signingEnvelope } from './signing-view';
import {
  buildSignedContentItem,
  computeObjectId,
  noOpEncrypt,
  type TypedDataSigner,
} from './sign-content';
import { verifyAuthorship } from './verify-content';

// The identity modules read ethers v5 from the ambient global (a Lit Action gets
// it injected); a Node test must publish it once.
beforeAll(() => {
  (globalThis as { ethers?: unknown }).ethers = { utils };
});

/** ethers v5 Wallet as the TypedDataSigner the signer accepts. */
function signerOf(wallet: Wallet): TypedDataSigner {
  return {
    getAddress: () => wallet.address,
    signTypedData: (domain, types, value) =>
      wallet._signTypedData(domain as never, types as never, value),
  };
}

const BODY: S2SContentBody = { title: 'Hello', slug: 'hello', content: '# Hello' };

/** The pristine v1 public metadata the goldens were captured from. */
const V1_PINNED: S2SPublicContent = {
  specVersion: '1',
  author: 'did:ethr:0x1111111111111111111111111111111111111111',
  postType: 'post',
  mediaType: 'text/markdown',
  parent: '',
  position: '',
  publication: 'example.eth',
  locale: 'en',
  createdAt: 1700000000,
  base: undefined,
  tags: ['a', 'b'],
  attributes: { x: 1 },
  plaintextHash: '0x' + 'ab'.repeat(32),
};

const V1_TYPEHASH = '0x1038fc5c371996ce57ab08dd569652d0e8a1453a9e56b850321b71cd664044c4';
const V1_OBJECT_ID = '0x811026fd17adcceb932968b9da14bcbf2877d514e8c57a0b4b0d5179d90d67b3';

function v2Public(over: Partial<S2SPublicContentV2> = {}): S2SPublicContentV2 {
  return {
    specVersion: '2',
    author: 'did:ethr:0x1111111111111111111111111111111111111111',
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '',
    publication: 'example.eth',
    locale: 'en',
    creationDate: 1700000000,
    modifiedDate: 1700000100,
    base: undefined,
    tags: ['a', 'b'],
    attributes: { x: 1 },
    plaintextHash: '0x' + 'ab'.repeat(32),
    ...over,
  };
}

function v2Digest(pub: S2SPublicContentV2): string {
  return utils._TypedDataEncoder.hash(S2S_DOMAIN, S2S_TYPES_V2 as never, buildSigningViewV2(pub));
}

describe('v1 envelope is unchanged', () => {
  it('keeps the S2SContent type hash', () => {
    expect(utils._TypedDataEncoder.hashStruct('S2SContent', S2S_TYPES as never, buildSigningView(V1_PINNED) as never)).toBe(
      V1_TYPEHASH,
    );
  });

  it('keeps the objectId (digest) byte for byte', () => {
    expect(computeObjectId(V1_PINNED)).toBe(V1_OBJECT_ID);
  });

  it('signs and verifies through the v1 struct and view', async () => {
    const wallet = new Wallet('0x' + '11'.repeat(32));
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
        tags: ['a', 'b'],
        attributes: { x: 1 },
      },
      BODY,
      signerOf(wallet),
      noOpEncrypt,
      toDidEthr(wallet.address),
    );

    expect(item.public).toMatchObject({ specVersion: '1', createdAt: 1700000000 });
    expect('creationDate' in item.public).toBe(false);
    expect(item.objectId).toBe(computeObjectId(item.public));
    expect(await verifyAuthorship(item, async () => item.body)).toBe(true);
  });
});

describe('v2 envelope', () => {
  const wallet = new Wallet('0x' + '22'.repeat(32));

  async function signV2(over: Partial<S2SPublicContentV2> = {}) {
    const pub = v2Public(over);
    return buildSignedContentItem(
      {
        specVersion: '2',
        postType: pub.postType,
        mediaType: pub.mediaType,
        parent: pub.parent,
        position: pub.position,
        publication: pub.publication,
        locale: pub.locale,
        creationDate: pub.creationDate,
        modifiedDate: pub.modifiedDate,
        tags: pub.tags,
        attributes: pub.attributes,
      },
      BODY,
      signerOf(wallet),
      noOpEncrypt,
      toDidEthr(wallet.address),
    );
  }

  it('carries both dates and neither v1 timestamp', async () => {
    const item = await signV2();

    expect(item.public).toMatchObject({ specVersion: '2', creationDate: 1700000000, modifiedDate: 1700000100 });
    expect('createdAt' in item.public).toBe(false);
  });

  it('signs and verifies a round trip', async () => {
    const item = await signV2();

    expect(await verifyAuthorship(item, async () => item.body)).toBe(true);
  });

  it('digests through the S2SContentV2 struct', async () => {
    const item = await signV2();

    expect(item.objectId).toBe(v2Digest(item.public));
    expect(computeObjectId(item.public)).toBe(item.objectId);
  });

  it('selects v1 when the item carries no specVersion', () => {
    // Items already in the log can predate the field entirely; src/press relies
    // on those still resolving to the v1 struct and view.
    const { specVersion, creationDate, modifiedDate, ...rest } = v2Public();
    const legacy = { ...rest, createdAt: 1700000100 } as unknown as S2SPublicContent;

    const { types, view } = signingEnvelope(legacy);

    expect(types).toBe(S2S_TYPES);
    expect(Object.keys(types)).toEqual(['S2SContent']);
    expect(view).toEqual(buildSigningView(legacy));
    expect('creationDate' in view).toBe(false);
  });

  it('changes objectId when either date changes', () => {
    const base = v2Public();
    const creation = v2Public({ creationDate: base.creationDate + 1 });
    const modified = v2Public({ modifiedDate: base.modifiedDate + 1 });

    expect(v2Digest(creation)).not.toBe(v2Digest(base));
    expect(v2Digest(modified)).not.toBe(v2Digest(base));
    expect(computeObjectId(creation)).toBe(v2Digest(creation));
    expect(computeObjectId(modified)).toBe(v2Digest(modified));
  });

  it('rejects a tampered v2 item', async () => {
    const item = await signV2();
    const tampered = { ...item, public: { ...item.public, modifiedDate: item.public.modifiedDate + 1 } };

    expect(await verifyAuthorship(tampered, async () => tampered.body)).toBe(false);
  });
});
