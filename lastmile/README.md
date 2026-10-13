# lastmile

Soul2Soul **last-mile**: makes a `.com` domain serve only the content its `.eth`
name's ENS contenthash points to — **verified on the server** (Phase 1) instead
of trusting a third-party gateway like `eth.limo`.

## What / why

**Trust chain:** magazine Safe → owns `*.eth` → ENS contenthash → IPFS CID → bytes.

A magazine's `.eth` name carries an ENS **contenthash** (EIP-1577) pointing at an
IPFS CID. The published content lives on IPFS (a Kubo node on the same host).
`lastmile` closes the loop between the two:

- it **resolves the contenthash independently against ≥2 Ethereum RPCs** and only
  proceeds when *all* of them succeed *and* agree (fail-closed),
- it **pins** the freshly resolved CID in the local Kubo node,
- it **atomically repoints nginx** at `{kubo_gateway}/ipfs/<cid>` and validates +
  reloads nginx before recording anything,
- only then does it persist the new CID as "currently served".

The point: a visitor reaching `https://s3ntiment.com` gets bytes whose CID is
whatever the ENS record says right now — verified server-side, with no
intermediary that could serve something else. On **any** doubt (RPC error, CID
disagreement, vanished contenthash, failed pin, rejected nginx include) the
daemon keeps serving the **last good CID** and raises an alert. **Phase 2**
(in-browser verification, Lit signature checks) is explicitly out of scope here.

## Architecture

| Module | Purpose |
| --- | --- |
| `src/config.ts` | `config.toml` loading/validation (strict: ≥2 `rpc_urls`, unknown-key rejection) |
| `src/ens.ts` | multi-RPC ENS contenthash resolution — fail-closed agreement over ≥2 RPCs |
| `src/cid.ts` / `src/ipfs/` | contenthash hex → CID decode (vendored, no external deps) |
| `src/kubo.ts` | Kubo (IPFS) pin/add, pin/rm, pin/ls client |
| `src/state.ts` | `state.json` + legacy `s2s.json` persistence, rollback bookkeeping, atomic writes |
| `src/nginx.ts` | atomic nginx include rewrite + `nginx -t` / reload (fail-closed, self-healing) |
| `src/sync.ts` | **per-magazine sync loop** — the fail-closed core (pin → nginx → persist) |
| `src/index.ts` | CLI: `--config`, `--once`, `--magazine`, daemon mode, graceful shutdown |
| `src/logger.ts` | tiny structured logger (`ISO time LEVEL [lastmile] msg ...`) |
| `lastmile.service` | systemd unit for the daemon |

## Install / build

```sh
npm install
npm run build          # tsc -> dist/
npm test               # vitest (no network, injected services)
npm run typecheck      # tsc --noEmit
```

The build output is `dist/`; deploy it to `/opt/lastmile` (the systemd unit uses
`WorkingDirectory=/opt/lastmile` and `ExecStart=.../dist/index.js`).

## Configuration

Copy `config.example.toml` to `/etc/lastmile/config.toml` and edit. Key fields:

- `rpc_urls` — **required, ≥2 independent Ethereum RPC endpoints.** Resolution
  only proceeds when all succeed AND agree (fail-closed). Two endpoints run by
  different providers is strongly recommended.
- `poll_interval_ms` — how often every magazine is re-resolved (default `60000`).
- `rollback_depth` — how many old CIDs stay pinned as a rollback safety net
  (default `5`, includes the current CID; older ones are unpinned on each update).
- `kubo_api_url` / `kubo_gateway_url` — the Kubo node's API (where we pin) and
  gateway (what nginx proxies to). The gateway should be configured with
  `Gateway.NoFetch = true` so it only serves blocks already on the node.
- `nginx_test_cmd` / `nginx_reload_cmd` — commands run after rewriting an include
  (defaults `sudo -n nginx -t` / `sudo -n nginx -s reload`).
- `alert_cmd` — optional shell command run on every alert; the alert message is
  piped to its stdin. Omit for no alerts.
- `[[magazines]]` — one table per magazine: `domain`, `ens_name` (must end in
  `.eth`), `nginx_include`, `state_dir`, plus optional per-magazine
  `kubo_gateway_url` / `kubo_api_url` overrides.

## systemd install

```sh
sudo cp lastmile.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lastmile
```

The service runs as **root** because it must write `/etc/nginx/lastmile/*.conf`
and run `sudo -n nginx -t` / `sudo -n nginx -s reload` (non-interactive).
`Restart=always` + `RestartSec=10` keep it up across crashes.

## Ops

**Verify what's being served:**

```sh
# The JSON mirror written alongside state.json:
curl https://s3ntiment.com/.well-known/s2s.json

# The ENS name nginx tags every response with:
curl -sI https://s3ntiment.com/ | grep -i x-s2s-ens

# The CID nginx is currently proxying (from the include):
grep s2s_cid /etc/nginx/lastmile/s3ntiment.conf

# Compare with the on-chain contenthash right now:
cat /var/lib/lastmile/s3ntiment/state.json
```

**Rollback semantics:** `state.json` keeps `previousCids` (most-recent-first,
bounded by `rollback_depth - 1`). Every update pins the new CID, keeps the
previous ones pinned for rollback, and unpins only what falls outside the depth.
To roll back, point the ENS contenthash back (or re-point nginx manually) — the
safety-net CIDs are still pinned locally.

**Logs:**

```sh
journalctl -u lastmile -f
```

Every poll logs one line per magazine: `info|warn|error` with
`domain`, `cid`, `blockNumber`, `durationMs`, and `detail` on failures. Alert
messages mirror the `detail` field.

**Fail-closed guarantees:**

- RPC error, CID disagreement, or a vanished contenthash → `error`, keeps serving
  the last good CID, no repoint / no pin / no state write, alert.
- Pin failure or a rejected nginx include (`nginx -t` failed, self-healed) →
  `stalled`, keeps the last good CID, alert.
- A CID is only recorded as served *after* it is actually pinned AND the nginx
  include passed validation. Any doubt keeps the last good CID in place.
- State files are written atomically (tmp + rename), so a crash can never leave a
  half-written record.

**CLI one-shot health check:**

```sh
node dist/index.js --config /etc/lastmile/config.toml --once
# exit 0 iff every magazine is updated/unchanged; non-zero if any error/stalled
```

## Phase 2 (out of scope)

In-browser verification of the trust chain (e.g. Lit Action signature checks) is
explicitly out of scope for Phase 1; server-side verification is what this
component provides.
