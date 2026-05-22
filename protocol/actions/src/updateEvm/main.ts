/// <reference path="../action_globals.ts" />

import { evmRead, evmWrite, toHexString } from "../libs/evm";
import { getProtocolInfo } from "../libs/protocol.factory";
import { getDomainOwnerAndModules } from "../libs/ens.factory";
import { contenthashToIPFS } from "../libs/ipfs.factory";
import { fetchWithTimeout } from "../libs/helpers";
import { canPublish, extractSignerAddress } from "../libs/gates";


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
  pin: 10_000,
  rm: 5_000
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
      // job.html holds the IPFS CID returned by uploadFile (post-render)
      const sourcePath = `/ipfs/${job.html}`;
      const url = `${IPFS_URL}/api/v0/files/cp?` +
        `arg=${encodeURIComponent(sourcePath)}` +
        `&arg=${encodeURIComponent(destPath)}` +
        `&parents=true&flush=false`; // flush=false batches writes; Kubo creates final version on files/stat
      const res = await fetchWithTimeout(url, { method: "POST" }, TIMEOUTS.cpFile);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to copy ${job.path}: ${text}`);
      }
      logz.push(`✓ ${job.path}`);
    }),
  );

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

    // Pin on kubo
    // await fetchWithTimeout(
    //   `${IPFS_URL}/api/v0/pin/add?arg=${newRootCid}`,
    //   { method: "POST" },
    //   TIMEOUTS.pin,
    // );
    // logz.push(`pinned`);

    // Write on-chain
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
