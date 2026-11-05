// ============================================================================
// s2s author new <pet-name> — file a new author identity in the store.
//
//   s2s author new zomi                       # key piped on stdin
//   echo 0x… | s2s author new zomi
//   s2s author new zomi --key 0x…
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
  // `config.rpc.L2` holds only the explicit overrides; every other author path
  // reads `ctx.rpcs.L2`, i.e. the DRPC → public → Alchemy → Infura chain.
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
  usage: 's2s author new <pet-name> [--key <0x…>] [--json]',
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

    const rawKey = flagString(args.flags, 'key') ?? stdinKey();
    if (!rawKey) {
      throw new UsageError(
        'no private key given — pass --key <0x…> or pipe the key on stdin (echo 0x… | s2s author new <pet-name>)',
      );
    }
    const privateKey = hexKey(rawKey);
    if (privateKey === undefined) {
      throw new UsageError('no private key given — pass --key <0x…>');
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
      },
      [
        `author '${name}' created and activated`,
        `eoa         : ${eoa}`,
        `safe        : ${safe ?? '(not predicted — no L2 RPC)'}`,
        `store       : ${file}`,
      ].join('\n'),
    );
  },
};
