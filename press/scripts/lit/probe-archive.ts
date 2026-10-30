// press/scripts/lit/probe-archive.ts — PHASE 0 (read-only) verification.
//
// Goal: verify the recovery preconditions for the lost per-publication content
// archive cache WITHOUT writing anything on-chain.
//
//  1. Resolve the protocol controller (soul2soul.eth) → records module →
//     ENS records contract + publication factory (same walk the actions do).
//  2. For each candidate publication identity, resolve the publication Safe +
//     publication module (getDomainOwnerAndModules walk) and read:
//       - `content_cache_<publication>` text record on the ENS records contract
//         (the archive pointer; decodes EIP-1577 envelope → CID)
//       - `getDeals` (offset/limit paginated) → P entries + item CIDs
//  3. Probe every unique item CID against the three storage providers
//     (transport-union Kubo, Pinata gateway, Filebase gateway) to confirm
//     availability for an off-chain archive rebuild.
//  4. Print the cold-render budget math so we can decide whether maintain-cache
//     can reseed in-action (small P) or needs the off-chain build + seed hook.
//
// Read-only: no transactions, no Lit session, no writes to any contract or
// gateway beyond GET-style content probes.
//
// Run:  cd protocol && npx tsx scripts/lit/probe-archive.ts

import { config as loadEnv } from 'dotenv';
import { createPublicClient, http, namehash } from 'viem';
import { mainnet, base } from 'viem/chains';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  getProtocolControllerAndModules,
  getRecords,
  decodeContenthashWrapped,
} from '@s2s/soul2soul-shared';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../../.env'), quiet: true });

const L1_RPC = process.env.MAINNET_RPC_URL!;
const L2_RPC = process.env.BASE_RPC_URL!;

const ENS_REGISTRY = (process.env.ENS_OPEN_SUBDOMAIN_REGISTRY || '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5') as `0x${string}`;
const KNOWN_NON_S2S_MODULES = ['0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226'];

const GATEWAYS = {
  transportUnion: (process.env.IPFS_URL || 'https://ipfs.transport-union.dev').replace(/\/$/, ''),
  pinata: `https://${process.env.PINATA_GATEWAY || 'neutralpress.mypinata.cloud'}`,
  filebase: 'https://ipfs.filebase.io',
};

const ENTRY_COMPONENTS = [
  { name: 'genesis', type: 'bytes32' },
  { name: 'author', type: 'address' },
  { name: 'cid', type: 'string' },
  { name: 'timestamp', type: 'uint256' },
];

const ABIS = {
  nameWrapper: [{ type: 'function', name: 'nameWrapper', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
  ownerOf: [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'id' }], outputs: [{ type: 'address' }] }],
  getModulesPaginated: [{
    type: 'function', name: 'getModulesPaginated', stateMutability: 'view',
    inputs: [{ type: 'address', name: 'start' }, { type: 'uint256', name: 'pageSize' }],
    outputs: [{ type: 'address[]', name: 'array' }, { type: 'address', name: 'next' }],
  }],
  name: [{ type: 'function', name: 'NAME', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }],
  getText: [{
    type: 'function', name: 'getText', stateMutability: 'view',
    inputs: [{ type: 'bytes32', name: 'node' }, { type: 'string', name: 'key' }],
    outputs: [{ type: 'string' }],
  }],
  getDeals: [{
    type: 'function', name: 'getDeals', stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'offset' }, { type: 'uint256', name: 'limit' }],
    outputs: [{ type: 'tuple[]', components: ENTRY_COMPONENTS }],
  }],
};

const l1 = createPublicClient({ chain: mainnet, transport: http(L1_RPC) });
const l2 = createPublicClient({ chain: base, transport: http(L2_RPC) });

const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, timeout(ms).then(() => { throw new Error('timeout'); })]);

