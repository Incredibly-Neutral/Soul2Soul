// ============================================================================
// The handle registry, and the three calls the CLI makes on it.
//
// A handle is the unique public name of an author Safe (`alice.s2s` in display,
// `alice` on chain). The registry is a plain contract on Base — no ENS, no DNS
// — that maps a handle to the Safe that owns it and to the records module that
// Safe had enabled at registration.
//
// Three operations, all of them a Safe self-call because the registry keys on
// `msg.sender`:
//
//   check(handle)                read-only: available, and a numeric reason
//   register(handle, records)    the owning Safe claims the name
//   release()                    the owning Safe gives it up; the cooldown starts
//
// `register` is gated: `S2SAuthorGate` accepts a records module only when that
// module answers `safe()` with the registering Safe, so the pointer written at
// registration is a module this Safe actually has. The CLI resolves that module
// the way `author bio` and the install do, and `--records` overrides it — the
// gate still decides, and a refusal is named as such.
//
// A userOp hash is not proof: `genericTx` resolves with the hash of a
// transaction that may have reverted. Every send here is followed by a re-read
// of the state it was supposed to change (`nameOf`, `resolve`, `entry`), and
// only the read-back counts.
//
// The registry address resolves from `--registry`, then `contracts.registry`
// (env `S2S_REGISTRY_ADDRESS`), then the shipped default. That default is the
// zero address until the registry is deployed, so "no code at the address" is
// reported as "not deployed yet" — a named state, not a generic RPC error.
// ============================================================================

import { base } from 'viem/chains';
import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem';
import { S2SRegistry } from '@s2s/author-contracts';

import type { SafeRunnerHandle } from '../adapters/tx-runner';
import { CliError, UsageError, describeError } from '../lib/errors';
import { defaultAuthorContractsSeam } from './author-contracts';
import type { CliConfig } from './config';
import { defaultForPath, textValue } from './configschema';

/** The zero address: no registry configured, no holder, no records location. */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** The registry the CLI ships with until one is deployed. */
export const DEFAULT_S2S_REGISTRY: Address = ZERO_ADDRESS;

/**
 * `S2SRegistry.check` reasons. The numbers are the contract's constants, so a
 * caller and the chain read the same code; the sentence belongs to the CLI.
 */
export const HANDLE_REASONS = {
  free: 0,
  invalidChar: 1,
  invalidLength: 2,
  invalidHyphen: 3,
  reserved: 4,
  skeletonTaken: 5,
  cooling: 6,
  registered: 7,
} as const;

/** The live entry `entry(handle)` answers; zeroed when the name is free. */
export interface RegistryEntry {
  safe: Address;
  handle: string;
  version: number;
  registeredAt: number;
  recordsLocation: Address;
}

export interface HandleCheck {
  available: boolean;
  reason: number;
}

/** The registry address in effect: flag, config, env, shipped default. */
export interface RegistryConfig {
  contracts?: { registry?: string };
}

/** A 20-byte hex address, checksummed; a usage error for anything else. */
export function asRegistryAddress(value: string, source: string): Address {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new UsageError(`${source} is not an address: '${value}'`);
  }
  return getAddress(trimmed.toLowerCase());
}

export function authorRegistryAddress(config: RegistryConfig, override?: string): Address {
  const fromFlag = textValue(override);
  if (fromFlag !== undefined) return asRegistryAddress(fromFlag, '--registry');

  const fromConfig = textValue(config.contracts?.registry);
  if (fromConfig !== undefined) return asRegistryAddress(fromConfig, 'contracts.registry');

  const fromEnv = textValue(process.env.S2S_REGISTRY_ADDRESS);
  if (fromEnv !== undefined) return asRegistryAddress(fromEnv, 'S2S_REGISTRY_ADDRESS');

  return asRegistryAddress(
    defaultForPath('contracts.registry') ?? DEFAULT_S2S_REGISTRY,
    'contracts.registry',
  );
}

