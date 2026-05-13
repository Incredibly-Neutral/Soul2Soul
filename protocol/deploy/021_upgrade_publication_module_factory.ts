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

		console.log(`Deploying new implementation via factory at ${factoryAddress}...`);

		const factoryDeployment = {
			address: factoryAddress as `0x${string}`,
			abi: Artifact_S2SPublicationModuleFactory.abi,
		};

		// Read old implementation
		const oldImpl = await env.read(factoryDeployment, {
			functionName: 'latestImplementation',
			args: [],
			account: deployer,
		});
		console.log(`Old implementation: ${oldImpl}`);

		// Deploy new impl via factory's built-in method
		const receipt = await env.execute(factoryDeployment, {
			functionName: 'deployNewImplementation',
			args: [],
			account: deployer,
		});
		console.log(`Transaction: ${receipt.transactionHash}`);

		const newImpl = await env.read(factoryDeployment, {
			functionName: 'latestImplementation',
			args: [],
			account: deployer,
		});
		console.log(`✅ New implementation deployed and registered: ${newImpl}`);
	},
	{tags: ['upgrade', 'S2SPublicationModuleFactory_upgrade']},
);
