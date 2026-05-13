import {
	type Accounts,
	type Data,
	type Extensions,
	extensions,
} from './config.js';
import {setupEnvironmentFromFiles} from '@rocketh/node';
import {setupHardhatDeploy} from 'hardhat-deploy/helpers';

import * as artifacts from '../generated/artifacts/index.js';
export {artifacts};

const {loadAndExecuteDeploymentsFromFiles} = setupEnvironmentFromFiles<
	Extensions,
	Accounts,
	Data
>(extensions);
const {loadEnvironmentFromHardhat} = setupHardhatDeploy<
	Extensions,
	Accounts,
	Data
>(extensions);

export {loadEnvironmentFromHardhat, loadAndExecuteDeploymentsFromFiles};
