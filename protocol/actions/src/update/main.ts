/// <reference path="../action_globals.ts" />

import { ActionResult, EvmUpdateData, EvmUpdateInput } from '@s2s/soul2soul-shared/lit-actions';
import { evmRead, evmWrite, toHexString } from '../libs/evm';
import { getProtocolInfo } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { contenthashToIPFS } from '../libs/ipfs.factory';
import { fetchWithTimeout, requireFields, setRpcAuth } from '../libs/helpers';
import { canPublish, canReset, extractSignerAddress } from '../libs/gates';
import { getConfig } from '../render/config.ctrl';
import {
  verifyProvenance,
  sanitizeRemovePath,
  verifyRevocable,
  verifyPathAvailable,
  type PageIdentity,
} from './verify';

const ACTION = 'evm-update';

const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
  'function batchSetRecords(bytes32[] nodes, address[] addrs, string[][] keys, string[][] values) nonpayable',
];

// ZERO address for batchSetRecords' `addrs` array — we only set text records
// (the C3 contract skips the address write when addrs[i] == address(0)).
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Reserved auxiliary record key on the canonical publication node that tracks
// the currently-written alias NAMES (JSON array). It is NOT part of resolution
// (the resolver reads `contenthash_wrapped`); it only lets the next update
// clear aliases that have been removed from the list. The canonical node is
// never cleared by this mechanism.
const ALIASES_TRACKING_KEY = 'aliases';

/** Dedupe preserving first-seen order. */
const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * Resolve the ENS write-target node list from the publication config.
 *
 *   * `config.aliases` (non-empty array) → ADDITIVE: [namehash(publication),
 *     ...aliases.map(namehash)] — the canonical publication node is ALWAYS
 *     written; aliases are extra doors to the same contenthash.
 *   * `config.domain` only (legacy field, backward compatible) → SWAP:
 *     [namehash(domain)] — identical to the pre-aliases behaviour (single
 *     write at namehash(domain), canonical node untouched).
 *   * neither → [namehash(publication)] — the default subdomain target.
 */
function resolveWriteTargets(
  config: { domain?: string; aliases?: string[] } | null | undefined,
  publication: string,
): { nodes: string[]; isLegacyDomain: boolean } {
  const aliases =
    Array.isArray(config?.aliases) && (config!.aliases as string[]).length > 0
      ? (config!.aliases as string[]).filter((a) => typeof a === 'string' && a.trim() !== '')
      : undefined;
  if (aliases && aliases.length > 0) {
    return {
      nodes: dedupe([publication, ...aliases]).map((n) => ethers.utils.namehash(n)),
      isLegacyDomain: false,
    };
  }
  if (config && config.domain) {
    return { nodes: [ethers.utils.namehash(config.domain)], isLegacyDomain: true };
  }
  return { nodes: [ethers.utils.namehash(publication)], isLegacyDomain: false };
}

// MFS ops that move content INTO the remote data_gateway Kubo node (cp-root
// copies the whole previous tree; per-file/assets cp and pin-add fetch and
// persist blocks) legitimately take far longer than metadata ops against a
// remote node. 10s was aborting deterministic cp-root runs with a bare
// AbortError; 60s is the realistic bound for a remote gateway.
const TIMEOUTS = {
  mkdir: 5_000,
  cpRoot: 60_000,
  cpFile: 60_000,
  stat: 5_000,
  rm: 5_000,
  pinAdd: 60_000,
  pinLs: 5_000,
};

