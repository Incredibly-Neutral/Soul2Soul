import Multipart from "./multi-part-lite-adopted/main.js";

import {
  dagGet,
  dagPut,
  add,
  addRecursive,
  getRecursive,
  getJsonLike,
  getFile,
  addFilesInDir,
  addFile,
  pinFile,
  addAsFolder,
  addFileFromUrl,
  addFormData,
} from "./remotekubo.service.js";

export interface IpfsCtrlr {
  add: (note: string, ipfs_endpoint: string) => Promise<string>;
  addFile: (path: string, ipfs_endpoint: string) => Promise<string>;
  addFileFromUrl: (
    url: string,
    ipfs_endpoint: string,
    onlyHash?: boolean,
  ) => Promise<string>;
  addFilesInDir: (files: string[], ipfs_endpoint: string) => Promise<string>;
  addRecursive: (sourcePath: string, ipfs_endpoint: string) => Promise<string>;
  addAsFolder: (assets: any[], ipfs_endpoint: string) => Promise<string>;
  addFormData: (formData: Multipart, ipfs_endpoint: string) => Promise<string>;
  dagGet: (cid: string, ipfs_endpoint: string) => Promise<string>;
  dagPut: (note: string, ipfs_endpoint: string) => Promise<string>;
  getFile: (
    cid: string,
    ipfs_endpoint: string,
  ) => Promise<Buffer<ArrayBufferLike>>;
  getRecursive: (
    cid: string,
    ipfs_endpoint: string,
  ) => Promise<Buffer<ArrayBufferLike>>;
  getJsonLike: (cid: string, ipfs_endpoint: string) => Promise<Buffer>;
  pinFile: (cid: string, ipfs_endpoint: string) => Promise<string>;
}

export const ipfsController: IpfsCtrlr = {
  add,
  addFile,
  addFileFromUrl,
  addFilesInDir,
  addRecursive,
  addAsFolder,
  addFormData,
  dagGet,
  dagPut,
  getJsonLike,
  getRecursive,
  getFile,
  pinFile,
};
