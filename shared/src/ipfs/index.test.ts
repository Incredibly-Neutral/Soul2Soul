import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { S2SIPFSMethods } from './index';

// ============================================================================
// S2SIPFSMethods — Kubo RPC bearer-token injection.
//
// The data gateway token-gates write RPC commands (add, dag/put, files/*).
// This client (used by neutralpress new-publication and the safe-app) must send
// `Authorization: Bearer <token>` on every Kubo RPC call once the token is
// configured, or its writes 401.
// ============================================================================

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const make = (token?: string) =>
  new S2SIPFSMethods('ipfs.transport-union.dev', 'pinata-jwt', '', '', token);

const headersOf = () => {
  const [, options] = mockFetch.mock.calls[0];
  return new Headers(options.headers as Record<string, string>);
};

describe('S2SIPFSMethods kubo auth injection', () => {
  it('sends NO Authorization header when no token is configured', async () => {
    const ipfs = make();
    await ipfs.fetchFromKubo('bafyabc');
    expect(headersOf().get('Authorization')).toBeNull();
  });

  it('injects Authorization: Bearer <token> on kuboPost (MFS + dag/get + cat)', async () => {
    const ipfs = make('sekret');
    await ipfs.mfsList('/tmp/x'); // routes through kuboPost
    expect(headersOf().get('Authorization')).toBe('Bearer sekret');
  });

  it('injects the token on addToKubo (/api/v0/add)', async () => {
    const ipfs = make('sekret');
    await ipfs.addToKubo('hello', 'f.txt');
    expect(headersOf().get('Authorization')).toBe('Bearer sekret');
  });

  it('injects the token on dagPut (/api/v0/dag/put)', async () => {
    const ipfs = make('sekret');
    mockFetch.mockResolvedValue(new Response('{"Cid":{"/":"QmX"}}', { status: 200 }));
    await ipfs.dagPut('{"a":1}', 'dag.json');
    expect(headersOf().get('Authorization')).toBe('Bearer sekret');
  });

  it('does NOT leak the Kubo token to Filebase/Pinata uploads', async () => {
    const ipfs = make('sekret');
    mockFetch.mockResolvedValue(new Response('{"Hash":"QmX"}', { status: 200 }));
    await ipfs.uploadToPinata('data', 'f.txt', 'filebase');
    // Header is `Bearer <filebaseToken>` (empty here) — never the Kubo token.
    expect(headersOf().get('Authorization')).toBe('Bearer');
  });
});

// ============================================================================
// backupToProviders — back up a kubo upload at filebase + pinata (+ filecoin).
// Fire-and-forget: never throws, all legs concurrent, per-leg result returned.
// ============================================================================

/** Instance carrying both pin tokens (filebase token + pinata JWT). */
const makeFull = () =>
	new S2SIPFSMethods('ipfs.transport-union.dev', 'pinata-jwt', '', 'filebase-token');

/** Find the fetch call made to a specific provider endpoint. */
const callFor = (url: string) =>
	mockFetch.mock.calls.find(([u]) => u === url) as any[] | undefined;

const authOf = (url: string) => {
	const call = callFor(url);
	expect(call).toBeDefined();
	const [, options] = call!;
	return new Headers(options.headers as Record<string, string>).get('Authorization');
};

