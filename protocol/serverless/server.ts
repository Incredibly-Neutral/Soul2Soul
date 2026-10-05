import { Hono } from 'hono';
import { serve } from '@hono/node-server';

// Bun sets `import.meta.main` only for the directly-run entry module, so the
// server startup block below is skipped when this file is imported (e.g. by
// the regression test under vitest/node).
declare global {
  interface ImportMeta {
    main?: boolean;
  }
  // Globals this module installs at load time (Lit shim, ethers@5) — declared
  // here so the strict typecheck is clean without `any`.
  var Lit: {
    Actions: {
      set: () => void;
      readSecretData: () => Uint8Array;
      getPrimaryKey: () => Uint8Array;
      setPublicKey: () => void;
      signEthereum: () => Promise<never>;
      getPrivateKey: () => Promise<never>;
    };
  };
  var ethers: unknown;
}

export const app = new Hono();

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
    signEthereum: async () => {
      throw new Error('signing disabled');
    },
    getPrivateKey: async () => {
      throw new Error('signing disabled');
    },
  },
};

// ═══ ethers@5 global ═══
const ethers = await import('ethers');
globalThis.ethers = ethers;

// ═══ Polyfills ═══
if (!globalThis.Buffer) {
  globalThis.Buffer = require('buffer').Buffer;
}
if (!globalThis.process) {
  globalThis.process = {
    env: { NODE_ENV: 'production', BROWSER: 'true' },
  } as unknown as NodeJS.Process;
}
if (!globalThis.FormData) {
  const { FormData } = require('node-fetch');
  globalThis.FormData = FormData;
}
if (!globalThis.Blob) {
  const { Blob } = require('node-fetch');
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
      // size >= max >= 1 guarantees a key exists here, but guard it for the typechecker.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
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

  const clean = cid.replace(/^\/(ipfs|ipns)\//, '');
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
    'params',
    'globalThis',
    'ethers',
    `
    ${wrapped}
    if (typeof main !== 'function') {
      return { error: 'no main function defined' };
    }
    return main(params);
  `,
  );

  const { ethers } = await import('ethers');
  const result = await fn(inputs, globalThis, ethers);
  return result;
}

// ═══ Routes ═══
app.get('/health', (c) => {
  return c.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/actions/:cid', async (c) => {
  const cid = c.req.param('cid');
  try {
    const code = await fetchFromIPFS(cid);
    return c.json({ cid, code, status: 'fetched' });
  } catch (err) {
    return c.json({ error: (err as Error).message }, { status: 502 });
  }
});

app.get('/ipfs/:cid', async (c) => {
  const cid = c.req.param('cid');
  try {
    const text = await fetchFromIPFS(cid);
    return c.text(text);
  } catch (err) {
    return c.json({ error: (err as Error).message }, { status: 502 });
  }
});

app.post('/run', async (c) => {
  // ── Setup phase: parse the body and resolve the action code. Every failure
  //    here must return JSON with an appropriate status — the neutralpress
  //    client is JSON-only and chokes on Hono's default text/plain 500.
  let cid: string | undefined;
  let code: string | undefined;
  let inputs: unknown;
  try {
    const body = await c.req.json<{ cid?: string; code?: string; inputs?: unknown }>();
    cid = body.cid;
    code = body.code;
    inputs = body.inputs;
  } catch {
    return c.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Get code
  let actionCode: string | null = null;
  if (code) {
    actionCode = code;
  } else if (cid) {
    try {
      actionCode = await fetchFromIPFS(cid);
    } catch (err) {
      // Mirror /actions and /ipfs: surface the fetchFromIPFS message as JSON 502.
      return c.json({ error: (err as Error).message }, { status: 502 });
    }
  }
  if (!actionCode) return c.json({ error: 'require code or cid' }, 400);

  const params = inputs || {};

  try {
    // Execute with timeout
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ACTION_TIMEOUT),
    );
    const actionPromise = executeAction(actionCode, params);

    const result = await Promise.race([actionPromise, timeoutPromise]);
    return c.json({ success: true, response: result });
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'timeout') return c.json({ error: 'action timed out' }, { status: 504 });
    return c.json({ error: message }, { status: 500 });
  }
});

// ═══ Global error handler — ALWAYS JSON ═══
// Safety net for any uncaught error thrown from a handler (e.g. a future
// setup-phase change): never let Hono's default text/plain "Internal Server
// Error" reach the JSON-only client.
app.onError((err, c) => {
  console.error('[serverless] unhandled error:', err);
  return c.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
});

// ═══ Start server (only when run directly, not when imported by tests) ═══
if (import.meta.main) {
  app.fire();

  serve(
    {
      fetch: app.fetch,
      port: PORT,
    },
    (info) => {
      console.log(`\n  🚀 s2s lit-action runner`);
      console.log(`  🌐 PORT:     ${info.port}`);
      console.log(`  📡 IPFS GW:  ${IPFS_GATEWAY}`);
      console.log(`  ⏱ TIMEOUT:   ${ACTION_TIMEOUT}ms`);
      console.log(`  📦 RUNTIME:   Bun`);
      console.log(`  ─────────────────────────`);
    },
  );

  process.on('SIGINT', async () => {
    console.log('\n⏹  shutting down...');
    process.exit(0);
  });
}
