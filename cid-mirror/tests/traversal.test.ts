/**
 * Tests for IPFS tree traversal with a stubbed KuboClient.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { KuboClient, hashToString, type KuboLsResult, type KuboLink } from '../src/ipfs/kubo.js';
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
    // Real kubo /api/v0/ls returns each object Hash as a plain CID string,
    // NOT a { '/': cid } JSON-CID object (that shape is what dag/get returns).
    this.lsResponses.set(cid, {
      Objects: [{ Hash: cid, Links: links }],
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

describe('hashToString', () => {
  it('passes a plain-string Hash through unchanged (real /api/v0/ls shape)', () => {
    expect(hashToString('QmPlain')).toBe('QmPlain');
  });

  it('unwraps a JSON-CID object Hash (dag/get shape)', () => {
    expect(hashToString({ '/': 'QmWrapped' })).toBe('QmWrapped');
  });

  it('throws a clear error for malformed hashes', () => {
    expect(() => hashToString(undefined)).toThrow(/Cannot resolve IPFS link hash/);
    expect(() => hashToString(null)).toThrow(/Cannot resolve IPFS link hash/);
    expect(() => hashToString({ '/': 42 } as unknown)).toThrow(/Cannot resolve IPFS link hash/);
    expect(() => hashToString('')).toThrow(/Cannot resolve IPFS link hash/);
  });
});

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

    // Root is a directory with two files. Real kubo ls shape: plain-string
    // Hash, Size>0 + Type:2 for files.
    stub.addLsResponse(rootCid, [
      { Name: 'index.html', Hash: file1Cid, Size: 100, Type: 2 },
      { Name: 'about.html', Hash: file2Cid, Size: 200, Type: 2 },
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

  it('downloads a nested directory tree (backwards compat: JSON-CID { "/": ... } Hash)', async () => {
    const rootCid = 'QmNested';
    const dirCid = 'QmAssets';
    const file1Cid = 'QmLogo';
    const file2Cid = 'QmStyle';

    // Root has one file and one directory. dag/get-style JSON-CID Hash shape
    // must still be accepted (backwards compat). Dirs use real ls fields:
    // Size:0 + Type:1 with a SLASH-LESS Name.
    stub.addLsResponse(rootCid, [
      { Name: 'index.html', Hash: { '/': file1Cid }, Size: 50, Type: 2 },
      { Name: 'assets', Hash: { '/': dirCid }, Size: 0, Type: 1 },
    ]);

    // Assets dir has one file
    stub.addLsResponse(dirCid, [
      { Name: 'style.css', Hash: { '/': file2Cid }, Size: 300, Type: 2 },
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

  it('downloads a directory whose links use the real kubo plain-string Hash (regression: Hash["/"])', async () => {
    const rootCid = 'QmRegRoot';
    const file1Cid = 'QmRegFile1';
    const file2Cid = 'QmRegFile2';
    const dirCid = 'QmRegAssets';
    const file3Cid = 'QmRegStyle';

    // Real kubo /api/v0/ls shape: each link's Hash is a plain CID string,
    // NOT a { '/': cid } JSON-CID object. The old client read link.Hash['/'],
    // which is `undefined` for a plain-string Hash, so catBytes(undefined)
    // failed on a real kubo node. This test must FAIL under that old code.
    // Dirs use real ls fields: Size:0 + Type:1 with SLASH-LESS Name.
    stub.addLsResponse(rootCid, [
      { Name: 'index.html', Hash: file1Cid, Size: 100, Type: 2 },
      { Name: 'about.html', Hash: file2Cid, Size: 200, Type: 2 },
      { Name: 'assets', Hash: dirCid, Size: 0, Type: 1 },
    ]);
    stub.addLsResponse(dirCid, [
      { Name: 'style.css', Hash: file3Cid, Size: 300, Type: 2 },
    ]);

    stub.addCatResponse(file1Cid, '<h1>Home</h1>');
    stub.addCatResponse(file2Cid, '<h1>About</h1>');
    stub.addCatResponse(file3Cid, 'body { color: red; }');

    const result = await mirror.refresh(rootCid);
    expect(result.files).toBe(3);

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

    const style = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'assets', 'style.css'),
      'utf-8',
    );
    expect(style).toBe('body { color: red; }');
  });

  it('downloads a NESTED subdirectory tree (regression: real ls dir-vs-file heuristic)', async () => {
    const rootCid = 'QmDeepRoot';
    const blogCid = 'QmBlog';
    const postsCid = 'QmPosts';
    const file1Cid = 'QmDeepIndex';
    const file2Cid = 'QmHomeMd';
    const file3Cid = 'QmHelloMd';

    // Real kubo /api/v0/ls: dirs have Size:0 + Type:1 and a SLASH-LESS Name
    // (no trailing '/'); files have Size>0 + Type:2. `Tsize` is NEVER
    // returned by /api/v0/ls, so the old `link.Tsize === 0 ||
    // link.Name.endsWith('/')` heuristic classified every real subdir as a
    // file and cat'd a directory CID (kubo returns HTTP 500 "this dag node
    // is a directory"). This test must FAIL under that old heuristic.
    stub.addLsResponse(rootCid, [
      { Name: 'index.html', Hash: file1Cid, Size: 100, Type: 2 },
      { Name: 'blog', Hash: blogCid, Size: 0, Type: 1 },
    ]);
    stub.addLsResponse(blogCid, [
      { Name: 'posts', Hash: postsCid, Size: 0, Type: 1 },
      { Name: 'home.md', Hash: file2Cid, Size: 50, Type: 2 },
    ]);
    stub.addLsResponse(postsCid, [
      { Name: 'hello.md', Hash: file3Cid, Size: 60, Type: 2 },
    ]);

    stub.addCatResponse(file1Cid, '<h1>Home</h1>');
    stub.addCatResponse(file2Cid, '# Home page');
    stub.addCatResponse(file3Cid, '# Hello world');

    const result = await mirror.refresh(rootCid);
    expect(result.files).toBe(3);

    const indexHtml = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'index.html'),
      'utf-8',
    );
    expect(indexHtml).toBe('<h1>Home</h1>');

    const homeMd = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'blog', 'home.md'),
      'utf-8',
    );
    expect(homeMd).toBe('# Home page');

    const helloMd = await fsp.readFile(
      path.join(TEST_WEBROOT, 'current', 'blog', 'posts', 'hello.md'),
      'utf-8',
    );
    expect(helloMd).toBe('# Hello world');
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
