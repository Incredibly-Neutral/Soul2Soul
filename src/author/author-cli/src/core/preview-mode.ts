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

/** The version the renderer will read, when it could be read at all. */
export interface PublishedVersion {
  encrypted: boolean;
}

/**
 * What is known about encryption before the mode is chosen.
 *
 * `noteEncrypted` is the local note's flag. It does not choose the mode: a
 * preview renders the published version, so `published` does. It only decides
 * whether an unreadable published version is worth a line.
 */
export interface RenderEncryption {
  /** The local note's encryption flag. */
  noteEncrypted: boolean;
  /** The version the renderer reads, when the publication's entry was readable. */
  published?: PublishedVersion;
  /** Set when the version the renderer would read could not be read. */
  unreadable?: { reason: string };
}

export interface PreviewModeInputs extends RenderEncryption {
  /** `publish` names its own mode; the other facts are then unused. */
  publish: boolean;
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
 * fix is a pin. The number is not named because 0.1.4 is still unfiled: the
 * release notes describe it, but no pin records it yet.
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

/**
 * A preview must not guess the published version's state, so it says it could
 * not read the version it would render. "Nothing was decrypted" holds in every
 * case this prints: the note is ciphertext and the dev runner has no key.
 */
export function previousStateUnreadableNotice(reason: string): string {
  return `the version this preview would render could not be read (${reason}), so nothing was decrypted`;
}

/**
 * Choose the render mode for this run.
 *
 *   - publish                                  → `publish`
 *   - the version could not be read,
 *     and the note is plaintext                → `dev`, silently: no key was needed
 *   - the version could not be read,
 *     and the note is ciphertext               → `dev` + the unreadable line
 *   - the published version is plaintext       → `dev` (the cheap runner stays)
 *   - the published version is ciphertext,
 *     admitted, unsigned render advertised     → `preview` (decrypt on Lit)
 *   - the published version is ciphertext,
 *     admitted, no unsigned render             → `dev` + the pin line
 *   - the published version is ciphertext,
 *     refused                                  → `dev` + the address-specific line
 */
export function choosePreviewMode(inputs: PreviewModeInputs): PreviewModeChoice {
  if (inputs.publish) return { mode: 'publish' };
  if (inputs.unreadable) {
    if (!inputs.noteEncrypted) return { mode: 'dev' };
    return { mode: 'dev', notice: previousStateUnreadableNotice(inputs.unreadable.reason) };
  }
  if (!inputs.published?.encrypted) return { mode: 'dev' };
  if (inputs.admitted && inputs.unsignedRender) return { mode: 'preview' };
  if (inputs.admitted) return { mode: 'dev', notice: UNSIGNED_PREVIEW_NOTICE };
  return { mode: 'dev', notice: previewRefusedNotice(inputs.signerAddress) };
}
