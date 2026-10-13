# lastmile

Soul2Soul **last-mile**: makes a `.com` serve only the content its `.eth` name's
ENS contenthash points to — verified on the server (Phase 1), instead of trusting
a third-party gateway.

Trust chain: magazine Safe → owns `*.eth` → ENS contenthash → IPFS CID → bytes.
This daemon resolves the contenthash against ≥2 independent RPCs, pins the CID in
a local Kubo node, and atomically repoints nginx at it. It fails closed: on any
doubt it keeps serving the last good CID.

**Phase 1 (this component):** server-side verification. **Phase 2** (in-browser
verification, Lit signature checks) is out of scope here.

See `brain/specs/` (or the handoff in `brain/handoffs/`) for the design.

## Layout

- `src/config.ts` — `config.toml` loading/validation
- `src/ens.ts` — multi-RPC ENS contenthash resolution (fail-closed)
- `src/cid.ts` — contenthash hex → CID (vendored decode primitives)
- `src/kubo.ts` — Kubo pin/unpin/list client
- `src/state.ts` — state dir + `s2s.json` persistence, rollback bookkeeping
- `src/nginx.ts` — atomic nginx include rewrite + `nginx -t`/reload
- `src/sync.ts` — per-magazine sync loop
- `src/index.ts` — CLI entrypoint
- `lastmile.service` — systemd unit (see README deployment section)
