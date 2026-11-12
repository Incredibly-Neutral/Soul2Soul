/**
 * The public, unsigned `label` on a v2 envelope.
 *
 * A label rides on the stored public part and is absent from S2S_TYPES_V2, so
 * it is not committed by the signature: the objectId and the signature over the
 * same item are the same bytes with and without one, and verifyAuthorship still
 * passes while the label sits on the item.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { utils, Wallet } from 'ethers';

import { S2S_TYPES_V2, bodyForKey, type S2SContentBody } from '../types';
import { signingEnvelope } from './signing-view';
import { buildSignedContentItem, noOpEncrypt, type TypedDataSigner } from './sign-content';
import { verifyAuthorship } from './verify-content';

beforeAll(() => {
  (globalThis as { ethers?: unknown }).ethers = { utils };
});

function signerOf(wallet: Wallet): TypedDataSigner {
  return {
    getAddress: () => wallet.address,
    signTypedData: (domain, types, value) =>
      wallet._signTypedData(domain, types, value),
  };
}

const BODY: S2SContentBody = { title: 'Field notes', slug: 'field-notes', content: '# Field notes' };

/** The v2 public input, with a label only when one is asked for. */
function pubV2(label?: string) {
  return {
    specVersion: '2' as const,
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '',
    publication: 'example.eth',
    locale: 'en',
    creationDate: 1700000000,
    modifiedDate: 1700000100,
    tags: ['a'],
    ...(label === undefined ? {} : { label }),
  };
}

describe('label is public but unsigned', () => {
  const wallet = new Wallet('0x' + '33'.repeat(32));

  it('leaves objectId and the signature byte-identical', async () => {
    const bare = await buildSignedContentItem(pubV2(), BODY, signerOf(wallet), noOpEncrypt, wallet.address);
    const labelled = await buildSignedContentItem(
      pubV2('Field notes'),
      BODY,
      signerOf(wallet),
      noOpEncrypt,
      wallet.address,
    );

    expect(labelled.public.label).toBe('Field notes');
    expect('label' in bare.public).toBe(false);
    expect(labelled.objectId).toBe(bare.objectId);
    expect(labelled.proof.signature).toBe(bare.proof.signature);
  });

  it('never reaches the signing view', async () => {
    const labelled = await buildSignedContentItem(
      pubV2('Field notes'),
      BODY,
      signerOf(wallet),
      noOpEncrypt,
      wallet.address,
    );

    const { types, view } = signingEnvelope(labelled.public);

    expect(types).toBe(S2S_TYPES_V2);
    expect('label' in view).toBe(false);
    expect(Object.keys(view)).not.toContain('label');
  });

  it('still verifies authorship with the label present', async () => {
    const labelled = await buildSignedContentItem(
      pubV2('Field notes'),
      BODY,
      signerOf(wallet),
      noOpEncrypt,
      wallet.address,
    );

    const body = bodyForKey(labelled) ?? '';
    expect(body).not.toBe('');
    expect(await verifyAuthorship(labelled, () => Promise.resolve(body))).toBe(true);
  });

  it('does not let a v1 envelope gain the field', async () => {
    // The type pins `label` to the v2 input; the cast exercises the runtime
    // guard, because a caller handing over an untyped object can still pass it.
    const v1Pub = {
      specVersion: '1',
      postType: 'post',
      mediaType: 'text/markdown',
      parent: '',
      position: '',
      publication: 'example.eth',
      locale: 'en',
      createdAt: 1700000000,
      tags: ['a'],
      label: 'Field notes',
    } as unknown as Parameters<typeof buildSignedContentItem>[0];

    const item = await buildSignedContentItem(v1Pub, BODY, signerOf(wallet), noOpEncrypt, wallet.address);

    expect(item.public.specVersion).toBe('1');
    expect('label' in item.public).toBe(false);
  });
});
