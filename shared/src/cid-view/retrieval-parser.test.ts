// cid-view retrieval-parser tests — validated against REAL ipfs-check fixtures.
//
// Fixtures: PROBE_TU_NDJSON embeds the 6 raw NDJSON lines of the latest probe
// (probe_tu.ndjson — transport-union kubo reachable). PROBE_HTTP_FILECOIN_ROW_NDJSON
// embeds one row of the older probe (probe_http.json row 7) — two Filecoin SPs
// (ezpdpz-main SP1 + ezpdpz-main2 SP32) serving over HTTP. Expected platforms are
// hand-derived from the raw rows (see per-row comments). Pure — no network.
/* eslint-disable @typescript-eslint/dot-notation -- cid/status map keys are hashes; bracket access mirrors map semantics */
import { describe, it, expect } from 'vitest';
import type { CidEntry, PublicationCidView } from './types';
import type { CidRetrievabilityStatus, RetrievabilitySource } from './retrievability';
import {
  FILECOIN_SP_HOSTS,
  aggregateRetrievability,
  classifyProvider,
  parseBatchNdjson,
  parseRow,
  toCidRetrievabilityStatus,
  type ParsedCidRetrievability,
} from './retrieval-parser';

// REAL fixture — LATEST probe (probe_tu.ndjson, transport-union kubo reachable),
// 6 NDJSON lines: non-array-result row, cache root (pinata+filecoin+kubo), site
// root (filebase+kubo), config CID (pinata+filebase+kubo), oldest deal CID
// (kubo-only dedup case), plus a filecoin-over-HTTP root (curio.akave.xyz).
const PROBE_TU_NDJSON = [
  "{\"cid\":\"QmUg3Hp5tiLqkHQqRUegRjGNt5DbCSPmP9KPAFVMBr2BXuB\",\"ms\":220,\"result\":{\"MutableResolution\":{\"InputPath\":\"/ipns/QmUg3Hp5tiLqkHQqRUegRjGNt5DbCSPmP9KPAFVMBr2BXuB\",\"DiagnosticURL\":\"https://ipns.ipfs.network/#QmUg3Hp5tiLqkHQqRUegRjGNt5DbCSPmP9KPAFVMBr2BXuB\",\"Error\":\"DNSLink lookup for \\\"QmUg3Hp5tiLqkHQqRUegRjGNt5DbCSPmP9KPAFVMBr2BXuB.\\\" failed: could not resolve name: DNSLink lookup could not find a TXT record (https://docs.ipfs.tech/concepts/dnslink/)\",\"IsMutableInput\":true}}}",
  "{\"cid\":\"QmNudJgDecqu1D5jP7xQPGtfAaL7BoGpEFaAPoCCMw5sT7\",\"ms\":12011,\"result\":[{\"ID\":\"QmbXFYQspgaCQEt3se5SbLpYEUsgGgFKb89T9vwh5warS3\",\"ConnectionError\":\"\",\"Addrs\":[\"/dns4/gateway-v1.pinata.cloud/tcp/443/https\"],\"ConnectionMaddrs\":[\"/dns4/gateway-v1.pinata.cloud/tcp/443/https\"],\"DataAvailableOverBitswap\":{\"Enabled\":false,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":true,\"Duration\":66720074,\"Endpoints\":[\"/dns4/gateway-v1.pinata.cloud/tcp/443/https\"],\"Connected\":true,\"Requested\":true,\"Found\":true,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/dns4/gateway-v1.pinata.cloud/tcp/443/https\",\"CandidateAddrs\":[\"/dns4/gateway-v1.pinata.cloud/tcp/443/https\"],\"Error\":\"\",\"CORS\":{\"Enabled\":true,\"Allowed\":true,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"},{\"ID\":\"Qma8ddFEQWEU8ijWvdxXm3nxU7oHsRtCykAaVz8WUYhiKn\",\"ConnectionError\":\"failed to dial: failed to dial Qma8ddFEQWEU8ijWvdxXm3nxU7oHsRtCykAaVz8WUYhiKn: all dials failed\\n  * [/ip4/137.184.243.187/tcp/443/tls/sni/bitswap.pinata.cloud/ws] dial backoff\",\"Addrs\":[\"/dnsaddr/bitswap.pinata.cloud\"],\"ConnectionMaddrs\":null,\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/137.184.243.187/tcp/443/wss\",\"CandidateAddrs\":[\"/dns4/bitswap.pinata.cloud/tcp/443/wss\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"},{\"ID\":\"12D3KooWAyAFoY1LctN9N57W387odSZPPKWifjAT7CFW3M2Ryrnu\",\"ConnectionError\":\"\",\"Addrs\":[\"/dns/curio.akave.xyz/tcp/443/https\"],\"ConnectionMaddrs\":[\"/dns/curio.akave.xyz/tcp/443/https\"],\"DataAvailableOverBitswap\":{\"Enabled\":false,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":true,\"Duration\":120146474,\"Endpoints\":[\"/dns/curio.akave.xyz/tcp/443/https\"],\"Connected\":true,\"Requested\":true,\"Found\":true,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/dns/curio.akave.xyz/tcp/443/https\",\"CandidateAddrs\":[\"/dns/curio.akave.xyz/tcp/443/https\"],\"Error\":\"\",\"CORS\":{\"Enabled\":true,\"Allowed\":true,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"},{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/tcp/4006\",\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/tcp/4001\",\"/ip4/62.166.178.42/udp/64808/quic-v1\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":6195534,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"},{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1\",\"/ip4/62.166.178.42/tcp/4006\",\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/tcp/4001\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":3476218,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"}]}",
  "{\"cid\":\"QmVazokwDShvg5Np8HQeoGCcF4qNefuZJ2ojuexUrVGzM5\",\"ms\":12012,\"result\":[{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/tcp/4001\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/udp/64808/quic-v1\",\"/ip4/62.166.178.42/tcp/4006\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":7964913,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"}]}",
  "{\"cid\":\"bafybeigk7y3jhhxlfslasrahkenicbvqekowwf3sghsarxc5sa2v2qcjhu\",\"ms\":12013,\"result\":[{\"ID\":\"12D3KooWGtYkBAaqJMJEmywMxaCiNP7LCEFUAFiLEBASe232c2VH\",\"ConnectionError\":\"\",\"Addrs\":[\"/dnsaddr/bitswap.filebase.io\"],\"ConnectionMaddrs\":[\"/ip4/57.129.37.40/udp/4001/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":346687679,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/57.129.37.40/tcp/443/wss\",\"CandidateAddrs\":[\"/dns4/bitswap.filebase.io/tcp/443/wss\",\"/dns6/bitswap.filebase.io/tcp/443/wss\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"megaphone\"},{\"ID\":\"12D3KooWGtYkBAaqJMJEmywMxaCiNP7LCEFUAFiLEBASe232c2VH\",\"ConnectionError\":\"\",\"Addrs\":[\"/dnsaddr/bitswap.filebase.io\"],\"ConnectionMaddrs\":[\"/ip4/57.129.37.40/udp/4001/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":290609119,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/57.129.37.40/tcp/443/wss\",\"CandidateAddrs\":[\"/dns6/bitswap.filebase.io/tcp/443/wss\",\"/dns4/bitswap.filebase.io/tcp/443/wss\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"megaphone\"},{\"ID\":\"12D3KooWEVD8HsXX9HhxteZffZG1jwjLcuwPHSRG8h9LPLMSHttP\",\"ConnectionError\":\"\",\"Addrs\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"ConnectionMaddrs\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"DataAvailableOverBitswap\":{\"Enabled\":false,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":true,\"Duration\":0,\"Endpoints\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"Connected\":true,\"Requested\":false,\"Found\":false,\"Error\":\"HTTP endpoint does not support HEAD requests\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/dns/trustless.filebase.io/tcp/443/https\",\"CandidateAddrs\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"Error\":\"\",\"CORS\":{\"Enabled\":true,\"Allowed\":true,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"},{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/10353/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/udp/10353/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/udp/10353/quic-v1\",\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/tcp/4001\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/udp/64808/quic-v1\",\"/ip4/62.166.178.42/tcp/4006\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":3460878,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/10353/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/udp/10353/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"}]}",
  "{\"cid\":\"QmPf6748QRhyZzr63zzzUzdSJFcUVhNU3HZvxjk9KaF4Z6\",\"ms\":12016,\"result\":[{\"ID\":\"QmaSDHYKwuUKTvnsGwqutEZWg5jrpzLJhDHaYRQ9VvrDyZ\",\"ConnectionError\":\"\",\"Addrs\":[\"/dns4/gateway-v3.pinata.cloud/tcp/443/https\"],\"ConnectionMaddrs\":[\"/dns4/gateway-v3.pinata.cloud/tcp/443/https\"],\"DataAvailableOverBitswap\":{\"Enabled\":false,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":true,\"Duration\":51125383,\"Endpoints\":[\"/dns4/gateway-v3.pinata.cloud/tcp/443/https\"],\"Connected\":true,\"Requested\":true,\"Found\":true,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/dns4/gateway-v3.pinata.cloud/tcp/443/https\",\"CandidateAddrs\":[\"/dns4/gateway-v3.pinata.cloud/tcp/443/https\"],\"Error\":\"\",\"CORS\":{\"Enabled\":true,\"Allowed\":true,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"},{\"ID\":\"12D3KooWC8RkG22G2Jp7wdBtMDxG4LLn6d3sDfqtqXBytpyNhXTM\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip6/2604:2dc0:100:567d::1/udp/4002/quic-v1\",\"/ip6/2604:2dc0:100:567d::1/udp/4002/quic-v1/webtransport/certhash/uEiC875gUHaRiVK4n4U-5QYHyO-0WGBoW1Wf91Q3HCk2yhg/certhash/uEiBsVRURwI_WwT3FcZjAbWSJbPZKOQtnJNXpdvyNAG1Q_g\",\"/ip4/15.204.196.125/tcp/4002\",\"/ip4/15.204.196.125/udp/4002/quic-v1\",\"/ip4/15.204.196.125/udp/4002/quic-v1/webtransport/certhash/uEiC875gUHaRiVK4n4U-5QYHyO-0WGBoW1Wf91Q3HCk2yhg/certhash/uEiBsVRURwI_WwT3FcZjAbWSJbPZKOQtnJNXpdvyNAG1Q_g\",\"/ip6/2604:2dc0:100:567d::1/tcp/4002\"],\"ConnectionMaddrs\":[\"/ip4/15.204.196.125/udp/4002/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":216676665,\"Found\":false,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/15.204.196.125/udp/4002/quic-v1/webtransport\",\"CandidateAddrs\":[\"/ip6/2604:2dc0:100:567d::1/udp/4002/quic-v1/webtransport/certhash/uEiC875gUHaRiVK4n4U-5QYHyO-0WGBoW1Wf91Q3HCk2yhg/certhash/uEiBsVRURwI_WwT3FcZjAbWSJbPZKOQtnJNXpdvyNAG1Q_g\",\"/ip4/15.204.196.125/udp/4002/quic-v1/webtransport/certhash/uEiC875gUHaRiVK4n4U-5QYHyO-0WGBoW1Wf91Q3HCk2yhg/certhash/uEiBsVRURwI_WwT3FcZjAbWSJbPZKOQtnJNXpdvyNAG1Q_g\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.0/e9914bb\"},{\"ID\":\"12D3KooWGtYkBAaqJMJEmywMxaCiNP7LCEFUAFiLEBASe232c2VH\",\"ConnectionError\":\"\",\"Addrs\":[\"/dnsaddr/bitswap.filebase.io\"],\"ConnectionMaddrs\":[\"/ip4/57.129.37.40/udp/4001/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":290323863,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/57.129.37.40/tcp/443/wss\",\"CandidateAddrs\":[\"/dns4/bitswap.filebase.io/tcp/443/wss\",\"/dns6/bitswap.filebase.io/tcp/443/wss\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"megaphone\"},{\"ID\":\"12D3KooWGtYkBAaqJMJEmywMxaCiNP7LCEFUAFiLEBASe232c2VH\",\"ConnectionError\":\"\",\"Addrs\":[\"/dnsaddr/bitswap.filebase.io\"],\"ConnectionMaddrs\":[\"/ip4/57.129.37.40/udp/4001/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":293348713,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/57.129.37.40/tcp/443/wss\",\"CandidateAddrs\":[\"/dns6/bitswap.filebase.io/tcp/443/wss\",\"/dns4/bitswap.filebase.io/tcp/443/wss\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"megaphone\"},{\"ID\":\"12D3KooWGtYkBAaqJMJEmywMxaCiNP7LCEFUAFiLEBASe232c2VH\",\"ConnectionError\":\"\",\"Addrs\":[\"/dnsaddr/bitswap.filebase.io\"],\"ConnectionMaddrs\":[\"/ip4/57.129.37.40/udp/4001/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":288984078,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/57.129.37.40/tcp/443/wss\",\"CandidateAddrs\":[\"/dns4/bitswap.filebase.io/tcp/443/wss\",\"/dns6/bitswap.filebase.io/tcp/443/wss\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"megaphone\"},{\"ID\":\"12D3KooWNvyc1NoeTF6SynHuq5exmsMs7YyE1UFp9YhsiYw2px9B\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/15.204.196.124/udp/4002/quic-v1\",\"/ip6/2604:2dc0:100:567c::1/udp/4002/quic-v1/webtransport/certhash/uEiB5rLFli7-hzsB5n1WfFG9uyz31yhgLXsnLQrDIlF0ZHA/certhash/uEiC4IqWvo2XHrkBSxkDElN6WJknZoH3HFcerwTgvtrDR9w\",\"/ip6/2604:2dc0:100:567c::1/tcp/4002\",\"/ip6/2604:2dc0:100:567c::1/udp/4002/quic-v1\",\"/dns4/15-204-196-124.k51qzi5uqu5dl1f4odfcmwb43j0ir149qoz54s9j3y3o8mtvyv96etqv6sm9dq.libp2p.direct/tcp/4002/tls/ws\",\"/dns6/2604-2dc0-100-567c--1.k51qzi5uqu5dl1f4odfcmwb43j0ir149qoz54s9j3y3o8mtvyv96etqv6sm9dq.libp2p.direct/tcp/4002/tls/ws\",\"/ip4/15.204.196.124/tcp/4002\",\"/ip4/15.204.196.124/udp/4002/quic-v1/webtransport/certhash/uEiB5rLFli7-hzsB5n1WfFG9uyz31yhgLXsnLQrDIlF0ZHA/certhash/uEiC4IqWvo2XHrkBSxkDElN6WJknZoH3HFcerwTgvtrDR9w\"],\"ConnectionMaddrs\":[\"/ip4/15.204.196.124/udp/4002/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":203845483,\"Found\":false,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/15.204.196.124/udp/4002/quic-v1/webtransport\",\"CandidateAddrs\":[\"/ip6/2604:2dc0:100:567c::1/udp/4002/quic-v1/webtransport/certhash/uEiB5rLFli7-hzsB5n1WfFG9uyz31yhgLXsnLQrDIlF0ZHA/certhash/uEiC4IqWvo2XHrkBSxkDElN6WJknZoH3HFcerwTgvtrDR9w\",\"/dns4/15-204-196-124.k51qzi5uqu5dl1f4odfcmwb43j0ir149qoz54s9j3y3o8mtvyv96etqv6sm9dq.libp2p.direct/tcp/4002/tls/ws\",\"/dns6/2604-2dc0-100-567c--1.k51qzi5uqu5dl1f4odfcmwb43j0ir149qoz54s9j3y3o8mtvyv96etqv6sm9dq.libp2p.direct/tcp/4002/tls/ws\",\"/ip4/15.204.196.124/udp/4002/quic-v1/webtransport/certhash/uEiB5rLFli7-hzsB5n1WfFG9uyz31yhgLXsnLQrDIlF0ZHA/certhash/uEiC4IqWvo2XHrkBSxkDElN6WJknZoH3HFcerwTgvtrDR9w\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.0/e9914bb\"},{\"ID\":\"12D3KooWNV1fmCMU2ZUaADFe76Sqs8KNyqFZ786bi2jLcfLKsRAn\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip6/2604:2dc0:100:567a::1/udp/4002/quic-v1/webtransport/certhash/uEiCVjqRU0gHyx60si3Fiz1M1NnnyHQYZibjHFkuM7NHAKQ/certhash/uEiA4lapNZjaJ724sBy5xlOZz3crdkZzKzWWrJFP2SdQJ3Q\",\"/ip6/2604:2dc0:100:567a::1/tcp/4002\",\"/ip6/2604:2dc0:100:567a::1/udp/4002/quic-v1\",\"/dns4/15-204-196-122.k51qzi5uqu5dkvga21hmvpizxe7xw618vs42rh4ipb3shrb85dw40ylveigj8n.libp2p.direct/tcp/4002/tls/ws\",\"/dns6/2604-2dc0-100-567a--1.k51qzi5uqu5dkvga21hmvpizxe7xw618vs42rh4ipb3shrb85dw40ylveigj8n.libp2p.direct/tcp/4002/tls/ws\",\"/ip4/15.204.196.122/tcp/4002\",\"/ip4/15.204.196.122/udp/4002/quic-v1\",\"/ip4/15.204.196.122/udp/4002/quic-v1/webtransport/certhash/uEiCVjqRU0gHyx60si3Fiz1M1NnnyHQYZibjHFkuM7NHAKQ/certhash/uEiA4lapNZjaJ724sBy5xlOZz3crdkZzKzWWrJFP2SdQJ3Q\"],\"ConnectionMaddrs\":[\"/ip4/15.204.196.122/udp/4002/quic-v1\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":198752440,\"Found\":false,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/15.204.196.122/udp/4002/quic-v1/webtransport\",\"CandidateAddrs\":[\"/ip6/2604:2dc0:100:567a::1/udp/4002/quic-v1/webtransport/certhash/uEiCVjqRU0gHyx60si3Fiz1M1NnnyHQYZibjHFkuM7NHAKQ/certhash/uEiA4lapNZjaJ724sBy5xlOZz3crdkZzKzWWrJFP2SdQJ3Q\",\"/dns4/15-204-196-122.k51qzi5uqu5dkvga21hmvpizxe7xw618vs42rh4ipb3shrb85dw40ylveigj8n.libp2p.direct/tcp/4002/tls/ws\",\"/dns6/2604-2dc0-100-567a--1.k51qzi5uqu5dkvga21hmvpizxe7xw618vs42rh4ipb3shrb85dw40ylveigj8n.libp2p.direct/tcp/4002/tls/ws\",\"/ip4/15.204.196.122/udp/4002/quic-v1/webtransport/certhash/uEiCVjqRU0gHyx60si3Fiz1M1NnnyHQYZibjHFkuM7NHAKQ/certhash/uEiA4lapNZjaJ724sBy5xlOZz3crdkZzKzWWrJFP2SdQJ3Q\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.0/e9914bb\"},{\"ID\":\"Qmdv6yNikmUWUWXufLJLRNkv6Y9sY5cmgeX5RVWA4WNMz4\",\"ConnectionError\":\"\",\"Addrs\":[\"/dnsaddr/bitswap-v3.pinata.cloud\"],\"ConnectionMaddrs\":[\"/ip4/104.18.35.135/tcp/443/wss\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":184674507,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/ip4/104.18.35.135/tcp/443/wss\",\"CandidateAddrs\":[\"/dns4/bitswap-v3.pinata.cloud/tcp/443/wss\"],\"Error\":\"\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"libp2p/1.8.0\"},{\"ID\":\"12D3KooWEVD8HsXX9HhxteZffZG1jwjLcuwPHSRG8h9LPLMSHttP\",\"ConnectionError\":\"\",\"Addrs\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"ConnectionMaddrs\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"DataAvailableOverBitswap\":{\"Enabled\":false,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":true,\"Duration\":0,\"Endpoints\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"Connected\":true,\"Requested\":false,\"Found\":false,\"Error\":\"HTTP endpoint does not support HEAD requests\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/dns/trustless.filebase.io/tcp/443/https\",\"CandidateAddrs\":[\"/dns/trustless.filebase.io/tcp/443/https\"],\"Error\":\"\",\"CORS\":{\"Enabled\":true,\"Allowed\":true,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"},{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1\",\"/ip4/62.166.178.42/tcp/4006\",\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/tcp/4001\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":4516018,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"},{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1\",\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/tcp/4001\",\"/ip4/62.166.178.42/tcp/4006\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":3798354,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"}]}",
  "{\"cid\":\"QmPQZ7oRjWdoJkB5yw2xw7TU1Nd7wSjxCSShUVDtHXttH8\",\"ms\":12016,\"result\":[{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/udp/64808/quic-v1\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/tcp/4006\",\"/ip4/62.166.178.42/tcp/4001\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":4627312,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"},{\"ID\":\"12D3KooWJWaakKdg1EhYzJrC9DChSDMwdoRjpGopGmMagBfcdE1T\",\"ConnectionError\":\"\",\"Addrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/ip4/62.166.178.42/tcp/4001\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\",\"/ip4/62.166.178.42/udp/64808/quic-v1\",\"/ip4/62.166.178.42/tcp/4006\"],\"ConnectionMaddrs\":[\"/ip4/62.166.178.42/tcp/4001\"],\"DataAvailableOverBitswap\":{\"Enabled\":true,\"Duration\":3451231,\"Found\":true,\"Responded\":true,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":false,\"Duration\":0,\"Endpoints\":null,\"Connected\":false,\"Requested\":false,\"Found\":false,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":false,\"ServiceWorkerCompatible\":false,\"VerifiedAddr\":\"\",\"CandidateAddrs\":[\"/ip4/62.166.178.42/udp/64808/quic-v1/webtransport/certhash/uEiBienU2tya1k77ObcDIml4R1ItT_6oxGV2SAD2j6wD7_A/certhash/uEiChrOF1xKRI6zqrc5Dt6J73bvpXzYEBLbOhhtulj-CFjQ\",\"/dns4/62-166-178-42.k51qzi5uqu5djehhra4xbk1az3bihdp0vv0ew855bl2s7yae32wzihcnh51pj2.libp2p.direct/tcp/4006/tls/ws\",\"/ip4/62.166.178.42/udp/64808/webrtc-direct/certhash/uEiDuHGZfs5m3cnCH13UYXGB8-4xv-b1EzYVCzwhw1JxRXw\"],\"Error\":\"failed to dial: context deadline exceeded\",\"CORS\":{\"Enabled\":false,\"Allowed\":false,\"Error\":\"\"}},\"Source\":\"Amino DHT\",\"AgentVersion\":\"kubo/0.43.1/acc53c0/docker\"}]}",
].join('\n');

