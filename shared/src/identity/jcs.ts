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

/**
 * Compute the keccak256 hash of the JCS-canonicalized JSON of a value.
 * Uses ethers v5's keccak256 (available in shared's deps).
 */
import { utils } from 'ethers';

export function keccakOfJson(value: unknown): string {
  const canonical = jcs(value);
  return utils.keccak256(utils.toUtf8Bytes(canonical));
}