import {deployScript} from '../rocketh/deploy.js';
import {namehash as viemNamehash} from 'viem/ens';

import {Artifact_ENSOpenSubdomainRegistry} from '../generated/artifacts/ENSOpenSubdomainRegistry.js';

export default deployScript(
	async (env) => {
		const {deployer} = env.namedAccounts;

		const ensRegistry = process.env.ENS_REGISTRY_ADDRESS || '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
		const domainName = process.env.DOMAIN_NAME || 'soul2soul.eth';
		const nameWrapper = process.env.NAMEWRAPPER_ADDRESS || '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
		const protocolSafe = process.env.PROTOCOL_SAFE_ADDRESS || '';

		const parentNode = viemNamehash(domainName);

		console.log(`Deploying ENSOpenSubdomainRegistry for ${domainName}`);
		console.log(`  parentNode: ${parentNode}`);
		console.log(`  ensRegistry: ${ensRegistry}`);
		console.log(`  nameWrapper: ${nameWrapper}`);
		console.log(`  protocolSafe: ${protocolSafe || deployer}`);

		const deployment = await env.deploy('ENSOpenSubdomainRegistry', {
			account: deployer,
			artifact: Artifact_ENSOpenSubdomainRegistry as any,
			args: [
				ensRegistry as `0x${string}`,
				parentNode,
				(protocolSafe || deployer) as `0x${string}`,
				nameWrapper as `0x${string}`,
			],
		});

		console.log(`ENSOpenSubdomainRegistry deployed at ${deployment.address}`);
	},
	{tags: ['ENS', 'ENSOpenSubdomainRegistry']},
);