describe('backupToProviders', () => {
	// The outer beforeEach resolves ONE shared Response instance for every call,
	// but a Response body can only be consumed once — with concurrent pin legs a
	// shared body makes the second .json() throw. Give each call a fresh Response.
	beforeEach(() => {
		mockFetch.mockImplementation(async () => new Response('{}', { status: 200 }));
	});

	it('fires filebase + pinata pins for the CID by default (filecoin skipped)', async () => {
		const ipfs = makeFull();
		const result = await ipfs.backupToProviders('QmX');

		const urls = mockFetch.mock.calls.map(([u]) => u);
		expect(urls).toContain('https://api.filebase.io/v1/ipfs/pins');
		expect(urls).toContain('https://api.pinata.cloud/pinning/pinByHash');
		expect(result.filebase).toBe(true);
		expect(result.pinata).toBe(true);
		expect(result.filecoin).toBe('skipped');
	});

	it('sends the instance tokens to the respective providers (no kubo token leak)', async () => {
		const ipfs = makeFull();
		await ipfs.backupToProviders('QmX');

		expect(authOf('https://api.filebase.io/v1/ipfs/pins')).toBe('Bearer filebase-token');
		expect(authOf('https://api.pinata.cloud/pinning/pinByHash')).toBe('Bearer pinata-jwt');
	});

	it('honours per-call token overrides', async () => {
		const ipfs = makeFull();
		await ipfs.backupToProviders('QmX', {
			filebaseToken: 'override-fb',
			pinataJwt: 'override-p',
		});

		expect(authOf('https://api.filebase.io/v1/ipfs/pins')).toBe('Bearer override-fb');
		expect(authOf('https://api.pinata.cloud/pinning/pinByHash')).toBe('Bearer override-p');
	});

	it('honours the providers option (filebase only, no pinata call)', async () => {
		const ipfs = makeFull();
		const result = await ipfs.backupToProviders('QmX', { providers: ['filebase'] });

		const urls = mockFetch.mock.calls.map(([u]) => u);
		expect(urls).toContain('https://api.filebase.io/v1/ipfs/pins');
		expect(urls).not.toContain('https://api.pinata.cloud/pinning/pinByHash');
		expect(result.filebase).toBe(true);
		expect(result.pinata).toBe(false);
	});

	it('uses the normalised kubo source as Pinata sourceIpfs (kuboUrl override)', async () => {
		const ipfs = makeFull();
		await ipfs.backupToProviders('QmX', { kuboUrl: 'custom.ipfs.example' });

		const call = callFor('https://api.pinata.cloud/pinning/pinByHash')!;
		const body = JSON.parse((call[1].body as string) || '{}');
		expect(body.pinataOptions.sourceIpfs.apiUrl).toBe('https://custom.ipfs.example/api/v0');
	});

	it('runs the filecoin leg with the CID and reports ok on CID parity', async () => {
		const ipfs = makeFull();
		const filecoin = vi.fn(async () => ({ rootCid: 'QmX' }));

		const result = await ipfs.backupToProviders('QmX', { filecoin });

		expect(filecoin).toHaveBeenCalledWith('QmX');
		expect(result.filecoin).toBe('ok');
	});

	it('reports mismatch and invokes onFilecoinMismatch when rootCid differs', async () => {
		const ipfs = makeFull();
		const onMismatch = vi.fn();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await ipfs.backupToProviders('QmX', {
			filecoin: async () => ({ rootCid: 'QmDIFFERENT' }),
			onFilecoinMismatch: onMismatch,
		});

		expect(result.filecoin).toBe('mismatch');
		expect(onMismatch).toHaveBeenCalledWith('QmDIFFERENT');
		expect(errorSpy.mock.calls[0][0]).toContain('[backup] CID mismatch');
		errorSpy.mockRestore();
	});

	it('reports failed when the filecoin leg rejects — never throws', async () => {
		const ipfs = makeFull();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await ipfs.backupToProviders('QmX', {
			filecoin: async () => {
				throw new Error('synapse down');
			},
		});

		expect(result.filecoin).toBe('failed');
		errorSpy.mockRestore();
	});

	it('treats a missing filecoin rootCid as success (no parity check data)', async () => {
		const ipfs = makeFull();
		const result = await ipfs.backupToProviders('QmX', { filecoin: async () => ({ pieceCid: 'p' }) });
		expect(result.filecoin).toBe('ok');
	});

	it('never throws when every pin service rejects (fire-and-forget)', async () => {
		const ipfs = makeFull();
		mockFetch.mockImplementation(async () => new Response('err', { status: 500 }));

		await expect(ipfs.backupToProviders('QmX')).resolves.toMatchObject({
			filebase: false,
			pinata: false,
		});
	});
});
