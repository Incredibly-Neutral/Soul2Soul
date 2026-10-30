/**
 * neutralpress publication creation — obsidian/oxo glue only.
 *
 * The re-usable parts live in shared (see SPEC-shared / shared/src/publication):
 *   - `newPublicationSafe` — the Safe×2/ENS/modules/config/feed/records orchestration
 *   - `buildNewPublicationDeps` — assembles NewPublicationDeps from injected pieces
 *   - `createL1Runner`/`createL2Runner` — oxo-core → TxRunner bridge
 *
 * What stays here is the obsidian-specific wiring: reading plugin/oxo settings
 * (gateways, tokens), pulling the author private key + lens from the oxo
 * controller, and injecting the protocol-generated ABIs (outside shared's rootDir).
 */

import {
	buildNewPublicationDeps,
	createL1Runner,
	createL2Runner,
	newPublicationSafe as sharedNew,
	type S2SPublication,
} from '@s2s/soul2soul-shared';
import { ipfsFromSettings } from './filecoin';
import {
	S2SRecordsModuleFactory,
	S2SPublicationModuleV2Factory,
	S2SRecordsModule,
} from '@s2s/publication-contracts';

export const newPublicationSafe = async (main: any, publication: S2SPublication) => {
	const githubToken =
		main.plugin.settings.github_token || main.oxo?.settings?.github_token || '';

	const deps = buildNewPublicationDeps({
		runners: {
			l1: createL1Runner(main.oxo),
			l2: createL2Runner(main.oxo),
		},
		privateKey: main.oxo.ctrlr.user.private_key,
		protocolInfo: main.protocolInfo,
		recordsModuleFactoryAbi: S2SRecordsModuleFactory,
		publicationModuleFactoryAbi: S2SPublicationModuleV2Factory,
		recordsModuleAbi: S2SRecordsModule,
		ipfs: ipfsFromSettings(main),
		githubToken,
		createFeed: (name, desc, addr) => main.oxo.ctrlr.lens.createFeed(name, desc, addr),
	});

	return sharedNew(deps, publication);
};
