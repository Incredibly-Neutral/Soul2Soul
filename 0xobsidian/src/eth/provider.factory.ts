import { ethers } from "ethers5";

export const getProvider = (
  chain: string = "BASE_SEPOLIA",
  alchemy_key?: string,
) => {
  let provider;

  switch (chain) {
    case "ETH_MAINNET":
      provider = ethers.getDefaultProvider(
        "https://eth-mainnet.g.alchemy.com/v2/" + alchemy_key,
        {
          alchemy: alchemy_key,
        },
      );
      break;

    case "SEPOLIA":
      provider = ethers.getDefaultProvider(
        // "https://eth-sepolia.g.alchemy.com/v2/" + alchemy_key,
        "https://sepolia.infura.io/v3/5588b2f2645b47bf9d9df736ab328181",
        {
          alchemy: alchemy_key,
        },
      );
      break;

    case "ARB_SEPOLIA":
      provider = ethers.getDefaultProvider(
        "https://arb-sepolia.g.alchemy.com/v2/" + alchemy_key,
        {
          alchemy: alchemy_key,
        },
      );
      break;

    case "BASE_SEPOLIA":
      provider = ethers.getDefaultProvider(
        "https://base-sepolia.g.alchemy.com/v2/" + alchemy_key,
        {
          alchemy: alchemy_key,
        },
      );
      break;

    case "GNOSIS_CHAIN":
      provider = ethers.getDefaultProvider(
        "https://rpc.gnosischain.com", // https://rpc.gnosis.gateway.fm
      );
      break;

    case "CRONICLE_YELLOWSTONE":
      provider = ethers.getDefaultProvider(
        "https://yellowstone-rpc.litprotocol.com/",
      );
      break;

    default:
      provider = ethers.getDefaultProvider(
        "https://arb-sepolia.g.alchemy.com/v2/" + alchemy_key,
        {
          alchemy: alchemy_key,
        },
      );
  }

  return provider;
};

export const getRPC = (chain: string, alchemy_key: string): string => {
  let rpc;

  switch (chain) {
    case "ETH_MAINNET":
      rpc = `https://eth-mainnet.g.alchemy.com/v2/${alchemy_key}`;
      break;

    case "SEPOLIA":
      // rpc = `https://eth-sepolia.g.alchemy.com/v2/${alchemy_key}`;
      rpc = "https://sepolia.infura.io/v3/5588b2f2645b47bf9d9df736ab328181";
      break;

    case "ARB_SEPOLIA":
      rpc = `https://arb-sepolia.g.alchemy.com/v2/${alchemy_key}`;
      break;

    case "BASE_SEPOLIA":
      rpc = `https://base-sepolia.g.alchemy.com/v2/${alchemy_key}`;
      break;

    default:
      rpc = `https://arb-sepolia.g.alchemy.com/v2/${alchemy_key}`;
  }

  return rpc;
};
