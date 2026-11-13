// Author draft — GATES-1 for one genesis, by the author Safe that keeps it.
//
// The decision is `ownsVerdict` in @s2s/soul2soul-shared/gates: the gate
// resolves the Safe's drafts log and owner-history module from the Safe's own
// enabled-module list, requires the drafts log to name that Safe, and answers
// whether the signer was an owner when the last version was appended. Nothing of
// that is repeated here.
//
// What this file adds is the PIN. The gate reports the append block it judged
// at; the entry is read at that same block, so the ciphertext this opens and the
// owner set the signer was tested against are the same version. Reading at the
// head would let a version appended between the two reads be the one decrypted,
// under an owner set that never saw it. A block of 0 means the version predates
// the block field (or the log was imported): there is no height to read at, so
// the read is unpinned, which is the same fallback the gate makes for the owner
// read.
//
// The caller-supplied Safe is bound twice over: the drafts log must name it for
// the genesis, and the blob's own signed `public.author` must equal it. A Safe
// can log another author's genesis and ciphertext CID in its own module, and
// only the blob's signed author refuses that.
//
// Every dependency is injected (gate, reads, cat, decryptor, signature
// recovery), so the decisions below run in a unit test without an enclave. The
// wiring is decrypt/main.ts.
//
// Log hygiene: this file logs nothing. The trace it returns is the action's
// returned value (stdout), and the plaintext, the ciphertext, the signature and
// the key must never appear in it.

import {
  resolveAuthorModules,
  type GateRead,
  type GateValueRead,
  type OwnsVerdict,
} from '@s2s/soul2soul-shared/gates';
import { toBytes32Id, verifyBodyHash } from '@s2s/soul2soul-shared/lit-actions';

const ZERO_ADDRESS = /^0x0{40}$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// DraftsModuleV1.fetch — the drafts log's own entry read, which unlike the
// publication module's carries `versionCount`.
const ENTRY_ABI = [
  'function fetch(bytes32 genesis) view returns (tuple(bytes32 genesis, address author, string cid, uint256 timestamp, uint256 versionCount))',
];

export interface DraftEntry {
  genesis: string;
  author: string;
  cid: string;
  timestamp: unknown;
  versionCount: unknown;
}

/** A contract read, optionally pinned to a block (`undefined` = at head). */
export type DraftRead = (
  target: string,
  abi: any,
  fn: string,
  args: unknown[],
  block?: number,
) => Promise<any>;

export interface AuthorDraftInput {
  pkpId: string;
  genesis: string;
  authorSafe: string;
  signature: string;
}

/**
 * What the action needs from its runtime, injected for testability.
 *
 * `owns` is `ownsVerdict` bound in ./gates; `read` is `evmRead` on L2 (its
 * trailing block argument is the pin); `cat` is the gateway; `decrypt` is
 * `Lit.Actions.Decrypt`; `recoverSigner` is `extractSignerAddress` over
 * `hashMessage('lit actions auth')`.
 */
export interface AuthorDraftDeps {
  owns: (genesis: string, authorSafe: string, signerAddress: string) => Promise<OwnsVerdict>;
  read: DraftRead;
  cat: (cid: string) => Promise<string>;
  decrypt: (ciphertext: unknown) => Promise<unknown>;
  recoverSigner: (signature: string) => string;
}

/** One line of the returned trace. Never carries plaintext, ciphertext, a signature or a key. */
export interface TraceStep {
  step: string;
  address?: string;
  block?: number;
}

export interface AuthorDraftData {
  /** The string the author signed, exactly as decrypted — the hash input. */
  plaintext: string;
  /** The Safe the drafts log names as this genesis's author. */
  author: string;
  /** CID of the version read at the judged block. */
  cid: string;
}

export type AuthorDraftOutcome =
  | { ok: true; data: AuthorDraftData; trace: TraceStep[] }
  | { ok: false; error: string; trace: TraceStep[] };

