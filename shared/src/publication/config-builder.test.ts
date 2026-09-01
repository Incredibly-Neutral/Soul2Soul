import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    it('merges templates: existing CID stays when template files unchanged', async () => {
      const ipfs = mockIPFS();
      ipfs.fetchFromKubo.mockResolvedValue({
        templates: [{ path: 'templates/post.hbs', cid: 'existing-cid', body: 'old' }],
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
    });
  });
});
