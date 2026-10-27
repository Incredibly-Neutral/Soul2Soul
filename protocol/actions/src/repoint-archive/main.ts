/// <reference path="../action_globals.ts" />

import {
  ActionResult,
  RepointArchiveInput,
  RepointArchiveData,
} from '@s2s/soul2soul-shared/lit-actions';
import { evmWrite, toHexString } from '../libs/evm';
import { getProtocolInfo } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { catFile } from '../libs/ipfs.factory';
import { getDeals } from '../libs/module.factory';
import { parseArchive, reconcile } from '../libs/archive.factory';
import { canReset, extractSignerAddress } from '../libs/gates';
import { requireFields, setRpcAuth } from '../libs/helpers';

const ACTION = 'repoint-archive';

// ENS records contract ABI (setText) — the PKP is the sole authorized caller
// (INV-10/INV-12); this action writes the per-publication cache pointer
// `content_cache_<publication>` exactly like maintain-cache, but to a caller
// PROVIDED archive CID instead of one it derives itself.
const RECORDS_CONTRACT_ABI = [
  'function setText(bytes32 node, string key, string value) nonpayable',
];

/**
 * Repoint-archive — one-shot cache-pointer repoint for a publication.
 *
 * WHY THIS ACTION EXISTS (recovery from the s3nl cache-loss incident): the
 * content archive cache blob behind `content_cache_<publication>` was GC'd and
 * its exact bytes are unreproducible (the archive's `built` timestamp is
 * non-deterministic), so the pointer must be repointed at a rebuilt archive.
 * maintain-cache cannot do it: at P=37 its in-action reseed (~58-60 requests)
 * exceeds Lit's 50-request session cap, and it has no input to accept a
 * prebuilt archive. This tiny action accepts the seed CID explicitly and
 * writes the pointer via the PKP — the only authorized writer.
 *
 * GATED STRICTER than maintain-cache: `canReset` — only an OWNER of the
 * PUBLICATION Safe may repoint the cache pointer (not merely an author Safe
 * owner). The cache is publication-scoped state; the publication Safe owns it.
 *
 * SEED VALIDATION before any write: the archive must cat cleanly, parse, and
 * reconcile to FULL coverage of every on-chain deal (needsFetch.length === 0),
 * else the write is refused. This is the in-action guard against pointing the
 * cache at a dead/partial/garbage archive — and against the fake-cache
 * injection class documented in brain/reviews/archive-cache-security-2026-10-06.md
 * (the off-chain rebuild additionally content-hash-verifies each item).
 *
 * Idempotent-ish: if the pointer already equals this CID, the write is a no-op
 * setText (same value) — still confirmed/reported as wrote:true.
 */
async function main(input: RepointArchiveInput): Promise<ActionResult<RepointArchiveData>> {
  let trace: any[] = [];

  try {
    requireFields(input, [
      'publication',
      'signature',
      'authorSafeAddress',
      'archiveCid',
      'endpoints',
    ]);
    const { publication, signature, preview, endpoints, archiveCid } = input;
    const gateway = endpoints.ipfsGateway;
    const rpcs = endpoints.rpcs;
    // Auth for Kubo RPC on the data gateway (token-gated writes; sent on reads too).
    setRpcAuth(endpoints.ipfsGatewayAuth);

    const signerAddress = extractSignerAddress(
      ethers.utils.hashMessage('lit actions auth'),
      signature,
    );
    trace.push(`signer: ${signerAddress}`);
    trace.push(`pub: ${publication}`);
    trace.push(`seed cid: ${archiveCid}`);

    const { publicationModule, multisig } = await getDomainOwnerAndModules(publication, rpcs);
    if (!publicationModule) throw 'missing publication module';

    // STRICT gate: publication Safe owner only (canReset), NOT canPublish.
    if (!preview) {
      if (!(await canReset(multisig, signerAddress, rpcs?.L2))) {
        throw 'not a publication owner';
      }
    }

    const protocolInfo = await getProtocolInfo(false, rpcs);
    if (!protocolInfo?.pkp || !protocolInfo?.ensRecords) {
      throw 'Failed to fetch protocol info';
    }

    const node = ethers.utils.namehash(publication);
    const cacheKey = `content_cache_${publication}`;

    // ── Seed validation (mandatory, before any write) ──
    // Cat the seed archive, parse it, and reconcile against the on-chain
    // freshness oracle. Refuse to write unless it covers EVERY deal — a
    // partial archive would silently regress the cache, and a garbage archive
    // is exactly the injection this gate exists to block.
    let deals: any[] = [];
    let needsFetch: any[] = [];
    let integrityIssues: { genesis: string; code: string; reason: string }[] = [];
    try {
      const archive = parseArchive(await catFile(gateway!, archiveCid));
      deals = await getDeals(publicationModule, rpcs?.L2);
      const rc = reconcile(deals, archive);
      needsFetch = rc.needsFetch;
      // A seed archive containing a forged/tampered entry is REJECTED as a
      // distinct failure from "incomplete": the two need different operator
      // responses (rebuild the archive vs find the forger), and reporting an
      // integrity rejection as "N/M deals uncovered" misdiagnoses it.
      integrityIssues = rc.integrityIssues;
    } catch (e) {
      throw `seed archive rejected (cat/parse/reconcile failed): ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
    trace.push({
      stage: 'seed-validate',
      deals: deals.length,
      needsFetch: needsFetch.length,
      integrityIssues: integrityIssues.length,
      integrityCodes: [...new Set(integrityIssues.map((i) => i.code))],
    });
    if (integrityIssues.length > 0) {
      throw `seed archive REJECTED: ${integrityIssues.length} item(s) failed integrity (${[
        ...new Set(integrityIssues.map((i) => i.code)),
      ].join(', ')}) — refusing to point at a tampered archive: ${integrityIssues
        .map((i) => i.genesis)
        .join(', ')}`;
    }
    if (needsFetch.length > 0) {
      throw `seed archive INCOMPLETE: ${needsFetch.length}/${deals.length} deals uncovered — refusing to write`;
    }

    // ── Pointer write via the PKP ──
    // confirm:true → await the mined receipt and detect status === 0 (revert),
    // mirroring the maintain-cache/update write path. Fail loudly on revert.
    const result = await evmWrite(
      'L2',
      protocolInfo.pkp,
      protocolInfo.ensRecords,
      RECORDS_CONTRACT_ABI,
      'setText',
      [node, cacheKey, toHexString(archiveCid)],
      true,
      rpcs?.L2?.[0],
    );
    trace.push({
      stage: 'setText',
      key: cacheKey,
      success: result?.success,
      hash: result?.hash,
      error: result?.error,
    });

    if (!result?.success) {
      return {
        ok: false,
        action: ACTION,
        error:
          `${cacheKey} pointer write failed: ${result?.error ?? 'unknown error'}` +
          (result?.hash ? ` (hash ${result.hash})` : ''),
        trace,
      };
    }

    return {
      ok: true,
      action: ACTION,
      data: { cid: archiveCid, wrote: true },
      trace,
    };
  } catch (e) {
    return {
      ok: false,
      action: ACTION,
      error: typeof e === 'string' ? e : ((e as Error)?.message ?? String(e)),
      trace,
    };
  }
}

export { main };
