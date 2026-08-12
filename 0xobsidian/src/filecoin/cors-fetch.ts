/**
 * cors-fetch.ts — CORS-free WHATWG fetch shim built on Electron's
 * `electron.remote.net.request`.
 *
 * Why this exists (see FILECOIN_CORS_FINDINGS.md at the repo root):
 * the Filecoin/PDP SDK transport bottoms out in `globalThis.fetch` — the
 * renderer's Chromium fetch (origin `app://obsidian.md`), which is
 * CORS-enforced. A provider that doesn't emit `Access-Control-Allow-Origin`
 * is unreadable to browser fetch, so a 201/204/200 still surfaces as
 * `NetworkError: Network request failed`.
 *
 * This module is a drop-in replacement for `globalThis.fetch` built on the
 * SAME bridge the repo already uses to escape CORS for Kubo/Pinata
 * (`0xobsidian/src/ipfs/remotekubo.service.ts`, `pinata.factory.ts`):
 * Electron's main-process `net` module via `electron.remote.net`.
 *
 * Because iso-web resolves `globalThis.fetch` at CALL time (http.js:251),
 * installing this shim around the Filecoin upload moves the whole PDP path
 * out of browser-CORS scope with no SDK patch.
 *
 * The electron accessor is injectable so the shim is unit-testable without a
 * real Electron runtime — pass a mock `() => net` to `createCorsFetch` /
 * `installCorsFetch`; it defaults to the real `electron.remote.net`.
 */

//@ts-ignore - electron is external; resolved at runtime by Obsidian's require
// shim (same pattern as remotekubo.service.ts / pinata.factory.ts).
import electron from "electron";

/** Minimal shape of Electron's main-process `net` module we consume. */
export type ElectronNet = {
  request(options: Record<string, unknown>): ElectronClientRequest;
};

/** Minimal shape of Electron's `ClientRequest` we consume. */
export type ElectronClientRequest = {
  on(
    event: "response",
    listener: (response: ElectronIncomingMessage) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  write(chunk: Buffer | Uint8Array | string): boolean;
  end(): void;
  abort(): void;
};

/** Minimal shape of Electron's `IncomingMessage` (Node http-style) we consume. */
export type ElectronIncomingMessage = {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "aborted", listener: () => void): void;
};

/** Injectable accessor for `electron.remote.net`. */
export type NetAccessor = () => ElectronNet;

/** The WHATWG fetch signature this shim implements. */
export type CorsFetch = typeof fetch;

/** Default accessor — the real Electron main-process net module. */
const defaultGetNet: NetAccessor = () =>
  (electron as { remote: { net: ElectronNet } }).remote.net;

/**
 * Statuses that MUST NOT carry a response body per the Fetch spec.
 * The 3-leg streaming upload's PUT leg returns 204 No Content.
 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function isWhatwgStream(value: unknown): value is ReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream).getReader === "function"
  );
}

function isNodeStream(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { on?: unknown }).on === "function" &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

/**
 * Build a `Request` from the fetch input, auto-injecting `duplex: "half"`
 * when the init carries a streaming body (required by the Fetch spec when
 * constructing a Request with a ReadableStream body).
 */
function buildRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  const requestInit: RequestInit = { ...init };
  const body = requestInit.body;
  if (body != null && isWhatwgStream(body)) {
    (requestInit as RequestInit & { duplex: "half" }).duplex = "half";
  }
  if (input instanceof Request) {
    return init ? new Request(input, requestInit) : input;
  }
  const url = typeof input === "string" ? input : input.toString();
  return new Request(url, requestInit);
}

