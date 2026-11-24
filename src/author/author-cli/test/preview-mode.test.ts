import { describe, expect, it } from 'vitest';

import {
  UNSIGNED_PREVIEW_NOTICE,
  choosePreviewMode,
  previousStateUnreadableNotice,
  previewRefusedNotice,
} from '../src/core/preview-mode';

const SIGNER = '0x1111111111111111111111111111111111111111';

const base = {
  publish: false,
  noteEncrypted: true,
  published: { encrypted: true },
  admitted: false,
  unsignedRender: false,
  signerAddress: SIGNER,
};

describe('choosePreviewMode', () => {
  it('renders a plaintext published version on the cheap dev runner', () => {
    expect(choosePreviewMode({ ...base, published: { encrypted: false } })).toEqual({ mode: 'dev' });
  });

  it('renders an admitted ciphertext version on Lit when the pinned action runs unsigned', () => {
    const choice = choosePreviewMode({ ...base, admitted: true, unsignedRender: true });
    expect(choice).toEqual({ mode: 'preview' });
  });

  it('follows the published version, not the note flag, when they disagree', () => {
    const choice = choosePreviewMode({
      ...base,
      noteEncrypted: false,
      published: { encrypted: true },
      admitted: true,
      unsignedRender: true,
    });
    expect(choice).toEqual({ mode: 'preview' });
  });

  it('falls back to dev with the pin line when the pinned action predates unsigned previews', () => {
    const choice = choosePreviewMode({ ...base, admitted: true });
    expect(choice).toEqual({ mode: 'dev', notice: UNSIGNED_PREVIEW_NOTICE });
  });

  it('falls back to dev with the address-specific refusal when the gate refuses', () => {
    const choice = choosePreviewMode({ ...base });
    expect(choice).toEqual({ mode: 'dev', notice: previewRefusedNotice(SIGNER) });
  });

  it('prints the unreadable line when a ciphertext note could not be resolved', () => {
    const choice = choosePreviewMode({
      ...base,
      published: undefined,
      unreadable: { reason: 'the gateway read timed out' },
    });
    expect(choice).toEqual({
      mode: 'dev',
      notice: previousStateUnreadableNotice('the gateway read timed out'),
    });
  });

  it('is silent for a plaintext note with no version to read', () => {
    const choice = choosePreviewMode({
      ...base,
      noteEncrypted: false,
      published: undefined,
      unreadable: { reason: 'the publication records no version for this genesis yet' },
    });
    expect(choice).toEqual({ mode: 'dev' });
  });

  it('publishes regardless of encryption, admission, unreadability or the capability', () => {
    for (const noteEncrypted of [false, true]) {
      for (const published of [undefined, { encrypted: false }, { encrypted: true }]) {
        for (const admitted of [false, true]) {
          for (const unsignedRender of [false, true]) {
            for (const unreadable of [undefined, { reason: 'x' }]) {
              expect(
                choosePreviewMode({
                  ...base,
                  publish: true,
                  noteEncrypted,
                  published,
                  admitted,
                  unsignedRender,
                  unreadable,
                }),
              ).toEqual({ mode: 'publish' });
            }
          }
        }
      }
    }
  });

  it('names a newer release, not a hardcoded version, in the pin line', () => {
    expect(UNSIGNED_PREVIEW_NOTICE).toContain('pin a newer release');
    expect(UNSIGNED_PREVIEW_NOTICE).not.toMatch(/\b0\.\d+\.\d+\b/);
  });

  it('names the refused address and the three admitted identities, not one command', () => {
    const notice = previewRefusedNotice(SIGNER);
    expect(notice).toContain(SIGNER);
    expect(notice).toContain('reviewer');
    expect(notice).toContain('its author');
    expect(notice).toContain('owner of the publication Safe');
    expect(notice).not.toContain('s2s author offer');
  });

  it('does not claim a published version existed when there was none to read', () => {
    const notice = previousStateUnreadableNotice(
      'the publication records no version for this genesis yet',
    );
    expect(notice).toContain('records no version');
    expect(notice).toContain('nothing was decrypted');
    expect(notice).not.toContain('the published version');
  });
});