// REAL fixture — older probe (probe_http.json row 7): two Filecoin SPs,
// SP1 (main.ezpdpz.net) + SP32 (main2.ezpdpz.net), both serving over HTTP.
const PROBE_HTTP_FILECOIN_ROW_NDJSON = "{\"cid\":\"bafkreia5y7mqtdbsbdij4uxbdkeqgdfzwof4njrfzsx7n3z7mmevlci4f4\",\"ms\":12006,\"result\":[{\"ID\":\"12D3KooWBpfaQbxwGfz6bpuWGK47tX3XvXGX1rkNkyX93a4kxFxU\",\"ConnectionError\":\"\",\"Addrs\":[\"/dns/main.ezpdpz.net/tcp/443/https\"],\"ConnectionMaddrs\":[\"/dns/main.ezpdpz.net/tcp/443/https\"],\"DataAvailableOverBitswap\":{\"Enabled\":false,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":true,\"Duration\":71740344,\"Endpoints\":[\"/dns/main.ezpdpz.net/tcp/443/https\"],\"Connected\":true,\"Requested\":true,\"Found\":true,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/dns/main.ezpdpz.net/tcp/443/https\",\"CandidateAddrs\":[\"/dns/main.ezpdpz.net/tcp/443/https\"],\"Error\":\"\",\"CORS\":{\"Enabled\":true,\"Allowed\":true,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"},{\"ID\":\"12D3KooWRVJPnq94FiotBWbjiDmV1eg3wTCXNX1TTSdTrEiZqS2K\",\"ConnectionError\":\"\",\"Addrs\":[\"/dns/main2.ezpdpz.net/tcp/443/https\"],\"ConnectionMaddrs\":[\"/dns/main2.ezpdpz.net/tcp/443/https\"],\"DataAvailableOverBitswap\":{\"Enabled\":false,\"Duration\":0,\"Found\":false,\"Responded\":false,\"Error\":\"\"},\"DataAvailableOverHTTP\":{\"Enabled\":true,\"Duration\":98878668,\"Endpoints\":[\"/dns/main2.ezpdpz.net/tcp/443/https\"],\"Connected\":true,\"Requested\":true,\"Found\":true,\"Error\":\"\"},\"BrowserCheck\":{\"Enabled\":true,\"WebBrowserCompatible\":true,\"ServiceWorkerCompatible\":true,\"VerifiedAddr\":\"/dns/main2.ezpdpz.net/tcp/443/https\",\"CandidateAddrs\":[\"/dns/main2.ezpdpz.net/tcp/443/https\"],\"Error\":\"\",\"CORS\":{\"Enabled\":true,\"Allowed\":true,\"Error\":\"\"}},\"Source\":\"IPNI\",\"AgentVersion\":\"\"}]}";

const ALL_FALSE: Record<RetrievabilitySource, boolean> = {
  kubo: false,
  pinata: false,
  filebase: false,
  filecoin: false,
};
const KUBO_ONLY: Record<RetrievabilitySource, boolean> = { ...ALL_FALSE, kubo: true };
const KUBO_PINATA: Record<RetrievabilitySource, boolean> = { ...ALL_FALSE, kubo: true, pinata: true };
const KUBO_PINATA_FILECOIN: Record<RetrievabilitySource, boolean> = {
  ...ALL_FALSE,
  kubo: true,
  pinata: true,
  filecoin: true,
};
const KUBO_FILEBASE: Record<RetrievabilitySource, boolean> = { ...ALL_FALSE, kubo: true, filebase: true };
const KUBO_PINATA_FILEBASE: Record<RetrievabilitySource, boolean> = {
  ...ALL_FALSE,
  kubo: true,
  pinata: true,
  filebase: true,
};
const FILECOIN_ONLY: Record<RetrievabilitySource, boolean> = { ...ALL_FALSE, filecoin: true };

function indexByCid(rows: ParsedCidRetrievability[]): Record<string, ParsedCidRetrievability> {
  const map: Record<string, ParsedCidRetrievability> = {};
  for (const row of rows) {
    if (row.cid !== '') map[row.cid] = row;
  }
  return map;
}

/** Build a minimal view from entries (mirrors retrievability.test.ts). */
function makeView(entries: Partial<CidEntry>[]): PublicationCidView {
  return {
    publication: 'pub.eth',
    generatedAt: '2026-10-08T00:00:00.000Z',
    entries: entries as CidEntry[],
    sources: { deals: false, config: true, tree: true, archive: true },
    summary: { total: entries.length, uniqueCids: entries.length, byCategory: {} },
  };
}

/** Full status helper for aggregate tests. */
function status(
  checkedAt: string,
  copies: number,
  sources: Record<RetrievabilitySource, boolean> = ALL_FALSE,
  error?: string,
): CidRetrievabilityStatus {
  const st: CidRetrievabilityStatus = {
    checkedAt,
    copies,
    sources,
    state: error !== undefined ? 'failed' : copies > 0 ? 'ok' : 'no-providers',
  };
  if (error !== undefined) {
    st.lastError = error;
    st.lastErrorAt = checkedAt;
  }
  return st;
}

describe('classifyProvider (pure, hand-built providers)', () => {
  it('pinata HTTP-only provider', () => {
    const p = classifyProvider({
      ID: 'peer-a',
      Addrs: ['/dns4/gateway-v1.pinata.cloud/tcp/443/https'],
      ConnectionMaddrs: ['/dns4/gateway-v1.pinata.cloud/tcp/443/https'],
      DataAvailableOverBitswap: { Found: false },
      DataAvailableOverHTTP: { Found: true },
      Source: 'IPNI',
      AgentVersion: '',
    });
    expect(p.served).toBe(true);
    expect(p.servedHttp).toBe(true);
    expect(p.servedBitswap).toBe(false);
    expect(p.platforms).toEqual(['pinata']);
  });

  it('filebase node serving via BOTH bitswap and HTTP is still one platform', () => {
    const p = classifyProvider({
      ID: 'peer-b',
      Addrs: ['/dnsaddr/bitswap.filebase.io'],
      DataAvailableOverBitswap: { Found: true },
      DataAvailableOverHTTP: { Found: true },
      AgentVersion: 'megaphone',
    });
    expect(p.served).toBe(true);
    expect(p.servedBitswap).toBe(true);
    expect(p.servedHttp).toBe(true);
    expect(p.platforms).toEqual(['filebase']);
  });

  it('kubo agent', () => {
    const p = classifyProvider({
      ID: 'peer-c',
      Addrs: ['/ip4/62.166.178.42/tcp/4001'],
      DataAvailableOverBitswap: { Found: true },
      DataAvailableOverHTTP: { Found: false },
      AgentVersion: 'kubo/0.43.1/acc53c0/docker',
    });
    expect(p.platforms).toEqual(['kubo']);
  });

  it('filecoin by SP host (not by agent)', () => {
    const p = classifyProvider({
      ID: 'peer-d',
      Addrs: ['/dns/main.ezpdpz.net/tcp/443/https'],
      DataAvailableOverHTTP: { Found: true },
      AgentVersion: '',
    });
    expect(p.platforms).toEqual(['filecoin']);
  });

  it('filecoin by SP host: every in-use SP host is recognised (AgentVersion absent)', () => {
    // HTTP-only SPs have no AgentVersion (identify is skipped over HTTP) — the
    // host match is what lights the filecoin dot. FILECOIN_SP_HOSTS must mirror
    // BROWSER_USABLE_PROVIDERS in shared/src/filecoin/index.ts.
    expect(FILECOIN_SP_HOSTS).toHaveLength(8);
    for (const host of FILECOIN_SP_HOSTS) {
      const p = classifyProvider({
        ID: 'peer-sp',
        Addrs: [`/dns/${host}/tcp/443/https`],
        DataAvailableOverHTTP: { Found: true },
        AgentVersion: '',
      });
      expect(p.platforms).toEqual(['filecoin']);
    }
  });

  it('filecoin NOT by an active-but-unused SP host (only in-use SPs count)', () => {
    // pdp.tigerteches.org is an active registry provider but not in the
    // BROWSER_USABLE_PROVIDERS set the app stores to — must NOT be filecoin.
    const p = classifyProvider({
      ID: 'peer-sp',
      Addrs: ['/dns/pdp.tigerteches.org/tcp/5521/https'],
      DataAvailableOverHTTP: { Found: true },
      AgentVersion: '',
    });
    expect(p.platforms).toEqual([]);
  });

  it('filecoin NOT by agent alone (boost) when no Addr is an in-use SP host', () => {
    // AgentVersion is deliberately ignored for filecoin: HTTP-only SPs carry
    // no agent (identify is skipped over HTTP), so an agent match would only
    // ever be accidental (e.g. the substring "lotus" inside a hostname).
    const p = classifyProvider({
      ID: 'peer-e',
      Addrs: ['/ip4/1.2.3.4/tcp/4001'],
      DataAvailableOverBitswap: { Found: true },
      AgentVersion: 'boost-v2023.11.28',
    });
    expect(p.platforms).toEqual([]);
  });

  it('unserved provider: served false and contributes nothing to a verdict', () => {
    const p = classifyProvider({
      ID: 'peer-f',
      Addrs: ['/dns/trustless.filebase.io/tcp/443/https'],
      DataAvailableOverBitswap: { Found: false },
      DataAvailableOverHTTP: { Found: false },
      AgentVersion: '',
    });
    expect(p.served).toBe(false);
    expect(p.servedBitswap).toBe(false);
    expect(p.servedHttp).toBe(false);
    // Classification still identifies the platform; the verdict layer ignores it.
    expect(p.platforms).toEqual(['filebase']);

    const verdict = parseRow({ cid: 'QmUnserved', result: [p] });
    expect(verdict.sources).toEqual(ALL_FALSE);
    expect(verdict.copies).toBe(0);
    expect(verdict.totalProviders).toBe(1);
    expect(verdict.servingProviders).toBe(0);
  });

  it('one provider may set multiple platform flags', () => {
    const p = classifyProvider({
      ID: 'peer-g',
      Addrs: ['/dns/curio.akave.xyz/tcp/443/https'],
      DataAvailableOverHTTP: { Found: true },
      AgentVersion: 'kubo/0.43.1/acc53c0/docker',
    });
    expect([...p.platforms].sort()).toEqual(['filecoin', 'kubo']);
  });
});

describe('parseRow — real probe_tu.ndjson (latest probe, kubo reachable)', () => {
  const rows = parseBatchNdjson(PROBE_TU_NDJSON);
  const byCid = indexByCid(rows);

  it('parses one row per line (6 rows) in line order', () => {
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.cid)).toEqual([
      'QmUg3Hp5tiLqkHQqRUegRjGNt5DbCSPmP9KPAFVMBr2BXuB',
      'QmNudJgDecqu1D5jP7xQPGtfAaL7BoGpEFaAPoCCMw5sT7',
      'QmVazokwDShvg5Np8HQeoGCcF4qNefuZJ2ojuexUrVGzM5',
      'bafybeigk7y3jhhxlfslasrahkenicbvqekowwf3sghsarxc5sa2v2qcjhu',
      'QmPf6748QRhyZzr63zzzUzdSJFcUVhNU3HZvxjk9KaF4Z6',
      'QmPQZ7oRjWdoJkB5yw2xw7TU1Nd7wSjxCSShUVDtHXttH8',
    ]);
  });

  it('non-array result row (MutableResolution) -> hard error, nothing served', () => {
    const row = byCid['QmUg3Hp5tiLqkHQqRUegRjGNt5DbCSPmP9KPAFVMBr2BXuB'];
    expect(row.ms).toBe(220);
    expect(row.totalProviders).toBe(0);
    expect(row.servingProviders).toBe(0);
    expect(row.sources).toEqual(ALL_FALSE);
    expect(row.copies).toBe(0);
    expect(row.error).toContain('invalid result');
    expect(row.error).toContain('MutableResolution');
  });

  it('QmNudJgD...: pinata (gw1 HTTP) + filecoin (curio.akave.xyz HTTP) + kubo; filebase absent', () => {
    const row = byCid['QmNudJgDecqu1D5jP7xQPGtfAaL7BoGpEFaAPoCCMw5sT7'];
    expect(row.sources).toEqual(KUBO_PINATA_FILECOIN);
    expect(row.copies).toBe(3);
    expect(row.totalProviders).toBe(5);
    expect(row.servingProviders).toBe(4);
  });

  it('QmVazokwD...: only transport-union kubo serves -> kubo only, single copy', () => {
    const row = byCid['QmVazokwDShvg5Np8HQeoGCcF4qNefuZJ2ojuexUrVGzM5'];
    expect(row.sources).toEqual(KUBO_ONLY);
    expect(row.copies).toBe(1);
    expect(row.totalProviders).toBe(1);
    expect(row.servingProviders).toBe(1);
  });

  it('bafybeigk...: filebase (megaphone via bitswap.filebase.io) + kubo; one unserved trustless.filebase.io', () => {
    const row = byCid['bafybeigk7y3jhhxlfslasrahkenicbvqekowwf3sghsarxc5sa2v2qcjhu'];
    expect(row.sources).toEqual(KUBO_FILEBASE);
    expect(row.copies).toBe(2);
    expect(row.totalProviders).toBe(4);
    expect(row.servingProviders).toBe(3);
  });

  it('config CID QmPf6748...: kubo + pinata (gw3 + bitswap-v3) + filebase; no filecoin SP host/agent', () => {
    const row = byCid['QmPf6748QRhyZzr63zzzUzdSJFcUVhNU3HZvxjk9KaF4Z6'];
    expect(row.sources).toEqual(KUBO_PINATA_FILEBASE);
    expect(row.copies).toBe(3);
    expect(row.totalProviders).toBe(11);
    expect(row.servingProviders).toBe(7);
  });

  it('oldest deal QmPQZ7oRjW...: same peer twice -> kubo counted ONCE (per-platform dedup regression)', () => {
    const row = byCid['QmPQZ7oRjWdoJkB5yw2xw7TU1Nd7wSjxCSShUVDtHXttH8'];
    expect(row.sources).toEqual(KUBO_ONLY);
    expect(row.copies).toBe(1);
    expect(row.totalProviders).toBe(2);
    expect(row.servingProviders).toBe(2);
  });
});

