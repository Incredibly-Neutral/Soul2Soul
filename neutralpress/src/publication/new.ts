/**
 * neutralpress publication creation — thin adapter that builds TxRunners
 * from oxo-core and delegates to the shared orchestration.
 */

import {
	newPublicationSafe as sharedNew,
	S2SPublication,
	S2SIPFSMethods,
} from '@s2s/soul2soul-shared';
import { createL1Runner, createL2Runner } from './tx-runner.adapter';
import {
	S2SRecordsModuleFactory,
	S2SPublicationModuleV2Factory,
	S2SRecordsModule,
} from '../../../protocol/contracts/generated/abis';

export const newPublicationSafe = async (main: any, publication: S2SPublication) => {
	const l1 = createL1Runner(main.oxo);
	const l2 = createL2Runner(main.oxo);

	// Build the IPFS client from plugin settings
	const kuboGateway = main.plugin.settings.data_gateway || 'https://ipfs.transport-union.dev';
	const pinataJwt = main.plugin.settings.pinata_jwt || main.oxo?.settings?.pinata_jwt || '';
	const pinataGateway =
		main.plugin.settings.pinata_gateway || 'https://neutralpress.mypinata.cloud';
	const filebaseToken =
		main.plugin.settings.filebase_token || main.oxo?.settings?.filebase_token || '';
	const kuboToken = main.oxo?.settings?.kubo_token || '';
	const ipfs = new S2SIPFSMethods(
		kuboGateway,
		pinataJwt,
		pinataGateway,
		filebaseToken,
		kuboToken,
	);

	const githubToken = main.plugin.settings.github_token || main.oxo?.settings?.github_token || '';

	return sharedNew(
		{
			l1,
			l2,
			privateKey: main.oxo.ctrlr.user.private_key,
			protocolInfo: main.protocolInfo,
			recordsModuleFactoryAbi: S2SRecordsModuleFactory,
			publicationModuleFactoryAbi: S2SPublicationModuleV2Factory,
			recordsModuleAbi: S2SRecordsModule,
			ipfs,
			githubToken,
			ensRecordsAddress: main.protocolInfo?.ensRecords ?? '',
			createFeed: (name, desc, addr) => main.oxo.ctrlr.lens.createFeed(name, desc, addr),
		},
		publication,
	);
};
