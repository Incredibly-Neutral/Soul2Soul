// press/scripts/lit/fetch-items.ts — Phase 1: pull all publication item
// CIDs from ipfs.transport-union.dev into a local staging dir for the
// off-chain archive rebuild. Read-only against the gateway (no writes on-chain).
//
// Run:  (repo root) npx tsx src/press/scripts/lit/fetch-items.ts [outDir]

import { config as loadEnv } from 'dotenv';
import { createPublicClient, http, namehash } from 'viem';
import { mainnet, base } from 'viem/chains';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { getManifest, isPublicationModuleName } from '@s2s/soul2soul-shared';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../../../.env'), quiet: true });

const PUBLICATION = process.env.PUBLICATION || 's3nl.soul2soul.eth';
const GATEWAY = (process.env.IPFS_URL || 'https://ipfs.transport-union.dev').replace(/\/$/, '');
const OUT_DIR = resolve(here, process.argv[2] || `.rebuild-stage-${PUBLICATION.replace(/\./g, '_')}`);

const ENS_REGISTRY = (process.env.ENS_OPEN_SUBDOMAIN_REGISTRY || '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5') as `0x${string}`;
const KNOWN_NON_S2S = ['0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226'];
const ENTRY_COMPONENTS = [
  { name: 'genesis', type: 'bytes32' },
  { name: 'author', type: 'address' },
  { name: 'cid', type: 'string' },
  { name: 'timestamp', type: 'uint256' },
];
const ABIS = {
  nameWrapper: [{ type: 'function', name: 'nameWrapper', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
  ownerOf: [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'id' }], outputs: [{ type: 'address' }] }],
  getModulesPaginated: [{ type: 'function', name: 'getModulesPaginated', stateMutability: 'view', inputs: [{ type: 'address', name: 'start' }, { type: 'uint256', name: 'pageSize' }], outputs: [{ type: 'address[]', name: 'array' }, { type: 'address', name: 'next' }] }],
  name: [{ type: 'function', name: 'NAME', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }],
  // The CREATE2 factory's predictions. A factory deployed before it answers none
  // of the three; every read below is caught and the NAME() scan runs instead.
  moduleAddress: [{ type: 'function', name: 'moduleAddress', stateMutability: 'view', inputs: [{ type: 'address', name: 'safe' }], outputs: [{ type: 'address' }] }],
  moduleAddressForVersion: [{ type: 'function', name: 'moduleAddressForVersion', stateMutability: 'view', inputs: [{ type: 'address', name: 'safe' }, { type: 'uint256', name: 'version' }], outputs: [{ type: 'address' }] }],
  implementationCount: [{ type: 'function', name: 'implementationCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
  getDeals: [{ type: 'function', name: 'getDeals', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'offset' }, { type: 'uint256', name: 'limit' }], outputs: [{ type: 'tuple[]', components: ENTRY_COMPONENTS }] }],
};

