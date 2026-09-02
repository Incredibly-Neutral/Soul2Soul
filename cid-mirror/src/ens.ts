/**
 * ENS resolution — extract ENS name from a PUBLICATION_URL, resolve its
 * contenthash (EIP-1577) via the configured L1 RPC.
 *
 * Uses the vendored contenthash module to decode the on-chain envelope.
 *
 * ENS registry: 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
 * Resolver interface: function contenthash(bytes32 node) view returns (bytes)
 *
 * Mirrors the patterns from shared/src/ens/index.ts (viem-based resolution)
 * but uses raw eth_call to keep dependencies minimal.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils';
import { decodeContenthashWrapped } from './ipfs/contenthash.js';

/** ENS Registry address (Ethereum mainnet). */
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';

/**
 * Detect whether a string looks like a bare CID (starts with Qm or b).
 */
export function isBareCID(value: string): boolean {
  return value.startsWith('Qm') || value.startsWith('b') || value.startsWith('1');
}

/**
 * Extract the ENS name from a publication URL.
 *
 * Accepts:
 *   - Full URL:  https://xxx.soul2soul.eth  →  xxx.soul2soul.eth
 *   - Bare name: xxx.soul2soul.eth          →  xxx.soul2soul.eth
 *   - Bare CID:  Qm... or bafy...           →  returned as-is (caller handles)
 */
export function extractEnsName(url: string): string {
  // If it's a bare CID, return it directly
  if (isBareCID(url)) return url;

  // Strip protocol prefix and path
  let name = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // Strip trailing slashes
  name = name.replace(/\/+$/, '');

  return name;
}

/**
 * Check if the extracted name is an ENS name (contains .eth).
 */
export function isEnsName(name: string): boolean {
  return name.endsWith('.eth') || name.includes('.eth.');
}

/**
 * Compute namehash for an ENS name using Keccak-256.
 */
export function namehash(name: string): string {
  const labels = name.toLowerCase().split('.');
  let node: Uint8Array = new Uint8Array(32);
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = keccak_256(new TextEncoder().encode(labels[i]));
    node = keccak_256(new Uint8Array([...node, ...labelHash]));
  }
  return '0x' + nobleBytesToHex(node);
}

/**
 * Perform an eth_call against the L1 RPC.
 */
async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  });

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`eth_call failed: ${res.status} ${res.statusText}`);
  }

  const json: any = await res.json();
  if (json.error) {
    throw new Error(`eth_call error: ${JSON.stringify(json.error)}`);
  }
  return json.result as string;
}

/**
 * Resolve an ENS name to its root CID via contenthash (EIP-1577).
 *
 * Steps:
 * 1. namehash the ENS name
 * 2. Call resolver(node) on the registry to get the resolver address
 * 3. Call contenthash(node) on the resolver to get the 0xe3 01 <CID> envelope
 * 4. Decode the envelope to a plain CID string
 *
 * @returns The root CID string, or null if resolution fails.
 */
export async function resolveEnsToCID(
  ensName: string,
  l1RpcUrl: string,
): Promise<string | null> {
  try {
    const node = namehash(ensName);

    // Step 2: call resolver(node) on registry
    const resolverData = '0x0178b8bf' + node.slice(2).toLowerCase();
    const resolverHex = await ethCall(l1RpcUrl, ENS_REGISTRY, resolverData);

    if (!resolverHex || resolverHex === '0x' || resolverHex === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      console.error(`ENS: no resolver for ${ensName}`);
      return null;
    }

    // Parse address from ABI-encoded return: padded to 32 bytes, take last 20
    const resolverAddr = '0x' + resolverHex.slice(resolverHex.length - 40);

    // Step 3: call contenthash(node) on resolver
    const contenthashData = '0xbc1c58d1' + node.slice(2).toLowerCase();
    const contenthashHex = await ethCall(l1RpcUrl, resolverAddr, contenthashData);

    if (!contenthashHex || contenthashHex === '0x') {
      console.error(`ENS: no contenthash for ${ensName}`);
      return null;
    }

    // The return is ABI-encoded `bytes`: offset(32) + length(32) + data
    const raw = contenthashHex.startsWith('0x') ? contenthashHex.slice(2) : contenthashHex;
    const dataOffset = parseInt(raw.slice(0, 64), 16) * 2; // offset in nibbles
    const contentLen = parseInt(raw.slice(dataOffset, dataOffset + 64), 16) * 2; // length in nibbles
    const contentBytes = raw.slice(dataOffset + 64, dataOffset + 64 + contentLen);

    if (!contentBytes || contentBytes.length < 4) {
      console.error(`ENS: contenthash too short for ${ensName}`);
      return null;
    }

    // Decode the 0xe3 01 <CID> envelope
    const cidLike = decodeContenthashWrapped('0x' + contentBytes);
    return cidLike.toString();
  } catch (err) {
    console.error(`ENS resolution failed for ${ensName}:`, err);
    return null;
  }
}
