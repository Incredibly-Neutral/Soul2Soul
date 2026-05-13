import {deployScript} from '../rocketh/deploy.js';
import {Artifact_S2SPublicationModuleFactory} from '../generated/artifacts/S2SPublicationModuleFactory.js';

export default deployScript(
	async (env) => {
		const {deployer} = env.namedAccounts;

		const factoryAddress = process.env.PUBLICATION_FACTORY_ADDRESS || '';
		if (!factoryAddress) {
			console.error('❌ PUBLICATION_FACTORY_ADDRESS not set');
			return;
		}

		console.log(`Upgrading publication module at factory ${factoryAddress}...`);

		const factoryDeployment = {
			address: factoryAddress as `0x${string}`,
			abi: Artifact_S2SPublicationModuleFactory.abi,
		};

		// Read current state
		const oldImpl = await env.read(factoryDeployment, {
			functionName: 'latestImplementation',
			args: [],
			account: deployer,
		});
		const oldVersion = await env.read(factoryDeployment, {
			functionName: 'implementationCount',
			args: [],
			account: deployer,
		});
		console.log(`Current implementation: ${oldImpl}`);
		console.log(`Current version: ${oldVersion}`);

		// Execute: deployNewImplementation deploys a fresh impl + registers it
		const receipt = await env.execute(factoryDeployment, {
			functionName: 'deployNewImplementation',
			args: [],
			account: deployer,
		});
		console.log(`Upgrade tx: ${receipt.transactionHash}`);

		// Verify
		const newImpl = await env.read(factoryDeployment, {
			functionName: 'latestImplementation',
			args: [],
			account: deployer,
		});
		const newVersion = await env.read(factoryDeployment, {
			functionName: 'implementationCount',
			args: [],
			account: deployer,
		});

		console.log(`✅ Upgrade complete`);
		console.log(`   Old impl: ${oldImpl} (v${oldVersion})`);
		console.log(`   New impl: ${newImpl} (v${newVersion})`);
	},
	{tags: ['upgrade', 'PublicationModule_upgrade']},
);
