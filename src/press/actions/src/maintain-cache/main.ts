/// <reference path="../action_globals.ts" />

import {
  ActionResult,
  MaintainCacheInput,
  MaintainCacheData,
} from '@s2s/soul2soul-shared/lit-actions';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { evmRead, evmWrite, toHexString } from '../libs/evm';
import { getProtocolInfo } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { catFile, uploadFile, decodeArchiveCid } from '../libs/ipfs.factory';
import { getDeals, type Entry } from '../libs/module.factory';
import { parseArchive, reconcile, mergeArchive, serialize } from '../libs/archive.factory';
import { judgeRefetchedItem, type ItemIssueCode } from '../libs/item-integrity';
import { canPublish, extractSignerAddress } from '../libs/gates';
import { requireFields, setRpcAuth } from '../libs/helpers';

const ACTION = 'maintain-cache';

// ENS records contract ABI (getText/setText) — local mirror of update/main.ts
// and render/main.ts. Used to read + write the per-publication content archive
// pointer (`content_cache_<publication>` text record on the publication node).
const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
];

/**
 * Parallel per-publication cache maintenance action.
 *
 * WHY THIS ACTION EXISTS (see the render-maintainer saga in the repo docs):
 * the render action's inline write-back (writeBackArchiveCache in render/main.ts)
 * runs at the dead tail of an ~8s, ~40-request render, issuing a fresh
 * StaticJsonRpcProvider's FIRST call (getTransactionCount) at the worst possible
 * moment — after the render has already hammered the same RPC endpoint with many
 * reads — which fails in production with ethers SERVER_ERROR 'missing response'.
 * The update action's setText almost never fails because it runs EARLY in a
 * SHORT, QUIET session against a young provider.
 *
 * This action reproduces those reliable conditions on its own: it is a tiny,
 * dedicated action with its OWN 50-request budget and a fresh provider. Given a
 * publication it re-derives the archive state (getDeals + archive cat +
 * reconcile) — exactly like writeBackArchiveCache — and writes the pointer
 * (confirm:true, mirrored from update). It is fired by the orchestrator after a
 * successful render whose envelope flagged pending cache drift, so the pointer's
 * setText gets a clean, quiet session rather than the render's tail.
 *
 * Idempotent by construction: if the render's inline write-back already landed,
 * the reconcile here sees the pointer already holds every deal → needsFetch is
 * empty → steady state, zero writes. If the inline write-back failed (or the
 * pointer was never bootstrapped), reconcile on the empty/absent pointer marks
 * everything MISS → this action seeds/publishes it.
 *
 * GATED like update (canPublish) so an unauthorized caller cannot force a
 * pointer write — it is the same signature/auth envelope the orchestrator used
 * for the render.
 */
