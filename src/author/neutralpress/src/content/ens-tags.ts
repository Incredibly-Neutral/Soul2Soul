/**
 * Pure ENS-tag helpers for neutralpress publications.
 *
 * These are DOM-free, side-effect-free utilities that translate between a
 * note's `--s2s` frontmatter tags and the publication ENS name they target
 * (e.g. `acme--s2s` ⇄ `acme.soul2soul.eth`).
 *
 * Keeping them here (instead of inline in the controller) removes the three
 * copy-pasted tag-filter loops that used to live in main.ctrlr.ts and makes
 * the mapping unit-testable.
 */

/** Frontmatter tag suffix that marks a note as claimed by a publication. */
export const S2S_TAG_SUFFIX = '--s2s';

/** ENS suffix of a s2s publication name (tag `acme--s2s` → `acme.soul2soul.eth`). */
export const S2S_ENS_SUFFIX = '.soul2soul.eth';

/** True when a frontmatter tag targets an s2s publication. */
export function isS2sTag(tag: string): boolean {
	return tag.endsWith(S2S_TAG_SUFFIX);
}

/**
 * Map a note's raw frontmatter tags to the ENS names of the publications it
 * is claimed by. Non-s2s tags are dropped.
 */
export function publicationEnsFromTags(tags: string[]): string[] {
	return tags.filter(isS2sTag).map((tag) => tag.replace(S2S_TAG_SUFFIX, S2S_ENS_SUFFIX));
}

/** Extract the subdomain (leftmost label) of an s2s publication ENS name. */
export function subdomainOf(ens: string): string {
	return ens.split('.')[0];
}

/**
 * Build the publication ENS name from a raw `--s2s` tag, lowercasing and
 * normalising the suffix (e.g. `MyPub--s2s` → `mypub.soul2soul.eth`).
 */
export function ensNameFromTag(tag: string): string {
	return tag.toLowerCase().replace(S2S_TAG_SUFFIX, '') + S2S_ENS_SUFFIX;
}
