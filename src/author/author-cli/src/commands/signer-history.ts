// ============================================================================
// s2s signer history [<safe>] — what the OwnerHistory module recorded about
// this Safe's owners, and whether it still agrees with them.
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
// rotation: anyone can call it and it stamps the era the guard missed.
// `--sync` sends that call from this machine's key. Without the flag the read is
// the whole command — nothing is signed and nothing is sent.
//
// The flag exists because the guard's hook cannot be relied on under the
// sponsored rail: the send's gas limit is the bundler's estimate from a
// simulation in which the hook's failure is swallowed by design, so the estimate
// never includes what the sync needs and the hook is starved. A rotation can
// therefore land with the era still holding the old owner, and this is the
// command that puts it right.
//
// The call needs no Safe, which is what permissionless means, but who pays is
// still a decision: an EOA with no ETH on Base cannot send it, and a paymaster
// can, so the rail is chosen by the same `eoaPayerReason` gate `confirm` uses.
// `--self-paid` forces the EOA send. Neither rail falls back to the other:
// a sponsored send that degrades into an EOA one would be a transaction the
// user did not choose. `sync()` writes nothing when the set already matched, so
// a matching history is refused instead of costing a transaction.
// ============================================================================

import { encodeFunctionData, type Address, type Hex } from 'viem';

import { OwnerHistoryModuleV1 } from '@s2s/author-contracts';

import { flagBool } from '../lib/args';
import type { ParsedArgs } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { authorEoa } from '../core/authors';
import { bundlerEndpoints, hexKey } from '../core/config';
import type { OwnerEra, OwnerHistoryRead } from '../core/author-contracts';
import { SponsoredSendReverted } from '../adapters/tx-runner';
import { eoaPayerReason, isFundsFailure } from './signer-confirm';
import {
  l2Rpc,
  reasonOf,
  refuseSafeArgument,
  resolveSignerSafe,
  shortAddress,
  signerDeps,
  type SignerDeps,
} from './signer-store';

