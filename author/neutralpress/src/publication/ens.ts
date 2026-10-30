import { ensSubdomainRegistryAbi } from "@s2s/soul2soul-shared";
import { IMainController } from "../main.ctrlr";
import { keccak256, toBytes } from "viem";

/**
 * Read from the ENS registry contract on ETH_MAINNET via the account's publicClient.
 * The ViemService in 0xobsidian only covers BASE; for L1 ENS reads we use the account directly.
 */
const readEns = async (main: IMainController, address: string, abi: any[], functionName: string, args: any[] = []): Promise<any> => {
    return main.oxo.ctrlr.account["ETH_MAINNET"].publicClient.readContract({
        address: address as `0x${string}`,
        abi,
        functionName,
        args,
    });
};

export const isAvailableEnsName = async (
	main: IMainController,
	tagName: string,
) => {
	
	const label = tagName.replace("--s2s", "");
	console.log("Contract:", main.plugin.settings.ens_registry);
	console.log("Label:", label);
	try {
		const result = await readEns(
			main,
			main.plugin.settings.ens_registry,
			ensSubdomainRegistryAbi,
			"isSubdomainAvailable",
			[label],
		);
		console.log("Result:", result);
		return result;
	} catch (error) {
		console.error("Contract error:", error);
		throw error;
	}
};

export const getPublicationMultiSig = async (main: IMainController, subdomain: string) => {

  console.log('debug', subdomain)

    const nameWrapper = await readEns(
      main,
      main.plugin.settings.ens_registry,
      [{
        "inputs": [],
        "name": "nameWrapper", 
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
      }],
      "nameWrapper",
      []
    );

    const parentNode = await readEns(
      main,
      main.plugin.settings.ens_registry,
      [{
        "inputs": [],
        "name": "parentNode",
        "outputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}],
        "stateMutability": "view", 
        "type": "function"
      }],
      "parentNode",
      []
    );

    // Calculate subdomain token ID (same as node hash for NameWrapper)
    const subdomainLabel = keccak256(toBytes(subdomain));
    console.log(
      "DEBUG", parentNode, subdomainLabel
    )
    const subdomainNode = keccak256(`0x${parentNode.slice(2)}${subdomainLabel.slice(2)}`);

    // Get wrapped token owner
    const manager = await readEns(
      main,
      nameWrapper,
      [{
        "inputs": [{"internalType": "uint256", "name": "id", "type": "uint256"}],
        "name": "ownerOf",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
      }],
      "ownerOf",
      [subdomainNode]
    );

    return {
        addr : manager,
        chainId: 1 
    };
}