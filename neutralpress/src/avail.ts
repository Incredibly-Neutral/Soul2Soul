import { parseCID } from '@s2s/soul2soul-shared';

/**
 * Publish availability measurement (minimal).
 *
 * Four fire-and-forget checks run after a publish, each polling for a bounded
 * window and reporting a timing in ms since the check started:
 *   1. .link cache-switch detection  (GET the publication front, x-ipfs-path matched the new CID)
 *   2. pinata API status             (authenticated GET /data/pinList confirms the CID is pinned)
 *   3. ipfs.io retrievability        (HEAD ipfs.io returns 200)
 *   4. filecoin retrievability       (poll the SP via isRetrievable(pieceCid))
 * A single console.log summarizes the four timings.
 * Every check always returns a number in ms — a check that never hit within
 * the window reports the full window elapsed.
 *
 * Check 4 does NOT import the Filecoin SDK: neutralpress deliberately keeps
 * @filoz/synapse-sdk (and the whole Filecoin module) out of the plugin bundle
 * (see main.ctrlr.ts). Filecoin is indexed by PIECE CID (bafkz…), not the root
 * IPFS CID, so the leg needs the pieceCid produced by the upload. The caller
 * threads that pieceCid plus the already session-key-initialized
 * FilecoinController (`this.oxo.ctrlr.storage`) as an opaque `unknown`; this
 * module only calls the existing `isRetrievable(pieceCid)` probe.
 */

