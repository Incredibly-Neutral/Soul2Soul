// ============================================================================
// Encryption seam for the author write path.
//
// WHAT THE READ PATH REQUIRES (this is the contract the write path must meet):
//   - An encrypted item stores the ciphertext as TEXT in `item.body`
//     (`press/actions/src/libs/module.factory.ts:359-361` — `toBody` passes
//     it through as `content`).
//   - `decryptRaw` does `JSON.parse(body.content)` and hands the parsed value
//     to `Lit.Actions.Decrypt({ pkpId, ciphertext })`
//     (`press/actions/src/libs/decrypt.ts:36`).
//   So the encryptor must return a string that `JSON.parse`s, and the parsed
//   value must be usable as a ciphertext: a non-empty string, or a non-empty
//   object. Anything else is a body the render path cannot decrypt, so it is
//   refused here rather than published.
//
// OPEN RISK — THE WRITER'S SHAPE IS INFERRED FROM THE READER, NOT OBSERVED:
//   No recorded live `/lit_action` encrypt response exists in this repo. The
//   authoring client has never run against Lit ("Live status: never invoked by
//   an authoring client", brain/prototype/02-authoring-implementation.md §5.4),
//   and the whitepaper's "encryption returns ciphertext only (no
//   `dataToEncryptHash`)" (brain/whitepaper/03-encryption-access-control.md:88)
//   can be read as "a bare base64 string". `LitService.encrypt` returns
//   `result.response.ciphertext` verbatim from the action's
//   `Lit.Actions.Encrypt({ pkpId, message })`, so its type is genuinely unknown
//   here. If a live run shows raw base64, the JSON requirement still stands:
//   the fix belongs in the READ path (`press/actions/src/libs/decrypt.ts:36`
//   must stop assuming `JSON.parse`), not in loosening the writer — publishing a
//   body nothing can render is worse than refusing to publish it.
//
// WHY A WHITELIST AND NOT A BLACKLIST OF ERRORS:
//   `LitService.encrypt` swallows its own failures and returns
//   `error.toString()` as if it were the ciphertext
//   (shared/src/lit/lit.service.ts:300-345 — the `throw new Error('Encrypt
//   failed…')` sits inside its own `try`). Real observed returns include
//   `"TimeoutError: The operation was aborted due to timeout"` (the default
//   `AbortSignal.timeout`), `"DOMException: failed to fetch"`,
//   `"Error: Encrypt failed: …"` and `"TypeError: Cannot read properties of
//   null (reading 'ciphertext')"`. Enumerating error shapes loses; requiring
//   the read-path contract wins — none of those parse as JSON text.
//
// OTHER GUARDS:
//   - Echo: an encryptor that returns the plaintext unchanged (directly, as a
//     JSON string, or re-serialised) would publish plaintext under a lying
//     `encryption: true`, so the result is compared with the plaintext.
//   - Fail closed: a note with `encryption: true` and a missing/empty
//     `LIT_USAGE_KEY` or `protocolInfo.pkp` is a `UsageError` before any
//     chain/IPFS work. There is no fallback to `noOpEncrypt`.
//   - The body is encrypted to `protocolInfo.pkp`, the same flattened PKP the
//     render action decrypts with (`press/actions/src/render/data.ctrlr.ts`
//     — `decryptRaw(protocolInfo.pkp, …)`).
//
// FRONTMATTER COERCION (owned by shared/src/authoring/note.ts:218,
// `Boolean(frontmatter.encryption)` — not edited here): only YAML `false`,
// `null`/`~`, `0` and `""` mean "plaintext". `"false"` (quoted), `no`, `off`,
// `yes`, `1`, `"encrypted"` are all truthy → encrypt. Note the inversion:
// `encryption: 0` publishes in the clear while `encryption: "false"` encrypts.
//
// Kept pure/injectable (no Lit credentials, no network) so the guards are
// unit-testable; the one I/O is the stored-item read, injected as a function.
// ============================================================================

import { noOpEncrypt } from '@s2s/soul2soul-shared';

import { CliError, UsageError } from '../lib/errors';
import { requireSetting } from './config';

/** The encrypt function shape `buildSignedContentItem` accepts. */
export type EncryptFn = (plaintext: string) => Promise<string> | string;

