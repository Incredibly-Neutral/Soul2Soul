import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeErrorResult, getAddress, parseAbi, zeroAddress } from 'viem';

/**
 * Factory suite: the CREATE2 prediction views against the deployment they
 * predict. Same style as `DraftsModuleV1.test.ts` — hardhat 3 + `node:test` +
 * viem, going through the factory because Hardhat only emits artifacts for
 * `src` and the OZ proxy is not deployable by name here.
 *
 * Each test reads the prediction, then creates, then compares. Nothing here
 * recomputes the CREATE2 hash in TypeScript: a reimplementation in the test
 * would agree with a wrong contract, so the assertion is prediction versus the
 * proxy the factory actually produced.
 */

const { viem } = await network.create();

const publicClient = await viem.getPublicClient();

type Hex = `0x${string}`;
type Deployment = Awaited<ReturnType<typeof deployFactory>>;

/** Compare addresses as checksummed strings; the chain decodes either casing. */
const same = (a: Hex, b: Hex) => assert.equal(getAddress(a), getAddress(b));

const ERROR_ABI = parseAbi(['error ZeroAddress()', 'error SafeCallFailed()']);
const ZERO_ADDRESS_ERROR = encodeErrorResult({ abi: ERROR_ABI, errorName: 'ZeroAddress' });
const SAFE_CALL_FAILED_ERROR = encodeErrorResult({ abi: ERROR_ABI, errorName: 'SafeCallFailed' });

/** viem wraps reverts: raw revert data and reason strings all live on the cause chain. */
function revertText(error: unknown): string {
  const parts: string[] = [];
  for (let e = error as any; e; e = e.cause) {
    if (typeof e.raw === 'string') parts.push(e.raw);
    if (typeof e.message === 'string') parts.push(e.message);
  }
  return parts.join('\n');
}

