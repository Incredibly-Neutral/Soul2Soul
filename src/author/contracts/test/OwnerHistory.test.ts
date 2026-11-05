import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  encodeErrorResult,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from 'viem';

/**
 * Owner-history suite: the guard is the only tap Safe 1.4.1 offers on an owner
 * rotation, so these tests drive a `MockSafe` that reproduces the two calls a
 * real Safe makes around an `onlySelf` mutation — `checkTransaction` before,
 * `checkAfterExecution` after. Same style as `DraftsModuleV1.test.ts`:
 * hardhat 3 + `node:test` + viem, and no `@safe-global/*` dependency.
 */

const { viem, networkHelpers } = await network.create();

const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;
type Deployment = Awaited<ReturnType<typeof deployHistory>>;

/**
 * Compare addresses as lowercase hex. Two reasons not to compare checksummed
 * strings: the chain returns its own casing for a decoded `address`, and no
 * test here is about EIP-55.
 */
const addr = (w: { account: { address: Hex } }) => w.account.address.toLowerCase();
const chk = (x: Hex) => x.toLowerCase();

/** Send a write, wait for the receipt, and return the block it landed in. */
async function blockOf(call: Promise<Hex>): Promise<bigint> {
  const hash = await call;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.ok(receipt.blockNumber !== null, 'receipt has no block number');
  return receipt.blockNumber;
}

/**
 * MockSafe(owners) → module implementation → factory → proxy → guard, then
 * install the guard, which is what a real Safe does with its own `setGuard`.
 */
async function deployHistory() {
  const [deployer, first, second, third, stranger] = await viem.getWalletClients();

  const mockSafe = await viem.deployContract('MockSafe', [
    [first.account.address, second.account.address],
  ]);

  const implementation = await viem.deployContract('OwnerHistoryModuleV1');
  const factory = await viem.deployContract('OwnerHistoryModuleV1Factory', [implementation.address]);

  // Era 0 opens in this transaction, so its start block is this one.
  const proxyBlock = await blockOf(factory.write.createModule([mockSafe.address]));
  const proxies = await factory.read.getModulesForSafe([mockSafe.address]);
  const history = await viem.getContractAt('OwnerHistoryModuleV1', proxies[0]!);

  const guard = await viem.deployContract('OwnerHistoryGuard', [mockSafe.address, history.address]);
  await mockSafe.write.setGuard([guard.address]);

  return {
    deployer,
    first,
    second,
    third,
    stranger,
    mockSafe,
    implementation,
    factory,
    history,
    guard,
    proxies,
    proxyBlock,
    safeAddr: chk(mockSafe.address),
  };
}

/**
 * Rotate as the Safe would: mutate through the guard hook, then mine past it.
 *
 * The gas limit is explicit because the guard forwards a *bounded* amount of
 * gas to `sync()` (600k) and keeps a reserve, so the Safe's transaction must
 * have room for the hook. A real Safe proposal sets that limit — and when it is
 * too tight the Safe still succeeds and only the sync is missed (`tight gas`
 * test below). Leaving it unspecified makes viem estimate against a simulation
 * that is itself allowed to skip the hook, so the estimate is self-consistent
 * with "no sync".
 */
async function rotate(d: Deployment, kind: number, a: Hex, b: Hex = zeroAddress) {
  const block = await blockOf(d.mockSafe.write.execOwnerChange([kind, a, b], { gas: 1_200_000n }));
  await networkHelpers.mine(); // so block/timestamp reads take the index path
  return block;
}

/** An `onlySelf` call, made the way a real Safe makes it: by executing it. */
async function execAsSafe(d: Deployment, target: Hex, data: Hex) {
  return blockOf(d.mockSafe.write.execCall([target, data]));
}

const ERROR_ABI = parseAbi([
  'error OnlySafe()',
  'error ZeroAddress()',
  'error SafeCallFailed()',
  'error OnlyDeployer()',
]);

const selectorOf = (name: 'OnlySafe' | 'ZeroAddress' | 'SafeCallFailed' | 'OnlyDeployer') =>
  encodeErrorResult({ abi: ERROR_ABI, errorName: name });

