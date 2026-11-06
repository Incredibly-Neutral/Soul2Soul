# pimlico-proxy

A small HTTP service between our frontend and Pimlico's bundler/paymaster API.

It exists so that the Pimlico API key never reaches a browser, and so that gas is
only ever sponsored for calls to our own contracts. It holds the key, authenticates
users with a session JWT, forwards an allowlisted set of JSON-RPC methods, always
attaches our sponsorship policy ID, and rejects any user operation whose calldata
targets something outside a per-chain allowlist.

The proxy signs nothing. It authenticates, filters and relays.

```
App backend ──(session JWT)──► Frontend ──(JSON-RPC + JWT)──► Proxy ──(?apikey=KEY)──► Pimlico ──► EntryPoint
     └──────────────(shared JWT secret)──────────────────────────┘
```

## Endpoints

| Route                | What it does                                  |
| -------------------- | --------------------------------------------- |
| `POST /rpc/:chainId` | JSON-RPC 2.0, single call or batch (up to 20) |
| `GET /healthz`       | `{"ok":true}`, no auth                        |

## Run

```bash
cp .env.example .env      # then fill in the real values
npm install
npm run dev               # tsx watch, reads .env
```

Production:

```bash
npm run build             # tsc -> dist/
npm start                 # node --env-file-if-exists=.env dist/index.js
```

`npm test` runs the suite (node:test + tsx). `npm run typecheck` checks `src/` and `test/`.

Missing or invalid configuration is a startup failure that names the variable and
nothing else. Secrets are never logged, never returned in an error, and never
appear in a response body.

## Configuration

Every variable is documented in [`.env.example`](./.env.example). The required set
is `PIMLICO_API_KEY`, `PIMLICO_SPONSORSHIP_POLICY_ID`, `ALLOWED_CHAIN_IDS`,
`ALLOWED_CALLS`, `CORS_ORIGINS` and, in `jwt` mode, `AUTH_JWT_SECRET`.

`AUTH_MODE=none` additionally requires `ALLOW_INSECURE_AUTH=true`, and is refused
when `NODE_ENV=production`. `TRUST_PROXY` defaults to `false`; set it to `true` only
behind a reverse proxy you control, because it makes the last `X-Forwarded-For`
entry the rate-limit key.

`ALLOWED_CALLS` is a comma-separated list of `address:selector` or
`chainId:address:selector`, with `*` for any selector:

```
ALLOWED_CALLS=84532:0xAbc...:0xa9059cbb,84532:0xAbc...:*
```

Addresses are lowercased on load. A selector only ever allows that one function on
that one contract.

## What gets through

Checks run in order; the first failure returns and nothing is forwarded.

1. **Origin** — a present `Origin` must match `CORS_ORIGINS` exactly, otherwise 403. A request with no `Origin` (server-to-server, curl) is let through; CORS
   headers are only ever sent to an allowed origin. This is a gate, not decoration:
   a cross-site `text/plain` POST gets no preflight, so header-only CORS would still
   let it reach the pipeline.
2. **Auth** — `Authorization: Bearer <JWT>`, HS256, requires `exp` and `sub`. Runs
   before the chain check, so an unauthenticated caller cannot map
   `ALLOWED_CHAIN_IDS` by comparing 401 against 404.
3. **Chain** — must be in `ALLOWED_CHAIN_IDS`, otherwise 404.
4. **Body** — JSON, max 256 KB.
5. **Rate limit** — per user and per IP, charged per call in a batch.
6. **Method** — allowlisted only. `pm_validateSponsorshipPolicies` and everything
   else not on the list is refused.
7. **Calldata** — every inner call in the user operation must hit an allowed
   target and selector. This is what stops the key being used for anything else.
8. **Policy** — the sponsorship policy ID is set server-side; a client-supplied
   value is discarded.
9. **Forward** — `POST {PIMLICO_BASE_URL}/v2/{chainId}/rpc?apikey=…`, 15 s timeout.

Rejections come back as JSON-RPC errors: `-32601` method not allowed, `-32602`
policy violation with a reason, `-32005` rate limited, `-32603` upstream trouble.

### Calldata unwrapping

`userOp.callData` is an account `execute` wrapper. Each supported wrapper is
decoded into `{ target, value, data }[]` and every inner call is judged:

| Account                                                          | Selector     |
| ---------------------------------------------------------------- | ------------ |
| Simple / Light single `execute(address,uint256,bytes)`           | `0xb61d27f6` |
| Simple v0.7 `executeBatch(address[],uint256[],bytes[])`          | `0x47e1da2a` |
| Simple v0.6 / Light v1 `executeBatch(address[],bytes[])`         | `0x18dfb3c7` |
| Simple v0.8 / Light v2 `executeBatch((address,uint256,bytes)[])` | `0x34fcd5be` |
| ERC-7579 `execute(bytes32,bytes)` (Kernel v3, Nexus)             | `0xe9ae5c53` |
| Kernel v2 `execute(address,uint256,bytes,uint8)`                 | `0x51945447` |
| Safe 4337 `executeUserOp(address,uint256,bytes,uint8)`           | `0x7bb37428` |
| Safe 4337 `executeUserOpWithErrorString(...)`                    | `0x541d63c8` |

Anything else is rejected. Delegatecall and staticcall are rejected. Safe batches go
through MultiSend as a delegatecall, so they are rejected too. `value > 0` is
rejected unless `ALLOW_NATIVE_VALUE=true`. Deployment is rejected unless
`ALLOW_DEPLOYMENT=true`, and the factory must be listed in `ALLOWED_FACTORIES` when
that list is set.

## Frontend

Point permissionless.js at the proxy — no API key, no policy ID. `fetchFn` reads the
current session token on every call.

```ts
import { http } from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { createSmartAccountClient } from 'permissionless';
import { createPimlicoClient } from 'permissionless/clients/pimlico';

const transport = http(`${PROXY_ORIGIN}/rpc/${chain.id}`, {
  fetchFn: (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${getSessionToken()}` },
    }),
});

const pimlicoClient = createPimlicoClient({
  transport,
  entryPoint: { address: entryPoint07Address, version: '0.7' },
});

const smartAccountClient = createSmartAccountClient({
  account,
  chain,
  bundlerTransport: transport,
  paymaster: pimlicoClient, // the proxy injects the policy
  userOperation: {
    estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
  },
});
```

The account type you use must have a decoder in `src/callPolicy.ts`. A new account
type needs a new decoder before it will work.

## Deploy

A single stateless container or Node service behind HTTPS, with `TRUST_PROXY=true`
(the default is `false`: an instance reachable directly must not believe
`X-Forwarded-For`).
Secrets in the platform's secret store, never in the image, never in `.env` on the
image.

Only one instance until rate limiting moves somewhere shared: the limiter is an
in-process `Map`.

### Docker

```bash
docker compose up -d --build
docker compose logs -f
```

`.env` is the only file you have to create, and it is the same file the bare-metal
path uses: Compose reads it with `env_file`, and nothing from it is baked into the
image. The container runs as the non-root `node` user with a read-only root
filesystem, `node dist/index.js` is PID 1 so SIGTERM reaches the process directly,
and Docker's stop grace period is 25 s against the 20 s forced exit in
`src/index.ts`.

The port is published on the loopback interface only, `127.0.0.1:2004`, because
nginx on the host is the public edge. Both sides read `PORT` from `.env`, which
ships as `2004`, so the published port and the port the service listens on cannot
drift apart. Set `TRUST_PROXY=true` in `.env` for the same reason.

### Nginx in front

```nginx
server {
    server_name pimlico.transport-union.dev;

    client_max_body_size 300k;      # the proxy caps at 256 KB and answers 413 itself

    location / {
        proxy_pass http://127.0.0.1:2004;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # TRUST_PROXY=true reads this
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 20s;                          # proxy's upstream timeout is 15s
    }
}
```

Keep `CORS_ORIGINS` in sync with the frontend origins actually allowed to call it.

## Known limits

- One sponsorship policy for all chains.
- Rate limits are per instance, per process.
- No Safe batching. EIP-7702 user operations are refused outright: an
  authorization sets the sender's code to a delegate of the client's choosing, which
  would make the `execute` wrapper in `callData` and the allowlist advisory.
- The `Origin` gate only gates browsers. Any script can omit the header and call
  directly, so the JWT is the real gate; CORS is defence in depth.
- Selector-level checks only: arguments such as amounts and recipients are not
  inspected, so an allowed selector can still be called with any arguments. Keep the
  permissioned selector set narrow.
- A Pimlico dashboard policy (chain allowlist, global cap, per-user cap, spend
  alerts) is the second layer, not a substitute for the allowlist here.
