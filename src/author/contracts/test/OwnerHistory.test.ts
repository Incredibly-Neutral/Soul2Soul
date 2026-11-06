import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import {
  encodeErrorResult,
  encodeFunctionData,
  parseAbi,
  toEventSelector,
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
 * MockSafe(owners) → both implementations → the one factory → proxy + guard
 * from `createOwnerHistoryModule`, then install the guard, which is the one
 * Safe transaction a real install needs (`setGuard` is `onlySelf`).
 *
 * Note what the factory did *not* do: it deployed the guard, and the Safe's
 * guard slot was still zero until `setGuard` below. Deployment is not adoption.
 */
async function deployHistory() {
  const [deployer, first, second, third, stranger] = await viem.getWalletClients();

  const mockSafe = await viem.deployContract('MockSafe', [
    [first.account.address, second.account.address],
  ]);

  const implementation = await viem.deployContract('OwnerHistoryModuleV1');
  // The factory deploys both module kinds; the drafts implementation is a
  // constructor argument here and nothing in this suite proxies onto it.
  const draftsImplementation = await viem.deployContract('DraftsModuleV1');
  const factory = await viem.deployContract('AuthorContractsFactory', [
    draftsImplementation.address,
    implementation.address,
  ]);

  // Era 0 opens in this transaction, so its start block is this one.
  const proxyBlock = await blockOf(factory.write.createOwnerHistoryModule([mockSafe.address]));
  const proxies = await factory.read.getOwnerHistoryModulesForSafe([mockSafe.address]);
  const history = await viem.getContractAt('OwnerHistoryModuleV1', proxies[0]!);
  const guardAddress = await factory.read.guardFor([proxies[0]!]);
  const guard = await viem.getContractAt('OwnerHistoryGuard', guardAddress);

  await mockSafe.write.setGuard([guard.address]);

  return {
    deployer,
    first,
    second,
    third,
    stranger,
    mockSafe,
    implementation,
    draftsImplementation,
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
async function rotateTx(d: Deployment, kind: number, a: Hex, b: Hex = zeroAddress) {
  const hash = await d.mockSafe.write.execOwnerChange([kind, a, b], { gas: 1_200_000n });
  const block = await blockOf(Promise.resolve(hash));
  await networkHelpers.mine(); // so block/timestamp reads take the index path
  return { hash, block };
}

/** The block a rotation landed in; most tests only care about that. */
async function rotate(d: Deployment, kind: number, a: Hex, b: Hex = zeroAddress) {
  return (await rotateTx(d, kind, a, b)).block;
}

/** An `onlySelf` call, made the way a real Safe makes it: by executing it. */
async function execAsSafe(d: Deployment, target: Hex, data: Hex) {
  return blockOf(d.mockSafe.write.execCall([target, data]));
}

/**
 * The guard's only notice that it did not record anything: the block it names,
 * or `undefined` when the hook fired.
 */
async function syncFailure(hash: Hex): Promise<bigint | undefined> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const topic = toEventSelector('SyncFailed(uint256)');
  const log = receipt.logs.find((l) => l.topics[0] === topic);
  if (!log) return undefined;
  assert.equal(receipt.blockNumber, BigInt(log.data), 'SyncFailed names its own block');
  return receipt.blockNumber;
}

/**
 * How many CALLs the guard made to the module in this transaction, read off a
 * `callTracer` trace rather than inferred.
 *
 * This helper exists because of a measurement, not out of tidiness: viem's gas
 * estimation simulates the call, and the simulation is *allowed* to skip the
 * hook (the guard is best-effort by construction), so the estimate comes back at
 * the cost of the Safe's mutation alone — ~83k — and the hook then returns at
 * its reserve check having called nothing at all. A test written that way passes
 * against a guard that never calls the module, which is exactly what the first
 * version of the three tests below did: all three were green, and a trace showed
 * zero CALLs from the guard frame in each.
 *
 * So every test that claims something about the module's behaviour under the
 * hook must (a) send an explicit gas limit — the `1_200_000n` on those calls is
 * load-bearing, not decoration — and (b) assert the call happened.
 */
async function guardCallsModule(hash: Hex, guard: Hex, module: Hex): Promise<number> {
  const trace: any = await publicClient.request({
    method: 'debug_traceTransaction' as any,
    params: [hash, { tracer: 'callTracer' }] as any,
  });
  let count = 0;
  const walk = (frame: any) => {
    if (frame.type === 'CALL' && chk(frame.from) === chk(guard) && chk(frame.to) === chk(module)) {
      count++;
    }
    for (const child of frame.calls ?? []) walk(child);
  };
  walk(trace);
  return count;
}

const ERROR_ABI = parseAbi([
  'error OnlySafe()',
  'error ZeroAddress()',
  'error SafeCallFailed()',
  'error OnlyDeployer()',
  'error ZeroOwners()',
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

    // Nobody was an owner in the block before era 0.
    assert.equal(await d.history.read.isOwnerAt([addr(d.first), d.proxyBlock - 1n]), false);
  });

  it('a rotation through the guard hook opens era 1 and closes era 0', async () => {
    const { hash, block: boundary } = await rotateTx(d, 0, addr(d.third));

    // A sync that landed under the hook says nothing: no notice, era opened.
    assert.equal(await syncFailure(hash), undefined);
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

  it('in the rotation block the live set answers, and the index agrees only because the sync landed', async () => {
    // head == N: `isOwnerAt(who, N)` takes the live branch, because the query is
    // not below the current block. It answers from the Safe's `isOwner`, which
    // is already post-rotation in this block.
    const boundary = await blockOf(
      d.mockSafe.write.execOwnerChange([2, addr(d.second), addr(d.third)], { gas: 1_200_000n }),
    );
    assert.equal(await publicClient.getBlockNumber(), boundary, 'no block mined since the rotation');

    assert.equal(await d.history.read.isOwnerAt([addr(d.third), boundary]), true); // the joiner
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), boundary]), false); // the leaver

    // N+1: the same two queries now come from the tenure index, and they agree
    // with the live answers only because the sync landed in the rotation block.
    // Had the hook been skipped, the index would still describe era 0 here and
    // the two paths would disagree — see the second half.
    await networkHelpers.mine();
    assert.equal(await d.history.read.eraCount(), 2n);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), boundary]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), boundary]), false);

    // The counter-example that makes the point: a rotation whose sync was
    // skipped, because 250k cannot pay for an add on a two-owner era (~306k).
    // At the head the live branch still follows the Safe; one block past it the
    // index answers from the stale era and says the opposite.
    const skipped = await blockOf(
      d.mockSafe.write.execOwnerChange([0, addr(d.second), zeroAddress], { gas: 250_000n }),
    );
    await networkHelpers.mine();
    await networkHelpers.mine();

    assert.equal(await d.mockSafe.read.isOwner([addr(d.second)]), true); // the Safe moved
    assert.equal(await d.history.read.eraCount(), 2n); // the index did not

    // At a block below the head the index is consulted, and it is stale: it
    // still describes the era that ended before this owner came back.
    assert.equal(await d.history.read.isOwnerAt([addr(d.second), skipped + 1n]), false);
    // At the head the live branch is consulted, and it is right.
    assert.equal(
      await d.history.read.isOwnerAt([addr(d.second), await publicClient.getBlockNumber()]),
      true,
    );
    // Only the live answer is reproducible from the chain's own state; the index
    // one is a record of a gap, and it stays wrong until somebody calls `sync()`.
  });

  it('sync() refuses to record an empty owner set, rather than emptying the history', async () => {
    // A real Safe cannot lose its last owner (`removeOwner` refuses to go below
    // the threshold), so this is the module's reaction to a broken or mid-upgrade
    // Safe. Recording it would close every tenure and open an era with no owners
    // — a history that says the Safe was ownerless from here on, forever.
    const before = await d.history.read.lastSyncedBlock();
    await d.mockSafe.write.dropAllOwners();

    await assertReverts(d.history.write.sync([]), selectorOf('ZeroOwners'));

    assert.equal(await d.history.read.eraCount(), 1n);
    assert.equal(await d.history.read.lastSyncedBlock(), before);
    assert.equal(await d.history.read.isOwner([addr(d.first)]), false); // the Safe is empty
    assert.equal(await d.history.read.isOwnerAt([addr(d.first), before]), true); // the history is not
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

  it('an owner who joined in a later era is not an owner at an earlier block, though they are one today', async () => {
    // The substitution `isOwnerAt` must never make: `isOwner(who) || <history>`
    // would let a signer prove a past block with a key that did not hold one
    // then. era 1 is {first}; era 2 swaps first out and third in.
    const era1 = await rotate(d, 1, addr(d.second)); // {first}
    const era2 = await rotate(d, 2, addr(d.first), addr(d.third)); // {third}

    // Today.
    assert.equal(await d.history.read.isOwner([addr(d.third)]), true);
    assert.equal(await d.history.read.isOwner([addr(d.first)]), false);

    // third joined in era 2: not an owner in era 1, an owner from era 2 on.
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), era1]), false);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), era2 - 1n]), false);
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), era2]), true);

    // first, the mirror case: an owner in era 1 and earlier, gone in era 2.
    assert.equal(await d.history.read.isOwnerAt([addr(d.first), era1]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.first), era2]), false);

    // And the present tense still answers live, through the same function.
    const head = await publicClient.getBlockNumber();
    assert.equal(await d.history.read.isOwnerAt([addr(d.third), head]), true);
    assert.equal(await d.history.read.isOwnerAt([addr(d.first), head]), false);
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

  it('a module address with no code does not revert the Safe, and admits it', async () => {
    // The one permanent wound this contract could inflict: `module` is
    // immutable, and `try ... returns (bool)` on a codeless callee decodes empty
    // returndata *in the guard's frame*, outside any catch — reverting
    // `execTransaction`, and with it the `setGuard(address(0))` that would remove
    // the guard. The guard now calls low-level and decodes nothing.
    const guard = await viem.deployContract('OwnerHistoryGuard', [
      d.safeAddr,
      d.stranger.account.address,
    ]);
    await d.mockSafe.write.setGuard([guard.address]);

    // The gas limit is explicit because estimation is blind to the hook: see
    // `guardCallsModule`. Without it this test never reaches the decoder that
    // round 1 bricked on, which is the only thing it is here to prove.
    const hash = await d.mockSafe.write.execOwnerChange([0, addr(d.third), zeroAddress], {
      gas: 1_200_000n,
    });
    assert.equal(await d.mockSafe.read.isOwner([addr(d.third)]), true); // the Safe lived
    assert.equal(await d.history.read.eraCount(), 1n); // and nothing was recorded

    // Silence would be the other failure: the guard has to say it skipped.
    // There is no CALL to trace here — the `code.length` belt returns first —
    // so the notice is the evidence that the hook ran at all, and the gas says
    // which branch produced it: the transaction spent ~83k of its 1.2M, so the
    // hook was entered with the rest and cannot have hit the reserve check.
    assert.notEqual(await syncFailure(hash), undefined);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.ok(receipt.gasUsed < 200_000n);

    // The escape hatch still works, which is the whole point: on a real Safe
    // `setGuard` is `onlySelf`, i.e. an `execTransaction` that must not revert.
    await d.mockSafe.write.setGuard([zeroAddress]);
    assert.equal(await d.mockSafe.read.guard(), zeroAddress);
  });

  it('a module with code but no sync() does not revert the Safe', async () => {
    const noSync = await viem.deployContract('NoSync');
    const guard = await viem.deployContract('OwnerHistoryGuard', [d.safeAddr, noSync.address]);
    await d.mockSafe.write.setGuard([guard.address]);

    // Explicit limit, same reason: the call has to be made for the test to mean
    // anything (see `guardCallsModule`).
    const hash = await d.mockSafe.write.execOwnerChange([0, addr(d.third), zeroAddress], {
      gas: 1_200_000n,
    });
    assert.equal(await d.mockSafe.read.isOwner([addr(d.third)]), true);
    assert.equal(await d.history.read.eraCount(), 1n);

    // The call happened and reverted in the dispatcher — this one landed in the
    // `catch` even before the fix, so it guards against a regression, not the
    // brick.
    assert.equal(await guardCallsModule(hash, chk(guard.address), chk(noSync.address)), 1);
    assert.notEqual(await syncFailure(hash), undefined);
  });

  it('a proxy whose implementation slot is empty does not revert the Safe', async () => {
    // `code.length > 0`, so the codeless belt cannot help here, and the
    // delegatecall to address(0) *succeeds* with empty returndata — exactly the
    // shape a `returns (bool)` decode cannot survive.
    const emptyProxy = await viem.deployContract('EmptyImplementationProxy');
    assert.equal(await emptyProxy.read.implementation(), zeroAddress);

    const guard = await viem.deployContract('OwnerHistoryGuard', [d.safeAddr, emptyProxy.address]);
    await d.mockSafe.write.setGuard([guard.address]);

    // Explicit limit again, and here it decides the outcome: with a short one
    // the hook returns at the reserve check, never calls, and `SyncFailed` would
    // fire for the wrong reason — the test would pass while proving nothing.
    const hash = await d.mockSafe.write.execOwnerChange([0, addr(d.third), zeroAddress], {
      gas: 1_200_000n,
    });
    assert.equal(await d.mockSafe.read.isOwner([addr(d.third)]), true);
    assert.equal(await d.history.read.eraCount(), 1n);

    // The guard really called it, the delegatecall to address(0) really
    // succeeded, and the empty returndata is what the length check catches:
    // `ok == true` and nothing recorded, which is why `SyncFailed` has to come
    // from the returndata length and not from `!ok`.
    assert.equal(await guardCallsModule(hash, chk(guard.address), chk(emptyProxy.address)), 1);
    assert.notEqual(await syncFailure(hash), undefined);
  });

  it('a gas-tight Safe transaction still succeeds, and the skip is visible', async () => {
    // 250k is enough for the owner mutation and not for the sync (306k on a
    // 2-owner era), so the guard's reserved tail keeps the Safe's own call
    // alive and the failed module call is nothing but a skipped sync.
    const hash = await d.mockSafe.write.execOwnerChange([0, addr(d.third), zeroAddress], {
      gas: 250_000n,
    });

    // The thing this protects: the Safe can always still execute, so the guard
    // can always still be removed — a guard cannot brick the Safe.
    assert.equal(await d.mockSafe.read.isOwner([addr(d.third)]), true);
    assert.equal(await d.history.read.eraCount(), 1n); // sync missed

    // A miss is not silent any more, and it is legible from the module too.
    const failedAt = await syncFailure(hash);
    assert.notEqual(failedAt, undefined);
    assert.equal(await d.history.read.lastSyncedBlock(), d.proxyBlock); // lagging

    // And it is not a loss: anybody repairs it, and the era is stamped then.
    const repairBlock = await blockOf(d.history.write.sync([], { account: d.stranger.account }));
    assert.equal(await d.history.read.eraCount(), 2n);
    assert.equal(await d.history.read.count(), 3n);
    assert.equal(await d.history.read.lastSyncedBlock(), repairBlock);
    assert.ok(repairBlock > failedAt!);
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

  it('setGuard enforces the ERC-165 gate: our guard installs, a plain contract reverts GS300', async () => {
    // Safe 1.4.1's `GuardManager.setGuard` validates before it stores:
    //   require(Guard(guard).supportsInterface(type(Guard).interfaceId), "GS300");
    // so a guard without ERC-165 is not uninstallable-later, it is uninstallable
    // at all. `d.guard` answering `true` is what this asserts; `NotAGuard`, which
    // answers `false` for every interface, is what the require rejects.
    await d.mockSafe.write.setGuard([zeroAddress]);
    assert.equal(await d.mockSafe.read.guard(), zeroAddress);

    await assert.doesNotReject(d.mockSafe.write.setGuard([d.guard.address]));
    assert.equal(chk(await d.mockSafe.read.guard()), chk(d.guard.address));

    const notAGuard = await viem.deployContract('NotAGuard');
    await assertReverts(d.mockSafe.write.setGuard([notAGuard.address]), 'GS300');
    // Rejected means unchanged: the Safe keeps the guard it had.
    assert.equal(chk(await d.mockSafe.read.guard()), chk(d.guard.address));
  });

  it('supportsInterface answers the guard id derived from our own selectors, and nothing else', async () => {
    // The id the real `setGuard` compares against, computed from the two
    // selectors this contract actually compiles to — not a literal typed twice.
    // EIP-165 excludes inherited functions, so `supportsInterface(bytes4)` is not
    // part of it, which is why this XOR is the whole interface id.
    const checkTransaction = toFunctionSelector(
      'function checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)',
    );
    const checkAfterExecution = toFunctionSelector('function checkAfterExecution(bytes32,bool)');
    const guardInterfaceId = `0x${(BigInt(checkTransaction) ^ BigInt(checkAfterExecution))
      .toString(16)
      .padStart(8, '0')}` as Hex;

    assert.equal(guardInterfaceId, '0xe6d7a83a');
    assert.equal(await d.guard.read.supportsInterface([guardInterfaceId]), true);
    assert.equal(await d.guard.read.supportsInterface(['0x01ffc9a7']), true); // IERC165

    // ERC-165 is not "returns true always": an id nobody claims is false.
    assert.equal(await d.guard.read.supportsInterface(['0xffffffff']), false);
  });

  it('sync() on a proxy that was never initialized fails cleanly, not with a panic', async () => {
    // The factory always initializes, so this needs a hand-made proxy: the
    // implementation behind an ERC-1967 proxy with no `initialize` call.
    const bareProxy = await viem.deployContract('BareProxy', [d.implementation.address]);
    const uninitialised = await viem.getContractAt('OwnerHistoryModuleV1', bareProxy.address);

    assert.equal(await uninitialised.read.eraCount(), 0n);
    assert.equal(await uninitialised.read.isOwner([addr(d.first)]), false); // safe is zero
    await assertReverts(uninitialised.write.sync([]), selectorOf('SafeCallFailed'));
    assert.equal(await uninitialised.read.lastSyncedBlock(), 0n);
  });

  it('initialize refuses a Safe that has no owners yet', async () => {
    // Deployed but not `setup()`ed: `getOwners()` returns nothing, so era 0
    // would be silently empty and nobody would ever have a tenure.
    const ownerless = await viem.deployContract('MockSafe', [[]]);
    await assertReverts(d.factory.write.createOwnerHistoryModule([ownerless.address]), selectorOf('ZeroOwners'));
    assert.equal((await d.factory.read.getOwnerHistoryModulesForSafe([chk(ownerless.address)])).length, 0);
  });

  it('isOwner answers false when the Safe returns a word that is not 0 or 1', async () => {
    // `abi.decode(..., (bool))` reverts on such a word, so a lying Safe could
    // have made the module's "never reverts" read revert. It compares the raw
    // word instead.
    const lying = await viem.deployContract('LyingSafe', [addr(d.first)]);
    await d.factory.write.createOwnerHistoryModule([lying.address]);
    const proxies = await d.factory.read.getOwnerHistoryModulesForSafe([chk(lying.address)]);
    const module = await viem.getContractAt('OwnerHistoryModuleV1', proxies[0]!);

    assert.equal(await module.read.eraCount(), 1n);
    assert.equal(await module.read.isOwner([addr(d.first)]), false);
    assert.equal(
      await module.read.isOwnerAt([addr(d.first), await publicClient.getBlockNumber()]),
      false,
    );
  });

  it('factory createOwnerHistoryModule yields a working proxy for the Safe', async () => {
    assert.equal(chk(await d.factory.read.ownerHistoryImplementation()), chk(d.implementation.address));
    assert.equal(await d.factory.read.ownerHistoryImplementationCount(), 1n);
    assert.equal(
      chk(await d.factory.read.getOwnerHistoryImplementationByVersion([1n])),
      chk(d.implementation.address),
    );

    const proxies = await d.factory.read.getOwnerHistoryModulesForSafe([d.safeAddr]);
    assert.equal(proxies.length, 1);

    const module = await viem.getContractAt('OwnerHistoryModuleV1', proxies[0]!);
    assert.equal(chk(await module.read.safe()), d.safeAddr);
    assert.equal(await module.read.eraCount(), 1n);
    assert.equal(await module.read.isOwner([addr(d.first)]), true);

    // A second Safe gets its own proxy, and the first one is untouched.
    const other = await viem.deployContract('MockSafe', [[addr(d.third)]]);
    await d.factory.write.createOwnerHistoryModule([other.address]);
    const others = await d.factory.read.getOwnerHistoryModulesForSafe([chk(other.address)]);
    assert.equal(others.length, 1);
    const otherModule = await viem.getContractAt('OwnerHistoryModuleV1', others[0]!);
    assert.equal(chk(await otherModule.read.safe()), chk(other.address));
    assert.deepEqual([...(await otherModule.read.ownersEver())].map((x: string) => x.toLowerCase()), [addr(d.third)]);
    assert.equal(await otherModule.read.isOwner([addr(d.first)]), false);
  });

  it('createOwnerHistoryModule binds proxy, guard and Safe, and installs nothing', async () => {
    // A Safe that has not been touched: the factory deploys the proxy and the
    // guard wired to it, and stops there.
    const fresh = await viem.deployContract('MockSafe', [[addr(d.first), addr(d.second)]]);
    await blockOf(d.factory.write.createOwnerHistoryModule([fresh.address]));

    const proxies = await d.factory.read.getOwnerHistoryModulesForSafe([chk(fresh.address)]);
    const proxy = proxies.at(-1)!;
    const guardAddress = await d.factory.read.guardFor([proxy]);
    assert.notEqual(guardAddress, zeroAddress);

    const history = await viem.getContractAt('OwnerHistoryModuleV1', proxy);
    const guard = await viem.getContractAt('OwnerHistoryGuard', guardAddress);

    // The two are bound to each other, and both name the Safe.
    assert.equal(chk(await guard.read.module()), chk(proxy));
    assert.equal(chk(await guard.read.safe()), chk(fresh.address));
    assert.equal(chk(await history.read.safe()), chk(fresh.address));
    // The factory's index points from the module to the guard it made.
    assert.equal(chk(await d.factory.read.guardFor([proxy])), chk(guardAddress));

    // Deployment is not adoption: nothing the factory does reaches the Safe's
    // storage, so the guard slot is still zero and no hook can fire yet.
    assert.equal(await fresh.read.guard(), zeroAddress);

    // And the guard is installable in the Safe's own transaction — the one
    // `setGuard`, which is `onlySelf` and enforces the ERC-165 gate.
    await fresh.write.setGuard([guardAddress]);
    assert.equal(chk(await fresh.read.guard()), chk(guardAddress));
  });

  it('both indexes append, and neither create is gated to the deployer', async () => {
    const draftsBefore = (await d.factory.read.getDraftsModulesForSafe([d.safeAddr])).length;
    const historyBefore = (await d.factory.read.getOwnerHistoryModulesForSafe([d.safeAddr])).length;

    // A stranger may create for a Safe it has nothing to do with: a proxy and a
    // guard install nothing on their own, so creation buys no trust.
    await d.factory.write.createDraftsModule([d.safeAddr], { account: d.stranger.account });
    await d.factory.write.createOwnerHistoryModule([d.safeAddr], { account: d.stranger.account });

    const drafts = await d.factory.read.getDraftsModulesForSafe([d.safeAddr]);
    const histories = await d.factory.read.getOwnerHistoryModulesForSafe([d.safeAddr]);
    assert.equal(drafts.length, draftsBefore + 1);
    assert.equal(histories.length, historyBefore + 1);
    // Every history proxy the factory made has a guard in its index.
    assert.notEqual(await d.factory.read.guardFor([histories.at(-1)!]), zeroAddress);

    // Moving either implementation stays the deployer's alone.
    assert.equal(chk(await d.factory.read.deployer()), addr(d.deployer));
    for (const write of [
      d.factory.write.setDraftsImplementation([chk(d.stranger.account.address)], {
        account: d.stranger.account,
      }),
      d.factory.write.setOwnerHistoryImplementation([chk(d.stranger.account.address)], {
        account: d.stranger.account,
      }),
    ]) {
      await assertReverts(write, selectorOf('OnlyDeployer'));
    }
    assert.equal(chk(await d.factory.read.draftsImplementation()), chk(d.draftsImplementation.address));
    assert.equal(chk(await d.factory.read.ownerHistoryImplementation()), chk(d.implementation.address));
  });

  it('guardFor answers zero for an unknown module instead of reverting', async () => {
    // An address this factory never deployed is a reader's mistake, and a read
    // that reverts on one is a read a gate cannot use.
    assert.equal(
      await d.factory.read.guardFor(['0x000000000000000000000000000000000000dead']),
      zeroAddress,
    );
  });

  it('initialize rejects address(0) and a safe-less contract, at deploy time', async () => {
    await assertReverts(d.factory.write.createOwnerHistoryModule([zeroAddress]), selectorOf('ZeroAddress'));

    // A contract without getOwners() cannot produce era 0: the proxy reverts
    // here rather than being born silently empty.
    await assertReverts(
      d.factory.write.createOwnerHistoryModule([chk(d.guard.address)]),
      selectorOf('SafeCallFailed'),
    );
    assert.equal((await d.factory.read.getOwnerHistoryModulesForSafe([chk(d.guard.address)])).length, 0);
  });

  it('setOwnerHistoryImplementation is deployer-only; the UUPS gate is the Safe', async () => {
    assert.equal(chk(await d.factory.read.deployer()), addr(d.deployer));

    const other = await viem.deployContract('OwnerHistoryModuleV1');
    await assertReverts(
      d.factory.write.setOwnerHistoryImplementation([other.address], { account: d.stranger.account }),
      selectorOf('OnlyDeployer'),
    );
    await d.factory.write.setOwnerHistoryImplementation([other.address]);
    assert.equal(await d.factory.read.ownerHistoryImplementationCount(), 2n);
    assert.equal(
      chk(await d.factory.read.getOwnerHistoryImplementationByVersion([2n])),
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
