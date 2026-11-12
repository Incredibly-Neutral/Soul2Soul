// ============================================================================
// The shared half of `s2s signer` — chain reads, the service, the store name,
// and the seam the three commands take.
//
// The three commands are store commands: they run without a `CliContext`, so
// nothing here may build one. The config is loaded directly (`loadConfig`), the
// L2 endpoint comes from `buildRpcEndpoints` like `author new` does, and the
// Safe Transaction Service is built from `config.safeTx` with the default
// `fetch`.
//
// Two facts drive the shape:
//
//   a Safe is a fact on chain. `signer add` proposes an owner of a Safe that is
//   already deployed, so the owners, the threshold and the nonce are read, never
//   assumed, and a Safe with no bytecode is refused before a key is filed.
//
//   the hash depends on the chain id. The service computes it under Base
//   mainnet's id unless told otherwise, and a hash for another chain is
//   rejected as a mismatch — so the id is written once, in the adapter, and
//   both the local hash and the service take it from there.
//
// Every read and every send goes through `SignerDeps`, so a test supplies a
// fake and opens no socket.
// ============================================================================

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { safeAbi } from '@s2s/soul2soul-shared';

import {
  makeSafeTxService,
  SAFE_TX_CHAIN_ID,
  type SafeTxService,
} from '../adapters/safe-tx';
import {
  addressFromWord,
  readSafeOwners,
  SAFE_FALLBACK_HANDLER_SLOT,
} from '../core/author-contracts';
import { activeAuthorRecord, authorsFilePath, readAuthors, safeProblem } from '../core/authors';
import { givenSafeInUse, createAuthorSafeRunner, SAFE_4337_MODULE } from '../core/author-safe';
import { loadConfig, type CliConfig } from '../core/config';
import { UsageError } from '../lib/errors';
import { buildRpcEndpoints } from '../adapters/rpc';
import { resolveKeySource, type KeySource } from './author-new';

/**
 * The chain a safeTxHash is computed for. Base mainnet is the only chain this
 * CLI authors on (`SAFE_L2_SINGLETON` is pinned to it), and the service indexes
 * per-chain, so a hash computed under another id is rejected as a mismatch.
 *
 * The id itself is written once, in the adapter, and imported here: a second
 * literal would be a second chain the hash could be computed for.
 */
export const SIGNER_CHAIN_ID = SAFE_TX_CHAIN_ID;

/** What the chain says about a Safe, in the form the commands decide on. */
export interface ChainSafe {
  deployed: boolean;
  owners: Address[];
  threshold: number;
  /** The Safe's next nonce: the one a new proposal must carry. */
  nonce: number;
}

/**
 * A Safe address from user input: 20 bytes of hex, checksummed. Anything else
 * is a usage error, because the alternative is a chain read that answers
 * nothing and an owner proposal against the void.
 */
export function asSafeAddress(value: string, source = '<safe>'): Address {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new UsageError(`${source} is not an address: '${value}'`);
  }
  return getAddress(trimmed.toLowerCase());
}

/**
 * A one-line reason for a note or a warning: the message and its code, without
 * the error class name that `describeError` prefixes.
 */
export function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code ? `${err.message} [${code}]` : err.message;
}

/** `0x1234…abcd` — for prose about an address, never for a hash to be typed. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 10)}…${address.slice(-4)}` : address;
}

/** The default pet name for a newly filed signer: six hex digits of its EOA. */
export function defaultSignerName(eoa: Address): string {
  return `signer-${eoa.slice(2, 8).toLowerCase()}`;
}

/**
 * The Safe the queue and confirm commands default to: the stored `given` Safe
 * this config signs for, else the active record's recorded Safe. Undefined when
 * the store has none, which is the caller's usage error to report.
 *
 * Both halves go through the same refusal. `givenSafeInUse` decides for the
 * row filed under this key; the fallback reads the active row, and a row that
 * cannot say which Safe it names (an unreadable `safeSource`, a given row with
 * no address) is refused here rather than passed off as an address — otherwise
 * these commands alone would act on a row every other command refuses.
 */
