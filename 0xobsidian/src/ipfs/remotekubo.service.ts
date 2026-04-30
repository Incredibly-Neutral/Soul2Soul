import {
  directoryFormData,
  singleFileFormData,
  singleFileFormDataFromPath,
  directoryFormDataStream,
  assembleFormData,
} from "./formdata.js";
//@ts-ignore
import electron from "electron";
const net = electron.remote.net;
import * as https from "https";
import Multipart from "./multi-part-lite-adopted/main.js";
import fs from "fs";
import path from "path";

const fixEndpoint = (endpoint: string) => {
  return endpoint
    .replace(/^(https?:\/\/)/, "") // Remove protocol if present
    .replace(/\/+$/, ""); // Remove trailing slashes
};

export const addRecursive = async (
  sourcePath: string,
  ipfs_endpoint: string,
  onlyHash: boolean = false,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    // console.log("addRecursive: " + ipfs_endpoint);

    const { formData, boundary } = await directoryFormData(sourcePath);

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    const path = onlyHash ? "api/v0/add?onlyHash=true" : "api/v0/add";

    try {
      const request = net.request({
        method: "POST",
        protocol: "https:",
        hostname: fixEndpoint(ipfs_endpoint),
        port: 443,
        path: path,
        headers,
      });

      request.on("response", (response: any) => {
        response.on("data", (chunk: any) => {
          const a = chunk.toString().split("\n");
          let root = a[a.length - 2];
          let parsnip = JSON.parse(root);
          resolve(parsnip["Hash"]);
        });
      });
      request.on("error", (error: any) => {
        console.log(`ERROR: ${JSON.stringify(error)}`);
        resolve("");
      });
      // Write the binary buffer directly
      request.write(formData);
      request.end();
    } catch (error) {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      resolve("");
    }
  });
};

export const addAsFolder = async (
  assets: any[],
  ipfs_endpoint: string,
  onlyHash: boolean = false,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    console.log("addRecursive: " + ipfs_endpoint);

    const { formData, boundary } = await assembleFormData(assets);

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    const path = onlyHash ? "api/v0/add?onlyHash=true" : "api/v0/add";

    try {
      const request = net.request({
        method: "POST",
        protocol: "https:",
        hostname: fixEndpoint(ipfs_endpoint),
        port: 443,
        path: path,
        headers,
      });

      request.on("response", (response: any) => {
        response.on("data", (chunk: any) => {
          const a = chunk.toString().split("\n");
          let root = a[a.length - 2];
          let parsnip = JSON.parse(root);
          resolve(parsnip["Hash"]);
        });
      });
      request.on("error", (error: any) => {
        console.log(`ERROR: ${JSON.stringify(error)}`);
        resolve("");
      });
      // Write the binary buffer directly
      request.write(formData);
      request.end();
    } catch (error) {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      resolve("");
    }
  });
};

export const getJsonLike = async (
  cid: string,
  ipfs_endpoint: string,
): Promise<any> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let resolved = false;

    const headers = {
      // No need for JSON content type; IPFS get returns raw data
    };

    const request = https.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint),
      path: `/api/v0/cat?arg=${cid}`,
      headers,
    });

    request.on("response", (response) => {
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      response.on("end", () => {
        if (!resolved) {
          resolved = true;
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf-8"); // Convert buffer to string
          resolve(JSON.parse(text));
        }
      });

      response.on("aborted", () => {
        console.log("aborted");
        if (!resolved) {
          resolved = true;
          reject(new Error("Response aborted"));
        }
      });

      response.on("error", (err) => {
        console.log("error");
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });

    request.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });

    request.end();
  });
};

export const getRecursive = async (
  cid: string,
  ipfs_endpoint: string,
): Promise<Buffer> => {
  return new Promise(async (resolve, reject) => {
    const headers = {
      "Content-Type": `application/json`,
    };

    const request = net.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint),
      path: `/api/v0/get?arg=${cid}&output=archive`,
      headers,
    });
    request.on("response", (response: any) => {
      response.on("data", (chunk: any) => {
        const nodeBuffer = Buffer.from(chunk);
        resolve(nodeBuffer);
      });
    });
    request.on("error", (error: any) => {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      reject();
    });
    request.end();
  });
};