/** `sync()` on the OwnerHistory module: no arguments, no permission needed. */
const SYNC_DATA: Hex = encodeFunctionData({ abi: OwnerHistoryModuleV1, functionName: 'sync' });

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
    ? ["the history lags the Safe's owners: sync() is permissionless and repairs it — rerun with --sync to send it"]
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
  const deps = signerDeps(overrides);
  const config = deps.config();

  refuseSafeArgument(args, 'signer history');
  const safe = resolveSignerSafe(config);
  if (!safe) {
    throw new UsageError(
      'this machine files no Safe for its active author — file one with `s2s signer add <safe>`',
    );
  }

  // The human block for a run that sent the sync: the transaction hash is the
  // claim, and the block below it is the proof, because the eras are the re-read
  // taken after the receipt.
  const syncLine = (txHash: Hex): string => `sync    ${txHash}`;

  const rpcUrl = l2Rpc(config);
  let history = await deps.readHistory(rpcUrl, safe);
  let syncTx: Hex | undefined;

  if (flagBool(args.flags, 'sync')) {
    const module: Address | null = history.module;
    if (module === null) {
      throw new CliError(
        `no owner-history module is enabled on ${safe}, so there is nothing to sync`,
        1,
        'no_history_module',
      );
    }
    // `sync()` returns false and writes nothing when the set already matches, so
    // this would be a transaction that buys no fact.
    if (!history.lags) {
      throw new CliError(
        "the history already matches the Safe's owners; nothing to sync",
        1,
        'history_in_sync',
      );
    }
    const configured = hexKey(config.privateKey);
    const privateKey =
      configured && /^0x[0-9a-fA-F]{64}$/.test(configured) ? (configured as Hex) : undefined;
    if (!privateKey) {
      throw new UsageError(
        'no signing key — the sync is a transaction, so it needs one: activate a key with `s2s author switch <name>`, or file one with `s2s signer add <safe>`',
      );
    }
    // A key that passed the check above always yields an EOA; `authorEoa`
    // types the answer as optional, so the prose name is fixed once here.
    const eoa = authorEoa(privateKey) ?? 'this key';
    // Who pays, decided before the send, by the gate `confirm` uses: a paymaster
    // URL, a 1-of-1 Safe, the 4337 module enabled and installed as the handler.
    // The threshold and owner count are the Safe's, so they are read, never
    // assumed — and the 4337 read is last because it is the only chain read the
    // decision cannot do without.
    const chain = await deps.readSafe(rpcUrl, safe);
    const endpoints = bundlerEndpoints(config, deps.chainId);
    const eoaReason = await eoaPayerReason({
      selfPaid: flagBool(args.flags, 'self-paid'),
      bundlerUrl: endpoints?.bundlerUrl,
      paymasterUrl: endpoints?.paymasterUrl,
      threshold: chain.threshold,
      owners: chain.owners.length,
      probe: () => deps.read4337(rpcUrl, safe),
      onReadFailure: (reason) => {
        out.warn(
          `could not read the Safe's 4337 state (${reason}) — sending the sync from ${eoa}, whose gas it will pay`,
        );
      },
    });
    const sponsored = eoaReason === undefined;
    // The warning below says which rail paid, and a failed send says it too: the
    // two are the only record of a decision the transaction hash cannot show.
    const payer = sponsored ? 'sponsored by the paymaster' : `paid by ${eoa} (${eoaReason})`;

    try {
      // A resolved send with no hash is not a sent sync: the seam's type says
      // `Hex`, so the check is against a stub that resolves empty.
      const sent: unknown = sponsored
        ? await deps.sendSponsored({ config, rpcUrl, privateKey, to: module, data: SYNC_DATA, safe })
        : await deps.send({ rpcUrl, privateKey, to: module, data: SYNC_DATA });
      if (typeof sent !== 'string' || sent === '') {
        throw new Error('the send resolved with no transaction hash');
      }
      const hash = sent as Hex;
      syncTx = hash;
      await deps.waitForReceipt({ rpcUrl, hash });
      out.warn(`sent sync() to ${module} in ${hash} as ${eoa}, ${payer}`);
    } catch (err) {
      // The read below is still worth printing: it says whether the era is
      // missing, and the reason is why nothing was recorded.
      // A node's rejection of an unaffordable EOA send is the one failure worth
      // its own sentence: it is not a rejected sync but an unfunded address, and
      // funding it — or letting the paymaster pay — is the whole repair.
      if (!sponsored && isFundsFailure(err)) {
        throw new CliError(
          `${eoa} has no ETH on base to pay for the sync on ${module}: the history still lags, so fund ${eoa} with a little Base ETH and run this again, or configure a paymaster (S2S_PIMLICO_KEY or S2S_PAYMASTER_URL) so the sync is sponsored${eoaReason === '--self-paid' ? ' — this run sent from the EOA because of --self-paid, so drop the flag to ask the paymaster' : ''}`,
          1,
          'sync_failed',
        );
      }
      // A sponsored revert carries its reason on the error, not in the message,
      // and the reason is the only thing that says why the sync did not run.
      const reason =
        err instanceof SponsoredSendReverted && err.reason !== undefined
          ? `${reasonOf(err)}: ${err.reason}`
          : reasonOf(err);
      throw new CliError(
        `the ${sponsored ? 'sponsored ' : ''}sync on ${module} was not recorded (${reason}) — ${payer}, and the history still lags, so fix the above and run this again`,
        1,
        'sync_failed',
      );
    }
    // Re-read, so the block printed below is the state the sync produced rather
    // than the one it was sent to repair.
    history = await deps.readHistory(rpcUrl, safe);
  }

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
      ...(syncTx ? { syncTx } : {}),
    },
    [`safe    ${safe}`, ...(syncTx ? [syncLine(syncTx)] : []), ...humanLines(history)].join('\n'),
  );
}

export const signerHistory: StoreCommandSpec = {
  name: 'history',
  summary:
    "What the OwnerHistory module recorded about the Safe's owners: the eras, the sync point, and whether the history still matches the owners on chain. --sync sends the permissionless sync() that repairs a lagging history, sponsored by the paymaster when the Safe qualifies and from the EOA otherwise.",
  flags: {
    sync: {
      type: 'boolean',
      summary:
        'send sync() when the history lags the owners, then read it back; refused when it already matches',
    },
    'self-paid': {
      type: 'boolean',
      summary:
        'send the sync as a plain transaction from the EOA and pay its gas, even when the paymaster would sponsor it',
    },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerHistory(out, args);
  },
};
