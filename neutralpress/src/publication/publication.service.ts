import { IMainController } from "../main.ctrlr";
import { newPublicationSafe } from "./new";

import { getPublicationMultiSig } from "./ens";
import { S2SPublication, publicationModuleAbi, recordsModuleAbi, recordsModuleFactoryAbi, safeAbi } from "@s2s/soul2soul-shared";

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

export class PublicationService implements IPublicationSrv{
	main: IMainController;
	subdomain: string;
	multisig: string;
	configModule: string;
	publicationModule: string;
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

	async grantLicense(stream_id: string) {
	
		return await this.main.oxo.ctrlr.account[L2].genericTx(
			this.publicationModule,
			JSON.stringify(publicationModuleAbi),
			"grantLicense",
			[this.publicationModule,stream_id],
			false,
		);
	}

	async revokeLicense(stream_id: string) {
		return await this.main.oxo.ctrlr.account[L2].genericTx(
			this.publicationModule,
			JSON.stringify(publicationModuleAbi),
			"revokeLicense",
			[stream_id],
			false,
		);
	}


	async isLicensed(stream_id: string) {

		return await this.main.oxo.ctrlr.account[L2].genericRead(
			this.publicationModule,
			JSON.stringify(publicationModuleAbi),
			"isLicensed",
			[stream_id],
			false,
		);
	}

	async isLicensedBatch(
		stream_ids: string[],
	): Promise<Record<string, boolean>> {
		const results = await this.main.oxo.ctrlr.account[L2].genericRead(
			this.publicationModule,
			JSON.stringify(publicationModuleAbi),
			"isLicensedBatch",
			[stream_ids],
			false,
		);

		// Convert the array of booleans to a Record<string, boolean>
		const dealRecord: Record<string, boolean> = {};
		for (let i = 0; i < stream_ids.length; i++) {
			dealRecord[stream_ids[i]] = results[i];
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

		const modules = await this.L2.genericRead(
			this.multisig,
			JSON.stringify(safeAbi),
			"getModulesPaginated",
			["0x0000000000000000000000000000000000000001", "10"]
		)


		for (let moduleAddress of modules[0]) {
			try {
				

				let moduleName;
				try {
					moduleName = await this.L2.genericRead(
						moduleAddress,
						'[{ "inputs": [], "name": "NAME", "outputs": [ { "internalType": "string", "name": "", "type": "string" } ], "stateMutability": "view", "type": "function" }]', 
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

		return  await this.L2.genericRead(
			this.configModule,
			JSON.stringify(recordsModuleAbi),
			"getRecord",
			["feed"]  
		);
	}
}
