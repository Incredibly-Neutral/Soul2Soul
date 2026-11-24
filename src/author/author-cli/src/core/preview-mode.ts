// ============================================================================
// Preview render mode — the decision, made before the renderer is called.
//
// The mode is a function of facts and nothing else: is this a publish, what is
// the encryption state of the version the renderer will read, did the gate
// admit this signer to the genesis, and does the publication's PINNED manifest
// advertise an unsigned render. Keeping it pure means the cases and the
// refusals are asserted without a chain.
//
// Every fallback to the cheap runner says why. A ciphertext page that looks
// merely broken is the failure this module exists to prevent.
// ============================================================================

import type { RenderMode } from '@s2s/soul2soul-shared';

export interface PreviewModeInputs {
  /** `publish` names its own mode; the other facts are then unused. */
  publish: boolean;
  /**
   * The encryption state of the version the renderer will read. For publish
   * that is this run's upload; for a preview it is the version already on the
   * publication, which is not necessarily the local note.
   */
  encrypted: boolean;
  /** Set when a preview could not read the published version's state. */
  unreadable?: { reason: string } | undefined;
  /** Did shared's `canPreview` admit this signer for this genesis? */
  admitted: boolean;
  /** Does the PINNED manifest advertise `capabilities.unsignedRender`? */
  unsignedRender: boolean;
  /** The address the gate was asked about; named when it refuses. */
  signerAddress: string;
}

export interface PreviewModeChoice {
  mode: RenderMode;
  /** The one line to print when the preview falls back to `dev`. */
  notice?: string;
}

/**
 * A publication whose pinned render action predates the `unsigned` input would
 * sign its own preview page, so shared's renderer refuses `preview` there. The
 * fix is a pin, and the release that carries it is not named here because no
 * release notes file records a version with the capability yet.
 */
export const UNSIGNED_PREVIEW_NOTICE =
  'the publication pins a render action that predates unsigned previews — pin a newer release to decrypt on Lit';

/**
 * The gate admits a listed reviewer, the manuscript's author, or an owner of
 * the publication Safe. Naming an address keeps the line from implying one
 * identity or one command.
 */
export function previewRefusedNotice(signerAddress: string): string {
  return (
    `preview not admitted for ${signerAddress}: the genesis needs an offer or a live agreement, ` +
    'and the signer must be its reviewer, its author or an owner of the publication Safe'
  );
}

/** A preview must not guess the published version's state, so it says it could not read it. */
export function previousStateUnreadableNotice(reason: string): string {
  return `the published version's encryption state could not be read (${reason}), so nothing was decrypted`;
}

/**
 * Choose the render mode for this run.
 *
 *   - publish                            → `publish`
 *   - the published version is unreadable → `dev` + the unreadable line
 *   - preview, plaintext                 → `dev` (the cheap runner stays)
 *   - preview, encrypted, admitted,
 *     unsigned render advertised         → `preview` (decrypt on Lit)
 *   - preview, encrypted, admitted,
 *     no unsigned render                 → `dev` + the pin line
 *   - preview, encrypted, refused        → `dev` + the address-specific line
 */
export function choosePreviewMode(inputs: PreviewModeInputs): PreviewModeChoice {
  if (inputs.publish) return { mode: 'publish' };
  if (inputs.unreadable) {
    return { mode: 'dev', notice: previousStateUnreadableNotice(inputs.unreadable.reason) };
  }
  if (!inputs.encrypted) return { mode: 'dev' };
  if (inputs.admitted && inputs.unsignedRender) return { mode: 'preview' };
  if (inputs.admitted) return { mode: 'dev', notice: UNSIGNED_PREVIEW_NOTICE };
  return { mode: 'dev', notice: previewRefusedNotice(inputs.signerAddress) };
}
