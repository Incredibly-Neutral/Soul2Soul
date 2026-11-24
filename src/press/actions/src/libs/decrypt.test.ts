/**
 * decryptRaw/decrypt gate selection.
 *
 * Contract: `options.preview` is the only thing that moves the gate. A preview
 * asks `canPreview` — a listed reviewer, the manuscript's author, or an owner of
 * the publication Safe, each of them only while the genesis is under an agreement
 * or an offer. Every other run asks `canRead` exactly as before. Neither path
 * decrypts when the gate refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canPreview, canRead } from './gates';
import { decrypt, decryptRaw } from './decrypt';

vi.mock('./gates', () => ({
  canRead: vi.fn(),
  canPreview: vi.fn(),
}));

const PKP = '0xpkp';
const AUTHOR_SAFE = '0xauthor';
const PUBLICATION_MODULE = '0xpublication';
const SIGNER = '0xsigner';
const RPCS = ['https://rpc.l2'];
const BODY = {
  id: '0x' + '11'.repeat(32),
  content: JSON.stringify({ ciphertext: '0xciphertext' }),
};
const PLAINTEXT = '{"title":"hello"}';

describe('decryptRaw — which gate admits the plaintext', () => {
  beforeEach(() => {
    vi.mocked(canRead).mockReset();
    vi.mocked(canPreview).mockReset();
    (globalThis as any).Lit = {
      Actions: { Decrypt: vi.fn(async () => PLAINTEXT) },
    };
  });

  it('asks canPreview when the run is a preview', async () => {
    vi.mocked(canPreview).mockResolvedValue(true);

    const result = await decryptRaw(PKP, BODY, AUTHOR_SAFE, PUBLICATION_MODULE, SIGNER, RPCS, {
      preview: true,
    });

    expect(result?.raw).toBe(PLAINTEXT);
    expect(canPreview).toHaveBeenCalledWith(BODY.id, PUBLICATION_MODULE, SIGNER, RPCS);
    expect(canRead).not.toHaveBeenCalled();
    expect((globalThis as any).Lit.Actions.Decrypt).toHaveBeenCalledTimes(1);
  });

  it('asks canRead when the run is not a preview', async () => {
    vi.mocked(canRead).mockResolvedValue(true);

    const result = await decryptRaw(PKP, BODY, AUTHOR_SAFE, PUBLICATION_MODULE, SIGNER, RPCS);

    expect(result?.raw).toBe(PLAINTEXT);
    expect(canRead).toHaveBeenCalledWith(BODY.id, AUTHOR_SAFE, PUBLICATION_MODULE, SIGNER, RPCS);
    expect(canPreview).not.toHaveBeenCalled();
  });

  it('does not decrypt when the gate refuses, preview or not', async () => {
    vi.mocked(canPreview).mockResolvedValue(false);
    vi.mocked(canRead).mockResolvedValue(false);

    expect(
      await decryptRaw(PKP, BODY, AUTHOR_SAFE, PUBLICATION_MODULE, SIGNER, RPCS, { preview: true }),
    ).toBeUndefined();
    expect(
      await decryptRaw(PKP, BODY, AUTHOR_SAFE, PUBLICATION_MODULE, SIGNER, RPCS),
    ).toBeUndefined();
    expect((globalThis as any).Lit.Actions.Decrypt).not.toHaveBeenCalled();
  });

  it('threads the options through decrypt', async () => {
    vi.mocked(canPreview).mockResolvedValue(true);

    expect(
      await decrypt(PKP, BODY, AUTHOR_SAFE, PUBLICATION_MODULE, SIGNER, RPCS, { preview: true }),
    ).toEqual({ title: 'hello' });
    expect(canPreview).toHaveBeenCalledTimes(1);
    expect(canRead).not.toHaveBeenCalled();
  });
});