async function main(input: EvmUpdateInput): Promise<ActionResult<EvmUpdateData>> {
  let trace: any[] = [];

  try {
    requireFields(input, ['publication', 'jobs', 'signature', 'authorSafeAddress', 'endpoints']);
    // A revoke with no matching ripple produces jobs.length === 0 but still
    // carries a `remove` entry (the revoked path) that must be processed — do
    // NOT treat "no jobs" as "nothing to do". Only reject when there is neither
    // a job nor a remove entry nor a reset flag (nothing meaningful to write).
    const hasRemove = input.remove && input.remove.length > 0;
    if (!Array.isArray(input.jobs) || (input.jobs.length === 0 && !hasRemove && !input.reset))
      throw 'jobs must be a non-empty array when no remove entries or reset are provided';
    const { publication, jobs, signature, authorSafeAddress, preview, endpoints, remove, reset } =
      input;
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
    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(
      publication,
      rpcs,
    );
    if (!multisig || !configModule || !publicationModule) {
      throw 'missing config modules';
    }

    trace.push(
      `owner: ${multisig}, configModule ${configModule}, publicationModule ${publicationModule}`,
    );

    // A reset is publication-owner gated (stricter than canPublish): the signer
    // must be an owner of the publication Safe (`multisig`), not merely an owner
    // of a whitelisted author Safe. Normal publishes keep canPublish unchanged.
    if (reset) {
      if (!(await canReset(multisig, signerAddress, rpcs?.L2))) {
        throw 'reset requires publication owner';
      }
    } else if (!(await canPublish(authorSafeAddress, publicationModule, signerAddress, rpcs?.L2))) {
      throw 'cannot publish';
    }

    const protocolInfo = await getProtocolInfo(false, rpcs);
    if (!protocolInfo?.pkp) {
      throw 'Failed to fetch protocol info';
    }
    trace.push(`pinfo: ${protocolInfo}`);

    const config = await getConfig(undefined, configModule, rpcs?.L2, gateway);
    trace.push(`config: ${config}`);

    // The WRITE nodes may differ from the publication identity: the config can
    // set either a legacy `domain` (single write-node override, backward
    // compatible) or a list of `aliases` (ADDITIVE — the canonical publication
    // node plus each alias). Only the write targets change here —
    // ownership/discovery (getDomainOwnerAndModules(publication),
    // canPublish/canReset) stays keyed on the original `publication` identity,
    // not the configured domain/aliases.
    const { nodes, isLegacyDomain } = resolveWriteTargets(config, publication);
    const canonicalNode = ethers.utils.namehash(publication);
    trace.push(`nodes: ${JSON.stringify(nodes)}`);

    // The primary node drives the previous-tree copy decision below. In the
    // additive/default paths this is the canonical publication node; in the
    // legacy `domain` path it is namehash(domain) — matching today's behaviour.
    const node = nodes[0];

    // Read previous contenthash_wrapped on-chain (primary node)
    const prevEncoded = await evmRead(
      'L2',
      protocolInfo.ensRecords,
      RECORDS_CONTRACT_ABI,
      'getText',
      [node, 'contenthash_wrapped'],
      rpcs?.L2,
    );
    trace.push(`prev: ${prevEncoded}`);

    // Read the previously-tracked alias names (auxiliary 'aliases' record on
    // the canonical publication node, JSON array) so a removed alias can be
    // cleared on the next update. Never throws — a missing/unparseable record
    // simply means there is nothing tracked yet (first run after upgrade).
    let prevAliases: string[] = [];
    try {
      const prevAliasJson = await evmRead(
        'L2',
        protocolInfo.ensRecords,
        RECORDS_CONTRACT_ABI,
        'getText',
        [canonicalNode, ALIASES_TRACKING_KEY],
        rpcs?.L2,
      );
      const parsed = typeof prevAliasJson === 'string' ? JSON.parse(prevAliasJson) : null;
      if (Array.isArray(parsed)) {
        prevAliases = parsed.filter((a: unknown) => typeof a === 'string');
      }
    } catch {}

    const mfsPath = `/temp-${Date.now()}`;

    let newRootCid: string;

    // A reset forces the fresh `mkdir` branch even when a previous root exists:
    // the old (confused) tree is never copied, so every page dir AND root
    // index.html vanish; assets are still re-copied below; the root is rewritten.
    if (prevEncoded && prevEncoded.length > 0 && !reset) {
      const prevCid = contenthashToIPFS(prevEncoded);
      trace.push(`cp root ${prevCid} → ${mfsPath}`);

      await fetchWithTimeout(
        `${gateway}/api/v0/files/cp?arg=/ipfs/${prevCid}&arg=${encodeURIComponent(mfsPath)}&parents=true`,
        { method: 'POST' },
        TIMEOUTS.cpRoot,
      );
    } else {
      trace.push(`mkdir ${mfsPath}`);
      await fetchWithTimeout(
        `${gateway}/api/v0/files/mkdir?arg=${encodeURIComponent(mfsPath)}&parents=true`,
        { method: 'POST' },
        TIMEOUTS.mkdir,
      );
    }

    // Log what jobs we received
    console.log(
      `[update] jobs: ${JSON.stringify(jobs.map((j: any) => ({ id: j.id?.slice(0, 12), path: j.path, html: j.html?.slice(0, 12) })))}`,
    );

    // Copy delta jobs in parallel — blocks already on the kubo node
    trace.push(`cp ${jobs.length} files`);
    await Promise.all(
      (jobs as any[]).map(async (job) => {
        const filePath = job.path === 'index.html' ? 'index.html' : `${job.path}/index.html`;
        const destPath = `${mfsPath}/${filePath}`;
        const sourceCid = job.html;

        // Provenance verification gate — reject unverified content.
        // The gate RETURNS the page's self-description (identifier, claimed
        // author, canonicalisation, claimed body digest) so the tree rules below
        // can tell a content-bound JCS page from a legacy one whose signature
        // covers only a document skeleton.
        let incomingPageIdentity: PageIdentity | null = null;
        if (!preview) {
          try {
            incomingPageIdentity = await verifyProvenance(
              sourceCid,
              job.id,
              protocolInfo.pkp!,
              gateway!,
              trace,
            );
          } catch (e) {
            throw `Rejected ${job.path}: provenance verify failed — ${typeof e === 'string' ? e : String(e)}`;
          }
        }

        // Check if dest entry already exists (from previous run's root copy)
        // Kubo files/cp does NOT overwrite — must rm first
        let prevHash: string = '';
        try {
          const statRes = await fetchWithTimeout(
            `${gateway}/api/v0/files/stat?arg=${encodeURIComponent(destPath)}`,
            { method: 'POST' },
            TIMEOUTS.stat,
          );
          try {
            prevHash = (await statRes.json()).Hash || '';
          } catch {}
        } catch {}

        // Fast path: skip if dest already matches source
        if (prevHash && prevHash === sourceCid) {
          trace.push(`skip (unchanged): ${filePath}`);
          return;
        }

        // Path gate — ALWAYS, not only when something is already there: a
        // legacy-signed page must not be introduced onto a free path either
        // (its signature does not bind the body it publishes). See
        // verifyPathAvailable for the three rules.
        if (!preview) {
          await verifyPathAvailable(
            gateway!,
            destPath,
            job.id,
            publicationModule,
            rpcs?.L2,
            incomingPageIdentity,
          );
        }

        // Remove existing entry so cp can overwrite
        if (prevHash) {
          await fetchWithTimeout(
            `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(destPath)}`,
            { method: 'POST' },
            TIMEOUTS.rm,
          ).catch((e) => trace.push(`warn: rm failed ${filePath}: ${String(e)}`));
        }

        // Now cp works cleanly
        const url =
          `${gateway}/api/v0/files/cp?` +
          `arg=/ipfs/${encodeURIComponent(sourceCid)}` +
          `&arg=${encodeURIComponent(destPath)}` +
          `&parents=true&flush=false`;
        const res = await fetchWithTimeout(url, { method: 'POST' }, TIMEOUTS.cpFile);
        if (!res.ok) {
          const text = await res.text();
          throw `Failed to cp ${job.path}: ${text}`;
        }
        trace.push(`✓ ${filePath} (${sourceCid.slice(0, 9)})`);
      }),
    );

    // Remove explicitly listed paths (slug changes, revoked posts)
    if (remove && remove.length > 0) {
      trace.push(`rm ${remove.length} paths`);
      // Build a set of job genesis ids for the replacedBy check
      const jobGenesisSet = new Set((jobs as any[]).map((j: any) => j.id).filter(Boolean));
      await Promise.all(
        (remove as any[]).map(async (entry: { path: string; replacedBy?: string }) => {
          let cleanPath: string;
          try {
            cleanPath = sanitizeRemovePath(entry.path);
          } catch (e) {
            trace.push(`skip remove ${entry.path}: ${typeof e === 'string' ? e : String(e)}`);
            return;
          }

          // Validate: replacedBy must match a genesis in the incoming job set
          if (entry.replacedBy && !jobGenesisSet.has(entry.replacedBy)) {
            trace.push(
              `skip remove ${entry.path}: replacedBy genesis ${entry.replacedBy?.slice(0, 12)}… not in job set`,
            );
            return;
          }

          // Revoke (no replacedBy): verify no active deal before removing
          if (!entry.replacedBy && !preview) {
            try {
              await verifyRevocable(gateway!, mfsPath, cleanPath, publicationModule, rpcs?.L2);
            } catch (e) {
              trace.push(`skip remove ${entry.path}: ${typeof e === 'string' ? e : String(e)}`);
              return;
            }
          }

          const rmPath = `${mfsPath}/${cleanPath}`;
          await fetchWithTimeout(
            `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(rmPath)}&recursive=true`,
            { method: 'POST' },
            TIMEOUTS.rm,
          ).catch((e) => trace.push(`warn: rm failed ${entry.path}: ${String(e)}`));
          trace.push(`removed: ${entry.path}`);
        }),
      );
    }

    // Copy assets into /assets
    if (config.assetsCid) {
      const assetsDestPath = `${mfsPath}/assets`;
      trace.push(`cp assets ${config.assetsCid} → ${assetsDestPath}`);

      // Remove existing /assets if present
      try {
        await fetchWithTimeout(
          `${gateway}/api/v0/files/stat?arg=${encodeURIComponent(assetsDestPath)}`,
          { method: 'POST' },
          TIMEOUTS.stat,
        );
        await fetchWithTimeout(
          `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(assetsDestPath)}&recursive=true`,
          { method: 'POST' },
          TIMEOUTS.rm,
        ).catch((e) => trace.push(`warn: rm assets failed: ${String(e)}`));
      } catch {}
      const assetsUrl =
        `${gateway}/api/v0/files/cp?` +
        `arg=/ipfs/${encodeURIComponent(config.assetsCid)}` +
        `&arg=${encodeURIComponent(assetsDestPath)}` +
        `&parents=true&flush=false`;
      const assetsRes = await fetchWithTimeout(assetsUrl, { method: 'POST' }, TIMEOUTS.cpFile);
      if (!assetsRes.ok) {
        const text = await assetsRes.text();
        throw `Failed to cp assets: ${text}`;
      }
      trace.push(`✓ assets (${config.assetsCid.slice(0, 9)})`);
    }

    // Log the MFS tree structure for debugging
    try {
      const lsRes = await fetchWithTimeout(
        `${gateway}/api/v0/files/ls?arg=${encodeURIComponent(mfsPath)}&long=true`,
        { method: 'POST' },
        TIMEOUTS.stat,
      );
      const lsData = await lsRes.json();
      console.log(
        `[update] MFS tree at ${mfsPath}: ${JSON.stringify(lsData.Entries?.map((e: any) => ({ name: e.Name, type: e.Type, size: e.Size })) || [])}`,
      );
    } catch (e: any) {
      console.log(`[update] MFS ls failed: ${String(e)}`);
    }

    // Wrap in try/finally so temp always cleans up (even on evmWrite failure)
    newRootCid = '';

    try {
      // New root CID
      const statRes = await fetchWithTimeout(
        `${gateway}/api/v0/files/stat?arg=${encodeURIComponent(mfsPath)}`,
        { method: 'POST' },
        TIMEOUTS.stat,
      );
      newRootCid = (await statRes.json()).Hash;
      trace.push(`root: ${newRootCid}`);

      await fetchWithTimeout(
        `${gateway}/api/v0/pin/add?arg=${newRootCid}`,
        { method: 'POST' },
        TIMEOUTS.pinAdd,
      );

      if (!preview) {
        const encoded = toHexString(newRootCid);
        trace.push(`writing ${encoded} to ${nodes.length} node(s)`);

        // The current alias NAMES (canonical publication name excluded) —
        // persisted to the canonical node's auxiliary 'aliases' record so the
        // next update can clear aliases removed from the list. The legacy
        // `domain` path tracks nothing (keeps today's single-node behaviour).
        const newAliases = isLegacyDomain ? [] : (config?.aliases ?? []);

        // Clear-on-removal: any alias that was previously written but is no
        // longer in the new list gets an EMPTY contenthash_wrapped so it stops
        // resolving instead of going stale (C3 has no delete — an empty value
        // is what getText returns for an unset record). The canonical
        // publication node is NEVER cleared by this mechanism.
        const clearNodes = dedupe(
          prevAliases.filter((a) => !newAliases.includes(a)).map((a) => ethers.utils.namehash(a)),
        ).filter((n) => n !== canonicalNode);
        if (clearNodes.length > 0) {
          trace.push(`clearing ${clearNodes.length} removed alias node(s)`);
        }

        // ONE atomic batchSetRecords tx: contenthash on every write node, '' on
        // every removed-alias node, plus the alias-tracking record on the
        // canonical node. Single tx → single nonce → no parallel evmWrite race
        // (libs/evm.ts nonce race + silent-success footgun is avoided by never
        // issuing parallel writes from the same PKP).
        const allNodes = dedupe([...nodes, ...clearNodes]);
        const addrs = allNodes.map(() => ZERO_ADDRESS);
        const keys = allNodes.map(() => ['contenthash_wrapped'] as string[]);
        const values = allNodes.map((n) =>
          clearNodes.includes(n) ? ([''] as string[]) : ([encoded] as string[]),
        );

        // Persist the current alias list on the canonical node (only when it is
        // a write target — the legacy `domain` path keeps today's single write).
        const canonicalIdx = allNodes.indexOf(canonicalNode);
        if (canonicalIdx !== -1) {
          keys[canonicalIdx] = ['contenthash_wrapped', ALIASES_TRACKING_KEY];
          values[canonicalIdx] = [encoded, JSON.stringify(newAliases)];
        }

        const result = await evmWrite(
          'L2',
          protocolInfo.pkp,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'batchSetRecords',
          [allNodes, addrs, keys, values],
          true,
          rpcs?.L2?.[0],
        );
        trace.push(JSON.stringify(result));
        // The on-chain write is the whole point of this action — a failed or
        // reverted contenthash_wrapped write must NEVER be reported as success
        // (the app would show the fresh root while the on-chain record is
        // unchanged). Fail loudly for ALL update writes (normal publishes and
        // reset) so the caller can surface the real cause.
        if (!result?.success) {
          return {
            ok: false,
            action: ACTION,
            error: 'contenthash_wrapped write failed: ' + (result?.error ?? 'unknown error'),
            trace,
          };
        }
      }

      return { ok: true, action: ACTION, data: { cid: newRootCid, trace }, trace };
    } finally {
      // Always clean up temp MFS path
      await fetchWithTimeout(
        `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(mfsPath)}&recursive=true`,
        { method: 'POST' },
        TIMEOUTS.rm,
      ).catch(() => trace.push(`warn: cleanup failed`));
    }
  } catch (e) {
    return { ok: false, action: ACTION, error: typeof e === 'string' ? e : String(e), trace };
  }
}

export { main };
