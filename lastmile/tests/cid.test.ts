import { describe, it, expect } from "vitest";
import {
  contenthashToCid,
  isIpnsContenthash,
  parseCID,
  encodeContenthashWrapped,
  decodeContenthashWrapped,
} from "../src/cid.js";

const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CH_V1 =
  "0xe30101701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a";
const CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const IPNS =
  "0xe5010170122029f2d17be6139079dc48696d1f582a5aa2a2f1b5f0a8f9c1c1e5a4b3c2d1e0f";

describe("contenthashToCid", () => {
  it("decodes the fixture contenthash to its CIDv1 string", () => {
    expect(contenthashToCid(CH_V1)).toBe(CID_V1);
  });

  it("throws on the empty '0x' contenthash", () => {
    expect(() => contenthashToCid("0x")).toThrow();
  });

  it("throws on the empty-string contenthash", () => {
    expect(() => contenthashToCid("")).toThrow();
  });

  it("throws on an ipns (0xe5) contenthash", () => {
    expect(() => contenthashToCid(IPNS)).toThrow();
  });

  it("throws on non-hex input", () => {
    expect(() => contenthashToCid("0xe3zz")).toThrow();
  });

  it("throws on non-string input", () => {
    expect(() => contenthashToCid(undefined as unknown as string)).toThrow();
  });
});

describe("isIpnsContenthash", () => {
  it("returns true for an 0xe5 ipns contenthash", () => {
    expect(isIpnsContenthash(IPNS)).toBe(true);
  });

  it("returns false for an 0xe3 ipfs contenthash", () => {
    expect(isIpnsContenthash(CH_V1)).toBe(false);
  });

  it("returns false for non-hex input", () => {
    expect(isIpnsContenthash("0xzz")).toBe(false);
  });
});

describe("CIDv0 roundtrip via encode/decode", () => {
  it("round-trips a CIDv0 through encodeContenthashWrapped -> decodeContenthashWrapped", () => {
    const cid = parseCID(CID_V0);
    const hex = encodeContenthashWrapped(cid);
    expect(decodeContenthashWrapped(hex).toString()).toBe(CID_V0);
  });
});
