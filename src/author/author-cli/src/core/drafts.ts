// ============================================================================
// The drafts log on the author Safe — which module answers for it, and what it
// holds.
//
// A drafts module is one UUPS proxy per author Safe, holding an append-only list
// of genesis ids and their versions. Two facts decide where it is:
//
//   1. the Safe's own enabled-module list, classified by ERC-165 (the list a
//      gate reads, and the only record of adoption); and
//   2. failing that, the factory index (`getDraftsModulesForSafe`), which is
//      permissionless and therefore a lead, not a proof.
//
// The enabled list wins whenever it answers, because `enableModule` is
// `onlySelf`: an entry there is the Safe's own statement — of enabling a module,
// not necessarily of holding this Safe's log, so the module's own `safe()` is
// read too. The index is read only when the list has no drafts module bound to
// this Safe, and the result says which answered (`source`), so a human can tell
// an installed author from a proxy somebody created for that Safe.
//
// The log itself is read COUNT-then-PAGES. `fetchAll` builds the whole list in
// one `eth_call` and fails once the log is big enough to matter; `fetchAllPaged`
// is the read a UI is meant to use (SPEC-author-drafts, "Reads"). Pages are 100
// entries, a short page ends the run, and the count stops the walk, so a log that
// is an exact multiple of the page size costs no empty call.
//
// The only write is `appendDraft` — one version per real upload, sent by the
// author Safe, because the module accepts `append` from its own Safe and from
// nothing else. A read never appends, and a preview never uploads.
//
// The row identifier is the genesis id. `label` is an unsigned V2 field and is
// not read here: nothing on the module answers it, so nothing is guessed.
// ============================================================================

import { base } from 'viem/chains';
import { BaseError, createPublicClient, getAddress, http, type Address, type Hex } from 'viem';

import { DraftsModuleV1 } from '@s2s/author-contracts';
import { toBytes32Id } from '@s2s/soul2soul-shared';

import type { AuthorContracts, EnabledAuthorModules } from './author-contracts';
import {
  authorContractsFactory,
  readAuthorContracts,
  readDraftsCount,
  readDraftsModuleSafe,
  readEnabledAuthorModules,
} from './author-contracts';
import { authorSafeState } from './author-safe';
import type { CliConfig } from './config';
import type { CliContext } from './context';
import { CliError, UsageError, errorText } from '../lib/errors';

/** Entries per `fetchAllPaged` call. A page is one `eth_call`. */
export const DRAFTS_PAGE_SIZE = 100;

/** Where a drafts module was found. */
export type DraftsModuleSource = 'enabled' | 'factory';

export interface ResolvedDraftsModule {
  address: Address;
  source: DraftsModuleSource;
  /**
   * Whether `address` is in the Safe's own enabled-module list, whichever branch
   * answered. A factory-index module can still be enabled on the Safe: it is just
   * not the module this run took for the drafts role.
   */
  onEnabledList: boolean;
}

/** One row of the log: the latest version of one genesis. */
export interface DraftEntry {
  genesis: Hex;
  cid: string;
  author: Address;
  /** Block time at the latest append, seconds since the epoch. */
  timestamp: number;
  /** Versions logged for this genesis. */
  versionCount: number;
}

/** One entry as the ABI hands it back, before the numbers are widened. */
export interface RawDraftEntry {
  genesis: Hex;
  author: Address;
  cid: string;
  timestamp: bigint;
  versionCount: bigint;
}

export interface ResolveDraftsModuleOptions {
  safe: Address;
  rpcUrl: string;
  factory: Address;
}

export interface ReadDraftsOptions {
  address: Address;
  rpcUrl: string;
}

export interface ReadDraftsPageOptions {
  address: Address;
  rpcUrl: string;
  offset: bigint;
  limit: bigint;
}

// ===========================================================================
// The seam
// ===========================================================================

/**
 * Everything this module reads, as one injectable object — the same shape as
 * `AuthorContractsSeam`: the reads that leave the process live here, so a test
 * fakes the decision without a chain.
 */
