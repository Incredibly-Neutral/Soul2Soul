import { describe, expect, it } from 'vitest';

import {
  PREVIEW_REFUSED_NOTICE,
  UNSIGNED_PREVIEW_NOTICE,
  choosePreviewMode,
} from '../src/core/preview-mode';

describe('choosePreviewMode', () => {
  it('renders a plaintext preview on the cheap dev runner', () => {
    const choice = choosePreviewMode({
      publish: false,
      encrypted: false,
      admitted: false,
      unsignedRender: false,
    });
    expect(choice).toEqual({ mode: 'dev' });
  });

  it('renders an admitted encrypted preview on Lit when the pinned action runs unsigned', () => {
    const choice = choosePreviewMode({
      publish: false,
      encrypted: true,
      admitted: true,
      unsignedRender: true,
    });
    expect(choice).toEqual({ mode: 'preview' });
  });

  it('falls back to dev with the pin line when the pinned action predates unsigned previews', () => {
    const choice = choosePreviewMode({
      publish: false,
      encrypted: true,
      admitted: true,
      unsignedRender: false,
    });
    expect(choice).toEqual({ mode: 'dev', notice: UNSIGNED_PREVIEW_NOTICE });
  });

  it('falls back to dev with the refusal line when the gate refuses the decryption', () => {
    const choice = choosePreviewMode({
      publish: false,
      encrypted: true,
      admitted: false,
      unsignedRender: true,
    });
    expect(choice).toEqual({ mode: 'dev', notice: PREVIEW_REFUSED_NOTICE });
  });

  it('publishes regardless of encryption, admission or the unsigned capability', () => {
    for (const encrypted of [false, true]) {
      for (const admitted of [false, true]) {
        for (const unsignedRender of [false, true]) {
          expect(
            choosePreviewMode({ publish: true, encrypted, admitted, unsignedRender }),
          ).toEqual({ mode: 'publish' });
        }
      }
    }
  });

  it('names the pin and the offer commands in the two refusal lines', () => {
    expect(UNSIGNED_PREVIEW_NOTICE).toContain('0.1.4');
    expect(PREVIEW_REFUSED_NOTICE).toContain('s2s author offer');
    expect(PREVIEW_REFUSED_NOTICE).toContain('s2s author publish');
  });
});
