// Helper: POST to Kubo MFS with timeout and response parsing
export const IPFS_URL = "https://ipfs.transport-union.dev";

// Kubo MFS API timeouts
export const MFS_TIMEOUTS = {
  mkdir: 5_000,
  stat: 5_000,
  ls: 5_000,
  cp: 10_000,
  pinAdd: 10_000,
  rm: 5_000,
};



export async function kuboMfsPost(path: string, timeoutMs: number): Promise<{ ok: boolean; json: () => Promise<any>; text: () => Promise<string> }> {
  const response = await fetch(`${IPFS_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ok = response.ok;
  return {
    ok,
    async json() { return response.json(); },
    async text() { return response.text(); },
  };
}

// Helper: create a temp MFS path, initializing from an existing root CID or creating fresh
export async function prepareTempMfs(currentRoot: string, tempDirName: string): Promise<string> {
  const tmpPath = `/tmp/${tempDirName}`;

  if (currentRoot && currentRoot !== "") {
    // Copy existing root into temp (MFS)
    const res = await kuboMfsPost(
      `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(currentRoot)}&arg=${encodeURIComponent(tmpPath)}&parents=true`,
      MFS_TIMEOUTS.cp,
    );
    if (!res.ok) {
      const text = await res.text();
      console.warn(`cp root failed, falling back to mkdir: ${text}`);
      // cp failed — create fresh dir instead (root may be pinned/unavailable)
      const mkdirRes = await kuboMfsPost(
        `/api/v0/files/mkdir?arg=${encodeURIComponent(tmpPath)}&parents=true`,
        MFS_TIMEOUTS.mkdir,
      );
      if (!mkdirRes.ok) {
        const mkdirText = await mkdirRes.text();
        throw new Error(`Failed to create temp MFS dir: ${mkdirText}`);
      }
    }
  } else {
    // Create fresh temp dir
    const res = await kuboMfsPost(
      `/api/v0/files/mkdir?arg=${encodeURIComponent(tmpPath)}&parents=true`,
      MFS_TIMEOUTS.mkdir,
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create temp MFS dir: ${text}`);
    }
  }

  return tmpPath;
}

// Helper: list files in an MFS directory
export async function kuboMfsList(mfsPath: string): Promise<any[]> {
  const res = await kuboMfsPost(
    `/api/v0/files/ls?arg=${encodeURIComponent(mfsPath)}`,
    MFS_TIMEOUTS.ls,
  );
  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  return (data.Links || []).map((link: any) => ({
    name: link.Name,
    hash: link.Hash,
    size: link.Size,
    type: link.Tsize ? "file" : "directory",
  }));
}

// Helper: stat a single entry in MFS
export async function kuboMfsStat(mfsPath: string): Promise<string | null> {
  const res = await kuboMfsPost(
    `/api/v0/files/stat?arg=${encodeURIComponent(mfsPath)}`,
    MFS_TIMEOUTS.stat,
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.Hash || null;
}

// Helper: flush an MFS directory to get the new root CID
export async function kuboMfsFlush(mfsPath: string): Promise<{ ok: boolean; cid: string }> {
  const res = await kuboMfsPost(
    `/api/v0/files/flush?arg=${encodeURIComponent(mfsPath)}`,
    MFS_TIMEOUTS.pinAdd,
  );
  if (!res.ok) {
    return { ok: false, cid: "" };
  }
  const data = await res.json();
  // /api/v0/files/flush returns { "/": "/" }, where / is the new root CID
  const cid = typeof data === 'string' ? data : (data['/'] || data.Hash || data.Cid?.['/'] || data.Cid || "");
  return { ok: true, cid };
}

// Helper: copy a file from IPFS (by CID) into an MFS path
export async function kuboMfsCp(sourceCid: string, destMfsPath: string): Promise<boolean> {
  const res = await kuboMfsPost(
    `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(sourceCid)}&arg=${encodeURIComponent(destMfsPath)}&parents=true&flush=false`,
    MFS_TIMEOUTS.cp,
  );
  if (!res.ok) {
    const text = await res.text();
    console.warn(`cp ${sourceCid} → ${destMfsPath} failed: ${text}`);
    return false;
  }
  return true;
}