export interface DraftsSeam {
  /** The Safe's enabled modules, classified by ERC-165 role. */
  readEnabled(opts: { safe: Address; rpcUrl: string }): Promise<EnabledAuthorModules>;
  /** `module.safe()` — the Safe a module was minted for; null when it answers none. */
  readModuleSafe(opts: { module: Address; rpcUrl: string }): Promise<Address | null>;
  /** The factory index (`getDraftsModulesForSafe` and siblings). */
  readFactory(opts: ResolveDraftsModuleOptions): Promise<AuthorContracts>;
  /** `count()` — the number of genesis ids in the log. */
  readCount(opts: { address: Address; rpcUrl: string }): Promise<bigint>;
  readPage(opts: ReadDraftsPageOptions): Promise<RawDraftEntry[]>;
  /** `versionCount(genesis)` — versions logged for one genesis. */
  readVersionCount(opts: { address: Address; rpcUrl: string; genesis: Hex }): Promise<bigint>;
}

function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

export const defaultDraftsSeam: DraftsSeam = {
  readEnabled: (opts) => readEnabledAuthorModules(opts),
  readModuleSafe: (opts) => readDraftsModuleSafe(opts),
  readFactory: (opts) => readAuthorContracts(opts),
  // The same `count()` an install reads, so the two cannot spell it differently.
  readCount: async (opts) => await readDraftsCount({ module: opts.address, rpcUrl: opts.rpcUrl }),
  readPage: async (opts) =>
    Array.from(
      (await clientFor(opts.rpcUrl).readContract({
        address: opts.address,
        abi: DraftsModuleV1,
        functionName: 'fetchAllPaged',
        args: [opts.offset, opts.limit],
      })) as readonly RawDraftEntry[],
    ),
  readVersionCount: async (opts) =>
    await clientFor(opts.rpcUrl).readContract({
      address: opts.address,
      abi: DraftsModuleV1,
      functionName: 'versionCount',
      args: [opts.genesis],
    }),
};

// ===========================================================================
// Which module answers
// ===========================================================================

/**
 * The drafts module that answers for `safe`.
 *
 * The enabled list first — that is adoption, and a gate reads the same list.
 * The factory index second, and only when the list has nothing: the index is
 * append-only and forgeable, so its newest entry is a proxy the Safe may never
 * have used. Nothing answering both means no install, and the remedy is the
 * command that installs one.
 *
 * An enabled module is checked against the Safe it was minted for. `enableModule`
 * is `onlySelf`, so the entry is this Safe's own call, but the call names any
 * address: a drafts module created for another Safe answers the role id too, and
 * its log is that Safe's. `safe()` is proxy storage fixed by `initialize` and no
 * setter exists, so a module bound elsewhere is not adopted and the resolution
 * falls through to the index.
 */
export async function resolveDraftsModule(
  opts: ResolveDraftsModuleOptions,
  seam: DraftsSeam = defaultDraftsSeam,
): Promise<ResolvedDraftsModule> {
  const enabled = await seam.readEnabled({ safe: opts.safe, rpcUrl: opts.rpcUrl });
  const onSafe = enabled.drafts;
  let rejected: { module: Address; bound: Address | null } | null = null;
  if (onSafe !== null) {
    const bound = await seam.readModuleSafe({ module: onSafe, rpcUrl: opts.rpcUrl });
    if (bound !== null && bound.toLowerCase() === opts.safe.toLowerCase()) {
      return { address: getAddress(onSafe.toLowerCase()), source: 'enabled', onEnabledList: true };
    }
    // Kept for the error: this Safe does enable a drafts module, and saying it
    // enables none would deny the one the read just saw.
    rejected = { module: getAddress(onSafe.toLowerCase()), bound };
  }

  const index = await seam.readFactory(opts);
  const created = index.drafts;
  if (created !== null) {
    return {
      address: getAddress(created.toLowerCase()),
      source: 'factory',
      onEnabledList: enabled.modules.some(
        (module) => module.toLowerCase() === created.toLowerCase(),
      ),
    };
  }

  throw new CliError(noModuleMessage(opts.safe, rejected), 1, 'no_drafts_module');
}

/**
 * Why no module answered, in the state the read actually found: a Safe that
 * enables nothing, or a Safe that enables a drafts module bound to a different
 * one. The second names the module, because the remedy is to install one of its
 * own, not to enable a draft module it already has.
 */
