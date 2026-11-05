import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { getAddress, keccak256, toHex, zeroAddress, zeroHash } from 'viem';

/**
 * First contract test suite in the repo — establishes the pattern:
 * hardhat 3 + `node:test` + the hardhat-viem / network-helpers plugins.
 * `pnpm test` runs `hardhat test`, which dispatches to the node test runner.
 */

const { viem, networkHelpers } = await network.create();

const genesis = (label: string) => keccak256(toHex(label));

/** An unknown genesis is a `bytes32(0)` Entry, so tests need one that is never appended. */
const UNKNOWN = genesis('never-appended');

type Deployment = Awaited<ReturnType<typeof deployDrafts>>;

/**
 * Deploy the implementation, the factory, and one proxy for `safe` — the
 * module's only writer. Going through the factory is also what production does,
 * and Hardhat only emits artifacts for `src`, so the OZ proxy is not deployable
 * by name here.
 */
async function deployDrafts() {
  const [deployer, safe, stranger] = await viem.getWalletClients();

  const implementation = await viem.deployContract('DraftsModuleV1');
  const factory = await viem.deployContract('DraftsModuleV1Factory', [implementation.address]);

  await factory.write.createModule([safe.account.address]);
  const modules = await factory.read.getModulesForSafe([safe.account.address]);
  const drafts = await viem.getContractAt('DraftsModuleV1', modules[0]!);

  return { drafts, implementation, factory, deployer, safe, stranger };
}

/** Append from the Safe — the only caller `append` accepts. */
async function appendAsSafe(d: Deployment, hash: `0x${string}`, cid: string) {
  await d.drafts.write.append([hash, cid], { account: d.safe.account });
}

/** viem returns the named struct fields as an object, not a tuple. */
async function fetch(d: Deployment, hash: `0x${string}`) {
  return d.drafts.read.fetch([hash]);
}

