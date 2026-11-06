// ============================================================================
// s2s author new <pet-name> — file a new author identity in the store.
//
//   s2s author new zomi                       # generate a fresh key (BIP39 phrase)
//   echo 0x… | s2s author new zomi            # key piped on stdin
//   s2s author new zomi --key 0x…             # key given on the command line
//   s2s author new zomi --mnemonic "word …"   # restore from a BIP39 phrase
//
// With no key anywhere, a 12-word BIP39 phrase is generated and the key is
// derived from it at the standard `m/44'/60'/0'/0/0` path: the common case is
// "give me an identity", not "I have a key to file", and a phrase is what a
// person can write down and any wallet can import. The store keeps the derived
// key only — every other layer (env, project config, signing) speaks keys, so a
// phrase in the file would be a second secret protecting the same thing. A
// generated phrase is printed once, in both modes; the store is its only other
// copy.
//
// The key is the Safe's owner, not the author id: the author id is the
// counterfactual Safe (`s2s_${eoa}` salt). Its address is predicted here when
// an L2 RPC is configured, and stored — so `author list` can show the identity
// without an RPC read. No RPC (or a failed read) is a warning, not a failure:
// the key is the thing that cannot be recovered later, the Safe can be derived
// again at any time by `author address`.
//
// A new author is not usable until the author contracts sit on its Safe, so the
// last step deploys the Safe and installs them (drafts/ownerHistory/guard). It
// runs strictly AFTER the key is filed: the store order is unchanged, and every
// failure here is a warning naming the recovery (`s2s author init`). A Safe this
// run cannot install on — its owners are not solely the filed key, or it already
// carries a guard that is not ours — leaves the install as a `pending-safe`
// transaction its owners must propose, reported with the reason core returns.
//
// A new author becomes the active one — adding an identity is a switch.
// Runs without `buildContext`: no Lit keys, no publication, no bundler.
// ============================================================================

import { readFileSync } from 'node:fs';

import type { Address } from 'viem';
import { bytesToHex } from 'viem';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';