/** One human sentence for a `check` reason. */
export function handleReasonSentence(handle: string, reason: number): string {
  switch (reason) {
    case HANDLE_REASONS.free:
      return `'${handle}' is free`;
    case HANDLE_REASONS.invalidChar:
      return `'${handle}' has a character outside a-z, 0-9 and '-' (uppercase is rejected, not folded)`;
    case HANDLE_REASONS.invalidLength:
      return `'${handle}' is ${String(new TextEncoder().encode(handle).length)} bytes — a handle is 3..32 bytes of a-z, 0-9 and '-'`;
    case HANDLE_REASONS.invalidHyphen:
      return `'${handle}' has a leading, trailing or doubled hyphen`;
    case HANDLE_REASONS.reserved:
      return `'${handle}' is reserved`;
    case HANDLE_REASONS.skeletonTaken:
      return `'${handle}' is taken by another spelling of the same name`;
    case HANDLE_REASONS.cooling:
      return `'${handle}' is cooling down after a release (90 days)`;
    case HANDLE_REASONS.registered:
      return `'${handle}' is already registered`;
    default:
      return `'${handle}' is not available (registry reason ${String(reason)})`;
  }
}

/** The short label for a reason, for the one-line human block. */
export function handleReasonLabel(reason: number): string {
  switch (reason) {
    case HANDLE_REASONS.free:
      return 'free';
    case HANDLE_REASONS.invalidChar:
      return 'invalid character';
    case HANDLE_REASONS.invalidLength:
      return 'invalid length';
    case HANDLE_REASONS.invalidHyphen:
      return 'invalid hyphen';
    case HANDLE_REASONS.reserved:
      return 'reserved';
    case HANDLE_REASONS.skeletonTaken:
      return 'skeleton taken';
    case HANDLE_REASONS.cooling:
      return 'cooling';
    case HANDLE_REASONS.registered:
      return 'registered';
    default:
      return `unknown (${String(reason)})`;
  }
}

// ===========================================================================
// Reads
// ===========================================================================

/** A public client per read: a client is cheap, a cached one is stale state. */
function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

export interface RegistryReadOptions {
  registry: Address;
  rpcUrl: string;
}

/** Whether an address carries bytecode — the proof the registry is deployed. */
export async function readHasCode(opts: { address: Address; rpcUrl: string }): Promise<boolean> {
  const code = await clientFor(opts.rpcUrl).getCode({ address: opts.address });
  return code !== undefined && code !== '0x';
}

export async function readCheck(
  opts: RegistryReadOptions & { handle: string },
): Promise<HandleCheck> {
  const [available, reason] = (await clientFor(opts.rpcUrl).readContract({
    address: opts.registry,
    abi: S2SRegistry,
    functionName: 'check',
    args: [opts.handle],
  })) as [boolean, number];
  return { available, reason: Number(reason) };
}

/** The handle a Safe holds, or null for the empty string the registry returns. */
export async function readNameOf(
  opts: RegistryReadOptions & { safe: Address },
): Promise<string | null> {
  const name = await clientFor(opts.rpcUrl).readContract({
    address: opts.registry,
    abi: S2SRegistry,
    functionName: 'nameOf',
    args: [opts.safe],
  });
  return name === '' ? null : name;
}

export async function readEntry(
  opts: RegistryReadOptions & { handle: string },
): Promise<RegistryEntry> {
  const entry = await clientFor(opts.rpcUrl).readContract({
    address: opts.registry,
    abi: S2SRegistry,
    functionName: 'entry',
    args: [opts.handle],
  });
  return {
    safe: entry.safe,
    handle: entry.handle,
    version: Number(entry.version),
    registeredAt: Number(entry.registeredAt),
    recordsLocation: entry.recordsLocation,
  };
}

/** The last version ever assigned to a handle; survives release on purpose. */
export async function readVersionOf(
  opts: RegistryReadOptions & { handle: string },
): Promise<number> {
  const version = await clientFor(opts.rpcUrl).readContract({
    address: opts.registry,
    abi: S2SRegistry,
    functionName: 'versionOf',
    args: [opts.handle],
  });
  return Number(version);
}

/** The Safe holding a handle, or null for the zero address. */
export async function readResolve(
  opts: RegistryReadOptions & { handle: string },
): Promise<Address | null> {
  const safe = await clientFor(opts.rpcUrl).readContract({
    address: opts.registry,
    abi: S2SRegistry,
    functionName: 'resolve',
    args: [opts.handle],
  });
  return safe === ZERO_ADDRESS ? null : getAddress(safe.toLowerCase());
}

export interface RegistrySeam {
  readHasCode(opts: { address: Address; rpcUrl: string }): Promise<boolean>;
  check(opts: RegistryReadOptions & { handle: string }): Promise<HandleCheck>;
  nameOf(opts: RegistryReadOptions & { safe: Address }): Promise<string | null>;
  entry(opts: RegistryReadOptions & { handle: string }): Promise<RegistryEntry>;
  versionOf(opts: RegistryReadOptions & { handle: string }): Promise<number>;
  resolve(opts: RegistryReadOptions & { handle: string }): Promise<Address | null>;
}

