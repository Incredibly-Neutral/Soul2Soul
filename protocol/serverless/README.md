# s2s Serverless Lit-action Runner

Bun-based Lit-action runner — fetches JS from IPFS by CID, injects ethers@5 + polyfills, executes securely in a sandboxed container.

## Architecture

| File | Purpose |
|---|---|
| `server.ts` | Bun HTTP server (Hono framework) |
| `Dockerfile` | Docker build |
| `docker-compose.yml` | Local Docker Compose |
| `.env.example` | Environment variables |

## Key Features

- Fetches and executes any JavaScript action stored on IPFS by CID
- LRU cache (50 entries) for repeated action code fetches
- Injects ethers@5 as a global (no signing capabilities)
- Lit Actions shim (`Lit.Actions.*`) for compatibility
- Bun runtime — fast, no npm
- Explicit permission flags for sandboxing

## Ports

| Port | Service |
|---|---|
| `4269` | HTTP API |

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/run` | Execute an action |
| `GET` | `/actions/:cid` | Fetch action code from IPFS |
| `GET` | `/ipfs/:cid` | Raw IPFS cat |
| `GET` | `/health` | Uptime check |

## Usage

### cURL

```bash
curl -X POST http://localhost:4269/run \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "Qm...action...",
    "inputs": { "publication": "foo.bar.eth", "configCid": "Qm..." }
  }'
```

### TypeScript (via `fetch` + `globalThis.ethers`)

```typescript
interface ActionRunParams {
  cid?: string;
  code?: string;       // or inline code instead of cid
  inputs: Record<string, unknown>;
}

interface ActionRunResult {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

async function runAction(params: ActionRunParams): Promise<ActionRunResult> {
  const res = await fetch("http://localhost:4269/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  return res.json();
}

// Example 1 — fetch action from IPFS
const res1 = await runAction({
  cid: "QmXyz123...abc",
  inputs: {
    publication: "foo.bar.eth",
    configCid: "QmConfig456...",
  },
});

// Example 2 — inline code (for prototyping)
const res2 = await runAction({
  code: `
    async function main(inputs) {
      const addr = "0x1234...";
      const signer = new ethers.Wallet(inputs.privateKey);
      return { addr, chainId: signer.provider?.network?.chainId };
    }
  `,
  inputs: { privateKey: "0xabc..." },
});
```

### TypeScript (via `Deno` / `Bun` — same server)

```typescript
// client.ts — run a stored action
import { runAction } from "./client";

const result = await runAction({
  cid: "QmPrepAction001...",
  inputs: {
    protocolInfo: { chainId: 8453 },
    authorSafeAddress: "0xa1b2...",
    publication: "alice.soul2soul.eth",
    configCid: "QmConfig789...",
    contentIds: ["QmPost001...", "QmPost002..."],
  },
});

console.log(result.result?.jobs); // [{ id, templateConfig, templateData, html }, ...]
```

### curl — fetch action code only

```bash
curl http://localhost:4269/actions/QmPrepAction001...
# → { "cid": "QmPrepAction001...", "code": "async function main...", "fetched": true }
```

### curl — health check

```bash
curl http://localhost:4269/health
# → { "status": "ok", "uptime": 142.3 }
```

## Docker / Docker Compose

```bash
# Build + run
docker build -s2s/serverless:latest .
docker run -p 4269:4269 s2s/serverless:latest

# Or via docker-compose
docker compose up --build
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4269` | HTTP server port |
| `IPFS_GATEWAY` | `https://ipfs.filebase.io` | IPFS Filebase gateway (URLs: `{IPFS_GATEWAY}/ipfs/{cid}`) |
| `ACTION_TIMEOUT_MS` | `30000` | Max execution time per action (ms) |
