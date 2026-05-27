import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Config ──────────────────────────────────────────────
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || "https://ipfs.transport-union.dev";
const ACTION_TIMEOUT_MS = parseInt(process.env.ACTION_TIMEOUT_MS || "30000", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);

// ─── Helpers ─────────────────────────────────────────
const runTempScript = (code, timeout) =>
  new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `s2s-action-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);

    writeFileSync(tmpFile, code, "utf8");

    const child = execFile(
      "node",
      [tmpFile],
      { timeout, maxBuffer: 1024 * 1024 * 10, env: { ...process.env } },
      (err, stdout, stderr) => {
        try { rmSync(tmpFile); } catch {}
        if (err) return reject(err);
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
    child.on("error", reject);
  });

// ─── IPFS fetch ──────────────────────────────────
async function fetchFromIPFS(cid) {
  const cleanCid = cid.replace(/^\/ipfs\//, "").replace(/^\/ipns\//, "");
  const url = `${IPFS_GATEWAY}/api/v0/cat?arg=${cleanCid}`;
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`IPFS cat failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

// ─── Build execution script ──────────────────────
function buildScript(userCode, inputs) {
  // Inject globals + action code, then call main(inputs)
  return `
    // ═══ Polyfills ═══
    const { Buffer } = require("buffer");
    globalThis.Buffer = Buffer;
    if (!globalThis.process) {
      globalThis.process = { env: { NODE_ENV: "production", BROWSER: "true" } };
    }
    globalThis.crypto = globalThis.crypto || await import("crypto").then(c => c.webcrypto);

    // ═══ ethers@5 global ═══
    globalThis.ethers = require("ethers");

    // ═══ Lit Actions shim (no signing) ═══
    const secretData = Buffer.from("{}","utf8");
    globalThis.Lit = {
      Actions: {
        set: () => {},
        readSecretData: () => secretData,
        getPrimaryKey: () => Buffer.from("00000000","hex"),
        setPublicKey: () => {},
        signEthereum: () => Promise.reject("signing disabled in serverless mode"),
        getPrivateKey: () => Promise.reject("key management disabled in serverless mode"),
      }
    };

    // ═══ User code ═══
    ${userCode}

    // ═══ Run main() if defined ═══
    (async () => {
      if (typeof main !== "function") return { status: "no main function defined" };
      return await main(${JSON.stringify(inputs)});
    })()
    .then(result => console.log(JSON.stringify({ result })))
    .catch(err => console.error(JSON.stringify({ error: err.message, stack: err.stack || "N/A" })));
  `;
}

// ════════════════════════════════════════════════════════
// ─── SERVER ─────────────────────────────────────────
// ════════════════════════════════════════════════════════
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // ═── Health ──
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
  }

  // ═── GET /actions/:cid — fetch action code from IPFS ──
  if (req.method === "GET" && /^\/actions\/.+$/.test(req.url)) {
    const cid = req.url.replace("/actions/", "");
    try {
      const code = await fetchFromIPFS(cid);
      res.writeHead(200);
      return res.end(JSON.stringify({ cid, code, fetched: true }));
    } catch (err) {
      res.writeHead(502);
      return res.end(JSON.stringify({ error: `IPFS fetch failed: ${err.message}` }));
    }
  }

  // ═── GET /ipfs/:cid — raw IPFS cat ──
  if (req.method === "GET" && /^\/ipfs\/.+$/.test(req.url)) {
    const cid = req.url.replace("/ipfs/", "");
    try {
      const text = await fetchFromIPFS(cid);
      res.writeHead(200);
      return res.end(text);
    } catch (err) {
      res.writeHead(502);
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═── POST /run — execute an action ──
  if (req.method === "POST" && req.url === "/run") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "invalid JSON" }));
    }

    let code;
    if (body.code) {
      code = body.code;
    } else if (body.cid) {
      code = await fetchFromIPFS(body.cid);
    } else {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'provide "code" or "cid"' }));
    }

    const inputs = body.inputs || {};

    try {
      const fullScript = buildScript(code, inputs);
      const result = await runTempScript(fullScript, ACTION_TIMEOUT_MS);

      // Parse the JSON result from stdout
      let parsed = { status: "raw output" };
      for (const line of (result.stdout || "").split("\n").filter(Boolean)) {
        try {
          parsed = JSON.parse(line);
          break;
        } catch { /* skip */ }
      }

      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        ...parsed,
        logs: { stdout: result.stdout, stderr: result.stderr },
      }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({
        success: false,
        error: err.message,
        code: err.code,
      }));
    }
  }

  res.writeHead(404);
  return res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  🚀 s2s Lit-action runner");
  console.log("  ─────────────────────────");
  console.log(`  🌐  PORT:       ${PORT}`);
  console.log(`  📡 IPFS GW:     ${IPFS_GATEWAY}`);
  console.log(`  ⏱  TIMEOUT:    ${ACTION_TIMEOUT_MS}ms`);
  console.log("  ─────────────────────────");
  console.log("  Endpoints:");
  console.log("  POST /run              — run action  (body: { cid|code, inputs })");
  console.log("  GET  /actions/:cid     — fetch action code from IPFS");
  console.log("  GET  /ipfs/:cid        — raw IPFS cat");
  console.log("  GET  /health           — uptime check");
  console.log("\n  Example:");
  console.log("    curl -X POST http://localhost:${PORT}/run \\");
  console.log("      -H 'Content-Type: application/json' \\");
  console.log("      -d '{\"cid\":\"<IPFS_CID>\", \"inputs\":{\"publication\":\"foo.bar.eth\",\"configCid\":\"Qm...\"}}'");
  console.log("\n");
});
