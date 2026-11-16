/**
 * The two module kinds `ens.factory` derives, loaded with the real `ethers`.
 *
 * `ens.factory.ts` derives PUBLICATION_KIND / RECORDS_KIND with `ethers.utils.id`
 * at module load from the same strings `shared/src/protocol/constants.ts` hashes,
 * which makes the two values comparable but does not keep them equal: nothing
 * checks the pair at runtime. Every other test stubs the global `ethers`, so a
 * stubbed `id` would agree with a stubbed kind and a divergence would pass; this
 * file is the one place the real library runs. It installs the
 * real `ethers` as `globalThis.ethers` and dynamic-imports `ens.factory`, so the
 * assertions read the module's own values — not strings retyped here — and pin
 * them against the shared constants and their hex. A mutated literal in
 * `ens.factory.ts` fails this file.
 *
 * No `vi.mock`: the module under test is the real one, and its `./evm` import
 * costs nothing here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as ethers from 'ethers5';
// The package entry is the specifier src/press imports at runtime, so this pins
// the built constant. The press suite already assumes `src/shared` was built
// before it runs.
import {
  S2S_MODULE_KIND_PUBLICATION,
  S2S_MODULE_KIND_RECORDS,
} from '@s2s/soul2soul-shared/protocol';

const PUBLICATION_HEX = '0x93cd3ffe1e9b7c92722da085a6b913d81fbc5e78f3580dc68ad71939359d0edc';
const RECORDS_HEX = '0x32af023b4fa285854135acd8d8f76ae902589e07e53598d9ded061f3398448bf';

let kinds: { PUBLICATION_KIND: string; RECORDS_KIND: string };

beforeAll(async () => {
  // `ens.factory` computes both kinds at module load from the runtime global.
  (globalThis as unknown as { ethers: unknown }).ethers = ethers;
  kinds = await import('./ens.factory');
});

describe('module kinds — the derivation and the published constants', () => {
  it('derives S2S_MODULE_KIND_PUBLICATION from s2s.module.publication', () => {
    expect(kinds.PUBLICATION_KIND).toBe(S2S_MODULE_KIND_PUBLICATION);
    expect(kinds.PUBLICATION_KIND).toBe(PUBLICATION_HEX);
    expect(S2S_MODULE_KIND_PUBLICATION).toBe(PUBLICATION_HEX);
  });

  it('derives S2S_MODULE_KIND_RECORDS from s2s.module.records', () => {
    expect(kinds.RECORDS_KIND).toBe(S2S_MODULE_KIND_RECORDS);
    expect(kinds.RECORDS_KIND).toBe(RECORDS_HEX);
    expect(S2S_MODULE_KIND_RECORDS).toBe(RECORDS_HEX);
  });
});
