import {deployScript} from '../rocketh/deploy.js';

import {Artifact_S2SPublicationModule} from '../generated/artifacts/S2SPublicationModule.js';
import {Artifact_S2SPublicationModuleFactory} from '../generated/artifacts/S2SPublicationModuleFactory.js';

export default deployScript(
	async (env) => {
		const {deployer} = env.namedAccounts;

		// Deploy S2SPublicationModule implementation (UUPS)
		const implementation = await env.deploy('S2SPublicationModule', {
			account: deployer,
			artifact: Artifact_S2SPublicationModule as any,
			args: [],
		});
		console.log(`S2SPublicationModule implementation at ${implementation.address}`);

		// Deploy the factory
		const factory = await env.deploy('S2SPublicationModuleFactory', {
			account: deployer,
			artifact: Artifact_S2SPublicationModuleFactory as any,
			args: [],
		});
		console.log(`S2SPublicationModuleFactory deployed at ${factory.address}`);
	},
	{tags: ['S2SPublicationModuleFactory']},
);
