// ============================================================================
// s2s author init — deploy the author Safe and install the author contracts.
//
// 0xobsidian's `newAuthor` deploys the author Safe on Base on first use, then
// installs the modules the author needs (drafts, owner history, guard).
// Headless, that is an explicit step: predict (author address), initialize,
// install. Idempotent — running it again on a live Safe with the contracts
// already on it reports and exits.
//
// This is also the recovery path: `s2s author new` degrades every install
// failure to a warning pointing here, and an author whose Safe already exists
// is brought up to date by this command alone.
// ============================================================================

import type { Address } from 'viem';

import type { CliContext } from '../core/context';
import type { CommandSpec } from '../lib/command';
import { initAuthorSafe } from '../core/author-safe';
import { installAuthorContracts, type InstallState } from '../core/author-contracts';
import { rememberAuthorContracts, rememberAuthorSafe } from '../core/authors';
import type { CliOut } from '../lib/out';

/** What the result says about the author contracts. */
interface ContractsReport {
  factory: string | null;
  drafts: string | null;
  ownerHistory: string | null;
  guard: string | null;
  state: InstallState;
  txs: string[];
  /** Why the install is `skipped` or `pending-safe`, as core reported it. */
  note?: string;
  safeTx?: { to: string; data: string };
}

/**
 * Install the author contracts on the deployed Safe. Never throws: `init` has
 * already done its one job (the Safe), and a failed install leaves the author
 * re-runnable rather than half-created.
 */
async function installContracts(
  out: CliOut,
  ctx: CliContext,
  safe: Address,
): Promise<ContractsReport> {
  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    // Unreachable in practice (initAuthorSafe needs the same endpoint), kept so
    // the install can never turn a deployed Safe into a failed command.
    out.warn('author contracts not installed — no L2 RPC configured');
    return {
      factory: null,
      drafts: null,
      ownerHistory: null,
      guard: null,
      state: 'skipped',
      txs: [],
    };
  }
  try {
    const result = await installAuthorContracts({
      config: ctx.config,
      safe,
      rpcUrl,
      privateKey: ctx.config.privateKey as `0x${string}`,
      out,
    });

    if (result.state === 'installed' || result.state === 'already') {
      const name = ctx.config.author?.name ?? null;
      if (name) {
        try {
          // `author list` / `switch` report the contracts offline.
          rememberAuthorContracts(name, result);
        } catch (err) {
          out.warn(
            `could not record the author contracts in the authors file: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } else if (result.state === 'skipped') {
      out.warn(
        `author contracts not installed${result.note ? ` — ${result.note}` : ''}; re-run \`s2s author init\``,
      );
    } else {
      // `pending-safe` is not "undeployed": core returns it for a Safe the key
      // does not solely own, one already carrying a guard that is not ours, or a
      // transaction that may have reverted. The note says which, and it must be
      // the thing we print. Only the multisig case carries a call to propose.
      const note = result.note ?? 'the Safe owners must install the guard';
      out.log(result.safeTx ? `${note} — the call to propose is below` : note);
    }

    return {
      factory: result.factory,
      drafts: result.drafts,
      ownerHistory: result.ownerHistory,
      guard: result.guard,
      state: result.state,
      txs: result.txs,
      ...(result.note ? { note: result.note } : {}),
      ...(result.safeTx ? { safeTx: result.safeTx } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.warn(`author contracts not installed: ${message} — re-run \`s2s author init\``);
    return {
      factory: null,
      drafts: null,
      ownerHistory: null,
      guard: null,
      state: 'skipped',
      txs: [],
      note: message,
    };
  }
}

/** The human block for `contracts` — the state, then what it installed. */
function contractsLines(report: ContractsReport): string[] {
  const state =
    report.state === 'installed'
      ? 'installed'
      : report.state === 'already'
        ? 'already installed'
        : report.state === 'pending-safe'
          ? `pending — ${report.note ?? 'the Safe owners must install the guard'}`
          : 'skipped (re-run `s2s author init` once the cause is fixed)';
  const lines = [`contracts   : ${state}`];
  if (report.state === 'skipped') return lines;

  lines.push(`factory     : ${report.factory ?? '(unknown)'}`);
  lines.push(`drafts      : ${report.drafts ?? '(none)'}`);
  lines.push(`ownerHistory: ${report.ownerHistory ?? '(none)'}`);
  lines.push(`guard       : ${report.guard ?? '(none)'}`);
  if (report.txs.length > 0) lines.push(`contract txs: ${report.txs.join(', ')}`);
  if (report.state === 'pending-safe' && report.safeTx) {
    lines.push('              the drafts module needs no install — the Safe calls append');
    lines.push('              on the drafts proxy directly. Propose this call instead:');
    lines.push(`              to   ${report.safeTx.to}`);
    lines.push(`              data ${report.safeTx.data}`);
  }
  return lines;
}

export const authorInit: CommandSpec = {
  name: 'init',
  summary: 'Deploy the author Safe and install the author contracts (idempotent).',
  flags: {},
  async run(ctx) {
    const result = await initAuthorSafe(ctx);
    // Keep the store current: `author list` / `switch` report the Safe offline.
    rememberAuthorSafe(ctx.config.author, result.address, (message) => {
      ctx.out.warn(message);
    });

    // The install is an addition, never a new way to fail: the Safe is the
    // command's one requirement, and it is deployed by now.
    const contracts = await installContracts(ctx.out, ctx, result.address);

    // A given Safe has no salt and is never deployed by this CLI, so neither
    // "already deployed" nor a salt line can be claimed for it.
    const given = result.salt === null;
    const headline = given
      ? result.deployed
        ? `author Safe ${result.address} (given) is deployed`
        : `author Safe ${result.address} (given) is not deployed — this CLI never deploys a given Safe`
      : result.txHash
        ? result.deployed
          ? `author Safe deployed at ${result.address}`
          : `deployment submitted for ${result.address} — not confirmed yet`
        : `author Safe already deployed at ${result.address}`;
    ctx.out.result(
      { action: 'author.init', ...result, contracts, author: ctx.config.author?.name ?? null },
      [
        headline,
        `author safe : ${result.address}`,
        `eoa (owner) : ${result.eoa}`,
        `salt        : ${result.salt ?? '(given Safe — no salt)'}`,
        `chain       : ${result.chain}`,
        `tx          : ${
          result.txHash ??
          (given ? '(none — a given Safe is deployed by its owners, not here)' : '(none — already deployed)')
        }`,
        ...contractsLines(contracts),
      ].join('\n'),
    );
  },
};
