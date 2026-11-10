import { App, TFile } from 'obsidian';
import { IMainController } from '../main.ctrlr';
import slugify from 'slugify';
import { marked } from 'marked';
import { distributeImages } from './images';
import * as crypto from 'crypto';
import { getAddress } from 'viem';
import {
	buildSignedContentItem,
	type S2SContentItemV2,
	noOpEncrypt,
	toDidEthr,
} from '@s2s/soul2soul-shared';

/**
 * Frontmatter key stating whether this note's last publish was encrypted.
 * Always written as a real YAML boolean, on every publish.
 */
export const ENCRYPTED_KEY = 'encrypted';

/**
 * Pre-rename spelling of {@link ENCRYPTED_KEY}. Read so a note written before
 * the rename keeps behaving as encrypted; never written, and dropped by the
 * same write-back that writes the new key.
 */
export const LEGACY_ENCRYPTION_KEY = 'encryption';

/**
 * The note's encryption state: `encrypted` first, then the legacy `encryption`
 * key. Neither present means plaintext.
 */
function encryptionOf(frontmatter: Record<string, any>): boolean {
	const stated = frontmatter[ENCRYPTED_KEY] ?? frontmatter[LEGACY_ENCRYPTION_KEY];
	return Boolean(stated);
}

/**
 * Parse a frontmatter date to unix seconds: `YYYY-MM-DD`, or a datetime with
 * optional fractional seconds and an optional `Z`/`±HH:MM` zone. An unzoned
 * value is UTC, as the writer emits it (`new Date().toJSON()` with the zone
 * stripped); reading it as local time would make the signature machine-bound.
 *
 * Absent or empty falls back to `fallback` — with no recorded creation this
 * publish is the creation. A value that IS there but does not parse throws:
 * falling back would re-birth the note on every publish.
 */
function creationDateOf(value: unknown, fallback: number): number {
	if (value === undefined || value === null || value === '') return fallback;
	const seconds = parseDateToUnix(value);
	if (seconds === undefined) {
		throw new Error(
			`creation_date ${JSON.stringify(
				value,
			)} is not a date — refusing to publish rather than re-birth the note. Fix it to \`YYYY-MM-DDTHH:mm:ss\` (UTC) or remove the key.`,
		);
	}
	return seconds;
}

function parseDateToUnix(value: unknown): number | undefined {
	if (value instanceof Date) {
		const ms = value.getTime();
		return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
	}
	if (typeof value !== 'string') return undefined;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
			value.trim(),
		);
	if (!match) return undefined;
	const [year, month, day, hour, minute, second] = [
		Number(match[1]),
		Number(match[2]),
		Number(match[3]),
		Number(match[4] ?? 0),
		Number(match[5] ?? 0),
		Number(match[6] ?? 0),
	];
	const millisecond = Number((match[7] ?? '').slice(0, 3).padEnd(3, '0') || 0);
	const zone = match[8];
	const offsetMinutes =
		zone === undefined || zone === 'Z'
			? 0
			: (zone.startsWith('-') ? -1 : 1) *
				(Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
	const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
	const date = new Date(ms);
	// Reject rollovers (`2021-13-01T…` → next year): only a real calendar time counts.
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCSeconds() !== second
	) {
		return undefined;
	}
	return Math.floor((ms - offsetMinutes * 60_000) / 1000);
}

export interface IContentController {
	main: IMainController;
	/** Build and sign a content item from an Obsidian note, then update frontmatter */
	publishContent: (file: TFile, subdomain: string) => Promise<S2SContentItemV2 | null>;
}

export class ContentController implements IContentController {
	main: IMainController;

	constructor(main: IMainController) {
		this.main = main;
	}

