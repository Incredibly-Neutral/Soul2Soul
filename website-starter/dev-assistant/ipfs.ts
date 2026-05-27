import * as fs from "fs/promises";
import * as path from "path";
import * as tar from "tar";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { ReadableStream } from "stream/web";
import * as os from "os";
import * as crypto from "crypto";

interface DagNode {
  [key: string]: string | DagNode;
}

interface IpfsLink {
  Hash: {
    "/": string;
  };
  Name: string;
  Tsize: number;
}

interface IpfsDataField {
  "/": {
    bytes: string;
  };
}

interface IpfsCidReference {
  "/": string;
}

interface IpfsDirectory {
  [key: string]: IpfsCidReference;
}

type IpfsDagNodeValue =
  | IpfsDataField
  | IpfsCidReference
  | IpfsLink[]
  | IpfsDirectory
  | { "/": string };

interface IpfsDagNode {
  Data?: IpfsDataField;
  Links?: IpfsLink[];
  [key: string]: IpfsDagNodeValue | undefined;
}

function isIpfsDataField(value: any): value is IpfsDataField {
  return (
    typeof value === "object" &&
    value !== null &&
    "/" in value &&
    typeof value["/"] === "object" &&
    value["/"] !== null &&
    "bytes" in value["/"]
  );
}

function isIpfsCidReference(value: any): value is IpfsCidReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "/" in value &&
    typeof value["/"] === "string"
  );
}

function isIpfsDirectory(value: any): value is IpfsDirectory {
  return (
    typeof value === "object" &&
    value !== null &&
    !("/" in value) &&
    Object.values(value).every(isIpfsCidReference)
  );
}

const getDagNode = async (cid: string): Promise<any> => {
  // console.log(`Fetching DAG node for CID: ${cid}`);
  const response = await fetch(
    `${process.env.IPFS_URL}/api/v0/dag/get?arg=${cid}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(
      `IPFS dag/get failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  // console.log('DAG response:', JSON.stringify(data, null, 2));
  return data;
};

const downloadRecursive = async (
  dagCid: string,
  basePath: string,
) => {
  try {
    const node = await getDagNode(dagCid);
    console.log(node);

    if (!node.Links || !Array.isArray(node.Links)) {
      console.log('No Links found in DAG');
      return;
    }

    for (const link of node.Links) {
      const cid = link.Hash["/"];
      const name = link.Name;
      
      // Determine file path - add /index.html for directory-style paths
      const filePath = name === 'index.html'
        ? path.join(basePath, 'index.html')
        : path.join(basePath, name, 'index.html');

      console.log(`Downloading ${cid} to ${filePath}`);

      // Fetch the content
      const response = await fetch(
        `${process.env.IPFS_URL}/api/v0/cat?arg=${cid}`,
        { method: "POST" }
      );

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Write the file
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(filePath, buffer);
      console.log(`Successfully wrote ${filePath}`);
    }

  } catch (err) {
    console.error('Failed to process DAG:', err);
  }
};

export const downloadHTML = async (cid: string, outputPath: string) => {
  //  console.log(`Starting download from IPFS CID: ${cid} to ${outputPath}`);

  try {
    // Create output directory if it doesn't exist
    await fs.mkdir(outputPath, { recursive: true });

    // Download and process the DAG directly to the target directory
    await downloadRecursive(cid, outputPath);
  } catch (error) {
    console.error("Failed to download from IPFS:", error);
    throw error;
  }

  // console.log(`Completed download from IPFS CID: ${cid}`);
};

export const fetchFromIPFS = async (ipfsGateway: string, cid: string): Promise<any> => {
        const url = `${ipfsGateway}/api/v0/cat?arg=${cid}`;

        console.log(url)
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
            'Content-Type': 'application/json',
            // Add auth if needed:
            // 'Authorization': 'Bearer YOUR_TOKEN'
            }
        });

        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('IPFS error response:', errorText);
            throw new Error(`Failed to fetch from IPFS: ${response.status} ${response.statusText}`);
        }
        
        const text = await response.text();

        console.log(text)
        
        try {
            return JSON.parse(text);
        } catch (error) {
            console.error('Failed to parse IPFS response as JSON:', text);
            throw new Error('Invalid JSON response from IPFS');
        }
    }