export const defaultRegistrySeam: RegistrySeam = {
  readHasCode,
  check: readCheck,
  nameOf: readNameOf,
  entry: readEntry,
  versionOf: readVersionOf,
  resolve: readResolve,
};

/**
 * Refuse an address with no code as "not deployed yet". The default registry is
 * the zero address, so this is the ordinary state of a build whose registry has
 * not shipped, and it must not read like a network failure.
 */
export async function requireRegistryDeployed(
  registry: Address,
  rpcUrl: string,
  seam: Pick<RegistrySeam, 'readHasCode'> = defaultRegistrySeam,
): Promise<void> {
  if (await seam.readHasCode({ address: registry, rpcUrl })) return;
  throw new CliError(
    registry === ZERO_ADDRESS
      ? 'no handle registry is configured yet — the S2S registry is not deployed; set contracts.registry (or S2S_REGISTRY_ADDRESS) once it is on Base'
      : `the S2S registry ${registry} is not deployed yet — it has no code; set contracts.registry (or S2S_REGISTRY_ADDRESS) to the deployed registry`,
  );
}

// ===========================================================================
// Writes
// ===========================================================================

export interface RegistryWriteSeam {
  openRunner(opts: {
    config: CliConfig;
    privateKey: Hex;
    rpcUrl: string;
    safe: Address;
  }): Promise<Pick<SafeRunnerHandle, 'genericTx'>>;
}

export interface RegistryDeps extends RegistrySeam, RegistryWriteSeam {}

export const defaultRegistryWriteSeam: RegistryWriteSeam = {
  openRunner: (opts) => defaultAuthorContractsSeam.openRunner(opts),
};

export interface RegisterHandleOptions {
  registry: Address;
  safe: Address;
  handle: string;
  records: Address;
  config: CliConfig;
  privateKey: string;
  rpcUrl: string;
  /** Set when `--records` supplied the location: the gate is what decides. */
  recordsSource?: 'flag';
}

export interface HandleWriteResult {
  handle: string;
  version: number;
  records: Address | null;
}

function sameAddress(a: Address | null, b: Address): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * `register(handle, records)` from the Safe, then the three reads that prove
 * it: `nameOf(safe)` holds the handle, `resolve(handle)` is the Safe, and
 * `entry(handle)` carries the version and the records pointer.
 */
export async function sendRegister(
  opts: RegisterHandleOptions,
  deps: RegistryDeps,
): Promise<HandleWriteResult> {
  const runner = await deps.openRunner({
    config: opts.config,
    privateKey: opts.privateKey as Hex,
    rpcUrl: opts.rpcUrl,
    safe: opts.safe,
  });
  await runner.genericTx(
    opts.registry,
    JSON.stringify(S2SRegistry),
    'register',
    [opts.handle, opts.records],
    false,
  );

  const read = { registry: opts.registry, rpcUrl: opts.rpcUrl };
  const gateNote =
    opts.recordsSource === 'flag'
      ? ` — the registry gate accepts only a records module that answers safe() with this Safe, so it may have refused ${opts.records}`
      : '';

  const name = await deps.nameOf({ ...read, safe: opts.safe });
  if (name !== opts.handle) {
    throw new CliError(
      `the register transaction did not register '${opts.handle}' on ${opts.registry} — the Safe ${opts.safe} holds ${name === null ? 'no handle' : `'${name}'`}; it may have reverted${gateNote}`,
    );
  }

  const holder = await deps.resolve({ ...read, handle: opts.handle });
  if (!sameAddress(holder, opts.safe)) {
    throw new CliError(
      `the registry resolves '${opts.handle}' to ${holder ?? 'no address'}, not the Safe ${opts.safe} — it may have reverted${gateNote}`,
    );
  }

  const entry = await deps.entry({ ...read, handle: opts.handle });
  return {
    handle: opts.handle,
    version: entry.version,
    records: entry.recordsLocation === ZERO_ADDRESS ? null : entry.recordsLocation,
  };
}

/** Check, then register. The pre-flight is what makes "nothing was sent" true. */
export async function registerHandle(
  opts: RegisterHandleOptions,
  deps: RegistryDeps,
): Promise<HandleWriteResult> {
  const status = await deps.check({
    registry: opts.registry,
    handle: opts.handle,
    rpcUrl: opts.rpcUrl,
  });
  if (!status.available) {
    throw new CliError(
      `cannot register '${opts.handle}': ${handleReasonSentence(opts.handle, status.reason)}; nothing was sent`,
    );
  }
  return sendRegister(opts, deps);
}

