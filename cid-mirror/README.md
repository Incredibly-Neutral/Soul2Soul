# cid-mirror

Content-addressed → location-addressed static site mirror.

Resolves an ENS publication name (or bare CID) to a root CID via the canonical s2s
mechanism — reading the `contenthash_wrapped` text record from the ensRecords records
contract on Base L2 (chainId 8453) and decoding the EIP-1577 `0xe3 01 <CID>` envelope —
then traverses the IPFS tree through a kubo RPC endpoint, and downloads every leaf
file to a local `webcontent/` directory with standard URL path structure — so nginx (or any
static file server) can serve it as a plain location-addressed website.

## Quick start

```bash
# 1. Configure
cp .env.example .env
# Edit .env: set PUBLICATION_URL, L1_RPC_URL, L2_RPC_URL, IPFS_API_URL

# 2. Build and start
docker compose up --build

# 3. Check status
curl http://localhost:3000/api/status

# 4. Trigger a re-mirror
curl -X POST http://localhost:3000/api/refresh
```

## API

| Method | Path            | Description                       |
|--------|-----------------|-----------------------------------|
| GET    | `/healthz`      | Liveness check                    |
| GET    | `/api/status`   | Current mirror state (CID, files) |
| POST   | `/api/refresh`  | Re-resolve, re-traverse, re-download, atomic swap |

### POST /api/refresh response

```json
{
  "rootCid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "files": 42,
  "durationMs": 1234,
  "refreshedAt": "2026-09-02T06:00:00.000Z"
}
```

## Serving with nginx

The `docker-compose.yml` bind-mounts `./webcontent:/app/webcontent` on the host. Configure nginx
(or another web server) to serve from that directory:

```nginx
server {
    listen 80;
    server_name example.com;

    root /path/to/cid-mirror/webcontent/current;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

The mirror engine writes into `webcontent/current` after an atomic swap; the `.staging` and `old`
directories are transient. Point nginx at the `current/` subdirectory.

## Traversal primitive choice

The engine uses **`ls` (IPFS links listing)** + recursive traversal with `cat` for leaf content.

Rationale:
- **`ls`** returns typed links (dir vs. file size heuristic) without loading the full DAG node,
  making it efficient for deep or wide trees.
- **`dag/get`** is heavier and unpacks full dag-pb nodes into JSON — useful when you need DAG
  structure metadata but wasteful for simple traversal.
- **`get`** (recursive single-call dump) does not give the incremental control needed for
  concurrency-limited downloads.
- **`ls` + `cat`** provides a clean split: list links first, then download leaves with bounded
  concurrency. This handles arbitrary unixFS trees including those with sharded directories.

## Environment variables

| Variable              | Required | Default               | Description                                |
|-----------------------|----------|-----------------------|--------------------------------------------|
| `PUBLICATION_URL`     | yes      | —                     | ENS name (`xxx.soul2soul.eth`) or bare CID |
| `L1_RPC_URL`          | yes      | —                     | Ethereum mainnet (chainId 1) — used only for the s2s ENS controller discovery leg |
| `L2_RPC_URL`          | yes      | —                     | Base mainnet (chainId 8453) — where the root CID is read (`contenthash_wrapped` on the records contract) |
| `RECORDS_CONTRACT`    | no       | (discover)            | Override the s2s ensRecords records contract address; unset = discover via s2s ENS flow |
| `IPFS_API_URL`        | no       | `http://127.0.0.1:5001` | Kubo RPC base URL                        |
| `PORT`                | no       | `3000`                | API server port                            |
| `REFRESH_INTERVAL_MS` | no       | (off)                 | Auto-refresh interval in ms                |
| `IPFS_API_AUTH`       | no       | (none)                | Authorization header for kubo RPC          |

## Development

```bash
# Install dependencies
npm install

# Typecheck
npm run typecheck

# Test
npm test

# Run locally (with .env configured)
npm start

# Watch mode
npm run dev
```

## Project structure

```
cid-mirror/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Environment config loader
│   ├── ens.ts                # ENS resolution (namehash, contenthash lookup)
│   ├── mirror.ts             # Tree traversal + atomic download engine
│   ├── api/
│   │   └── index.ts          # Express routes (refresh, status, healthz)
│   └── ipfs/
│       ├── contenthash.ts    # Vendored from s2s monorepo (contenthash decode)
│       ├── index.ts          # Re-exports + contenthashToIPFS helper
│       └── kubo.ts           # Kubo RPC client (cat, ls, dagGet)
├── tests/
│   ├── contenthash.test.ts
│   ├── ens.test.ts
│   ├── path-mapping.test.ts
│   └── traversal.test.ts
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Code provenance

- **`src/ipfs/contenthash.ts`** — vendored verbatim from `shared/src/ipfs/contenthash.ts` in the
  s2s monorepo. Pure, dependency-free base58/base32/CID math. Maintains the attribution header.
- **`src/ipfs/kubo.ts`** — mirrors kubo RPC patterns from `S2SIPFSMethods`
  (`shared/src/ipfs/index.ts`) and `ipfs.factory.ts` (`protocol/actions/src/libs/ipfs.factory.ts`).
- **`src/ens.ts`** — s2s root-CID resolution mirrors `protocol/actions/src/libs/ens.factory.ts`
  + `protocol.factory.ts` (getProtocolInfo): namehash → L2 (Base 8453) records-contract
  `getText('contenthash_wrapped')` → decode the `0xe3 01 <CID>` envelope. (The old standard-ENS
  `registry.resolver → contenthash` path is NOT how s2s publishes.)
