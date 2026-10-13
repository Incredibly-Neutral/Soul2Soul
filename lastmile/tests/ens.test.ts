import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveContenthash } from "../src/ens.js";

const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CH_V1 =
  "0xe30101701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a";
// A different (valid but bogus) CIDv1 contenthash for the disagreement test.
const CH_OTHER = "0xe30101701220" + "11".repeat(32);

const RPC_A = "https://rpc-a.example";
const RPC_B = "https://rpc-b.example";

interface FakeContenthashResult {
  contenthash: string | null;
  blockNumber?: bigint | null;
}

interface FakeEnsClient {
  getEnsContenthash(args: { name: string }): Promise<FakeContenthashResult>;
}

// Key each fake client by its rpc url, so createPublicClient can hand out a
// scriptable getEnsContenthash per transport.
const { fakeClients, httpMock, createPublicClientMock } = vi.hoisted(() => {
  const fakeClients = new Map<string, FakeEnsClient>();
  const httpMock = vi.fn((url: string, opts?: Record<string, unknown>) => ({ url, opts }));
  const createPublicClientMock = vi.fn(
    (args: { chain?: unknown; transport?: { url: string } }) => {
      const client = fakeClients.get(args.transport?.url ?? "");
      if (!client) {
        throw new Error(`no fake client registered for ${args.transport?.url}`);
      }
      return client;
    },
  );
  return { fakeClients, httpMock, createPublicClientMock };
});

vi.mock("viem", () => ({
  mainnet: {},
  http: httpMock,
  createPublicClient: createPublicClientMock,
}));

vi.mock("viem/chains", () => ({ mainnet: {} }));

type FakeImpl =
  | { kind: "ok"; contenthash: string | null; blockNumber?: bigint | null }
  | { kind: "throw"; error: Error };

function registerClient(url: string, impl: FakeImpl): void {
  fakeClients.set(url, {
    getEnsContenthash: async (_args: { name: string }) => {
      if (impl.kind === "throw") throw impl.error;
      return { contenthash: impl.contenthash, blockNumber: impl.blockNumber ?? null };
    },
  });
}

beforeEach(() => {
  fakeClients.clear();
  httpMock.mockClear();
  createPublicClientMock.mockClear();
});

describe("resolveContenthash", () => {
  it("returns ok when all rpcs agree on the same contenthash", async () => {
    registerClient(RPC_A, { kind: "ok", contenthash: CH_V1, blockNumber: 12345678n });
    registerClient(RPC_B, { kind: "ok", contenthash: CH_V1, blockNumber: 12345678n });

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

  it("returns ok with cid null when every rpc reports no contenthash (unanimous null)", async () => {
    registerClient(RPC_A, { kind: "ok", contenthash: null });
    registerClient(RPC_B, { kind: "ok", contenthash: null });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.contenthashHex).toBeNull();
    expect(out.result.cid).toBeNull();
  });

  it("returns disagreement when rpcs return different contenthashes", async () => {
    registerClient(RPC_A, { kind: "ok", contenthash: CH_V1 });
    registerClient(RPC_B, { kind: "ok", contenthash: CH_OTHER });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("disagreement");
    if (out.status !== "disagreement") return;

    expect(out.results).toHaveLength(2);
    expect(out.detail).toContain("CID disagreement across RPCs");
  });

  it("fails closed (status error) when any rpc throws", async () => {
    registerClient(RPC_A, { kind: "ok", contenthash: CH_V1 });
    registerClient(RPC_B, { kind: "throw", error: new Error("boom") });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("error");
    if (out.status !== "error") return;

    expect(out.detail).toBe(`${RPC_B}: boom`);
    expect(out.results).toHaveLength(1); // only the successful rpc is retained
    expect(out.results[0].rpcUrl).toBe(RPC_A);
  });

  it("treats an empty-string contenthash as null", async () => {
    registerClient(RPC_A, { kind: "ok", contenthash: "" });
    registerClient(RPC_B, { kind: "ok", contenthash: "" });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.contenthashHex).toBeNull();
    expect(out.result.cid).toBeNull();
  });

  it("treats a bare '0x' contenthash as null", async () => {
    registerClient(RPC_A, { kind: "ok", contenthash: "0x" });
    registerClient(RPC_B, { kind: "ok", contenthash: "0x" });

    const out = await resolveContenthash("example.eth", [RPC_A, RPC_B]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;

    expect(out.result.contenthashHex).toBeNull();
    expect(out.result.cid).toBeNull();
  });

  it("passes the default 15s timeout to the http transport", async () => {
    registerClient(RPC_A, { kind: "ok", contenthash: null });

    await resolveContenthash("example.eth", [RPC_A]);
    expect(httpMock).toHaveBeenCalledWith(RPC_A, { timeout: 15_000 });
    expect(createPublicClientMock).toHaveBeenCalledTimes(1);
  });
});
