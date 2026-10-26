// ============================================================================
// s2s author init — deploy the author Safe.
//
// 0xobsidian's `newAuthor` deploys the author Safe on Base on first use.
// Headless, that deployment is an explicit step: predict (author address), then
// initialize. Idempotent — running it again on a live Safe reports and exits.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { initAuthorSafe } from '../core/author-safe';

export const authorInit: CommandSpec = {
  name: 'init',
  summary: 'Deploy the author Safe (idempotent).',
  usage: 's2s author init [--json]',
  async run(ctx) {
    const result = await initAuthorSafe(ctx);
    const headline = result.txHash
      ? result.deployed
        ? `author Safe deployed at ${result.address}`
        : `deployment submitted for ${result.address} — not confirmed yet`
      : `author Safe already deployed at ${result.address}`;
    ctx.out.result(
      { action: 'author.init', ...result },
      [
        headline,
        `author safe : ${result.address}`,
        `eoa (owner) : ${result.eoa}`,
        `salt        : ${result.salt}`,
        `chain       : ${result.chain}`,
        `tx          : ${result.txHash ?? '(none — already deployed)'}`,
      ].join('\n'),
    );
  },
};