export const add = async (
  note: any,
  ipfs_endpoint: string,
  onlyHash?: boolean,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    const noteBuffer = Buffer.from(JSON.stringify(note));
    const { formData, boundary } = await singleFileFormData(
      note.slug || note.name || note.path || "nft",
      noteBuffer,
    );

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    const apiPath = onlyHash ? "api/v0/add?onlyHash=true" : "api/v0/add";

    // console.log(`https://${fixEndpoint(ipfs_endpoint)}/${apiPath}`);

    try {
      const request = net.request({
        method: "POST",
        protocol: "https:",
        hostname: fixEndpoint(ipfs_endpoint),
        port: 443,
        path: apiPath,
        headers,
      });

      request.on("response", (response: any) => {
        response.on("data", (chunk: any) => {
          const a = chunk.toString().split("\n");
          // console.log(a);
          let parsnip = JSON.parse(a[0]);
          // console.log(parsnip)
          resolve(parsnip["Hash"]);
        });
      });
      request.on("error", (error: any) => {
        console.log(`ERROR: ${JSON.stringify(error)}`);
        reject();
      });
      // Write the binary buffer directly
      request.write(formData);
      request.end();
    } catch (error) {
      console.log(`ERROR: ${JSON.stringify(error)} -- ${note}`);
      reject();
    }
  });
};

export const addFile = async (
  path: any,
  ipfs_endpoint: string,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    const formData = await singleFileFormDataFromPath(path);

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${formData.getBoundary()}`,
    };

    const request = net.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint),
      path: "/api/v0/add",
      headers,
    });

    //  formData.pipe(request);

    request.on("response", (response: any) => {
      response.on("data", (chunk: any) => {
        const a = chunk.toString().split("\n");
        // console.log(a);
        let parsnip = JSON.parse(a[0]);
        // console.log(parsnip)
        resolve(parsnip["Hash"]);
      });
    });
    request.on("error", (error: any) => {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      reject();
    });
    // Write the binary buffer directly
    request.write(await formData.buffer());
    request.end();
  });
};

export const addFileFromUrl = async (
  url: any,
  ipfs_endpoint: string,
  onlyHash?: boolean,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    const arrayBuffer = await fetch(url).then((r) => r.arrayBuffer());
    const content = Buffer.from(arrayBuffer);

    const filename = path.basename(url);

    const { formData, boundary } = await singleFileFormData(filename, content);

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    const apiPath = onlyHash ? "api/v0/add?onlyHash=true" : "api/v0/add";

    const request = net.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint),
      path: apiPath,
      headers,
    });

    //  formData.pipe(request);

    request.on("response", (response: any) => {
      response.on("data", (chunk: any) => {
        const a = chunk.toString().split("\n");
        // console.log(a);
        let parsnip = JSON.parse(a[0]);
        // console.log(parsnip)
        resolve(parsnip["Hash"]);
      });
    });
    request.on("error", (error: any) => {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      reject();
    });
    // Write the binary buffer directly
    request.write(formData);
    request.end();
  });
};

export const pinFile = async (
  path: any,
  ipfs_endpoint: string,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    const formData = await singleFileFormDataFromPath(path);

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${formData.getBoundary()}`,
    };

    const request = net.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint) + "/cluster",
      path: "/api/v0/add",
      headers,
    });

    request.on("response", (response: any) => {
      response.on("data", (chunk: any) => {
        const a = chunk.toString().split("\n");
        // console.log(a);
        let parsnip = JSON.parse(a[0]);
        // console.log(parsnip)
        resolve(parsnip.cid);
      });
    });
    request.on("error", (error: any) => {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      reject();
    });
    // Write the binary buffer directly
    request.write(await formData.buffer());
    request.end();
  });
};