describe('parseRow — real probe_http.json row (older shape, filecoin over HTTP)', () => {
  it('two Filecoin SPs (ezpdpz-main SP1 + ezpdpz-main2 SP32) -> filecoin once, 1 copy', () => {
    const [row] = parseBatchNdjson(PROBE_HTTP_FILECOIN_ROW_NDJSON);
    expect(row.cid).toBe('bafkreia5y7mqtdbsbdij4uxbdkeqgdfzwof4njrfzsx7n3z7mmevlci4f4');
    expect(row.sources).toEqual(FILECOIN_ONLY);
    expect(row.copies).toBe(1);
    expect(row.totalProviders).toBe(2);
    expect(row.servingProviders).toBe(2);
  });
});

describe('parseRow — synthetic rows (rule 7 + robustness)', () => {
  it('row-level error with a valid array result is carried but does NOT zero serving', () => {
    const row = parseRow({
      cid: 'QmErrButServed',
      ms: 5,
      error: 'probe partially failed',
      result: [
        {
          ID: 'peer',
          Addrs: ['/ip4/62.166.178.42/tcp/4001'],
          DataAvailableOverBitswap: { Found: true },
          AgentVersion: 'kubo/0.43.1/acc53c0/docker',
        },
      ],
    });
    expect(row.sources).toEqual(KUBO_ONLY);
    expect(row.copies).toBe(1);
    expect(row.error).toBe('probe partially failed');
  });

  it('provider ConnectionError with Found:true still serves (rule 7)', () => {
    const row = parseRow({
      cid: 'QmConnErrServed',
      result: [
        {
          ID: 'peer',
          ConnectionError: 'failed to open stream: context deadline exceeded',
          Addrs: ['/ip4/62.166.178.42/tcp/4001'],
          DataAvailableOverBitswap: { Found: true },
          AgentVersion: 'kubo/0.43.1/acc53c0/docker',
        },
      ],
    });
    expect(row.servingProviders).toBe(1);
    expect(row.copies).toBe(1);
  });

  it('non-object row -> hard error with empty cid', () => {
    const row = parseRow('not-an-object');
    expect(row.cid).toBe('');
    expect(row.sources).toEqual(ALL_FALSE);
    expect(row.copies).toBe(0);
    expect(row.error).toContain('invalid row');
  });

  it('null ConnectionMaddrs (as seen in real data) does not break classification', () => {
    const row = parseRow({
      cid: 'QmNullMaddrs',
      result: [
        {
          ID: 'peer',
          Addrs: ['/dns4/gateway-v1.pinata.cloud/tcp/443/https'],
          ConnectionMaddrs: null,
          DataAvailableOverHTTP: { Found: true },
          Source: 'IPNI',
        },
      ],
    });
    expect(row.sources.pinata).toBe(true);
    expect(row.copies).toBe(1);
  });

  it('non-object provider element ([null]) does not crash and contributes nothing', () => {
    const row = parseRow({ cid: 'QmNullElement', result: [null] });
    expect(row.totalProviders).toBe(1);
    expect(row.servingProviders).toBe(0);
    expect(row.sources).toEqual(ALL_FALSE);
    expect(row.copies).toBe(0);
  });

  it('malformed provider element next to a valid one is skipped, valid still serves', () => {
    const row = parseRow({
      cid: 'QmMixedElements',
      result: [
        null,
        0,
        {
          ID: 'peer',
          Addrs: ['/ip4/62.166.178.42/tcp/4001'],
          DataAvailableOverBitswap: { Found: true },
          AgentVersion: 'kubo/0.43.1/acc53c0/docker',
        },
      ],
    });
    expect(row.totalProviders).toBe(3);
    expect(row.servingProviders).toBe(1);
    expect(row.sources).toEqual(KUBO_ONLY);
    expect(row.copies).toBe(1);
  });

  it('non-array result without a row error gets a synthesized description', () => {
    const row = parseRow({ cid: 'QmBad', result: { MutableResolution: {} } });
    expect(row.copies).toBe(0);
    expect(row.error).toContain('invalid result');
  });
});

