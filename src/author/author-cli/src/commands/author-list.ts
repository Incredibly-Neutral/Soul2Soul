// ============================================================================
// s2s author list — every stored author, plus which one signs.
//
// Offline: the EOA comes from the stored key, the Safe from the store (it is
// only there once `author new`/`address`/`init` predicted it). No RPC, so this
// is safe on a machine with no network. Runs without `buildContext`.
//
// The rows come from `authorRows` and nowhere else: a row filed by
// `s2s signer rotate` is printed as pending, with the row it replaces, because
// printing it as an owner would tell the user a key signs for a Safe it does
// not own — and `signer rotate` sends them here to choose between the two rows.
// ============================================================================

import type { StoreCommandSpec } from '../lib/command';
import type { CliOut } from '../lib/out';
import { authorRows, authorsFilePath, readAuthors } from '../core/authors';

export const authorList: StoreCommandSpec = {
  name: 'list',
  summary: 'List the stored authors and mark the active one.',
  flags: {},
  run(out: CliOut) {
    const store = readAuthors();
    const rows = authorRows(store);

    if (rows.length === 0) {
      out.result(
        { action: 'author.list', active: null, authors: [] },
        `no authors yet — add one with: s2s author new <pet-name>\nstore: ${authorsFilePath()}`,
      );
      return;
    }

    const width = Math.max(...rows.map((row) => row.name.length));
    const table = rows
      .map((row) => {
        const marker = row.active ? '*' : ' ';
        const safe =
          row.safe === null
            ? 'safe (not predicted)'
            : `safe ${row.safe}${row.ownership === 'pending' ? ' (pending)' : ''}`;
        const chases = row.replaces === undefined ? '' : `  → replaces ${row.replaces}`;
        return `${marker} ${row.name.padEnd(width)}  ${row.eoa ?? '(invalid key)'}  ${safe}${chases}`;
      })
      .join('\n');

    out.result(
      { action: 'author.list', active: store.active, authors: rows },
      [
        `authors (${String(rows.length)}), active: ${store.active ?? '(none)'} — * signs`,
        '',
        table,
      ].join('\n'),
    );
  },
};
