import { ensRegistryABI, resolverABI } from "./abi";
import * as ethers5 from "ethers5";

const ALCHEMY_KEY = process.env.ALCHEMY_KEY;

export const getContractAddress = async (ensName: string) => {
  try {
    const node = ethers5.utils.namehash(ensName);

    const ensProvider = new ethers5.providers.JsonRpcProvider(
      `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      { chainId: 11155111, name: "sepolia" },
    );

    const registry = new ethers5.Contract(
      "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e", // ENS Registry
      ensRegistryABI,
      ensProvider,
    );

    const resolverAddress = await registry.resolver(node);

    const resolver = new ethers5.Contract(
      resolverAddress,
      resolverABI,
      ensProvider,
    );

    return await resolver.text(node, "contract.address");
  } catch (error) {
    console.error("Error getting contract address:", error);
    return "false";
  }
};
