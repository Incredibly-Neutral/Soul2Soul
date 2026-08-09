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
 * Every check always returns a number in ms — a check that never hit within
 * the window reports the full window elapsed.
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
	/** ms until the cache served the new CID, or the full window if never. */
	ms: number;
	/** true if the cache switched within the window, false if it never did. */
	switched: boolean;
	/** which host reported the switch: 'limo' or 'preview-fallback'. */
	source: 'limo' | 'preview-fallback';
}

export interface GatewayResult {
	/** ms until the gateway returned 200, or the full window if never. */
	ms: number;
	/** true if a 200 came back within the window, false if it never did. */
	reached: boolean;
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
				return { ms: Date.now() - started, switched: true, source };
			}
		} catch (err) {
			if (source === 'limo') {
				console.log(
					`[avail] .limo fetch failed (${(err as Error).message}), falling back to ${fallbackUrl}`,
				);
				source = 'preview-fallback';
			}
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return { ms: Date.now() - started, switched: false, source };
}

/** Check 2/3 — time (ms) until the given gateway returns 200 for the CID. */
export async function checkRetrievable(url: string): Promise<GatewayResult> {
	const started = Date.now();
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				method: 'HEAD',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (res.status === 200) {
				return { ms: Date.now() - started, reached: true };
			}
		} catch {
			/* retry */
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return { ms: Date.now() - started, reached: false };
}

export interface Availability {
	publication: string;
	cid: string;
	limo: LimoResult;
	pinata: GatewayResult;
	ipfsio: GatewayResult;
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

/** ONE summary comparing the three timings vs the .limo switch. */
export function logAvailability(a: Availability): void {
	// Every gateway reports a number in ms; a gateway that never retrieved
	// reports the full window, which .limo naturally beats.
	const gateways: GatewayResult[] = [a.pinata, a.ipfsio];

	// 'graceful' only when .limo switched at-or-before EVERY gateway (each a
	// number). If any gateway beat limo, or limo never switched, it's exposed.
	const graceful =
		a.limo.switched && gateways.every((g) => a.limo.ms <= g.ms);
	const verdict = graceful
		? 'graceful (limo switched at-or-before every gateway)'
		: 'exposed (some gateway retrievable before limo switched, or none retrieved)';

	console.log(
		`[avail] publish ${a.publication} cid=${a.cid}\n` +
			`  .limo switch:  ${a.limo.ms}ms (switched: ${a.limo.switched}, ${a.limo.source})\n` +
			`  pinata:        ${a.pinata.ms}ms (reached: ${a.pinata.reached})\n` +
			`  ipfs.io:       ${a.ipfsio.ms}ms (reached: ${a.ipfsio.reached})\n` +
			`  — ${verdict}`,
	);
}
