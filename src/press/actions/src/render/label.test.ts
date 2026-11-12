/**
 * The public manuscript label, as the press hands it to templates.
 *
 * `S2SPublicContentV2.label` is public but UNSIGNED: absent from the EIP-712
 * struct, so an item's objectId and signature are the same bytes with it and
 * without it, and absent means "use the genesis id", resolved by whoever
 * displays it. The press carries it onto the flat body so a template can name an
 * ENCRYPTED item, whose title is inside the ciphertext:
 *
 *   - a v3 item carrying `public.label` yields a body whose `label` is that
 *     string and whose `title` is absent (nothing is decrypted yet);
 *   - an item without one yields NO label (undefined, not ""), so the template's
 *     default still applies;
 *   - `mergeDecrypted` keeps the public label across decryption.
 *
 * Everything runs through the real functions — the collection choke point
 * (readItemByEntry → toBody) and `mergeDecrypted` — on items minted the way the
 * author mints them: JCS body, keccak256, EIP-712 digest, real signature.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Wallet, TypedDataEncoder, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';

vi.mock('../libs/evm', () => ({ evmRead: vi.fn() }));
vi.mock('../libs/ipfs.factory', () => ({ catFile: vi.fn() }));

import {
  fetchByPublicationDetailed,
  resetIntegrityWarningLatch,
  toBody,
  type Entry,
} from '../libs/module.factory';
import { mergeDecrypted } from './data.ctrlr';
import { evmRead } from '../libs/evm';
import { catFile } from '../libs/ipfs.factory';
import { inspectItemIntegrity } from '../libs/item-integrity';
import { emptyArchive, parseArchive, reconcile, serialize } from '../libs/archive.factory';
import { jcs } from '@s2s/soul2soul-shared/lit-actions';
import { buildSigningViewV2 } from '../../../../shared/dist/manuscript/identity/signing-view';
import { S2S_DOMAIN, S2S_TYPES_V2, type Address } from '../../../../shared/dist/manuscript/types';

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

const AUTHOR = new Wallet('0x' + '31'.repeat(32));
const GENESIS = '0x' + 'cd'.repeat(32);
const GATEWAY = 'https://ipfs.example';
const PUBLICATION = '0xPubModule';
const entry: Entry = { genesis: GENESIS, author: AUTHOR.address, cid: 'bafyitem', timestamp: 1234 };

/** The plaintext an encrypted item hides: the title lives here, nowhere else. */
const bodyJson = jcs({ title: 'Inside the ciphertext', slug: 'secret', content: 'Hi', custom: {} });
const plaintextHash = keccak256(toUtf8Bytes(bodyJson));

/** The signed public block, optionally carrying the unsigned label. */
const publicV2 = (label?: string) => ({
  specVersion: '2',
  author: AUTHOR.address as Address,
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
  ...(label !== undefined ? { label } : {}),
});

