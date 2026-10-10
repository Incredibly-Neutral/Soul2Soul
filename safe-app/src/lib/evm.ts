import { CID } from "multiformats";
import { ethers } from "ethers";
declare global {
  const Lit: any;
}

// Keyless fallbacks. We must NOT fall back to `lb.drpc.live/.../default`:
// DRPC retired that keyless endpoint and now rejects it with "Your token is
// invalid or expired" (error code 4), which kills every RPC read (Safe SDK
// init, module discovery, records) in a build made without VITE_DRPC_API_KEY.
// Use working public RPCs instead so a keyless build degrades, not dies.
const PUBLIC_RPCS: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
};

export const getRpcUrl = (chainId: number): string  => {
    const apiKey = import.meta.env.VITE_DRPC_API_KEY;

    if (apiKey) {
      switch (chainId) {
        case 1:
          return `https://lb.drpc.live/ethereum/${apiKey}`;
        case 8453:
          return `https://lb.drpc.live/base/${apiKey}`;
      }
    }

    return PUBLIC_RPCS[chainId] ?? '';
  }

const evmSetup = (contractAddress: string, abi: any, chainId: number) => {

  const rpc = getRpcUrl(chainId)
  const provider = new ethers.JsonRpcProvider(rpc);

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
