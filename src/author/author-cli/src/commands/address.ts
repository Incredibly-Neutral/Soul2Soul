// ============================================================================
// s2s author address — the author's on-chain identity.
//
// The author id is the Safe (the manuscript owner neutralpress writes), not the
// EOA. Its address is counterfactual, so it exists before deployment: this
// prints it (plus the EOA that owns it) without sending anything. A `given`
// Safe has no salt and is not written back — the stored address is the fact
// this command reports.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorSafeSalt, authorSafeState } from '../core/author-safe';
import { rememberAuthorSafe } from '../core/authors';

export const authorAddress: CommandSpec = {
  name: 'address',
  summary: 'Print the author Safe address (author id, predicted — not deployed).',
  flags: {},
  async run(ctx) {
    const state = await authorSafeState(ctx);
    // Keep the store current: `author list` / `switch` report the Safe offline.
    // `rememberAuthorSafe` is a no-op for a given record (nothing derived may
    // replace the stored address), so the call stays unconditional here.
    rememberAuthorSafe(ctx.config.author, state.address, (message) => {
      ctx.out.warn(message);
    });
    ctx.out.result(
      { action: 'author.address', ...state, author: ctx.config.author?.name ?? null },
      [
        `author safe : ${state.address}`,
        `eoa (owner) : ${state.eoa}`,
        `salt        : ${state.salt ?? '(none, the Safe was given, not derived)'}`,
        `chain       : ${state.chain}`,
        `deployed    : ${state.deployed ? 'yes' : 'no — run: s2s author init'}`,
      ].join('\n'),
    );
  },
};

export { authorSafeSalt };
