/// <reference path="../action_globals.ts" />

import { ActionResult, EvmUpdateData, EvmUpdateInput } from '@s2s/soul2soul-shared/lit-actions';
import { evmRead, evmWrite, toHexString } from '../libs/evm';
import { getProtocolInfo } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { contenthashToIPFS } from '../libs/ipfs.factory';
import { fetchWithTimeout, requireFields } from '../libs/helpers';
import { canPublish, canReset, extractSignerAddress } from '../libs/gates';
import { getConfig } from '../render/config.ctrl';
import {
  verifyProvenance,
  sanitizeRemovePath,
  verifyRevocable,
  verifyPathAvailable,
} from './verify';

const ACTION = 'evm-update';

const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
];

const TIMEOUTS = {
  mkdir: 5_000,
  cpRoot: 10_000,
  cpFile: 10_000,
  stat: 5_000,
  rm: 5_000,
  pinAdd: 10_000,
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

    const node = ethers.utils.namehash(publication);
    trace.push(`node: ${node}`);

    // Read previous contenthash_wrapped on-chain
    const prevEncoded = await evmRead(
      'L2',
      protocolInfo.ensRecords,
      RECORDS_CONTRACT_ABI,
      'getText',
      [node, 'contenthash_wrapped'],
      rpcs?.L2,
    );
    trace.push(`prev: ${prevEncoded}`);

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

        // Provenance verification gate — reject unverified content
        if (!preview) {
          try {
            await verifyProvenance(sourceCid, job.id, protocolInfo.pkp!, gateway!, trace);
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

        // Remove existing entry so cp can overwrite
        if (prevHash) {
          // Check existing content isn't under an active deal with a different genesis
          if (!preview) {
            await verifyPathAvailable(gateway!, destPath, job.id, publicationModule, rpcs?.L2);
          }
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
        trace.push(`writing ${encoded}`);
        const result = await evmWrite(
          'L2',
          protocolInfo.pkp,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'setText',
          [node, 'contenthash_wrapped', encoded],
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
