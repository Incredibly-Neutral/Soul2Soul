import type {HardhatUserConfig} from 'hardhat/config';
import {fileURLToPath} from 'url';

import HardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';
import HardhatViem from '@nomicfoundation/hardhat-viem';
import HardhatNetworkHelpers from '@nomicfoundation/hardhat-network-helpers';
import HardhatKeystore from '@nomicfoundation/hardhat-keystore';

import HardhatDeploy from 'hardhat-deploy';
import {
	addForkConfiguration,
	addNetworksFromEnv,
	addNetworksFromKnownList,
} from 'hardhat-deploy/helpers';
import * as dotenv from 'dotenv';

dotenv.config({path: fileURLToPath(new URL('../../../.env', import.meta.url))});

const config: HardhatUserConfig = {
	plugins: [
		HardhatNodeTestRunner,
		HardhatViem,
		HardhatNetworkHelpers,
		HardhatKeystore,
		HardhatDeploy,
	],
	solidity: {
		version: '0.8.24',
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
			viaIR: true,
			// tstore/tload (EIP-1153) need Cancun: the factory passes the
			// implementation to a proxy through transient storage.
			evmVersion: 'cancun',
			// No metadata hash. The proxy's creation code is hashed into every
			// module address, and the hash changes with the compiler build even
			// when the source does not, which would silently move every address.
			// Kept global rather than a per-file override: an override compiles
			// the proxy twice, once for the artifact and once into the factory's
			// embedded creationCode, and the two would disagree.
			metadata: {
				bytecodeHash: 'none',
			},
		},
	},
	networks: addForkConfiguration(
		addNetworksFromKnownList(
			addNetworksFromEnv({
				default: {
					type: 'edr-simulated',
					chainType: 'l1',
					accounts: {
						mnemonic: process.env.PROTOCOL_KEY || undefined,
					},
				},
			}),
		),
	),
	paths: {
		sources: 'src',
		tests: 'test',
		artifacts: 'artifacts',
		cache: 'cache',
	},
	generateTypedArtifacts: {
		destinations: [
			{
				folder: './generated',
				mode: 'typescript',
			},
		],
	},
};

export default config;
