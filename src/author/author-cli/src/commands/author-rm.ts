// ============================================================================
// s2s author rm <pet-name> [--force] — forget a stored author.
//
// Removing the active author is allowed and moves `active` to the first
// remaining author (insertion order), or to null when the store empties — so
// there is never an "active" name that is not in the file. The key itself is
// not recoverable from here: the file is the only copy, and it is 0600.
//
// `s2s signer rotate` puts two rows in the file for one Safe, and until its
// swap executes only one of them is a key the Safe knows. Removing either row
// in that window is refused (`removalHoldIn`): the old row may be the last
// stored copy of the key that owns the Safe, and the pending row is the last
// copy of the key the swap puts there. `--force` drops it anyway — that is the
// way to abandon a swap that can no longer execute — and warns, because after
// it the chain is the only record of who owns what.
// Runs without `buildContext`.
// ============================================================================

import type { ParsedArgs } from '../lib/args';
import { flagBool } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import {
  authorsFilePath,
  findAuthor,
  readAuthors,
  removalHoldIn,
  removeAuthor,
  writeAuthors,
} from '../core/authors';

export const authorRm: StoreCommandSpec = {
  name: 'rm',
  summary: 'Remove a stored author (the active slot moves on if it was active).',
  params: '<pet-name>',
  flags: {
    force: {
      type: 'boolean',
      summary: 'remove a row a pending `signer rotate` depends on, abandoning that rotation',
    },
  },
  run(out: CliOut, args: ParsedArgs) {
    const requested = args.positionals[0];
    if (!requested) {
      throw new UsageError('missing required argument: <pet-name>');
    }

    const file = authorsFilePath();
    const store = readAuthors(file);
    const author = findAuthor(store, requested);
    if (!author) {
      const known = Object.keys(store.authors);
      throw new UsageError(
        known.length === 0
          ? `unknown author '${requested}' — no authors yet (add one with: s2s author new <pet-name>)`
          : `unknown author '${requested}' — known authors: ${known.join(', ')}`,
      );
    }

    const hold = removalHoldIn(store, author.name);
    if (hold) {
      if (!flagBool(args.flags, 'force')) {
        throw new CliError(hold, 1, 'rotation_pending');
      }
      out.warn(
        `removed '${author.name}' with a rotation in flight — no stored key is guaranteed to own that Safe now; \`s2s signer add <safe>\` files one that does`,
      );
    }

    const next = removeAuthor(store, author.name);
    writeAuthors(next, file);

    out.result(
      { action: 'author.rm', name: author.name, file, active: next.active },
      [
        `removed author '${author.name}'`,
        `active      : ${next.active ?? '(none — no authors left)'}`,
        `store       : ${file}`,
      ].join('\n'),
    );
  },
};
