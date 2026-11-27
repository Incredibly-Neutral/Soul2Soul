// ============================================================================
// s2s author bio — the author's `bio` record, and the `pen_name` beside it.
//
//   s2s author bio                          # read what the records module holds
//   s2s author bio "writes about protocols" # set bio (trimmed, capped)
//   s2s author bio --clear                  # delete the bio record
//
// The value is a plain string in the protocol's generic records module, next to
// `pen_name` — no CID, no JSON document, no IPFS. Both are `onlySafe` writes, so
// each one goes out as a Safe self-call through the same runner `author init`
// uses; this command opens a runner only when it is writing.
//
// The records module is resolved the way `author init` resolves it, every run:
// the protocol manifest names the factory, the factory predicts the Safe's
// module, and the Safe's own enabled-module list proves it is installed. Nothing
// is cached in `authors.json` — a removed module would leave a stale address
// there, and the store records what the Safe was, not what it is.
//
// An author without a records module is sent to `s2s author init`, which is the
// command that installs it. This one does not install: a bio is not the place to
// create modules, enable them and write a pet name as a side effect.
//
// Runs without `buildContext` (no Lit keys, no publication), but it does need
// the L2 RPC and the store's active author: the record lives on chain.
// ============================================================================

import type { Address, Hex } from 'viem';
import { S2SRecordsModuleV0_1 } from '@s2s/publication-contracts';

import type { ParsedArgs } from '../lib/args';
import { flagBool } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError, describeError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { buildRpcEndpoints } from '../adapters/rpc';
import type { SafeRunnerHandle } from '../adapters/tx-runner';
import { defaultAuthorContractsSeam } from '../core/author-contracts';
import {
  BIO_KEY,
  BIO_MAX_LENGTH,
  PEN_NAME_KEY,
  defaultRecordsSeam,
  resolveRecords,
  type RecordsResolution,
} from '../core/author-records';
import { activeAuthorRecord, readAuthors, type AuthorsStore } from '../core/authors';
import { loadConfig, type CliConfig } from '../core/config';

/** Which of the three operations ran. */
export type AuthorBioAction = 'author.bio' | 'author.bio.set' | 'author.bio.clear';

/** The machine block: where the records are, and the two values it holds. */
export interface AuthorBioResult {
  action: AuthorBioAction;
  /** The author Safe the records belong to. */
  safe: Address;
  /** The records module address (the prediction, proved by the enabled list). */
  records: Address;
  penName: string | null;
  bio: string | null;
}

/** The reads, the write and the two sources of ambient state; a test replaces them whole. */
export interface AuthorBioDeps {
  store(): AuthorsStore;
  config(): CliConfig;
  /** Manifest → factory → implementation → the Safe's predicted module. */
  resolve(opts: { safe: Address; rpcUrl: string }): Promise<RecordsResolution>;
  readRecord(opts: { module: Address; key: string; rpcUrl: string }): Promise<string | null>;
  /** The Safe's enabled-module list — the proof the module is installed. */
  readEnabled(opts: { safe: Address; rpcUrl: string }): Promise<Address[]>;
  openRunner(opts: {
    config: CliConfig;
    privateKey: Hex;
    rpcUrl: string;
    safe: Address;
  }): Promise<Pick<SafeRunnerHandle, 'genericTx'>>;
}

export function authorBioDeps(overrides: Partial<AuthorBioDeps> = {}): AuthorBioDeps {
  return {
    store: overrides.store ?? (() => readAuthors()),
    config: overrides.config ?? (() => loadConfig()),
    resolve:
      overrides.resolve ??
      ((opts) => resolveRecords(opts, defaultRecordsSeam)),
    readRecord:
      overrides.readRecord ??
      ((opts) => defaultRecordsSeam.record(opts)),
    readEnabled:
      overrides.readEnabled ??
      (async (opts) => (await defaultAuthorContractsSeam.readEnabled(opts)).modules),
    openRunner: overrides.openRunner ?? defaultAuthorContractsSeam.openRunner,
  };
}

/** The active author's Safe, or a usage error naming how to get one. */
function requireAuthor(deps: AuthorBioDeps): { name: string; safe: Address; privateKey: string } {
  const author = activeAuthorRecord(deps.store());
  if (!author) {
    throw new UsageError('no active author — run `s2s author new <pet-name>` to add one');
  }
  if (!author.safe) {
    throw new CliError(
      `author '${author.name}' has no Safe address yet — run \`s2s author init\` first`,
    );
  }
  return { name: author.name, safe: author.safe as Address, privateKey: author.privateKey };
}

/** The L2 endpoint, or a failure naming the setting that supplies one. */
function requireRpc(config: CliConfig): string {
  const rpcUrl = buildRpcEndpoints(config).L2[0];
  if (!rpcUrl) throw new CliError('no L2 RPC configured — set S2S_RPC_L2 or rpc.l2 in config');
  return rpcUrl;
}

/**
 * Resolve the records module and prove the Safe carries it. A module that the
 * factory can deploy but this Safe has not enabled is "not installed" from the
 * outside, so both halves are required here.
 */