export function resolveSignerSafe(config: CliConfig): Address | undefined {
  const inUse = givenSafeInUse(config);
  if (inUse) return inUse;
  const active = activeAuthorRecord(readAuthors());
  if (!active) return undefined;
  const problem = safeProblem(active.name, active);
  if (problem) throw new UsageError(problem);
  const stored = active.safe;
  if (!stored) return undefined;
  try {
    return asSafeAddress(stored);
  } catch {
    return undefined;
  }
}

/** The L2 endpoint every signer command reads and sends on. */
export function l2Rpc(config: CliConfig): string {
  const rpcUrl = buildRpcEndpoints(config).L2[0];
  if (!rpcUrl) {
    throw new UsageError('no L2 RPC endpoint configured — set S2S_RPC_L2 (or BASE_RPC_URL)');
  }
  return rpcUrl;
}

// ===========================================================================
// Chain reads
// ===========================================================================

/** Whether an address carries bytecode — a deployed Safe, or a contract owner. */
export async function readCode(rpcUrl: string, address: Address): Promise<boolean> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const code = await client.getCode({ address });
  return code !== undefined && code !== '0x';
}

/**
 * Owners, threshold and nonce of a deployed Safe. An address with no bytecode
 * answers nothing, so it is reported as `deployed: false` with empty fields
 * rather than as three failed calls.
 */
export async function readChainSafe(rpcUrl: string, safe: Address): Promise<ChainSafe> {
  if (!(await readCode(rpcUrl, safe))) {
    return { deployed: false, owners: [], threshold: 0, nonce: 0 };
  }
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const [{ owners, threshold }, nonce] = await Promise.all([
    readSafeOwners({ safe, rpcUrl }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' }),
  ]);
  return { deployed: true, owners, threshold, nonce: Number(nonce) };
}

/** `execTransaction` sent as a plain transaction: the EOA pays its own gas. */
async function sendFromEoa(input: {
  rpcUrl: string;
  privateKey: Hex;
  to: Address;
  data: Hex;
}): Promise<Hex> {
  const account = privateKeyToAccount(input.privateKey);
  const wallet = createWalletClient({ chain: base, transport: http(input.rpcUrl) });
  return wallet.sendTransaction({ account, to: input.to, data: input.data });
}

/**
 * The two facts a sponsored send needs from the Safe itself: the 4337 module is
 * enabled, and the module is what the Safe falls back to. Enabled does not imply
 * installed as the handler, because a Safe can enable a module and still route
 * `validateUserOp` to a different handler.
 */
export interface Safe4337State {
  moduleEnabled: boolean;
  /** The installed handler, or null when the slot is empty. */
  fallbackHandler: Address | null;
}

/**
 * `isModuleEnabled` in the precise shape viem needs. A local fragment rather
 * than the shared `safeAbi`, which types the result `unknown` (it is not a
 * `const` literal), and this read must answer a boolean.
 */
const SAFE_4337_READS = parseAbi(['function isModuleEnabled(address module) view returns (bool)']);

/**
 * The two chain reads the sponsorship decision makes, as functions, so a test
 * can drive `read4337From` with a fake chain instead of a socket. The handler is
 * a *storage* read: Safe 1.4.1 has no `getFallbackHandler()` getter — a call for
 * one falls through into the installed handler and reverts — so asking the Safe
 * is not an option, and the only way to see the handler is
 * `fallback_manager.handler.address`.
 */
export interface Safe4337Reads {
  /** One storage word of the Safe, or undefined when the slot is empty. */
  word(slot: Hex): Promise<Hex | undefined>;
  /** Safe 1.4.1's own `isModuleEnabled(address)`. */
  moduleEnabled(module: Address): Promise<boolean>;
}

/**
 * `isModuleEnabled(SAFE_4337_MODULE)` and the fallback handler, from `reads`.
 *
 * An empty handler word reads as null, not an error: a Safe with no handler
 * cannot route `validateUserOp` to the module, which is exactly what the
 * caller's reason string has to say.
 */
export async function read4337From(reads: Safe4337Reads): Promise<Safe4337State> {
  const [moduleEnabled, word] = await Promise.all([
    reads.moduleEnabled(SAFE_4337_MODULE),
    reads.word(SAFE_FALLBACK_HANDLER_SLOT),
  ]);
  return { moduleEnabled, fallbackHandler: addressFromWord(word) };
}

/** `read4337From` against the chain at `rpcUrl`. */
export async function read4337(rpcUrl: string, safe: Address): Promise<Safe4337State> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return await read4337From({
    word: async (slot) => await client.getStorageAt({ address: safe, slot }),
    moduleEnabled: async (module) =>
      await client.readContract({
        address: safe,
        abi: SAFE_4337_READS,
        functionName: 'isModuleEnabled',
        args: [module],
      }),
  });
}

