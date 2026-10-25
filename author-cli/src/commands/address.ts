// ============================================================================
// s2s author address — the author's on-chain identity.
//
// The author id is the Safe (the manuscript owner neutralpress writes), not the
// EOA. Its address is counterfactual, so it exists before deployment: this
// prints it (plus the EOA that owns it) without sending anything.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorSafeSalt, authorSafeState } from '../core/author-safe';

export const authorAddress: CommandSpec = {
  name: 'address',
  summary: 'Print the author Safe address (author id, predicted — not deployed).',
  usage: 's2s author address [--json]',
  async run(ctx) {
    const state = await authorSafeState(ctx);
    ctx.out.result(
      { action: 'author.address', ...state },
      [
        `author safe : ${state.address}`,
        `eoa (owner) : ${state.eoa}`,
        `salt        : ${state.salt}`,
        `chain       : ${state.chain}`,
        `deployed    : ${state.deployed ? 'yes' : 'no — run: s2s author init'}`,
      ].join('\n'),
    );
  },
};

export { authorSafeSalt };
