/**
 * cors-fetch.test.ts — unit tests for the CORS-free electron.remote.net fetch
 * shim (0xobsidian/src/filecoin/cors-fetch.ts).
 *
 * The shim routes through an INJECTED `electron.remote.net` accessor so it can
 * be exercised without a real Electron runtime. These tests cover:
 *  1. WHATWG Response shape (.ok/.status/.headers/.text()/.clone(), 204 body).
 *  2. Streaming request body + duplex:"half" (the 3-leg PUT upload legs).
 *  3. install/restore semantics on globalThis.fetch, incl. restore-on-error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// electron is external at runtime (Obsidian's require shim) and not installed
// as a resolvable package in the test env. We never exercise the real default
// accessor — every test injects a fake `net` — so mock it to satisfy import
// resolution.
vi.mock("electron", () => ({
  default: { remote: { net: {} } },
}));

import {
  createCorsFetch,
  installCorsFetch,
  restoreCorsFetch,
  type CorsFetch,
} from "../src/filecoin/cors-fetch.js";

interface CapturedRequest {
  options: Record<string, unknown>;
  chunks: Buffer[];
}

interface MockNetOptions {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  error?: Error;
}

/** Build a fake `electron.remote.net` that answers with a canned response. */
function makeMockNet(opts: MockNetOptions = {}) {
  const requests: CapturedRequest[] = [];
  const net = {
    request(options: Record<string, unknown>) {
      const captured: CapturedRequest = { options, chunks: [] };
      requests.push(captured);
      const clientRequest: any = {
        write: (chunk: Buffer | Uint8Array | string) => {
          captured.chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
          );
          return true;
        },
        end: () => {
          if (opts.error) {
            setImmediate(() => clientRequest.emit("error", opts.error));
            return;
          }
          const incoming: any = {
            statusCode: opts.status ?? 200,
            statusMessage: opts.statusMessage ?? "",
            headers: opts.headers ?? {
              "content-type": "application/json",
            },
          };
          const incomingHandlers: Record<string, Array<(...a: any[]) => void>> = {};
          incoming.on = (event: string, fn: (...a: any[]) => void) => {
            (incomingHandlers[event] ??= []).push(fn);
            return incoming;
          };
          incoming.emit = (event: string, ...args: any[]) => {
            for (const h of incomingHandlers[event] ?? []) h(...args);
          };
          setImmediate(() => {
            clientRequest.emit("response", incoming);
            if (opts.body != null) {
              incoming.emit("data", Buffer.from(opts.body));
            }
            incoming.emit("end");
          });
        },
        abort: vi.fn(),
      };
      // EventEmitter-style .on used by the shim.
      const handlers: Record<string, Array<(...a: any[]) => void>> = {};
      clientRequest.on = (event: string, fn: (...a: any[]) => void) => {
        (handlers[event] ??= []).push(fn);
        return clientRequest;
      };
      clientRequest.emit = (event: string, ...args: any[]) => {
        for (const h of handlers[event] ?? []) h(...args);
      };
      return clientRequest;
    },
  };
  return { net, requests };
}

let originalFetch: CorsFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  // Defensive: never leave the shim installed between tests.
  restoreCorsFetch();
  globalThis.fetch = originalFetch;
});