/** Stream the request body into the Electron ClientRequest, chunk by chunk. */
async function writeRequestBody(
  clientRequest: ElectronClientRequest,
  body: BodyInit | ReadableStream | null,
): Promise<void> {
  if (body == null) return;

  // WHATWG ReadableStream — the streaming upload legs (duplex: "half").
  if (isWhatwgStream(body)) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clientRequest.write(Buffer.from(value));
    }
    return;
  }

  // Node-style readable stream (defensive; not used by iso-web today).
  if (isNodeStream(body)) {
    const stream = body as unknown as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: unknown) =>
        clientRequest.write(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
        ),
      );
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    return;
  }

  // Static bodies: string / ArrayBuffer / typed array / Blob.
  if (typeof body === "string") {
    clientRequest.write(Buffer.from(body));
    return;
  }
  if (body instanceof ArrayBuffer) {
    clientRequest.write(Buffer.from(body));
    return;
  }
  if (ArrayBuffer.isView(body)) {
    clientRequest.write(
      Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    );
    return;
  }
  if (typeof (body as Blob).arrayBuffer === "function") {
    const buf = await (body as Blob).arrayBuffer();
    clientRequest.write(Buffer.from(buf));
    return;
  }
  clientRequest.write(Buffer.from(String(body)));
}

/**
 * Create a CORS-free fetch bound to the given electron accessor.
 * Defaults to the real `electron.remote.net`; pass a mock for tests.
 */
export function createCorsFetch(getNet: NetAccessor = defaultGetNet): CorsFetch {
  return async function corsFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = buildRequest(input, init);
    const { method, url, signal } = request;

    // Headers → plain object for Electron's ClientRequest options.
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const net = getNet();
    const clientRequest = net.request({ method, url, headers });

    // Abort propagation (iso-web passes a combined signal).
    if (signal) {
      if (signal.aborted) {
        clientRequest.abort();
      } else {
        signal.addEventListener(
          "abort",
          () => clientRequest.abort(),
          { once: true },
        );
      }
    }

    // Wire the response BEFORE writing the body so no data is missed.
    const responsePromise = new Promise<Response>((resolve, reject) => {
      clientRequest.on("response", (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on("end", () => {
          const status = incoming.statusCode ?? 0;
          const statusText = incoming.statusMessage ?? "";
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers ?? {})) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) responseHeaders.append(key, v);
            } else {
              responseHeaders.set(key, String(value));
            }
          }
          const body = NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks);
          resolve(
            new Response(body, {
              status,
              statusText,
              headers: responseHeaders,
            }),
          );
        });
        incoming.on("error", reject);
        incoming.on("aborted", () =>
          reject(new Error("Response aborted")),
        );
      });
      clientRequest.on("error", reject);
    });

    // Send the body (streaming-aware), then finish the request.
    await writeRequestBody(clientRequest, request.body);
    clientRequest.end();

    return responsePromise;
  };
}

/** Default instance bound to the real `electron.remote.net`. */
export const corsFetch: CorsFetch = createCorsFetch();

// ── Scoped install/restore on globalThis.fetch ──────────────────────────────
// iso-web binds `globalThis.fetch` at call time, so installing this shim
// before a Filecoin op and restoring it afterwards moves only the Filecoin
// traffic off browser fetch; every other plugin HTTP keeps native fetch.

let installed = false;
let previousFetch: CorsFetch | undefined;

/**
 * Install the CORS-free fetch on `globalThis.fetch` for the duration of a
 * Filecoin op. Returns the restore function (also available as
 * `restoreCorsFetch`). Idempotent — a second install before restore is a no-op.
 */
export function installCorsFetch(getNet?: NetAccessor): () => void {
  if (installed) return restoreCorsFetch;
  previousFetch = globalThis.fetch;
  globalThis.fetch = createCorsFetch(getNet);
  installed = true;
  return restoreCorsFetch;
}

/** Restore the previous `globalThis.fetch` (safe to call when not installed). */
export function restoreCorsFetch(): void {
  if (!installed) return;
  if (previousFetch) {
    globalThis.fetch = previousFetch;
  } else {
    delete (globalThis as { fetch?: CorsFetch }).fetch;
  }
  previousFetch = undefined;
  installed = false;
}
