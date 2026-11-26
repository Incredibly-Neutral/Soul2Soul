/**
 * `verify.ts` end-to-end against a local JSON-RPC stub — the chain question the
 * two gates ask (`hasAgreement`), with no external network.
 *
 * History this file was written against: both gates once built their own
 * `StaticJsonRpcProvider`, and one release destructured `{ provider }` off the
 * instance (a provider has no such property), which left `contract.provider`
 * null and made every overwrite of a different page throw
 * "Cannot read properties of null (reading 'call')". The gates now ask through
 * `evmRead` in `libs/evm.ts` — one cached, failing-over read — so the cases
 * below drive the real functions and pin the verdicts, not the construction:
 *   - a different, unbound page at the path → allowed;
 *   - the same genesis → allowed, and no chain read at all;
 *   - an active agreement → refused, both for an overwrite and for a removal.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as ethers from 'ethers5'; // protocol's v5 alias — verify.ts runs against ethers v5 semantics at runtime
import { verifyPathAvailable, verifyRevocable } from './verify';

// verify.ts references the Lit-runtime-injected global `ethers`
// (action_globals.ts); point it at the real ethers v5 so the real functions
// run unmocked.
(globalThis as { ethers?: unknown }).ethers = ethers;

const PUB_MODULE = '0x' + '11'.repeat(20);

// ---------------------------------------------------------------------------
// Local JSON-RPC stub — offline, deterministic replacement for the Base RPC.
// ---------------------------------------------------------------------------

let server: http.Server;
let rpcUrl: string;
let nextHasAgreement = false; // per-test switch for the eth_call (hasAgreement) result

const boolToHex32 = (value: boolean): string => '0x' + '00'.repeat(31) + (value ? '01' : '00');

const stubResult = (method: string): string => {
  switch (method) {
    case 'net_version':
      return '8453';
    case 'eth_chainId':
      return '0x2105';
    case 'eth_call':
      return boolToHex32(nextHasAgreement);
    default:
      return '0x';
  }
};

const jsonRpcResponse = (id: unknown, result: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed: any = JSON.parse(body);
      const reply = Array.isArray(parsed)
        ? JSON.stringify(parsed.map((m: any) => jsonRpcResponse(m.id, stubResult(m.method))))
        : jsonRpcResponse(parsed.id, stubResult(parsed.method));
      res.setHeader('content-type', 'application/json');
      res.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  rpcUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  nextHasAgreement = false;
});

// ---------------------------------------------------------------------------
// The real functions, against the local RPC. Only the IPFS gateway fetch is
// stubbed; provider selection, failover and the `hasAgreement` call are the real
// `libs/evm.ts` path.
// ---------------------------------------------------------------------------

const schemaHtml = (identifier: string): string =>
  `<!DOCTYPE html><html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    identifier,
    encoding: { sha256: 'deadbeef' },
  })}</script></head><body>page</body></html>`;

const stubGateway = (identifier: string): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(schemaHtml(identifier), { status: 200 })),
  );
};

describe('verify.ts real functions (end-to-end, local RPC)', () => {
  it('verifyPathAvailable — overwrite with a DIFFERENT genesis reaches hasAgreement and resolves when no agreement is active', async () => {
    nextHasAgreement = false;
    stubGateway('existing-genesis');
    await expect(
      verifyPathAvailable(
        'http://gateway.test',
        '/some/page',
        'incoming-genesis',
        PUB_MODULE,
        [rpcUrl],
      ),
    ).resolves.toBeUndefined();
  });

  it('verifyPathAvailable — refuses the overwrite when the existing genesis HAS an active agreement', async () => {
    nextHasAgreement = true;
    stubGateway('existing-genesis');
    await expect(
      verifyPathAvailable(
        'http://gateway.test',
        '/some/page',
        'incoming-genesis',
        PUB_MODULE,
        [rpcUrl],
      ),
    ).rejects.toThrow('Path occupied by genesis');
  });

  it('verifyPathAvailable — same genesis overwriting itself never touches the RPC', async () => {
    nextHasAgreement = true; // would throw if the RPC path were taken
    const fetchMock = vi.fn().mockResolvedValue(new Response(schemaHtml('same-genesis'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      verifyPathAvailable(
        'http://gateway.test',
        '/some/page',
        'same-genesis',
        PUB_MODULE,
        [rpcUrl],
      ),
    ).resolves.toBeUndefined();
  });

  it('verifyRevocable — resolves when the existing page has no active agreement', async () => {
    nextHasAgreement = false;
    stubGateway('existing-genesis');
    await expect(
      verifyRevocable('http://gateway.test', '/root', 'some/page', PUB_MODULE, [rpcUrl]),
    ).resolves.toBeUndefined();
  });

  it('verifyRevocable — refuses removal when the existing page HAS an active agreement', async () => {
    nextHasAgreement = true;
    stubGateway('existing-genesis');
    await expect(
      verifyRevocable('http://gateway.test', '/root', 'some/page', PUB_MODULE, [rpcUrl]),
    ).rejects.toThrow('Refusing to remove: genesis');
  });
});
