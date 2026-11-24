// ============================================================================
// Preview render mode — the decision, made before the renderer is called.
//
// The mode is a function of four facts and nothing else: is this a publish, is
// the note encrypted, did the gate admit this signer to the genesis, and does
// the publication's pinned manifest advertise an unsigned render. Keeping it
// pure means the three cases and both refusals are asserted without a chain.
//
// The two refusals are signalled, not silent: an encrypted preview that cannot
// decrypt on Lit still renders on the cheap runner, and the line says why so
// the author is not left with a ciphertext page that looks merely broken.
// ============================================================================

import type { RenderMode } from '@s2s/soul2soul-shared';

export interface PreviewModeInputs {
  /** `publish` names its own mode; the other three facts are then unused. */
  publish: boolean;
  /** The note's resolved encryption flag — the same value that drove the encryptor. */
  encrypted: boolean;
  /** Did shared's `canPreview` admit this signer for this genesis? */
  admitted: boolean;
  /** Does the PINNED manifest advertise `capabilities.unsignedRender`? */
  unsignedRender: boolean;
}

export interface PreviewModeChoice {
  mode: RenderMode;
  /** The one line to print when the encrypted preview falls back to `dev`. */
  notice?: string;
}

/**
 * A publication whose pinned render action predates the `unsigned` input would
 * sign its own preview page, so shared's renderer refuses `preview` there. The
 * fix is a pin, not a flag.
 */
export const UNSIGNED_PREVIEW_NOTICE =
  'the publication pins a render action that predates unsigned previews — pin release 0.1.4 to decrypt on Lit';

/**
 * Lit decrypts only for a genesis the publication still holds by deal or by
 * offer, and (on the author path) only for a Safe whose drafts log names it.
 * A bare preview has neither yet.
 */
export const PREVIEW_REFUSED_NOTICE =
  "decrypting is refused: the genesis needs an open offer or a live agreement, and the author Safe's drafts log must carry it — run `s2s author offer` or `s2s author publish` to create one";

/**
 * Choose the render mode for this run.
 *
 *   - publish                       → `publish`
 *   - preview, plaintext            → `dev` (the cheap runner stays)
 *   - preview, encrypted, admitted,
 *     unsigned render advertised    → `preview` (decrypt on Lit)
 *   - preview, encrypted, admitted,
 *     no unsigned render            → `dev` + the pin line
 *   - preview, encrypted, refused   → `dev` + the offer/agreement line
 */
export function choosePreviewMode(inputs: PreviewModeInputs): PreviewModeChoice {
  if (inputs.publish) return { mode: 'publish' };
  if (!inputs.encrypted) return { mode: 'dev' };
  if (inputs.admitted && inputs.unsignedRender) return { mode: 'preview' };
  if (inputs.admitted) return { mode: 'dev', notice: UNSIGNED_PREVIEW_NOTICE };
  return { mode: 'dev', notice: PREVIEW_REFUSED_NOTICE };
}