import type { ParsedArgs } from '../lib/args';
import { flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import {
  addAuthor,
  authorEoa,
  authorsFilePath,
  isValidPetName,
  PET_NAME_MAX_LENGTH,
  readAuthors,
  rememberAuthorContracts,
  writeAuthors,
  writeBackAuthorSafe,
} from '../core/authors';
import { predictAuthorSafe } from '../core/author-safe';
import {
  authorContractsFactory,
  installAuthorContracts,
  type InstallState,
} from '../core/author-contracts';
import { buildRpcEndpoints } from '../adapters/rpc';
import { hexKey, loadConfig, type CliConfig } from '../core/config';

/** The key piped on stdin, when stdin is not a terminal (`echo 0x… | s2s …`). */
function stdinKey(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** A BIP39 phrase and the account it derives, at the standard HD path. */
function fromMnemonic(mnemonic: string): { privateKey: string; mnemonic: string } {
  const phrase = mnemonic.trim().split(/\s+/).join(' ');
  let key: Uint8Array | null;
  try {
    key = mnemonicToAccount(phrase).getHdKey().privateKey;
  } catch (err) {
    throw new UsageError(
      `invalid mnemonic — expected a BIP39 phrase (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!key) {
    throw new UsageError("invalid mnemonic — the phrase derives no key at m/44'/60'/0'/0/0");
  }
  return { privateKey: bytesToHex(key), mnemonic: phrase };
}

/** Anything that is not a single hex word is treated as a phrase candidate. */
function looksLikePhrase(input: string): boolean {
  return !/^0x[0-9a-fA-F]*$/.test(input.trim());
}

export interface KeySource {
  privateKey: string;
  /** The phrase the key came from: generated, or restored from an existing one. */
  mnemonic?: string;
  /** True only when this run made the phrase — the caller should show it once. */
  generated: boolean;
}

/**
 * Where the key comes from: `--key`, else `--mnemonic`, else stdin (a hex key
 * or a phrase, told apart by shape), else a freshly generated phrase. Split out
 * — with every source injectable — so the paths that would otherwise read fd 0
 * or the CSPRNG are testable.
 */
export function resolveKeySource(
  flags: Record<string, string | boolean>,
  sources: {
    stdin?: () => string | undefined;
    phrase?: () => string;
  } = {},
): KeySource {
  const explicitKey = flagString(flags, 'key');
  if (explicitKey) return { privateKey: explicitKey, generated: false };

  const explicitMnemonic = flagString(flags, 'mnemonic');
  if (explicitMnemonic) return { ...fromMnemonic(explicitMnemonic), generated: false };

  const piped = (sources.stdin ?? stdinKey)();
  if (piped) {
    const text = piped.trim();
    return looksLikePhrase(text)
      ? { ...fromMnemonic(text), generated: false }
      : { privateKey: text, generated: false };
  }

  const phrase = (sources.phrase ?? (() => generateMnemonic(english)))();
  return { ...fromMnemonic(phrase), generated: true };
}

/**
 * The predicted author Safe, or null when it could not be derived. Prediction
 * is a read of the L2 Safe factory, so it needs an RPC endpoint and can fail;
 * neither case may lose the key the user just handed over.
 */
async function predictSafe(
  out: CliOut,
  config: CliConfig,
  privateKey: string,
  eoa: Address,
): Promise<Address | null> {
  // `config.rpc.l2` is already the fully resolved chain (custom endpoints, else
  // DRPC → public → Alchemy → Infura), the same one `ctx.rpcs.L2` carries.
  const rpcUrl = buildRpcEndpoints(config).L2[0];
  if (!rpcUrl) {
    out.warn(
      'no L2 RPC configured — author Safe not predicted; run `s2s author address` once one is set',
    );
    return null;
  }
  try {
    // Predict for the key being added, not for whatever S2S_PRIVATE_KEY holds:
    // the owner is part of the counterfactual address.
    const prediction = await predictAuthorSafe({ config: { ...config, privateKey }, eoa, rpcUrl });
    return prediction.address;
  } catch (err) {
    out.warn(
      `could not predict the author Safe: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * What the result says about the author contracts, whether or not they landed.
 * Always present, so a script never has to distinguish "absent" from "skipped".
 */
export interface ContractsReport {
  /** The factory the contracts were installed from (null when unreadable). */
  factory: string | null;
  drafts: string | null;
  ownerHistory: string | null;
  guard: string | null;
  state: InstallState;
  /** The userOps / txs the install sent. */
  txs: string[];
  /** Why the install is `skipped` or `pending-safe`, as core reported it. */
  note?: string;
  /** The Safe call the owners must propose (`pending-safe`). */
  safeTx?: { to: string; data: string };
}

/** The contracts block for a run that never reached the chain. */
function notInstalled(config: CliConfig, state: InstallState, note?: string): ContractsReport {
  let factory: string | null = null;
  try {
    factory = authorContractsFactory(config);
  } catch {
    // An unconfigured factory is reported as unknown, never a failure: the key
    // is already filed and `s2s author init` is the place to fix this.
    factory = null;
  }
  return {
    factory,
    drafts: null,
    ownerHistory: null,
    guard: null,
    state,
    txs: [],
    ...(note ? { note } : {}),
  };
}

/**
 * Deploy the author Safe (when needed) and install the author contracts on it.
 * Never throws: a missing RPC, a missing bundler, an undeployed Safe or a chain
 * error all degrade to a warning that names `s2s author init`, because at this
 * point the user's key is safe and nothing here is irreplaceable.
 */
async function installContracts(
  out: CliOut,
  config: CliConfig,
  name: string,
  privateKey: string,
  safe: Address | null,
): Promise<ContractsReport> {
  const rpcUrl = buildRpcEndpoints(config).L2[0];
  if (!rpcUrl) {
    const note = 'no L2 RPC configured';
    out.warn(
      'author contracts not installed — no L2 RPC configured; the key is filed, run `s2s author init` once an L2 RPC is set',
    );
    return notInstalled(config, 'skipped', note);
  }
  if (!safe) {
    // The Safe address is unknown, so there is nothing to install on (and no
    // owner to install as). Same recovery as any other skip.
    const note = 'author Safe not predicted';
    out.warn(`author contracts not installed — ${note}; run \`s2s author init\``);
    return notInstalled(config, 'skipped', note);
  }

  try {
    const result = await installAuthorContracts({
      // The key just filed, not the active one: `author new` may have been run
      // with S2S_PRIVATE_KEY set to somebody else.
      config: { ...config, privateKey },
      safe,
      rpcUrl,
      privateKey: privateKey as `0x${string}`,
      out,
    });

    if (result.state === 'installed' || result.state === 'already') {
      try {
        // Offline reporting for `author list` / `author switch`.
        rememberAuthorContracts(name, result);
      } catch (err) {
        out.warn(
          `could not record the author contracts in the authors file: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else if (result.state === 'skipped') {
      out.warn(
        `author contracts not installed${result.note ? ` — ${result.note}` : ''}; run \`s2s author init\` to install them`,
      );
    } else {
      // `pending-safe` is not "undeployed": core returns it for a Safe the filed
      // key does not solely own, or one already carrying a guard that is not
      // ours. The note says which, and it must be the thing we print.
      out.log(
        `${result.note ?? 'the Safe owners must install the guard'} — the call to propose is below`,
      );
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
    out.warn(`author contracts not installed: ${message} — run \`s2s author init\` to finish`);
    return notInstalled(config, 'skipped', message);
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
          : 'skipped (run `s2s author init`)';
  const lines = [`contracts   : ${state}`];
  if (report.state === 'skipped') return lines;

  lines.push(`factory     : ${report.factory ?? '(unknown)'}`);
  lines.push(`drafts      : ${report.drafts ?? '(none)'}`);
  lines.push(`ownerHistory: ${report.ownerHistory ?? '(none)'}`);
  lines.push(`guard       : ${report.guard ?? '(none)'}`);
  if (report.state === 'pending-safe') {
    lines.push('              the drafts module needs no install — the Safe calls append');
    lines.push('              on the drafts proxy directly. Propose this call instead:');
    if (report.safeTx) {
      lines.push(`              to   ${report.safeTx.to}`);
      lines.push(`              data ${report.safeTx.data}`);
    } else {
      lines.push('              (the exact call could not be built — run `s2s author init`)');
    }
  }
  return lines;
}

export const authorNew: StoreCommandSpec = {
  name: 'new',
  summary: 'Add an author identity (private key + pet name) and activate it.',
  params: '<pet-name>',
  flags: {
    key: {
      type: 'string',
      summary: 'private key to file (0x…); default: stdin if piped, else a generated phrase',
      value: '<0x…>',
    },
    mnemonic: {
      type: 'string',
      summary: 'BIP39 phrase to restore from (or pipe it on stdin)',
      value: '<words…>',
    },
  },
  async run(out: CliOut, args: ParsedArgs) {
    const name = args.positionals[0];
    if (!name) {
      throw new UsageError('missing required argument: <pet-name>');
    }
    if (!isValidPetName(name)) {
      throw new UsageError(
        `invalid author name '${name}' — letters, digits, '.', '_' or '-', starting with a letter or digit (max ${String(PET_NAME_MAX_LENGTH)} chars)`,
      );
    }

    const source = resolveKeySource(args.flags);
    const privateKey = hexKey(source.privateKey);
    if (privateKey === undefined) {
      throw new UsageError(
        'invalid private key — expected 32 bytes of hex (0x followed by 64 hex chars)',
      );
    }

    // Validate by deriving: this is the same call every signing path makes, so
    // a key that passes here cannot fail later with "expected hex or 32 bytes".
    const eoa = authorEoa(privateKey);
    if (!eoa) {
      throw new UsageError(
        'invalid private key — expected 32 bytes of hex (0x followed by 64 hex chars)',
      );
    }

    const file = authorsFilePath();
    // The key is written first, with no Safe: prediction is a network read, and
    // an interrupted one must not lose the key the user just handed over.
    // `addAuthor` rejects a duplicate name or key before anything is written.
    writeAuthors(addAuthor(readAuthors(file), name, privateKey, null), file);

    const config = loadConfig();
    const safe = await predictSafe(out, config, privateKey, eoa);
    if (safe !== null) writeBackAuthorSafe(name, safe, file);

    // Only now, with the key on disk and the Safe recorded, does anything touch
    // the chain — and nothing below may turn this into a failed command.
    const contracts = await installContracts(out, config, name, privateKey, safe);

    out.result(
      {
        action: 'author.new',
        name,
        eoa,
        safe,
        active: true,
        file,
        contracts,
        // The phrase is echoed when it is the thing to write down; a key the
        // user supplied is already theirs and never comes back at them.
        ...(source.mnemonic ? { mnemonic: source.mnemonic } : {}),
        ...(source.generated ? { privateKey } : {}),
      },
      [
        `author '${name}' created and activated`,
        `eoa         : ${eoa}`,
        `safe        : ${safe ?? '(not predicted — no L2 RPC)'}`,
        ...contractsLines(contracts),
        `store       : ${file}`,
        ...(source.mnemonic
          ? [
              `mnemonic    : ${source.mnemonic}`,
              `              (${source.generated ? 'generated' : 'restored'} — write it down: it restores this author anywhere)`,
            ]
          : []),
      ].join('\n'),
    );
  },
};
