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
  encrypted: false,
  admitted: false,
  unsignedRender: false,
  signerAddress: SIGNER,
};

describe('choosePreviewMode', () => {
  it('renders a plaintext preview on the cheap dev runner', () => {
    expect(choosePreviewMode({ ...base })).toEqual({ mode: 'dev' });
  });

  it('renders an admitted encrypted preview on Lit when the pinned action runs unsigned', () => {
    const choice = choosePreviewMode({ ...base, encrypted: true, admitted: true, unsignedRender: true });
    expect(choice).toEqual({ mode: 'preview' });
  });

  it('falls back to dev with the pin line when the pinned action predates unsigned previews', () => {
    const choice = choosePreviewMode({ ...base, encrypted: true, admitted: true });
    expect(choice).toEqual({ mode: 'dev', notice: UNSIGNED_PREVIEW_NOTICE });
  });

  it('falls back to dev with the address-specific refusal when the gate refuses', () => {
    const choice = choosePreviewMode({ ...base, encrypted: true });
    expect(choice).toEqual({ mode: 'dev', notice: previewRefusedNotice(SIGNER) });
  });

  it('falls back to dev with the unreadable line instead of guessing the published state', () => {
    const choice = choosePreviewMode({
      ...base,
      unreadable: { reason: 'the gateway read timed out' },
    });
    expect(choice).toEqual({
      mode: 'dev',
      notice: previousStateUnreadableNotice('the gateway read timed out'),
    });
  });

  it('publishes regardless of encryption, admission, unreadability or the capability', () => {
    for (const encrypted of [false, true]) {
      for (const admitted of [false, true]) {
        for (const unsignedRender of [false, true]) {
          for (const unreadable of [undefined, { reason: 'x' }]) {
            expect(
              choosePreviewMode({
                ...base,
                publish: true,
                encrypted,
                admitted,
                unsignedRender,
                unreadable,
              }),
            ).toEqual({ mode: 'publish' });
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
});
