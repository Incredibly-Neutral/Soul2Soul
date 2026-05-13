import {deployScript} from '../rocketh/deploy.js';

import {Artifact_S2SRecordsModuleFactory} from '../generated/artifacts/S2SRecordsModuleFactory.js';

export default deployScript(
	async (env) => {
		const {deployer} = env.namedAccounts;

		const deployment = await env.deploy('S2SRecordsModuleFactory', {
			account: deployer,
			artifact: Artifact_S2SRecordsModuleFactory as any,
			args: [],
		});

		console.log(`S2SRecordsModuleFactory deployed at ${deployment.address}`);
	},
	{tags: ['S2SRecordsModuleFactory']},
);