describe('parseBatchNdjson — robustness', () => {
  it('skips blank lines, never throws, and flags unparseable lines', () => {
    const rows = parseBatchNdjson('{"cid":"QmA","result":[]}\n\n  \nnot-json\n');
    expect(rows).toHaveLength(2);
    expect(rows[0].cid).toBe('QmA');
    expect(rows[1].error).toBe('invalid JSON line');
  });
});

describe('toCidRetrievabilityStatus', () => {
  const clock = () => new Date('2026-10-09T12:00:00.000Z');

  it('maps copies/sources/error and stamps checkedAt from the injected clock', () => {
    const parsed: ParsedCidRetrievability = {
      cid: 'QmX',
      totalProviders: 3,
      servingProviders: 2,
      sources: KUBO_PINATA,
      copies: 2,
      error: 'partial',
    };
    expect(toCidRetrievabilityStatus(parsed, clock)).toEqual({
      checkedAt: '2026-10-09T12:00:00.000Z',
      copies: 2,
      sources: KUBO_PINATA,
      state: 'failed',
      lastError: 'partial',
      lastErrorAt: '2026-10-09T12:00:00.000Z',
    });
  });

  it('omits error when unset and clones (does not alias) the parsed sources', () => {
    const parsed: ParsedCidRetrievability = {
      cid: 'QmY',
      totalProviders: 1,
      servingProviders: 1,
      sources: KUBO_ONLY,
      copies: 1,
    };
    const st = toCidRetrievabilityStatus(parsed, clock);
    expect(st.state).toBe('ok');
    expect(st.lastError).toBeUndefined();
    expect(st.sources).toEqual(KUBO_ONLY);
    expect(st.sources).not.toBe(parsed.sources);
  });
});

