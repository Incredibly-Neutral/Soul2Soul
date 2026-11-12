// ============================================================================
// s2s signer history — what the OwnerHistory module recorded about this Safe's
// owners, and whether it still agrees with them.
//
// The Safe is the one this machine files for its active author. `signer add` is
// the one signer command that names a Safe, because it is the one with no row to
// read one from.
//
// A rotation executes `swapOwner` inside `execTransaction`, and the guard the
// Safe routes through stamps a new era as it goes. That stamp is the only
// record that an owner who signed an earlier publication was an owner then, so
// "did the rotation get recorded?" is a question with an answer on chain, and no
// other command answers it: `author address` reads the factory index and the
// queue reads proposals, neither of which reads the module.
//
// The module is read from the Safe's enabled list first, else from the guard in
// the guard slot. The factory index is not consulted: it is permissionless, and
// an entry a griefer appended says nothing about what this Safe carries.
//
// `sync()` is permissionless, so a history that lags the owners is not a lost
// rotation: anyone can call it and it stamps the era the guard missed. The
// command says so rather than printing a repair nobody can perform.
//
// Nothing is signed and nothing is sent. The read is the whole command.
// ============================================================================

import type { ParsedArgs } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import type { OwnerEra, OwnerHistoryRead } from '../core/author-contracts';
import {
  l2Rpc,
  refuseSafeArgument,
  resolveSignerSafe,
  shortAddress,
  signerDeps,
  type SignerDeps,
} from './signer-store';

/** One era's owner list: whole when it names one owner, else shortened per address. */
function ownerList(owners: readonly string[]): string {
  const [only, ...others] = owners;
  if (only !== undefined && others.length === 0) return only;
  return owners.map(shortAddress).join(', ');
}

/** `0x…` — a block number as the chain spells it, which is how a reader checks it. */
function blockHex(block: number): string {
  return `0x${block.toString(16)}`;
}

/** One era line: `  #0  blocks 0x… → 0x…  owners 0x…, 0x…`. */
function eraLine(era: OwnerEra): string {
  const end = era.endBlock === null ? 'head' : blockHex(era.endBlock);
  return `  #${String(era.index)}  blocks ${blockHex(era.startBlock)} → ${end}  owners ${ownerList(era.owners)}`;
}

/** The human block: the hook, the module, the eras, the sync point, and nothing else. */
function humanLines(history: OwnerHistoryRead): string[] {
  // The slot answers who the hook is; the guard's own `module()` answers whether
  // it is an owner-history hook at all. A policy guard in the slot is named as
  // one rather than called ours.
  const guard =
    history.guard === null
      ? 'guard   (none)  no owner-history hook is installed'
      : history.guardModule !== null
        ? `guard   ${history.guard}  owner-history guard (bound to this Safe)`
        : `guard   ${history.guard}  not an owner-history guard`;
  const module =
    history.module === null
      ? 'module  (none)'
      : `module  ${history.module}  S2S Owner History Module V1`;

  if (history.module === null) {
    return [
      guard,
      module,
      'no owner-history module is enabled on this Safe: nothing recorded the rotation',
    ];
  }

  const synced =
    history.lastSyncedBlock === null
      ? 'synced  unknown'
      : `synced  block ${blockHex(history.lastSyncedBlock)}`;
  // A history that agrees with the owners needs no closing line: the eras above
  // already answer the question. One that disagrees says what repairs it.
  const lag = history.lags
    ? ["the history lags the Safe's owners: sync() is permissionless and repairs it"]
    : [];

  return [
    guard,
    module,
    `eras    ${String(history.eraCount)}`,
    ...history.eras.map(eraLine),
    synced,
    ...lag,
  ];
}

export async function runSignerHistory(
  out: CliOut,
  args: ParsedArgs,
  overrides: Partial<SignerDeps> = {},
): Promise<void> {
  refuseSafeArgument(args, 'signer history');
  const deps = signerDeps(overrides);
  const config = deps.config();

  const safe = resolveSignerSafe(config);
  if (!safe) {
    throw new UsageError(
      'this machine files no Safe for its active author — file one with `s2s signer add <safe>`',
    );
  }

  const history = await deps.readHistory(l2Rpc(config), safe);

  out.result(
    {
      action: 'signer.history',
      safe,
      guard: history.guard,
      module: history.module,
      moduleSource: history.moduleSource,
      eraCount: history.eraCount,
      eras: history.eras.map((era) => ({
        index: era.index,
        startBlock: era.startBlock,
        endBlock: era.endBlock,
        owners: era.owners,
      })),
      ownersEver: history.ownersEver,
      lastSyncedBlock: history.lastSyncedBlock,
      lags: history.lags,
    },
    [`safe    ${safe}`, ...humanLines(history)].join('\n'),
  );
}

export const signerHistory: StoreCommandSpec = {
  name: 'history',
  summary:
    "What the OwnerHistory module recorded about the Safe's owners: the eras, the sync point, and whether the history still matches the owners on chain.",
  flags: {},
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerHistory(out, args);
  },
};