export const dagPut = async (
  note: any,
  ipfs_endpoint: string,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    const noteBuffer = Buffer.from(JSON.stringify(note));
    const { formData, boundary } = await singleFileFormData(
      note.slug || note.name || note.path || "nft",
      noteBuffer,
    );

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    const request = net.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint),
      path: "/api/v0/dag/put",
      headers,
    });

    request.on("response", (response: any) => {
      response.on("data", (chunk: any) => {
        const a = chunk.toString().split("\n");
        let parsnip = JSON.parse(a[0]);
        resolve(parsnip["Cid"]["/"]);
      });
    });
    request.on("error", (error: any) => {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      reject();
    });
    // Write the binary buffer directly
    request.write(formData);
    request.end();
  });
};

export const dagGet = async (
  cid: string,
  ipfs_endpoint: string,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    const headers = {
      "Content-Type": `application/json`,
    };

    const hostname = fixEndpoint(ipfs_endpoint);
    const url = `https://${hostname}/api/v0/dag/get?arg=${cid}`;

    try {
      const request = net.request({
        method: "POST",
        protocol: "https:",
        hostname: hostname,
        port: 443,
        path: `/api/v0/dag/get?arg=${cid}`,
        headers,
      });

      request.on("response", (response: any) => {
        response.on("data", (chunk: any) => {
          console.log("data chunk received");
          const nodeBuffer = Buffer.from(chunk).toString();
          resolve(nodeBuffer);
        });
      });

      request.on("error", (error: any) => {
        console.log(`ERROR: ${JSON.stringify(error)}`);
        reject(error);
      });

      request.end();
    } catch (error) {
      console.log(`CATCH ERROR: ${JSON.stringify(error)}`);
      reject(error);
    }
  });
};

export const getFile = async (
  cid: string,
  ipfs_endpoint: string,
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let resolved = false;

    const headers = {
      // No need for specific content type for raw file retrieval
    };

    const hostname = fixEndpoint(ipfs_endpoint);
    const url = `https://${hostname}/api/v0/cat?arg=${cid}`;

    try {
      const request = https.request({
        method: "POST",
        protocol: "https:",
        hostname: hostname,
        port: 443,
        path: `/api/v0/cat?arg=${cid}`,
        headers,
      });

      request.on("response", (response: any) => {
        response.on("data", (chunk: any) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on("end", () => {
          if (!resolved) {
            resolved = true;
            const buffer = Buffer.concat(chunks);
            resolve(buffer);
          }
        });

        response.on("aborted", () => {
          if (!resolved) {
            resolved = true;
            reject(new Error("Response aborted"));
          }
        });

        response.on("error", (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      });

      request.on("error", (error: any) => {
        console.log(`ERROR: ${JSON.stringify(error)}`);
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      });

      request.end();
    } catch (error) {
      console.log(`CATCH ERROR: ${JSON.stringify(error)}`);
      reject(error);
    }
  });
};

// export const uploadDirectoryStructure = async (
//   files: { path: string; content: Buffer }[],
//   ipfs_endpoint: string,
// ): Promise<string> => {
//   return new Promise(async (resolve, reject) => {
//     try {
//       // Create a multipart form
//       let form = new Multipart();

//       // Add each file to the form
//       for (let file of files) {
//         // Convert Buffer to Readable stream which works better with form-data
//         const stream = fs.createReadStream(
//           Buffer.isBuffer(file.content)
//             ? Buffer.from(file.content)
//             : file.content,
//         );

//         form.append("file", stream, {
//           filename: file.path,
//         });
//       }

//       const formData = await form.buffer();
//       const boundary = form.getBoundary();

//       const headers = {
//         "Content-Type": `multipart/form-data; boundary=${boundary}`,
//       };

//       const request = net.request({
//         method: "POST",
//         protocol: "https:",
//         hostname: fixEndpoint(ipfs_endpoint),
//         port: 443,
//         path: "/api/v0/add?recursive=true&wrap-with-directory=true",
//         headers,
//       });

//       request.on("response", (response: any) => {
//         let data = "";

//         response.on("data", (chunk: any) => {
//           data += chunk.toString();
//         });

//         response.on("end", () => {
//           try {
//             const lines = data
//               .split("\n")
//               .filter((line) => line.trim().length > 0);
//             const lastLine = lines[lines.length - 1];
//             const result = JSON.parse(lastLine);
//             resolve(result.Hash);
//           } catch (error) {
//             console.log("Error parsing IPFS response:", error);
//             reject(new Error("Failed to parse IPFS response"));
//           }
//         });
//       });

//       request.on("error", (error: any) => {
//         console.log(`ERROR: ${JSON.stringify(error)}`);
//         reject(error);
//       });

//       // Write the binary buffer directly
//       request.write(formData);
//       request.end();
//     } catch (error) {
//       console.log(`Error in uploadDirectoryStructure: ${error}`);
//       reject(error);
//     }
//   });
// };

export const addFormData = async (
  multipart: Multipart,
  ipfs_endpoint: string,
): Promise<any> => {
  const body = await multipart.buffer();
  const boundary = multipart.getBoundary();

  const headers = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": body.length.toString(),
  };

  let res = await _genericCall(
    "/api/v0/add?recursive=true&wrap-with-directory=true",
    headers,
    body,
    ipfs_endpoint,
    parseLastLineOnly, // Pass the custom parser
  );

  return res;
};

