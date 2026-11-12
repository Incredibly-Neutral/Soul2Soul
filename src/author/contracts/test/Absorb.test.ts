import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { getAddress, keccak256, toHex, zeroAddress } from 'viem';

/**
 * `absorb` imports a page of an older drafts module's log into this one, so an
 * author who stays at the same Safe address keeps their drafts when they adopt
 * new modules.
 *
 * The old module is untrusted input, so half of this suite is about what a
 * broken one may do: nothing, as far as the batch is concerned. The fixtures it
 * drives live in `BadOldModule.t.sol` (and one real `OwnerHistoryModuleV1`,
 * which has no `fetchAllPaged` at all, stands in for "a contract that is not
 * this kind of module").
 */

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();

const genesis = (label: string) => keccak256(toHex(label));

type Pair = Awaited<ReturnType<typeof deployPair>>;

/**
 * Two drafts proxies on the SAME Safe through the one factory: `oldModule` is
 * what the author used before, `fresh` is the one they are adopting. Same Safe
 * address is the whole premise of `absorb`.
 */
async function deployPair() {
  const [deployer, safe, stranger] = await viem.getWalletClients();

  const implementation = await viem.deployContract('DraftsModuleV1');
  const historyImplementation = await viem.deployContract('OwnerHistoryModuleV1');
  const factory = await viem.deployContract('AuthorContractsFactory', [
    implementation.address,
    historyImplementation.address,
  ]);

  await factory.write.createDraftsModule([safe.account.address]);
  await factory.write.createDraftsModule([safe.account.address]);

  const modules = await factory.read.getDraftsModulesForSafe([safe.account.address]);
  const oldModule = await viem.getContractAt('DraftsModuleV1', modules[0]!);
  const fresh = await viem.getContractAt('DraftsModuleV1', modules[1]!);

  return { oldModule, fresh, factory, implementation, historyImplementation, deployer, safe, stranger };
}

/** `append` on the old module, from the Safe — the only caller it takes. */
async function appendOld(p: Pair, hash: `0x${string}`, cid: string) {
  await p.oldModule.write.append([hash, cid], { account: p.safe.account });
}

/** `absorb` on the module being adopted, from the Safe. */
async function absorb(p: Pair, oldModule: `0x${string}`, offset: bigint, limit: bigint) {
  return p.fresh.write.absorb([oldModule, offset, limit], { account: p.safe.account });
}

/** The `Absorbed` events this module emitted, oldest first. */
async function absorbedEvents(p: Pair) {
  return publicClient.getContractEvents({
    address: p.fresh.address,
    abi: p.fresh.abi,
    eventName: 'Absorbed',
    fromBlock: 0n,
  });
}

