# Gateway Keepalive / Warmup — Current-State Map

**Date:** 2026-08-31
**Repo:** /home/joera/code/s2s (@ main)
**Mode:** READ-ONLY exploration — no code modified.
**Purpose:** Design input for a "gateway keepalive / warmup" service that periodically
requests the root CID of published sites from as many public IPFS gateways as possible
(public gateways evict content from cache unless probed). This maps the current state
with file:line citations across the 5 requested areas.

Prior probes referenced:
- /home/joera/code/s2s-gateway-probe/REPORT.md (data_gateway = ipfs.transport-union.dev; SLOW-not-dead)
- /home/joera/code/s2s-live-cid/REPORT.md (lit_action_update record read empty)

---

## 1. PUBLISHING FLOW — where the root CID is computed / stored

The canonical publish path is the `evm-update` Lit action:
`protocol/actions/src/update/main.ts`.

**Where the root CID is produced (inside the Lit action, against the remote Kubo `data_gateway`):**
- `update/main.ts:98-109` — reads the **previous** on-chain `contenthash_wrapped` via
  `getText(node, 'contenthash_wrapped')` on the ENS Records module (`RECORDS_CONTRACT_ABI`,
  `update/main.ts:44-47`).
- `update/main.ts:109-140` — builds a temp MFS tree on the Kubo gateway:
  - if a previous root exists and not a reset: `files/cp /ipfs/<prevCid> → /temp-<ts>`
    (the *cp-root* flow), `TIMEOUTS.cpRoot = 60_000` (`update/main.ts:25-34`; raised from 10s — see
    IMPLEMENTATION.md / gateway-probe REPORT).
  - else: `files/mkdir /temp-<ts>` (`update/main.ts:126-129`).
