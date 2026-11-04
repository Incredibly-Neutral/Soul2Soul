// press/scripts/lit/rebuild-archive.ts — Phase 1: rebuild the lost
// per-publication content archive cache off-chain (no on-chain writes).
//
// Source of truth: getDeals() (on-chain, in the staged manifest) + the item
// CIDs (fetched from ipfs.transport-union.dev into the staging dir).
//
// Output: the new archive blob, its CID, and the EIP-1577 pointer value that
// maintain-cache/update would write to `content_cache_<publication>`.
//
// DEFAULT = DRY RUN: builds + validates + computes CID + pointer value locally,
// uploads nothing.
//   --push  uploads the archive to transport-union (Kubo add) and triple-pins
//           it to Pinata + Filebase, then prints the final CID + pointer value.
//
// Run:  (repo root) npx tsx src/press/scripts/lit/rebuild-archive.ts [--push]

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync, readdirSync, existsSync } from 'fs';
import ipfsHashPkg from 'typestub-ipfs-only-hash';
import {
  parseCID,
  encodeContenthashWrapped,
} from '@s2s/soul2soul-shared';
import { mergeArchive, reconcile, serialize } from '../../actions/src/libs/archive.factory';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../../../.env'), quiet: true });

const PUBLICATION = process.env.PUBLICATION || 's3nl.soul2soul.eth';
const GATEWAY = (process.env.IPFS_URL || 'https://ipfs.transport-union.dev').replace(/\/$/, '');
const STAGE = resolve(here, `.rebuild-stage-${PUBLICATION.replace(/\./g, '_')}`);
const PUSH = process.argv.includes('--push');

const ipfsHash = (ipfsHashPkg as any).of ?? (ipfsHashPkg as any).default?.of;

const toHexString = (cid: string) => encodeContenthashWrapped(parseCID(cid));

