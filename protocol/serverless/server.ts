import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

const IPFS_GATEWAY = process.env.IPFS_GATEWAY || "https://ipfs.filebase.io";
const ACTION_TIMEOUT = parseInt(process.env.ACTION_TIMEOUT_MS || "30000", 10);
const PORT = parseInt(process.env.PORT || "4269", 10);

// ═══ Lit Actions shim (no signing) ═══
globalThis.Lit = {
  Actions: {
    set: () => {},
    readSecretData: () => new Uint8Array(0),
    getPrimaryKey: () => new Uint8Array(8),
    setPublicKey: () => {},
    signEthereum: async () => { throw new Error("signing disabled"); },
    getPrivateKey: async () => { throw new Error("signing disabled"); },
  },
};

// ═══ ethers@5 global ═══
const ethers = await import("ethers");
globalThis.ethers = ethers;

// ═══ Polyfills ═══
if (!globalThis.Buffer) {
  globalThis.Buffer = require("buffer").Buffer;
}
if (!globalThis.process) {
  globalThis.process = { env: { NODE_ENV: "production", BROWSER: "true" } };
}
if (!globalThis.FormData) {
  const { FormData } = require("node-fetch");
  globalThis.FormData = FormData;
}
if (!globalThis.Blob) {
  const { Blob } = require("node-fetch");
  globalThis.Blob = Blob;
}

// ═══ LRU Cache ═══
class LRUCache {
  private cache = new Map<string, string>();
  private max: number;

  constructor(max = 50) {
    this.max = max;
  }

  get(key: string) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key: string, val: string) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.max) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, val);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

// ═══ Global cache instance ═══
const codeCache = new LRUCache(50);

// ═══ Fetch action from IPFS ═══
async function fetchFromIPFS(cid: string): Promise<string> {
  // Check cache first
  const cached = codeCache.get(cid);
  if (cached) return cached;

  const clean = cid.replace(/^\/(ipfs|ipns)\//, "");
  const url = `${IPFS_GATEWAY}\/ipfs\/${clean}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`IPFS failed: ${res.status} ${res.statusText}`);
  const text = await res.text();

  // Store in cache
  codeCache.set(cid, text);
  return text;
}

// ═══ Execute action ═══
async function executeAction(code: string, inputs: any): Promise<any> {
  // Inject globals
  const wrapped = `
    globalThis.Buffer = globalThis.Buffer || { alloc: () => new Uint8Array(0) };
    globalThis.process = globalThis.process || { env: { NODE_ENV: 'production', BROWSER: 'true' } };
    globalThis.FormData = globalThis.FormData || class FormData {};
    globalThis.Blob = globalThis.Blob || class Blob {};
    ${code}
  `;

  // Create sandboxed function
  const fn = new Function(
    "params",
    "globalThis",
    "ethers",
    `
    ${wrapped}
    if (typeof main !== 'function') {
      return { error: 'no main function defined' };
    }
    return main(params);
  `
  );

  const { ethers } = await import("ethers");
  const result = await fn(inputs, globalThis, ethers);
  return result;
}

// ═══ Routes ═══
app.get("/health", (c) => {
  return c.json({ status: "ok", uptime: process.uptime() });
});

app.get("/actions/:cid", async (c) => {
  const cid = c.req.param("cid");
  try {
    const code = await fetchFromIPFS(cid);
    return c.json({ cid, code, status: "fetched" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, { status: 502 });
  }
});

app.get("/ipfs/:cid", async (c) => {
  const cid = c.req.param("cid");
  try {
    const text = await fetchFromIPFS(cid);
    return c.text(text);
  } catch (err) {
    return c.json({ error: (err as Error).message }, { status: 502 });
  }
});

app.post("/run", async (c) => {
  const { cid, code, inputs } = await c.req.json() as any;

  // Get code
  const actionCode = code || (cid ? await fetchFromIPFS(cid) : null);
  if (!actionCode) return c.json({ error: "require code or cid" }, 400);

  const params = inputs || {};

  try {
    // Execute with timeout
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ACTION_TIMEOUT)
    );
    const actionPromise = executeAction(actionCode, params);

    const result = await Promise.race([actionPromise, timeoutPromise]);
    return c.json({ success: true, response: result });
  } catch (err) {
    const message = (err as Error).message;
    if (message === "timeout") return c.json({ error: "action timed out" }, { status: 504 });
    return c.json({ error: message }, { status: 500 });
  }
});

// ═══ Start server ═══
app.fire();

serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  console.log(`\n  🚀 s2s lit-action runner`);
  console.log(`  🌐 PORT:     ${info.port}`);
  console.log(`  📡 IPFS GW:  ${IPFS_GATEWAY}`);
  console.log(`  ⏱ TIMEOUT:   ${ACTION_TIMEOUT}ms`);
  console.log(`  📦 RUNTIME:   Bun`);
  console.log(`  ─────────────────────────`);
});

process.on("SIGINT", async () => {
  console.log("\n⏹  shutting down...");
  process.exit(0);
});
