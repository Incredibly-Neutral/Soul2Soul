/**
 * ENS resolution — resolve a publication ENS name to its s2s ROOT CID via the
 * canonical S2S mechanism:
 *
 *   namehash(publication)
 *     → on Base L2 (chainId 8453) getText(node, 'contenthash_wrapped')
 *       from the S2S `ensRecords` records contract
 *     → decode the 0xe3 01 <CID> envelope (EIP-1577 ipfs-ns contenthash)
 *
 * NOTE: s2s never stores the root CID as a standard ENS contenthash on
 * Ethereum mainnet (registry.resolver(node) → resolver.contenthash(node)).
 * It stores the root CID as a TEXT record `contenthash_wrapped` on a custom
 * records contract on Base L2, so that is the only correct read path.
 *
 * The records contract address is discovered by mirroring
 * protocol/actions/src/libs/protocol.factory.ts (getProtocolInfo) and
 * protocol/actions/src/libs/ens.factory.ts, using raw eth_call to keep
 * dependencies minimal:
 *
 *   1. L1 (mainnet): registry.nameWrapper()            → nameWrapper address
 *   2. L1 (mainnet): nameWrapper.ownerOf(namehash('soul2soul.eth'))
 *                    → custom registry
 *   3. L1 (mainnet): customRegistry.parentDomainController()
 *                    → protocol controller (publication multisig)
 *   4. L2 (Base 8453): controller.getModulesPaginated(...) → module list;
 *      module.NAME() == 'S2S Records Module'           → configModule
 *   5. L2 (Base 8453): configModule.getRecords(['data_gateway', 'ens_records',
 *      ...]) → ens_records → the records contract
 *
 * A RECORDS_CONTRACT env override skips the discovery entirely and reads
 * getText straight off that address.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils';
import { decodeContenthashWrapped } from './ipfs/contenthash.js';

/** S2S ENS registry address (Ethereum mainnet, chainId 1) — the s2s NameWrapper registry. */
const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

/** Base mainnet chainId — the chain the records contract lives on. */
export const L2_CHAIN_ID = 8453;

/**
 * The canonical Safe AA (4337) module — present in the publication Safe's
 * module list but can NEVER be an S2S module, so probing it with NAME() is
 * pure waste (mirrors ens.factory.ts KNOWN_NON_S2S_MODULES).
 */
const KNOWN_NON_S2S_MODULES = ['0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226'];

const isKnownNonS2SModule = (address: string): boolean =>
  KNOWN_NON_S2S_MODULES.some(
    (known) => known.toLowerCase() === address.toLowerCase(),
  );

// ---------------------------------------------------------------------------
// ABI selectors (keccak256(signature)[0:4]) — computed against @noble/hashes
// ---------------------------------------------------------------------------
const SEL = {
  nameWrapper: '0xa8e5fbc0', // function nameWrapper() view returns (address)
  ownerOf: '0x6352211e', // function ownerOf(uint256 id) view returns (address)
  parentDomainController: '0xe4df1462', // function parentDomainController() view returns (address)
  getModulesPaginated: '0xcc2f8452', // function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)
  name: '0xa3f4df7e', // function NAME() view returns (string)
  getRecords: '0xbe880b7a', // function getRecords(string[] keys) view returns (address[])
  getText: '0xad428dac', // function getText(bytes32 node, string key) view returns (string)
} as const;

/** getRecords key set, same order as protocol.factory.ts (ens_records is index 1). */
const RECORDS_KEYS = [
  'data_gateway',
  'ens_records',
  'ens_registry',
  'publication_factory',
  'records_factory',
  'pkp_ethAddress',
  'lit_action_prep',
  'lit_action_render',
  'lit_action_update',
] as const;

// ---------------------------------------------------------------------------
// Minimal ABI encode/decode (see verification against ethers v6 in PR notes)
// ---------------------------------------------------------------------------

const u256 = (n: bigint | number): string =>
  BigInt(n).toString(16).padStart(64, '0');

const utf8Bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

function padRight32(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
}

/** ABI-encode a string: length word + data padded to 32 bytes (no offset word). */
function encodeString(s: string): string {
  const bytes = utf8Bytes(s);
  return u256(bytes.length) + bytesToHex(padRight32(bytes));
}

/**
 * ABI-encode a string[]: length + per-element offsets + element data.
 * Offsets are measured from the byte right after the length word (verified
 * byte-for-byte against ethers v6 encodeFunctionData).
 */