const l1 = createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL!) });
const l2 = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL!) });
let publicationFactory: `0x${string}` | null = null;
const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The factory, taken from the manifest document, read once per run. Absent is
// not fatal: the NAME() scan below still resolves the module.
async function getFactoryFromManifest(): Promise<`0x${string}` | null> {
  try {
    const manifest = await getManifest(l1, l2);
    return (manifest.moduleFactory || null) as `0x${string}` | null;
  } catch (e) {
    console.log(`manifest unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// The factory's CREATE2 prediction for this Safe, accepted only when the Safe's
// module list already holds it. A factory without these reads fails on the first
// one and the caller falls through to the NAME() scan.
async function predictPublicationModule(
  safe: `0x${string}`,
  candidates: `0x${string}`[],
): Promise<`0x${string}` | null> {
  if (!publicationFactory) return null;
  const onList = (addr: unknown) =>
    typeof addr === 'string'
      ? ((candidates.find((m) => m.toLowerCase() === addr.toLowerCase()) as `0x${string}`) ?? null)
      : null;
  try {
    const next = onList(await l2.readContract({ address: publicationFactory, abi: ABIS.moduleAddress, functionName: 'moduleAddress', args: [safe] }));
    if (next) return next;
    const count = Number(await l2.readContract({ address: publicationFactory, abi: ABIS.implementationCount, functionName: 'implementationCount' }));
    // Versions are 1-based over the implementation history and the view reverts
    // InvalidVersion at 0, so the walk is for the older generations only:
    // `moduleAddress` already covered the newest one. Count 2 asks version 1.
    for (let version = count - 1; version >= Math.max(1, count - 8); version--) {
      const hit = onList(await l2.readContract({ address: publicationFactory, abi: ABIS.moduleAddressForVersion, functionName: 'moduleAddressForVersion', args: [safe, BigInt(version)] }));
      if (hit) return hit;
    }
  } catch { /* not a CREATE2 factory, or a failed read: fall through */ }
  return null;
}

async function resolvePublicationModule(name: string) {
  const node = namehash(name);
  const nw = await l1.readContract({ address: ENS_REGISTRY, abi: ABIS.nameWrapper, functionName: 'nameWrapper' });
  const multisig = await l1.readContract({ address: nw, abi: ABIS.ownerOf, functionName: 'ownerOf', args: [BigInt(node)] });
  const [modules] = await l2.readContract({ address: multisig as `0x${string}`, abi: ABIS.getModulesPaginated, functionName: 'getModulesPaginated', args: ['0x0000000000000000000000000000000000000001', 10n] });
  const candidates = (modules as `0x${string}`[]).filter(
    (addr) => !KNOWN_NON_S2S.some((k) => k.toLowerCase() === addr.toLowerCase()),
  );

  // Prediction first: the factory names the module for this Safe, and the
  // answer counts only when the Safe already lists it.
  const predicted = await predictPublicationModule(multisig as `0x${string}`, candidates);
  if (predicted) return predicted;

  for (const addr of candidates) {
    try {
      const n = await l2.readContract({ address: addr, abi: ABIS.name, functionName: 'NAME' });
      if (isPublicationModuleName(n)) return addr;
    } catch { /* no NAME() */ }
  }
  return null;
}

async function fetchItem(cid: string): Promise<{ ok: boolean; body?: string; status?: number; error?: string }> {
  try {
    const res = await fetch(`${GATEWAY}/api/v0/cat?arg=${cid}`, { method: 'POST', signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.text() };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

async function main() {
  console.log(`publication: ${PUBLICATION}`);
  console.log(`gateway:     ${GATEWAY}`);
  console.log(`staging:     ${OUT_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });

  publicationFactory = await getFactoryFromManifest();
  console.log(`factory:     ${publicationFactory || '(unreadable — NAME() scan only)'}`);

  const pubModule = await resolvePublicationModule(PUBLICATION);
  if (!pubModule) { console.error('no publication module'); process.exit(1); }
  console.log(`publication module: ${pubModule}`);

  const deals: { genesis: string; author: string; cid: string; timestamp: bigint }[] = [];
  for (let offset = 0n; ; offset += 100n) {
    const page = await l2.readContract({ address: pubModule as `0x${string}`, abi: ABIS.getDeals, functionName: 'getDeals', args: [offset, 100n] });
    for (const e of page) deals.push({ genesis: e.genesis, author: e.author, cid: e.cid, timestamp: e.timestamp });
    if (page.length < 100) break;
  }
  console.log(`deals: ${deals.length}`);

  const manifest: any[] = [];
  let ok = 0, failed = 0;
  for (let i = 0; i < deals.length; i++) {
    const d = deals[i];
    const r = await fetchItem(d.cid);
    const file = `${OUT_DIR}/${String(i).padStart(3, '0')}_${d.genesis.slice(0, 8)}.json`;
    if (r.ok && r.body) {
      let valid = false; let note = '';
      try { const j = JSON.parse(r.body); valid = !!j && (!!j.public || !!j.encryption); if (!valid) note = 'missing public/encryption'; } catch { note = 'not JSON'; }
      if (valid) {
        writeFileSync(file, r.body);
        manifest.push({ i, genesis: d.genesis, cid: d.cid, author: d.author, size: r.body.length, file });
        ok++;
        console.log(`  ✓ [${i}] ${d.cid.slice(0, 20)}… ${r.body.length}b ${note || 'valid'}`);
      } else {
        failed++;
        console.log(`  ✗ [${i}] ${d.cid.slice(0, 20)}… invalid: ${note}`);
      }
    } else {
      failed++;
      console.log(`  ✗ [${i}] ${d.cid.slice(0, 20)}… ${r.status ? `HTTP ${r.status}` : `ERR ${r.error}`}`);
    }
    await timeout(80);
  }

  writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify({ publication: PUBLICATION, gateway: GATEWAY, fetchedAt: new Date().toISOString(), deals: deals.map((d) => ({ ...d, timestamp: d.timestamp.toString() })), fetched: manifest }, null, 2));
  console.log(`\nfetched OK: ${ok}/${deals.length}   failed: ${failed}`);
  console.log(`manifest: ${OUT_DIR}/manifest.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