export const addFilesInDir = async (
  files: string[],
  ipfs_endpoint: string,
): Promise<string> => {
  return new Promise(async (resolve, reject) => {
    let form = new Multipart();

    for (let path of files) {
      const buffer = fs.createReadStream(path);
      form.append("file", buffer, {
        filename: path.split("/").slice(-2).join("/"),
      });
    }

    const formData = await form.buffer();
    const boundary = form.getBoundary();

    const headers = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    const request = net.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint),
      path: "/api/v0/add?recursive=true&wrap-with-directory=true",
      headers,
    });
    request.on("response", (response: any) => {
      response.on("data", (chunk: any) => {
        const a = chunk
          .toString()
          .split("\n")
          .filter((x: string) => x.length > 0);
        // console.log(a)
        let parsnip = JSON.parse(a[a.length - 1]);

        resolve(parsnip["Hash"]);
      });
    });
    request.on("error", (error: any) => {
      console.log(`ERROR: ${JSON.stringify(error)}`);
      reject();
    });
    // Write the binary buffer directly
    request.write(formData);
    request.end();
  });
};

// Create a custom parser function for IPFS multi-line JSON response
const parseLastLineOnly = (text: string) => {
  // IPFS returns one JSON object per line
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return {}; // Empty response
  } else if (lines.length === 1) {
    // Single JSON object
    return JSON.parse(lines[0]);
  } else {
    // Multiple JSON objects - parse all but return the last one (root directory)
    const lastLine = lines[lines.length - 1];
    return JSON.parse(lastLine)["Hash"];
  }
};

const _genericCall = async (
  path: string,
  headers: any,
  body: any,
  ipfs_endpoint: string,
  responseParser?: (text: string) => any,
) => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let resolved = false;

    const request = https.request({
      method: "POST",
      protocol: "https:",
      hostname: fixEndpoint(ipfs_endpoint),
      path,
      headers,
    });

    request.on("response", (response) => {
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      response.on("end", () => {
        if (!resolved) {
          resolved = true;
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf-8"); // Convert buffer to string
          try {
            // If a custom parser is provided, use it
            if (responseParser) {
              resolve(responseParser(text));
            } else {
              // Default behavior - try to parse as single JSON
              resolve(JSON.parse(text));
            }
          } catch (e) {
            console.error("Failed to parse JSON response:", text);
            reject(e);
          }
        }
      });

      response.on("aborted", () => {
        console.log("aborted");
        if (!resolved) {
          resolved = true;
          reject(new Error("Response aborted"));
        }
      });

      response.on("error", (err) => {
        console.log("error");
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });

    request.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });

    // Write the body to the request if it exists
    if (body) {
      request.write(body);
    }

    request.end();
  });
};
