import { CID } from "multiformats";
import { ALCHEMY_KEY } from "./constants";
import { ethers } from "ethers";
declare global {
  const Lit: any;
}

const evmSetup = (contractAddress: string, abi: any, chainId: number) => {


  let provider;
  const apiKey = import.meta.env.VITE_DRPC_API_KEY || 'default';

  switch(chainId) {

    case 1:
      provider = new ethers.JsonRpcProvider(`https://lb.drpc.live/ethereum/${apiKey}`);

    break;

    case 8453:
      provider = new ethers.JsonRpcProvider(`https://lb.drpc.live/base/${apiKey}`);

    break; 

  }


  const contract = new ethers.Contract(
    contractAddress,
    abi,
    provider
  );

  return { provider, contract };
};

export const evmRead = async (
  chainId: number,
  contractAddress: string,
  abi: any,
  method: string,
  args: any[]
) => {
  const { provider, contract } = evmSetup(contractAddress, abi, chainId);
  return await contract[method](...args);
};

export const toHexString = (_cid: string) => {

    const cid = CID.parse(_cid);

    const contenthashBytes = new Uint8Array([
      0xe3, // ipfs-ns multicodec
      0x01, // version
      ...cid.bytes
    ]);
    
    return '0x' + Array.from(contenthashBytes)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
}