	/**
	 * Parse an Obsidian note and produce the raw pieces needed for signing.
	 * Returns structured data without any Lens-era type baggage.
	 */
	parseNote = async (
		file: TFile,
		now: number = Math.floor(Date.now() / 1000),
	): Promise<{
		contentId: string | null;
		postType: string;
		locale: string;
		tags: string[];
		parent: number;
		position: number;
		encryption: boolean;
		title: string;
		slug: string;
		content: string;
		summary: string | undefined;
		custom: Record<string, unknown>;
	}> => {
		const rawFile = await this.main.plugin.app.vault.read(file);

		const frontmatter = await this.parseContentFrontmatter(file, this.main.plugin.app, now);
		const title = file.name.replace(/\.[^/.]+$/, '') || frontmatter.title || '';

		let [body, extractedTitle, _baseFileName] = this.extractTitleAndBase(rawFile, title);
		const resolvedTitle = extractedTitle || title;
		const slug = frontmatter.slug || this.slug(resolvedTitle);

		const tags = frontmatter.tags ? JSON.parse(JSON.stringify(frontmatter.tags)) : [];
		const knownKeys = new Set([
			'content_id',
			'post_type',
			'language',
			'tags',
			'parent',
			'position',
			ENCRYPTED_KEY,
			LEGACY_ENCRYPTION_KEY,
			'title',
			'modified_date',
			'creation_date',
			'cid',
			'kubo_cid',
			'genesis',
			'author',
		]);
		const custom: Record<string, unknown> = {};
		for (const key of Object.keys(frontmatter)) {
			if (!knownKeys.has(key)) {
				custom[key] = frontmatter[key];
			}
		}
		const publications = tags
			.filter((tag: string) => tag.endsWith('--s2s'))
			.map((tag: string) => tag.replace('--s2s', '.soul2soul.eth'));

		let mdContent = await marked(body);
		mdContent = await distributeImages(
			this.main,
			this.main.plugin.app,
			file,
			mdContent,
			this.main.protocolInfo.gateway,
		);

		const MORE = /<!--more-->/i;
		const SPLIT = /<!--split-->/i;

		function deriveSummary(html: string): { summary: string | undefined; content: string } {
			const moreIdx = html.search(MORE);
			const splitIdx = html.search(SPLIT);
			const cutIdx = [moreIdx, splitIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];

			const summary = cutIdx >= 0 ? html.slice(0, cutIdx).trim() : undefined;
			const content =
				splitIdx >= 0
					? html.slice(splitIdx).replace(SPLIT, '').trim()
					: html.replace(MORE, '').trim();
			return { summary, content };
		}

		const { summary, content } = deriveSummary(mdContent);

		return {
			contentId: frontmatter.content_id || null,
			postType: frontmatter.post_type || 'post',
			locale: frontmatter.language || 'en',
			tags,
			parent: frontmatter.parent ? parseInt(frontmatter.parent) : 0,
			position: frontmatter.position ? parseInt(frontmatter.position) : 0,
			encryption: encryptionOf(frontmatter),
			title: resolvedTitle,
			slug,
			content,
			summary,
			custom,
		};
	};

	/**
	 * Build a signed S2SContentItem from an Obsidian note and publish it.
	 * Replaces the old Lens-based storeNoteOnLens.
	 *
	 * Signing happens via the 0xobsidian BASE account's EOA (asTypedDataSigner).
	 * The signed object is stored in frontmatter for later use by the render pipeline.
	 */
	async publishContent(file: TFile, subdomain: string): Promise<S2SContentItemV2 | null> {
		// One sample for both signed dates: on a first publish `creationDate` and
		// `modifiedDate` are the same instant, even across a second boundary.
		const now = Math.floor(Date.now() / 1000);
		const parsed = await this.parseNote(file, now);
		const baseAccount = this.main.oxo.ctrlr.account['BASE'];

		if (!baseAccount?.signTypedData) {
			console.warn('No BASE account available for signing; content not signed');
			return null;
		}

		const signer = baseAccount.asTypedDataSigner();

		// Merge summary into custom bag if present
		const custom = { ...(parsed.custom || {}) };
		if (parsed.summary !== undefined) custom.summary = parsed.summary;

		// Read existing genesis from frontmatter (stable identity for updates)
		const cache = this.main.plugin.app.metadataCache.getFileCache(file);
		const existingGenesis: string | null = cache?.frontmatter?.genesis || null;
		console.log('existing genesis', existingGenesis);

		// Two signed dates: `modifiedDate` is this publish, `creationDate` is the
		// note's birth and stays fixed across revisions. `now` (sampled above, before
		// any await) is threaded into parseNote, which writes exactly that instant to
		// `creation_date` on a first publish — so the recorded birth and the signed
		// creationDate are the same second, not two samples. A revision reads the
		// birth back from frontmatter instead.
		const creationDate = existingGenesis
			? creationDateOf(cache?.frontmatter?.creation_date, now)
			: now;

		try {
			const signedItem = await buildSignedContentItem(
				{
					specVersion: '2',
					postType: parsed.postType,
					mediaType: 'text/markdown',
					parent: String(parsed.parent),
					position: String(parsed.position),
					publication: subdomain,
					locale: parsed.locale,
					creationDate,
					modifiedDate: now,
					tags: parsed.tags,
					attributes: undefined,
				},
				{
					title: parsed.title,
					slug: parsed.slug,
					content: parsed.content,
					custom: custom,
				},
				signer,
				noOpEncrypt,
				// Author is the Safe address (on-chain msg.sender).
				// The EOA that signs is a Safe owner, verified off-chain.
				toDidEthr(baseAccount.address),
			);

			console.log('publishing:', signedItem);

			// Preserve the original genesis on updates — the contract
			// identifies content by its first-publish (genesis) objectId.
			// Only the very first publish creates a new identity.
			const objectId = existingGenesis ?? signedItem.objectId;
			console.log('oid', objectId);

			// Record the state this publish produced, as a real YAML boolean. Written
			// on every publish, not only when absent, so the file always states what
			// the last publish did and the author edits it to change the next one.
			// The value is the flag that drove the body — `signedItem.encryption`,
			// set from the encrypt function in buildSignedContentItem — not a second
			// read of the note.
			// Dropping the legacy key in the same pass leaves a migrated note with
			// one key — `encryption` is read, never written.
			await this.updateFrontMatter(
				this.main.plugin.app,
				file,
				ENCRYPTED_KEY,
				signedItem.encryption === true,
				[LEGACY_ENCRYPTION_KEY],
			);

			// Store signed metadata to frontmatter (genesis publish only)
			if (!existingGenesis) {
				// Format modified time to match creation_date (no ms, no Z)
				const mtime = new Date(file.stat.mtime).toJSON().split('.')[0];
				await this.updateFrontMatter(this.main.plugin.app, file, 'genesis', objectId);
				await this.updateFrontMatter(
					this.main.plugin.app,
					file,
					'author',
					signedItem.public.author,
				);
				await this.updateFrontMatter(this.main.plugin.app, file, 'modified_date', mtime);
			}

			return { ...signedItem, objectId };
		} catch (err) {
			console.error('publishContent: signing failed:', err);
			return null;
		}
	}

