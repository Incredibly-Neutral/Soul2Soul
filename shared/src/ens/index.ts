import { ensRegistryABI, resolverABI } from "./abi";
import * as ethers from "ethers";
import { Provider } from 'ethers';

const ENSREGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

export const getContractAddressFromEnsName = async (ensName: string, ethersV6Provider: Provider) => {
  try {
    const node = ethers.namehash(ensName);

    // const ensProvider = new ethers.JsonRpcProvider(
    //   `https://eth-sepolia.g.alchemy.com/v2/${alchemy_key}`,
    //   { chainId: 11155111, name: "sepolia" },
    // );

    const registry = new ethers.Contract(
      ENSREGISTRY,
      ensRegistryABI,
      ethersV6Provider,
    );

    const resolverAddress = await registry.resolver(node);

    const resolver = new ethers.Contract(
      resolverAddress,
      resolverABI,
      ethersV6Provider,
    );

    return await resolver.text(node, "contract.address");
  } catch (error) {
    console.error("Error getting contract address:", error);
    return "false";
  }
};


