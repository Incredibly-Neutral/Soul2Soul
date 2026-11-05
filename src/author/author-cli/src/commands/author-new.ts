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
  writeAuthors,
  writeBackAuthorSafe,
} from '../core/authors';
import { predictAuthorSafe } from '../core/author-safe';
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
    throw new UsageError('invalid mnemonic — the phrase derives no key at m/44\'/60\'/0\'/0/0');
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
): Promise<string | null> {
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

    const safe = await predictSafe(out, loadConfig(), privateKey, eoa);
    if (safe !== null) writeBackAuthorSafe(name, safe, file);

    out.result(
      {
        action: 'author.new',
        name,
        eoa,
        safe,
        active: true,
        file,
        // The phrase is echoed when it is the thing to write down; a key the
        // user supplied is already theirs and never comes back at them.
        ...(source.mnemonic ? { mnemonic: source.mnemonic } : {}),
        ...(source.generated ? { privateKey } : {}),
      },
      [
        `author '${name}' created and activated`,
        `eoa         : ${eoa}`,
        `safe        : ${safe ?? '(not predicted — no L2 RPC)'}`,
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