/** The subset of `CliContext` encryption needs. Structural, so tests can fake it. */
export interface EncryptionContext {
  config: { litUsageKey?: string };
  protocolInfo: { pkp?: string };
  lit: { encrypt(key: string, pkpId: string, message: string): Promise<string> | string };
}

/** The subset of `ParsedNote` encryption needs. */
export interface EncryptionFlag {
  encryption: boolean;
}

/** The subset of the IPFS adapter needed to read a stored content item. */
export interface StoredItemReader {
  fetchFromKubo(cid: string): Promise<unknown>;
}

/** The declared state of a stored content item, as the write path needs it. */
export interface StoredItemState {
  /** `true` only when the item says `encryption: true` (absent = plaintext). */
  encryption: boolean;
  /** `item.body` when it is a string, else undefined. */
  body: string | undefined;
}

/**
 * Error shapes `LitService.encrypt` can hand back as "ciphertext". This is the
 * SECONDARY check — the JSON-text whitelist below is what actually closes the
 * hole — but naming the shape gives the author a usable message.
 */
function errorShapeOf(value: string): string | undefined {
  if (/^\s*Error:/.test(value)) return 'an Error string';
  if (/^\s*TypeError:/.test(value)) return 'a TypeError string';
  if (/\bEncrypt failed\b/.test(value)) return 'an "Encrypt failed" message';
  if (/^\s*(?:DOMException|TimeoutError|AbortError|NetworkError|FetchError)\b/.test(value)) {
    return 'a timeout/network error';
  }
  if (/(?:^|\n)\s*at\s+(?:\S+ \()?\S+:\d+:\d+\)?/.test(value)) return 'a stack trace';
  return undefined;
}

/** Whether `parsed` is a shape the read path can hand to `Lit.Actions.Decrypt`. */
function usableCiphertextValue(parsed: unknown): boolean {
  if (typeof parsed === 'string') return parsed.trim() !== '';
  if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed).length > 0;
  return false;
}

/** Describe a value that is not JSON text, for the failure message. */
function describeUnparseable(value: string): string {
  const looksBase64 = /^[A-Za-z0-9+/=_-]{40,}$/.test(value);
  const kind = looksBase64 ? 'raw base64-like text' : 'non-JSON text';
  return `${kind} (${String(value.length)} chars, starts ${JSON.stringify(value.slice(0, 32))})`;
}

/**
 * Whether `value` is the plaintext coming back out (an echoing encryptor).
 * Covers the direct echo (`value === plaintext`), a JSON-string echo, and a
 * re-serialised echo of the same object.
 */
function isEcho(value: string, parsed: unknown, plaintext: string): boolean {
  if (value === plaintext || value.trim() === plaintext.trim()) return true;
  if (parsed === plaintext) return true;
  try {
    const wanted = JSON.parse(plaintext) as unknown;
    if (wanted === null) return parsed === wanted;
    if (typeof parsed !== typeof wanted) return false;
    return JSON.stringify(parsed) === JSON.stringify(wanted);
  } catch {
    return false;
  }
}

/**
 * Assert a value is usable ciphertext for the read path and return it
 * unchanged.
 *
 * Requires: a string, non-empty, not error-shaped, not the plaintext echoed
 * back, `JSON.parse`-able, and parsing to a non-empty string or object.
 *
 * @param plaintext - the plaintext that was sent to the encryptor, when known
 *                    (enables the echo check).
 */