function encodeStringArray(strings: readonly string[]): string {
  const elems = strings.map(encodeString);
  let head = u256(strings.length);
  let pos = 32 + 32 * strings.length; // first element data position (bytes)
  const offsets: number[] = [];
  for (let i = 0; i < strings.length; i++) {
    offsets.push(pos);
    pos += elems[i].length / 2;
  }
  // ethers measures element offsets from the byte after the length word
  for (const o of offsets) head += u256(o - 32);
  return head + elems.join('');
}

/** getText(bytes32 node, string key) calldata. */
function calldataGetText(node: string, key: string): string {
  return SEL.getText + node.slice(2).toLowerCase() + u256(0x40) + encodeString(key);
}

/** getRecords(string[]) calldata. */
function calldataGetRecords(): string {
  return SEL.getRecords + u256(0x20) + encodeStringArray(RECORDS_KEYS);
}

/** getModulesPaginated(address,uint256) calldata. */
function calldataGetModulesPaginated(start: string, pageSize: number): string {
  return (
    SEL.getModulesPaginated +
    start.slice(2).toLowerCase().padStart(64, '0') +
    u256(pageSize)
  );
}

/** Decode an ABI `address` return (last 20 bytes of the padded word). */
function decodeAddressReturn(hex: string): string {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  return '0x' + raw.slice(-40);
}

/** Decode an ABI `string` return (offset + length + utf8 data). */
function decodeStringReturn(hex: string): string {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  const offset = parseInt(raw.slice(0, 64), 16) * 2; // nibbles
  const len = parseInt(raw.slice(offset, offset + 64), 16);
  const data = raw.slice(offset + 64, offset + 64 + len * 2);
  return Buffer.from(data, 'hex').toString('utf8');
}

/** Decode an ABI `address[]` return (offset + length + padded addresses). */
function decodeAddressListReturn(hex: string): string[] {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  const offset = parseInt(raw.slice(0, 64), 16) * 2;
  const len = parseInt(raw.slice(offset, offset + 64), 16);
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const word = raw.slice(offset + 64 + i * 64, offset + 64 + i * 64 + 64);
    out.push('0x' + word.slice(-40));
  }
  return out;
}

/** Decode `(address[] array, address next)` return (tuple of two members). */
function decodeModulesReturn(hex: string): { array: string[]; next: string } {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  const arrayOffset = parseInt(raw.slice(0, 64), 16) * 2;
  const next = '0x' + raw.slice(64, 128).slice(-40);
  const len = parseInt(raw.slice(arrayOffset, arrayOffset + 64), 16);
  const array: string[] = [];
  for (let i = 0; i < len; i++) {
    const word = raw.slice(
      arrayOffset + 64 + i * 64,
      arrayOffset + 64 + i * 64 + 64,
    );
    array.push('0x' + word.slice(-40));
  }
  return { array, next };
}

// ---------------------------------------------------------------------------
// eth_call transport
// ---------------------------------------------------------------------------

/**
 * Perform an eth_call against an RPC. `rpcUrl` may be an L1 (mainnet) or
 * L2 (Base) endpoint; the callee must pass the correct one for the contract
 * being read (matching which chain each contract lives on).
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

// ---------------------------------------------------------------------------
// Protocol discovery (mirrors protocol/actions/src/libs/ens.factory.ts +
// protocol.factory.ts getProtocolInfo)
// ---------------------------------------------------------------------------

/**
 * Resolve the protocol controller (publication multisig) via the s2s ENS flow.
 *
 *   L1: registry.nameWrapper() → nameWrapper.ownerOf(namehash('soul2soul.eth'))
 *       → parentDomainController()
 */
export async function getProtocolController(l1RpcUrl: string): Promise<string> {
  const nameWrapper = decodeAddressReturn(
    await ethCall(l1RpcUrl, ENS_REGISTRY_ADDRESS, SEL.nameWrapper),
  );

  // The controller is a property of the s2s root domain, identical for every
  // publication under it (mirrors getProtocolControllerAndModules).
  const subdomainNode = namehash('soul2soul.eth');
  const customRegistry = decodeAddressReturn(
    await ethCall(l1RpcUrl, nameWrapper, SEL.ownerOf + subdomainNode.slice(2).toLowerCase()),
  );

  return decodeAddressReturn(
    await ethCall(l1RpcUrl, customRegistry, SEL.parentDomainController),
  );
}

/**
 * Find the S2S Records config module among the protocol controller's Safe
 * modules by NAME() == 'S2S Records Module' (L2 only).
 */