export interface ReleaseHandleOptions {
  registry: Address;
  safe: Address;
  config: CliConfig;
  privateKey: string;
  rpcUrl: string;
}

/**
 * `release()` from the Safe, after reading what it holds, then prove the read
 * back is empty. `NoHandle` reverts, so an empty name is never sent.
 */
export async function sendRelease(
  opts: ReleaseHandleOptions,
  deps: RegistryDeps,
): Promise<HandleWriteResult | null> {
  const read = { registry: opts.registry, rpcUrl: opts.rpcUrl };
  const current = await deps.nameOf({ ...read, safe: opts.safe });
  if (current === null) return null;

  const before = await deps.entry({ ...read, handle: current });
  const runner = await deps.openRunner({
    config: opts.config,
    privateKey: opts.privateKey as Hex,
    rpcUrl: opts.rpcUrl,
    safe: opts.safe,
  });
  await runner.genericTx(opts.registry, JSON.stringify(S2SRegistry), 'release', [], false);

  const after = await deps.nameOf({ ...read, safe: opts.safe });
  if (after !== null) {
    throw new CliError(
      `the release transaction did not release '${current}' on ${opts.registry} — the Safe ${opts.safe} still holds it; it may have reverted`,
    );
  }
  return {
    handle: current,
    version: before.version,
    records: before.recordsLocation === ZERO_ADDRESS ? null : before.recordsLocation,
  };
}

// ===========================================================================
// The `author new` / `author init` extra
// ===========================================================================

export interface InstallHandleOptions {
  config: CliConfig;
  safe: Address;
  records: Address | null;
  privateKey: string;
  rpcUrl: string;
  /** `--handle`; absent means "report what the Safe holds, register nothing". */
  handle?: string;
}

export interface InstallHandleReport {
  handle: string | null;
  handleNote?: string;
}

/**
 * The handle step after a contract install. Never throws: the key and the Safe
 * are already filed, and a refused registration is a note, exactly as a records
 * module that did not install is.
 *
 * With no `--handle` it only reads what the Safe holds, and says nothing when
 * it holds nothing.
 */
export async function registerOnInstall(
  opts: InstallHandleOptions,
  deps: RegistryDeps = { ...defaultRegistrySeam, ...defaultRegistryWriteSeam },
): Promise<InstallHandleReport> {
  let registry: Address;
  try {
    registry = authorRegistryAddress(opts.config);
  } catch (err) {
    return opts.handle === undefined
      ? { handle: null }
      : { handle: null, handleNote: `the handle was not registered: ${describeError(err)}` };
  }

  let deployed: boolean;
  try {
    deployed = await deps.readHasCode({ address: registry, rpcUrl: opts.rpcUrl });
  } catch (err) {
    return opts.handle === undefined
      ? { handle: null, handleNote: `could not read the registry ${registry} (${describeError(err)})` }
      : {
          handle: null,
          handleNote: `the handle was not registered: could not read the registry ${registry} (${describeError(err)})`,
        };
  }

  if (!deployed) {
    if (opts.handle === undefined) return { handle: null };
    return {
      handle: null,
      handleNote: `the handle '${opts.handle}' was not registered: the registry ${registry} is not deployed yet`,
    };
  }

  if (opts.handle === undefined) {
    try {
      return { handle: await deps.nameOf({ registry, safe: opts.safe, rpcUrl: opts.rpcUrl }) };
    } catch (err) {
      return { handle: null, handleNote: `could not read the registry ${registry} (${describeError(err)})` };
    }
  }

  if (opts.records === null) {
    return {
      handle: null,
      handleNote: `the handle '${opts.handle}' was not registered: the Safe has no records module — run \`s2s author init\` first`,
    };
  }

  try {
    const result = await registerHandle(
      {
        registry,
        safe: opts.safe,
        handle: opts.handle,
        records: opts.records,
        config: opts.config,
        privateKey: opts.privateKey,
        rpcUrl: opts.rpcUrl,
      },
      deps,
    );
    return { handle: result.handle };
  } catch (err) {
    return {
      handle: null,
      handleNote: `the handle '${opts.handle}' was not registered: ${describeError(err)}`,
    };
  }
}