export function assertCiphertext(value: unknown, plaintext?: string): string {
  if (typeof value !== 'string') {
    throw new CliError(
      `encryption failed: the encryptor returned ${value === null ? 'null' : typeof value}, not ciphertext — nothing was published`,
    );
  }
  if (value.trim() === '') {
    throw new CliError('encryption failed: the encryptor returned empty text — nothing was published');
  }

  const errorShape = errorShapeOf(value);
  if (errorShape !== undefined) {
    const firstLine = (value.split('\n')[0] ?? '').trim();
    throw new CliError(
      `encryption failed: the encryptor returned ${errorShape}, not ciphertext (${firstLine}) — nothing was published`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    // Diagnose rather than blame Lit: the point is to make the FIRST live run
    // self-explanatory, because a raw-base64 return is a read-path bug, not a
    // Lit outage.
    throw new CliError(
      `encryption failed: got ${describeUnparseable(value)}, which cannot be stored as an encrypted body — nothing was published. ` +
        'The read path requires JSON text: press/actions/src/libs/decrypt.ts:36 does `JSON.parse(body.content)` and passes the parsed value to `Lit.Actions.Decrypt`. ' +
        'If this really is Lit\'s ciphertext, the read path has to accept that shape before any encrypted note can be published.',
    );
  }

  if (!usableCiphertextValue(parsed)) {
    throw new CliError(
      `encryption failed: the result parses to ${parsed === null ? 'null' : typeof parsed}, not a non-empty object or string, so the render path could not decrypt it — nothing was published`,
    );
  }

  if (plaintext !== undefined && isEcho(value, parsed, plaintext)) {
    throw new CliError(
      'encryption failed: the encryptor returned the plaintext unchanged (or re-serialised), which would publish the body in the clear — nothing was published',
    );
  }

  return value;
}

/**
 * Resolve a required setting for encryption as a `UsageError`.
 *
 * `requireSetting` throws a plain `Error`; encryption misconfiguration is a
 * usage problem (exit code 2) and must be loud — the alternative is a
 * manuscript published in the clear.
 */
function requireEncryptionSetting(value: string | undefined, name: string, why: string): string {
  let resolved: string;
  try {
    resolved = requireSetting(value, name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`${why}: ${message}`);
  }
  if (resolved.trim() === '') {
    throw new UsageError(`${why}: \`${name}\` is empty.`);
  }
  return resolved;
}

/**
 * Build the encrypt function for a note.
 *
 * `encryption: false` → `noOpEncrypt` itself (so shared keeps the body flag
 * false and the JSON passes through byte-for-byte).
 *
 * `encryption: true` → a real Lit encryptor bound to the protocol PKP, failing
 * closed before any upload if `LIT_USAGE_KEY` or `protocolInfo.pkp` is missing
 * or empty, and rejecting a result the render path could not decrypt.
 */
export function buildEncryptFn(
  ctx: EncryptionContext,
  parsed: EncryptionFlag,
  /** Label used in the error messages (the note path). */
  notePath?: string,
): EncryptFn {
  if (!parsed.encryption) return noOpEncrypt;

  const why = `cannot encrypt ${notePath ?? 'note'}: frontmatter \`encryption: true\``;
  const litUsageKey = requireEncryptionSetting(ctx.config.litUsageKey, 'LIT_USAGE_KEY', why);
  const pkp = requireEncryptionSetting(ctx.protocolInfo.pkp, 'protocolInfo.pkp', why);

  // `LitService.encrypt` does not throw (it stringifies its own errors), but a
  // throwing transport or a future fix must still not surface as a raw stack:
  // both paths end as "nothing was published".
  return async (plaintext: string): Promise<string> => {
    let result: unknown;
    try {
      result = await ctx.lit.encrypt(litUsageKey, pkp, plaintext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(`encryption failed: Lit threw (${message}) — nothing was published`);
    }
    return assertCiphertext(result, plaintext);
  };
}

// ===========================================================================
// Stored item reads (offer verification + republish downgrade guard)
// ===========================================================================

/**
 * Read a stored content item by CID and report the two fields the write path
 * cares about. Throws `UsageError` when the item cannot be read or is not an
 * item — both callers need "I could not verify this" to be distinguishable
 * from "verified, and it is plaintext".
 */
export async function fetchStoredItem(
  ipfs: StoredItemReader,
  cid: string,
  notePath: string,
): Promise<StoredItemState> {
  let item: unknown;
  try {
    item = await ipfs.fetchFromKubo(cid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`cannot read content item ${cid} for ${notePath}: ${message}`);
  }
  if (typeof item !== 'object' || item === null) {
    throw new UsageError(`content item ${cid} for ${notePath} is not a JSON object`);
  }
  const record = item as { encryption?: unknown; body?: unknown };
  if (record.encryption !== undefined && typeof record.encryption !== 'boolean') {
    throw new UsageError(
      `content item ${cid} for ${notePath} has a non-boolean \`encryption\` field (${JSON.stringify(record.encryption)})`,
    );
  }
  return {
    encryption: record.encryption === true,
    body: typeof record.body === 'string' ? record.body : undefined,
  };
}