async function main(input: MaintainCacheInput): Promise<ActionResult<MaintainCacheData>> {
  let trace: any[] = [];

  try {
    requireFields(input, ['publication', 'signature', 'authorSafeAddress', 'endpoints']);
    const { publication, signature, authorSafeAddress, preview, endpoints } = input;
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

    const { publicationModule } = await getDomainOwnerAndModules(publication, rpcs);
    if (!publicationModule) throw 'missing publication module';

    // Same authorization gate as the update action — only a legitimate author
    // (per canPublish) may write the publication's cache pointer.
    if (!preview) {
      if (!(await canPublish(authorSafeAddress, publicationModule, signerAddress, rpcs?.L2))) {
        throw 'cannot publish';
      }
    }

    const protocolInfo = await getProtocolInfo(false, rpcs);
    if (!protocolInfo?.pkp || !protocolInfo?.ensRecords) {
      throw 'Failed to fetch protocol info';
    }

    const node = ethers.utils.namehash(publication);
    const cacheKey = `content_cache_${publication}`;

    // Read the current archive pointer. EMPTY ⇒ never bootstrapped ⇒ treat the
    // current archive as `null` (mergeArchive/reconcile both accept that).
    let archiveCid = '';
    try {
      archiveCid = await evmRead(
        'L2',
        protocolInfo.ensRecords,
        RECORDS_CONTRACT_ABI,
        'getText',
        [node, cacheKey],
        rpcs?.L2,
      );
      // Pointer is an EIP-1577 ipfs-ns contenthash envelope (0xe3...), not a
      // raw CID. Decode back to a CID for catFile below; a decode failure
      // collapses to '' → archive stays null (no-archive), never a garbage CID.
      archiveCid = decodeArchiveCid(archiveCid);
    } catch (e) {
      console.log(
        `[maintain-cache] pointer read failed, treating as empty: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    trace.push({ cache: 'pointer', publication, archiveCid: archiveCid || '(empty)' });

    // Re-derive the drift: freshness oracle (getDeals) + archive cat + reconcile.
    const deals: Entry[] = await getDeals(publicationModule, rpcs?.L2);
    const archive = archiveCid ? parseArchive(await catFile(gateway!, archiveCid)) : null;
    const { needsFetch, integrityIssues } = reconcile(deals, archive);
    trace.push({
      cache: 'reconcile',
      deals: deals.length,
      needsFetch: needsFetch.length,
      integrityIssues: integrityIssues.length,
      integrityCodes: [...new Set(integrityIssues.map((i) => i.code))],
      archive: archiveCid ? 'present' : '(null seed)',
    });

    // Steady state: pointer already holds every deal → zero writes.
    if (needsFetch.length === 0) {
      trace.push({
        cache: 'writeback',
        stage: 'steady-state',
        skipped: true,
        reason: 'no drift to merge',
      });
      return {
        ok: true,
        action: ACTION,
        data: { cid: '', wrote: false },
        trace,
      };
    }

    // Fetch the FULL canonical items for the drift entries (cat each cid) and
    // merge them into the archive — same as writeBackArchiveCache.
    //
    // ONE POLICY, SHARED WITH THE RENDER: every refetched item goes through
    // judgeRefetchedItem() (shape → author binding → plaintextHash → objectId →
    // proof signer), the same verdict the render read path applies before it
    // serves an item. A 'mismatch' is NEVER cached: caching it would both serve
    // it to readers later and, because a re-serialised archive gets a new CID,
    // turn every invocation into another pin + setText write for an item that
    // can never become valid (an unbounded write loop). Rejected items are
    // reported in the trace and left out of the next snapshot.
    const refreshed = new Map<string, S2SContentItem>();
    const rejected: { genesis: string; cid: string; code: ItemIssueCode; reason: string }[] = [];
    await Promise.all(
      needsFetch.map(async (entry) => {
        let item: unknown;
        try {
          item = JSON.parse(await catFile(gateway!, entry.cid));
        } catch (e) {
          console.warn(
            `[maintain-cache] drift fetch failed for ${entry.genesis} (${entry.cid}):`,
            e,
          );
          return;
        }
        const verdict = judgeRefetchedItem(item, entry.author, entry.genesis, entry.cid);
        if (!verdict.usable) {
          console.warn(
            `[maintain-cache] refusing to cache ${entry.genesis} (${entry.cid}): ${verdict.integrity.code}`,
            verdict.integrity.reason,
          );
          rejected.push({
            genesis: entry.genesis,
            cid: entry.cid,
            code: verdict.integrity.code,
            reason: verdict.integrity.reason,
          });
          return;
        }
        refreshed.set(entry.genesis, item as S2SContentItem);
      }),
    );

    if (rejected.length > 0) {
      trace.push({ cache: 'writeback', stage: 'integrity', rejected });
    }

    // Nothing fetchable/acceptable and nothing already present ⇒ nothing to
    // merge/write. This is also what bounds the write loop: a corrupt item (in
    // the archive or at its deal cid) is rejected every time and never causes a
    // new pin/setText, so a bad publication reaches steady state instead of
    // rewriting forever.
    if (refreshed.size === 0) {
      trace.push({
        cache: 'writeback',
        stage: 'merge',
        skipped: true,
        reason:
          rejected.length > 0
            ? 'no acceptable drift (all refetched items rejected)'
            : 'no fetchable drift',
        refreshedSize: 0,
        rejected: rejected.length,
      });
      return { ok: true, action: ACTION, data: { cid: '', wrote: false }, trace };
    }

    // SELF-HEAL: evict every carried-forward genesis reconcile just flagged, so
    // the new snapshot stops re-reporting the same tampering. A genesis that
    // refetched cleanly is already in `refreshed` and is re-added by
    // mergeArchive, so this only removes entries that are still bad.
    const flagged = new Set(integrityIssues.map((i) => i.genesis));
    const next = mergeArchive(archive, deals, refreshed, flagged);
    trace.push({
      cache: 'writeback',
      stage: 'self-heal',
      evicted: [...flagged].filter((g) => !refreshed.has(g)),
      keptOnlyDeal: deals.length <= 1 && flagged.size > 0,
    });
    const newCid = await uploadFile(gateway!, serialize(next));
    trace.push({ cache: 'writeback', stage: 'pin', newCid });

    // RELIABLE pointer write: confirm:true → await the mined receipt and detect
    // status === 0 (revert). Mirrors update/main.ts's contenthash_wrapped write
    // (the one that is provably reliable in production). A failed/reverted write
    // here FAILS LOUDLY (ok:false) so the orchestrator logs it — never a silently
    // dropped pointer.
    const result = await evmWrite(
      'L2',
      protocolInfo.pkp,
      protocolInfo.ensRecords,
      RECORDS_CONTRACT_ABI,
      'setText',
      [node, cacheKey, toHexString(newCid)],
      true,
      rpcs?.L2?.[0],
    );
    trace.push({
      cache: 'writeback',
      stage: 'setText',
      key: cacheKey,
      success: result?.success,
      hash: result?.hash,
      error: result?.error,
    });
    trace.push(JSON.stringify(result));

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
      data: { cid: newCid, wrote: true },
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