async function assertReverts(call: Promise<unknown>, expected: string) {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a revert matching ${expected}, but the call succeeded`);
  const text = revertText(caught);
  assert.ok(
    text.includes(expected),
    `expected revert data ${expected}, got:\n${text.slice(0, 500)}`,
  );
}

async function deployFactory() {
  const [deployer, ownerOne, ownerTwo, stranger] = await viem.getWalletClients();

  // A history proxy reads the Safe during `initialize`, so both test Safes are
  // `MockSafe` contracts: an EOA has no `getOwners()` and the create would
  // revert `SafeCallFailed` before any address existed worth predicting. The
  // drafts module would accept an EOA, and using the same two Safes for both
  // roles is what makes the four-prediction test a real cross-product.
  const owners = [ownerOne.account.address, ownerTwo.account.address];
  const safeA = await viem.deployContract('MockSafe', [owners]);
  const safeB = await viem.deployContract('MockSafe', [owners]);

  const draftsImplementation = await viem.deployContract('DraftsModuleV1');
  const historyImplementation = await viem.deployContract('OwnerHistoryModuleV1');
  const factory = await viem.deployContract('AuthorContractsFactory', [
    draftsImplementation.address,
    historyImplementation.address,
  ]);

  return {
    factory,
    draftsImplementation,
    historyImplementation,
    safeAContract: safeA,
    deployer: deployer.account.address,
    safeA: safeA.address,
    safeB: safeB.address,
    stranger: stranger.account,
  };
}

/** Create one drafts proxy and return both the predicted and deployed address. */
async function createDrafts(d: Deployment, safe: Hex) {
  const predicted = await d.factory.read.draftsModuleAddress([safe]);
  await d.factory.write.createDraftsModule([safe]);
  const modules = await d.factory.read.getDraftsModulesForSafe([safe]);
  return { predicted, deployed: modules[modules.length - 1]! };
}

/** Create one history proxy plus its guard; the prediction covers the proxy only. */
async function createHistory(d: Deployment, safe: Hex) {
  const predicted = await d.factory.read.ownerHistoryModuleAddress([safe]);
  await d.factory.write.createOwnerHistoryModule([safe]);
  const modules = await d.factory.read.getOwnerHistoryModulesForSafe([safe]);
  const proxy = modules[modules.length - 1]!;
  return { predicted, deployed: proxy, guard: await d.factory.read.guardFor([proxy]) };
}

describe('AuthorContractsFactory', () => {
  let d: Deployment;

  beforeEach(async () => {
    d = await deployFactory();
  });

  it('the prediction equals the deployed proxy for a fresh Safe, both roles', async () => {
    const drafts = await createDrafts(d, d.safeA);
    same(drafts.deployed, drafts.predicted);

    const history = await createHistory(d, d.safeA);
    same(history.deployed, history.predicted);

    // Both proxies are distinct even though they share a Safe and a nonce: the
    // salt carries the role.
    assert.notEqual(getAddress(drafts.deployed), getAddress(history.deployed));

    // And what was deployed is the real module, not just an address that agreed.
    const draftsModule = await viem.getContractAt('DraftsModuleV1', drafts.deployed);
    same(await draftsModule.read.safe(), d.safeA);
    const historyModule = await viem.getContractAt('OwnerHistoryModuleV1', history.deployed);
    same(await historyModule.read.safe(), d.safeA);
    assert.notEqual(getAddress(history.guard), getAddress(history.deployed));
  });

  it('a prediction read before any create equals what that create deploys', async () => {
    // Nothing has been created yet for either Safe.
    const draftsBefore = await d.factory.read.draftsModuleAddress([d.safeB]);
    const historyBefore = await d.factory.read.ownerHistoryModuleAddress([d.safeB]);

    await d.factory.write.createDraftsModule([d.safeB]);
    await d.factory.write.createOwnerHistoryModule([d.safeB]);

    const drafts = await d.factory.read.getDraftsModulesForSafe([d.safeB]);
    const history = await d.factory.read.getOwnerHistoryModulesForSafe([d.safeB]);
    assert.equal(drafts.length, 1);
    assert.equal(history.length, 1);
    same(drafts[0]!, draftsBefore);
    same(history[0]!, historyBefore);
  });

  it('four predictions — two Safes, two roles — are four distinct addresses', async () => {
    const addresses = [
      await d.factory.read.draftsModuleAddress([d.safeA]),
      await d.factory.read.ownerHistoryModuleAddress([d.safeA]),
      await d.factory.read.draftsModuleAddress([d.safeB]),
      await d.factory.read.ownerHistoryModuleAddress([d.safeB]),
    ].map(getAddress);

    assert.equal(new Set(addresses).size, 4, `collision among ${addresses.join(', ')}`);

    // The prediction is stable while nothing intervenes: reading it twice, or
    // reading drafts and then history, does not move it.
    same(await d.factory.read.draftsModuleAddress([d.safeA]), addresses[0]!);
    same(await d.factory.read.draftsModuleAddress([d.safeB]), addresses[2]!);
  });

  it('a second create for the same Safe moves the address, and each create matches its own prediction', async () => {
    const first = await createDrafts(d, d.safeA);
    same(first.deployed, first.predicted);

    const secondPrediction = await d.factory.read.draftsModuleAddress([d.safeA]);
    assert.notEqual(getAddress(secondPrediction), getAddress(first.deployed));

    await d.factory.write.createDraftsModule([d.safeA]);
    const modules = await d.factory.read.getDraftsModulesForSafe([d.safeA]);
    assert.equal(modules.length, 2);
    same(modules[1]!, secondPrediction);
    same(modules[0]!, first.deployed);

    // Same for the history pair: the proxy moves, and the guard is fresh.
    const firstHistory = await createHistory(d, d.safeA);
    const secondHistory = await createHistory(d, d.safeA);
    same(firstHistory.deployed, firstHistory.predicted);
    same(secondHistory.deployed, secondHistory.predicted);
    assert.notEqual(getAddress(firstHistory.deployed), getAddress(secondHistory.deployed));
    assert.notEqual(getAddress(firstHistory.guard), getAddress(secondHistory.guard));
    same(await d.factory.read.guardFor([firstHistory.deployed]), firstHistory.guard);
    same(await d.factory.read.guardFor([secondHistory.deployed]), secondHistory.guard);
  });

  it('the index and event behaviour is unchanged', async () => {
    const drafts = await createDrafts(d, d.safeA);
    const draftsLogs = await publicClient.getContractEvents({
      address: d.factory.address,
      abi: d.factory.abi,
      eventName: 'DraftsModuleCreated',
      args: { safe: d.safeA },
      fromBlock: 0n,
    });
    assert.equal(draftsLogs.length, 1);
    same(draftsLogs[0]!.args.moduleProxy!, drafts.deployed);
    same(draftsLogs[0]!.args.implementation!, d.draftsImplementation.address);
    assert.equal((await d.factory.read.getDraftsModulesForSafe([d.safeA])).length, 1);

    const history = await createHistory(d, d.safeA);
    const historyLogs = await publicClient.getContractEvents({
      address: d.factory.address,
      abi: d.factory.abi,
      eventName: 'OwnerHistoryModuleCreated',
      args: { safe: d.safeA },
      fromBlock: 0n,
    });
    assert.equal(historyLogs.length, 1);
    same(historyLogs[0]!.args.moduleProxy!, history.deployed);
    same(historyLogs[0]!.args.guard!, history.guard);
    same(historyLogs[0]!.args.implementation!, d.historyImplementation.address);
    same(await d.factory.read.guardFor([history.deployed]), history.guard);

    const historyModules = await d.factory.read.getOwnerHistoryModulesForSafe([d.safeA]);
    assert.equal(historyModules.length, 1);
    same(historyModules[0]!, history.deployed);

    // The stranger's create lands too: permissionless creation is unchanged, and
    // it takes the next nonce, which is the case the prediction is exact for.
    await d.factory.write.createDraftsModule([d.safeA], { account: d.stranger });
    assert.equal((await d.factory.read.getDraftsModulesForSafe([d.safeA])).length, 2);
  });

  it('setDraftsImplementation moves the prediction, and the next create lands on it', async () => {
    const before = await createDrafts(d, d.safeA);
    same(before.deployed, before.predicted);

    const oldPrediction = await d.factory.read.draftsModuleAddress([d.safeA]);
    const next = await viem.deployContract('DraftsModuleV1');
    await d.factory.write.setDraftsImplementation([next.address]);

    const movedPrediction = await d.factory.read.draftsModuleAddress([d.safeA]);
    assert.notEqual(getAddress(movedPrediction), getAddress(oldPrediction));

    await d.factory.write.createDraftsModule([d.safeA]);
    const modules = await d.factory.read.getDraftsModulesForSafe([d.safeA]);
    same(modules[modules.length - 1]!, movedPrediction);

    // The moved proxy runs the new implementation's code, which is why the code
    // hash had to change with it.
    const module = await viem.getContractAt('DraftsModuleV1', movedPrediction);
    same(await module.read.safe(), d.safeA);

    // The history pointer is untouched: the two implementations stay separate.
    same(await d.factory.read.ownerHistoryImplementation(), d.historyImplementation.address);
  });

  it('the prediction answers for inputs no create can realise', async () => {
    // Two of them, documented on the views: a zero Safe, and a contract that
    // cannot answer getOwners(). Both make `initialize` revert, so no address is
    // ever occupied, while the view still returns the arithmetic answer.
    const predicted = await d.factory.read.draftsModuleAddress([zeroAddress]);
    assert.notEqual(getAddress(predicted), getAddress(zeroAddress));

    await assertReverts(
      d.factory.write.createDraftsModule([zeroAddress]),
      ZERO_ADDRESS_ERROR,
    );
    // Nothing was indexed, and the counter did not move: the revert took the
    // whole call with it.
    assert.equal((await d.factory.read.getDraftsModulesForSafe([zeroAddress])).length, 0);
    same(await d.factory.read.draftsModuleAddress([zeroAddress]), predicted);

    await assertReverts(
      d.factory.write.createOwnerHistoryModule([zeroAddress]),
      ZERO_ADDRESS_ERROR,
    );

    // A contract with no getOwners(): the history module reads the Safe inside
    // initialize, gets no answer, and reverts. The drafts module would accept it,
    // which is why the prediction is not a statement that a proxy exists.
    const notASafe = await viem.deployContract('DraftsModuleV1');
    const historyPrediction = await d.factory.read.ownerHistoryModuleAddress([notASafe.address]);
    assert.notEqual(getAddress(historyPrediction), getAddress(zeroAddress));

    await assertReverts(
      d.factory.write.createOwnerHistoryModule([notASafe.address]),
      SAFE_CALL_FAILED_ERROR,
    );
    assert.equal(
      (await d.factory.read.getOwnerHistoryModulesForSafe([notASafe.address])).length,
      0,
    );
    // The prediction did not move with the failed create.
    same(
      await d.factory.read.ownerHistoryModuleAddress([notASafe.address]),
      historyPrediction,
    );
  });
});