async function resolvePublicationModule(name: string) {
  const node = namehash(name);
  const nw = await l1.readContract({ address: ENS_REGISTRY, abi: ABIS.nameWrapper, functionName: 'nameWrapper' });
  const multisig = await l1.readContract({ address: nw, abi: ABIS.ownerOf, functionName: 'ownerOf', args: [BigInt(node)] });
  if (/^0x0+$/.test(multisig)) return { node, multisig: null, configModule: null, publicationModule: null };
  const [modules] = await l2.readContract({
    address: multisig as `0x${string}`, abi: ABIS.getModulesPaginated, functionName: 'getModulesPaginated',
    args: ['0x0000000000000000000000000000000000000001', 10n],
  });
  let configModule: string | null = null;
  let publicationModule: string | null = null;
  for (const addr of modules as `0x${string}`[]) {
    if (KNOWN_NON_S2S_MODULES.some((k) => k.toLowerCase() === addr.toLowerCase())) continue;
    try {
      const n = await l2.readContract({ address: addr, abi: ABIS.name, functionName: 'NAME' });
      if (n === 'S2S Records Module') configModule = addr;
      else if (n === 'S2S Publication Module V2' || n === 'S2S Publication Module') publicationModule = addr;
    } catch { /* no NAME() */ }
  }
  return { node, multisig, configModule, publicationModule };
}

async function getDeals(pubModule: string) {
  const out: { genesis: string; author: string; cid: string; timestamp: bigint }[] = [];
  for (let offset = 0n; ; offset += 100n) {
    const page = await l2.readContract({
      address: pubModule as `0x${string}`, abi: ABIS.getDeals, functionName: 'getDeals',
      args: [offset, 100n],
    });
    for (const e of page) out.push({ genesis: e.genesis, author: e.author, cid: e.cid, timestamp: e.timestamp });
    if (page.length < 100) break;
  }
  return out;
}

async function probeCid(cid: string) {
  const results: Record<string, string> = {};
  // transport-union: Kubo RPC cat
  try {
    const res = await withTimeout(fetch(`${GATEWAYS.transportUnion}/api/v0/cat?arg=${cid}`, { method: 'POST' }), 15000);
    const ok = res.ok;
    const body = ok ? await res.text() : '';
    results.transportUnion = ok ? `OK (${body.length}b)` : `FAIL ${res.status}`;
  } catch (e) { results.transportUnion = `ERR ${e instanceof Error ? e.message : String(e)}`; }
  // Pinata gateway
  try {
    const res = await withTimeout(fetch(`${GATEWAYS.pinata}/ipfs/${cid}`), 15000);
    const ok = res.ok;
    const body = ok ? await res.text() : '';
    results.pinata = ok ? `OK (${body.length}b)` : `FAIL ${res.status}`;
  } catch (e) { results.pinata = `ERR ${e instanceof Error ? e.message : String(e)}`; }
  // Filebase gateway
  try {
    const res = await withTimeout(fetch(`${GATEWAYS.filebase}/ipfs/${cid}`), 15000);
    const ok = res.ok;
    const body = ok ? await res.text() : '';
    results.filebase = ok ? `OK (${body.length}b)` : `FAIL ${res.status}`;
  } catch (e) { results.filebase = `ERR ${e instanceof Error ? e.message : String(e)}`; }
  return results;
}

