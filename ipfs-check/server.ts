// Batch proxy for ipfs-check.
// POST /batch  {"cids": ["bafy...", ...]}  ->  NDJSON stream, one line per CID as it finishes.
// Run: bun run server.ts

const CHECK_URL = process.env.CHECK_URL ?? "http://127.0.0.1:3333";
const PORT = Number(process.env.PORT ?? 3334);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 20); // across ALL requests
const CHECK_TIMEOUT_S = Number(process.env.CHECK_TIMEOUT_S ?? 20);
const MAX_CIDS_PER_REQUEST = 50;

// ---- global semaphore: caps load on ipfs-check no matter how many clients/batches ----
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve)); // slot handed over by release()
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

type CheckResult = { cid: string; ms: number; result?: unknown; error?: string };

async function checkCid(cid: string, signal: AbortSignal): Promise<CheckResult> {
  await acquire();
  const start = performance.now();
  try {
    if (signal.aborted) return { cid, ms: 0, error: "aborted" };
    const url = `${CHECK_URL}/check?cid=${encodeURIComponent(cid)}&timeoutSeconds=${CHECK_TIMEOUT_S}`;
    const res = await fetch(url, { signal });
    const ms = Math.round(performance.now() - start);
    if (!res.ok) return { cid, ms, error: `${res.status}: ${(await res.text()).trim()}` };
    return { cid, ms, result: await res.json() };
  } catch (e) {
    return { cid, ms: Math.round(performance.now() - start), error: String(e) };
  } finally {
    release();
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Bun.serve({
  port: PORT,
  // Bun closes connections idle for 10s by default; a check can be silent for longer.
  idleTimeout: 255, // max allowed
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname === "/health") {
      return Response.json({ active, queued: waiting.length, max: MAX_CONCURRENT }, { headers: CORS });
    }

    if (pathname !== "/batch" || req.method !== "POST") {
      return new Response("POST /batch {\"cids\": [...]}", { status: 404, headers: CORS });
    }

    let cids: unknown;
    try {
      ({ cids } = (await req.json()) as { cids: unknown });
    } catch {
      return new Response("invalid JSON", { status: 400, headers: CORS });
    }
    if (!Array.isArray(cids) || cids.length === 0 || cids.length > MAX_CIDS_PER_REQUEST) {
      return new Response(`cids must be an array of 1-${MAX_CIDS_PER_REQUEST}`, { status: 400, headers: CORS });
    }

    const unique = [...new Set(cids.map(String))];
    const signal = req.signal; // fires when the client disconnects -> cancels ipfs-check calls
    const enc = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        await Promise.all(
          unique.map(async (cid) => {
            const r = await checkCid(cid, signal);
            try {
              controller.enqueue(enc.encode(JSON.stringify(r) + "\n"));
            } catch {
              /* client gone */
            }
          }),
        );
        try {
          controller.close();
        } catch {}
      },
    });

    return new Response(stream, {
      headers: {
        ...CORS,
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no", // tell nginx not to buffer the stream
      },
    });
  },
});

console.log(`batch proxy on :${PORT} -> ${CHECK_URL} (max ${MAX_CONCURRENT} concurrent, ${CHECK_TIMEOUT_S}s/check)`);