/**
 * `execTransaction` sent as a userOp from `safe`, sponsored by the configured
 * paymaster. No ETH is needed on the EOA: the paymaster fronts the gas and the
 * bundler submits.
 *
 * This is deliberately not a fallback for `sendFromEoa`. It makes one attempt
 * and throws; choosing the EOA instead is the caller's decision, taken before
 * the send, so a sponsorship refusal can never turn into an EOA transaction the
 * user did not ask for.
 *
 * Returns the **on-chain transaction hash** (the transaction that carried the
 * userOp, hence the one that carried the Safe's `execTransaction`), waiting for
 * the userOp receipt first. A throw is one of three, tagged by `sendCall` where
 * the phase is known: `SponsoredSendRefused` (nothing submitted),
 * `SponsoredSendUncertain` (submitted, receipt unseen), `SponsoredSendReverted`
 * (landed, the call inside it reverted, transaction hash carried).
 *
 * `config` is the config the command resolved, passed in rather than reloaded:
 * an injected config or a `--key` has to reach the runner too.
 */
async function sendSponsoredFromSafe(input: {
  config: CliConfig;
  rpcUrl: string;
  privateKey: Hex;
  to: Address;
  data: Hex;
  safe: Address;
}): Promise<Hex> {
  const runner = await createAuthorSafeRunner({
    config: input.config,
    privateKey: input.privateKey,
    eoa: privateKeyToAccount(input.privateKey).address,
    rpcUrl: input.rpcUrl,
    // The command only reaches this after finding a paymaster URL, and a
    // paymaster URL never exists without a bundler URL (`bundlerEndpoints`).
    requireBundler: true,
    safe: input.safe,
  });
  return runner.sendCall(input.to, input.data);
}

// ===========================================================================
// The seam
// ===========================================================================

/**
 * Everything the signer commands do outside the process. Tests replace all of
 * it; production uses `signerDeps()` with no overrides.
 */
export interface SignerDeps {
  config(): CliConfig;
  service(config: CliConfig): SafeTxService;
  readSafe(rpcUrl: string, safe: Address): Promise<ChainSafe>;
  readCode(rpcUrl: string, address: Address): Promise<boolean>;
  /** Send a plain transaction from the key and return its hash. */
  send(input: { rpcUrl: string; privateKey: Hex; to: Address; data: Hex }): Promise<Hex>;
  /**
   * Send the same call as a userOp from `safe`, sponsored by the paymaster, and
   * return the on-chain transaction hash. Throws on refusal; never falls back.
   */
  sendSponsored(input: {
    config: CliConfig;
    rpcUrl: string;
    privateKey: Hex;
    to: Address;
    data: Hex;
    safe: Address;
  }): Promise<Hex>;
  /**
   * `isModuleEnabled(SAFE_4337_MODULE)` and `getFallbackHandler()` from the
   * Safe: the two facts the sponsorship decision needs, read in one place so a
   * test can fail them together.
   */
  read4337(rpcUrl: string, safe: Address): Promise<Safe4337State>;
  keySource(flags: Record<string, string | boolean>): KeySource;
  authorsPath(): string;
  /** Chain id the safeTxHash is computed for; see `SIGNER_CHAIN_ID`. */
  chainId: number;
}

const DEFAULT_SIGNER_DEPS: SignerDeps = {
  config: () => loadConfig(),
  service: (config) => makeSafeTxService({ config, chainId: SIGNER_CHAIN_ID }),
  readSafe: readChainSafe,
  readCode,
  send: sendFromEoa,
  sendSponsored: sendSponsoredFromSafe,
  read4337,
  keySource: (flags) => resolveKeySource(flags),
  authorsPath: () => authorsFilePath(),
  chainId: SIGNER_CHAIN_ID,
};

/** The seam with the given overrides applied — the only constructor callers use. */
export function signerDeps(overrides: Partial<SignerDeps> = {}): SignerDeps {
  return { ...DEFAULT_SIGNER_DEPS, ...overrides };
}
