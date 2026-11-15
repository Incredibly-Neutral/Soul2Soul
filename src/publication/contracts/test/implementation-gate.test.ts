import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MissingUpgradeGateError,
  UPGRADE_GATE_SELECTOR,
  hasUpgradeGate,
} from '../scripts/implementation-gate.ts';

/**
 * The deploy script's pre-check, on its own: does the implementation answer
 * `factory()`? A wrong PUBLICATION_IMPL_CONTRACT must fail before the factory's
 * deploy gas is spent, and that decision has no chain to be wrong about — only
 * a `call` and what it returns.
 *
 * The client is a stub, not a fixture: `MockCaller.t.sol` is for the cases that
 * need code at an address, and this one needs no address at all. The three
 * outcomes below are the three the script can meet: a getter, no selector, and
 * a getter-shaped call that returns nothing usable.
 */

type Hex = `0x${string}`;

const IMPL: Hex = '0x1111111111111111111111111111111111111111';

/** One ABI-encoded word: an address left-padded to 32 bytes. */
const WORD = `0x${'0'.repeat(24)}${'11'.repeat(20)}` satisfies Hex;

type Call = (args: { to: Hex; data: Hex }) => Promise<{ data?: string } | undefined>;

const client = (call: Call) => ({ call });

describe('hasUpgradeGate', () => {
  it('passes when the implementation returns a full word', async () => {
    let sent: { to: Hex; data: Hex } | undefined;
    const gated = await hasUpgradeGate(
      client(async (args) => {
        sent = args;
        return { data: WORD };
      }),
      IMPL,
    );

    assert.equal(gated, true);
    assert.equal(sent?.to, IMPL);
    assert.equal(sent?.data, UPGRADE_GATE_SELECTOR);
  });

  it('throws MissingUpgradeGateError when the call reverts on the absent selector', async () => {
    const caller = client(async () => {
      throw new Error('execution reverted');
    });

    await assert.rejects(
      () => hasUpgradeGate(caller, IMPL),
      (error: unknown) => {
        assert.ok(error instanceof MissingUpgradeGateError);
        assert.equal(error.implementation, IMPL);
        assert.match(error.message, /does not answer factory\(\)/);
        return true;
      },
    );
  });

  it('fails when the call returns no data', async () => {
    assert.equal(await hasUpgradeGate(client(async () => ({ data: undefined })), IMPL), false);
  });

  it('fails when the call returns short data', async () => {
    assert.equal(await hasUpgradeGate(client(async () => ({ data: '0x11' })), IMPL), false);
  });
});
