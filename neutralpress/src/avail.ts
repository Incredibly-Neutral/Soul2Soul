import { parseCID, toPreviewLabel } from '@s2s/soul2soul-shared';

/**
 * Publish availability measurement (minimal).
 *
 * Three fire-and-forget checks run after a publish, each polling for a bounded
 * window and reporting a timing in ms since the check started:
 *   1. .limo cache-switch detection  (x-ipfs-path matched the new CID)
 *   2. Pinata retrievability         (HEAD gateway.pinata.cloud returns 200)
 *   3. ipfs.io retrievability        (HEAD ipfs.io returns 200)
 * A single console.log summarizes the three timings and whether the publish
 * was graceful (limo switched first) or exposed (gateway retrievable first).
 */

export const LIMO_FALLBACK_HOST = 'preview.transport-union.dev';

const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Compare two CID strings as decoded bytes (multibase-stripped). */
function sameCid(a: string, b: string): boolean {
	try {
		return bytesEqual(parseCID(a).bytes, parseCID(b).bytes);
	} catch {
		return a === b;
	}
}

/** Extract the CID from an x-ipfs-path header like "/ipfs/<cid>/..." */
function cidFromIpfsPath(path: string): string | null {
	const m = path.match(/\/ipfs\/([^/]+)/);
	return m ? m[1] : null;
}

export interface LimoResult {
	/** ms until the cache served the new CID, or null if never within the window. */
	ms: number | null;
	/** which host reported the switch: 'limo' or 'preview-fallback'. */
	source: 'limo' | 'preview-fallback';
}

/** Check 1 — .limo cache-switch detection, with graceful TLS fallback. */
export async function checkLimoCacheSwitch(
	publication: string,
	newCid: string,
): Promise<LimoResult> {
	const label = toPreviewLabel(newCid);
	const limoUrl = `https://${publication}.limo/`;
	const fallbackUrl = `https://${label}.${LIMO_FALLBACK_HOST}/`;
	let source: LimoResult['source'] = 'limo';
	const started = Date.now();
	const deadline = Date.now() + POLL_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const url = source === 'limo' ? limoUrl : fallbackUrl;
		try {
			const res = await fetch(url, {
				method: 'HEAD',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const served = cidFromIpfsPath(res.headers.get('x-ipfs-path') ?? '');
			if (res.status < 400 && served && sameCid(served, newCid)) {
				return { ms: Date.now() - started, source };
			}
		} catch (err) {
			if (source === 'limo') {
				console.log(
					`[avail] .limo TLS failed, falling back to ${fallbackUrl}: ${(err as Error).message}`,
				);
				source = 'preview-fallback';
			}
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return { ms: null, source };
}

/** Check 2/3 — time (ms) until the given gateway returns 200 for the CID. */
export async function checkRetrievable(url: string): Promise<number | null> {
	const started = Date.now();
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				method: 'HEAD',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (res.status === 200) return Date.now() - started;
		} catch {
			/* retry */
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return null;
}

export interface Availability {
	publication: string;
	cid: string;
	limo: LimoResult;
	pinata: number | null;
	ipfsio: number | null;
}

/** Run all three checks in parallel and log the summary. */
export async function measureAvailability(publication: string, cid: string): Promise<void> {
	const [limo, pinata, ipfsio] = await Promise.all([
		checkLimoCacheSwitch(publication, cid),
		checkRetrievable(`https://gateway.pinata.cloud/ipfs/${cid}`),
		checkRetrievable(`https://ipfs.io/ipfs/${cid}`),
	]);
	logAvailability({ publication, cid, limo, pinata, ipfsio });
}

/** ONE summary line comparing the three timings vs the .limo switch. */
export function logAvailability(a: Availability): void {
	// Gateways that retrieved within the window. Empty-set case: if neither
	// pinata nor ipfs.io returned 200, firstRetrievable stays null (never
	// Infinity), so the verdict can't claim the publish was served at all.
	const gateways = [a.pinata, a.ipfsio].filter((x): x is number => x != null);
	const firstRetrievable = gateways.length ? Math.min(...gateways) : null;

	const limoSwitched = a.limo.ms != null;
	// 'graceful' requires a gateway to have actually retrieved AND limo to have
	// switched no later than that first retrieval. No retrievable gateway => not graceful.
	const graceful =
		limoSwitched && firstRetrievable != null && a.limo.ms! <= firstRetrievable;
	const verdict = limoSwitched
		? graceful
			? 'graceful (limo switched first)'
			: 'exposed (gateway retrievable before limo switched)'
		: 'exposed (limo not switched within window)';

	console.log(
		`[avail] publish ${a.publication} cid=${a.cid}\n` +
			`  .limo switch:  ${a.limo.ms != null ? `${a.limo.ms}ms (${a.limo.source})` : 'not switched'}\n` +
			`  pinata:        ${a.pinata != null ? `${a.pinata}ms` : 'timeout'}\n` +
			`  ipfs.io:       ${a.ipfsio != null ? `${a.ipfsio}ms` : 'timeout'}\n` +
			`  first retrievable: ${firstRetrievable != null ? `${firstRetrievable}ms` : 'none'} — ${verdict}`,
	);
}
