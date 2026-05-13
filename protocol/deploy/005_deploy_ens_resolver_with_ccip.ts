import {deployScript} from '../rocketh/deploy.js';
import {namehash as viemNamehash} from 'viem/ens';

import {Artifact_ENSResolverWthCCIP} from '../generated/artifacts/ENSResolverWthCCIP.js';

export default deployScript(
	async (env) => {
		const {deployer} = env.namedAccounts;

		const domainName = process.env.DOMAIN_NAME || 'soul2soul.eth';
		const ensRegistry = process.env.ENS_REGISTRY_ADDRESS || '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
		const nameWrapper = process.env.NAMEWRAPPER_ADDRESS || '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
		const baseRecordsContract = process.env.BASE_RECORDS_ADDRESS || '';
		const protocolSafe = process.env.PROTOCOL_SAFE_ADDRESS || '';

		const domainNode = viemNamehash(domainName);

		// RPC URLs for CCIP-Read to query the L2 records contract
		const rpcUrls = (process.env.CCIP_RPC_URLS || 'https://mainnet.base.org').split(',');

		if (!baseRecordsContract) {
			console.warn('⚠️  BASE_RECORDS_ADDRESS not set — deploy ENSSubdomainRecordsContract first');
		}

		console.log(`Deploying ENSResolverWthCCIP for ${domainName}`);
		console.log(`  domainNode: ${domainNode}`);
		console.log(`  rpcUrls: ${rpcUrls}`);
		console.log(`  baseRecordsContract: ${baseRecordsContract}`);
		console.log(`  ensRegistry: ${ensRegistry}`);
		console.log(`  nameWrapper: ${nameWrapper}`);
		console.log(`  initialOwner: ${protocolSafe || deployer}`);

		const deployment = await env.deploy('ENSResolverWthCCIP', {
			account: deployer,
			artifact: Artifact_ENSResolverWthCCIP as any,
			args: [
				domainNode,
				rpcUrls,
				(baseRecordsContract || '0x0000000000000000000000000000000000000001') as `0x${string}`,
				ensRegistry as `0x${string}`,
				nameWrapper as `0x${string}`,
				(protocolSafe || deployer) as `0x${string}`,
			],
		});

		console.log(`ENSResolverWthCCIP deployed at ${deployment.address}`);
	},
	{tags: ['ENS', 'ENSResolverWthCCIP']},
);
