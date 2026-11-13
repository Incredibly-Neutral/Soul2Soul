// Author draft — GATES-1 for one genesis, by the author Safe that keeps it.
//
// The decision is `canAuthorVerdict` in @s2s/soul2soul-shared/gates: the gate
// resolves the Safe's drafts log and owner-history module from the Safe's own
// enabled-module list, requires the drafts log to name that Safe, and answers
// whether the signer was an owner when the last version was appended — or, where
// the log records no height, whether they own the Safe now. None of that is
// decided here and none of it is read twice: the verdict carries the drafts
// module it read from, the entry author it read, the block it judged at and the
// owner set that answered, so this file neither resolves the Safe's modules a
// second time (chain calls, and a module set that could rotate in between) nor
// reads anything it was not handed.
//
// What this file adds is the PIN, and the pin is the append-block path. When the
// gate judged at a positive block, the entry is read at that same block, so the
// ciphertext this opens and the owner set the signer was tested against are one
// version; reading at the head would let a version appended between the two
// reads be the one decrypted, under an owner set that never saw it. When the
// gate answered from the live owner set — block 0, or no usable block list —
// there is no height to pin to, and the entry is read at the head, the same
// present the answer was given in. That is the one path on which the entry and
// the owner answer are not bound: a version appended between the `isOwner` read
// and the fetch can be opened under ownership tested before it existed. The
// trace names the owner set that answered, so a reader does not infer it from a
// missing block.
//
// The caller-supplied Safe is bound twice over: the drafts log must name it for
// the genesis, and the blob's own signed `public.author` must equal it. A Safe
// can log another author's genesis and ciphertext CID in its own module, and
// only the blob's signed author refuses that.
//
// Every dependency is injected (gate, read, cat, decryptor, signature recovery),
// so the decisions below run in a unit test without an enclave. The wiring is
// decrypt/main.ts.
//
// Log hygiene: this file logs nothing. The trace it returns is the action's
// returned value (stdout), and the plaintext, the ciphertext, the signature and
// the key must never appear in it.

import {
  type AuthorModulesError,
  type CanAuthorVerdict,
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
  'no-owner-history-module':
    'no owner history module on the author Safe: the append block cannot be judged',
  'ambiguous-owner-history-module': 'two owner history modules answer on the author Safe',
};

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
 * `canAuthorVerdict` is `canAuthorVerdict` bound in ./gates: the whole author
 * question, answered in one call, carrying the modules, the entry author, the
 * judged block and the owner set it decided from. `read` is `evmRead` on L2 and
 * its trailing block argument is the pin. `cat` is the gateway; `decrypt` is
 * `Lit.Actions.Decrypt`; `recoverSigner` is `extractSignerAddress` over
 * `hashMessage('lit actions auth')`.
 */
export interface AuthorDraftDeps {
  canAuthorVerdict: (
    genesis: string,
    authorSafe: string,
    signerAddress: string,
  ) => Promise<CanAuthorVerdict>;
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
  /** On the `appendBlock` step: the owner set the gate's answer came from. */
  ownerSet?: CanAuthorVerdict['ownerSet'];
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

    // GATES-1, and the block this whole action is pinned to when there is one.
    const verdict = await deps.canAuthorVerdict(genesisId, safe, signer);
    // The block when the gate reached one, and which set answered when it
    // answered at all. A refusal can still name a block — a positive append
    // block with no owner-history module names the block no one could judge at —
    // so the step is emitted whenever there is either, never inferred from
    // `ownerSet` alone.
    if (verdict.block !== undefined || verdict.ownerSet !== undefined) {
      trace.push({
        step: 'appendBlock',
        ...(verdict.block !== undefined ? { block: verdict.block } : {}),
        ...(verdict.ownerSet !== undefined ? { ownerSet: verdict.ownerSet } : {}),
      });
    }

    // The gate decided from these; use them rather than resolving the Safe's
    // modules again. Each refusal keeps its own words.
    if (verdict.modulesError) {
      return refuse(MODULE_REFUSALS[verdict.modulesError] ?? 'cannot resolve the author Safe modules');
    }
    if (!verdict.modules) return refuse('cannot resolve the author Safe modules');
    if (verdict.author === undefined) return refuse('unknown draft');
    if (!sameAddress(verdict.author, safe)) return refuse('draft belongs to another Safe');
    step('draft', verdict.author);
    if (!verdict.ok) return refuse('signer does not own the author Safe');

    // The pin: the entry is the one the gate judged, not the current head. With
    // no positive block the gate judged against the live owner set, so the entry
    // is read at the head — the version that set was read at.
    const pin = verdict.block !== undefined && verdict.block > 0 ? verdict.block : undefined;
    const entry: DraftEntry = await deps.read(
      verdict.modules.drafts,
      ENTRY_ABI,
      'fetch',
      [genesisId],
      pin,
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
