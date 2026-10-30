import { mainnet, sepolia, base, baseSepolia, gnosis } from "viem/chains";

export const getViemChainByName = (chainName: string)  => {

    switch (chainName) {
      case "ETH_MAINNET":
        return mainnet;
      case "SEPOLIA":
        return sepolia;
      case "BASE":
        return base;
      case "BASE_SEPOLIA":
        return baseSepolia;
      case "GNOSIS_CHAIN":
        return gnosis;
      default:
        return mainnet;
    }
  }

export const getViemChainById = (id: number)  => {

    switch (id) {
      case 1:
        return mainnet;
      case 11155111:
        return sepolia;
      case 8453:
        return base;
      case 84532:
        return baseSepolia;
      case 100:
        return gnosis;
      default:
        return mainnet;
    }
  }

export const getChainName = (chainId: number): string => {
    // Reverse lookup from chainId to chain name
    switch (chainId) {
      case 1: return "ETH_MAINNET";
      case 11155111: return "SEPOLIA";
      case 8453: return "BASE";
      case 84532: return "BASE_SEPOLIA";
      case 100: return "GNOSIS_CHAIN";
      default: return "ETH_MAINNET";
    }
}

  // Helper methods (keep your existing chain management)
export const getChainId = (chain: string): number => {
    switch (chain) {
      case "ETH_MAINNET": return 1;
      case "SEPOLIA": return 11155111;
      case "BASE": return 8453;
      case "BASE_SEPOLIA": return 84532;
      case "GNOSIS_CHAIN": return 100;
      default: return 1;
    }
}

export const getNetwork = (chainId: number)  => {

  let network;

  switch (chainId) {
    case 1:
      network = {
        chainId:  chainId,
        name: "ethereum"
      }
      break;
    case 8453:
      network = {
        chainId:  chainId,
        name:  "base"
      }
      break;
  }

  return network;
}

export const getRPCUrl = (chainId: number, api_key: string): string => {
  let rpc;

  switch (chainId) {
    case 1:
      rpc = `https://lb.drpc.live/ethereum/${api_key}`;
      break;

    case 11155111:
      rpc = `https://lb.drpc.live/sepolia/${api_key}`;
      break;

    case 8453:
      rpc = `https://lb.drpc.live/base/${api_key}`;
      break;

    case 84532:
      rpc = `https://lb.drpc.live/base-sepolia/${api_key}`;
      break;

    case 175188:
      rpc = "https://yellowstone-rpc.litprotocol.com/";
      break;

  }

  return rpc!;
};

export const getScanApi = (chainId: number): string => {

    if (chainId === 8453) {
      return `https://basescan.org/api`;  // Basescan V2-compatible (no chainid param needed)
    }  

    return `https://api.etherscan.io/v2/api?chainid=` + chainId;
}