- `update/main.ts:142-199` — cp delta jobs (each page's html CID → `/<path>/index.html`), with
  provenance verify + stat/rm/cp (the MFS cp per-file flow).
- `update/main.ts:265+` — copies `config.assetsCid` into `/assets`.
- `update/main.ts:296-302` — **NEW ROOT CID = `files/stat /temp-<ts>` → `.Hash`**; then
  `pin/add <root>` (`update/main.ts:304`).
- `update/main.ts:314-336` — `evmWrite setText(node, 'contenthash_wrapped', toHexString(newRootCid))`
  on-chain. **The canonical root CID ends up ON-CHAIN as the ENS text record
  `contenthash_wrapped` on the publication node**, stored as an EIP-1577 ipfs-ns contenthash
  envelope (`0xe3 0x01 + CID bytes`).
- `update/main.ts:344-346` — cleanup: `files/rm /temp-<ts>`. The transient MFS path is
  destroyed; the durable record of the root is the on-chain `contenthash_wrapped`.

**Encoding helpers:**
- `toHexString` (evm.ts) ↔ `encodeContenthashWrapped`/`decodeContenthashWrapped`:
  `shared/src/ipfs/contenthash.ts:258-262` (encode) and `decodeContenthashWrapped` →
  `contenthashToIPFS` (`protocol/actions/src/libs/ipfs.factory.ts:245-253`, `update/main.ts:7,117`).
  A malformed/legacy contenthash decodes to invalid CIDs (the GARBAGE case flagged in the
  gateway-probe REPORT).

**Config module / MFS root:**
- `getConfig` reads the on-chain `config` record → configCid → IPFS JSON config (`mapping`,
  `assetsCid`): `protocol/actions/src/render/config.ctrl.ts:6-14`.
- The Kubo MFS **root** itself lives only transiently per publish in `/temp-*` (cleaned up);
  cumulative MFS root on the node is large (~798 MB) but is NOT the durable root-of-record —
  the on-chain `contenthash_wrapped` is.

**Update path summary:** root CID is *computed* from MFS `stat` during the publish, *stored*
durably as `contenthash_wrapped` on-chain (ENS text record), with Pinata + Filecoin as
durability backstops (see §3).

---

## 2. GATEWAY CONSUMPTION — public gateways, .eth.link/.dweb.link/ipfs.io, URL building

**The on-chain gateway record:**
- `data_gateway` record = `https://ipfs.transport-union.dev` (a Kubo node). Read by
  `protocol/actions/src/libs/protocol.factory.ts:20-23` (`getRecords(['data_gateway', ...])`) and
  by `shared/src/protocol/index.ts` `getProtocolInfo` (`:44-66`, `getRecords :76-110`).
  `getProtocolControllerAndModules` (`shared/src/protocol/index.ts:113-224`) does the ENS walk:
  NameWrapper → ownerOf(namehash) → parentDomainController → getModulesPaginated → module named
  `S2S Records Module`.
- `protocol/actions/src/libs/ens.factory.ts:173` `getDomainOwnerAndModules` is the action-side twin.

**Kubo RPC (write/fetch) URL building — all append `/api/v0/...` to the gateway:**
- `protocol/actions/src/libs/ipfs.factory.ts`: `getPublicationConfig` `/api/v0/cat`
  (`:18-39`), `uploadFile` `/api/v0/add` (`:41-58`), `catFile` `/api/v0/cat` (`:60-76`),
  `getDag` `/api/v0/dag/get` (`:78-91`), `putDag` `/api/v0/dag/put` (`:154-180`),
  `createUnixFSFromCbor` mkdir/cp/stat/pin/rm (`:221-278`).
- `shared/src/ipfs/index.ts` `S2SIPFSMethods.kuboPost` (`:39-55`) + `MFS_TIMEOUTS`
  (mkdir/stat/ls 5s, cp/pinAdd 60s: `:9-17`).

**Serving-URL forms (how an ENS name becomes a URL):**
- **Preview (origin-per-CID subdomain gateway):** `https://<CIDv1-base32>.preview.transport-union.dev/`
  built in `neutralpress/src/render/render.helper.ts` (`toPreviewLabel`, `:159-160`; helper at
  `shared/src/ipfs/contenthash.ts:262-273`). Origin-per-CID is required because any path-prefixing
  gateway (`/ipfs/<cid>/…`) breaks root-absolute `/assets/...` (SPEC-00-system-contract.md:218,339).
- **Prod (DNSLink / ENS):** `https://<publication>.link/` where `<publication>` is the full ENS
  name, e.g. `https://s3nl.soul2soul.eth.link/` (`render.helper.ts:177-185`). Also `pagePathFor`
  (`render.helper.ts:52-74`) strips a leading `/ipfs/<cid>` because the `.link` DNSLink gateway
  serves the site root at the domain itself.
- **Path gateway (ipfs.io):** `gatewayUrl(cid) = https://ipfs.io/ipfs/<cid>` in safe-app's Website
  Tree tab (`brain/reviews/review-tree-tab-cid-pr71-real-2026-08-31.md:20`).
- `.limo` / `.link` references and behavior are documented in research — see
  `brain/research/2026-08-08-publish-availability-time-gaps.md` (`:60-70`, `:126`, `:315-317`) and
  `brain/handoffs/handoff-publish-availability-measurement.md` (`:39-52`): **`.eth.link` and `.limo`
  are the SAME operator (eth.limo); `.limo` caches resolved contenthash with `max-age=300` (5 min)**,
  and the publication form `*.soul2soul.eth.limo` (4-label) had a suspected TLS issue.

**Existing list of public gateways:** there is **NO** centralized list of public gateways in code.
References are scattered: `ipfs.io` (safe-app), `.link`/`.limo` (neutralpress + research), the
Kubo `data_gateway` (on-chain), and the preview subdomain gateway. "From as many public gateways
as possible" is a **greenfield** list — nothing enumerable today.

**serverless runner gateway:**
- `protocol/serverless/server.ts:7` `IPFS_GATEWAY` default `https://neutralpress.mypinata.cloud`
  (fetch actions from `${IPFS_GATEWAY}/ipfs/<clean>` `:80-91`); the built `server.js:8` defaults to
  `https://ipfs.transport-union.dev` (and repo `.env` `IPFS_URL=` matches). The action runtime path
  itself uses the on-chain `data_gateway`.

---

## 3. EXISTING KEEPALIVE / WARM / PIN / UPTIME / PROBE / CRON / HEARTBEAT

**Grep verdict (keepalive | keep-alive | warm | heartbeat | cron | uptime | probe):** there is
**NO gateway keepalive/warmup service, no cron, no scheduled warm loop, no heartbeat** anywhere in
the repo. Public-gateway warming is **completely absent** — this is the gap the new service fills.

What DOES exist (adjacent mechanisms, none of which warm public gateways):
- **Kubo pin on publish** — `pin/add <root>` on the data_gateway after each update
  (`update/main.ts:304`; `shared/src/ipfs/index.ts` `mfsFlush`/pin). Pins on the self-hosted node do
  NOT warm third-party public gateways.
- **Pinata pin + Filecoin upload** (durability backstops) — `neutralpress/src/render/render.helper.ts:128-145`
  (`pinCidFromRemote(..., 'https://ipfs.transport-union.dev', ...)` + `filecoinUploadBackground`).
  These are storage durability, not gateway warming.
- **Serverless `/health` uptime endpoint** — `protocol/serverless/server.ts:128`, `server.js:96`
  (`{status:"ok", uptime: process.uptime()}`). Self-uptime only; does not probe gateways.
- **Filecoin provider probe script** — `protocol/scripts/filecoin/probe-providers.ts` is the closest
  existing "probe a set of endpoints" pattern (CORS/ALPN loop over PDP providers). Structurally the
  best template for a gateway-probe script, but it targets Filecoin providers, not IPFS gateways.
- **`maintain-cache` Lit action** — `protocol/actions/src/maintain-cache/main.ts` keeps the per-
  publication **content archive** pointer (`content_cache_<publication>`) warm on the Kubo node.
  It is cache-warming for the publication's *content archive*, fired by the orchestrator after
  render (`shared/src/rendering/sequence.ts:346-359`), NOT a periodic public-gateway keepalive.
- **Design/analysis of the gateway-cache weakness** (no implementation) — `brain/research/2026-08-08-publish-availability-time-gaps.md`
  §4-5 names the SPOFs: one CCIP gateway, one Kubo node for fresh roots, **one third-party gateway
  (`.limo`)** with a ~5 min cache, and proposes (as design space, not built) a durability/readiness
  gate and multi-gateway read path. The keepalive service is the missing runtime for the
  multi-gateway leg.

---

## 4. DATA SOURCES — how to enumerate "which sites to warm" (ENS names / root CIDs)

**Canonical root-of-record per site:** the ENS text record `contenthash_wrapped` on the publication
node. Read pattern:
- `update/main.ts:98-109` — `getText(namehash(publication), 'contenthash_wrapped')` on
  `protocolInfo.ensRecords` (Base L2). This is the exact read a keepalive service would replicate to
  fetch each site's root CID (then decode via `contenthashToIPFS`, `ipfs.factory.ts:245-253`).
- Records module ABI: `protocol/contracts/generated/abis/S2SRecordsModule.ts`
  (`getRecords(string[])`); runtime readers: `shared/src/protocol/index.ts`
  `getProtocolInfo`/`getRecords`/`getProtocolControllerAndModules` (`:44-224`) and
  `protocol/actions/src/libs/protocol.factory.ts` (`:20-41`).

**Gateway for reading CIDs:** the same `data_gateway` record (§2) gives one Kubo node; a keepalive
service would instead re-request each root across a *list of public gateways* (new list, §2).

**Per-publication secondary records (useful auxiliary data, not the serving root):**
- `content_cache_<publication>` archive pointer — `maintain-cache/main.ts:96-113`,
  `render/main.ts:99-109` (read + `decodeArchiveCid`).
- `config` record → configCid (mapping + `assetsCid`) — `render/config.ctrl.ts:6-14`.

**Site registry / enumerating the publication set:** there is **no simple "list all sites" API**.
Publications are ENS subdomains of `soul2soul.eth` created via subdomain registration; contracts:
- `protocol/contracts/contracts/ENSOpenSubdomainRegistry.sol` (`setSubnodeOwner`, `:10`, `:120-129`)
- `S2SPublicationModule.sol` / `S2SPublicationModuleV2.sol` + `*Factory.sol` — the
  `publication_factory` / `records_factory` on-chain records point at these.
Enumeration today would require either ENS subdomain enumeration or maintaining an explicit list
(the keepalive service therefore needs a *registry of ENS names to warm*, or derive them from
subdomain enumeration — neither exists readymade). The `.s2s-orchestrator/registry.json` is dev-task
metadata (build/review orchestration), NOT a runtime site registry and not appropriate as the warm list.

---

## 5. WIRING — where a periodic loop would live; workspaces; script wiring

**pnpm workspaces** (`pnpm-workspace.yaml`): `0xobsidian`, `neutralpress`, `protocol`, `shared`,
`safe-app`. Root `package.json` `"test": "pnpm -r test"`, `"shared": "pnpm -C shared run build"`.

**Script wiring convention (the established pattern for one-off/operational scripts):**
- Root `package.json` runs tsx scripts with dotenv: e.g. `"deploy-group": "tsx --require dotenv/config protocol/scripts/lit/deploy-group.ts"`, `"update-protocol": "tsx --require dotenv/config protocol/scripts/lit/update-protocol.ts"` (root package.json scripts block).
- `protocol/package.json` registers operational scripts: `filecoin:setup-key`, `filecoin:probe`-style
  (via `filecoin:*` entries `:12-18`), `protocol:update` → `tsx ./scripts/lit/update-protocol.ts`.
- Operational scripts live under `protocol/scripts/{lit,filecoin,ens}/` and run with `tsx
  --require dotenv/config` against the repo `.env` (RPC keys, PINATA_JWT, IPFS_URL). The Filecoin
  probe (`protocol/scripts/filecoin/probe-providers.ts`) is the reference example of a "loop over
  endpoints and report" script in this repo.

**Where a periodic keepalive loop would live (recommendation):**
- **Best fit: a standalone script under `protocol/scripts/` (e.g. `protocol/scripts/gateway/keepalive.ts`
  or `protocol/scripts/lit/keepalive.ts`)**, wired as a new `protocol/package.json` script
  (`"gateway:keepalive": "tsx --require dotenv/config ./scripts/gateway/keepalive.ts"`) following the
  `filecoin:*` precedent. The repo has **no scheduler/cron/daemon infra** — a periodic loop must
  either be driven by an external cron (calling the script on an interval) or run as a long-lived
  daemon (e.g. a `setInterval` loop). `/etc/cron` / CI / external scheduler is the natural driver;
  nothing in-repo schedules tasks today.
- **serverless runner** (`protocol/serverless/server.ts`, Hono/Bun/Docker, port 4269) is a
  request-runner for Lit-action previews, not a scheduler — it would only host a keepalive if given
  a timer route, which does not exist.
- **safe-app** (`s2s-records-safe-app`, Vite) is the management UI; a keepalive would be an awkward
  home (browser-lived) but it DOES contain the reference `gatewayUrl(cid) = https://ipfs.io/ipfs/<cid>`
  and the Website-Tree root-CID display useful for a warm target list.

**Testing:** vitest, node env, `pool: 'forks'` (`vitest.config.base.ts`); per-package
`vitest run --reporter=verbose` (protocol/shared/0xobsidian `test` scripts); shared adds
`setupFiles` (`shared/vitest.config.ts`). A keepalive service would add
`protocol/scripts/gateway/keepalive.test.ts` targeting `protocol`'s vitest config.

---

## Summary table (file:line anchors)

| Concern | Location |
|---|---|
| Root CID computed (MFS stat) + on-chain write | `protocol/actions/src/update/main.ts:296-336` |
| cp-root / mkdir MFS branch | `update/main.ts:109-140` (cpRoot timeout `:25-34`) |
| Contenthash encode/decode helpers | `shared/src/ipfs/contenthash.ts:258-273`; `ipfs.factory.ts:245-253` |
| On-chain records read (gateway+actions) | `protocol/actions/src/libs/protocol.factory.ts:20-41`; `shared/src/protocol/index.ts:44-224` |
| Kubo RPC URL building | `shared/src/ipfs/index.ts:39-55`; `ipfs.factory.ts:*` |
| Serving URLs (preview / .link / ipfs.io) | `neutralpress/src/render/render.helper.ts:157-185`; safe-app gatewayUrl |
| .limo/.link single operator + 5min cache | `brain/research/2026-08-08-publish-availability-time-gaps.md:60-70,315` |
| No keepalive/warm/cron exists | grep — absent |
| Closest probe template | `protocol/scripts/filecoin/probe-providers.ts` |
| Site registry / factories | `contracts/contracts/{ENSOpenSubdomainRegistry,S2SPublicationModule(Factory),S2SPublicationModuleV2(Factory)}.sol` |
| Script wiring pattern | root `package.json` scripts + `protocol/package.json:12-18` |
| Workspaces / tests | `pnpm-workspace.yaml`; `vitest.config.base.ts` |

## OPEN GAPS FOR THE NEW SERVICE
1. **No public-gateway list** anywhere — must be authored (ipfs.io, .link/.limo, dweb.link,
   cloudflare-ipfs, pinata, etc.), with awareness that `.link`/`.limo` are one operator.
2. **No site enumeration API** — need an ENS-name list (or subdomain enumeration) to know which
   roots to warm; roots come from on-chain `contenthash_wrapped` reads.
3. **No scheduler** — a periodic loop needs external cron or an in-script timer; none exists.
4. **Origin-per-CID constraint** — warm requests must use the correct form per gateway
   (subdomain/preview vs path `/ipfs/<cid>` vs DNSLink `name.link`), since root-absolute `/assets`
   breaks path-prefixed gateways.
