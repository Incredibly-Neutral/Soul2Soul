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
// A row filed by `s2s signer add` is printed as unconfirmed on the same grounds:
// the key joins the Safe only when an owner posts its `addOwnerWithThreshold`
// and that transaction executes, so until then it holds no share of anything.
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
        const state =
          row.ownership === 'pending'
            ? ' (pending)'
            : row.ownership === 'unconfirmed'
              ? ' (filed, not an owner yet)'
              : '';
        const safe =
          row.safe === null ? `safe (not predicted)${state}` : `safe ${row.safe}${state}`;
        const chases = row.replaces === undefined ? '' : `  → replaces ${row.replaces}`;
        return `${marker} ${row.name.padEnd(width)}  ${row.eoa ?? '(invalid key)'}  ${safe}${chases}`;
      })
      .join('\n');

    const unconfirmed = rows.filter((row) => row.ownership === 'unconfirmed').length;
    out.result(
      { action: 'author.list', active: store.active, authors: rows },
      [
        `authors (${String(rows.length)}), active: ${store.active ?? '(none)'} — * signs`,
        '',
        table,
        ...(unconfirmed === 0
          ? []
          : [
              '',
              `${String(unconfirmed)} row${unconfirmed === 1 ? '' : 's'} filed, not an owner yet: the key joins the Safe only when an owner posts the addOwnerWithThreshold call and it executes; \`s2s signer add\` printed that call`,
            ]),
      ].join('\n'),
    );
  },
};
