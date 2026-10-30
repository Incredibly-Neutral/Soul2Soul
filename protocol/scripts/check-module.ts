import {createPublicClient, http, getContract} from 'viem';
import * as dotenv from 'dotenv';

dotenv.config();

import {Artifact_S2SPublicationModuleFactory} from '@s2s/publication-contracts/artifacts/S2SPublicationModuleFactory';
import {Artifact_S2SPublicationModule} from '@s2s/publication-contracts/artifacts/S2SPublicationModule';
import {Artifact_S2SRecordsModuleFactory} from '@s2s/publication-contracts/artifacts/S2SRecordsModuleFactory';
import {Artifact_S2SRecordsModule} from '@s2s/publication-contracts/artifacts/S2SRecordsModule';

async function main() {
	const network = process.env.HARDHAT_NETWORK || process.env.NETWORK || 'base';
	const rpcUrl = process.env[`ETH_NODE_URI_${network.toUpperCase()}`] || process.env.BASE_RPC_URL;

	if (!rpcUrl) {
		console.error('❌ No RPC URL found. Set ETH_NODE_URI_<NETWORK> or BASE_RPC_URL');
		process.exit(1);
	}

	const client = createPublicClient({
		transport: http(rpcUrl),
	});

	const pubFactoryAddr = process.env.PUBLICATION_FACTORY_ADDRESS;
	const recFactoryAddr = process.env.RECORDS_FACTORY_ADDRESS;

	console.log(`\n=== Checking deployments on ${network} ===\n`);

	if (pubFactoryAddr) {
		console.log(`--- S2SPublicationModuleFactory @ ${pubFactoryAddr} ---`);
		try {
			const pubFactory = getContract({
				address: pubFactoryAddr as `0x${string}`,
				abi: Artifact_S2SPublicationModuleFactory.abi,
				client,
			});

			const latestImpl = await pubFactory.read.latestImplementation();
			const implCount = await pubFactory.read.implementationCount();
			console.log(`  latestImplementation: ${latestImpl}`);
			console.log(`  implementationCount:  ${implCount}`);

			// Check implementation has expected functions
			if (latestImpl !== '0x0000000000000000000000000000000000000000') {
				const impl = getContract({
					address: latestImpl as `0x${string}`,
					abi: Artifact_S2SPublicationModule.abi,
					client,
				});

				try {
					const name = await impl.read.NAME();
					console.log(`  ✅ Implementation NAME(): ${name}`);
				} catch { console.log('  ❌ No NAME() on impl'); }

				try {
					const count = await impl.read.getContentIdCount();
					console.log(`  ✅ getContentIdCount(): ${count}`);
				} catch { console.log('  ❌ No getContentIdCount()'); }
			}
		} catch (e: any) {
			console.log(`  ❌ Error: ${e.message}`);
		}
	} else {
		console.log('--- S2SPublicationModuleFactory: not set (PUBLICATION_FACTORY_ADDRESS)');
	}

	if (recFactoryAddr) {
		console.log(`\n--- S2SRecordsModuleFactory @ ${recFactoryAddr} ---`);
		try {
			const recFactory = getContract({
				address: recFactoryAddr as `0x${string}`,
				abi: Artifact_S2SRecordsModuleFactory.abi,
				client,
			});
			console.log(`  ✅ Factory accessible`);
		} catch (e: any) {
			console.log(`  ❌ Error: ${e.message}`);
		}
	} else {
		console.log('\n--- S2SRecordsModuleFactory: not set (RECORDS_FACTORY_ADDRESS)');
	}
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
