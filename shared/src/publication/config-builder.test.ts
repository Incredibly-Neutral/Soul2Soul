import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { ConfigBuilder, parseGitHubUrl } from './config-builder';

// =============================================================================
// Helpers
// =============================================================================

function mockIPFS(): any {
  return {
    gateway: 'ipfs.mock',
    fetchFromKubo: vi.fn(),
    addToKubo: vi.fn().mockResolvedValue('mock-cid'),
    dagPut: vi.fn().mockResolvedValue('mock-dag-cid'),
    uploadToPinata: vi.fn().mockResolvedValue('mock-filebase-hash'),
    pinCidRemote: vi.fn().mockResolvedValue(true),
    dagGet: vi.fn(),
    kuboPost: vi.fn(),
    mfsCp: vi.fn(),
    mfsFlush: vi.fn(),
    prepareTempMfs: vi.fn(),
  };
}

function makeBuilder(ipfs?: any, token?: string): ConfigBuilder {
  return new ConfigBuilder(ipfs ?? mockIPFS(), token ?? 'mock-token');
}

function makeResponse(body: any, status = 200, headers?: Record<string, string>): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

describe('ConfigBuilder', () => {
  // ---------------------------------------------------------------------------
  // parseGitHubUrl (standalone)
  // ---------------------------------------------------------------------------
  describe('parseGitHubUrl', () => {
    it('parses github.com/owner/repo', () => {
      const result = parseGitHubUrl('github.com/owner/repo');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        branch: 'main',
      });
    });

    it('parses github.com/owner/repo/tree/dev', () => {
      const result = parseGitHubUrl('github.com/owner/repo/tree/dev');
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        branch: 'dev',
      });
    });

    it('throws on invalid URL', () => {
      expect(() => parseGitHubUrl('not-a-github-url')).toThrow('Invalid GitHub URL');
    });
  });

  // ---------------------------------------------------------------------------
  // buildConfig
  // ---------------------------------------------------------------------------
  describe('buildConfig', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          // GitHub API commits
          if (url.includes('/commits/')) {
            return Promise.resolve(makeResponse({ sha: 'abc123def' }));
          }
          // GitHub API contents — empty for both templates and assets
          if (url.includes('api.github.com/repos')) {
            return Promise.resolve(makeResponse([]));
          }
          // raw.githubusercontent.com for mapping.json
          if (url.includes('raw.githubusercontent.com')) {
            return Promise.resolve(
              makeResponse(
                JSON.stringify({
                  templateConfig: [{ template: 'post', selector: '.post' }],
                  ripples: [],
                  localePaths: { default: '', nl: '', en: '/en' },
                }),
              ),
            );
          }
          // default
          return Promise.resolve(makeResponse(''));
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('builds config with empty existingConfigCid and returns kubo CID', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockRejectedValue(new Error('not found'));
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'testpub.soul2soul.eth',
        '0x1234',
        'mock-assets-cid',
      );

      // fetchFromKubo was NOT called because existingConfigCid is undefined
      expect(ipfs.fetchFromKubo).toHaveBeenCalledTimes(0);

      // dagPut was called with the templates array
      expect(ipfs.dagPut).toHaveBeenCalled();

      // Dual-write: uploadToPinata (now Filebase) + addToKubo
      expect(ipfs.uploadToPinata).toHaveBeenCalled();
      expect(ipfs.addToKubo).toHaveBeenCalled();

      // Return value is the KUBO CID, not the pinata one
      expect(result.cid).toBe('mock-cid');
      expect(result.config.name).toBe('testpub.soul2soul.eth');
      expect(result.config.contract).toBe('0x1234');
      expect(result.config.assetsCid).toBe('mock-assets-cid');
      expect(result.config.dataGateway).toBe('ipfs.mock');
      expect(result.config.mapping).toBeDefined();
      expect(result.config.templateCid).toBe('mock-dag-cid');

      // localePaths is hoisted to the top level of the built config so the
      // renderer's createPath can read it (it reads config.localePaths, not
      // config.mapping.localePaths)
      expect(result.config.localePaths).toEqual({
        default: '',
        nl: '',
        en: '/en',
      });
    });

    it('mirrors templateCid to Filebase and Pinata via pinCidRemote (fresh build)', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockRejectedValue(new Error('not found'));
      const builder = makeBuilder(ipfs);

      await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'testpub.soul2soul.eth',
        '0x1234',
        'mock-assets-cid',
      );

      // templateCid (the dagPut CID) is mirrored to BOTH pinning services
      // fire-and-forget: once to filebase, once to pinata.
      expect(ipfs.pinCidRemote).toHaveBeenCalledWith('mock-dag-cid', 'filebase');
      expect(ipfs.pinCidRemote).toHaveBeenCalledWith('mock-dag-cid', 'pinata');
      expect(ipfs.pinCidRemote).toHaveBeenCalledTimes(2);
    });

    it('writes a real IPLD link per template entry on the fresh-build path', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes('/commits/')) {
          return Promise.resolve(makeResponse({ sha: 'abc123def' }));
        }
        // GitHub templates dir → two template files
        if (url.includes('/contents/templates')) {
          return Promise.resolve(
            makeResponse([
              {
                path: 'templates/post.hbs',
                download_url:
                  'https://raw.githubusercontent.com/owner/repo/main/templates/post.hbs',
                type: 'file',
              },
              {
                path: 'templates/layout.hbs',
                download_url:
                  'https://raw.githubusercontent.com/owner/repo/main/templates/layout.hbs',
                type: 'file',
              },
            ]),
          );
        }
        // GitHub API contents — no assets
        if (url.includes('api.github.com/repos')) {
          return Promise.resolve(makeResponse([]));
        }
        // Template file body
        if (url.includes('raw.githubusercontent.com') && url.endsWith('.hbs')) {
          return Promise.resolve(makeResponse('Hello {{name}}'));
        }
        // raw.githubusercontent.com for mapping.json
        if (url.includes('raw.githubusercontent.com')) {
          return Promise.resolve(
            makeResponse(
              JSON.stringify({
                templateConfig: [{ template: 'post', selector: '.post' }],
                ripples: [],
                localePaths: { default: '', nl: '', en: '/en' },
              }),
            ),
          );
        }
        return Promise.resolve(makeResponse(''));
      });
      vi.stubGlobal('fetch', fetchMock);

      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockRejectedValue(new Error('not found'));
      // Real (valid) CID per template file so the dag-json payload decodes to
      // genuine IPLD links — the exact strings Kubo's dag/put link decoder
      // accepts (and the same CID.parse that decodes them).
      ipfs.addToKubo.mockImplementation(async (_content: string, name: string) => {
        const hash = await sha256.digest(new TextEncoder().encode(name));
        return CID.create(1, 0x55, hash).toString();
      });
      const builder = makeBuilder(ipfs);

      await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'testpub.soul2soul.eth',
        '0x1234',
        'mock-assets-cid',
      );

      const dagPutCall = (ipfs.dagPut as any).mock.calls[0];
      const templatesPayload = JSON.parse(dagPutCall[0]);
      expect(templatesPayload).toHaveLength(2);
      for (const entry of templatesPayload) {
        // Every entry keeps path/cid/body and gains a REAL IPLD link derived
        // from its own cid (`{ '/': <cid> }` — the dag-json link form).
        expect(entry.path).toBeDefined();
        expect(entry.body).toBeDefined();
        expect(entry.link).toEqual({ '/': entry.cid });
        // The link target must be a valid CID (CID.parse throws otherwise — the
        // same validation Kubo's dag-json decoder applies when it materialises
        // the link), and it must equal the entry's cid.
        const linkCid = CID.parse(entry.link['/']);
        expect(linkCid.equals(CID.parse(entry.cid))).toBe(true);
        expect(linkCid.toString()).toBe(entry.cid);
      }
      // Sanity: the two cids are distinct, so each link is derived from the
      // entry that carries it (not a shared/static value).
      expect(templatesPayload[0].link['/']).not.toBe(templatesPayload[1].link['/']);
    });

    it('fetches mapping.json at commit SHA not branch ref', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.includes('/commits/')) {
          return Promise.resolve(makeResponse({ sha: 'abc123def' }));
        }
        if (url.includes('api.github.com/repos')) {
          return Promise.resolve(makeResponse([]));
        }
        if (url.includes('raw.githubusercontent.com')) {
          // Capture the URL to verify it includes the commit SHA, not "main"
          return Promise.resolve(makeResponse(JSON.stringify({ templateConfig: [], ripples: [] })));
        }
        return Promise.resolve(makeResponse(''));
      });
      vi.stubGlobal('fetch', fetchMock);

      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({});
      const builder = makeBuilder(ipfs);

      await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        undefined,
      );

      // The raw.githubusercontent.com call should use the commit SHA
      const rawCalls = fetchMock.mock.calls.filter(([url]: string[]) =>
        url.includes('raw.githubusercontent.com'),
      );
      expect(rawCalls.length).toBeGreaterThan(0);
      for (const [url] of rawCalls) {
        expect(url).toContain('abc123def');
        expect(url).not.toContain('/main/');
      }
    });

    it('loads existing config when existingConfigCid is provided', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({
        templates: [{ path: 'old/template.hbs', cid: 'old-cid', body: 'old' }],
      });
      const builder = makeBuilder(ipfs);

      await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
      );

      expect(ipfs.fetchFromKubo).toHaveBeenCalledWith('existing-config-cid');
    });

    it('migrates a legacy domain-only existing config into the aliases list', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({
        domain: 'custom.soul2soul.eth',
      });
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
      );

      // A carried domain-only existing config is promoted to the aliases model:
      // the rebuilt config lists the name as an alias, with no `domain` field.
      expect(result.config.aliases).toEqual(['custom.soul2soul.eth']);
      expect(result.config.domain).toBeUndefined();
    });

    it('migrates a carried s3ntiment domain-only config to aliases (no override)', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({ domain: 's3ntiment.eth' });
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
      );

      expect(result.config.aliases).toEqual(['s3ntiment.eth']);
      expect(result.config.domain).toBeUndefined();
    });

    it('omits domain from the built config when the existing config has none', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({});
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
      );

      expect(result.config.domain).toBeUndefined();
    });

    it('sets the domain on the built config when a domain override is provided', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockRejectedValue(new Error('not found'));
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        undefined,
        's3ntiment.eth',
      );

      expect(result.config.domain).toBe('s3ntiment.eth');
      // The write target is a plain string that the EVM update action feeds to
      // namehash(domain); the rest of the config is untouched.
      expect(result.config.name).toBe('test.soul2soul.eth');
    });

    it('explicit domain override wins over the carried existing config domain', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({
        domain: 'old.soul2soul.eth',
      });
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
        'new.soul2soul.eth',
      );

      expect(result.config.domain).toBe('new.soul2soul.eth');
    });

    it('an empty string domain override clears the carried existing config domain', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({
        domain: 'old.soul2soul.eth',
      });
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
        '',
      );

      expect(result.config.domain).toBeUndefined();
    });

    // ---------------------------------------------------------------------
    // ENS alias / multi-domain write targets
    // ---------------------------------------------------------------------

    it('sets aliases on the built config when an aliases array override is provided', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockRejectedValue(new Error('not found'));
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        undefined,
        undefined,
        ['a.eth', 'b.eth'],
      );

      expect(result.config.aliases).toEqual(['a.eth', 'b.eth']);
      // Aliases replace the legacy domain field entirely.
      expect(result.config.domain).toBeUndefined();
    });

    it('explicit aliases override wins over a carried existing domain', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({ domain: 'old.soul2soul.eth' });
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
        undefined,
        ['new.eth'],
      );

      expect(result.config.aliases).toEqual(['new.eth']);
      expect(result.config.domain).toBeUndefined();
    });

    it('carries the existing config aliases when no override is provided', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({ aliases: ['a.eth', 'b.eth'] });
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
      );

      expect(result.config.aliases).toEqual(['a.eth', 'b.eth']);
      expect(result.config.domain).toBeUndefined();
    });

    it('an empty aliases array clears ALL write targets (aliases AND legacy domain)', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({
        aliases: ['old.eth'],
        domain: 'legacy.soul2soul.eth',
      });
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
        undefined,
        [],
      );

      expect(result.config.aliases).toBeUndefined();
      expect(result.config.domain).toBeUndefined();
    });

    it('dedupes and drops empty alias entries from an aliases override', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockRejectedValue(new Error('not found'));
      const builder = makeBuilder(ipfs);

      const result = await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        undefined,
        undefined,
        ['a.eth', 'a.eth', '  ', 'b.eth'],
      );

      expect(result.config.aliases).toEqual(['a.eth', 'b.eth']);
    });

    it('merges templates: existing CID stays when template files unchanged', async () => {
      const ipfs = mockIPFS();
      // A real (valid) CIDv0 string so the carried-forward entry keeps its link.
      const carriedCid = 'QmV9aLxGaJKFkcBiyAtDWVnLoHZy2eeUNdCxyLeFk4CEY6';
      ipfs.fetchFromKubo.mockResolvedValue({
        templates: [{ path: 'templates/post.hbs', cid: carriedCid, body: 'old' }],
      });
      const builder = makeBuilder(ipfs);

      // GitHub returns empty template dir → no new templates processed
      await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-cid',
      );

      // dagPut should be called with the merged array (old template preserved
      // from the fetched existing config)
      const dagPutCall = (ipfs.dagPut as any).mock.calls[0];
      const templatesPayload = JSON.parse(dagPutCall[0]);
      // Existing config had 1 template; GitHub returned no templates dir,
      // so the existing one is kept from the fetched config
      expect(templatesPayload).toHaveLength(1);
      expect(templatesPayload[0].path).toBe('templates/post.hbs');
      // Carried-forward entry (from the fetched existing config) also gets a
      // REAL IPLD link derived from its cid — it must not be skipped on the
      // existing-config merge path.
      expect(templatesPayload[0].cid).toBe(carriedCid);
      expect(templatesPayload[0].link).toEqual({ '/': carriedCid });
      expect(CID.parse(templatesPayload[0].link['/']).toString()).toBe(carriedCid);
    });

    it('omits the IPLD link for a carried-forward entry whose cid is not a valid CID', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({
        templates: [{ path: 'templates/post.hbs', cid: 'not-a-real-cid', body: 'old' }],
      });
      const builder = makeBuilder(ipfs);

      // GitHub returns empty template dir → the corrupt carried entry is kept
      await builder.buildConfig(
        'owner',
        'repo',
        'main',
        'test.soul2soul.eth',
        '0x1234',
        'cid',
        'existing-config-cid',
      );

      const dagPutCall = (ipfs.dagPut as any).mock.calls[0];
      const templatesPayload = JSON.parse(dagPutCall[0]);
      expect(templatesPayload).toHaveLength(1);
      expect(templatesPayload[0].path).toBe('templates/post.hbs');
      // A corrupt/legacy cid gets NO link — otherwise Kubo's dag-json decoder
      // would reject the entire payload and break the publish (degrades like
      // the pre-link plain-string node instead).
      expect(templatesPayload[0].cid).toBe('not-a-real-cid');
      expect('link' in templatesPayload[0]).toBe(false);
      expect(templatesPayload[0].link).toBeUndefined();
    });
  });
});
