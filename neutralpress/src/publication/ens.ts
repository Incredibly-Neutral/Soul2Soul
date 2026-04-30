
import { ensSubdomainRegistryAbi } from "@s2s/soul2soul-shared";
import { IMainController } from "../main.ctrlr";
import { keccak256, toBytes } from "viem";

export const isAvailableEnsName = async (
	main: IMainController,
	tagName: string,
) => {
	
	const label = tagName.replace("--s2s", "");
	console.log("Contract:", main.plugin.settings.ens_registry);
	console.log("Label:", label);
	try {
		const result = await main.oxo.ctrlr.account["ETH_MAINNET"].genericRead(
			main.plugin.settings.ens_registry,
			JSON.stringify(ensSubdomainRegistryAbi),
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

    const nameWrapper = await main.oxo.ctrlr.account["ETH_MAINNET"].genericRead(
      main.plugin.settings.ens_registry,
      JSON.stringify([{
        "inputs": [],
        "name": "nameWrapper", 
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
      }]),
      "nameWrapper",
      []
    );

    const parentNode = await main.oxo.ctrlr.account["ETH_MAINNET"].genericRead(
      main.plugin.settings.ens_registry,
      JSON.stringify([{
        "inputs": [],
        "name": "parentNode",
        "outputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}],
        "stateMutability": "view", 
        "type": "function"
      }]),
      "parentNode",
      []
    );

    // Calculate subdomain token ID (same as node hash for NameWrapper)

    const subdomainLabel = keccak256(toBytes(subdomain));
    const subdomainNode = keccak256(`0x${parentNode.slice(2)}${subdomainLabel.slice(2)}`);

    // Get wrapped token owner
    const manager = await main.oxo.ctrlr.account["ETH_MAINNET"].genericRead(
      nameWrapper,
      JSON.stringify([{
        "inputs": [{"internalType": "uint256", "name": "id", "type": "uint256"}],
        "name": "ownerOf",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function"
      }]),
      "ownerOf",
      [subdomainNode]
    );

    return {
        addr : manager,
        chainId: 1 
    };
}