function revertText(error: unknown): string {
  const parts: string[] = [];
  for (let e = error as any; e; e = e.cause) {
    if (typeof e.raw === 'string') parts.push(e.raw);
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join('\n');
}

async function assertReverts(call: Promise<unknown>, expected: string | RegExp) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a revert matching ${expected}, but the call succeeded`);
  const text = revertText(caught);
  if (typeof expected === 'string') {
    assert.ok(text.includes(expected), `expected revert data ${expected}, got:\n${text.slice(0, 500)}`);
  } else {
    assert.match(text, expected);
  }
}

describe('OwnerHistoryModuleV1', () => {
  let d: Deployment;

  beforeEach(async () => {
    d = await deployHistory();
  });

  it('initialize writes era 0 from the Safe and isOwner mirrors the Safe live', async () => {
    assert.equal(await d.history.read.NAME(), 'S2S Owner History Module V1');
    assert.equal(chk(await d.history.read.safe()), d.safeAddr);

    assert.equal(await d.history.read.eraCount(), 1n);
    const era0 = await d.history.read.currentEra();
    assert.equal(era0.startBlock, d.proxyBlock);
    assert.equal(era0.endBlock, 0n);
    assert.equal(era0.endTime, 0n);
    assert.deepEqual([...era0.owners].map((x: string) => x.toLowerCase()), [addr(d.first), addr(d.second)]);

    // The mirrored list of everyone who has ever held the key.
    assert.deepEqual(
      [...(await d.history.read.ownersEver())].map((x: string) => x.toLowerCase()),
      [addr(d.first), addr(d.second)],
    );
    assert.equal(await d.history.read.count(), 2n);
    assert.equal(await d.history.read.lastSyncedBlock(), d.proxyBlock);

    // Live mirror: the Safe's answer, not a cached copy.
    assert.equal(await d.history.read.isOwner([addr(d.first)]), true);
    assert.equal(await d.history.read.isOwner([addr(d.third)]), false);
    assert.equal(await d.history.read.isOwner([zeroAddress]), false);

    // A query at the head answers from the live set.
    const head = await publicClient.getBlockNumber();
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), head]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), head]), false);

    assert.equal(await d.history.read.isOwnerOrWasOwnerAt([addr(d.first), head]), true);
    assert.equal(await d.history.read.isOwnerOrWasOwnerAt([addr(d.third), head]), false);

    // Nobody was an owner in the block before era 0.
    assert.equal(await d.history.read.isOwnerAt([addr(d.first), d.proxyBlock - 1n]), false);
  });

  it('a rotation through the guard hook opens era 1 and closes era 0', async () => {
    const boundary = await rotate(d, 0, addr(d.third));

    assert.equal(await d.history.read.eraCount(), 2n);

    const era0 = await d.history.read.eraAt([0n]);
    assert.equal(era0.startBlock, d.proxyBlock);
    assert.equal(era0.endBlock, boundary);
    assert.ok(era0.endTime > 0n);
    assert.deepEqual([...era0.owners].map((x: string) => x.toLowerCase()), [addr(d.first), addr(d.second)]);

    const era1 = await d.history.read.currentEra();
    assert.equal(era1.startBlock, boundary);
    assert.equal(era1.endBlock, 0n);
    assert.equal(era1.endTime, 0n);
    assert.deepEqual(
      [...era1.owners].map((x: string) => x.toLowerCase()),
      [addr(d.first), addr(d.second), addr(d.third)],
    );

    assert.equal(await d.history.read.count(), 3n);
    assert.deepEqual(
      [...(await d.history.read.ownersEver())].map((x: string) => x.toLowerCase()),
      [addr(d.first), addr(d.second), addr(d.third)],
    );
    assert.equal(await d.history.read.lastSyncedBlock(), boundary);

    // The hook ran during the Safe's own transaction, not in a later one.
    const logs = await publicClient.getContractEvents({
      address: d.history.address,
      abi: d.history.abi,
      fromBlock: 0n,
    });
    const names = logs.map((l: any) => l.eventName);
    assert.ok(names.includes('EraOpened'));
    assert.ok(names.includes('EraClosed'));
    const closed = logs.find((l: any) => l.eventName === 'EraClosed')!;
    assert.equal(closed.args.eraIndex, 0n);
    assert.equal(closed.args.endBlock, boundary);

    const added = logs.filter((l: any) => l.eventName === 'OwnerAdded');
    assert.equal(added.length, 3); // two initial owners + the one that entered
    assert.equal(chk(added.at(-1)!.args.owner!), addr(d.third));
    assert.equal(added.at(-1)!.args.eraIndex, 1n);
  });

  it('eras are half-open: the boundary block belongs to the new set, not the old', async () => {
    const boundary = await rotate(d, 0, addr(d.third));

    // Added owner: present from the boundary block onwards.
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), boundary - 1n]), false);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), boundary]), true);

    // Retained owner: unchanged across the boundary.
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), boundary - 1n]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), boundary]), true);

    // Removal: gone at its own boundary block, present the block before.
    const removal = await rotate(d, 1, addr(d.second));
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), removal - 1n]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), removal]), false);
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), boundary]), true);
    assert.equal(await d.history.read.isOwner([addr(d.second)]), false);

    // Tenures: one closed spell, carved at the exact boundary.
    const [blocks, times] = await d.history.read.tenuresOf([addr(d.second)]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.start, d.proxyBlock);
    assert.equal(blocks[0]!.end, removal);
    assert.equal(times.length, 1);
    assert.equal(times[0]!.end, (await publicClient.getBlock({ blockNumber: removal }))!.timestamp);

    // A re-added owner keeps one entry in `ownersEver` and gains a second tenure.
    const readd = await rotate(d, 0, addr(d.second));
    assert.deepEqual(
      [...(await d.history.read.ownersEver())].map((x: string) => x.toLowerCase()),
      [addr(d.first), addr(d.second), addr(d.third)],
    );
    assert.equal(await d.history.read.count(), 3n);
    assert.equal(await d.history.read.eraCount(), 4n); // era0, +third, -second, +second
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), readd]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), readd - 1n]), false);

    const [readdBlocks] = await d.history.read.tenuresOf([addr(d.second)]);
    assert.equal(readdBlocks.length, 2);
    assert.equal(readdBlocks[1]!.start, readd);
    assert.equal(readdBlocks[1]!.end, 0n);
  });

  it('swapOwner keeps the count and records one era, not two', async () => {
    const boundary = await rotate(d, 2, addr(d.second), addr(d.third));

    const era1 = await d.history.read.currentEra();
    assert.deepEqual([...era1.owners].map((x: string) => x.toLowerCase()), [addr(d.first), addr(d.third)]);
    assert.equal(await d.history.read.eraCount(), 2n);
    assert.equal(await d.history.read.count(), 3n);
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), boundary - 1n]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), boundary]), false);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), boundary]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), boundary - 1n]), false);
  });

  it('wasOwnerAt answers on both sides of the rotation timestamp', async () => {
    await networkHelpers.time.increase(3600);
    const boundary = await rotate(d, 0, addr(d.third));
    const boundaryTime = (await publicClient.getBlock({ blockNumber: boundary }))!.timestamp;

    assert.equal(await d.history.read.wasOwnerAt([addr(d.third), boundaryTime - 1n]), false);
    assert.equal(await d.history.read.wasOwnerAt([addr(d.third), boundaryTime]), true);
    assert.equal(await d.history.read.wasOwnerAt([addr(d.first), boundaryTime - 1n]), true);

    // Tenure timestamps are recorded alongside the block numbers, not derived.
    const [blocks, times] = await d.history.read.tenuresOf([addr(d.third)]);
    assert.equal(blocks[0]!.start, boundary);
    assert.equal(times[0]!.start, boundaryTime);
    assert.equal(times[0]!.end, 0n);

    // At or past the head the answer comes from the live set.
    await networkHelpers.time.increase(60);
    assert.equal(await d.history.read.wasOwnerAt([addr(d.third), boundaryTime]), true);
    assert.equal(await d.history.read.wasOwnerAt([addr(d.first), boundaryTime]), true);
  });

  it('sync is idempotent: unchanged set writes nothing and returns false', async () => {
    const era = await d.history.read.currentEra();

    // eth_call of the write path is the cheapest way to see the return value.
    assert.equal(await d.history.read.sync(), false);
    // And a real transaction changes no state either.
    await d.history.write.sync([], { account: d.stranger.account });

    assert.equal(await d.history.read.eraCount(), 1n);
    const after = await d.history.read.currentEra();
    assert.equal(after.startBlock, era.startBlock);
    assert.equal(after.endBlock, era.endBlock);
    assert.equal(await d.history.read.lastSyncedBlock(), era.startBlock);
    assert.equal(await d.history.read.count(), 2n);

    // After a real change (here: no guard, so no hook) sync reports it and,
    // as the same transaction, records the era.
    await d.mockSafe.write.setGuard([zeroAddress]);
    await rotate(d, 0, addr(d.third));
    assert.equal(await d.history.read.sync(), true); // eth_call: the return value only
    const syncBlock = await blockOf(d.history.write.sync([], { account: d.stranger.account }));
    assert.equal(await d.history.read.eraCount(), 2n);
    assert.equal(await d.history.read.lastSyncedBlock(), syncBlock);
  });

  it('a missed hook is repaired by a permissionless sync, at the sync block', async () => {
    // The guard is removed, so the rotation happens with no hook at all.
    await d.mockSafe.write.setGuard([zeroAddress]);
    const rotation = await rotate(d, 0, addr(d.third));
    assert.equal(await d.history.read.eraCount(), 1n);

    // The mirror is stale: the Safe already holds three keys, era 0 says two.
    assert.equal(await d.history.read.isOwner([addr(d.third)]), true);
    assert.equal(
      await d.history.read.isOwnerAt([addr(d.third), await publicClient.getBlockNumber()]),
      true, // live path at the head
    );
    assert.equal((await d.history.read.currentEra()).endBlock, 0n);

    // A stranger repairs it; the new era starts at the sync block, not at the
    // block the Safe actually rotated in. That gap is the documented cost.
    const syncBlock = await blockOf(d.history.write.sync([], { account: d.stranger.account }));
    assert.equal(await d.history.read.eraCount(), 2n);

    const era1 = await d.history.read.currentEra();
    assert.equal(era1.startBlock, syncBlock);
    assert.deepEqual(
      [...era1.owners].map((x: string) => x.toLowerCase()),
      [addr(d.first), addr(d.second), addr(d.third)],
    );

    // Compressed: inside the gap the third owner is attributed to neither era.
    await networkHelpers.mine();
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), rotation]), false);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), syncBlock]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), syncBlock - 1n]), false);

    // And it is genuinely idempotent once repaired.
    assert.equal(await d.history.read.sync(), false);
  });

  it('the guard never reverts: a reverting module is swallowed', async () => {
    const broken = await viem.deployContract('RevertingSync');
    const guard = await viem.deployContract('OwnerHistoryGuard', [d.safeAddr, broken.address]);
    await d.mockSafe.write.setGuard([guard.address]);

    // Full Safe-shaped path: checkTransaction, the mutation, checkAfterExecution.
    await assert.doesNotReject(d.mockSafe.write.execOwnerChange([0, addr(d.third), zeroAddress]));
    assert.equal(await d.mockSafe.read.isOwner([addr(d.third)]), true);
    assert.equal(await d.history.read.eraCount(), 1n); // the sync did not happen

    // checkTransaction takes arbitrary calldata and a bogus signature blob.
    await assert.doesNotReject(
      guard.write.checkTransaction([
        addr(d.third),
        1n,
        '0xdeadbeef',
        0,
        1n,
        2n,
        3n,
        zeroAddress,
        zeroAddress,
        `0x${'00'.repeat(65)}`,
        addr(d.stranger),
      ]),
    );

    // checkAfterExecution with anything at all, from the Safe itself.
    await assert.doesNotReject(d.mockSafe.write.pokeGuard([zeroHash, false]));
  });

  it('a gas-tight Safe transaction still succeeds: the hook is skipped, never fatal', async () => {
    // 250k is enough for the owner mutation and not for the sync (306k on a
    // 2-owner era), so the guard's reserved tail keeps the Safe's own call
    // alive and the catch absorbs the module's out-of-gas.
    await assert.doesNotReject(
      d.mockSafe.write.execOwnerChange([0, addr(d.third), zeroAddress], { gas: 250_000n }),
    );

    // The thing this protects: the Safe can always still execute, so the guard
    // can always still be removed — a guard cannot brick the Safe.
    assert.equal(await d.mockSafe.read.isOwner([addr(d.third)]), true);
    assert.equal(await d.history.read.eraCount(), 1n); // sync missed

    // And the miss is not a loss: anybody repairs it.
    await d.history.write.sync([], { account: d.stranger.account });
    assert.equal(await d.history.read.eraCount(), 2n);
    assert.equal(await d.history.read.count(), 3n);
  });

  it('the guard ignores calls from non-Safe senders', async () => {
    await d.mockSafe.write.setGuard([zeroAddress]);
    await d.mockSafe.write.execOwnerChange([0, addr(d.third), zeroAddress]);
    assert.equal(await d.history.read.eraCount(), 1n);

    // A stranger poking the guard must not be able to drive the module.
    await d.guard.write.checkAfterExecution([zeroHash, true], { account: d.stranger.account });
    assert.equal(await d.history.read.eraCount(), 1n);

    // The Safe itself can.
    await d.mockSafe.write.setGuard([d.guard.address]);
    // room for the hook: the guard forwards a bounded amount (see `rotate`)
    await d.mockSafe.write.pokeGuard([zeroHash, true], { gas: 1_200_000n });
    assert.equal(await d.history.read.eraCount(), 2n);
  });

  it('unknown address: every read answers false or empty instead of reverting', async () => {
    const nobody = addr(d.stranger);

    assert.equal(await d.history.read.isOwner([nobody]), false);
    assert.equal(await d.history.read.isOwnerAt([nobody, 0n]), false);
    assert.equal(await d.history.read.wasOwnerAt([nobody, 0n]), false);
    assert.equal(await d.history.read.isOwnerOrWasOwnerAt([nobody, 0n]), false);

    const [blocks, times] = await d.history.read.tenuresOf([nobody]);
    assert.deepEqual([...blocks], []);
    assert.deepEqual([...times], []);

    // Out-of-range era indices answer an empty era, not a revert.
    const past = await d.history.read.eraAt([7n]);
    assert.equal(past.startBlock, 0n);
    assert.deepEqual([...past.owners], []);

    // somebody who was never an owner at a block inside era 0
    assert.equal(await d.history.read.isOwnerAt([nobody, d.proxyBlock]), false);
  });

  it('the guard ABI is Safe 1.4.1 IGuard: the enum encodes as uint8', async () => {
    // Safe's IGuard declares `Enum.Operation`; its ABI type is uint8. This is
    // the selector the Safe calls, and the one our compiled ABI must match.
    const expected =
      'function checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)';

    const fn = (d.guard.abi as readonly any[]).find(
      (item) => item.type === 'function' && item.name === 'checkTransaction',
    );
    assert.ok(fn, 'guard ABI has no checkTransaction');
    const compiled = `function ${fn.name}(${fn.inputs.map((i: any) => i.type).join(',')})`;
    assert.equal(compiled, expected);
    assert.equal(toFunctionSelector(compiled), toFunctionSelector(expected));

    assert.equal(fn.inputs.length, 11);
    assert.equal(fn.inputs[3].type, 'uint8'); // the local enum, not a tuple

    const after = (d.guard.abi as readonly any[]).find(
      (item) => item.type === 'function' && item.name === 'checkAfterExecution',
    );
    assert.equal(after.inputs.map((i: any) => i.type).join(','), 'bytes32,bool');

    assert.equal(chk(await d.guard.read.safe()), d.safeAddr);
    assert.equal(chk(await d.guard.read.module()), chk(d.history.address));
  });

  it('factory createModule yields a working proxy for the Safe', async () => {
    assert.equal(chk(await d.factory.read.latestImplementation()), chk(d.implementation.address));
    assert.equal(await d.factory.read.implementationCount(), 1n);
    assert.equal(
      chk(await d.factory.read.getImplementationByVersion([1n])),
      chk(d.implementation.address),
    );

    const proxies = await d.factory.read.getModulesForSafe([d.safeAddr]);
    assert.equal(proxies.length, 1);

    const module = await viem.getContractAt('OwnerHistoryModuleV1', proxies[0]!);
    assert.equal(chk(await module.read.safe()), d.safeAddr);
    assert.equal(await module.read.eraCount(), 1n);
    assert.equal(await module.read.isOwner([addr(d.first)]), true);

    // A second Safe gets its own proxy, and the first one is untouched.
    const other = await viem.deployContract('MockSafe', [[addr(d.third)]]);
    await d.factory.write.createModule([other.address]);
    const others = await d.factory.read.getModulesForSafe([chk(other.address)]);
    assert.equal(others.length, 1);
    const otherModule = await viem.getContractAt('OwnerHistoryModuleV1', others[0]!);
    assert.equal(chk(await otherModule.read.safe()), chk(other.address));
    assert.deepEqual([...(await otherModule.read.ownersEver())].map((x: string) => x.toLowerCase()), [addr(d.third)]);
    assert.equal(await otherModule.read.isOwner([addr(d.first)]), false);
  });

  it('initialize rejects address(0) and a safe-less contract, at deploy time', async () => {
    await assertReverts(d.factory.write.createModule([zeroAddress]), selectorOf('ZeroAddress'));

    // A contract without getOwners() cannot produce era 0: the proxy reverts
    // here rather than being born silently empty.
    await assertReverts(
      d.factory.write.createModule([chk(d.guard.address)]),
      selectorOf('SafeCallFailed'),
    );
    assert.equal((await d.factory.read.getModulesForSafe([chk(d.guard.address)])).length, 0);
  });

  it('setImplementation is deployer-only; the UUPS gate is the Safe', async () => {
    assert.equal(chk(await d.factory.read.deployer()), addr(d.deployer));

    const other = await viem.deployContract('OwnerHistoryModuleV1');
    await assertReverts(
      d.factory.write.setImplementation([other.address], { account: d.stranger.account }),
      selectorOf('OnlyDeployer'),
    );
    await d.factory.write.setImplementation([other.address]);
    assert.equal(await d.factory.read.implementationCount(), 2n);
    assert.equal(
      chk(await d.factory.read.getImplementationByVersion([2n])),
      chk(other.address),
    );

    const next = await viem.deployContract('OwnerHistoryModuleV1');
    await assertReverts(
      d.history.write.upgradeTo([next.address], { account: d.stranger.account }),
      selectorOf('OnlySafe'),
    );

    // The bare implementation has its initializers disabled in the constructor.
    const bare = await viem.getContractAt('OwnerHistoryModuleV1', d.implementation.address);
    await assertReverts(bare.write.initialize([d.safeAddr]), /already initialized/);

    // The proxy is already initialised — and only the Safe can even try.
    await assertReverts(
      execAsSafe(
        d,
        chk(d.history.address),
        encodeFunctionData({ abi: d.history.abi, functionName: 'initialize', args: [d.safeAddr] }),
      ),
      /already initialized/,
    );

    // The Safe's own upgrade keeps storage and era numbering intact.
    await rotate(d, 0, addr(d.third));
    await execAsSafe(
      d,
      chk(d.history.address),
      encodeFunctionData({
        abi: d.history.abi,
        functionName: 'upgradeTo',
        args: [chk(next.address)],
      }),
    );

    const logs = await publicClient.getContractEvents({
      address: d.history.address,
      abi: d.history.abi,
      eventName: 'ContractUpgraded',
      fromBlock: 0n,
    });
    assert.equal(logs.length, 1);
    assert.equal(chk(logs[0]!.args.implementation!), chk(next.address));

    assert.equal(await d.history.read.eraCount(), 2n);
    assert.equal(await d.history.read.count(), 3n);
    assert.equal(
      await d.history.read.isOwnerAt([addr(d.third), await publicClient.getBlockNumber()]),
      true,
    );
  });
});
