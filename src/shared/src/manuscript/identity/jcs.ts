// ============================================================================
// JCS — RFC 8785 Canonical JSON
// Deterministic JSON serialization so that hashing is reproducible.
// specVersion "1" pins JCS + keccak256 + EIP-712.
// ============================================================================

/**
 * Serialize a value to canonical JSON per RFC 8785 (JCS).
 *
 * Rules:
 * - Object keys are sorted lexicographically (by UTF-16 code unit, like JSON.parse)
 * - No whitespace between tokens
 * - Strings use \uXXXX escaping only where required
 * - Numbers use the JSON specification (no leading zeros, no trailing dot)
 * - Booleans and null are lowercase
 * - Arrays preserve order; empty arrays are []
 * - Empty objects are {}
 */
export function jcs(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('JCS: infinite/NaN values are not allowed');
    }
    return String(value);
  }
  if (typeof value === 'string') return serializeString(value);
  if (Array.isArray(value)) return serializeArray(value);
  if (typeof value === 'object') return serializeObject(value as Record<string, unknown>);
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

function serializeString(s: string): string {
  // JSON.stringify with no indentation is already mostly JCS-compatible for strings.
  // RFC 8785 requires \uXXXX escaping for only certain characters.
  // JSON.stringify handles most of these correctly.
  return JSON.stringify(s);
}

function serializeArray(arr: unknown[]): string {
  const items = arr.map(serialize);
  return '[' + items.join(',') + ']';
}

function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => serializeString(k) + ':' + serialize(obj[k]));
  return '{' + pairs.join(',') + '}';
}

// keccak from @noble/hashes, not ethers or viem: hashing (unlike EIP-712
// signing) must not depend on the runtime providing a chain library, the output
// is byte-identical, and it costs ~10KB in an action bundle — viem's `utils`
// barrel costs ~800KB there because the action build resolves its CJS entry.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Compute the keccak256 hash of the JCS-canonicalized JSON of a value.
 *
 * viem, not ethers: hashing (unlike EIP-712 signing) must not depend on the
 * runtime providing a chain library, and the output is byte-identical. This
 * also keeps the hash half of the integrity verdict working in a runtime that
 * has no typed-data signer.
 */
export function keccakOfJson(value: unknown): string {
  return keccakOfString(jcs(value));
}

/**
 * keccak256 of a UTF-8 string's exact bytes — the contract "hash these bytes".
 * viem, for the same reason as keccakOfJson: no dependency on a runtime ethers.
 */
export function keccakOfString(text: string): string {
  return '0x' + bytesToHex(keccak_256(utf8ToBytes(text)));
}