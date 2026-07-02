import { IMainController } from "../main.ctrlr";
import { newPublicationSafe } from "./new";

import { getPublicationMultiSig } from "./ens";
import { S2SPublication, safeAbi } from "@s2s/soul2soul-shared";
import { S2SRecordsModuleFactory, S2SPublicationModuleFactory, S2SPublicationModule, S2SRecordsModule} from "../../../protocol/contracts/generated/abis" 

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
	grantLicense: (stream_id: string) => Promise<any>;
	isLicensed: (stream_id: string) => Promise<boolean>;
	isLicensedBatch: (
		stream_ids: string[],
	) => Promise<Record<string, boolean>>;
	revokeLicense: (stream_id: string) => Promise<any>;
	getPublicationMultiSigAddresses: (tags: string[]) => Promise<string>;
	getMultiSig: () => Promise<string>;
	getPublicationFeedAddress: () => Promise<string>;
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

	async grantLicense(contentId: string) {
		return await this.main.oxo.ctrlr.account[L2].genericTx(
			this.publicationModule,
			JSON.stringify(S2SPublicationModule),
			"grantLicense",
			[this.publicationModule,contentId],
			false,
		);
	}

	/**
	 * Append a version to a genesis document on the V2 publication module.
	 * genesis and objectId are both content-derived hashes (bytes32).
	 * cid is the root CID from the Filecoin/Kubo storage pipeline.
	 */
	async append(genesis: string, objectId: string, cid: string) {
		// Use the V2 ABI — same function signature as grantLicense for now
		// TODO: import V2 ABI once compiled
		return await this.main.oxo.ctrlr.account[L2].genericTx(
			this.publicationModule,
			JSON.stringify(S2SPublicationModule),
			"append",
			[genesis, objectId, cid],
			false,
		);
	}

	async revokeLicense(contentId: string) {
		return await this.main.oxo.ctrlr.account[L2].genericTx(
			this.publicationModule,
			JSON.stringify(S2SPublicationModule),
			"revokeLicense",
			[contentId],
			false,
		);
	}

	async isLicensed(contentId: string) {
		return await readL2(
			this.main,
			this.publicationModule,
			S2SPublicationModule,
			"isLicensed",
			[contentId],
		);
	}

	async isLicensedBatch(
		contentIds: string[],
	): Promise<Record<string, boolean>> {
		const results = await readL2(
			this.main,
			this.publicationModule,
			S2SPublicationModule,
			"isLicensedBatch",
			[contentIds],
		);

		// Convert the array of booleans to a Record<string, boolean>
		const dealRecord: Record<string, boolean> = {};
		for (let i = 0; i < contentIds.length; i++) {
			dealRecord[contentIds[i]] = results[i];
		}
		return dealRecord;
	}

	async getMultiSig() {
		return this.multisig;
	}

	async getPublicationMultiSigAddresses(tags: string[]) {
		for (const tag of tags) {
			if (tag.contains("--s2s")) {
				const { addr } = await getPublicationMultiSig(
					this.main,
					tag.replace("--s2s", ".soul2soul.eth"),
				);
				if (addr) {
					return addr;
				}
			}
		}
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
					} else if (moduleName === "S2S Publication Module") {
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

	async getPublicationFeedAddress() {
		return await readL2(
			this.main,
			this.configModule,
			S2SRecordsModule,
			"getRecord",
			["feed"]  
		);
	}
}