async function main() {
  console.log('=== Phase 0: archive-cache recovery probe (read-only) ===');
  console.log(`L1: ${L1_RPC.replace(/https?:\/\//, '').slice(0, 40)}…`);
  console.log(`L2: ${L2_RPC.replace(/https?:\/\//, '').slice(0, 40)}…`);
  console.log(`gateways: ${JSON.stringify(GATEWAYS)}`);
  console.log('');

  // 1. Protocol info
  const { multisig: protoSafe, configModule: protoConfig } = await getProtocolControllerAndModules(false, l1, l2);
  console.log(`protocol safe:   ${protoSafe}`);
  console.log(`protocol config: ${protoConfig}`);
  if (!protoConfig) { console.error('FATAL: no protocol config module'); process.exit(1); }
  const records = await getRecords(protoConfig!, ['ens_records', 'publication_factory', 'pkp_ethAddress', 'data_gateway', 'lit_action_maintainCache'], l2);
  const [ensRecords, pubFactory, pkp, dataGateway, maintainCacheAction] = records;
  console.log(`ens_records:        ${ensRecords}`);
  console.log(`publication_factory:${pubFactory}`);
  console.log(`pkp_ethAddress:     ${pkp}`);
  console.log(`data_gateway:       ${dataGateway}`);
  console.log(`lit_action_maintainCache: ${maintainCacheAction || '(unset — orchestrator skips maintain-cache)'}`);
  console.log('');

  // 2. Candidates
  const candidates = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['s3nl.soul2soul.io', 's3nl.soul2soul.eth'];

  for (const name of candidates) {
    console.log(`\n──────── publication: ${name} ────────`);
    const node = namehash(name);
    const key = `content_cache_${name}`;
    let pointerRaw = '';
    try {
      pointerRaw = await l2.readContract({
        address: ensRecords as `0x${string}`, abi: ABIS.getText, functionName: 'getText', args: [node, key],
      });
    } catch (e) { console.log(`  pointer read FAILED: ${e instanceof Error ? e.message : String(e)}`); }
    let pointerCid = '';
    if (pointerRaw) {
      try { pointerCid = decodeContenthashWrapped(pointerRaw).toString(); }
      catch (e) { console.log(`  pointer not an ipfs contenthash (len=${pointerRaw.length}): ${e instanceof Error ? e.message : String(e)}`); }
    }
    console.log(`  node: ${node}`);
    console.log(`  ${key} pointer raw: ${pointerRaw || '(empty)'}`);
    console.log(`  → archive CID: ${pointerCid || '(none / unreadable)'}`);

    const { multisig, configModule, publicationModule } = await resolvePublicationModule(name);
    console.log(`  publication Safe: ${multisig || '(unresolved)'}`);
    if (multisig) {
      console.log(`  config module:    ${configModule || '(none found)'}`);
      console.log(`  publication module: ${publicationModule || '(none found)'}`);
    }

    if (!publicationModule) {
      console.log('  → no publication module for this name (not the live publication, or unresolved)');
      continue;
    }

    const deals = await getDeals(publicationModule);
    const uniqueCids = [...new Set(deals.map((d) => d.cid))];
    console.log(`  deals: ${deals.length}  unique item CIDs: ${uniqueCids.length}`);
    deals.slice(0, 8).forEach((d, i) =>
      console.log(`    [${i}] genesis ${d.genesis.slice(0, 18)}… author ${d.author.slice(0, 10)}… cid ${d.cid.slice(0, 24)}…`));

    // 3. Availability probe
    console.log(`  probing ${uniqueCids.length} unique item CIDs across providers…`);
    const summary = { transportUnion: 0, pinata: 0, filebase: 0 };
    const failed: { cid: string; by: string[] }[] = [];
    let idx = 0;
    for (const cid of uniqueCids) {
      const r = await probeCid(cid);
      const missing = Object.entries(r).filter(([, v]) => v.startsWith('FAIL') || v.startsWith('ERR')).map(([k]) => k);
      if (r.transportUnion.startsWith('OK')) summary.transportUnion++;
      if (r.pinata.startsWith('OK')) summary.pinata++;
      if (r.filebase.startsWith('OK')) summary.filebase++;
      if (missing.length) failed.push({ cid, by: missing });
      if (idx < 5 || missing.length) {
        console.log(`    ${cid.slice(0, 30)}…  tu=${r.transportUnion} pinata=${r.pinata} fb=${r.filebase}`);
      }
      idx++;
      await timeout(50);
    }
    console.log(`  availability: transportUnion ${summary.transportUnion}/${uniqueCids.length}  Pinata ${summary.pinata}/${uniqueCids.length}  Filebase ${summary.filebase}/${uniqueCids.length}`);
    if (failed.length) {
      console.log(`  missing from ≥1 provider (${failed.length}):`);
      failed.forEach((f) => console.log(`    ${f.cid}  missing: ${f.by.join(', ')}`));
    } else {
      console.log('  all item CIDs available from all three providers');
    }

    // 4. Budget math
    const P = deals.length;
    const renderCold = 17 + P; // 17 fixed + P cats (best case, no decrypt/NAME probes counted)
    const maintainReseed = 12 + P;
    console.log(`  budget: P=${P}  cold-render≈17+P=${renderCold}  maintain-cache reseed≈12+P=${maintainReseed}  (Lit cap=50)`);
    console.log(`  verdict: ${maintainReseed <= 50 ? 'maintain-cache CAN reseed in-action' : 'too large → need off-chain build + seed hook'}`);
  }

  console.log('\n=== Phase 0 complete (read-only; nothing written) ===');
}

main().catch((e) => { console.error(e); process.exit(1); });