/** Sign the envelope. The label is NOT in the view, so it cannot change this. */
const envelope = (pub: ReturnType<typeof publicV2>) => {
  const digest = TypedDataEncoder.hash(
    S2S_DOMAIN as never,
    S2S_TYPES_V2 as never,
    buildSigningViewV2(pub as never),
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

/** Storage v3, encrypted: the `s2s` body is ciphertext, so no title is readable. */
const encryptedItem = (label?: string) => {
  const pub = publicV2(label);
  return { public: pub, ...envelope(pub), encryption: true, bodies: { s2s: bodyJson } };
};

/** The same envelope in plaintext: `bodies.s2s` IS the bytes the hash covers. */
const plaintextItem = (label?: string) => {
  const pub = publicV2(label);
  return { public: pub, ...envelope(pub), encryption: false, bodies: { s2s: bodyJson } };
};

/** Serve one item over both chain reads: getDeals (collection) and getLatest. */
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

/** The label a stored item carries, read past the union of the two public parts. */
const labelOf = (item: unknown): string | undefined =>
  (item as { public?: { label?: string } }).public?.label;

beforeEach(() => {
  vi.clearAllMocks();
  resetIntegrityWarningLatch();
});

describe('toBody — the public label reaches the template', () => {
  it('carries public.label on an encrypted v3 item, with no title to show', async () => {
    serve(encryptedItem('Field notes'));

    const { bodies } = await fetchByPublicationDetailed(PUBLICATION, undefined, GATEWAY);
    expect(bodies).toHaveLength(1);

    const body = bodies[0];
    expect(body.encryption).toBe(true);
    expect(body.label).toBe('Field notes');
    // Nothing is decrypted on this path, so the title is not there to read —
    // which is exactly why the label is what a listing shows.
    expect(body.title).toBeUndefined();
    expect('title' in body).toBe(false);
  });

  it('leaves the key off entirely when the item carries no label', () => {
    const body = toBody(entry, encryptedItem());

    // undefined, not '': an empty string would be a name that overrides the
    // genesis-id default instead of deferring to it.
    expect(body.label).toBeUndefined();
    expect('label' in body).toBe(false);
  });

  it('treats a blank label as no label', () => {
    const body = toBody(entry, encryptedItem('   '));

    expect(body.label).toBeUndefined();
    expect('label' in body).toBe(false);
  });

  it('does not change objectId or the signature — the label is unsigned', () => {
    const withLabel = encryptedItem('Field notes');
    const without = encryptedItem();

    expect(withLabel.objectId).toBe(without.objectId);
    expect(withLabel.proof.signature).toBe(without.proof.signature);
    // And the verdict is the same 'encrypted' doubt either way, not a mismatch.
    expect(inspectItemIntegrity(withLabel, AUTHOR.address)).toMatchObject({
      level: 'unverifiable',
      code: 'encrypted',
    });
    expect(inspectItemIntegrity(without, AUTHOR.address)).toMatchObject({
      level: 'unverifiable',
      code: 'encrypted',
    });
  });

  it('leaves a plaintext item verified — the extra field perturbs no check', () => {
    const labelled = plaintextItem('Field notes');
    const plain = plaintextItem();

    expect(labelled.objectId).toBe(plain.objectId);
    expect(inspectItemIntegrity(labelled, AUTHOR.address)).toMatchObject({
      level: 'verified',
      code: 'verified',
    });
    expect(toBody(entry, labelled).label).toBe('Field notes');
    expect(toBody(entry, labelled).title).toBe('Inside the ciphertext');
  });
});

describe('the archive — an unsigned field changes nothing it compares', () => {
  it('round-trips a labelled item through the archive and still serves it', () => {
    // The archive stores the item as parsed and reconcile() only compares the
    // cid and the integrity verdict — neither of which the label touches. So a
    // labelled entry is FRESH, not a MISS, and the body it serves carries it.
    const archive = parseArchive(
      serialize({
        ...emptyArchive(),
        items: { [GENESIS]: { cid: entry.cid, item: encryptedItem('Field notes') } },
      }),
    );
    // Read past the union of the two public parts: only the v2 envelope can
    // carry a label, so the member holding one is not expressible on the union.
    expect(labelOf(archive.items[GENESIS].item)).toBe('Field notes');

    const { fresh, needsFetch, integrityIssues } = reconcile([entry], archive);
    expect(needsFetch).toHaveLength(0);
    expect(integrityIssues).toHaveLength(0);
    expect(fresh.get(GENESIS).label).toBe('Field notes');
  });
});

describe('mergeDecrypted — the public label survives decryption', () => {
  it('keeps the label from the encrypted body beside the decrypted title', () => {
    const encrypted = toBody(entry, encryptedItem('Field notes'));
    const merged = mergeDecrypted(encrypted, {
      title: 'Inside the ciphertext',
      slug: 'secret',
      content: 'Hi',
      custom: {},
    });

    expect(merged.label).toBe('Field notes');
    expect(merged.title).toBe('Inside the ciphertext');
    expect(merged.encryption).toBe(false);
  });

  it('invents no label for an unlabelled item', () => {
    const merged = mergeDecrypted(toBody(entry, encryptedItem()), {
      title: 'Inside the ciphertext',
      slug: 'secret',
      content: 'Hi',
      custom: {},
    });

    expect(merged.label).toBeUndefined();
    expect('label' in merged).toBe(false);
  });
});
