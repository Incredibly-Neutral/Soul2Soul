// ============================================================================
// s2s author rm <pet-name> — forget a stored author.
//
// Removing the active author is allowed and moves `active` to the first
// remaining author (insertion order), or to null when the store empties — so
// there is never an "active" name that is not in the file. The key itself is
// not recoverable from here: the file is the only copy, and it is 0600.
// Runs without `buildContext`.
// ============================================================================

import type { ParsedArgs } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { authorsFilePath, findAuthor, readAuthors, removeAuthor, writeAuthors } from '../core/authors';

export const authorRm: StoreCommandSpec = {
  name: 'rm',
  summary: 'Remove a stored author (the active slot moves on if it was active).',
  usage: 's2s author rm <pet-name> [--json]',
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