export async function getConfigModule(
  controller: string,
  l2RpcUrl: string,
): Promise<string | null> {
  const { array: modules } = decodeModulesReturn(
    await ethCall(
      l2RpcUrl,
      controller,
      calldataGetModulesPaginated('0x0000000000000000000000000000000000000001', 10),
    ),
  );

  for (const moduleAddress of modules) {
    if (isKnownNonS2SModule(moduleAddress)) continue;
    try {
      const name = decodeStringReturn(
        await ethCall(l2RpcUrl, moduleAddress, SEL.name),
      );
      if (name === 'S2S Records Module') return moduleAddress;
    } catch {
      // Module doesn't implement NAME() — skip it (mirrors ens.factory.ts).
    }
  }
  return null;
}

/**
 * Read the `ens_records` records-contract address from the config module's
 * getRecords() (L2 only).
 */
export async function getRecordsContract(
  configModule: string,
  l2RpcUrl: string,
): Promise<string> {
  const addresses = decodeAddressListReturn(
    await ethCall(l2RpcUrl, configModule, calldataGetRecords()),
  );
  return addresses[1] ?? ''; // index 1 == 'ens_records'
}

/**
 * Discover the full s2s protocol layout: controller → configModule →
 * ensRecords (the records contract). Replicates getProtocolInfo().
 */
export async function getProtocolInfo(
  l1RpcUrl: string,
  l2RpcUrl: string,
): Promise<{ controller: string; configModule: string; ensRecords: string }> {
  const controller = await getProtocolController(l1RpcUrl);
  const configModule = await getConfigModule(controller, l2RpcUrl);
  if (!configModule) {
    throw new Error('ENS: no S2S Records config module found on protocol controller');
  }
  const ensRecords = await getRecordsContract(configModule, l2RpcUrl);
  if (!ensRecords) {
    throw new Error('ENS: ens_records records contract not found via getRecords');
  }
  return { controller, configModule, ensRecords };
}

/**
 * Resolve the records-contract address: explicit/env override first, else the
 * s2s discovery flow.
 */
async function getEnsRecords(
  l1RpcUrl: string,
  l2RpcUrl: string,
  recordsContract?: string,
): Promise<string | null> {
  const override = recordsContract || process.env.RECORDS_CONTRACT || '';
  if (override) return override;
  try {
    return (await getProtocolInfo(l1RpcUrl, l2RpcUrl)).ensRecords;
  } catch (err) {
    console.error(`ENS: protocol discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public helpers (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Root CID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an s2s publication ENS name to its ROOT CID.
 *
 * Steps (canonical s2s mechanism):
 * 1. namehash the ENS name → node
 * 2. Resolve the `ensRecords` records contract: `recordsContract` override
 *    (or L2_RPC_URL/RECORDS_CONTRACT env) if given, else discover via the s2s
 *    ENS flow (getProtocolInfo).
 * 3. On Base L2 (8453), call getText(node, 'contenthash_wrapped') on the
 *    records contract.
 * 4. Decode the 0xe3 01 <CID> envelope to a plain CID string.
 *
 * `l1RpcUrl` is Ethereum mainnet and is used only for the L1 controller
 * discovery leg; the actual CID read happens on `l2RpcUrl` (Base 8453).
 *
 * @returns The root CID string, or null if resolution fails.
 */
export async function resolveEnsToCID(
  ensName: string,
  l1RpcUrl: string,
  l2RpcUrl?: string,
  recordsContract?: string,
): Promise<string | null> {
  try {
    const node = namehash(ensName);

    const l2 = l2RpcUrl || process.env.L2_RPC_URL || '';
    if (!l2) {
      console.error('ENS: L2_RPC_URL (Base 8453) is required to resolve the records contract');
      return null;
    }

    const ensRecords = await getEnsRecords(l1RpcUrl, l2, recordsContract);
    if (!ensRecords) {
      console.error(`ENS: could not determine ensRecords records contract for ${ensName}`);
      return null;
    }

    // Step 3: getText(node, 'contenthash_wrapped') on the records contract (L2)
    const textHex = await ethCall(l2, ensRecords, calldataGetText(node, 'contenthash_wrapped'));
    if (!textHex || textHex === '0x') {
      console.error(`ENS: no contenthash_wrapped text record for ${ensName}`);
      return null;
    }

    const value = decodeStringReturn(textHex);
    if (!value || value === '0x') {
      console.error(`ENS: empty contenthash_wrapped text record for ${ensName}`);
      return null;
    }

    // Step 4: decode the 0xe3 01 <CID> envelope
    const cidLike = decodeContenthashWrapped(value);
    return cidLike.toString();
  } catch (err) {
    console.error(`ENS resolution failed for ${ensName}:`, err);
    return null;
  }
}
