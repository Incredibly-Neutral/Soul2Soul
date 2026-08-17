/**
 * Publication-intent runner for neutralpress.
 *
 * Collapses the three copy-pasted "getFileByPath → isValidForPublishing →
 * parseNote → filter --s2s → map ENS → loop dispatch" bodies that used to
 * live in main.ctrlr.ts into ONE runner (`runIntent`) plus one single-purpose
 * function per intent.
 *
 *   - upload  → append + durability, NO rendering
 *   - publish → append + full render (preview when publish=false, prod=true)
 *   - retract → on-chain retract + remove-plumbing re-render, never makeOffer
 */
import { TAbstractFile, TFile } from 'obsidian';
import type { IMainController } from '../main.ctrlr';
import { publicationEnsFromTags } from '../content/ens-tags';
import { publishToPublication } from './publish';
import { revokeContent } from './revoke';

export type PublicationIntent = 'upload' | 'publish' | 'retract';

/**
 * Resolve the ENS names of the publications a note is claimed by (one runner
 * for the previously-triplicated tag-filter loop). Returns `[]` for a note
 * with no `--s2s` tags.
 */
export async function resolvePublicationsForFile(
	main: IMainController,
	file: TFile,
): Promise<string[]> {
	const { tags } = await main.content.parseNote(file);
	return publicationEnsFromTags(tags ?? []);
}

/** Single-purpose intent: append + durability only, no rendering. */
export async function uploadIntent(main: IMainController, file: TFile, publication: string) {
	await publishToPublication(main, file, publication, { render: false });
}

/** Single-purpose intent: append + full render (publish=false → preview). */
export async function publishIntent(
	main: IMainController,
	file: TFile,
	publication: string,
	publish: boolean,
) {
	await publishToPublication(main, file, publication, { render: true, publish });
}

/** Single-purpose intent: on-chain retract + remove-plumbing re-render. */
export async function retractIntent(main: IMainController, file: TFile, publication: string) {
	await revokeContent(main, file, publication);
}

/**
 * Run one publication intent across every publication the note is claimed by.
 * The controller's thin wrappers delegate here.
 */
export async function runIntent(
	main: IMainController,
	_file: TAbstractFile,
	intent: PublicationIntent,
	publish = false,
): Promise<void> {
	const file = main.plugin.app.vault.getFileByPath(_file.path);
	if (!main.isValidForPublishing(file)) return;

	const publications = await resolvePublicationsForFile(main, file);
	for (const publication of publications) {
		if (intent === 'upload') {
			await uploadIntent(main, file, publication);
		} else if (intent === 'publish') {
			await publishIntent(main, file, publication, publish);
		} else {
			await retractIntent(main, file, publication);
		}
	}
}
