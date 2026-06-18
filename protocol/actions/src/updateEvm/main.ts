/// <reference path="../action_globals.ts" />

import { evmRead, evmWrite, toHexString } from "../libs/evm";
import { getProtocolInfo } from "../libs/protocol.factory";
import { getDomainOwnerAndModules } from "../libs/ens.factory";
import { contenthashToIPFS } from "../libs/ipfs.factory";
import { fetchWithTimeout } from "../libs/helpers";
import { canPublish, extractSignerAddress } from "../libs/gates";
import { getConfig } from "../single/config.ctrl";


const IPFS_URL = "https://ipfs.transport-union.dev";

const RECORDS_CONTRACT_ABI = [
  "function getText(bytes32 node, string key) view returns (string)",
  "function setText(bytes32 node, string key, string value) nonpayable"
];

const TIMEOUTS = {
  mkdir: 5_000,
  cpRoot: 10_000,
  cpFile: 10_000,
  stat: 5_000,
  rm: 5_000,
  pinAdd: 10_000,
  pinLs: 5_000
};

export const mergedMain = async (
  { signature, authorSafeAddress, publication, jobs, dev }: any,
): Promise<{ success: boolean; cid?: string; response?: string | Error; logz: string[] }> => {
  const logz: string[] = [];

  const signerAddress = extractSignerAddress(
    ethers.utils.hashMessage("lit actions auth"),
    signature,
  );
  logz.push(`signer: ${signerAddress}`);

  const { multisig, configModule, publicationModule } =
    await getDomainOwnerAndModules(publication);
  if (
    !multisig ||
    !configModule ||
    !publicationModule
  ) {
    return { success: false, response: "missing config modules", logz };
  }

  if (!(await canPublish(authorSafeAddress, publicationModule, signerAddress))) {
    return { success: false, response: "cannot publish", logz };
  }

  const protocolInfo = await getProtocolInfo(false);
  if (!protocolInfo?.pkp) {
    return { success: false, response: "Failed to fetch protocol info", logz };
  }

  const config = await getConfig(undefined, configModule);

  const node = ethers.utils.namehash(publication);
  logz.push(`node: ${node}`);

  // Read previous contenthash_wrapped on-chain
  const prevEncoded = await evmRead(
    "BASE",
    protocolInfo.ensRecords,
    RECORDS_CONTRACT_ABI,
    "getText",
    [node, "contenthash_wrapped"],
  );
  logz.push(`prev: ${prevEncoded}`);

  const mfsPath = `/temp-${Date.now()}`;

  let newRootCid: string;

  if (prevEncoded && prevEncoded.length > 0) {
    const prevCid = contenthashToIPFS(prevEncoded);
    logz.push(`cp root ${prevCid} → ${mfsPath}`);

    await fetchWithTimeout(
      `${IPFS_URL}/api/v0/files/cp?arg=/ipfs/${prevCid}&arg=${encodeURIComponent(mfsPath)}&parents=true`,
      { method: "POST" },
      TIMEOUTS.cpRoot,
    );
  } else {
    logz.push(`mkdir ${mfsPath}`);
    await fetchWithTimeout(
      `${IPFS_URL}/api/v0/files/mkdir?arg=${encodeURIComponent(mfsPath)}&parents=true`,
      { method: "POST" },
      TIMEOUTS.mkdir,
    );
  }

  // Copy delta jobs in parallel — blocks already on the kubo node
  logz.push(`cp ${jobs.length} files`);
  await Promise.all(
    jobs.map(async (job: any) => {
      const filePath =
        job.path === "index.html"
          ? "index.html"
          : `${job.path}/index.html`;
      const destPath = `${mfsPath}/${filePath}`;
      const sourceCid = job.html;

      console.log("SOURCE CID", sourceCid)

      // Check if dest entry already exists (from previous run's root copy)
      // Kubo files/cp does NOT overwrite — must rm first
      let prevHash: string = "";
      try {
        const statRes = await fetchWithTimeout(
          `${IPFS_URL}/api/v0/files/stat?arg=${encodeURIComponent(destPath)}`,
          { method: "POST" },
          TIMEOUTS.stat,
        );
        try { prevHash = (await statRes.json()).Hash || ""; } catch {}
      } catch {}

      // Fast path: skip if dest already matches source
      if (prevHash && prevHash === sourceCid) {
        logz.push(`skip (unchanged): ${filePath}`);
        return;
      }

      // Remove existing entry so cp can overwrite
      if (prevHash) {
        await fetchWithTimeout(
          `${IPFS_URL}/api/v0/files/rm?arg=${encodeURIComponent(destPath)}`,
          { method: "POST" },
          TIMEOUTS.rm,
        ).catch(e => logz.push(`warn: rm failed ${filePath}: ${e instanceof Error ? e.message : e}`));
      }

      // Now cp works cleanly
      const url = `${IPFS_URL}/api/v0/files/cp?` +
        `arg=/ipfs/${encodeURIComponent(sourceCid)}` +
        `&arg=${encodeURIComponent(destPath)}` +
        `&parents=true&flush=false`;
      const res = await fetchWithTimeout(url, { method: "POST" }, TIMEOUTS.cpFile);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to cp ${job.path}: ${text}`);
      }
      logz.push(`✓ ${filePath} (${sourceCid.slice(0, 9)})`);
    }),
  );

   // Copy assets into /assets
  if (config.assetsCid) {
    const assetsDestPath = `${mfsPath}/assets`;
    logz.push(`cp assets ${config.assetsCid} → ${assetsDestPath}`);

    // Remove existing /assets if present
    try {
      await fetchWithTimeout(
        `${IPFS_URL}/api/v0/files/stat?arg=${encodeURIComponent(assetsDestPath)}`,
        { method: "POST" },
        TIMEOUTS.stat,
      );
      await fetchWithTimeout(
        `${IPFS_URL}/api/v0/files/rm?arg=${encodeURIComponent(assetsDestPath)}&recursive=true`,
        { method: "POST" },
        TIMEOUTS.rm,
      ).catch(e => logz.push(`warn: rm assets failed: ${e instanceof Error ? e.message : e}`));
    } catch {}
    const assetsUrl = `${IPFS_URL}/api/v0/files/cp?` +
    `arg=/ipfs/${encodeURIComponent(config.assetsCid)}` +  // no /assets suffix needed
    `&arg=${encodeURIComponent(assetsDestPath)}` +
    `&parents=true&flush=false`;
    const assetsRes = await fetchWithTimeout(assetsUrl, { method: "POST" }, TIMEOUTS.cpFile);
    if (!assetsRes.ok) {
      const text = await assetsRes.text();
      throw new Error(`Failed to cp assets: ${text}`);
    }
    logz.push(`✓ assets (${config.assetsCid.slice(0, 9)})`);
  }

  // Wrap in try/finally so temp always cleans up (even on evmWrite failure)
  newRootCid = "";

  try {
    // New root CID
    const statRes = await fetchWithTimeout(
      `${IPFS_URL}/api/v0/files/stat?arg=${encodeURIComponent(mfsPath)}`,
      { method: "POST" },
      TIMEOUTS.stat,
    );
    newRootCid = (await statRes.json()).Hash;
    logz.push(`root: ${newRootCid}`);

    await fetchWithTimeout(
      `${IPFS_URL}/api/v0/pin/add?arg=${newRootCid}`,
      { method: "POST" },
      TIMEOUTS.pinAdd,
    );

    if (!dev) {

      const encoded = toHexString(newRootCid);
      logz.push(`writing ${encoded}`);
      const result = await evmWrite(
        "BASE",
        protocolInfo.pkp,
        protocolInfo.ensRecords,
        RECORDS_CONTRACT_ABI,
        "setText",
        [node, "contenthash_wrapped", encoded],
        true,
      );
      logz.push(JSON.stringify(result));

    }

    return { success: true, cid: newRootCid, logz };
    
  } finally {
    // Always clean up temp MFS path

    await fetchWithTimeout(
      `${IPFS_URL}/api/v0/files/rm?arg=${encodeURIComponent(mfsPath)}&recursive=true`,
      { method: "POST" },
      TIMEOUTS.rm,
    ).catch(() => logz.push(`warn: cleanup failed`));
  }
};

// Named export for backwards compat during transition
export const main = mergedMain;