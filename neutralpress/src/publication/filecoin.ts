/**
 * Filecoin durability helpers for neutralpress.
 *
 * Extracted from the old MainController monolith (SPEC-00 §3.2): a normalised
 * Kubo gateway URL getter and a fire-and-forget Filecoin upload wrapper that
 * never blocks or throws the main flow.
 */
import { Notice } from 'obsidian';
import type { FilecoinUploadResult } from '@s2s/soul2soul-shared/filecoin';
import type { IMainController } from '../main.ctrlr';

/** Normalized Kubo API base URL (with protocol) for Filecoin tree export. */
export function kuboBaseUrl(main: IMainController): string {
	const raw = main.oxo.settings.kubo_url || 'ipfs.transport-union.dev';
	return raw.startsWith('http') ? raw : `https://${raw}`;
}

/**
 * Fire-and-forget Filecoin durability upload (SPEC-00 §3.2).
 * Never throws, never blocks the main flow. When `expectedCid` is given,
 * asserts CID parity with the Filecoin rootCid (INV-13) and surfaces a
 * notice on mismatch.
 */
export function filecoinUploadBackground(
	main: IMainController,
	kind: string,
	upload: () => Promise<FilecoinUploadResult>,
	expectedCid?: string,
): void {
	(async () => {
		try {
			const result = await upload();
			// Quiet success — no logging unless CID parity is violated.
			if (expectedCid && result.rootCid && expectedCid !== result.rootCid) {
				console.error(
					`[cid-mismatch] ${kind}: Kubo ${expectedCid.slice(0, 12)}… ≠ Filecoin ${result.rootCid.slice(0, 12)}…`,
				);
				new Notice(
					`⚠️ CID mismatch (${kind}): Kubo ${expectedCid.slice(0, 12)}… ≠ Filecoin ${result.rootCid.slice(0, 12)}…`,
				);
			}
		} catch (err) {
			// Exactly one concise line — never the full error object / nested causes.
			// Detect the min-2-copies failure by its stable error name rather than
			// importing the class: a value import would force esbuild to bundle the
			// whole filecoin module (and @filoz/synapse-sdk) into this plugin.
			if (err instanceof Error && err.name === 'FilecoinMinCopiesError') {
				console.error(`[filecoin] ${kind} background upload failed: ${err.message}`);
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[filecoin] ${kind} background upload failed: ${msg}`);
			}
		}
	})();
}