describe('aggregateRetrievability', () => {
  const view = makeView([
    { cid: 'siteA', category: 'site-root', source: 'tree' },
    { cid: 'siteA', category: 'site-file', source: 'tree' },
    { cid: 'cfgB', category: 'config', source: 'config' },
    { cid: 'archC', category: 'archive', source: 'archive' },
    { cid: 'archC', category: 'archive-item', source: 'archive' },
  ]);
  const statuses: Record<string, CidRetrievabilityStatus> = {
    siteA: status('2026-10-09T00:00:00.000Z', 1, KUBO_ONLY), // single copy
    cfgB: status('2026-10-09T00:00:00.000Z', 2, KUBO_PINATA), // multi copy
    // archC is NOT in the map -> unknown == missing.
  };
  const agg = aggregateRetrievability(view, statuses);

  it('top-level counts (entries, not unique cids)', () => {
    expect(agg.total).toBe(5);
    expect(agg.serving).toBe(3); // siteA x2 + cfgB
    expect(agg.singleCopy).toBe(2); // siteA x2
    expect(agg.missing).toBe(2); // archC x2
  });

  it('per-category aggregates', () => {
    expect(agg.byCategory['site-root']).toEqual({ total: 1, serving: 1, singleCopy: 1, missing: 0 });
    expect(agg.byCategory['site-file']).toEqual({ total: 1, serving: 1, singleCopy: 1, missing: 0 });
    expect(agg.byCategory['config']).toEqual({ total: 1, serving: 1, singleCopy: 0, missing: 0 });
    expect(agg.byCategory['archive']).toEqual({ total: 1, serving: 0, singleCopy: 0, missing: 1 });
    expect(agg.byCategory['archive-item']).toEqual({ total: 1, serving: 0, singleCopy: 0, missing: 1 });
  });

  it('actionable cid lists are deduped across entries, first-appearance order', () => {
    expect(agg.missingCids).toEqual(['archC']);
    expect(agg.singleCopyCids).toEqual(['siteA']);
  });

  it('empty view -> zero aggregate', () => {
    expect(aggregateRetrievability(makeView([]), {})).toEqual({
      total: 0,
      serving: 0,
      singleCopy: 0,
      missing: 0,
      byCategory: {},
      missingCids: [],
      singleCopyCids: [],
    });
  });
});
