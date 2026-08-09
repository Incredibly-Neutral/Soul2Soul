// protocol/scripts/filecoin/probe-providers.ts
//
// Probes every active mainnet PDP provider for browser usability.
//
// Under the two-independent-primary strategy the client uploads to each of the
// TWO selected providers as its OWN PRIMARY (store + findPiece + commit) with
// copies: 1 — the SP-to-SP pull path is never used. So only the PRIMARY role
// is relevant here:
//
//   PRIMARY   — client PUTs the piece directly.
//               Needs: HTTP/2 (Chromium only streams request bodies over h2)
//                    + CORS on PUT /pdp/piece/uploads/{id}
//                      (ACAO present AND content-type in Allow-Headers)
//
// The SECONDARY (pull) role is reported for diagnostics only — a provider's
// pull-endpoint health no longer gates whether it can be used for copies.
//
// The earlier version of this script only checked that ACAO existed on the
// upload path. That was too lenient: provider 9 (ruka) passed, then failed at
// runtime with "Request header field content-type is not allowed by
// Access-Control-Allow-Headers in preflight response" on the PULL endpoint.
// Both the header check and the pull endpoint are now tested.

import { createPublicClient, http, hexToString } from "viem";
import { serviceProviderRegistry } from "@filoz/synapse-core/abis";
import { execSync } from "child_process";

const REGISTRY = "0xf55dDbf63F1b55c3F1D4FA7e339a68AB7b64A5eB" as const;
const RPC = "https://api.node.glif.io/rpc/v1";

// Probe from both origins we actually upload from.
const ORIGINS = [
  "https://publication-module.soul2soul.io", // safe-app
  "app://obsidian.md",                       // 0xobsidian plugin
];

const ENDORSED = new Set([1, 5, 7]);

const ACTIVE_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 30, 31, 32,
];

const abi = (serviceProviderRegistry as any).abi ?? serviceProviderRegistry;
const client = createPublicClient({ transport: http(RPC) });

// ── helpers ─────────────────────────────────────────────────────────

/** capabilityKeys[] + productCapabilityValues[] → { key: decodedString } */
function decodeCaps(product: any, values: readonly `0x${string}`[]) {
  const out: Record<string, string> = {};
  product.capabilityKeys.forEach((k: string, i: number) => {
    try { out[k] = hexToString(values[i]); } catch { out[k] = values[i]; }
  });
  return out;
}

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** Does the SP negotiate HTTP/2? Chromium needs h2 to stream a request body. */
function checkAlpn(host: string): "h2" | "http/1.1" | "none" | "fail" {
  const out = sh(
    `openssl s_client -connect ${host}:443 -alpn h2,http/1.1 </dev/null 2>/dev/null | grep -i "ALPN protocol"`,
  );
  if (!out) return "fail";
  if (out.includes("h2")) return "h2";
  if (out.includes("http/1.1")) return "http/1.1";
  return "none";
}

type CorsResult = {
  ok: boolean;
  acao: boolean;          // Access-Control-Allow-Origin present
  allowsContentType: boolean;
  allowsMethod: boolean;
  raw: string;
};

/**
 * Full CORS preflight check — not just "is ACAO present".
 * Verifies the browser would actually be allowed to send this request:
 *   - Access-Control-Allow-Origin present
 *   - Access-Control-Allow-Headers includes content-type
 *   - Access-Control-Allow-Methods includes the method
 */
function checkCors(url: string, method: "PUT" | "POST", origin: string): CorsResult {
  const raw = sh(
    `curl -s -o /dev/null -D - -X OPTIONS "${url}" ` +
    `-H "Origin: ${origin}" ` +
    `-H "Access-Control-Request-Method: ${method}" ` +
    `-H "Access-Control-Request-Headers: content-type" ` +
    `--max-time 12 2>/dev/null`,
  ).toLowerCase();

  const acao = /access-control-allow-origin:/.test(raw);

  const headersLine = raw.match(/access-control-allow-headers:([^\r\n]*)/)?.[1] ?? "";
  const methodsLine = raw.match(/access-control-allow-methods:([^\r\n]*)/)?.[1] ?? "";

  // A wildcard in Allow-Headers permits any header.
  const allowsContentType =
    headersLine.includes("*") || headersLine.includes("content-type");

  const allowsMethod =
    methodsLine.includes("*") || methodsLine.includes(method.toLowerCase());

  return {
    ok: acao && allowsContentType && allowsMethod,
    acao,
    allowsContentType,
    allowsMethod,
    raw,
  };
}

/** Short reason string for why CORS failed, for the report. */
function corsWhy(c: CorsResult): string {
  if (c.ok) return "ok";
  if (!c.acao) return "no-ACAO";
  if (!c.allowsContentType) return "no-content-type";
  if (!c.allowsMethod) return "method-not-allowed";
  return "?";
}

// ── probe ───────────────────────────────────────────────────────────

type Row = {
  id: number;
  name: string;
  host: string;
  url: string;
  status: string;
  alpn: string;
  upload: string;     // per-origin worst result
  pull: string;
  primaryOk: boolean;
  secondaryOk: boolean;
};

