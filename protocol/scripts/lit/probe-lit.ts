#!/usr/bin/env node
/**
 * probe-lit.ts — fresh-view probe of the Lit Protocol Core API (account management)
 *
 * Grounded in the API's OWN OpenAPI spec (fetched from <base>/openapi.json),
 * deliberately NOT in s2s/s3ntiment implementation code. Purpose: independently
 * verify correct request/response usage so we can catch a mistake on our side.
 *
 * Documented request shapes (from /openapi.json):
 *   POST /add_action                 { action_ipfs_cid, name, description }  [X-Api-Key]
 *   GET  /list_actions               ?group_id=&page_number=&page_size=      [X-Api-Key]
 *   GET|POST /create_wallet          (no body)                               [X-Api-Key]
 *   POST /add_action_to_group        { group_id, action_ipfs_cid }           [X-Api-Key]
 *   POST /remove_action_from_group   { group_id, hashed_cid }                [X-Api-Key]
 *   POST /get_lit_action_ipfs_id     (raw action-code body)                  NO auth
 *
 * Usage (read-only by default — writes are gated behind --write):
 *   LIT_PROBE_API_KEY=<key> tsx protocol/scripts/lit/probe-lit.ts
 *   LIT_PROBE_API_KEY=<key> tsx protocol/scripts/lit/probe-lit.ts --write
 *   LIT_PROBE_GROUP_ID=14 ...                    optional group id for list_actions
 *   LIT_PROBE_CID=<cid> ...                      CID used by the (write) add_action probe
 *   LIT_PROBE_BASE_URL=... LIT_PROBE_TIMEOUT_MS=...   overrides
 *
 * A plain run never mutates production state.
 */
import process from "node:process";

const BASE = process.env.LIT_PROBE_BASE_URL ?? "https://api.chipotle.litprotocol.com/core/v1";
const API_KEY = process.env.LIT_PROBE_API_KEY ?? "";
const GROUP_ID = process.env.LIT_PROBE_GROUP_ID; // optional
const TIMEOUT_MS = Number(process.env.LIT_PROBE_TIMEOUT_MS ?? 20000);
const WRITE = process.argv.includes("--write");

interface ProbeOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  write?: boolean;
}
interface ProbeResult {
  name: string;
  status: string;
  http: number;
  elapsedMs: number;
  detail: string;
}

async function probe(name: string, path: string, opts: ProbeOpts = {}): Promise<ProbeResult> {
  const { method = "GET", body, auth = true, write = false } = opts;
  if (write && !WRITE) {
    return { name, status: "SKIP (write gated)", http: 0, elapsedMs: 0, detail: "pass --write to enable" };
  }
  if (auth && !API_KEY) {
    return { name, status: "SKIP (no key)", http: 0, elapsedMs: 0, detail: "set LIT_PROBE_API_KEY" };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers["X-Api-Key"] = API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  let http = 0;
  let detail = "";
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    http = res.status;
    detail = (await res.text()).slice(0, 500);
    return { name, status: res.ok ? "PASS" : `FAIL(http ${res.status})`, http, elapsedMs: Date.now() - start, detail };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return {
      name,
      status: aborted ? `TIMEOUT(>${TIMEOUT_MS}ms)` : "NETWORK-ERR",
      http,
      elapsedMs: Date.now() - start,
      detail: aborted ? "" : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`Lit Core API probe — base=${BASE}`);
  console.log(`  write=${WRITE ? "ENABLED" : "off (read-only)"} timeout=${TIMEOUT_MS}ms key=${API_KEY ? `set (${API_KEY.slice(0, 6)}…)` : "NOT SET"}`);
  const group = GROUP_ID ? `&group_id=${GROUP_ID}` : "";
  const results: ProbeResult[] = [];

  results.push(await probe("list_actions (auth read)", `/list_actions?page_number=0&page_size=50${group}`));
  results.push(await probe("version (unauth)", "/version", { auth: false }));
  results.push(
    await probe("get_lit_action_ipfs_id (unauth POST)", "/get_lit_action_ipfs_id", {
      method: "POST",
      auth: false,
      body: "() => console.log('lit-probe')",
    }),
  );

  if (WRITE) {
    const cid = process.env.LIT_PROBE_CID ?? "QmNPXjE8X9fP1JeqMGNrhq6GDypghtdYBWJfXQdzd6sLQy";
    const testName = `probe-test-${Date.now()}`;
    results.push(
      await probe("add_action (WRITE)", "/add_action", {
        method: "POST",
        write: true,
        body: { action_ipfs_cid: cid, name: testName, description: "lit probe test action" },
      }),
    );
    results.push(await probe("create_wallet (WRITE)", "/create_wallet", { write: true }));
  }

  console.log("\n=== RESULTS ===");
  let failed = 0;
  for (const r of results) {
    console.log(`[${r.status.padEnd(28)}] ${r.name.padEnd(44)} ${String(r.elapsedMs).padStart(6)}ms http=${r.http}`);
    if (r.detail) console.log(`      ${r.detail}`);
    if (r.status.startsWith("FAIL") || r.status.startsWith("TIMEOUT") || r.status === "NETWORK-ERR") failed++;
  }
  const ok = results.length - failed;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
}

main();
