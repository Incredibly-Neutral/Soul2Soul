/**
 * Tests for IPFS tree traversal with a stubbed KuboClient.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { KuboClient, type KuboLsResult, type KuboLink } from '../src/ipfs/kubo.js';
import { Mirror } from '../src/mirror.js';

// Test directory for output
const TEST_WEBROOT = '.test-webroot';

/**
 * A stub KuboClient that returns predefined responses without hitting a real server.
 */
class StubKuboClient extends KuboClient {
  private readonly lsResponses: Map<string, KuboLsResult> = new Map();
  private readonly catResponses: Map<string, Uint8Array> = new Map();

  constructor() {
    super('http://stub.local:5001');
  }

  addLsResponse(cid: string, links: KuboLink[]): void {
    this.lsResponses.set(cid, {
      Objects: [{ Hash: { '/': cid }, Links: links }],
    });
  }

  addCatResponse(cid: string, content: string | Uint8Array): void {
    this.catResponses.set(
      cid,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    );
  }

  override async ls(cid: string): Promise<KuboLsResult> {
    const result = this.lsResponses.get(cid);
    if (!result) {
      // If no ls response is registered, throw like a real ls would for a file leaf
      throw new Error(`Stub: no ls data for ${cid}`);
    }
    return result;
  }

  override async catBytes(cid: string): Promise<ArrayBuffer> {
    const content = this.catResponses.get(cid);
    if (!content) {
      throw new Error(`Stub: no cat data for ${cid}`);
    }
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
  }
}

describe('Mirror traversal with stubbed kubo', () => {
  let stub: StubKuboClient;
  let mirror: Mirror;

  beforeEach(async () => {
    // Clean up any previous test artifacts
    await fsp.rm(TEST_WEBROOT, { recursive: true, force: true });

    stub = new StubKuboClient();
    mirror = new Mirror(stub, TEST_WEBROOT);
  });

  afterEach(async () => {
    await fsp.rm(TEST_WEBROOT, { recursive: true, force: true });
  });

  it('downloads a single file (no links = leaf)', async () => {
    const rootCid = 'QmLeafFile';
    stub.addCatResponse(rootCid, '<html><body>Hello</body></html>');

    const result = await mirror.refresh(rootCid);
    expect(result.files).toBe(1);
    expect(result.rootCid).toBe(rootCid);

    // Check the file was written
    const content = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'index.html'),
      'utf-8',
    );
    expect(content).toBe('<html><body>Hello</body></html>');
  });

  it('downloads a flat directory tree', async () => {
    const rootCid = 'QmRoot';
    const file1Cid = 'QmFile1';
    const file2Cid = 'QmFile2';

    // Root is a directory with two files
    stub.addLsResponse(rootCid, [
      { Name: 'index.html', Hash: { '/': file1Cid }, Tsize: 100 },
      { Name: 'about.html', Hash: { '/': file2Cid }, Tsize: 200 },
    ]);

    stub.addCatResponse(file1Cid, '<h1>Home</h1>');
    stub.addCatResponse(file2Cid, '<h1>About</h1>');

    const result = await mirror.refresh(rootCid);
    expect(result.files).toBe(2);

    const home = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'index.html'),
      'utf-8',
    );
    expect(home).toBe('<h1>Home</h1>');

    const about = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'about.html'),
      'utf-8',
    );
    expect(about).toBe('<h1>About</h1>');
  });

  it('downloads a nested directory tree', async () => {
    const rootCid = 'QmNested';
    const dirCid = 'QmAssets';
    const file1Cid = 'QmLogo';
    const file2Cid = 'QmStyle';

    // Root has one file and one directory
    stub.addLsResponse(rootCid, [
      { Name: 'index.html', Hash: { '/': file1Cid }, Tsize: 50 },
      { Name: 'assets', Hash: { '/': dirCid }, Tsize: 0 },
    ]);

    // Assets dir has one file
    stub.addLsResponse(dirCid, [
      { Name: 'style.css', Hash: { '/': file2Cid }, Tsize: 300 },
    ]);

    stub.addCatResponse(file1Cid, '<h1>Home</h1>');
    stub.addCatResponse(file2Cid, 'body { color: red; }');

    const result = await mirror.refresh(rootCid);
    expect(result.files).toBe(2);

    // Check structure
    const indexHtml = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'index.html'),
      'utf-8',
    );
    expect(indexHtml).toBe('<h1>Home</h1>');

    const styleCss = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'assets', 'style.css'),
      'utf-8',
    );
    expect(styleCss).toBe('body { color: red; }');
  });

  it('performs atomic swap (staging is not visible after success)', async () => {
    const rootCid = 'QmAtomic';
    stub.addCatResponse(rootCid, 'atomic content');
    // Single file leaf — ls fails, falls back to cat

    // First refresh
    await mirror.refresh(rootCid);

    // Staging directory should NOT exist after refresh
    const stagingExists = fs.existsSync(path.join(TEST_WEBROOT, '.staging'));
    expect(stagingExists).toBe(false);

    // Content should be in "current"
    const content = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'index.html'),
      'utf-8',
    );
    expect(content).toBe('atomic content');
  });

  it('tracks state after refresh', async () => {
    const rootCid = 'QmState';
    stub.addCatResponse(rootCid, 'state content');

    const result = await mirror.refresh(rootCid);
    expect(result.files).toBe(1);
    expect(result.rootCid).toBe(rootCid);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.refreshedAt).toBeTruthy();

    // Check via getState
    const state = mirror.getState();
    expect(state.rootCid).toBe(rootCid);
    expect(state.files).toBe(1);
    expect(state.error).toBeNull();
  });
});
