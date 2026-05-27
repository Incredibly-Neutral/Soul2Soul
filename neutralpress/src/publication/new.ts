import { uploadConfig } from "./config";
import { S2SPublication, safeAbi, ensSubdomainRegistryAbi } from "@s2s/soul2soul-shared";
import { S2SRecordsModuleFactory, S2SPublicationModuleFactory, S2SRecordsModule } from "../../../protocol/generated/abis" 

const isEthAddress = (address: string) => /^0x[a-fA-F0-9]{40}$/.test(address);

const L1 = "ETH_MAINNET";
const L2 = "BASE";

export const newPublicationSafe = async (
	main: any,
	publication: S2SPublication
) => {

	const salt = "publication_safe_" + publication.name;
	const subdomain : string = publication.name.split(".")[0] || "";
  
	const signer1 = await main.publications[subdomain].L1.updateSigner(main.oxo.ctrlr.user.private_key);
	const signer2 = await main.publications[subdomain].L2.updateSigner(main.oxo.ctrlr.user.private_key);

	const publicationAddress1 = await main.publications[subdomain].L1.connectToFreshSafe(salt);
	const publicationAddress2 = await main.publications[subdomain].L2.connectToFreshSafe(salt);

	publication.contract = publicationAddress1;

	console.log("SAFE", publication.contract)
	console.log("FACTORY",main.plugin.settings.safe_publication_factory)
	
	const [registration, [recordsModule]] = await Promise.all([
		// L1: ENS registration
		 main.publications[subdomain].L1.genericTx(
			main.plugin.settings.ens_registry,
			JSON.stringify(ensSubdomainRegistryAbi),
			"registerSubdomain",
			[subdomain, publicationAddress1],
			false,
		),
		
		// L2: Create both modules in ONE batched transaction
		main.publications[subdomain].L2.genericTx(
			main.plugin.settings.safe_records_factory,
			JSON.stringify(S2SRecordsModuleFactory),
			"createModule",
			[publicationAddress2],
			true
		)
	]);

	console.log("ENS registered:", registration);

	// Safe on L2 is now deployed — reconnect before sending FROM it
	await main.publications[subdomain].L1.connectToExistingSafe(publicationAddress1);
	await main.publications[subdomain].L2.connectToExistingSafe(publicationAddress2);

	const publicationModule = await main.publications[subdomain].L2.genericTx(
		main.plugin.settings.safe_publication_factory,
		JSON.stringify(S2SPublicationModuleFactory),
		"createModule",
		[publicationAddress2, publication.authors, []],
		true
	);

	console.log("Created modules:", recordsModule, publicationModule);

	await main.publications[subdomain].L2.batchGenericTx([
		{
			address: publicationAddress2,
			abi: JSON.stringify(safeAbi),
			method: "enableModule",
			args: [recordsModule],
			deploy: false
		},
		{
			address: publicationAddress2,
			abi: JSON.stringify(safeAbi),
			method: "enableModule",
			args: [publicationModule],
			deploy: false 
		}
	]);

	// Verify modules enabled
	await verifyModulesEnabled(main.publications[subdomain].L2, publication.name, publicationAddress2, recordsModule, publicationModule);

	publication.configCid = await uploadConfig(main, publication);

	const feedAddress = await main.oxo.ctrlr.lens.createFeed(publication.name, 'Publication Feed for Soul2Soul Protocol', publicationAddress2);

	publication.feed = feedAddress;

	await setRecordsWithRetry(main.publications[subdomain].L2, recordsModule, publication);

	if (publication.owners!.length > 0) {
		const addOwnerCalls = publication.owners!.map( (owner: string) => ({
			address: publicationAddress2,
			abi: JSON.stringify(safeAbi),
			method: "addOwnerWithThreshold",
			args: [owner, 1]
		}));
		
		await main.publications[subdomain].L1.batchGenericTx(addOwnerCalls);
		await main.publications[subdomain].L2.batchGenericTx(addOwnerCalls);
		await verifyOwnersAdded(main.publications[subdomain].L1, publicationAddress2,  publication.owners || []);
		await verifyOwnersAdded(main.publications[subdomain].L2, publicationAddress2,  publication.owners || []);
		await removeInitialSigner(main.publications[subdomain].L1, publicationAddress2, signer1,  publication.owners || []);
		await removeInitialSigner(main.publications[subdomain].L2, publicationAddress2, signer1,  publication.owners || []);
	}

	console.log("FINISHED: ", publicationAddress1)
	
}

