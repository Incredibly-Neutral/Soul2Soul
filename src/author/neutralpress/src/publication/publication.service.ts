import { IMainController } from "../main.ctrlr";
import { newPublicationSafe } from "./new";

import { getPublicationMultiSig } from "./ens";
import { S2SPublication, safeAbi, isPublicationModuleName } from "@s2s/soul2soul-shared";
import { S2SPublicationModuleV2 } from "@s2s/publication-contracts"
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

/**
 * The three reads a CREATE2 module factory answers, as its source defines them
 * (`src/publication/contracts/src/S2SPublicationModuleV4Create2Factory.sol`).
 *
 * Kept inline rather than taken from `@s2s/publication-contracts/abis`: these
 * three are all this service touches, and viem wants the parsed shape the
 * generated module also exports (the same trio, in another package).
 *
 * What this resolver relies on, and the source says:
 *  - moduleAddress(safe) is the module the factory already recorded for that
 *    Safe when it has one, and the address createModule(safe, …) would deploy
 *    at otherwise. It names a create that has not happened only for a Safe with
 *    no module, and only that answer moves when the protocol Safe calls
 *    setImplementation.
 *  - moduleAddressForVersion(safe, version) is 1-based over
 *    implementationHistory and reverts InvalidVersion outside 1..implementationCount().
 *  - The address does not depend on the create's arguments: the factory
 *    constructs the proxy with empty initializer data and calls
 *    initialize(safe, authors, devs) on it afterwards, so the authors array
 *    cannot move it.
 *
 * An older factory answers none of them: the call reverts, and that revert is
 * the signal to fall back to the NAME() scan.
 */
const create2FactoryAbi = [
	{ "inputs": [{ "internalType": "address", "name": "safe", "type": "address" }], "name": "moduleAddress", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
	{ "inputs": [{ "internalType": "address", "name": "safe", "type": "address" }, { "internalType": "uint256", "name": "version", "type": "uint256" }], "name": "moduleAddressForVersion", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
	{ "inputs": [], "name": "implementationCount", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
];

const isModuleAddress = (value: unknown): value is string =>
	typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);

/**
 * The module an existing publication lives at, per the CREATE2 factory.
 *
 * `moduleAddress(safe)` names the module the factory recorded for this Safe, or
 * the create that has not happened yet when it has none, so it is only
 * meaningful once code sits there; a publication made under an earlier
 * implementation is named by `moduleAddressForVersion(safe, version)`, tried
 * newest first. `undefined` means this factory cannot answer for this Safe — a
 * pre-CREATE2 factory, or a module from a plain-CREATE generation — and the
 * caller falls back to the NAME() scan.
 */
const predictPublicationModule = async (main: IMainController, safe: string): Promise<string | undefined> => {
	const factory = main.protocolInfo?.publicationFactory;
	if (!factory || !isModuleAddress(safe)) return undefined;

	const hasCode = async (address: string): Promise<boolean> => {
		try {
			const code = await main.oxo.ctrlr.viem.publicClient.getCode({ address: address as `0x${string}` });
			return !!code && code !== '0x';
		} catch {
			return false;
		}
	};

	// A revert on moduleAddress IS the answer: this factory predates the create2
	// views, so stop here instead of spending an implementationCount read and up
	// to eight reverted moduleAddressForVersion calls before the NAME() scan.
	let next: unknown;
	try {
		next = await readL2(main, factory, create2FactoryAbi, 'moduleAddress', [safe]);
	} catch {
		return undefined;
	}
	if (isModuleAddress(next) && await hasCode(next)) return next;

	let count = 0;
	try {
		count = Number(await readL2(main, factory, create2FactoryAbi, 'implementationCount', []));
	} catch {
		return undefined;
	}
	if (!Number.isFinite(count) || count < 1) return undefined;

	// 1-based over implementationHistory, reverting outside 1..count.
	const floor = Math.max(1, count - 7);
	for (let version = count; version >= floor; version--) {
		let address: unknown;
		try {
			address = await readL2(main, factory, create2FactoryAbi, 'moduleAddressForVersion', [safe, version]);
		} catch {
			continue;
		}
		if (isModuleAddress(address) && await hasCode(address)) return address;
	}
	return undefined;
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
	 * Retract — the AUTHOR's verb, sent by the author Safe (the genesis author).
	 * V3 makes it terminal: on an agreement it sets `_ended`, tombstones the
	 * latest version and drops the agreement, so `makeOffer`/`admit` revert
	 * `Ended()` afterwards; on a bare offer it just withdraws the offer.
	 *
	 * The publication's own takedown is a different verb — `reject` — and it is
	 * reversible. Do not use this from the publication Safe: it reverts
	 * `NotAuthorized()`.
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

		// Prediction first: a CREATE2 factory names the module this publication
		// lives at, which does not depend on the module list being readable. It is
		// accepted only when the Safe still LISTS it — a module disabled by a
		// teardown stays deployed, and every write to it would revert.
		// The prediction is held aside and applied after the scan: the scan keeps
		// its own tie-break (last publication module listed wins) so a factory
		// that answers nothing changes nothing, and the confirmed prediction is
		// not overwritten by the scan either.
		const predicted = await predictPublicationModule(this.main, this.multisig);
		const predictedModule =
			predicted && (modules[0] as string[]).some((m: string) => (m ?? '').toLowerCase() === predicted.toLowerCase())
				? predicted
				: undefined;

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
					} else if (isPublicationModuleName(moduleName)) {
					  // Any version: V1/V2 publications still serve reads and author writes.
					  publicationModule = moduleAddress;
					} 
				} catch (error) {
					// console.log("Module doesn't have NAME() function");
				}
				
			} catch (error) {
				// console.log("Error checking module:", moduleAddress, error.message);
			}
		}

		if (predictedModule) publicationModule = predictedModule;

		return { configModule, publicationModule } 
	}

}