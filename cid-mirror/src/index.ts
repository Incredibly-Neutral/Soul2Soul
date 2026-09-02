/**
 * cid-mirror — content-addressed → location-addressed static site mirror.
 *
 * Entry point: loads config, resolves the publication URL to a root CID,
 * initializes the mirror engine, starts the API server, and optionally
 * sets up auto-refresh.
 */

import express from 'express';
import { loadConfig } from './config.js';
import { extractEnsName, isBareCID, isEnsName, resolveEnsToCID } from './ens.js';
import { KuboClient } from './ipfs/kubo.js';
import { Mirror } from './mirror.js';
import { createApi } from './api/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Parse the publication URL
  const name = extractEnsName(cfg.publicationUrl);
  console.log(`[cid-mirror] Publication: ${name}`);

  // Initialize kubo client
  const kubo = new KuboClient(cfg.ipfsApiUrl, cfg.ipfsApiAuth);

  // Initialize mirror engine
  const mirror = new Mirror(kubo, 'webcontent', cfg.publicationUrl, cfg.l1RpcUrl);

  // Resolve root CID
  let rootCid: string | null = null;

  if (isBareCID(name)) {
    rootCid = name;
    console.log(`[cid-mirror] Using bare CID: ${rootCid}`);
  } else if (isEnsName(name)) {
    console.log(`[cid-mirror] Resolving ENS name: ${name}`);
    // Canonical s2s mechanism: namehash -> getText('contenthash_wrapped') on
    // the Base-L2 (8453) ensRecords records contract. L1 is used only for the
    // controller discovery leg; the CID itself is read on L2.
    rootCid = await resolveEnsToCID(name, cfg.l1RpcUrl, cfg.l2RpcUrl, cfg.recordsContract);
    if (!rootCid) {
      console.error('[cid-mirror] Failed to resolve ENS name to CID. Service will start but refresh will fail until a CID is resolved.');
    } else {
      console.log(`[cid-mirror] Resolved root CID: ${rootCid}`);
    }
  } else {
    // Assume it's a CID or other direct identifier
    rootCid = name;
    console.log(`[cid-mirror] Using direct identifier as CID: ${rootCid}`);
  }

  // Set root CID on mirror state
  if (rootCid) {
    // Perform initial mirror
    try {
      console.log('[cid-mirror] Performing initial mirror...');
      const result = await mirror.refresh(rootCid);
      console.log(`[cid-mirror] Initial mirror complete: ${result.files} files, ${result.durationMs}ms`);
    } catch (err) {
      console.error('[cid-mirror] Initial mirror failed:', err);
    }
  }

  // Create and start API server
  const app = express();
  app.use(express.json());

  const api = createApi(mirror);
  app.use('/api', api);

  // The healthz endpoint is also served from the API router under /api/healthz,
  // but we add it at root level too for standard health checks
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.listen(cfg.port, () => {
    console.log(`[cid-mirror] API server listening on port ${cfg.port}`);
  });

  // Optional auto-refresh — always re-resolves ENS if applicable
  if (cfg.refreshIntervalMs && rootCid) {
    console.log(`[cid-mirror] Auto-refresh every ${cfg.refreshIntervalMs}ms`);
    setInterval(async () => {
      console.log('[cid-mirror] Auto-refresh triggered');
      try {
        const result = await mirror.refreshResolved();
        console.log(`[cid-mirror] Auto-refresh complete: ${result.files} files, ${result.durationMs}ms`);
      } catch (err) {
        console.error('[cid-mirror] Auto-refresh failed:', err);
      }
    }, cfg.refreshIntervalMs);
  }
}

main().catch((err) => {
  console.error('[cid-mirror] Fatal error:', err);
  process.exit(1);
});
