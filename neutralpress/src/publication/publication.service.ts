import { IMainController } from "../main.ctrlr";
import { newPublicationSafe } from "./new";

import { getPublicationMultiSig } from "./ens";
import { S2SPublication, safeAbi } from "@s2s/soul2soul-shared";
import { S2SPublicationModuleV2 } from "../../../protocol/contracts/generated/abis"
import { toBytes32Id } from '@s2s/soul2soul-shared'; 

const L1 = "ETH_MAINNET";
const L2 = "BASE";

export interface IPublicationSrv {
	main: IMainController;
	new: (
		main: IMainController,
		name: string,
		owners: string[],
		authors: string[],
		devRepository: string,
		commit: string,
	) => void;
	makeOffer: (genesis: string, cid: string) => Promise<any>;
	retract: (genesis: string) => Promise<any>;
	getMultiSig: () => Promise<string>;
	publicationModule: string
}

/**
 * Read from a BASE contract via the ViemService (which wraps a viem publicClient).
 * Replaces the old L2.genericRead() calls. The ViemService takes parsed ABI (not string).
 */
const readL2 = async (main: IMainController, address: string, abi: any[], functionName: string, args: any[] = []): Promise<any> => {
	return main.oxo.ctrlr.viem.read(address as `0x${string}`, abi, functionName, args);
};

export class PublicationService implements IPublicationSrv{
	main: IMainController;
	subdomain: string;
	multisig!: string;
	configModule!: string;
	publicationModule!: string;
	L1: any;
	L2: any;

	constructor(main: IMainController, subdomain: string) {
		this.main = main;
		this.subdomain = subdomain;
		this.L1 = this.main.oxo.ctrlr.safeInstance(L1);
		this.L2 = this.main.oxo.ctrlr.safeInstance(L2);
	}

	async init() {
		const { addr, chainId } = await getPublicationMultiSig(this.main, this.subdomain);
 		this.multisig = addr;
		const { configModule, publicationModule } = await this.getModuleAdresses();
		this.configModule = configModule;
		this.publicationModule = publicationModule
	}

	async new(main: IMainController, ensName: string, owners: string[], authors: string[], devRepository: string, branch: string) {
		let publication: S2SPublication = {
			name: ensName,
			owners,
			authors,
			contract: undefined,
			configCid: undefined,
			feed: undefined,
			devRepository,
			branch,
		};
		newPublicationSafe(main, publication)
	}

	/**
	 * Make an offer (or deal, if whitelisted). This is the single author write.
	 * Whitelisted author / safe → appends to the log and becomes a deal immediately.
	 * Anyone else → appended to the log as a pending offer.
	 * genesis: toBytes32Id of the document's persistent identity (first objectId).
	 * cid: root CID from the Filecoin/Kubo storage pipeline.
	 */

	

	async makeOffer(genesis: string, cid: string) {
	  return await this.main.oxo.ctrlr.account[L2].genericTx(
	    this.publicationModule,
	    JSON.stringify(S2SPublicationModuleV2),
	    "makeOffer",
	    [toBytes32Id(genesis), cid],
	    false,
	  );
	}

	/**
	 * Retract — asymmetric by caller:
	 *   author → full withdrawal (removed from deals and/or offers)
	 *   safe   → demotes deal back to offer, or rejects an offer
	 */
	async retract(genesis: string) {
	  return await this.main.oxo.ctrlr.account[L2].genericTx(
	    this.publicationModule,
	    JSON.stringify(S2SPublicationModuleV2),
	    "retract",
	    [toBytes32Id(genesis)],
	    false,
	  );
	}

	async getMultiSig() {
		return this.multisig;
	}

	async getModuleAdresses() {
		let configModule, publicationModule; 

		const modules = await readL2(
			this.main,
			this.multisig,
			safeAbi,
			"getModulesPaginated",
			["0x0000000000000000000000000000000000000001", "10"]
		);

		for (let moduleAddress of modules[0]) {
			try {
				let moduleName;
				try {
					moduleName = await readL2(
						this.main,
						moduleAddress,
						[{ "inputs": [], "name": "NAME", "outputs": [ { "internalType": "string", "name": "", "type": "string" } ], "stateMutability": "view", "type": "function" }],
						"NAME",
						[]
					);
					
					if (moduleName === "S2S Records Module") {
						configModule = moduleAddress;
					} else if (
					  moduleName === "S2S Publication Module V2" ||
					  moduleName === "S2S Publication Module"   // keep for backwards compat
					) {
					  publicationModule = moduleAddress;
					} 
				} catch (error) {
					// console.log("Module doesn't have NAME() function");
				}
				
			} catch (error) {
				// console.log("Error checking module:", moduleAddress, error.message);
			}
		}

		return { configModule, publicationModule } 
	}

}