// ============================================================================
// s2s author migrate — move an author Safe onto the current module generation.
//
// An author's identity is the Safe address, so adopting newer author contracts
// cannot mean a new author. The factory predicts the module addresses for a
// Safe by CREATE2, so the new modules belong to this Safe whether or not they
// have been deployed yet: create them, carry the old drafts log over
// (`absorb`, in pages), swap the guard, enable the new modules, and leave the
// old ones disabled and abandoned on chain.
//
// The guard swap is the one step that can do damage, so it is the one step with
// a gate: a guard in the slot is replaced only when it is this package's
// owner-history guard for the old module. Anything else — a policy guard, another
// product's guard — stops the command with a note naming the guard it found.
// ============================================================================

import type { Address } from 'viem';

import type { CliContext } from '../core/context';
import type { CommandSpec } from '../lib/command';
import { authorSafeState } from '../core/author-safe';
import { migrateAuthorContracts, type InstallState, type SafeCall } from '../core/author-contracts';
import { rememberAuthorContracts } from '../core/authors';
import type { CliOut } from '../lib/out';

/** What the result says about the author contracts after the migration. */
interface ContractsReport {
  factory: string | null;
  drafts: string | null;
  ownerHistory: string | null;
  guard: string | null;
  state: InstallState;
  txs: string[];
  note?: string;
  safeTx?: { to: string; data: string };
  safeTxs?: { to: string; data: string }[];
  pages: number;
  oldDrafts: string | null;
  oldOwnerHistory: string | null;
}

/** Every call a multisig's owners must propose, in order. */
function safeCalls(report: ContractsReport): { to: string; data: string }[] {
  if (report.safeTxs && report.safeTxs.length > 0) return report.safeTxs;
  return report.safeTx ? [report.safeTx] : [];
}

async function migrate(out: CliOut, ctx: CliContext, safe: Address): Promise<ContractsReport> {
  const base: ContractsReport = {
    factory: null,
    drafts: null,
    ownerHistory: null,
    guard: null,
    state: 'skipped',
    txs: [],
    pages: 0,
    oldDrafts: null,
    oldOwnerHistory: null,
  };

  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    // Unreachable in practice (the Safe read needs the same endpoint), kept so a
    // missing endpoint is a reported skip and never a failed command.
    out.warn('author contracts not migrated — no L2 RPC configured');
    return base;
  }

  try {
    const result = await migrateAuthorContracts({
      config: ctx.config,
      safe,
      rpcUrl,
      privateKey: ctx.config.privateKey as `0x${string}`,
      out,
    });

    const report: ContractsReport = {
      factory: result.factory,
      drafts: result.drafts,
      ownerHistory: result.ownerHistory,
      guard: result.guard,
      state: result.state,
      txs: result.txs,
      pages: result.pages,
      oldDrafts: result.oldDrafts,
      oldOwnerHistory: result.oldOwnerHistory,
      ...(result.note ? { note: result.note } : {}),
      ...(result.safeTx ? { safeTx: result.safeTx } : {}),
      ...(result.safeTxs ? { safeTxs: result.safeTxs } : {}),
    };

    if (result.state === 'installed' || result.state === 'already') {
      const name = ctx.config.author?.name ?? null;
      if (name) {
        try {
          rememberAuthorContracts(name, result);
        } catch (err) {
          out.warn(
            `could not record the author contracts in the authors file: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      out.log(
        result.state === 'already'
          ? `author Safe ${safe} already carries the current author contracts`
          : `author Safe ${safe} migrated to the current author contracts${result.pages > 0 ? ` (${String(result.pages)} draft page(s) absorbed)` : ''}`,
      );
    } else if (result.state === 'skipped') {
      out.warn(`author contracts not migrated${result.note ? ` — ${result.note}` : ''}`);
    } else {
      const note = result.note ?? 'the Safe owners must finish the migration';
      const calls = safeCalls(report).length;
      out.log(calls > 0 ? `${note} — the calls to propose are below` : note);
    }

    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.warn(`author contracts not migrated: ${message}`);
    return { ...base, note: message };
  }
}

/** The human block: the state, the modules now on the Safe, then any proposal. */
function contractsLines(report: ContractsReport): string[] {
  const state =
    report.state === 'installed'
      ? 'migrated'
      : report.state === 'already'
        ? 'already current — nothing sent'
        : report.state === 'pending-safe'
          ? `pending — ${report.note ?? 'the Safe owners must finish the migration'}`
          : 'skipped';
  const lines = [`contracts   : ${state}`];
  if (report.state === 'skipped') return lines;

  lines.push(`factory     : ${report.factory ?? '(unknown)'}`);
  lines.push(`drafts      : ${report.drafts ?? '(none)'}`);
  lines.push(`ownerHistory: ${report.ownerHistory ?? '(none)'}`);
  lines.push(`guard       : ${report.guard ?? '(none)'}`);
  if (report.oldDrafts) lines.push(`old drafts  : ${report.oldDrafts} (disabled, abandoned)`);
  if (report.oldOwnerHistory) {
    lines.push(`old history : ${report.oldOwnerHistory} (disabled, abandoned)`);
  }
  if (report.pages > 0) lines.push(`absorbed    : ${String(report.pages)} page(s)`);
  if (report.txs.length > 0) lines.push(`txs         : ${report.txs.join(', ')}`);

  const calls = safeCalls(report);
  if (report.state === 'pending-safe' && calls.length > 0) {
    lines.push('              propose these Safe calls, in this order:');
    for (const [index, call] of calls.entries()) {
      lines.push(`              ${String(index + 1)}. to   ${call.to}`);
      lines.push(`                 data ${call.data}`);
    }
  }
  return lines;
}

export const authorMigrate: CommandSpec = {
  name: 'migrate',
  summary:
    'Move the author Safe onto the current author-contract modules (absorb drafts, new guard).',
  flags: {},
  async run(ctx) {
    // The address is the author id: read it, never derive a new one.
    const state = await authorSafeState(ctx);
    const contracts = await migrate(ctx.out, ctx, state.address);
    ctx.out.result(
      {
        action: 'author.migrate',
        safe: state.address,
        contracts,
        author: ctx.config.author?.name ?? null,
      },
      [
        `author safe : ${state.address}`,
        `deployed    : ${state.deployed ? 'yes' : 'no'}`,
        ...contractsLines(contracts),
      ].join('\n'),
    );
  },
};

/** Exported for the tests that pin the proposal formatting. */
export type { ContractsReport as MigrateContractsReport, SafeCall };
