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
 * The shim is URL-SCOPED: only Filecoin/PDP data-plane and IPFS-gateway
 * traffic routes through the Electron net bridge. Every other URL — Pimlico,
 * DRPC, Alchemy, any JSON-RPC / viem traffic — is delegated verbatim to the
 * captured native fetch. This matters because the Filecoin upload window
 * stays open for minutes (3-leg streaming, timeout:false), so a concurrent
 * Pimlico RPC can land inside it; without scoping that RPC would ride the
 * Electron shim and viem's 8s withTimeout would fire as a spurious
 * TimeoutError on the second publish after a reload. See
 * `isFilecoinOrIpfsUrl` for the classifier.
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
  on(event: "abort", listener: () => void): void;
  on(event: "aborted", listener: () => void): void;
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
 * Reduce a fetch `input` (string, URL, or Request) to its absolute URL string
 * for classification. Returns `null` when the input cannot be resolved to a
 * URL (unparseable relative string, or a Request whose own URL is
 * unresolvable) — callers treat that as "not a Filecoin target" and delegate
 * to native fetch, which performs its own (correct) relative-URL resolution.
 */
function resolveUrlString(input: RequestInfo | URL): string | null {
  try {
    if (input instanceof Request) return input.url ?? null;
    if (typeof input === "string") return new URL(input).toString();
    return input.toString();
  } catch {
    return null;
  }
}

/**
 * True when the given fetch input targets the Filecoin/PDP data plane or an
 * IPFS gateway — i.e. traffic that MUST route through the Electron net shim to
 * escape browser CORS. Everything else (Pimlico, DRPC, Alchemy, any JSON-RPC /
 * viem traffic, Kubo, ...) returns false and is delegated to the captured
 * native fetch so it never rides the Electron shim during an upload window.
 *
 * The PDP data plane is the ONLY part of the Filecoin upload path that lacks
 * CORS headers; the SP provider host is dynamic (resolved from the SP registry
 * at upload time, not a fixed catalog), so we classify by the `/pdp/` path
 * prefix that every `@filoz/synapse-core` SP call uses (POST `/pdp/piece`,
 * PUT `/pdp/piece/upload/{uuid}`, POST `/pdp/piece/uploads`, etc.) rather than
 * by host. IPFS gateways are matched by host and/or the `/ipfs/` path prefix.
 */