function noModuleMessage(
  safe: Address,
  rejected: { module: Address; bound: Address | null } | null,
): string {
  if (rejected === null) {
    return `no enabled drafts module on author Safe ${safe} — run: s2s author init`;
  }
  const why =
    rejected.bound === null
      ? 'answers no safe(), so this run cannot tell whose log it holds'
      : `is bound to ${rejected.bound}, not to this Safe`;
  return `no drafts module bound to author Safe ${safe} — the drafts module enabled here (${rejected.module}) ${why}; run: s2s author init`;
}

// ===========================================================================
// The log
// ===========================================================================

/** The factory this config points at — the same one the install uses. */
export function draftsFactory(config: CliConfig): Address {
  return authorContractsFactory(config);
}

/** One page's entry, with the two `uint256`s narrowed to JS numbers. */
function toDraft(entry: RawDraftEntry): DraftEntry {
  return {
    genesis: entry.genesis,
    cid: entry.cid,
    author: getAddress(entry.author.toLowerCase()),
    timestamp: Number(entry.timestamp),
    versionCount: Number(entry.versionCount),
  };
}

/**
 * Every draft in the log, in insertion order.
 *
 * `count()` bounds the run and a short page ends it: `fetchAllPaged` clamps a
 * limit past the end rather than reverting, so the last page is short exactly
 * when the log ran out. `type(uint256).max` is never asked for — that is the
 * whole-log call this avoids — and a count of zero sends no call at all.
 */
export async function readDrafts(
  opts: ReadDraftsOptions,
  seam: DraftsSeam = defaultDraftsSeam,
): Promise<DraftEntry[]> {
  const count = await seam.readCount({ address: opts.address, rpcUrl: opts.rpcUrl });
  const total = Number(count);
  if (total === 0) return [];

  const drafts: DraftEntry[] = [];
  for (let offset = 0; ; offset += DRAFTS_PAGE_SIZE) {
    const page = await seam.readPage({
      address: opts.address,
      rpcUrl: opts.rpcUrl,
      offset: BigInt(offset),
      limit: BigInt(DRAFTS_PAGE_SIZE),
    });
    for (const entry of page) drafts.push(toDraft(entry));
    if (page.length < DRAFTS_PAGE_SIZE) break;
    if (offset + DRAFTS_PAGE_SIZE >= total) break;
  }
  return drafts;
}

// ===========================================================================
// The write — one append per real upload
// ===========================================================================

/** One version appended, as the write path and `s2s drafts append` report it. */
export interface AppendedDraft {
  /** The module that took the append. */
  module: Address;
  /** The genesis the version belongs to, as the caller spelled it. */
  genesis: string;
  cid: string;
  /** Versions logged for `genesis`, read back after the append. */
  versionCount: number;
  txHash: string;
}

export interface AppendDraftOptions {
  genesis: string;
  cid: string;
}

/** The `append` call, with both spellings of the genesis: the string and its bytes32. */
export interface SimulateAppendCall {
  module: Address;
  safe: Address;
  genesis: string;
  id: Hex;
  cid: string;
}

/**
 * The append's dependencies: the reads, the Safe resolution and the pre-flight
 * call. One object, so a test drives the write with no chain — the same shape
 * `DraftsSeam` gives the reads.
 */
export interface AppendDraftDeps {
  seam: DraftsSeam;
  /** The author Safe and whether it has code. */
  safeState(ctx: CliContext): Promise<{ address: Address; deployed: boolean }>;
  /** `append` as the Safe, before it is sent, so a revert is named and not paid for. */
  simulate(ctx: CliContext, call: SimulateAppendCall): Promise<void>;
}

export function appendDraftDeps(overrides: Partial<AppendDraftDeps> = {}): AppendDraftDeps {
  return {
    seam: overrides.seam ?? defaultDraftsSeam,
    safeState: overrides.safeState ?? authorSafeState,
    simulate: overrides.simulate ?? simulateAppend,
  };
}

/**
 * The two lines every failed append shares.
 *
 * The upload already happened by the time an append is attempted, so the one
 * fact the author must not have to rediscover is that the bytes are pinned: the
 * command failed, the content did not. The retry is the command that appends
 * without uploading again.
 */
function notAppended(opts: AppendDraftOptions, why: string): CliError {
  return new CliError(
    `the bytes are pinned at ${opts.cid}, but the drafts log was not appended: ${why}\n` +
      `  retry once that is fixed: s2s drafts append ${opts.genesis} ${opts.cid}`,
    1,
    'drafts_not_appended',
  );
}

