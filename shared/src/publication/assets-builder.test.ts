import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AssetsBuilder } from "./assets-builder";
import { parseGitHubUrl } from "./config-builder";

// =============================================================================
// Helpers
// =============================================================================

function mockIPFS(): any {
  return {
    gateway: "ipfs.mock",
    fetchFromKubo: vi.fn(),
    addToKubo: vi.fn().mockResolvedValue("new-cid-from-github"),
    dagPut: vi.fn(),
    dagGet: vi.fn().mockResolvedValue({ Links: [] }),
    uploadToPinata: vi.fn(),
    kuboPost: vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => ({}), text: () => "" }),
    mfsCp: vi.fn().mockResolvedValue(true),
    mfsFlush: vi.fn().mockResolvedValue({ ok: true, cid: "flushed-root-cid" }),
    prepareTempMfs: vi.fn().mockResolvedValue("/tmp/mock"),
  };
}

function makeBuilder(ipfs?: any, token?: string): AssetsBuilder {
  return new AssetsBuilder(
    ipfs ?? mockIPFS(),
    token ?? "mock-token",
  );
}

/**
 * Helper: build a Links array for IPFS dag/get responses.
 */
function makeLinks(entries: Record<string, string>): any[] {
  return Object.entries(entries).map(([name, hash]) => ({
    Name: name,
    Hash: { "/": hash },
    Tsize: 100,
  }));
}

