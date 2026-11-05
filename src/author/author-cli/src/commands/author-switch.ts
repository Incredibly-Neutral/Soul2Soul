// ============================================================================
// s2s author switch <pet-name> — make a stored author the active one.
//
// The whole point of the store: one command changes who signs, with no env var
// and no file edit. Offline by design — the EOA is derived from the stored key
// locally, and the Safe (when known) is read from the store, so no RPC is
// involved. An unknown name errors with the names that do exist.
// Runs without `buildContext`.
// ============================================================================

import type { ParsedArgs } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { authorEoa, authorsFilePath, findAuthor, readAuthors, writeAuthors } from '../core/authors';

export const authorSwitch: StoreCommandSpec = {
  name: 'switch',
  summary: 'Make a stored author the active one (sign as it from now on).',
  usage: 's2s author switch <pet-name> [--json]',
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

    const eoa = authorEoa(author.privateKey);
    if (!eoa) {
      throw new UsageError(
        `author '${author.name}' holds a key that is not a valid private key — re-add it with: s2s author rm ${author.name} && s2s author new ${author.name} --key <0x…>`,
      );
    }

    writeAuthors({ ...store, active: author.name }, file);
    out.result(
      { action: 'author.switch', name: author.name, eoa, safe: author.safe, file },
      [
        `active author: ${author.name}`,
        `eoa         : ${eoa}`,
        `safe        : ${author.safe ?? '(not predicted — run: s2s author address)'}`,
        `store       : ${file}`,
      ].join('\n'),
    );
  },
};
