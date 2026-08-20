/**
 * Regression test — evm-update Lit action crash on overwrite:
 *   "TypeError: Cannot read properties of null (reading 'call')"
 *
 * Root cause: verifyRevocable() and verifyPathAvailable() built their hasDeal
 * Contract from a provider DESTRUCTURED OFF A PROVIDER INSTANCE:
 *
 *   const { provider } = new ethers.providers.StaticJsonRpcProvider(...);
 *
 * A StaticJsonRpcProvider instance has no `provider` property, so the
 * destructure yields `undefined`. ethers v5 then sets `contract.provider =
 * null`, and `contract.hasDeal(...)` reads `this.provider.call(...)` and
 * throws the TypeError above — i.e. every time an existing page at the
 * destination is overwritten with different content.
 *
 * The fix constructs the provider directly:
 *
 *   const provider = new ethers.providers.StaticJsonRpcProvider(...);
 *
 * This test (a) proves the OLD pattern produces `contract.provider === null`
 * and the exact production TypeError, and (b) drives the REAL
 * verifyRevocable()/verifyPathAvailable() against a local JSON-RPC stub so
 * the fixed construction is exercised end-to-end (no external network).
 * Reverting verify.ts to the destructuring pattern FAILS this file.
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

const HAS_DEAL_ABI = ['function hasDeal(bytes32 genesis) view returns (bool)'];
const PUB_MODULE = '0x' + '11'.repeat(20);
const GENESIS_BYTES32 = '0x' + '22'.repeat(32);

// ---------------------------------------------------------------------------
// Local JSON-RPC stub — offline, deterministic replacement for the Base RPC.
// ---------------------------------------------------------------------------

let server: http.Server;
let rpcUrl: string;
let nextHasDeal = false; // per-test switch for the eth_call (hasDeal) result

const boolToHex32 = (value: boolean): string => '0x' + '00'.repeat(31) + (value ? '01' : '00');

const stubResult = (method: string): string => {
  switch (method) {
    case 'net_version':
      return '8453';
    case 'eth_chainId':
      return '0x2105';
    case 'eth_call':
      return boolToHex32(nextHasDeal);
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
  nextHasDeal = false;
});

// ---------------------------------------------------------------------------
// (a) Construction pattern — the old (buggy) vs the fixed.
// Builds the provider/contract exactly the way verify.ts does.
// ---------------------------------------------------------------------------

describe('verify.ts provider construction pattern', () => {
  it('OLD pattern — destructuring { provider } off the instance yields undefined → contract.provider is null', () => {
    const instance = new ethers.providers.StaticJsonRpcProvider(rpcUrl, {
      chainId: 8453,
      name: 'base',
    });
    // Deliberately reproducing the buggy pattern: the instance has no `provider`
    // property (the cast makes that explicit — a direct destructure is a TS error).
    const { provider } = instance as any; // ← the buggy verify.ts pattern
    expect(provider).toBeUndefined();
    const contract = new ethers.Contract(PUB_MODULE, HAS_DEAL_ABI, provider);
    // ethers v5 sets contract.provider = null for an undefined signer/provider
    expect(contract.provider).toBeNull();
  });

  it('OLD pattern — hasDeal rejects with the EXACT production TypeError', async () => {
    const instance = new ethers.providers.StaticJsonRpcProvider(rpcUrl, {
      chainId: 8453,
      name: 'base',
    });
    const { provider } = instance as any; // ← the buggy verify.ts pattern
    const contract = new ethers.Contract(PUB_MODULE, HAS_DEAL_ABI, provider);
    await expect(contract.hasDeal(GENESIS_BYTES32)).rejects.toThrow(
      "Cannot read properties of null (reading 'call')",
    );
  });

  it('FIXED pattern — contract.provider is the real provider instance (non-null)', () => {
    const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, {
      chainId: 8453,
      name: 'base',
    });
    const contract = new ethers.Contract(PUB_MODULE, HAS_DEAL_ABI, provider);
    expect(contract.provider).not.toBeNull();
    expect(contract.provider).toBe(provider);
  });

  it('FIXED pattern — hasDeal completes a real RPC round-trip (no null-provider crash)', async () => {
    nextHasDeal = true;
    const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, {
      chainId: 8453,
      name: 'base',
    });
    const contract = new ethers.Contract(PUB_MODULE, HAS_DEAL_ABI, provider);
    await expect(contract.hasDeal(GENESIS_BYTES32)).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Real verify.ts functions end-to-end against the local RPC.
// Stubs only the IPFS gateway fetch; the provider/Contract/hasDeal path is
// the REAL code. With the old pattern these reject with the null-provider
// TypeError instead.
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
  it('verifyPathAvailable — overwrite with a DIFFERENT genesis reaches hasDeal and resolves when no deal is active', async () => {
    nextHasDeal = false;
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

  it('verifyPathAvailable — refuses the overwrite when the existing genesis HAS an active deal', async () => {
    nextHasDeal = true;
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
    nextHasDeal = true; // would throw if the RPC path were taken
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

  it('verifyRevocable — resolves when the existing page has no active deal', async () => {
    nextHasDeal = false;
    stubGateway('existing-genesis');
    await expect(
      verifyRevocable('http://gateway.test', '/root', 'some/page', PUB_MODULE, [rpcUrl]),
    ).resolves.toBeUndefined();
  });

  it('verifyRevocable — refuses removal when the existing page HAS an active deal', async () => {
    nextHasDeal = true;
    stubGateway('existing-genesis');
    await expect(
      verifyRevocable('http://gateway.test', '/root', 'some/page', PUB_MODULE, [rpcUrl]),
    ).rejects.toThrow('Refusing to remove: genesis');
  });
});