describe('DraftsModuleV1.absorb', () => {
  let p: Pair;

  beforeEach(async () => {
    p = await deployPair();
  });

  it('imports every version of every page in order, with the old cid and the old timestamp', async () => {
    const a = genesis('draft-a');
    const b = genesis('draft-b');
    // The third is past 31 bytes: the import copies a string that does not fit
    // in one word, which is where a hand decoder gets it wrong.
    const longCid = `bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi${'q'.repeat(120)}`;
    const appendedA = ['bafy-a1', 'bafy-a2', longCid];

    for (const cid of appendedA) {
      await appendOld(p, a, cid);
      await networkHelpers.time.increase(60);
    }
    await appendOld(p, b, 'bafy-b1');

    const [oldStampsA, oldCidsA] = await p.oldModule.read.history([a]);
    const [oldStampsB, oldCidsB] = await p.oldModule.read.history([b]);
    assert.equal(oldCidsA.length, 3);

    await absorb(p, p.oldModule.address, 0n, 10n);

    // The list order is the old insertion order, not the page's own idea of it.
    assert.equal(await p.fresh.read.count(), 2n);
    assert.deepEqual(
      (await p.fresh.read.fetchAll()).map((e) => e.genesis),
      [a, b],
    );

    // Version order, cid and timestamp come across exactly: `history` is what a
    // reader compares against the old module, and it must not have moved.
    const [stampsA, cidsA] = await p.fresh.read.history([a]);
    const [stampsB, cidsB] = await p.fresh.read.history([b]);
    assert.deepEqual([...cidsA], [...oldCidsA]);
    assert.deepEqual([...stampsA], [...oldStampsA]);
    assert.deepEqual([...cidsB], [...oldCidsB]);
    assert.deepEqual([...stampsB], [...oldStampsB]);
    assert.deepEqual([...cidsA], appendedA);

    assert.equal(await p.fresh.read.versionCount([a]), 3n);
    assert.equal(await p.fresh.read.versionCount([b]), 1n);

    // The author is this Safe, as it would be for an append: the binding is the
    // module's own rule, not something the import reads from the old log.
    assert.equal(getAddress(await p.fresh.read.authorOf([a])), getAddress(p.safe.account.address!));
    assert.equal(await p.fresh.read.isDraft([b]), true);

    const entry = await p.fresh.read.fetch([a]);
    assert.equal(entry.cid, longCid);
    assert.equal(entry.timestamp, oldStampsA[2]);
    assert.equal(entry.versionCount, 3n);

    const [event] = await absorbedEvents(p);
    assert.equal(event!.args.genesisCount, 2n);
    assert.equal(event!.args.versionCount, 4n);
    assert.equal(event!.args.skipped, 0n);
    assert.equal(getAddress(event!.args.oldModule!), getAddress(p.oldModule.address));
  });

  it('writes blockNumber 0 for imported versions while the old log keeps its blocks', async () => {
    const a = genesis('draft-blocked');

    await appendOld(p, a, 'bafy-blocked-v1');
    await networkHelpers.mine(2);
    await appendOld(p, a, 'bafy-blocked-v2');

    const oldBlocks = await p.oldModule.read.blocksOf([a]);
    assert.ok(oldBlocks[0]! > 0n && oldBlocks[1]! > oldBlocks[0]!, 'the old log knows its blocks');

    await absorb(p, p.oldModule.address, 0n, 10n);

    const [stamps] = await p.fresh.read.history([a]);
    assert.deepEqual([...(await p.oldModule.read.history([a]))[0]], [...stamps], 'timestamps are preserved');

    // 0 = imported, no block recorded. Not block 0 of a chain: the import does
    // not know the block, because `history` does not return it.
    const blocks = await p.fresh.read.blocksOf([a]);
    assert.deepEqual([...blocks], [0n, 0n]);
  });

  it('a second call with the same page imports nothing twice', async () => {
    const a = genesis('draft-a');
    const b = genesis('draft-b');
    await appendOld(p, a, 'bafy-a1');
    await appendOld(p, a, 'bafy-a2');
    await appendOld(p, b, 'bafy-b1');

    await absorb(p, p.oldModule.address, 0n, 10n);
    const [, cidsBefore] = await p.fresh.read.history([a]);
    assert.equal(await p.fresh.read.count(), 2n);
    assert.equal(await p.fresh.read.versionCount([a]), 2n);

    await absorb(p, p.oldModule.address, 0n, 10n);

    assert.equal(await p.fresh.read.count(), 2n);
    assert.equal(await p.fresh.read.versionCount([a]), 2n);
    assert.deepEqual([...(await p.fresh.read.history([a]))[1]], [...cidsBefore]);

    const events = await absorbedEvents(p);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.args.genesisCount, 2n);
    assert.equal(events[1]!.args.versionCount, 0n, 'nothing imported the second time');
    assert.equal(events[1]!.args.skipped, 2n);
  });

  it('a genesis this module already knows is skipped whole, not merged', async () => {
    const a = genesis('draft-a');
    const b = genesis('draft-b');
    await appendOld(p, a, 'bafy-a1');
    await appendOld(p, a, 'bafy-a2');
    await appendOld(p, b, 'bafy-b1');

    // One local version of `a`: the import leaves it as it is, it does not add
    // the old log's two versions behind it.
    await p.fresh.write.append([a, 'bafy-fresh-local'], { account: p.safe.account });

    await absorb(p, p.oldModule.address, 0n, 10n);

    assert.equal(await p.fresh.read.count(), 2n);
    assert.equal(await p.fresh.read.versionCount([a]), 1n);
    assert.deepEqual([...(await p.fresh.read.history([a]))[1]], ['bafy-fresh-local']);
    assert.equal(await p.fresh.read.versionCount([b]), 1n);

    const [event] = await absorbedEvents(p);
    assert.equal(event!.args.skipped, 1n);
    assert.equal(event!.args.versionCount, 1n);
  });

  it('imports one page at a time: offset and limit bound the loop', async () => {
    const hashes = [genesis('a'), genesis('b'), genesis('c')];
    for (const [i, hash] of hashes.entries()) await appendOld(p, hash, `bafy-${i}`);

    await absorb(p, p.oldModule.address, 0n, 2n);
    assert.equal(await p.fresh.read.count(), 2n);

    await absorb(p, p.oldModule.address, 2n, 2n);
    assert.equal(await p.fresh.read.count(), 3n);

    assert.deepEqual(
      (await p.fresh.read.fetchAll()).map((e) => e.genesis),
      hashes,
    );
  });

  it('an out-of-range offset or a zero limit is harmless', async () => {
    await appendOld(p, genesis('draft-a'), 'bafy-a1');

    await absorb(p, p.oldModule.address, 99n, 10n);
    assert.equal(await p.fresh.read.count(), 0n);

    await absorb(p, p.oldModule.address, 0n, 0n);
    assert.equal(await p.fresh.read.count(), 0n);

    const events = await absorbedEvents(p);
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(e.args.genesisCount, 0n);
      assert.equal(e.args.versionCount, 0n);
    }
  });

  it('a non-Safe caller reverts OnlySafe and imports nothing', async () => {
    await appendOld(p, genesis('draft-a'), 'bafy-a1');

    await assert.rejects(
      p.fresh.write.absorb([p.oldModule.address, 0n, 10n], { account: p.stranger.account }),
      /OnlySafe/,
    );
    assert.equal(await p.fresh.read.count(), 0n);
  });

  it('a failing or non-conforming old module is skipped, not fatal', async () => {
    const reverting = await viem.deployContract('RevertingOldModule');
    const garbage = await viem.deployContract('GarbageOldModule');
    // A real contract of this package with no `fetchAllPaged`: the call reverts
    // in its dispatcher, which is the "right address, wrong module" case.
    const wrongKind = await viem.deployContract('OwnerHistoryModuleV1');

    const unusable: `0x${string}`[] = [
      reverting.address,          // every read reverts
      garbage.address,            // every read answers junk
      wrongKind.address,          // right address, wrong module
      zeroAddress,                // no code at all
      p.stranger.account.address, // an EOA: no code, empty answer
    ];
    for (const old of unusable) {
      await absorb(p, old, 0n, 10n);
    }

    assert.equal(await p.fresh.read.count(), 0n);

    const events = await absorbedEvents(p);
    assert.equal(events.length, 5);
    for (const e of events) {
      assert.equal(e.args.genesisCount, 0n);
      assert.equal(e.args.versionCount, 0n);
    }

    // The module still works after the bad addresses: nothing was left broken.
    const a = genesis('draft-a');
    await appendOld(p, a, 'bafy-a1');
    await absorb(p, p.oldModule.address, 0n, 10n);
    assert.equal(await p.fresh.read.count(), 1n);
  });

  it('a history whose two arrays disagree, or whose timestamp is too wide, is skipped', async () => {
    const good = genesis('bad-history-good');
    const skewed = genesis('bad-history-skewed');
    const tooLate = genesis('bad-history-too-late');
    const bad = await viem.deployContract('BadHistoryOldModule', [good, skewed, tooLate]);

    await absorb(p, bad.address, 0n, 10n);

    // All or nothing per genesis: half a history would claim to be a trail.
    assert.equal(await p.fresh.read.count(), 1n);
    assert.equal(await p.fresh.read.isDraft([good]), true);
    assert.equal(await p.fresh.read.isDraft([skewed]), false);
    assert.equal(await p.fresh.read.isDraft([tooLate]), false);

    const [event] = await absorbedEvents(p);
    assert.equal(event!.args.genesisCount, 3n);
    assert.equal(event!.args.versionCount, 1n);
    assert.equal(event!.args.skipped, 2n);
  });

  it('one unreadable genesis in a readable page does not strand the rest', async () => {
    const good = genesis('half-good');
    const bad = genesis('half-bad');
    const halfBroken = await viem.deployContract('HalfBrokenOldModule', [good, bad]);

    await absorb(p, halfBroken.address, 0n, 10n);

    assert.equal(await p.fresh.read.count(), 1n);
    assert.equal(await p.fresh.read.isDraft([good]), true);
    assert.equal(await p.fresh.read.isDraft([bad]), false);

    const [stamps, cids] = await p.fresh.read.history([good]);
    assert.deepEqual([...cids], ['bafy-old-v1', 'bafy-old-v2']);
    assert.deepEqual([...stamps], [1_700_000_001n, 1_700_000_002n]);

    const [event] = await absorbedEvents(p);
    assert.equal(event!.args.genesisCount, 2n);
    assert.equal(event!.args.versionCount, 2n);
    assert.equal(event!.args.skipped, 1n);
  });
});
