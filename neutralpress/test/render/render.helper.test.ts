/**
 * Unit tests for the pure render-pipeline helpers in src/render/render.helper.ts.
 *
 * Covered:
 *   - buildRpcEndpoints: deterministic DRPC/Alchemy RPC URL construction for
 *     ETH_MAINNET (L1) and BASE (L2), driven by the plugin's `rpc_key` setting
 *     and the hardcoded Alchemy key — including the empty `rpc_key` path.
 *   - pagePathFor: CID-aware render-path normalisation — digest compare against
 *     the publish root CID (v0/v1 share the multihash digest), spurious-prefix
 *     dropping for unparseable segments, bare `/ipfs/<cid>` fold, and
 *     querystring/hash preservation.
 *
 * `renderCalls` is intentionally NOT invoked here: it drives the Lit render
 * pipeline and builds DOM fragments (`document.createDocumentFragment()`,
 * `new Notice(...)`) which are undefined in the node test environment. The
 * module import is safe — `renderCalls` is defined but never called.
 */

import { describe, it, expect } from 'vitest';
import { buildRpcEndpoints, pagePathFor } from '../../src/render/render.helper';
import { makeMain } from '../helpers/main';

// Hardcoded in buildRpcEndpoints (not read from settings).
const ALCHEMY_KEY = 'NFOkRqUo2swIC9g5tRJ7c';

// Real CIDv0 strings whose multihash digests are distinct (verified via the
// shared `parseCID`). Each v1 form shares its v0 digest — used to exercise the
// digest-wise compare in pagePathFor.
const ROOT_CID_V0 = 'QmZULkCELmmk5XNfCgTnCyFgAVxBRBXyDHGGMVoLFLiXEN';
const ROOT_CID_V1 = 'bafybeiffndsajwhk3lwjewwdxqntmjm4b5wxaaanokonsggenkbw6slwk4';
const OTHER_CID_V0 = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR';
const OTHER_CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

describe('buildRpcEndpoints', () => {
	it('builds deterministic L1/L2 endpoint pairs from the rpc_key setting', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = 'drpc_test';

		expect(buildRpcEndpoints(main as any)).toEqual({
			L1: [
				'https://lb.drpc.live/ethereum/drpc_test',
				`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
			],
			L2: [
				'https://lb.drpc.live/base/drpc_test',
				`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
			],
		});
	});

	it('surfaces the exact rpc_key set on oxo.ctrlr.plugin.settings', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = 'my-secret-key';

		const rpcs = buildRpcEndpoints(main as any);
		expect(rpcs.L1[0]).toBe('https://lb.drpc.live/ethereum/my-secret-key');
		expect(rpcs.L2[0]).toBe('https://lb.drpc.live/base/my-secret-key');
	});

	it('L1 vs L2 differ only in the DRPC network slug; Alchemy host mirrors the chain', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = 'k';
		const { L1, L2 } = buildRpcEndpoints(main as any);

		expect(L1[0]).toContain('/ethereum/');
		expect(L2[0]).toContain('/base/');
		expect(L1[1]).toContain('eth-mainnet.g.alchemy.com');
		expect(L2[1]).toContain('base-mainnet.g.alchemy.com');
		// Same key is reused across both chains.
		expect(L1[1]).toBe(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`);
		expect(L2[1]).toBe(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`);
	});

	it('handles the empty rpc_key path without throwing (Alchemy still keyed)', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = '';

		const rpcs = buildRpcEndpoints(main as any);
		expect(rpcs.L1[0]).toBe('https://lb.drpc.live/ethereum/');
		expect(rpcs.L2[0]).toBe('https://lb.drpc.live/base/');
		expect(rpcs.L1[1]).toContain(`/v2/${ALCHEMY_KEY}`);
	});
});

describe('pagePathFor', () => {
	it('leaves a path with no leading /ipfs/<cid> unchanged', () => {
		expect(pagePathFor('/posts/hello', ROOT_CID_V0)).toBe('/posts/hello');
		expect(pagePathFor('/', ROOT_CID_V0)).toBe('/');
	});

	it('strips a leading /ipfs/<cid> when the digest matches the root CID', () => {
		expect(pagePathFor(`/ipfs/${ROOT_CID_V0}/posts/hello`, ROOT_CID_V0)).toBe('/posts/hello');
		expect(pagePathFor(`/ipfs/${ROOT_CID_V0}/assets/a.css`, ROOT_CID_V0)).toBe('/assets/a.css');
	});

	it('matches across CIDv0 and CIDv1 of the same multihash (digest compare)', () => {
		// v1 path prefix vs v0 root, and vice versa.
		expect(pagePathFor(`/ipfs/${ROOT_CID_V1}/posts/hello`, ROOT_CID_V0)).toBe('/posts/hello');
		expect(pagePathFor(`/ipfs/${ROOT_CID_V0}/posts/hello`, ROOT_CID_V1)).toBe('/posts/hello');
	});

	it('keeps the path unchanged when the prefix is a different CID', () => {
		const res = `/ipfs/${OTHER_CID_V0}/posts/hello`;
		expect(pagePathFor(res, ROOT_CID_V0)).toBe(res);
		// v1-form foreign CID also counts as non-matching.
		const resV1 = `/ipfs/${OTHER_CID_V1}/posts/hello`;
		expect(pagePathFor(resV1, ROOT_CID_V0)).toBe(resV1);
	});

	it('treats an unparseable segment as a spurious prefix and drops it', () => {
		expect(pagePathFor('/ipfs/not-a-cid/posts/hello', ROOT_CID_V0)).toBe('/posts/hello');
	});

	it('folds a bare /ipfs/<cid> to "/" when it matches the root', () => {
		expect(pagePathFor(`/ipfs/${ROOT_CID_V0}`, ROOT_CID_V0)).toBe('/');
		expect(pagePathFor(`/ipfs/${ROOT_CID_V1}`, ROOT_CID_V0)).toBe('/');
	});

	it('preserves querystring and hash fragments when stripping the prefix', () => {
		expect(pagePathFor(`/ipfs/${ROOT_CID_V0}/posts/hello?ref=1#top`, ROOT_CID_V0)).toBe(
			'/posts/hello?ref=1#top',
		);
	});

	it('leaves degenerate empty-segment paths untouched (regex does not match)', () => {
		// `/ipfs//x` has no non-slash segment, so the regex doesn't match and the
		// path is returned as-is rather than silently mangled.
		expect(pagePathFor('/ipfs//x', ROOT_CID_V0)).toBe('/ipfs//x');
	});
});
