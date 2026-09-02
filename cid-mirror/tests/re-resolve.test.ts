/**
 * Tests for ENS re-resolution on refresh (B1 fix).
 *
 * Ensures that `mirror.refreshResolved()` re-resolves the ENS name to the
 * latest contenthash CID before traversing, rather than using a stale CID
 * captured at startup.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock the ENS module BEFORE any source imports so that Mirror's import of
// resolveEnsToCID also gets the mock.
// vi.hoisted runs before vi.mock factories, so the fn is available.
// ---------------------------------------------------------------------------
const { mockResolveEnsToCID } = vi.hoisted(() => ({
  mockResolveEnsToCID: vi.fn(),
}));

vi.mock('../src/ens.js', () => ({
  isBareCID: (v: string) => v.startsWith('Qm') || v.startsWith('b') || v.startsWith('1'),
  isEnsName: (v: string) => v.endsWith('.eth') || v.includes('.eth.'),
  resolveEnsToCID: mockResolveEnsToCID,
  extractEnsName: (v: string) => v,
  namehash: () => '0x' + '00'.repeat(32),
}));

// ---------------------------------------------------------------------------
// Source imports (the ENS module is now mocked)
// ---------------------------------------------------------------------------
import { KuboClient } from '../src/ipfs/kubo.js';
import { Mirror } from '../src/mirror.js';

const TEST_WEBROOT = '.test-webroot-resolve';

class StubKuboClient extends KuboClient {
  private readonly lsResponses: Map<string, any> = new Map();
  private readonly catResponses: Map<string, Uint8Array> = new Map();

  constructor() {
    super('http://stub.local:5001');
  }

  addCatResponse(cid: string, content: string | Uint8Array): void {
    this.catResponses.set(
      cid,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    );
  }

  override async ls(_cid: string): Promise<any> {
    throw new Error('Stub: ls not registered — treating as file leaf');
  }

  override async catBytes(cid: string): Promise<ArrayBuffer> {
    const content = this.catResponses.get(cid);
    if (!content) throw new Error(`Stub: no cat data for ${cid}`);
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
  }
}

describe('ENS re-resolution on refresh', () => {
  let stub: StubKuboClient;
  let mirror: Mirror;

  beforeEach(async () => {
    await fsp.rm(TEST_WEBROOT, { recursive: true, force: true });
    mockResolveEnsToCID.mockReset();

    stub = new StubKuboClient();
    // Create mirror with ENS publication URL — triggers re-resolution path
    mirror = new Mirror(
      stub,
      TEST_WEBROOT,
      'app.soul2soul.eth',
      'https://rpc.example.com', // l1RpcUrl
      'https://l2-rpc.example.com', // l2RpcUrl
      '0x' + 'aa'.repeat(20), // recordsContract override
    );
  });

  afterEach(async () => {
    await fsp.rm(TEST_WEBROOT, { recursive: true, force: true });
  });

  it('re-resolves ENS name before traversing on refreshResolved', async () => {
    // The ENS resolver should return the latest CID
    const latestCid = 'QmFreshlyResolved';
    mockResolveEnsToCID.mockResolvedValue(latestCid);
    stub.addCatResponse(latestCid, 'content from fresh ENS resolution');

    const result = await mirror.refreshResolved();

    // Verify ENS was re-resolved (the mock was called), threading the
    // l2RpcUrl / recordsContract constructor options through refreshResolved.
    expect(mockResolveEnsToCID).toHaveBeenCalledTimes(1);
    expect(mockResolveEnsToCID).toHaveBeenCalledWith(
      'app.soul2soul.eth',
      'https://rpc.example.com',
      'https://l2-rpc.example.com',
      '0x' + 'aa'.repeat(20),
    );

    // Verify the fresh CID was used
    expect(result.rootCid).toBe(latestCid);
    expect(result.files).toBe(1);

    const state = mirror.getState();
    expect(state.rootCid).toBe(latestCid);

    // Verify file content was downloaded using the fresh CID
    const content = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'index.html'),
      'utf-8',
    );
    expect(content).toBe('content from fresh ENS resolution');
  });

  it('throws when ENS re-resolution returns null', async () => {
    mockResolveEnsToCID.mockResolvedValue(null);

    await expect(mirror.refreshResolved()).rejects.toThrow(
      'ENS re-resolution failed',
    );
    expect(mockResolveEnsToCID).toHaveBeenCalledTimes(1);
  });
});
