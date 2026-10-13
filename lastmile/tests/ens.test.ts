import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveContenthash } from "../src/ens.js";

const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CH_V1 =
  "0xe30101701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a";
// A different (valid but bogus) CIDv1 contenthash for the disagreement test.
const CH_OTHER = "0xe30101701220" + "11".repeat(32);
const RESOLVER_ADDR = "0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41";

const RPC_A = "https://rpc-a.example";
const RPC_B = "https://rpc-b.example";

type FakeImpl =
  | { kind: "throw"; error: Error }
  | {
      kind: "ok";
      resolver: string | null;
      contenthash: string | null;
      blockNumber?: bigint | null;
      blockError?: boolean;
    };

interface FakeEnsClient {
  url: string;
  impl: FakeImpl;
  readContract: ReturnType<typeof vi.fn>;
  getBlockNumber: ReturnType<typeof vi.fn>;
}

// Key each fake client by its rpc url, so createPublicClient / getEnsResolver
// can hand out scriptable readContract + getBlockNumber per transport.
const { fakeClients, httpMock, createPublicClientMock, getEnsResolverMock } = vi.hoisted(() => {
  const fakeClients = new Map<string, FakeEnsClient>();
  const httpMock = vi.fn((url: string, opts?: Record<string, unknown>) => ({ url, opts }));
  const createPublicClientMock = vi.fn((args: { chain?: unknown; transport?: { url: string } }) => {
    const client = fakeClients.get(args.transport?.url ?? "");
    if (!client) {
      throw new Error(`no fake client registered for ${args.transport?.url}`);
    }
    return client;
  });
  const getEnsResolverMock = vi.fn(async (client: FakeEnsClient) => {
    const impl = client?.impl;
    if (!impl) throw new Error(`no impl for ${client?.url}`);
    if (impl.kind === "throw") throw impl.error;
    return impl.resolver; // Address | null
  });
  return { fakeClients, httpMock, createPublicClientMock, getEnsResolverMock };
});

vi.mock("viem", () => ({
  mainnet: {},
  http: httpMock,
  createPublicClient: createPublicClientMock,
  namehash: vi.fn((name: string) => ("0x" + name) as `0x${string}`),
}));

vi.mock("viem/chains", () => ({ mainnet: {} }));

vi.mock("viem/ens", () => ({ getEnsResolver: getEnsResolverMock }));

function registerClient(url: string, impl: FakeImpl): void {
  const readContract = vi.fn(async () => {
    if (impl.kind === "throw") throw impl.error;
    return impl.contenthash ?? null;
  });
  const getBlockNumber = vi.fn(async () => {
    if (impl.kind === "throw") throw impl.error;
    if (impl.blockError) throw new Error("block rpc down");
    return impl.blockNumber ?? 0n;
  });
  fakeClients.set(url, { url, impl, readContract, getBlockNumber });
}

function clientFor(url: string): FakeEnsClient {
  const c = fakeClients.get(url);
  if (!c) throw new Error(`no fake client for ${url}`);
  return c;
}

beforeEach(() => {
  fakeClients.clear();
  httpMock.mockClear();
  createPublicClientMock.mockClear();
  getEnsResolverMock.mockClear();
});

describe("resolveContenthash", () => {
  it("returns ok when all rpcs agree on the same contenthash", async () => {
    registerClient(RPC_A, {
      kind: "ok",
      resolver: RESOLVER_ADDR,
      contenthash: CH_V1,
      blockNumber: 12345678n,
    });
    registerClient(RPC_B, {
      kind: "ok",
      resolver: RESOLVER_ADDR,
      contenthash: CH_V1,
      blockNumber: 12345678n,
    });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.ensName).toBe("example.eth");
    expect(out.result.contenthashHex).toBe(CH_V1);
    expect(out.result.cid).toBe(CID_V1);
    expect(out.result.rpcUrl).toBe(RPC_A);
    expect(out.result.blockNumber).toBe(12345678n);
    expect(typeof out.result.timestamp).toBe("number");
  });

  it("returns ok with cid null when every rpc has a resolver but no contenthash (unanimous null)", async () => {
    registerClient(RPC_A, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: null });
    registerClient(RPC_B, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: null });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.contenthashHex).toBeNull();
    expect(out.result.cid).toBeNull();
    // contenthash null -> no getBlockNumber call, blockNumber stays null
    expect(clientFor(RPC_A).getBlockNumber).not.toHaveBeenCalled();
  });

  it("returns ok with cid null when every rpc has no resolver at all", async () => {
    registerClient(RPC_A, { kind: "ok", resolver: null, contenthash: null });
    registerClient(RPC_B, { kind: "ok", resolver: null, contenthash: null });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.contenthashHex).toBeNull();
    expect(out.result.cid).toBeNull();
    // no resolver -> contenthash() is never read
    expect(clientFor(RPC_A).readContract).not.toHaveBeenCalled();
  });

  it("returns disagreement when rpcs return different contenthashes", async () => {
    registerClient(RPC_A, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: CH_V1 });
    registerClient(RPC_B, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: CH_OTHER });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("disagreement");
    if (out.status !== "disagreement") return;

    expect(out.results).toHaveLength(2);
    expect(out.detail).toContain("CID disagreement across RPCs");
  });

  it("fails closed (status error) when any rpc read throws", async () => {
    registerClient(RPC_A, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: CH_V1 });
    registerClient(RPC_B, { kind: "throw", error: new Error("boom") });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("error");
    if (out.status !== "error") return;

    expect(out.detail).toBe(`${RPC_B}: boom`);
    expect(out.results).toHaveLength(1); // only the successful rpc is retained
    expect(out.results[0].rpcUrl).toBe(RPC_A);
  });

  it("treats an empty-string contenthash as null", async () => {
    registerClient(RPC_A, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: "" });
    registerClient(RPC_B, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: "" });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.contenthashHex).toBeNull();
    expect(out.result.cid).toBeNull();
  });

  it("treats a bare '0x' contenthash as null", async () => {
    registerClient(RPC_A, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: "0x" });
    registerClient(RPC_B, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: "0x" });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.contenthashHex).toBeNull();
    expect(out.result.cid).toBeNull();
  });

  it("keeps blockNumber null when getBlockNumber fails (best-effort, no fail-closed)", async () => {
    registerClient(RPC_A, {
      kind: "ok",
      resolver: RESOLVER_ADDR,
      contenthash: CH_V1,
      blockError: true,
    });
    registerClient(RPC_B, {
      kind: "ok",
      resolver: RESOLVER_ADDR,
      contenthash: CH_V1,
      blockError: true,
    });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.cid).toBe(CID_V1);
    expect(out.result.blockNumber).toBeNull();
  });

  it("passes the default 15s timeout to the http transport", async () => {
    registerClient(RPC_A, { kind: "ok", resolver: RESOLVER_ADDR, contenthash: null });

    await resolveContenthash("example.eth", [RPC_A]);
    expect(httpMock).toHaveBeenCalledWith(RPC_A, { timeout: 15_000 });
    expect(createPublicClientMock).toHaveBeenCalledTimes(1);
  });
});