	/** Parse frontmatter from Obsidian metadata cache — returns raw fields */
	parseContentFrontmatter = async (
		file: TFile,
		app: App,
		now: number = Math.floor(Date.now() / 1000),
	): Promise<Record<string, any>> => {
		return new Promise((resolve, reject) => {
			const cache = app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter || {};

			// The caller's instant, not a second sample: the publish path hands in
			// the value it signs as `creationDate`, so the recorded birth is the
			// same second as the signature and the next revision re-signs it.
			const stamp = new Date(now * 1000).toISOString().slice(0, 19);
			frontmatter.modified_date = stamp;
			this.updateFrontMatter(app, file, 'modified_date', stamp);

			if (frontmatter.creation_date == undefined) {
				frontmatter.creation_date = stamp;
				this.updateFrontMatter(app, file, 'creation_date', stamp);
			}

			resolve(frontmatter);
		});
	};

	extractTitleAndBase(
		raw: string,
		fallbackTitle: string,
	): [string, string | undefined, string | undefined] {
		let baseFileName: string | undefined;
		let content = raw.split('---')[2]?.trim() || '';

		// Check if content contains any .base references
		const baseRegex = /!\[\[(.*?)\.base(\.md)?\]\]/g;
		const baseMatches = content.match(baseRegex);
		if (baseMatches) {
			baseFileName = baseMatches[0].replace(/!\[\[(.*?)\]\]/g, '$1');
			content = content.replace(baseRegex, '');
		}

		content = content.replace(/^\n+/, '');

		let title: string | undefined = fallbackTitle;
		if (content.slice(0, 2) === '# ') {
			const parts = content.split('\n');
			title = parts[0].replace('# ', '').trim();
			parts.shift();
			content = parts.join('\n').trim();
		}

		return [content, title, baseFileName];
	}

	slug(title: string): string {
		const options = {
			lower: true,
			remove: /['"?!.,:;()\[\]{}@#$%^&*+=<>~`|\\]/g,
			strict: true,
		};
		return slugify(title, options);
	}

	/**
	 * Assign `value` to `key`, then drop `remove` — one frontmatter pass.
	 *
	 * The value is assigned as given: a boolean stays a boolean, so
	 * `encrypted: false` serialises unquoted. A stringified `'false'` is truthy
	 * and would silently encrypt on the next publish.
	 */
	updateFrontMatter = async (
		app: App,
		file: TFile,
		key: string,
		value: string | string[] | boolean,
		remove: string[] = [],
	) => {
		if (file != null) {
			await app.fileManager.processFrontMatter(file, (frontmatter) => {
				frontmatter[key] = value;
				for (const legacyKey of remove) delete frontmatter[legacyKey];
			});
		}
	};

	getFrontMatter = async (app: App, file: TFile): Promise<any> => {
		return new Promise(async (resolve, reject) => {
			await app.fileManager.processFrontMatter(file, (frontmatter) => {
				resolve(frontmatter);
			});
		});
	};
}
