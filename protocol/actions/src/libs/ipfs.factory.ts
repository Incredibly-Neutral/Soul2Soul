import { IPFS_URL } from "./constants";
import { fetchWithTimeout } from "./helpers";

interface StandardLink {
  Hash: { "/": string };
  Name: string;
  Tsize: number;
}

export interface DagNode {
  Links?: StandardLink[];
  metadata?: {
    [id: string]: {
      path: string;
      cid: string;
      updatedAt?: number;
    };
  };
}

export const getPublicationConfig = async (configCid: string) => {
  try {
    const response = await fetch(`${IPFS_URL}/api/v0/cat?arg=${configCid}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch config from IPFS: ${response.statusText}`,
      );
    }
    const config = await response.json();
    if (!config || !config.mapping) {
      throw new Error("Invalid config format: missing mapping");
    }
    return config;
  } catch (error) {
    console.error("Error in getPublicationConfig:", error);
    throw error;
  }
  // });
};

export const uploadFile = async (output: string) => {
  const ipfsApiUrl = `${IPFS_URL}/api/v0/add`;
  const formData = new FormData();
  formData.append("file", output);

  const response = await fetch(ipfsApiUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(
      `IPFS upload failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = await response.json();
  return result.Hash;
};

export const catFile = async (cid: string) => {

  const ipfsApiUrl = `${IPFS_URL}/api/v0/cat?arg=${cid}`;

  const response = await fetch(ipfsApiUrl, {
    method: "POST",
  });

  if (!response.ok) {

    console.log(response)

    throw new Error(
      `IPFS retrieval failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = await response.text();
  return result;
};

export const getDag = async (cid: string) => {
  const ipfsApiUrl = `${IPFS_URL}/api/v0/dag/get?arg=${cid}`;
  const response = await fetch(ipfsApiUrl, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `IPFS request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return data;
};

export const updateDagItem = (
  dag: DagNode,
  id: string,
  path: string,
  newCid: string
): DagNode => {
  const normalizedPath = normalizePath(path);
  const existing = dag.metadata?.[id];
  
  // Remove old link if path changed
  const filteredLinks = (dag.Links || []).filter(link => 
    existing ? link.Name !== existing.path : true
  );

  // Also remove any link with the same path (in case of collision)
  const dedupedLinks = filteredLinks.filter(link => link.Name !== normalizedPath);

  return {
    Links: [
      ...dedupedLinks,
      { Hash: { "/": newCid }, Name: normalizedPath, Tsize: 0 }
    ],
    metadata: {
      ...dag.metadata,
      [id]: {
        path: normalizedPath,
        cid: newCid,
        updatedAt: Date.now()
      }
    }
  };
};

export const removeDagItem = (dag: DagNode, id: string): DagNode => {
  const existing = dag.metadata?.[id];
  if (!existing) return dag;

  const { [id]: removed, ...remainingMetadata } = dag.metadata || {};

  return {
    Links: (dag.Links || []).filter(link => link.Name !== existing.path),
    metadata: remainingMetadata
  };
};

// Utility function to convert data to Blob
async function toBlob(data: any): Promise<Blob> {
  if (data instanceof Blob) return data;
  if (typeof data === "string") return new Blob([data]);
  return new Blob([JSON.stringify(data)]);
}

export const putDag = async (dag: DagNode): Promise<string> => {
  const ipfsApiUrl = `${IPFS_URL}/api/v0/dag/put?store-codec=dag-cbor&input-codec=dag-json&pin=true`;

  // Convert DAG to blob
  const blob = await toBlob(dag);

  const formData = new FormData();
  formData.append("file", blob, "dag.json");

  const response = await fetch(ipfsApiUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `IPFS DAG put failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const result = await response.json();
  if (result.Cid) {
    return result.Cid["/"];
  } else {
    throw new Error(`Invalid response from IPFS: ${JSON.stringify(result)}`);
  }
};


export const createMetadata = (dag: DagNode, idMap: Record<string, string>): DagNode => {
  
  const metadata: DagNode['metadata'] = {};
  const links: StandardLink[] = [];
  const seenPaths = new Set<string>();

  for (const [path, id] of Object.entries(idMap)) {
    const normalizedPath = normalizePath(path);
    
    // Skip duplicates
    if (seenPaths.has(normalizedPath)) continue;
    seenPaths.add(normalizedPath);
    
    // Find existing link by matching normalized paths
    const existingLink = dag.Links?.find(link => 
      normalizePath(link.Name) === normalizedPath
    );
    
    if (existingLink) {
      links.push({
        Hash: existingLink.Hash,
        Name: normalizedPath,
        Tsize: existingLink.Tsize
      });
      
      metadata[id] = {
        path: normalizedPath,
        cid: existingLink.Hash["/"],
        updatedAt: Date.now()
      };
    }
  }

  return { Links: links, metadata };
};

const normalizePath = (p: string): string => {
  const cleaned = p.replace(new RegExp('^/+|/+$', 'g'), '');
  return cleaned === '' ? 'index.html' : cleaned;
};


export const createUnixFSFromCbor = async (dag: any, gateway: string): Promise<string> => {
  
  const files = dag.Links?.map((link: any) => ({
    // Ensure paths end with /index.html for directory-style URLs
    path: link.Name === 'index.html' 
      ? 'index.html' 
      : `${link.Name}/index.html`,
    cid: link.Hash["/"]
  })) || [];
  
  const mfsPath = `/temp-${Date.now()}`;
  
  await fetchWithTimeout(`${gateway}/api/v0/files/mkdir?arg=${encodeURIComponent(mfsPath)}&parents=true`, {
    method: 'POST'
  });
  
  for (const file of files) {
    const destPath = `${mfsPath}/${file.path}`;
    const sourcePath = `/ipfs/${file.cid}`;
    
    const url = `${gateway}/api/v0/files/cp?` +
      `arg=${encodeURIComponent(sourcePath)}&` +
      `arg=${encodeURIComponent(destPath)}&` +
      `parents=true`;
    
    const res = await fetchWithTimeout(url, { method: 'POST' });
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error("Error copying file:", errorText);
      throw new Error(`Failed to copy ${file.path}: ${errorText}`);
    }
  }
  
  const statRes = await fetchWithTimeout(`${gateway}/api/v0/files/stat?arg=${encodeURIComponent(mfsPath)}`, {
    method: 'POST'
  });
  
  const stat = await statRes.json();
  const dirCid = stat.Hash;

  // Pin before 
  await fetchWithTimeout(`${gateway}/api/v0/pin/add?arg=${dirCid}`, {
    method: 'POST'
  });

  
  await fetchWithTimeout(`${gateway}/api/v0/files/rm?arg=${encodeURIComponent(mfsPath)}&recursive=true`, {
    method: 'POST'
  });
  
  return dirCid;
}


export const contenthashToIPFS = (hexString: string): string => {

    const hex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    
    if (bytes[0] !== 0xe3) {
        throw new Error('Not an IPFS contenthash (expected 0xe3)');
    }
    
    // Skip 0xe3 (ipfs-ns) and 0x01 (version)
    const cidBytes = bytes.slice(2);
    
    // Base58 encode
    const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    
    let num = BigInt(0);
    for (const byte of cidBytes) {
        num = num * 256n + BigInt(byte);
    }
    
    let result = "";
    while (num > 0n) {
        result = BASE58_ALPHABET[Number(num % 58n)] + result;
        num = num / 58n;
    }
    
    // Handle leading zero bytes
    for (const byte of cidBytes) {
        if (byte !== 0) break;
        result = "1" + result;
    }
    
    return result;
}