describe('DraftsModuleV1', () => {
  let d: Deployment;

  beforeEach(async () => {
    d = await deployDrafts();
  });

  it('initializes: safe is the writer, NAME is the discovery string, log is empty', async () => {
    assert.equal(getAddress(await d.drafts.read.safe()), getAddress(d.safe.account.address!));
    assert.equal(await d.drafts.read.NAME(), 'S2S Drafts Module V1');
    assert.equal(await d.drafts.read.count(), 0n);
    assert.equal(await d.drafts.read.versionCount([UNKNOWN]), 0n);
  });

  it('append binds the author and pushes the genesis onto the log', async () => {
    const hash = genesis('draft-a');
    await appendAsSafe(d, hash, 'bafy-draft-a-v1');

    assert.equal(await d.drafts.read.isDraft([hash]), true);
    assert.equal(getAddress(await d.drafts.read.authorOf([hash])), getAddress(d.safe.account.address!));
    assert.equal(await d.drafts.read.count(), 1n);
    assert.equal(await d.drafts.read.versionCount([hash]), 1n);

    const entry = await fetch(d, hash);
    assert.equal(entry.genesis, hash);
    assert.equal(getAddress(entry.author), getAddress(d.safe.account.address!));
    assert.equal(entry.cid, 'bafy-draft-a-v1');
    assert.equal(entry.versionCount, 1n);
    assert.ok(entry.timestamp > 0n);
  });

  it('append from a non-safe reverts OnlySafe, and bad input reverts its own error', async () => {
    const hash = genesis('draft-a');

    await assert.rejects(
      d.drafts.write.append([hash, 'bafy-draft-a-v1'], { account: d.stranger.account }),
      /OnlySafe/,
    );

    await assert.rejects(appendAsSafe(d, zeroHash, 'bafy-nope'), /ZeroHash/);
    await assert.rejects(appendAsSafe(d, hash, ''), /EmptyCid/);

    assert.equal(await d.drafts.read.count(), 0n);
    assert.equal(await d.drafts.read.isDraft([hash]), false);
  });

  it('repeated append accumulates versions in order with increasing timestamps', async () => {
    const hash = genesis('draft-a');
    const cids = ['bafy-v1', 'bafy-v2', 'bafy-v3'];

    const stamps: bigint[] = [];
    for (const cid of cids) {
      stamps.push(await networkHelpers.time.latest());
      await appendAsSafe(d, hash, cid);
      await networkHelpers.time.increase(60);
    }

    assert.equal(await d.drafts.read.count(), 1n);
    assert.equal(await d.drafts.read.versionCount([hash]), 3n);

    const [timestamps, historyCids] = await d.drafts.read.history([hash]);
    assert.deepEqual([...historyCids], cids);
    assert.equal(timestamps.length, 3);
    assert.ok(timestamps[0] >= stamps[0]);
    assert.ok(timestamps[1] > timestamps[0]);
    assert.ok(timestamps[2] > timestamps[1]);

    // fetch returns the LATEST version, not the first.
    const entry = await fetch(d, hash);
    assert.equal(entry.cid, 'bafy-v3');
    assert.equal(entry.timestamp, timestamps[2]);
    assert.equal(entry.versionCount, 3n);
  });

  it('fetch on an unknown genesis returns a zeroed Entry instead of reverting', async () => {
    const entry = await fetch(d, UNKNOWN);

    assert.equal(entry.versionCount, 0n);
    assert.equal(entry.genesis, zeroHash);
    assert.equal(entry.author, zeroAddress);
    assert.equal(entry.cid, '');
    assert.equal(entry.timestamp, 0n);

    const [timestamps, cids] = await d.drafts.read.history([UNKNOWN]);
    assert.equal(timestamps.length, 0);
    assert.equal(cids.length, 0);
  });

  it('fetchAll is in insertion order and fetchAllPaged pages it', async () => {
    const hashes = [genesis('a'), genesis('b'), genesis('c'), genesis('d')];
    for (const [i, hash] of hashes.entries()) {
      await appendAsSafe(d, hash, `bafy-${i}`);
    }
    // A second version on the first one must not move it in the list.
    await appendAsSafe(d, hashes[0], 'bafy-0-v2');

    assert.equal(await d.drafts.read.count(), 4n);

    const all = await d.drafts.read.fetchAll();
    assert.deepEqual(
      all.map((e) => e.genesis),
      hashes,
    );
    assert.deepEqual(
      all.map((e) => e.cid),
      ['bafy-0-v2', 'bafy-1', 'bafy-2', 'bafy-3'],
    );
    assert.deepEqual(
      all.map((e) => e.versionCount),
      [2n, 1n, 1n, 1n],
    );

    const middle = await d.drafts.read.fetchAllPaged([1n, 2n]);
    assert.deepEqual(
      middle.map((e) => e.genesis),
      [hashes[1], hashes[2]],
    );

    const tail = await d.drafts.read.fetchAllPaged([3n, 10n]);
    assert.deepEqual(
      tail.map((e) => e.genesis),
      [hashes[3]],
    );

    assert.deepEqual(await d.drafts.read.fetchAllPaged([10n, 2n]), []);
    assert.deepEqual(await d.drafts.read.fetchAllPaged([0n, 0n]), []);
  });

  it('factory createModule yields a working proxy for the Safe', async () => {
    assert.equal(getAddress(await d.factory.read.latestImplementation()), getAddress(d.implementation.address));
    assert.equal(await d.factory.read.implementationCount(), 1n);
    assert.equal(getAddress(await d.factory.read.getImplementationByVersion([1n])), getAddress(d.implementation.address));

    const modules = await d.factory.read.getModulesForSafe([d.safe.account.address]);
    assert.equal(modules.length, 1);

    const module = await viem.getContractAt('DraftsModuleV1', modules[0]!);
    assert.equal(getAddress(await module.read.safe()), getAddress(d.safe.account.address!));

    const hash = genesis('draft-via-factory');
    await module.write.append([hash, 'bafy-factory'], { account: d.safe.account });

    const entry = await module.read.fetch([hash]);
    assert.equal(entry.cid, 'bafy-factory');
    assert.equal(entry.versionCount, 1n);
    assert.equal(await module.read.count(), 1n);

    await assert.rejects(
      module.write.append([hash, 'bafy-stranger'], { account: d.stranger.account }),
      /OnlySafe/,
    );
  });
});