describe("Response shape", () => {
  it("returns .ok/.status/.headers/.text() for a 200 JSON response", async () => {
    const { net } = makeMockNet({
      status: 200,
      statusMessage: "OK",
      headers: {
        "content-type": "application/json",
        "x-sp": "synapse",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    const fetchShim = createCorsFetch(() => net);

    const res = await fetchShim(
      "https://sp.example.com/pdp/piece/uploads/abc",
      { method: "PUT" },
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-sp")).toBe("synapse");
    expect(await res.text()).toBe(JSON.stringify({ hello: "world" }));
  });

  it("ok is false for non-2xx status", async () => {
    const { net } = makeMockNet({ status: 500, statusMessage: "Internal Server Error" });
    const fetchShim = createCorsFetch(() => net);

    const res = await fetchShim("https://sp.example.com/pdp/piece");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it("clone() produces an independent, re-readable body", async () => {
    const { net } = makeMockNet({ body: "clone-me" });
    const fetchShim = createCorsFetch(() => net);

    const res = await fetchShim("https://sp.example.com/piece");
    const cloned = res.clone();
    expect(await cloned.text()).toBe("clone-me");
    expect(await res.text()).toBe("clone-me");
  });

  it("204 No Content (PUT upload leg) yields an empty body, not a throw", async () => {
    const { net } = makeMockNet({ status: 204, statusMessage: "No Content" });
    const fetchShim = createCorsFetch(() => net);

    const res = await fetchShim("https://sp.example.com/pdp/piece/uploads/uuid", {
      method: "PUT",
    });
    expect(res.status).toBe(204);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("");
  });
});

describe("streaming request body / duplex handling", () => {
  it("streams a WHATWG ReadableStream body (Request singleton, duplex:half)", async () => {
    const { net, requests } = makeMockNet({ status: 204 });
    const fetchShim = createCorsFetch(() => net);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-one-"));
        controller.enqueue(new TextEncoder().encode("chunk-two"));
        controller.close();
      },
    });
    // The DOM `RequestInit` type in this lib has no `duplex`; iso-web adds it.
    // Cast to keep the streaming-body/duplex form exercised.
    const request = new Request(
      "https://sp.example.com/pdp/piece/uploads/uuid",
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: stream,
        duplex: "half",
      } as unknown as RequestInit,
    );

    const res = await fetchShim(request);
    expect(res.status).toBe(204);
    expect(requests).toHaveLength(1);
    expect(requests[0].options.method).toBe("PUT");
    expect(requests[0].options.url).toBe(
      "https://sp.example.com/pdp/piece/uploads/uuid",
    );
    expect(requests[0].options.headers).toMatchObject({
      "content-type": "application/octet-stream",
    });
    // All streamed chunks arrived in order, nothing lost.
    expect(Buffer.concat(requests[0].chunks).toString()).toBe(
      "chunk-one-chunk-two",
    );
  });

  it("auto-injects duplex:half for the url+init streaming form", async () => {
    const { net, requests } = makeMockNet({ status: 204 });
    const fetchShim = createCorsFetch(() => net);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("leg-body"));
        controller.close();
      },
    });

    // No explicit duplex provided — the shim must inject it or the Request
    // constructor would throw.
    const res = await fetchShim("https://sp.example.com/pdp/piece/uploads/uuid", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: stream,
    });

    expect(res.status).toBe(204);
    expect(Buffer.concat(requests[0].chunks).toString()).toBe("leg-body");
  });

  it("sends a plain string JSON body (finalize leg)", async () => {
    const { net, requests } = makeMockNet({ status: 200, body: "{}" });
    const fetchShim = createCorsFetch(() => net);

    await fetchShim("https://sp.example.com/pdp/piece/uploads/uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pieceCid: "baga..." }),
    });

    expect(requests[0].options.method).toBe("POST");
    expect(Buffer.concat(requests[0].chunks).toString()).toBe(
      JSON.stringify({ pieceCid: "baga..." }),
    );
  });
});

describe("install/restore semantics", () => {
  it("installs the CORS fetch and restores the original on demand", async () => {
    const { net } = makeMockNet({ status: 200, body: "installed-ok" });
    const restore = installCorsFetch(() => net);

    expect(globalThis.fetch).not.toBe(originalFetch);

    const res = await globalThis.fetch("https://sp.example.com/upload", {
      method: "PUT",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("installed-ok");

    restore();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("restores the original fetch even when the op throws (finally-style)", async () => {
    const { net } = makeMockNet({ error: new Error("boom") });
    installCorsFetch(() => net);

    // Simulate the controller's try/finally: op throws, restore still runs.
    let threw = false;
    try {
      await globalThis.fetch("https://sp.example.com/fail");
    } catch {
      threw = true;
    } finally {
      restoreCorsFetch();
    }

    expect(threw).toBe(true);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("rejects on request error and surfaces the underlying failure", async () => {
    const { net } = makeMockNet({ error: new Error("ECONNREFUSED") });
    const fetchShim = createCorsFetch(() => net);

    await expect(
      fetchShim("https://sp.example.com/pdp/piece", { method: "POST" }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("install is idempotent; restore once returns to the original", async () => {
    const { net } = makeMockNet({ status: 204 });
    installCorsFetch(() => net);
    const restoreAgain = installCorsFetch(() => net); // no-op second install

    restoreAgain();
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
