// Author draft — GATES-1 for one genesis, by the author Safe that keeps it.
//
// The parts are in @s2s/soul2soul-shared/gates and this file composes them, in
// this order: resolve the Safe's drafts log and owner-history module from the
// Safe's own enabled-module list; require the drafts log's `authorOf(genesis)`
// to name that Safe; take the append block from `blocksOf(genesis)`'s last
// entry; and ask `isOwnerAt` whether the signer was an owner of the Safe at that
// block. The modules are resolved once and every read below goes to the drafts
// log that resolution named.
//
// What this file adds is the PIN. The append block the signer was judged at is
// also the block the entry is read at, so the ciphertext this opens and the
// owner set the signer was tested against are the same version. Reading at the
// head would let a version appended between the two reads be the one decrypted,
// under an owner set that never saw it. A block of 0 means the version predates
// the block field or the log was imported: there is no owner set at that height
// to judge, so this action refuses it — there is no unpinned read to fall back
// to.
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
  lastVersionBlock,
  type AuthorModules,
  type AuthorModulesError,
} from '@s2s/soul2soul-shared/gates';
import { toBytes32Id, verifyBodyHash } from '@s2s/soul2soul-shared/lit-actions';

const ZERO_ADDRESS = /^0x0{40}$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Why the Safe's module lookup refused, in this action's words. The gate answers
 * a reason code; the action keeps the distinct message the string action had, so
 * a refusal still says whether the Safe runs no drafts log or two.
 */
const MODULE_REFUSALS: Record<AuthorModulesError, string> = {
  'unreadable-module-list': 'cannot read the author Safe module list',
  'no-enabled-modules': 'author Safe has no enabled modules',
  'no-drafts-module': 'no drafts module on the author Safe',
  'ambiguous-drafts-module': 'two drafts modules answer on the author Safe',
  'no-owner-history-module': 'no owner history module on the author Safe',
  'ambiguous-owner-history-module': 'two owner history modules answer on the author Safe',
};

// DraftsModuleV1.fetch — the drafts log's own entry read, which unlike the
// publication module's carries `versionCount`.
const ENTRY_ABI = [
  'function fetch(bytes32 genesis) view returns (tuple(bytes32 genesis, address author, string cid, uint256 timestamp, uint256 versionCount))',
];

/** DraftsModuleV1.authorOf — the Safe this genesis's first append named. */
const AUTHOR_OF_ABI = ['function authorOf(bytes32 genesis) view returns (address)'];

/** DraftsModuleV1.blocksOf — the block behind each version, oldest first. */
const BLOCKS_OF_ABI = ['function blocksOf(bytes32 genesis) view returns (uint64[] blocks)'];

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
 * `resolveModules` is `resolveAuthorModules` bound in ./gates, and answers the
 * author Safe's drafts log and owner history or why it could not. `readValue`
 * is `evmRead` on L2 without a block, for the two answers that are not
 * booleans: `authorOf` and `blocksOf` on the drafts log. `isOwnerAt` is the
 * shared `isOwnerAt` bound in ./gates, asked at a block against the Safe's
 * owner-history module. `read` is `evmRead` on L2 and its trailing block
 * argument is the pin. `cat` is the gateway; `decrypt` is
 * `Lit.Actions.Decrypt`; `recoverSigner` is `extractSignerAddress` over
 * `hashMessage('lit actions auth')`.
 */
export interface AuthorDraftDeps {
  resolveModules: (authorSafe: string) => Promise<AuthorModules>;
  readValue: (
    target: string,
    abi: string[],
    fn: string,
    args: unknown[],
  ) => Promise<unknown>;
  isOwnerAt: (
    safe: string,
    who: string,
    blockNumber: number,
    ownerHistory: string,
  ) => Promise<boolean>;
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

/**
 * An address answer from a read, or `undefined` when it is not one. A zero
 * address is the drafts log's "no such genesis" answer.
 */
const addressAnswer = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value) || ZERO_ADDRESS.test(value)) {
    return undefined;
  }
  return value;
};

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

    // The Safe's modules are resolved once; every read below goes to the drafts
    // log this named. Each refusal keeps its own words.
    const modules = await deps.resolveModules(safe);
    if (!modules.ok) {
      return refuse(MODULE_REFUSALS[modules.error] ?? 'cannot resolve the author Safe modules');
    }

    const draftAuthor = addressAnswer(
      await deps.readValue(modules.drafts, AUTHOR_OF_ABI, 'authorOf', [genesisId]),
    );
    if (draftAuthor === undefined) return refuse('unknown draft');
    if (!sameAddress(draftAuthor, safe)) return refuse('draft belongs to another Safe');

    // GATES-1's block: the version the signer is judged at is the version this
    // action reads.
    const block = lastVersionBlock(
      await deps.readValue(modules.drafts, BLOCKS_OF_ABI, 'blocksOf', [genesisId]),
    );
    if (block !== undefined) trace.push({ step: 'appendBlock', block });
    step('draft', draftAuthor);

    // A log that answers no block list is not the pre-upgrade case, which
    // answers a list of zeros; it is a read this action cannot pin.
    if (block === undefined) return refuse('cannot read the append block');
    // Block 0 is no height: the version was appended before the log recorded a
    // block number, or carried in by an import, so there is no owner set at that
    // height to judge. The entry is only ever read at a finite positive block.
    if (block === 0) return refuse('no append block was recorded for this draft');

    if (!(await deps.isOwnerAt(safe, signer, block, modules.ownerHistory))) {
      return refuse('signer does not own the author Safe');
    }

    // The pin: the entry is the one ownership was judged on, not the current head.
    const entry: DraftEntry = await deps.read(
      modules.drafts,
      ENTRY_ABI,
      'fetch',
      [genesisId],
      block,
    );

    if (isZeroCount(entry?.versionCount)) return refuse('unknown draft');

    const author = String(entry.author);
    if (ZERO_ADDRESS.test(author) || !sameAddress(author, safe)) {
      return refuse('draft belongs to another Safe');
    }

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