const sameAddress = (a: unknown, b: unknown): boolean =>
  String(a).toLowerCase() === String(b).toLowerCase();

/** A version count of zero is the module's "no such draft" answer, in any of its shapes. */
const isZeroCount = (count: unknown): boolean =>
  count === 0 ||
  count === '0' ||
  (typeof (count as { isZero?: unknown })?.isZero === 'function' &&
    (count as { isZero: () => boolean }).isZero());

/**
 * Decrypt an author's draft, or refuse. See the header for the pin.
 */
export const decryptAuthorDraft = async (
  input: AuthorDraftInput,
  deps: AuthorDraftDeps,
): Promise<AuthorDraftOutcome> => {
  const trace: TraceStep[] = [];
  const step = (name: string, address?: unknown): void => {
    trace.push(address ? { step: name, address: String(address) } : { step: name });
  };
  const refuse = (error: string): AuthorDraftOutcome => ({ ok: false, error, trace });

  try {
    const genesisId = toBytes32Id(String(input.genesis ?? ''));
    step('genesis', genesisId);

    const safe = String(input.authorSafe ?? '');
    if (!ADDRESS_RE.test(safe) || ZERO_ADDRESS.test(safe)) {
      return refuse('author Safe is not an address');
    }

    const signer = deps.recoverSigner(String(input.signature ?? ''));
    step('signer', signer);

    // GATES-1, and the block this whole action is pinned to.
    const verdict = await deps.owns(genesisId, safe, signer);
    if (verdict.block !== undefined) trace.push({ step: 'appendBlock', block: verdict.block });
    if (!verdict.ok) return refuse('signer does not own the author Safe');

    // The gate resolved these too and does not report them; a shared change to
    // ownVerdict's OwnsVerdict would remove this second lookup. It cannot fail
    // for a Safe the gate just admitted, unless the reads race a rotation.
    const modules = await resolveAuthorModules(
      deps.read as GateRead,
      deps.read as GateValueRead,
      safe,
    );
    if (!modules.ok) return refuse('cannot resolve the author Safe modules: ' + modules.error);

    // The pin: the entry is the one the gate judged, not the current head.
    const entry: DraftEntry = await deps.read(
      modules.drafts,
      ENTRY_ABI,
      'fetch',
      [genesisId],
      verdict.block,
    );

    if (isZeroCount(entry?.versionCount)) return refuse('unknown draft');

    const author = String(entry.author);
    if (ZERO_ADDRESS.test(author) || !sameAddress(author, safe)) {
      return refuse('draft belongs to another Safe');
    }
    step('draft', author);

    const item = JSON.parse(await deps.cat(String(entry.cid)));
    step('item');

    if (item.encryption !== true) return refuse('not an encrypted item');

    // The address is the last colon-separated segment, so an item pinned with an
    // older scheme-prefixed author still matches; nothing writes that form now.
    const blobAuthor = String(item.public?.author ?? '')
      .split(':')
      .pop();
    if (!sameAddress(blobAuthor, safe)) return refuse('item author is not the draft author');
    step('blobAuthor', blobAuthor);

    const res = await deps.decrypt(item.body);
    const plaintext =
      typeof res === 'string'
        ? res
        : typeof (res as { decrypted?: unknown })?.decrypted === 'string'
          ? (res as { decrypted: string }).decrypted
          : null;
    if (plaintext === null) return refuse('decrypt returned no plaintext');
    step('decrypt');

    if (!verifyBodyHash(plaintext, String(item.public?.plaintextHash ?? ''))) {
      return refuse('plaintext does not match the signed hash');
    }
    step('plaintextHash');

    return { ok: true, data: { plaintext, author, cid: String(entry.cid) }, trace };
  } catch (error) {
    return refuse(
      'decrypt failed: ' + String((error as Error)?.message ?? error).slice(0, 160),
    );
  }
};
