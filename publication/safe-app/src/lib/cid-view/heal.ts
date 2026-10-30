// src/lib/cid-view/heal.ts — safe-app heal adapter for the shared heal primitive.
//
// Builds the concrete `HealConfig` for the Storage CID inventory's "heart heal"
// (pin a missing/under-replicated CID to kubo/pinata/filebase + commit 2x
// filecoin copies) and re-exports the shared heal API so components import
// healing ONLY from this module (`@/lib/cid-view/heal.js`).
//
// The filecoin uploader (`healToFilecoin`) fetches the CID's CAR from the
// remote kubo source (dag/export) and commits it via FilecoinStorage.uploadTree
// — which already retries provider pairs until >=2 copies are committed (the
// "2x filecoin" guarantee). Fail-open by design: a fetch/upload failure returns
// `{ copyCount: 0 }` instead of throwing, so the shared healCid records it as a
// per-provider failure rather than aborting the whole heal.
import { IPFS_URL } from '../ipfs-fs.factory.js';
import type { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import type { HealConfig } from '@s2s/soul2soul-shared/safe-app';

/** Result shape the shared HealFilecoinUploader contract expects. */
export interface HealFilecoinUploadResult {
  pieceCid?: string;
  copyCount: number;
  copies?: Array<{ provider: string; dealId?: string }>;
}

/**
 * Fetch a CID's CAR from the remote kubo source and commit it to filecoin
 * (2 copies via uploadTree). Never throws: a fetch/upload failure returns
 * `{ copyCount: 0, pieceCid: '' }` so the shared heal turns it into a
 * per-provider failure.
 */
export async function healToFilecoin(
  cid: string,
  source: string,
  storage: FilecoinStorage,
): Promise<HealFilecoinUploadResult> {
  const kuboToken = import.meta.env.VITE_KUBO_TOKEN || '';
  const headers: Record<string, string> = {};
  if (kuboToken) headers.Authorization = `Bearer ${kuboToken}`;
  try {
    const response = await fetch(`${source}/api/v0/dag/export?arg=${encodeURIComponent(cid)}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      console.warn(`[cid-view] heal filecoin: dag/export failed (${String(response.status)})`);
      return { copyCount: 0, pieceCid: '' };
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const result = await storage.uploadTree(bytes, [], 'heal');
    return { pieceCid: result.pieceCid, copyCount: result.copyCount, copies: result.copies };
  } catch (err) {
    console.warn(
      '[cid-view] heal filecoin: upload failed',
      err instanceof Error ? err.message : String(err),
    );
    return { copyCount: 0, pieceCid: '' };
  }
}

/** Build the heal config once per FilecoinStorage instance (see s2s-storage-tab). */
export function buildHealConfig(storage: FilecoinStorage): HealConfig {
  return {
    source: IPFS_URL,
    pinataJwt: import.meta.env.VITE_PINATA_JWT || '',
    filebaseToken: import.meta.env.VITE_FILEBASE_TOKEN || '',
    kuboToken: import.meta.env.VITE_KUBO_TOKEN || '',
    filecoin: (cid, source) => healToFilecoin(cid, source, storage),
  };
}

// Re-export the shared heal API so the section imports healing ONLY from here.
export {
  healCid,
  HEAL_PROVIDERS,
  type HealConfig,
  type HealOutcome,
  type HealProvider,
} from '@s2s/soul2soul-shared/safe-app';
