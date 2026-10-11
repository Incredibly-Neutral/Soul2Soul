# Lit Protocol action-registry proxy on Base — on-chain forensics + usage

Date: 2026-09-18
Status: Research findings (investigation). Read-only; no code changes.

## TL;DR

- The "action registry" address `0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa` on Base (8453) is an
  **EIP-2535 Diamond proxy**. The earlier "selector-routing proxy / ~194-byte stub" reading is
  consistent with a Diamond: the proxy is a thin stub that routes by 4-byte selector to facet
  implementations.
- **The custom error `0xd4a84737` the user hit on `removeActionFromGroup` genuinely lives in the
  Lit action-logic facets** — specifically in `0x2aa0f31e5d3a4ebbd230dcfa4cc2b1df43c47b46` (and
  also `0x7c251374e8c5e35915f8ba2b0ad494038d6b6dbb`). The proxy stub itself only contains the
  `0x0a82dd73` "no route" revert. So the failing call **reaches Lit logic**; it is not a routing
  failure. The error semantics cannot be decoded (facets are unverified) but the error is real and
  on-chain.
- **Usage on the proxy is very low** on Base: on the order of a handful of events per several-hour
  window (10 logs in ~4h, 6 of them one dominant event signature). Not a high-traffic contract.

## Facts

### 1. Diamond / facet architecture

Blockscout classifies the proxy as EIP-2535 Diamond (`proxy_type: eip2535`) with 7 facets, created
in tx `0x96c64749a5faa972bd6c07b1a2f03c9d26d9c0ce98a02d54274496c5366a8499` (2026-03-27).

The proxy runtime bytecode is ~193 bytes and contains the `0x0a82dd73` revert (no-route), matching
the earlier stub observation. It does **not** contain `0xd4a84737`.

### 2. Facet → selector mapping (decoded from Diamond `facets()` loupe return)

| facet | #selectors | notable selectors |
|---|---|---|
| `0x8694b75c6d3dedfc791e61204659a2ef7c5e1b7` | 1 | `0x1f931c1c` |
| `0xa8d413390b5866888e21e289fc547b00e7fdac70` | 5 | DiamondLoupe: `0xcdffacc6`(facets) `0x52ef6b2c`(facetFunctionSelectors) `0xadfca15e`(facetAddresses) `0x7a0ed627`(facetAddress) `0x01ffc9a7`(supportsInterface) |
| `0x721cb8fa6dfba2ef89579e639c0b33d21f1dc976` | 2 | Ownable: `0x8da5cb5b`(owner) `0xf2fde38b`(transferOwnership) |
| `0xc6912c58034274bb894f570cdc3ab4902cc528c3` | 6 | `0xc001bc79` `0xae8c49a5` `0xfdbfc9b7` `0x52067859` `0xeaca4614` `0x286cf9bb` |
| `0x5698f83d1bb8765adf2fbcb8ea57dddcba1c4c27` | 5 | `0x683f2de8` `0x40b4d453` `0xc12f1a42` `0xca05588a` `0xe6ad2928` |
| `0x7c251374e8c5e35915f8ba2b0ad494038d6b6dbb` | 35 | main action-registry logic; contains `0xd4a84737` |
| `0x2aa0f31e5d3a4ebbd230dcfa4cc2b1df43c47b46` | 21 | action/group logic; contains `0xd4a84737`; holds remove selectors |

### 3. Where `0xd4a84737` lives (bytecode search)

`eth_getCode` + substring search for the error selector across proxy + all 7 facets:

- proxy `0xaaaa...7aa`: `0xd4a84737`=false, `0x0a82dd73`=true (193 B stub)
- `0xa8d41339...` (loupe): no error (2163 B)
- `0x721cb8fa...` (ownable): no (358 B)
- `0xc6912c58...`: no (2017 B)
- `0x5698f83d...`: no (1339 B)
- `0x7c251374...`: **yes** (8894 B)
- `0x2aa0f31e...`: **yes** (13290 B)

So the remove error lives in the unverified action facets, not in the routing stub.

### 4. Remove-function selectors

Candidate signature hashing (keccak) against the routed selector set found:

- `0x5d861c72` = `removeActionFromGroup(uint256,uint256,uint256)` → facet `0x2aa0f31e...`
- `0x40d4411b` = `removeAction(uint256,uint256)` → facet `0x2aa0f31e...`

Both land in the facet that also contains `0xd4a84737`. The exact canonical Lit signature is
unverified (no public ABI), but the remove path is confirmed to terminate in `0x2aa0f31e...`.

### 5. Usage / events on the proxy (Base, 2026-09-18)

`eth_getLogs` over the last ~4–8h (Base publicnode RPC, chunked to respect block-range limits and
rate limits):

- ~10 logs in the window. **Low, sporadic usage** — not a high-traffic contract.
- Dominant event `0x1b7561a9627fa84d82b24435d040afcf609a93e967d51c16204121a6ea55ddea` (6/10):
  - topic1 = 32-byte hash (looks like an IPFS/hashed CID)
  - topic2 = indexed sender address (e.g. `0x3c5777496d57f944aaea08b699a766b8f6e825bb`, `0xaf1120ae948f4d478465b5cdba52415cc5541fea`)
  - data = 32-byte hash
  - strongly resembles an action-registration event (hashed CID + caller + payload)
- Secondary `0x0551519d0004b2acf750c9d3f73faf8def960d093f4aa8005fbaeba14010e1bf` (2/10):
  - topic1 = 32-byte hash, topic2 = uint256 (e.g. `0x2`), data = address
  - resembles a group/action-group membership event (hash, group index, member)
- Other topic0 seen: `0xf2e48806...`, `0x8c94abd0...`
- Observed same-tx co-emission of the two main events (action register + group add in one tx).

The exact event names cannot be recovered without the facet ABI (keccak event signatures are
one-way), but the structure is consistent with action registration and group-membership events.

## Endpoints / RPC used

- Primary RPC: `https://base.publicnode.com` (works for `eth_getLogs`; requires a browser
  `User-Agent`; chunked ranges; tight loops get HTTP 403/rate-limited).
- Other Base RPCs and limits observed: `1rpc.io/base` (50-block log cap), `blastapi` (10-block),
  `drpc` free (10000-block), `meowrpc`/`ankr` (unusable), `base.blockscout.com` (rate-limits).
- `config.litprotocol.com` / `get_node_chain_config` → NXDOMAIN (could not independently re-confirm
  the address from Lit's endpoint at investigation time). On-chain the proxy is live and emitting
  logs, consistent with the address the user obtained.

## Open items / limits

- Facet contracts are unverified — no public source/ABI — so exact function signatures and the
  `0xd4a84737` error text are not recoverable from chain data alone.
- To get the definitive remove semantics, Lit's source (open-source repo / published ABI) is the
  authoritative reference.
- Usage scan was time-boxed (~4–8h window) and rate-limited; a longer-window or multi-address scan
  (PKP NFT, LitToken) would sharpen the cadence/volume picture.