async function main() {
  console.log(`publication: ${PUBLICATION}`);
  console.log(`stage:       ${STAGE}`);
  console.log(`mode:        ${PUSH ? 'PUSH (uploads + triple-pins)' : 'DRY RUN (no uploads)'}`);

  const manifestPath = resolve(STAGE, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`no manifest at ${manifestPath} — run fetch-items.ts first`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deals: { genesis: string; author: string; cid: string; timestamp: string }[] = manifest.deals;
  console.log(`deals from manifest: ${deals.length}`);

  // Load each staged item and rebuild the refreshed map genesis → S2SContentItem.
  const refreshed = new Map<string, S2SContentItem>();
  for (const f of manifest.fetched) {
    const raw = readFileSync(f.file, 'utf8');
    const item = JSON.parse(raw) as S2SContentItem;
    refreshed.set(f.genesis, item);
  }
  console.log(`staged items loaded: ${refreshed.size}`);

  // Content-addressing verification: hash each staged item's raw bytes and
  // require it to equal its on-chain deal cid. This is the "content follows
  // cid" check — it proves the archive we are about to build is honest (see
  // brain/reviews/archive-cache-security-2026-10-06.md).
  let verified = 0;
  for (const f of manifest.fetched) {
    const raw = readFileSync(f.file, 'utf8');
    const h = await ipfsHash(raw);
    if (h !== f.cid) {
      console.error(`CONTENT MISMATCH: ${f.genesis} — deal cid ${f.cid} != hash of staged bytes ${h}`);
      process.exit(1);
    }
    verified++;
  }
  console.log(`content-hash verify: ${verified}/${manifest.fetched.length} match on-chain deal cids`);

  // Rebuild the archive from scratch (prev = null), then stamp the publication.
  const archive = mergeArchive(null, deals, refreshed);
  archive.publication = PUBLICATION.split('.')[0]; // short name, inert metadata field
  console.log(`archive items: ${Object.keys(archive.items).length}  format: ${archive.format}`);

  // Self-check: reconcile must find ZERO drift (every deal fresh in the archive).
  const { fresh, needsFetch } = reconcile(deals, archive);
  console.log(`self-check reconcile → fresh: ${fresh.size}, needsFetch: ${needsFetch.length}`);
  if (needsFetch.length > 0) {
    console.error(`INCOMPLETE: ${needsFetch.length} deals not covered by rebuilt archive:`);
    needsFetch.forEach((d) => console.error(`  ${d.genesis} ${d.cid}`));
    process.exit(1);
  }

  const blob = serialize(archive);
  const cid = await ipfsHash(blob);
  const pointer = toHexString(cid);
  console.log(`\narchive blob: ${blob.length} bytes`);
  console.log(`new archive CID:    ${cid}`);
  console.log(`pointer value (EIP-1577): ${pointer}`);
  console.log(`→ setText(node, 'content_cache_${PUBLICATION}', '${pointer}')`);

  if (!PUSH) {
    console.log('\n(dry run — nothing uploaded. Use --push to upload + triple-pin.)');
    return;
  }

  // ── Push: transport-union Kubo add (writes require the gateway bearer token) ──
  const fd = new FormData();
  fd.append('file', blob);
  const kuboAuth = process.env.KUBO_TOKEN ? { Authorization: `Bearer ${process.env.KUBO_TOKEN}` } : {};
  const addRes = await fetch(`${GATEWAY}/api/v0/add`, {
    method: 'POST',
    headers: kuboAuth,
    body: fd,
  });
  if (!addRes.ok) throw new Error(`transport-union add failed: ${addRes.status} ${addRes.statusText}`);
  const addJson = await addRes.json();
  console.log(`\ntransport-union add → ${addJson.Hash}`);
  if (addJson.Hash !== cid) console.warn(`WARN: kubo CID ${addJson.Hash} != local ${cid}`);

  // Verify round-trip: cat it back + parse + reconcile.
  const catRes = await fetch(`${GATEWAY}/api/v0/cat?arg=${addJson.Hash}`, { method: 'POST' });
  const catText = await catRes.text();
  const { parseArchive } = await import('../../actions/src/libs/archive.factory');
  const parsed = parseArchive(catText);
  const rc = reconcile(deals, parsed);
  console.log(`round-trip verify → items ${Object.keys(parsed.items).length}, needsFetch ${rc.needsFetch.length}`);

  // ── Triple-pin: Pinata ──
  const pinataJwt = process.env.PINATA_JWT;
  if (pinataJwt) {
    const pfd = new FormData();
    pfd.append('file', new Blob([blob]), `${cid}.json`);
    pfd.append('pinataMetadata', JSON.stringify({ name: `archive-${PUBLICATION}-${cid.slice(0, 8)}` }));
    const pRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST', headers: { Authorization: `Bearer ${pinataJwt}` }, body: pfd,
    });
    const pBody = await pRes.text();
    if (pRes.ok) console.log(`pinata pin → ${JSON.parse(pBody).IpfsHash}`);
    else console.warn(`pinata pin FAILED ${pRes.status}: ${pBody.slice(0, 200)}`);
  } else console.warn('PINATA_JWT unset — skipping pinata pin');

  // ── Triple-pin: Filebase (Kubo-compatible add with Bearer token) ──
  const filebaseToken = process.env.VITE_FILEBASE_TOKEN;
  if (filebaseToken) {
    const ffd = new FormData();
    ffd.append('file', new Blob([blob]), `${cid}.json`);
    const fRes = await fetch('https://rpc.filebase.io/api/v0/add', {
      method: 'POST', headers: { Authorization: `Bearer ${filebaseToken}` }, body: ffd,
    });
    const fBody = await fRes.text();
    if (fRes.ok) console.log(`filebase add → ${JSON.parse(fBody).Hash}`);
    else console.warn(`filebase add FAILED ${fRes.status}: ${fBody.slice(0, 200)}`);
  } else console.warn('VITE_FILEBASE_TOKEN unset — skipping filebase pin');

  console.log(`\nFINAL: archive CID ${addJson.Hash}  pointer ${toHexString(addJson.Hash)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
