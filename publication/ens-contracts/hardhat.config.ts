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

dotenv.config({path: fileURLToPath(new URL('../../.env', import.meta.url))});

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
