// ============================================================================
// s2s author handle — the author Safe's unique name in the registry.
//
//   s2s author handle                        # status: the handle, entry, version
//   s2s author handle alice                  # register
//   s2s author handle alice --check          # availability only, no transaction
//   s2s author handle alice --release        # release (only when the Safe owns it)
//
// The registry keys on `msg.sender`, so both writes are Safe self-calls through
// the same runner `author bio` uses. Nothing is sent that a read did not clear:
// `--check` and the register pre-flight ask `check(handle)` first, and a release
// with no handle on the Safe opens no runner at all — the shape of
// `author bio --clear` on an absent bio.
//
// The records pointer is resolved the way the install and `author bio` resolve
// it (factory → implementation → predicted module → the Safe's enabled list), so
// a registration names the module the Safe actually carries. `--records`
// overrides it, but only with an address that has code; the registry gate still
// decides whether that module belongs to this Safe, and a refusal says so.
//
// Runs without `buildContext` (no Lit keys, no publication), but it does need
// the L2 RPC and the store's active author: the entries live on chain.
// ============================================================================

import type { Address } from 'viem';

import type { ParsedArgs } from '../lib/args';
import { flagBool, flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError, describeError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { buildRpcEndpoints } from '../adapters/rpc';
import type { SafeRunnerHandle } from '../adapters/tx-runner';
import { authorContractsFactory, defaultAuthorContractsSeam } from '../core/author-contracts';
import { defaultRecordsSeam, resolveRecords, type RecordsResolution } from '../core/author-records';
import {
  asRegistryAddress,
  authorRegistryAddress,
  defaultRegistrySeam,
  defaultRegistryWriteSeam,
  handleReasonLabel,
  handleReasonSentence,
  requireRegistryDeployed,
  sendRegister,
  sendRelease,
  ZERO_ADDRESS,
  type HandleCheck,
  type RegistryDeps,
  type RegistryEntry,
} from '../core/author-registry';
import { activeAuthorRecord, readAuthors, type AuthorsStore } from '../core/authors';
import { loadConfig, type CliConfig } from '../core/config';

export type AuthorHandleAction =
  | 'author.handle'
  | 'author.handle.register'
  | 'author.handle.release'
  | 'author.handle.check';

/** The machine block: one object, whatever operation ran. */
export interface AuthorHandleResult {
  action: AuthorHandleAction;
  safe: Address;
  handle: string | null;
  version: number | null;
  records: Address | null;
  available: boolean | null;
  reason: number | null;
}

/** The registry reads, the records resolution and the one runner seam. */
export interface AuthorHandleDeps extends RegistryDeps {
  store(): AuthorsStore;
  config(): CliConfig;
  /** Config → factory → implementation → the Safe's module. */
  resolveRecords(opts: { safe: Address; rpcUrl: string }): Promise<RecordsResolution>;
  /** The Safe's enabled-module list — the proof the module is installed. */
  readEnabled(opts: { safe: Address; rpcUrl: string }): Promise<Address[]>;
}

export function authorHandleDeps(overrides: Partial<AuthorHandleDeps> = {}): AuthorHandleDeps {
  const config = overrides.config ?? (() => loadConfig());
  return {
    ...defaultRegistrySeam,
    ...defaultRegistryWriteSeam,
    store: overrides.store ?? (() => readAuthors()),
    config,
    resolveRecords:
      overrides.resolveRecords ??
      ((opts) =>
        resolveRecords({ ...opts, factory: authorContractsFactory(config()) }, defaultRecordsSeam)),
    readEnabled:
      overrides.readEnabled ??
      (async (opts) => (await defaultAuthorContractsSeam.readEnabled(opts)).modules),
    ...overrides,
  };
}

/** The active author's Safe, or a usage error naming how to get one. */
function requireAuthor(deps: AuthorHandleDeps): {
  name: string;
  safe: Address;
  privateKey: string;
} {
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
 * The records pointer for a registration: the same resolution the install and
 * `author bio` perform, including the enabled-list proof. `--records` replaces
 * it only with an address that carries code; the gate makes the final call.
 */
async function recordsForRegister(
  safe: Address,
  rpcUrl: string,
  override: string | undefined,
  deps: AuthorHandleDeps,
): Promise<{ records: Address; source: 'flag' | undefined }> {
  if (override !== undefined) {
    const records = asRegistryAddress(override, '--records');
    if (!(await deps.readHasCode({ address: records, rpcUrl }))) {
      throw new CliError(
        `--records ${records} has no code — the registry gate accepts only the records module the Safe has enabled`,
      );
    }
    return { records, source: 'flag' };
  }

  let resolved: RecordsResolution;
  try {
    resolved = await deps.resolveRecords({ safe, rpcUrl });
  } catch (err) {
    throw new CliError(`could not read the records module for ${safe}: ${describeError(err)}`);
  }
  if (!resolved.deployed) {
    throw new CliError(
      `the author factory ${resolved.factory} is not deployed — run \`s2s author init\` first`,
    );
  }
  if (resolved.implementation === null) {
    throw new CliError(
      `the author factory ${resolved.factory} has no records implementation set — run \`s2s author init\` first`,
    );
  }
  if (resolved.address === null) {
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
  return { records: resolved.address, source: undefined };
}

/** `<handle>.s2s` in the human block; the JSON keeps the bare name. */
function displayHandle(handle: string | null): string {
  return handle === null ? '(none)' : `${handle}.s2s`;
}

function lines(entries: readonly [string, string][]): string {
  return entries
    .map(([label, value]) => (label === '' ? `              ${value}` : `${label.padEnd(12)}: ${value}`))
    .join('\n');
}

/** The status read, with the entry only when the Safe holds a handle. */
async function readStatus(
  registry: Address,
  safe: Address,
  rpcUrl: string,
  deps: AuthorHandleDeps,
): Promise<{
  handle: string | null;
  version: number | null;
  records: Address | null;
}> {
  const handle = await deps.nameOf({ registry, safe, rpcUrl });
  if (handle === null) return { handle: null, version: null, records: null };
  const entry: RegistryEntry = await deps.entry({ registry, handle, rpcUrl });
  const version = await deps.versionOf({ registry, handle, rpcUrl });
  return {
    handle,
    version,
    records: entry.recordsLocation === ZERO_ADDRESS ? null : entry.recordsLocation,
  };
}

export async function runAuthorHandle(
  out: CliOut,
  args: ParsedArgs,
  deps: AuthorHandleDeps = authorHandleDeps(),
): Promise<void> {
  const check = flagBool(args.flags, 'check');
  const release = flagBool(args.flags, 'release');
  const registryFlag = flagString(args.flags, 'registry');
  const recordsFlag = flagString(args.flags, 'records');
  const handle = args.positionals[0];

  if (args.positionals.length > 1) {
    throw new UsageError('the handle takes one name');
  }
  if (check && release) {
    throw new UsageError('`--check` and `--release` are different operations — pick one');
  }
  if (check && handle === undefined) {
    throw new UsageError('`--check` needs a handle name — run `s2s author handle <name> --check`');
  }
  if (release && recordsFlag !== undefined) {
    throw new UsageError('`--records` applies to registering a handle, not releasing one');
  }

  const author = requireAuthor(deps);
  const config = deps.config();
  const rpcUrl = requireRpc(config);
  const registry = authorRegistryAddress(config, registryFlag);
  await requireRegistryDeployed(registry, rpcUrl, deps);

  const base = { safe: author.safe };
  const read = { registry, rpcUrl };

  // --check: availability only. Nothing is sent, whatever the answer.
  if (check && handle !== undefined) {
    const status: HandleCheck = await deps.check({ ...read, handle });
    const result: AuthorHandleResult = {
      action: 'author.handle.check',
      ...base,
      handle,
      version: null,
      records: null,
      available: status.available,
      reason: status.reason,
    };
    out.result(
      result,
      lines([
        ['author', author.name],
        ['safe', author.safe],
        ['registry', registry],
        ['handle', displayHandle(handle)],
        ['available', status.available ? 'yes' : 'no'],
        ['reason', `${handleReasonLabel(status.reason)} (${String(status.reason)})`],
      ]),
    );
    return;
  }

  // --release: read what the Safe holds first, so an empty name sends nothing.
  if (release) {
    const current = await deps.nameOf({ ...read, safe: author.safe });
    if (current === null) {
      // No handle on the Safe is nothing to release, but a name given here may
      // still belong to somebody else — that is a failure, not a quiet no-op.
      if (handle !== undefined) {
        const holder = await deps.resolve({ ...read, handle });
        if (holder !== null && holder.toLowerCase() !== author.safe.toLowerCase()) {
          throw new CliError(
            `the handle '${handle}' belongs to the Safe ${holder}, not ${author.safe} — nothing was released`,
          );
        }
      }
      const result: AuthorHandleResult = {
        action: 'author.handle.release',
        ...base,
        handle: null,
        version: null,
        records: null,
        available: null,
        reason: null,
      };
      out.result(
        result,
        lines([
          ['author', author.name],
          ['safe', author.safe],
          ['registry', registry],
          ['handle', '(none)'],
          ['', '(the Safe holds no handle — nothing to release)'],
        ]),
      );
      return;
    }

    if (handle !== undefined && handle !== current) {
      const holder = await deps.resolve({ ...read, handle });
      if (holder !== null) {
        throw new CliError(
          `the handle '${handle}' belongs to the Safe ${holder}, not ${author.safe} — nothing was released`,
        );
      }
      throw new CliError(
        `the Safe ${author.safe} holds '${current}', not '${handle}' — run \`s2s author handle --release\` to release '${current}'`,
      );
    }

    out.log(`releasing '${current}' on the registry ${registry}…`);
    const released = await sendRelease(
      { registry, safe: author.safe, config, privateKey: author.privateKey, rpcUrl },
      deps,
    );
    const result: AuthorHandleResult = {
      action: 'author.handle.release',
      ...base,
      handle: released?.handle ?? current,
      version: released?.version ?? null,
      records: released?.records ?? null,
      available: null,
      reason: null,
    };
    out.result(
      result,
      lines([
        ['author', author.name],
        ['safe', author.safe],
        ['registry', registry],
        ['handle', displayHandle(result.handle)],
        ['version', result.version === null ? '(none)' : String(result.version)],
        ['records', result.records ?? '(none)'],
        ['', '(handle released — the cooldown has started)'],
      ]),
    );
    return;
  }

  // A positional with no operation flag is a registration.
  if (handle !== undefined) {
    const status = await deps.check({ ...read, handle });
    if (!status.available) {
      throw new CliError(
        `cannot register '${handle}': ${handleReasonSentence(handle, status.reason)}; nothing was sent`,
      );
    }

    const { records, source } = await recordsForRegister(author.safe, rpcUrl, recordsFlag, deps);
    out.log(`registering '${handle}' on the registry ${registry}…`);
    const registered = await sendRegister(
      {
        registry,
        safe: author.safe,
        handle,
        records,
        config,
        privateKey: author.privateKey,
        rpcUrl,
        ...(source === 'flag' ? { recordsSource: 'flag' as const } : {}),
      },
      deps,
    );
    const result: AuthorHandleResult = {
      action: 'author.handle.register',
      ...base,
      handle: registered.handle,
      version: registered.version,
      records: registered.records ?? records,
      available: null,
      reason: null,
    };
    out.result(
      result,
      lines([
        ['author', author.name],
        ['safe', author.safe],
        ['registry', registry],
        ['handle', displayHandle(result.handle)],
        ['version', String(result.version)],
        ['records', result.records ?? '(none)'],
        ['', '(handle registered)'],
      ]),
    );
    return;
  }

  // No positional, no operation flag: status.
  const status = await readStatus(registry, author.safe, rpcUrl, deps);
  const result: AuthorHandleResult = {
    action: 'author.handle',
    ...base,
    handle: status.handle,
    version: status.version,
    records: status.records,
    available: null,
    reason: null,
  };
  out.result(
    result,
    lines([
      ['author', author.name],
      ['safe', author.safe],
      ['registry', registry],
      ['handle', displayHandle(status.handle)],
      ['version', status.version === null ? '(none)' : String(status.version)],
      ['records', status.records ?? '(none)'],
    ]),
  );
}

export const authorHandle: StoreCommandSpec = {
  name: 'handle',
  summary: "Read, register or release the author Safe's .s2s handle.",
  params: '[<handle>]',
  flags: {
    registry: {
      type: 'string',
      summary: 'registry address to use instead of contracts.registry',
      value: '<address>',
    },
    records: {
      type: 'string',
      summary: 'records module to register (must have code; the gate decides)',
      value: '<address>',
    },
    check: { type: 'boolean', summary: 'report availability only; send nothing' },
    release: { type: 'boolean', summary: "release the Safe's handle and start the cooldown" },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runAuthorHandle(out, args);
  },
};
