// ============================================================================
// Flags shared by more than one action, declared once.
//
// A command's `flags` is both what cli.ts parses and what `--help` prints, so a
// shared flag has to be shared here rather than re-typed in four help strings.
// ============================================================================

import type { FlagSpec, FlagSpecs } from '../lib/args';

export const PUBLICATION_FLAG: FlagSpec = {
  type: 'string',
  value: '<ens>',
  summary: "target publication ENS (default: the note's --s2s frontmatter tag)",
};

export const ALLOW_PLAINTEXT_FLAG: FlagSpec = {
  type: 'boolean',
  summary: 'allow republishing a previously-encrypted note in the clear',
};

/** The content actions that take a note: publication + the encryption escape hatch. */
export const NOTE_FLAGS: FlagSpecs = {
  publication: PUBLICATION_FLAG,
  'allow-plaintext': ALLOW_PLAINTEXT_FLAG,
};
