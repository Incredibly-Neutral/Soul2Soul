import {deployScript} from '../rocketh/deploy.js';

import {Artifact_ENSSubdomainRecordsContract} from '../generated/artifacts/ENSSubdomainRecordsContract.js';

export default deployScript(
	async (env) => {
		const {deployer} = env.namedAccounts;

		const deployment = await env.deploy('ENSSubdomainRecordsContract', {
			account: deployer,
			artifact: Artifact_ENSSubdomainRecordsContract as any,
			args: [deployer],
		});

		console.log(`ENSSubdomainRecordsContract deployed at ${deployment.address}`);
	},
	{tags: ['ENSSubdomainRecordsContract']},
);