async function requireRecords(
  safe: Address,
  rpcUrl: string,
  deps: AuthorBioDeps,
): Promise<Address> {
  let resolved: RecordsResolution;
  try {
    resolved = await deps.resolve({ safe, rpcUrl });
  } catch (err) {
    throw new CliError(`could not read the records module for ${safe}: ${describeError(err)}`);
  }
  if (resolved.implementation === null || resolved.address === null) {
    throw new CliError(
      `the Safe ${safe} has no records module — run \`s2s author init\` to install it`,
    );
  }
  const enabled = await deps.readEnabled({ safe, rpcUrl });
  const installed = enabled.some((entry) => entry.toLowerCase() === resolved.address!.toLowerCase());
  if (!installed) {
    throw new CliError(
      `the records module ${resolved.address} is not enabled on the Safe ${safe} — run \`s2s author init\` to install it`,
    );
  }
  return resolved.address;
}

/** Read both records; either may be absent. */
async function readBoth(
  module: Address,
  rpcUrl: string,
  deps: AuthorBioDeps,
): Promise<{ penName: string | null; bio: string | null }> {
  const penName = await deps.readRecord({ module, key: PEN_NAME_KEY, rpcUrl });
  const bio = await deps.readRecord({ module, key: BIO_KEY, rpcUrl });
  return { penName, bio };
}

/**
 * One userOp does one write; the read-back proves it, as everywhere else in this
 * CLI. The runner is bound to the Safe, so the Safe is the `onlySafe` sender.
 */
async function sendRecordCall(
  module: Address,
  method: 'setRecord' | 'deleteRecord',
  args: unknown[],
  author: { safe: Address; privateKey: string },
  config: CliConfig,
  rpcUrl: string,
  deps: AuthorBioDeps,
): Promise<void> {
  const runner = await deps.openRunner({
    config,
    privateKey: author.privateKey as Hex,
    rpcUrl,
    safe: author.safe,
  });
  await runner.genericTx(module, JSON.stringify(S2SRecordsModuleV0_1), method, args, false);
}

export async function runAuthorBio(
  out: CliOut,
  args: ParsedArgs,
  deps: AuthorBioDeps = authorBioDeps(),
): Promise<void> {
  const clear = flagBool(args.flags, 'clear');
  const value = args.positionals[0];
  if (args.positionals.length > 1) {
    throw new UsageError('the bio takes one value — quote it if it contains spaces');
  }
  if (clear && value !== undefined) {
    throw new UsageError('`--clear` takes no value — run `s2s author bio --clear` to delete the bio');
  }

  let trimmed: string | undefined;
  if (value !== undefined) {
    trimmed = value.trim();
    if (trimmed === '') {
      throw new UsageError('the bio is empty — pass some text, or `--clear` to remove the record');
    }
    if (trimmed.length > BIO_MAX_LENGTH) {
      throw new UsageError(
        `the bio is ${String(trimmed.length)} characters — the cap is ${String(BIO_MAX_LENGTH)}; shorten it and run again`,
      );
    }
  }

  const author = requireAuthor(deps);
  const config = deps.config();
  const rpcUrl = requireRpc(config);
  const module = await requireRecords(author.safe, rpcUrl, deps);

  /** A `--clear` that found nothing to delete: no userOp may be sent. */
  let alreadyAbsent = false;

  if (trimmed !== undefined) {
    out.log(`writing the bio on the records module ${module}…`);
    await sendRecordCall(module, 'setRecord', [BIO_KEY, trimmed], author, config, rpcUrl, deps);
    const after = await deps.readRecord({ module, key: BIO_KEY, rpcUrl });
    if (after !== trimmed) {
      throw new CliError(
        `the setRecord transaction did not write the bio on ${module} — it may have reverted; run again`,
      );
    }
  } else if (clear) {
    // `deleteRecord` reverts `KeyNotFound`, so an absent bio must not be sent:
    // the record is read first, and only a present one is deleted.
    const current = await deps.readRecord({ module, key: BIO_KEY, rpcUrl });
    if (current === null) {
      alreadyAbsent = true;
      out.log(`the bio on the records module ${module} is already absent — nothing to clear`);
    } else {
      out.log(`clearing the bio on the records module ${module}…`);
      await sendRecordCall(module, 'deleteRecord', [BIO_KEY], author, config, rpcUrl, deps);
      const after = await deps.readRecord({ module, key: BIO_KEY, rpcUrl });
      if (after !== null) {
        throw new CliError(
          `the deleteRecord transaction did not clear the bio on ${module} — it may have reverted; run again`,
        );
      }
    }
  }

  const values = await readBoth(module, rpcUrl, deps);
  const action: AuthorBioAction =
    trimmed !== undefined ? 'author.bio.set' : clear ? 'author.bio.clear' : 'author.bio';
  const result: AuthorBioResult = {
    action,
    safe: author.safe,
    records: module,
    penName: values.penName,
    bio: values.bio,
  };

  const lines = [
    `author      : ${author.name}`,
    `safe        : ${author.safe}`,
    `records     : ${module}`,
    `pen_name    : ${values.penName ?? '(absent)'}`,
    `bio         : ${values.bio ?? '(absent)'}`,
  ];
  if (action === 'author.bio.set') lines.push('              (bio set)');
  if (action === 'author.bio.clear') {
    lines.push(alreadyAbsent ? '              (bio already absent)' : '              (bio cleared)');
  }
  out.result(result, lines.join('\n'));
}

export const authorBio: StoreCommandSpec = {
  name: 'bio',
  summary: "Read, set or clear the author's bio record on the author Safe.",
  params: '[<text>]',
  flags: {
    clear: { type: 'boolean', summary: 'delete the bio record' },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runAuthorBio(out, args);
  },
};
