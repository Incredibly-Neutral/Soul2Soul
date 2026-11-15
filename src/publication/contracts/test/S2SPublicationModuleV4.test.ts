import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeErrorResult, encodeFunctionData, parseAbi } from 'viem';

/**
 * One property: a publication may only upgrade to an implementation the protocol
 * safe set on the factory that deployed it. The publication's own safe picks
 * when, and among what — it no longer picks what.
 *
 * Every upgrade here goes through `MockCaller`, which is both the protocol safe
 * and the publication safe: two roles, one contract, so `msg.sender` is a
 * contract on both paths. The proxies are the factory's own, except in the last
 * case, which needs a proxy that no V4 factory ever touched.
 *
 * Hardhat 3 + `node:test` + viem, same wiring as `S2SPublicationModuleV4Create2Factory.test.ts`.
 */

const { viem } = await network.create();

const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;

const ERRORS = parseAbi([
  'error OnlySafe()',
  'error NoFactory()',
  'error ImplementationNotApproved(address implementation)',
]);

const enc = {
  onlySafe: encodeErrorResult({ abi: ERRORS, errorName: 'OnlySafe' }),
  noFactory: encodeErrorResult({ abi: ERRORS, errorName: 'NoFactory' }),
  notApproved: (implementation: Hex) =>
    encodeErrorResult({ abi: ERRORS, errorName: 'ImplementationNotApproved', args: [implementation] }),
};

/** Every layer of a viem error, as text: revert data can sit in `raw` or `data`. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e = error as any; e; e = e.cause) {
    if (typeof e.raw === 'string') parts.push(e.raw);
    if (typeof e.data === 'string') parts.push(e.data);
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join('\n');
}

async function expectRevert(call: Promise<unknown>, data: Hex, name: string) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${name}, but the call succeeded`);
  const text = errorText(caught);
  assert.ok(
    text.includes(data) || text.includes(name),
    `expected ${name} (${data}), got:\n${text.slice(0, 600)}`,
  );
}

const FACTORY_CALLS = parseAbi([
  'function setImplementation(address _implementation)',
  'function createModule(address safe, address[] _authors, address[] _devs)',
  'function moduleAddress(address safe) view returns (address)',
]);

const MODULE_CALLS = parseAbi([
  'function upgradeTo(address newImplementation)',
  'function upgradeToAndCall(address newImplementation, bytes data)',
  'function factory() view returns (address)',
  'function initialize(address _safe, address[] _authors, address[] _devs)',
]);

/**
 * `upgradeTo` for an upgrade that is expected to land: `upgradeToAndCall` with
 * empty data force-delegatecalls the new implementation with no calldata, and
 * this module has no fallback, so a successful `upgradeToAndCall` needs a real
 * initializer to run. Authorisation is identical on both paths.
 */
const upgradeToData = (implementation: Hex) =>
  encodeFunctionData({ abi: MODULE_CALLS, functionName: 'upgradeTo', args: [implementation] });

const upgradeToAndCallData = (implementation: Hex) =>
  encodeFunctionData({
    abi: MODULE_CALLS,
    functionName: 'upgradeToAndCall',
    args: [implementation, '0x'],
  });

/**
 * implementation (version 1) → MockCaller (protocol safe, and publication safe)
 * → V4 create2 factory → one module for the caller's own safe.
 */
async function deploy() {
  const [deployer, stranger] = await viem.getWalletClients();

  const implementation = await viem.deployContract('S2SPublicationModuleV4');
  const caller = await viem.deployContract('MockCaller');
  const factory = await viem.deployContract('S2SPublicationModuleV4Create2Factory', [
    caller.address,
    implementation.address,
    // No legacy implementations: this suite is about a freshly created module.
    [],
  ]);

  const safe = caller.address;

  // `createModule` is called by the safe it names, which is the caller contract.
  await caller.write.exec([
    factory.address,
    encodeFunctionData({
      abi: FACTORY_CALLS,
      functionName: 'createModule',
      args: [safe, [], []],
    }),
  ]);
  const [module] = await factory.read.getModulesForSafe([safe]);

  return { deployer, stranger, implementation, caller, factory, safe, module: module! };
}