const rows: Row[] = [];

console.log(
  "id\tend\tPRIM\tSEC\talpn\t\tupload-cors\tpull-cors\tstatus\t\tname / host",
);
console.log("─".repeat(120));

for (const id of ACTIVE_IDS) {
  let r: any;
  try {
    r = await client.readContract({
      address: REGISTRY,
      abi,
      functionName: "getProviderWithProduct",
      args: [BigInt(id), 0], // productType 0 = PDP
    });
  } catch {
    console.log(`${id}\t\t— registry read failed`);
    continue;
  }

  const name: string = r.providerInfo?.name ?? "?";
  if (!r.providerInfo?.isActive || !r.product?.isActive) {
    console.log(`${id}\t\t— inactive\t\t\t\t\t\t\t${name}`);
    continue;
  }

  const caps = decodeCaps(r.product, r.productCapabilityValues);
  const url = (caps.serviceURL ?? "").replace(/\/$/, "");
  if (!url.startsWith("http")) {
    console.log(`${id}\t\t— no serviceURL\t\t\t\t\t\t${name}`);
    continue;
  }

  const host = new URL(url).host;
  const status = caps.serviceStatus ?? "";

  // 1. ALPN — only matters for the PRIMARY (streaming PUT from the client).
  const alpn = checkAlpn(host);

  // 2. CORS on the upload path (PRIMARY role) — must pass from EVERY origin.
  const uploadChecks = ORIGINS.map(o =>
    checkCors(`${url}/pdp/piece/uploads/x`, "PUT", o),
  );
  const uploadOk = uploadChecks.every(c => c.ok);
  const uploadWhy = uploadOk ? "ok" : corsWhy(uploadChecks.find(c => !c.ok)!);

  // 3. CORS on the pull path (SECONDARY role) — this is what broke ruka.
  const pullChecks = ORIGINS.map(o =>
    checkCors(`${url}/pdp/piece/pull`, "POST", o),
  );
  const pullOk = pullChecks.every(c => c.ok);
  const pullWhy = pullOk ? "ok" : corsWhy(pullChecks.find(c => !c.ok)!);

  // Roles
  const primaryOk   = alpn === "h2" && uploadOk;
  const secondaryOk = pullOk;   // no client-side streaming body → ALPN not required

  rows.push({ id, name, host, url, status, alpn, upload: uploadWhy, pull: pullWhy, primaryOk, secondaryOk });

  console.log(
    `${id}\t${ENDORSED.has(id) ? "[E]" : "   "}\t` +
    `${primaryOk ? "✅" : "❌"}\t${secondaryOk ? "✅" : "❌"}\t` +
    `${alpn.padEnd(8)}\t${uploadWhy.padEnd(14)}\t${pullWhy.padEnd(14)}\t` +
    `${(status || "-").padEnd(8)}\t${name} / ${host}`,
  );
}

// ── report ──────────────────────────────────────────────────────────

const primaries  = rows.filter(r => r.primaryOk);
const secondaries = rows.filter(r => r.secondaryOk);
const both       = rows.filter(r => r.primaryOk && r.secondaryOk);

console.log(`\n${"═".repeat(70)}`);
console.log(`active PDP providers probed : ${rows.length}`);
console.log(`usable as PRIMARY  (h2 + upload CORS) : ${primaries.length}`);
console.log(`usable as SECONDARY (pull CORS)       : ${secondaries.length}  (diagnostic only)`);
console.log(`usable as BOTH                        : ${both.length}`);

console.log(`\n=== usable as PRIMARY — safe as an INDEPENDENT PRIMARY (copies: 1) ===`);
for (const r of primaries) {
  console.log(`  ${String(r.id).padEnd(3)} ${r.name.padEnd(24)} ${(r.status || "-").padEnd(8)} ${r.host}`);
}

console.log(`\n// paste into shared/src/filecoin/index.ts`);
console.log(`const BROWSER_USABLE_PROVIDERS = [${primaries.map(r => r.id + "n").join(", ")}];`);

// Providers that can take the primary but can't be pulled to — usable only
// with copies: 1, or as the primary in a mixed set.
const primaryOnly = rows.filter(r => r.primaryOk && !r.secondaryOk);
if (primaryOnly.length) {
  console.log(`\n=== primary-only (pull CORS fails — will break as a secondary) ===`);
  for (const r of primaryOnly) {
    console.log(`  ${String(r.id).padEnd(3)} ${r.name.padEnd(24)} pull=${r.pull}\t${r.host}`);
  }
}

console.log(`
NOTE: this probes CORS + ALPN only — i.e. "can a browser talk to it at all".
It does NOT test whether an SP-to-SP pull actually completes: provider 6
(Axiaoming) passed CORS but timed out pulling from the primary after 300s
("Failed to pull pieces from source provider"). That is a server-side
reachability/performance issue between the two SPs and only mattered for the
old one-primary-plus-one-pull strategy. Under two-independent-primary stores
the pull path is never used, so a provider's pull-endpoint health is
irrelevant — any PRIMARY-usable provider works as an independent primary.
Treat this list as a necessary, not sufficient, filter.
`);