describe("AssetsBuilder", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      // GitHub contents API — default: empty
      if (url.includes("api.github.com/repos")) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      // raw file fetch
      if (
        url.includes("raw.githubusercontent.com") ||
        url.startsWith("https://raw.")
      ) {
        return Promise.resolve(new Response("file content", { status: 200 }));
      }
      // default
      return Promise.resolve(
        new Response(JSON.stringify({}), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // 1. Entry present in existing DAG but absent from GitHub → dropped
  // ---------------------------------------------------------------------------
  it("drops existing top-level entries absent from GitHub", async () => {
    const ipfs = mockIPFS();
    ipfs.fetchFromKubo.mockResolvedValue({ assetsCid: "existing-root" });
    ipfs.dagGet.mockResolvedValue({
      Links: makeLinks({
        "old-dir": "QmOldDir",
        "still-there": "QmStillThere",
      }),
    });

    const builder = makeBuilder(ipfs);
    // GitHub contents of assets/ returns nothing (empty for all paths)
    await builder.buildAssets(
      "owner", "repo", "main",
      "test.soul2soul.eth", "0x1234", "existing-config-cid",
    );

    // The 'old-dir' entry should NOT be restored (it was skipped)
    // Only 'still-there' would be restored — but since GitHub top-level is
    // empty (no files returned), ALL entries skip via !githubTopLevel.has(name)
    // Actually: the loop iterates existingCids and skips everything.
    // mfsCp should not have been called for 'old-dir'
    const mfsCpCalls = (ipfs.mfsCp as any).mock.calls;
    const oldDirCalls = mfsCpCalls.filter(
      ([_cid, path]: [string, string]) => path === "/tmp/mock/old-dir",
    );
    expect(oldDirCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. SYNC_BY_FILENAME: unchanged file restored from IPFS, new file from GitHub
  // ---------------------------------------------------------------------------
  it("restores unchanged files in SYNC_BY_FILENAME dirs from IPFS by name", async () => {
    const ipfs = mockIPFS();
    ipfs.fetchFromKubo.mockResolvedValue({ assetsCid: "existing-root" });
    // Existing DAG has img/ with two children
    ipfs.dagGet.mockImplementation((cid: string) => {
      if (cid === "existing-root") {
        return Promise.resolve({
          Links: makeLinks({ img: "QmImgDir" }),
        });
      }
      if (cid === "QmImgDir") {
        return Promise.resolve({
          Links: makeLinks({
            "logo.png": "QmLogoOld",
            "unchanged.svg": "QmUnchanged",
          }),
        });
      }
      return Promise.resolve({ Links: [] });
    });

    // GitHub returns assets/img/ with TWO files: unchanged.svg + new.svg
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("api.github.com/repos")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { name: "unchanged.svg", path: "assets/img/unchanged.svg", type: "file", download_url: "https://raw.githubusercontent.com/...", url },
              { name: "new.svg", path: "assets/img/new.svg", type: "file", download_url: "https://raw.githubusercontent.com/...", url },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("content", { status: 200 }));
    });

    const builder = makeBuilder(ipfs);
    await builder.buildAssets(
      "owner", "repo", "main",
      "test.soul2soul.eth", "0x1234", "existing-config-cid",
    );

    // mfsCp should have been called for unchanged.svg (restored from IPFS)
    const mfsCpCalls = (ipfs.mfsCp as any).mock.calls;
    const unchangedRestore = mfsCpCalls.filter(
      ([cid]: [string]) => cid === "QmUnchanged",
    );
    expect(unchangedRestore.length).toBeGreaterThanOrEqual(1);

    // addToKubo should have been called for new.svg (new file from GitHub)
    const addToKuboCalls = (ipfs.addToKubo as any).mock.calls;
    const newFileAdd = addToKuboCalls.filter(
      ([_content, name]: [any, string]) => name === "new.svg",
    );
    expect(newFileAdd).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 3. ALWAYS_SYNC_FROM_GITHUB (js/css): always refetched from GitHub
  // ---------------------------------------------------------------------------
  it("always refetches js/css files from GitHub even when present in old DAG", async () => {
    const ipfs = mockIPFS();
    ipfs.fetchFromKubo.mockResolvedValue({ assetsCid: "existing-root" });
    // Existing DAG has js/ with old child
    ipfs.dagGet.mockResolvedValue({
      Links: makeLinks({
        js: "QmJsDir",
        fonts: "QmFontsDir",
      }),
    });

    // GitHub returns assets/js/app.js
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("api.github.com/repos")) {
        if (url.includes("contents/assets")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                { name: "app.js", path: "assets/js/app.js", type: "file", download_url: "https://raw.githubusercontent.com/...", url },
              ]),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response("content", { status: 200 }));
    });

    const builder = makeBuilder(ipfs);
    await builder.buildAssets(
      "owner", "repo", "main",
      "test.soul2soul.eth", "0x1234", "existing-config-cid",
    );

    // addToKubo should be called for app.js even though an old version existed
    const addToKuboCalls = (ipfs.addToKubo as any).mock.calls;
    const jsCalls = addToKuboCalls.filter(
      ([_content, name]: [any, string]) => name === "app.js",
    );
    expect(jsCalls).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 4. Untouched top-level dir → whole-dir cp restore
  // ---------------------------------------------------------------------------
  it("restores untouched top-level dirs as whole-dir cp", async () => {
    const ipfs = mockIPFS();
    ipfs.fetchFromKubo.mockResolvedValue({ assetsCid: "existing-root" });
    // Existing DAG has 'static-assets' (not in SYNC_BY_FILENAME or ALWAYS_SYNC)
    ipfs.dagGet.mockResolvedValue({
      Links: makeLinks({ "static-assets": "QmStatic" }),
    });

    // GitHub returns assets/static-assets/ (a single file inside)
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("contents/assets/static-assets") || url.includes("contents/assets")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { name: "static-assets", path: "assets/static-assets", type: "dir", url, download_url: "" },
            ]),
            { status: 200 },
          ),
        );
      }
      if (url.includes("api.github.com/repos")) {
        // For assets/static-assets subdirectory: has the files inside
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { name: "bg.png", path: "assets/static-assets/bg.png", type: "file", download_url: "https://...", url },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("content", { status: 200 }));
    });

    const builder = makeBuilder(ipfs);
    await builder.buildAssets(
      "owner", "repo", "main",
      "test.soul2soul.eth", "0x1234", "existing-config-cid",
    );

    // mfsCp should be called for "static-assets" (whole-dir restore)
    const mfsCpCalls = (ipfs.mfsCp as any).mock.calls;
    const staticCp = mfsCpCalls.filter(
      ([cid]: [string]) => cid === "QmStatic",
    );
    expect(staticCp).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 5. Returns the flushed root CID from mfsFlush
  // ---------------------------------------------------------------------------
  it("returns the flushed root CID from mfsFlush", async () => {
    const ipfs = mockIPFS();
    ipfs.fetchFromKubo.mockResolvedValue({});
    const builder = makeBuilder(ipfs);

    const result = await builder.buildAssets(
      "owner", "repo", "main",
      "test.soul2soul.eth", "0x1234", "existing-cid",
    );

    expect(result.cid).toBe("flushed-root-cid");
    expect(ipfs.mfsFlush).toHaveBeenCalled();
  });
});