/** Call `target` as the publication safe, through the forwarding fixture. */
async function asSafe(caller: Awaited<ReturnType<typeof deploy>>['caller'], target: Hex, data: Hex) {
  const hash = await caller.write.exec([target, data]);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function upgradeTo(
  d: Awaited<ReturnType<typeof deploy>>,
  implementation: Hex,
): Promise<void> {
  await asSafe(d.caller, d.module, upgradeToData(implementation));
}

/** The module behind the proxy, read through the module's own ABI. */
async function moduleAt(address: Hex) {
  return viem.getContractAt('S2SPublicationModuleV4', address);
}

async function setImplementation(d: Awaited<ReturnType<typeof deploy>>, implementation: Hex) {
  await asSafe(
    d.caller,
    d.factory.address,
    encodeFunctionData({
      abi: FACTORY_CALLS,
      functionName: 'setImplementation',
      args: [implementation],
    }),
  );
}

describe('S2SPublicationModuleV4 — approved upgrades', () => {
  it('records the factory that deployed it, and keeps that answer after an upgrade', async () => {
    const d = await deploy();
    const module = await moduleAt(d.module);

    assert.equal((await module.read.factory()).toLowerCase(), d.factory.address.toLowerCase());

    const next = await viem.deployContract('S2SPublicationModuleV4');
    await setImplementation(d, next.address);
    await upgradeTo(d, next.address);

    assert.equal(
      (await module.read.factory()).toLowerCase(),
      d.factory.address.toLowerCase(),
      'factory is written once, by initialize, and an upgrade does not touch it',
    );
    // The proxy runs the new code, so the constant moves with it.
    assert.equal(await module.read.NAME(), 'S2S Publication Module V4');
  });

  it('lets the safe upgrade to an implementation the factory has set', async () => {
    const d = await deploy();
    const next = await viem.deployContract('S2SPublicationModuleV4');

    await setImplementation(d, next.address);
    await upgradeTo(d, next.address);

    assert.equal(
      await d.factory.read.isApprovedImplementation([next.address]),
      true,
      'setImplementation is what approves an upgrade target',
    );
  });

  it('refuses an implementation the factory never set', async () => {
    const d = await deploy();
    // A real V4 module, so the refusal is about approval and nothing else.
    const unapproved = await viem.deployContract('S2SPublicationModuleV4');

    await expectRevert(
      upgradeTo(d, unapproved.address),
      enc.notApproved(unapproved.address),
      'ImplementationNotApproved',
    );
  });

  it('refuses an upgrade started by anyone but the safe', async () => {
    const d = await deploy();
    const next = await viem.deployContract('S2SPublicationModuleV4');
    await setImplementation(d, next.address);

    // Approved target, wrong caller: the approval check never runs.
    await expectRevert(
      d.stranger.writeContract({
        address: d.module,
        abi: MODULE_CALLS,
        functionName: 'upgradeToAndCall',
        args: [next.address, '0x'],
      }),
      enc.onlySafe,
      'OnlySafe',
    );
  });
});

describe('S2SPublicationModuleV4 — approval is append-only', () => {
  /**
   * The whole point of approving every implementation ever set rather than only
   * the latest: a publication can go back, without asking the protocol safe.
   */
  it('keeps version 1 legal after setImplementation, so a module can roll back', async () => {
    const d = await deploy();
    const next = await viem.deployContract('S2SPublicationModuleV4');

    await setImplementation(d, next.address);
    await upgradeTo(d, next.address);

    assert.equal(await d.factory.read.isApprovedImplementation([d.implementation.address]), true);
    await upgradeTo(d, d.implementation.address);

    assert.equal(
      await d.factory.read.isApprovedImplementation([d.implementation.address]),
      true,
      'the original implementation stays in the set',
    );
  });

  it('makes a new implementation legal for an existing module without moving any address', async () => {
    const d = await deploy();
    const before = await d.factory.read.moduleAddress([d.safe]);
    const next = await viem.deployContract('S2SPublicationModuleV4');

    await setImplementation(d, next.address);

    assert.equal(
      (await d.factory.read.moduleAddress([d.safe])).toLowerCase(),
      before.toLowerCase(),
      'moduleAddress follows the module that exists, not the new prediction',
    );
    assert.equal(before.toLowerCase(), d.module.toLowerCase());
    assert.notEqual(await publicClient.getCode({ address: d.module }), '0x');

    // No create, no redeploy: the same proxy now runs the new implementation.
    await upgradeTo(d, next.address);
    assert.equal((await moduleAt(d.module)).address.toLowerCase(), d.module.toLowerCase());
  });
});

/**
 * `Initializable` (OZ 4.9) refuses a second run with a require string, not a
 * custom error, so the assertion is on the reason. Matching the reason, not just
 * "it threw", is what makes the test fail when `initializer` is removed: an
 * unguarded `initialize` would run a second time and succeed.
 */
const INIT_REASON = 'Initializable: contract is already initialized';

async function expectRevertReason(call: Promise<unknown>, reason: string) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a revert with "${reason}", but the call succeeded`);
  const text = errorText(caught);
  assert.ok(text.includes(reason), `expected "${reason}", got:\n${text.slice(0, 600)}`);
}

describe('S2SPublicationModuleV4 — initialize runs once', () => {
  it('refuses a second initialize on an initialized proxy', async () => {
    const d = await deploy();
    const module = await moduleAt(d.module);
    // The factory called initialize in the same transaction as the CREATE2, so
    // this proxy is initialized before the test touches it.
    assert.equal(
      (await module.read.factory()).toLowerCase(),
      d.factory.address.toLowerCase(),
      'the proxy was initialized by the factory',
    );

    await expectRevertReason(
      d.stranger.writeContract({
        address: d.module,
        abi: MODULE_CALLS,
        functionName: 'initialize',
        args: [d.safe, [], []],
      }),
      INIT_REASON,
    );
  });

  it('refuses initialize on the bare implementation', async () => {
    const [, stranger] = await viem.getWalletClients();
    // Deployed directly, so the constructor's `_disableInitializers()` is the
    // only thing standing between a stranger and the implementation's storage.
    const implementation = await viem.deployContract('S2SPublicationModuleV4');

    await expectRevertReason(
      stranger.writeContract({
        address: implementation.address,
        abi: MODULE_CALLS,
        functionName: 'initialize',
        args: [stranger.account.address, [], []],
      }),
      INIT_REASON,
    );
  });
});

describe('S2SPublicationModuleV4 — modules with no factory', () => {
  /**
   * A proxy deployed before V4 existed has no factory recorded, and there is no
   * setter to give it one. It can still reach V4 — V3's rule is `onlySafe`, so
   * its safe may upgrade it here — and from then on it refuses every upgrade.
   * Fail-closed, not owner-only.
   */
  it('refuses every upgrade once it runs V4 without a factory recorded', async () => {
    const v3 = await viem.deployContract('S2SPublicationModuleV3');
    const caller = await viem.deployContract('MockCaller');

    // The plain-CREATE factory deploys an ERC1967Proxy over V3 and runs
    // `initialize` in the same transaction. Nothing records a factory: V3 has no
    // such field, and this is the deploy path a publication took before V4.
    const v3Factory = await viem.deployContract('S2SPublicationModuleV3Factory', [
      caller.address,
      v3.address,
    ]);
    await caller.write.exec([
      v3Factory.address,
      encodeFunctionData({
        abi: FACTORY_CALLS,
        functionName: 'createModule',
        args: [caller.address, [], []],
      }),
    ]);
    const [proxy] = await v3Factory.read.getModulesForSafe([caller.address]);

    const v4 = await viem.deployContract('S2SPublicationModuleV4');

    // V3's own rule allows this: the caller contract is the safe.
    await asSafe(caller, proxy!, upgradeToData(v4.address));

    const module = await moduleAt(proxy!);
    assert.equal(
      await module.read.factory(),
      '0x0000000000000000000000000000000000000000',
      'no V3 deploy path records a factory, and V4 has no setter to add one',
    );

    const other = await viem.deployContract('S2SPublicationModuleV4');
    await expectRevert(
      asSafe(caller, proxy!, upgradeToAndCallData(other.address)),
      enc.noFactory,
      'NoFactory',
    );
    // Not even back to the implementation it is already running.
    await expectRevert(
      asSafe(caller, proxy!, upgradeToAndCallData(v4.address)),
      enc.noFactory,
      'NoFactory',
    );
  });
});
