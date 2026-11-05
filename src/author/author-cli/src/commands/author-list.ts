// ============================================================================
// s2s author list — every stored author, plus which one signs.
//
// Offline: the EOA comes from the stored key, the Safe from the store (it is
// only there once `author new`/`address`/`init` predicted it). No RPC, so this
// is safe on a machine with no network. Runs without `buildContext`.
// ============================================================================

import type { StoreCommandSpec } from '../lib/command';
import type { CliOut } from '../lib/out';
import { authorEoa, authorsFilePath, readAuthors } from '../core/authors';

interface AuthorListRow {
  name: string;
  eoa: string | null;
  safe: string | null;
  active: boolean;
}

export const authorList: StoreCommandSpec = {
  name: 'list',
  summary: 'List the stored authors and mark the active one.',
  flags: {},
  run(out: CliOut) {
    const store = readAuthors();
    const rows: AuthorListRow[] = Object.entries(store.authors).map(([name, record]) => ({
      name,
      eoa: authorEoa(record.privateKey) ?? null,
      safe: record.safe,
      active: name === store.active,
    }));

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
        return `${marker} ${row.name.padEnd(width)}  ${row.eoa ?? '(invalid key)'}  ${
          row.safe === null ? 'safe (not predicted)' : `safe ${row.safe}`
        }`;
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