export function isFilecoinOrIpfsUrl(input: RequestInfo | URL): boolean {
  const url = resolveUrlString(input);
  if (url === null) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // PDP data plane: every synapse-core SP call is `/pdp/`-prefixed.
  if (parsed.pathname.includes("/pdp/")) return true;

  const host = parsed.hostname.toLowerCase();
  // IPFS gateways (host-based): gateway.ipfs.io, *.ipfs.dweb.link,
  // *.trustless.gateway, *.nftstorage.link, *.mypinata.cloud, *.web3.storage.
  if (
    host === "ipfs.io" ||
    host.endsWith(".ipfs.io") ||
    /\.ipfs\./.test(host) ||
    host.endsWith(".dweb.link") ||
    host.endsWith(".nftstorage.link") ||
    host.endsWith(".mypinata.cloud") ||
    host.endsWith(".web3.storage")
  ) {
    return true;
  }

  // IPFS gateways (path-based): any host serving content under /ipfs/<cid>.
  if (parsed.pathname.startsWith("/ipfs/")) return true;

  return false;
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
 *
 * `nativeFetch` is the captured original `globalThis.fetch`. When supplied,
 * any request whose URL is NOT a Filecoin/PDP or IPFS target is delegated to
 * it verbatim (input + init passed through unchanged) — so Pimlico, DRPC,
 * Alchemy and other RPC/viem traffic bypasses the Electron net shim even
 * during an upload window. When omitted (direct `createCorsFetch` use in
 * tests, or a pre-existing native fetch that is itself this shim), the shim
 * handles every URL exactly as it did before.
 */
export function createCorsFetch(
  getNet: NetAccessor = defaultGetNet,
  nativeFetch?: CorsFetch,
): CorsFetch {
  return async function corsFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // ── URL scoping ────────────────────────────────────────────────────────
    // Only Filecoin/PDP + IPFS traffic needs the CORS-free Electron bridge.
    // Anything else must keep using the captured native fetch; routing it
    // through Electron's net (which resolves on its own event loop, outside
    // the renderer's fetch/CORS stack) is what caused Pimlico's
    // pimlico_getUserOperationGasPrice to time out on the second publish
    // after a reload (the RPC landed inside the first publish's still-open
    // shim window). Delegate verbatim so viem's withTimeout/abort semantics
    // see a genuine native fetch.
    if (nativeFetch && !isFilecoinOrIpfsUrl(input)) {
      return nativeFetch(input, init);
    }

    const request = buildRequest(input, init);
    const { method, url, signal } = request;

    // Headers → plain object for Electron's ClientRequest options.
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const net = getNet();
    const clientRequest = net.request({ method, url, headers });

    // ── Abort-safe lifecycle ──────────────────────────────────────────────
    // `responsePromise` must ALWAYS settle — including on abort — because
    // viem's `http()` transport wraps its fetch in a withTimeout that, on
    // timeout, only calls controller.abort() and relies on the underlying
    // fetch rejecting. If the shim never settles on abort, an on-chain
    // JSON-RPC routed through the shim hangs INDEFINITELY (not an error, not
    // a return). So every terminal ClientRequest/IncomingMessage event —
    // success, error, abort, aborted — settles the pending promise exactly
    // once, and an abort rejection carries name "AbortError" so viem's
    // isAbortError() converts it into its TimeoutError.
    let settled = false;
    let abortListener: (() => void) | undefined;
    let resolveResponse!: (response: Response) => void;
    let rejectResponse!: (error: Error) => void;

    const responsePromise = new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    const clearAbortListener = () => {
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      // Once this request has settled, drop the signal abort listener so it
      // can never abort a recycled/later in-flight request.
      clearAbortListener();
      fn();
    };

    const abortError = (): Error => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      return err;
    };

    // Wire the response BEFORE writing the body so no data is missed.
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
        settle(() =>
          resolveResponse(
            new Response(body, {
              status,
              statusText,
              headers: responseHeaders,
            }),
          ),
        );
      });
      incoming.on("error", (e: Error) => settle(() => rejectResponse(e)));
      incoming.on("aborted", () => settle(() => rejectResponse(abortError())));
    });
    clientRequest.on("error", (e: Error) => settle(() => rejectResponse(e)));
    clientRequest.on("abort", () => settle(() => rejectResponse(abortError())));
    clientRequest.on("aborted", () =>
      settle(() => rejectResponse(abortError())),
    );

    // Abort propagation (iso-web passes a combined signal). Registered AFTER
    // the settlement handlers above so a pre-aborted signal's abort() still
    // lands on the promise.
    if (signal) {
      if (signal.aborted) {
        clientRequest.abort();
      } else {
        const onAbort = () => clientRequest.abort();
        abortListener = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Send the body (streaming-aware), then finish the request. A body-stream
    // failure must also settle the response promise (and drop the listener)
    // so no phase can leave it hanging — return the settled promise so the
    // rejection is observed by the caller.
    try {
      await writeRequestBody(clientRequest, request.body);
    } catch (err) {
      settle(() =>
        rejectResponse(err instanceof Error ? err : new Error(String(err))),
      );
      return responsePromise;
    }
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
  // Pass the captured native fetch so the installed shim delegates any
  // non-Filecoin/IPFS URL straight back to it (URL scoping). When no
  // previous fetch existed (previousFetch undefined), delegation is skipped
  // and the shim behaves exactly as before.
  globalThis.fetch = createCorsFetch(getNet, previousFetch);
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