export const add = async (
  fileContent: string,
  name: string,
  ipfs_endpoint: string,
  onlyHash?: boolean,
): Promise<string> => {
  const formData = new FormData();
  
  // Create a blob with the file content
  const blob = new Blob([fileContent], { type: 'text/plain' });
  formData.append('file', blob, name);

  const apiPath = onlyHash ? "api/v0/add?only-hash=true" : "api/v0/add";

  const response = await fetch(
    `https://${fixEndpoint(ipfs_endpoint)}/${apiPath}`,
    {
      method: 'POST',
      body: formData,
      // Don't set Content-Type header - browser will set it automatically with correct boundary
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`IPFS add failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result: any = await response.json();
  return result.Hash || result.Cid?.['/'] || result.Cid;
};

export const dagPut = async (
  fileContent: string,
  name: string,
  ipfs_endpoint: string,
): Promise<string> => {
  const formData = new FormData();
  
  // Create a blob with the JSON data
  const blob = new Blob([fileContent], { type: 'application/json' });
  formData.append('object data', blob, name || 'dag.json');

  const response = await fetch(
    `https://${fixEndpoint(ipfs_endpoint)}/api/v0/dag/put`,
    {
      method: 'POST',
      body: formData,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DAG put failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result: any = await response.json();
  return result.Cid['/'] || result.Cid || result.Hash;
};

const fixEndpoint = (endpoint: string) => {
  return endpoint
    .replace(/^(https?:\/\/)/, "") // Remove protocol if present
    .replace(/\/+$/, ""); // Remove trailing slashes
};

// export const downloadAsTar = async (cid: string, outputPath: string) => {
//     console.log(`Starting download from IPFS CID: ${cid} to ${outputPath}`);
//     // outputPath = path.join(outputPath, 'assets');
//  //   const baseDir = path.dirname(outputPath)

//     try {
//         // Create base directory if it doesn't exist
//         await fs.mkdir(outputPath, { recursive: true });

//         const response  = await fetch(`${process.env.IPFS_URL}/api/v0/get?arg=${cid}&archive=true&compress=false`, {
//             method: 'POST'
//         });

//         if (!response.ok) {
//             throw new Error(`IPFS cat failed: ${response.status} ${response.statusText}`);
//         }

//         if (!response.body) {
//             throw new Error('No response body received from IPFS');
//         }

//         // Create readable stream from response
//         const readable = Readable.fromWeb(response.body as ReadableStream);

//         // Create a temporary directory for extraction
//         const tempDir = path.join(os.tmpdir(), `neutralpress-${crypto.randomUUID()}`);
//         await fs.mkdir(tempDir, { recursive: true });

//         console.log(outputPath, tempDir)

//         try {
//             // Extract tar to temporary directory
//             await pipeline(
//                 readable,
//                 tar.x({
//                     cwd: tempDir,
//                     strip: 1,
//                     noChmod: true,  // Preserve file modes
//                     strict: true,   // Ensure strict parsing
//                     onentry: (entry) => {
//                         // Force binary mode for known binary file types
//                         if (/\.(jpg|jpeg|png|gif|webp|bmp|ico|svg)$/i.test(entry.path)) {
//                             entry.mode = 0o644;  // Set appropriate file permissions for binary files
//                         }
//                     }
//                 })
//             );

//             // Move files from temp directory to final location
//             const files = await fs.readdir(tempDir);
//             for (const file of files) {
//                 const sourcePath = path.join(tempDir, file);
//                 const targetPath = path.join(outputPath, file);

//                 // Remove target if it exists
//                 try {
//                    // await fs.rm(targetPath, { recursive: true, force: true });
//                 } catch (err) {
//                     // Ignore errors if file doesn't exist
//                 }

//                 // Copy files instead of rename to handle cross-device operations
//                 await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
//             }

//             console.log(`Successfully extracted ... to ${outputPath}`);
//         } finally {
//             // Clean up temp directory
//             try {
//                 await fs.rm(tempDir, { recursive: true, force: true });
//             } catch (err) {
//                 console.warn('Failed to clean up temporary directory:', err);
//             }
//         }
//     } catch (error) {

//         console.error('Failed to download and extract assets:', error);
//         throw error;
//     }

//     console.log(`Completed download from IPFS CID: ${cid}`);
// }
