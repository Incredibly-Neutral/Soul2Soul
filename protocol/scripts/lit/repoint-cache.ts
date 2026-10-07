// protocol/scripts/lit/repoint-cache.ts — Phase 3: execute the repoint-archive
// Lit action to repoint the s3nl cache pointer at the rebuilt archive.
//
// Uses the SAME live transport as the orchestrator (runAction non-preview):
//   fetch action code from Pinata → LitService.executeAction(code, inputs, usageKey)
// The usage key (VITE_LIT_USAGE_KEY) is the app's Lit executor credential —
// already in root .env.
//
// The repoint-archive action is gated by canReset: the signature over
// 'lit actions auth' must recover to an OWNER of the PUBLICATION Safe
// (0xaB16Bf896018f282Ea864810644f66df15980E6c for s3nl). You do NOT need to
// share a private key: sign the literal string 'lit actions auth' with an owner
// wallet and provide the SIGNATURE as PUBLICATION_OWNER_SIGNATURE (env or argv[2]).
// (For local testing you may instead set PUBLICATION_OWNER_PRIVATE_KEY and the
// script signs for you.) Either way it pre-flights isOwner and refuses to
// proceed unless the recovered signer is an owner of the publication Safe.
//
// Run:  cd protocol && npx tsx scripts/lit/repoint-cache.ts [owner_signature]

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { createPublicClient, http, keccak256, toHex, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { LitService } from '@s2s/soul2soul-shared';

const MESSAGE = 'lit actions auth';
const MESSAGE_HASH = keccak256(toHex(`\x19Ethereum Signed Message:\n${MESSAGE.length}${MESSAGE}`));

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../../.env'), quiet: true });

const PUBLICATION = process.env.PUBLICATION || 's3nl.soul2soul.eth';
const PUB_SAFE = '0xaB16Bf896018f282Ea864810644f66df15980E6c';
const ARCHIVE_CID = 'Qmd3BngEHfJtuab1r3JLWj9YPN32U2DwfsxTjn5hidvmw7';
const GATEWAY = (process.env.IPFS_URL || 'https://ipfs.transport-union.dev').replace(/\/$/, '');
const PINATA_GATEWAY = (process.env.PINATA_GATEWAY || 'https://neutralpress.mypinata.cloud').replace(/\/$/, '');
const USAGE_KEY = process.env.VITE_LIT_USAGE_KEY || '';

// ── Repoint action CID ────────────────────────────────────────────────────
// IMPORTANT: the execution authority is the Lit GROUP, which registers
// QmZr42… (hash 0xb08495…). config.json currently says QmWNxw6… (hash
// 0x596c16…, newer shared schema with the optional `repointArchive` field)
// but that bundle is NOT registered in group 1 — executing it would be denied.
// Both bundles contain the identical repoint action code (verified by diff:
// the only difference is the optional repointArchive field in the shared
// protocolSchema, which does not affect this action's runtime). We execute
// the group-registered bundle. See the divergence note for the cleanup.
const REPOINT_ACTION_CID = 'QmZr42z6rCaMAGWPFR5jR1gcwfuGyHjaEySrFGeMDnR4Hi';

// Resolve the deployed repoint-archive action CID from config.json.
function actionCid(name: string): string {
  const cfg = JSON.parse(readFileSync(resolve(here, 'config.json'), 'utf8'));
  const g = cfg.groups?.find((x: any) => x.name === 's2s');
  const a = g?.actions?.find((x: any) => x.name === name);
  if (!a?.cid) throw new Error(`action '${name}' not found in config.json`);
  return a.cid;
}

async function main() {
  if (!USAGE_KEY) throw new Error('VITE_LIT_USAGE_KEY missing from .env');
  const ownerPk = process.env.PUBLICATION_OWNER_PRIVATE_KEY;
  const providedSig = process.argv[2] || process.env.PUBLICATION_OWNER_SIGNATURE;
  if (!ownerPk && !providedSig) {
    console.error(
      'No signer provided — the repoint-archive action is gated by canReset and\n' +
        'needs a signature from an OWNER of the publication Safe\n' +
        `  ${PUB_SAFE}\n` +
        'Option 1 (recommended — no key leaves your wallet): sign the literal string\n' +
        `  '${MESSAGE}'\n` +
        'with an owner wallet (EIP-191 personal_sign) and provide the signature as\n' +
        '  PUBLICATION_OWNER_SIGNATURE=<0x…> in .env, or as argv[2].\n' +
        'Option 2 (local test only): set PUBLICATION_OWNER_PRIVATE_KEY and the script signs.',
    );
    process.exit(1);
  }

  // ── Pre-flight: the recovered signer MUST be an owner of the publication Safe ──
  let signer: string;
  let signature: string;
  if (providedSig) {
    signature = providedSig;
    signer = await recoverAddress({ hash: MESSAGE_HASH, signature: signature as `0x${string}` });
    console.log(`signer (recovered from your signature): ${signer}`);
  } else {
    const owner = privateKeyToAccount(`0x${ownerPk.replace(/^0x/, '')}` as `0x${string}`);
    signature = await owner.signMessage({ message: MESSAGE });
    signer = owner.address;
    console.log(`signer:        ${signer}  (signed locally from PUBLICATION_OWNER_PRIVATE_KEY)`);
  }
  const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
  const isOwner = await pub.readContract({
    address: PUB_SAFE,
    abi: [{ name: 'isOwner', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'bool' }] }] as const,
    functionName: 'isOwner',
    args: [signer as `0x${string}`],
  });
  if (!isOwner) {
    console.error(`REFUSING: signer ${signer} is NOT an owner of the publication Safe ${PUB_SAFE}`);
    process.exit(1);
  }
  console.log(`publication Safe owner ✓`);

  const cfgCid = actionCid('repoint-archive');
  const cid = REPOINT_ACTION_CID;
  if (cfgCid !== cid) {
    console.warn(`note: config.json lists repoint-archive = ${cfgCid} but the Lit group only\n      registers ${cid} — executing the group-registered bundle (the other is not authorized).`);
  }
  console.log(`publication:   ${PUBLICATION}`);
  console.log(`publication Safe: ${PUB_SAFE}`);
  console.log(`archive CID:   ${ARCHIVE_CID}`);
  console.log(`action CID:    ${cid}`);
  console.log(`gateway:       ${GATEWAY}`);

  console.log(`messageHash:   ${MESSAGE_HASH}`);
  console.log(`signature:     ${signature.slice(0, 20)}…`);

  const inputs: Record<string, unknown> = {
    publication: PUBLICATION,
    signature,
    authorSafeAddress: PUB_SAFE,
    archiveCid: ARCHIVE_CID,
    preview: false,
    endpoints: {
      ipfsGateway: GATEWAY,
      rpcs: {
        L1: process.env.MAINNET_RPC_URL ? [process.env.MAINNET_RPC_URL] : [],
        L2: process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : [],
      },
    },
  };

  // ── Execute live: fetch action code (transport-union, NOT Pinata which 403s
  //    all CIDs right now), then Lit executeAction ──
  const codeUrl = `${GATEWAY}/ipfs/${cid}`;
  console.log(`\nfetching action code from ${codeUrl} …`);
  const codeResp = await fetch(codeUrl);
  if (!codeResp.ok) {
    const pinataUrl = `${PINATA_GATEWAY}/ipfs/${cid}`;
    console.warn(`transport-union fetch failed (${codeResp.status}) — trying ${pinataUrl}`);
    const alt = await fetch(pinataUrl);
    if (!alt.ok) throw new Error(`action code fetch failed: transport-union ${codeResp.status}, pinata ${alt.status}`);
    const code = await alt.text();
    console.log(`action code: ${code.length} chars (via pinata)`);
    await exec(code, inputs);
    return;
  }
  const code = await codeResp.text();
  console.log(`action code: ${code.length} chars`);
  await exec(code, inputs);
}

async function exec(code: string, inputs: Record<string, unknown>) {
  const lit = new LitService({ environment: 'prod', accountKey: USAGE_KEY });
  console.log('executing repoint-archive action on Lit nodes …');
  const raw = await lit.executeAction(code, inputs, USAGE_KEY);
  const response = (raw as any)?.response;

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(response, null, 2));
  const logs = (raw as any)?.logs;
  if (typeof logs === 'string' && logs.trim()) {
    console.log('\n=== ACTION LOGS ===');
    console.log(logs);
  } else if (Array.isArray(logs) && logs.length) {
    console.log('\n=== ACTION LOGS ===');
    logs.forEach((l: string) => console.log(l));
  }
  const ok = response?.ok === true;
  if (ok) console.log('\n✅ pointer write confirmed — verify on-chain:');
  else console.log('\n❌ action did not return ok:true');
  console.log(`  content_cache_${PUBLICATION} should be the EIP-1577 pointer for ${ARCHIVE_CID}`);
}

main().catch((e) => {
  console.error(`\nrepoint-cache failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