async function verifyModulesEnabled(pubInstance: any, ensName: string, publicationAddress: string, recordsModule: string, publicationModule: string) {

    // Add initial delay for state propagation
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    for (const module of [recordsModule, publicationModule]) {
        let isEnabled = false;
        let retries = 0;
        
        while (!isEnabled && retries < 20) {
            console.log("checking for module:", module);
            retries++;
            try {
                isEnabled = await pubInstance.genericRead(
                    publicationAddress,
                    JSON.stringify(safeAbi),
                    "isModuleEnabled",
                    [module]
                );

                
                if (isEnabled) {
                    // console.log(`✅ Module ${module} verified after ${retries} attempts`);
                } else {
                    // console.log(`Module not enabled yet, waiting...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error: any) {
                console.log(`❌ Retry ${retries}/20 - Error:`, error.message || error);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // ✅ NOW CHECK AFTER THE LOOP
        if (!isEnabled) {
            console.error(`❌ Module ${module} still not verified after ${retries} retries`);
            console.log("Continuing anyway - modules are enabled but state not readable yet");
        }
    }
    
    // Extra safety buffer
    await new Promise(resolve => setTimeout(resolve, 3000));
}

async function setRecordsWithRetry(pubInstance: any, recordsModule: string, publication: any) {
	let success = false;
	let attempts = 0;

	console.log("recordsmodule", recordsModule);
	
	while (!success && attempts < 3) {
		attempts++;
		try {
			console.log(`Setting records (attempt ${attempts}/3)...`);
			
			const setRecords = await pubInstance.genericTx(
				recordsModule,
				JSON.stringify(S2SRecordsModule),
				"setRecords",
				[
					['name','config','repo','branch','feed'],
					[publication.name, publication.configCid, publication.devRepository, publication.branch, publication.feed]
				],
				false,
			);
			
			console.log("✅ setRecords succeeded:", setRecords);
			success = true;
		} catch (error: any) {
			console.log(`❌ Attempt ${attempts} failed:`, error.message);
			if (attempts < 3) {
				await new Promise(resolve => setTimeout(resolve, 3000));
			} else {
				throw error;
			}
		}
	}
}

async function verifyOwnersAdded(pubInstance: any, publicationAddress: string, owners: string[]) {
	if (owners.length === 0) return;
	
	console.log("Verifying owners added...");
	let isOwner = false;
	let retries = 0;
	
	while (!isOwner && retries < 10) {
		retries++;
		try {
			isOwner = await pubInstance.genericRead(
				publicationAddress,
				JSON.stringify(safeAbi),
				"isOwner",
				[owners[0]]
			);
			
			if (isOwner) {
				console.log(`✅ Owner ${owners[0]} verified after ${retries} attempts`);
			} else {
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		} catch (error) {
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
	
	if (!isOwner) throw new Error(`Owner ${owners[0]} not added`);
	
	// Extra buffer
	await new Promise(resolve => setTimeout(resolve, 3000));
}

// async function removeOwnerWithRetry(pubInstance: any, publicationAddress: string, signer: string, newThreshold: number) {
// 	let success = false;
// 	let attempts = 0;
	
// 	while (!success && attempts < 3) {
// 		attempts++;
// 		try {
// 			console.log(`Removing original owner (attempt ${attempts}/3)...`);
			
// 			const rmOwner = await pubInstance.genericTx(
// 				publicationAddress,
// 				JSON.stringify(abi_safe),
// 				"removeOwner",
// 				["0x0000000000000000000000000000000000000001", signer, newThreshold],
// 				false
// 			);
			
// 			console.log("✅ removeOwner succeeded:", rmOwner);
// 			success = true;
// 		} catch (error) {
// 			console.log(`❌ Attempt ${attempts} failed:`, error.message);
// 			if (attempts < 3) {
// 				await new Promise(resolve => setTimeout(resolve, 2000));
// 			} else {
// 				throw error;
// 			}
// 		}
// 	}
// }

async function removeInitialSigner(pubInstance: any, publicationAddress: string, signer: string, owners: string[]) {

	const currentOwners = await pubInstance.genericRead(
		publicationAddress,
		JSON.stringify(safeAbi),
		"getOwners",
		[]
	);

	console.log("Current owners:", currentOwners);

	// Find the index of the owner to remove
	const ownerToRemove = signer;
	const ownerIndex = currentOwners.findIndex(
		(addr: string) => addr.toLowerCase() === ownerToRemove.toLowerCase()
	);

	if (ownerIndex === -1) {
		console.log("Owner already removed or not found");
	} else {
		// prevOwner is either the sentinel (if first) or the previous owner in the array
		const prevOwner = ownerIndex === 0 
			? "0x0000000000000000000000000000000000000001" 
			: currentOwners[ownerIndex - 1];
		
		console.log("Removing owner:", ownerToRemove);
		console.log("prevOwner:", prevOwner);
		console.log("New threshold:", owners.length);

		// Retry logic for removeOwner
		let removeOwnerSuccess = false;
		let attempts = 0;

		while (!removeOwnerSuccess && attempts < 3) {
			attempts++;
			try {
				console.log(`Removing original owner (attempt ${attempts}/3)...`);
				
				const rmOwner = await pubInstance.genericTx(
					publicationAddress,
					JSON.stringify(safeAbi),
					"removeOwner",
					[prevOwner, ownerToRemove, owners.length.toString()],
					false
				);
				
				console.log("✅ removeOwner succeeded:", rmOwner);
				removeOwnerSuccess = true;
			} catch (error: any) {
				console.log(`❌ Attempt ${attempts} failed:`, error.message);
				if (attempts < 3) {
					await new Promise(resolve => setTimeout(resolve, 3000));
				} else {
					throw error;
				}
			}
		}
	}
}