/** What the module's own custom errors mean, named rather than left decoded. */
function appendRevertHint(reason: string): string {
  if (/\bOnlySafe\b/.test(reason)) {
    return ' — OnlySafe(): the module sends `append` for the Safe it was initialised with, and this run is not that Safe';
  }
  if (/\bZeroHash\b/.test(reason)) return ' — ZeroHash(): the genesis id is bytes32 zero';
  if (/\bEmptyCid\b/.test(reason)) return ' — EmptyCid(): the cid is empty';
  return '';
}

/**
 * Simulate `append` as the author Safe, exactly as `src/core/service.ts` does
 * for `makeOffer`: viem never decodes revert data for a raw send, so a reverted
 * append would arrive as "execution reverted for an unknown reason", and the
 * eth_call's `from` is the msg.sender of the deployed userOp — the Safe — so a
 * module that is the wrong Safe's refuses before gas is spent.
 */
async function simulateAppend(ctx: CliContext, call: SimulateAppendCall): Promise<void> {
  try {
    await ctx.l2.simulateContract({
      address: call.module,
      abi: DraftsModuleV1,
      functionName: 'append',
      args: [call.id, call.cid],
      account: call.safe,
    });
  } catch (err) {
    const reason = err instanceof BaseError ? err.shortMessage : errorText(err);
    throw notAppended(
      { genesis: call.genesis, cid: call.cid },
      `the append from author Safe ${call.safe} would revert — ${reason}${appendRevertHint(reason)}`,
    );
  }
}

/**
 * Append one version to the author Safe's drafts log.
 *
 * The module is resolved the way `s2s drafts list` resolves it (the Safe's own
 * enabled list first, the factory index second), the genesis is converted by
 * shared's `toBytes32Id` so the id is the same bytes the publication module
 * would see, and the write is sent by the author Safe through the ERC-4337
 * runner — `append` is `onlySafe`, so an EOA send can never work. The count
 * returned is read back from the module after the send: it is the log's answer,
 * not the caller's arithmetic.
 */
export async function appendDraft(
  ctx: CliContext,
  opts: AppendDraftOptions,
  overrides: Partial<AppendDraftDeps> = {},
): Promise<AppendedDraft> {
  const deps = appendDraftDeps(overrides);
  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    throw new UsageError('no L2 RPC endpoint configured — set S2S_RPC_L2 (or BASE_RPC_URL)');
  }

  const { address: safe, deployed } = await deps.safeState(ctx);
  if (!deployed) {
    throw notAppended(
      opts,
      `the author Safe ${safe} is not deployed yet, so it enables no module — run: s2s author init`,
    );
  }

  let resolved: ResolvedDraftsModule;
  try {
    resolved = await resolveDraftsModule(
      { safe, rpcUrl, factory: draftsFactory(ctx.config) },
      deps.seam,
    );
  } catch (err) {
    // The resolution's own message names the state it found (no module, or one
    // bound elsewhere) and the install that fixes it. What it cannot know is
    // that the bytes are already pinned, so the wrap adds exactly that.
    throw notAppended(opts, err instanceof Error ? err.message : String(err));
  }

  const id = toBytes32Id(opts.genesis) as Hex;
  await deps.simulate(ctx, { module: resolved.address, safe, genesis: opts.genesis, id, cid: opts.cid });

  let txHash: string;
  try {
    txHash = await (
      await ctx.authorRunner()
    ).genericTx(resolved.address, JSON.stringify(DraftsModuleV1), 'append', [id, opts.cid], false);
  } catch (err) {
    // The send failed after the simulation passed: a bundler refusal, or a
    // userOp that landed and reverted. Neither is a viem message the author can
    // act on, and the log may or may not hold the version — so say what is
    // known and name the read that settles it.
    throw new CliError(
      `the bytes are pinned at ${opts.cid}, but the append did not complete: ${errorText(err)}\n` +
        `  check the log with: s2s drafts list\n` +
        `  retry with: s2s drafts append ${opts.genesis} ${opts.cid}`,
      1,
      'drafts_append_failed',
    );
  }

  const versionCount = Number(
    await deps.seam.readVersionCount({ address: resolved.address, rpcUrl, genesis: id }),
  );

  return { module: resolved.address, genesis: opts.genesis, cid: opts.cid, versionCount, txHash };
}