const POLL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Compare two CID strings by version-independent multihash digest. */
function sameCid(a: string, b: string): boolean {
	try {
		return bytesEqual(parseCID(a).digest, parseCID(b).digest);
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
}

export interface GatewayResult {
	/** ms until the gateway returned 200, or the full window if never. */
	ms: number;
	/** true if a 200 came back within the window, false if it never did. */
	reached: boolean;
}

export interface PinataResult extends GatewayResult {
	/** Last observed pinList status (e.g. 'pinned', 'failed', 'searching'). */
	status?: string;
}

/** Check 1 — .link cache-switch detection (GET the publication front). */
export async function checkLimoCacheSwitch(
	publication: string,
	newCid: string,
): Promise<LimoResult> {
	const linkUrl = `https://${publication}.link/`;
	const started = Date.now();
	const deadline = Date.now() + POLL_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(linkUrl, {
				method: 'GET',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const served = cidFromIpfsPath(res.headers.get('x-ipfs-path') ?? '');
			if (res.status < 400 && served && sameCid(served, newCid)) {
				return { ms: Date.now() - started, switched: true };
			}
		} catch {
			/* retry silently — no fallback */
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return { ms: Date.now() - started, switched: false };
}

/** Check 2 — time (ms) until Pinata has stored the CID, via its authenticated API. */
export async function checkPinataStatus(cid: string, jwt: string): Promise<PinataResult> {
	const started = Date.now();
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	const url = `https://api.pinata.cloud/data/pinList?cid=${cid}&status=all&pageLimit=1&includeCount=false`;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${jwt}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (res.ok) {
				const data = await res.json();
				const rows = data?.rows;
				if (Array.isArray(rows) && rows.length > 0) {
					const row = rows[0];
					const status = row.status;
					// Defensive terminal-failure log: a status that is present and
					// terminal (e.g. 'failed') means the pin can never be reachable.
					if (status === 'failed') {
						console.log(`[avail] pinata failed: ${status}`);
						return { ms: Date.now() - started, reached: false, status };
					}
					// A matching row with non-zero size is the ground-truth 'pinata
					// has the object' signal — `status` is omitted when pinned.
					if (row.size > 0) {
						return { ms: Date.now() - started, reached: true, status };
					}
				}
			}
		} catch {
			/* retry silently — non-2xx / JSON parse errors */
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return { ms: Date.now() - started, reached: false };
}

/** Check 3 — time (ms) until the given gateway returns 200 for the CID. */
export async function checkRetrievable(
	url: string,
	method: 'HEAD' | 'GET' = 'HEAD',
): Promise<GatewayResult> {
	const started = Date.now();
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				method,
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

/**
 * Check 4 — time (ms) until the Filecoin storage provider (SP) confirms it
 * serves the piece for this publish. Polls the existing
 * `storage.isRetrievable(pieceCid)` probe (a real HTTP GET of the SP's
 * PDP/CDN URL — the strongest "the SP serves the bytes" signal) every
 * POLL_INTERVAL_MS until it returns true, up to POLL_TIMEOUT_MS.
 *
 * Filecoin is indexed by PIECE CID (bafkz…), not the root IPFS CID, so the
 * caller must supply the pieceCid that the upload produced.
 *
 * Defensive, never throws: when no pieceCid is available or the storage is
 * unusable (the Filecoin upload is currently broken upstream, so a valid
 * pieceCid may never arrive), it reports reached:false with the full window
 * and leaves the other three legs unaffected.
 *
 * @param opts.pieceCid the Filecoin piece CID to probe (empty if none).
 * @param opts.dataSetId optional Filecoin dataset id (threaded for context).
 * @param storage       the session-key-initialized FilecoinController, kept an
 *                      opaque `unknown` so neutralpress stays SDK-free.
 */
export async function checkFilecoinStatus(
	opts: { pieceCid: string; dataSetId?: string },
	storage: unknown, // FilecoinController (FilecoinStorage) — opaque to avoid the SDK import
): Promise<GatewayResult> {
	const started = Date.now();
	const deadline = Date.now() + POLL_TIMEOUT_MS;

	const probe = (storage as { isRetrievable?: (pieceCid: string) => Promise<boolean> } | undefined)
		?.isRetrievable;

	// No piece CID (upload never produced one) or no usable probe: the leg can
	// never reach — report the full window without touching the other legs.
	if (!opts.pieceCid || typeof probe !== 'function') {
		return { ms: POLL_TIMEOUT_MS, reached: false };
	}

	while (Date.now() < deadline) {
		try {
			if (await probe(opts.pieceCid)) {
				return { ms: Date.now() - started, reached: true };
			}
		} catch {
			/* retry silently — transient provider errors */
		}
		await sleep(POLL_INTERVAL_MS);
	}
	return { ms: Date.now() - started, reached: false };
}

export interface Availability {
	publication: string;
	cid: string;
	limo: LimoResult;
	pinata: PinataResult;
	ipfsio: GatewayResult;
	filecoin: GatewayResult;
}

/**
 * Run the three HTTP legs in parallel and return the partial Availability
 * (without the Filecoin leg). The Filecoin leg is chained separately by the
 * caller (it needs the piece CID produced by the upload, which is only known
 * after the upload resolves), and the caller then calls logAvailability with
 * all four legs.
 */
export async function measureAvailability(
	publication: string,
	cid: string,
	pinataJwt: string,
): Promise<Omit<Availability, 'filecoin'>> {
	const [limo, pinata, ipfsio] = await Promise.all([
		checkLimoCacheSwitch(publication, cid),
		checkPinataStatus(cid, pinataJwt),
		checkRetrievable(`https://ipfs.io/ipfs/${cid}`),
	]);
	return { publication, cid, limo, pinata, ipfsio };
}

/** Log the four per-check timings. */
export function logAvailability(a: Availability): void {
	console.log(
		`[avail] publish ${a.publication} cid=${a.cid}\n` +
			`  .link switch:  ${a.limo.ms}ms (switched: ${a.limo.switched})\n` +
			`  pinata:        ${a.pinata.ms}ms (reached: ${a.pinata.reached})\n` +
			`  ipfs.io:       ${a.ipfsio.ms}ms (reached: ${a.ipfsio.reached})\n` +
			`  filecoin:      ${a.filecoin.ms}ms (reached: ${a.filecoin.reached})`,
	);
}
