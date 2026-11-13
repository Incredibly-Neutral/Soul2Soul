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
// `onlySelf`: an entry there is the Safe's own statement. The index is read only
// when the list has no drafts module, and the result says which answered
// (`source`), so a human can tell an installed author from a proxy somebody
// created for that Safe.
//
// The log itself is read COUNT-then-PAGES. `fetchAll` builds the whole list in
// one `eth_call` and fails once the log is big enough to matter; `fetchAllPaged`
// is the read a UI is meant to use (SPEC-author-drafts, "Reads"). Pages are 100
// entries, a short page ends the run, and the count stops the walk, so a log that
// is an exact multiple of the page size costs no empty call.
//
// The row identifier is the genesis id. `label` is an unsigned V2 field and is
// not read here: nothing on the module answers it, so nothing is guessed.
// ============================================================================

import { base } from 'viem/chains';
import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem';

import { DraftsModuleV1 } from '@s2s/author-contracts';

import type { AuthorContracts, EnabledAuthorModules } from './author-contracts';
import {
  authorContractsFactory,
  readAuthorContracts,
  readDraftsCount,
  readEnabledAuthorModules,
} from './author-contracts';
import type { CliConfig } from './config';
import { CliError } from '../lib/errors';

/** Entries per `fetchAllPaged` call. A page is one `eth_call`. */
export const DRAFTS_PAGE_SIZE = 100;

/** Where a drafts module was found. */
export type DraftsModuleSource = 'enabled' | 'factory';

export interface ResolvedDraftsModule {
  address: Address;
  source: DraftsModuleSource;
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
  /** The factory index (`getDraftsModulesForSafe` and siblings). */
  readFactory(opts: ResolveDraftsModuleOptions): Promise<AuthorContracts>;
  /** `count()` — the number of genesis ids in the log. */
  readCount(opts: { address: Address; rpcUrl: string }): Promise<bigint>;
  readPage(opts: ReadDraftsPageOptions): Promise<RawDraftEntry[]>;
}

function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

export const defaultDraftsSeam: DraftsSeam = {
  readEnabled: (opts) => readEnabledAuthorModules(opts),
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
 */
export async function resolveDraftsModule(
  opts: ResolveDraftsModuleOptions,
  seam: DraftsSeam = defaultDraftsSeam,
): Promise<ResolvedDraftsModule> {
  const enabled = await seam.readEnabled({ safe: opts.safe, rpcUrl: opts.rpcUrl });
  const onSafe = enabled.drafts;
  if (onSafe !== null) return { address: getAddress(onSafe.toLowerCase()), source: 'enabled' };

  const index = await seam.readFactory(opts);
  const created = index.drafts;
  if (created !== null) return { address: getAddress(created.toLowerCase()), source: 'factory' };

  throw new CliError(
    `no enabled drafts module on author Safe ${opts.safe} — run: s2s author init`,
    1,
    'no_drafts_module',
  );
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
