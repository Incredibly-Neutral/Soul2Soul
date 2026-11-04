/**
 * Unit tests for the pure render-pipeline helpers in src/render/render.helper.ts.
 *
 * Covered:
 *   - buildRpcEndpoints: deterministic DRPC RPC URL construction for
 *     ETH_MAINNET (L1) and BASE (L2), driven by the plugin's `rpc_key` setting
 *     (the DRPC API key) — including the empty `rpc_key` path. No fallback
 *     providers are wired in yet, so each chain carries exactly one endpoint.
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

// buildRpcEndpoints reads the DRPC API key from settings; no literals.

// Real CIDv0 strings whose multihash digests are distinct (verified via the
// shared `parseCID`). Each v1 form shares its v0 digest — used to exercise the
// digest-wise compare in pagePathFor.
const ROOT_CID_V0 = 'QmZULkCELmmk5XNfCgTnCyFgAVxBRBXyDHGGMVoLFLiXEN';
const ROOT_CID_V1 = 'bafybeiffndsajwhk3lwjewwdxqntmjm4b5wxaaanokonsggenkbw6slwk4';
const OTHER_CID_V0 = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR';
const OTHER_CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

describe('buildRpcEndpoints', () => {
	it('builds one DRPC endpoint per chain from the rpc_key setting', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = 'drpc_test';

		expect(buildRpcEndpoints(main as any)).toEqual({
			L1: ['https://lb.drpc.live/ethereum/drpc_test'],
			L2: ['https://lb.drpc.live/base/drpc_test'],
		});
	});

	it('surfaces the exact rpc_key set on oxo.ctrlr.plugin.settings', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = 'my-secret-key';

		const rpcs = buildRpcEndpoints(main as any);
		expect(rpcs.L1[0]).toBe('https://lb.drpc.live/ethereum/my-secret-key');
		expect(rpcs.L2[0]).toBe('https://lb.drpc.live/base/my-secret-key');
	});

	it('L1 vs L2 differ only in the DRPC network slug, same key on both', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = 'k';
		const { L1, L2 } = buildRpcEndpoints(main as any);

		expect(L1[0]).toContain('/ethereum/');
		expect(L2[0]).toContain('/base/');
		expect(L1).toHaveLength(1);
		expect(L2).toHaveLength(1);
	});

	it('handles the empty rpc_key path without throwing', () => {
		const main = makeMain();
		main.oxo.ctrlr.plugin.settings.rpc_key = '';

		const rpcs = buildRpcEndpoints(main as any);
		expect(rpcs.L1[0]).toBe('https://lb.drpc.live/ethereum/');
		expect(rpcs.L2[0]).toBe('https://lb.drpc.live/base/');
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
