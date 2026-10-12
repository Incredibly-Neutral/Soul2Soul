/**
 * Kubo/durability helpers for neutralpress.
 *
 * Extracted from the old MainController monolith (SPEC-00 §3.2):
 *   - `kuboBaseUrl` — normalised Kubo gateway URL (with protocol), used by
 *     the Filecoin tree-export path.
 *   - `ipfsFromSettings` — builds the shared S2SIPFSMethods client from the
 *     plugin/oxo settings so the 4-way backup (filebase + pinata + filecoin,
 *     see S2SIPFSMethods.backupToProviders) can run after a kubo upload.
 *
 * The fire-and-forget + CID-parity logic that used to live here
 * (filecoinUploadBackground) now lives in the shared method it delegates to —
 * one implementation for every consumer.
 */
import type { IMainController } from '../main.ctrlr';
import { S2SIPFSMethods } from '@s2s/soul2soul-shared';

/** Normalized Kubo API base URL (with protocol) for Filecoin tree export. */
export function kuboBaseUrl(main: IMainController): string {
	const raw = main.oxo.settings.kubo_url || 'ipfs.transport-union.dev';
	return raw.startsWith('http') ? raw : `https://${raw}`;
}

/**
 * Build the shared IPFS client from plugin/oxo settings — the same token
 * precedence new-publication uses (plugin settings first, oxo fallback).
 * This is what lets the kubo upload path reuse the single shared backup
 * method (`backupToProviders`) for 4-way durable coverage.
 */
export function ipfsFromSettings(main: IMainController): S2SIPFSMethods {
	const pluginSettings = main.plugin.settings as unknown as Record<string, unknown>;
	const oxoSettings = (main.oxo?.settings ?? {}) as Record<string, unknown>;
	const kuboGateway =
		(pluginSettings.data_gateway as string) || 'https://ipfs.transport-union.dev';
	const pinataJwt =
		(pluginSettings.pinata_jwt as string) || (oxoSettings.pinata_jwt as string) || '';
	const pinataGateway =
		(pluginSettings.pinata_gateway as string) || 'https://neutralpress.mypinata.cloud';
	const filebaseToken =
		(pluginSettings.filebase_token as string) || (oxoSettings.filebase_token as string) || '';
	const kuboToken = (oxoSettings.kubo_token as string) || '';
	return new S2SIPFSMethods(kuboGateway, pinataJwt, pinataGateway, filebaseToken, kuboToken);
}
