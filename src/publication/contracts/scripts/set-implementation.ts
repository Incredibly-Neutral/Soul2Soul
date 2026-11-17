/**
 * Set the V6 factory's implementation, one kind at a time.
 *
 * `setImplementation(bytes32 kind, address impl)` is the privileged half of the
 * deploy: S2SPublicationModulesFactoryV6 accepts it only from its immutable
 * `protocolSafe`. It moves nothing. New modules of that kind are built over the
 * implementation; every module already deployed keeps its address and its
 * storage, and moves only when its own Safe calls `upgradeToAndCall`.
 *
 * Kinds are separate all the way down: implementations are approved per kind,
 * `latestImplementation` is per kind, and an implementation declares its kind.
 * A records implementation set for the publication kind is a mismatch the
 * factory refuses, so this script names one implementation per kind and runs the
 * same checks the factory runs before proposing anything. Those checks are:
 * code present, `factory()` equal to this factory, `moduleKind()` equal to the
 * kind, `proxiableUUID()` equal to the ERC-1967 slot, and the implementation not
 * revoked. Failing one is a sentence, not a revert after a Safe signature.
 *
 * A kind already at the named implementation, and approved for it, is skipped
 * with one line: setting it again writes the same pointer and emits an event
 * that would look like a deploy.
 *
 * The signing key only decides how the call travels. When it is the protocol
 * Safe, each call is sent and then verified against `latestImplementation` and
 * `isApproved`. Otherwise the calls are proposed to the Safe service as one
 * batch, so the owners confirm once in the Safe app: the safeTxHash is printed
 * and nothing changes until that Safe executes it. A `createModule` for an
 * affected kind reverts `NoImplementation(kind)` in the meantime.
 *
 * Whether a key may propose is the service's answer, not a local check: the
 * proposal is attempted, as update-protocol.ts does with the same key. A refusal
 * prints the batch and the service's own message, so the call still reaches an
 * owner.
 *
 * Output is split. The narrative goes to stderr, so stdout carries only what a
 * machine can paste: the Safe Transaction Builder batch (`--format batch`) or the
 * calldata (`--format data`). `--dry-run` is the batch, without proposing. Either
 * shape prints instead of proposing or sending, whoever holds the key. The default
 * is text, which proposes and prints only the narrative.
 *
 * This is the V6 pair only. The V4/V5 scripts beside it encode different
 * selectors against different factories and cannot be adapted by changing an
 * address.
 *
 * Usage:
 *   cd src/publication/contracts
 *   pnpm set:impl [--kind publication|records] [--format text|batch|data] [--dry-run]
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY               key that proposes or sends the call
 *   PROTOCOL_SAFE_ADDRESS              the safe the factory must answer
 *   PUBLICATION_FACTORY_ADDRESS        the V6 factory, as printed by pnpm deploy:factory
 *   PUBLICATION_IMPLEMENTATION_ADDRESS optional: the publication-kind module
 *   RECORDS_IMPLEMENTATION_ADDRESS     optional: the records-kind module
 *   BASE_RPC_URL / VITE_DRPC_API_KEY   optional RPC override
 *
 * After a deploy, put PUBLICATION_FACTORY_ADDRESS in .env and write the
 * publication_factory record with:
 *   tsx src/press/scripts/lit/update-protocol.ts
 * That record is what every client reads, so it names the factory this script
 * set, not an older one.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
} from 'viem';
import type { Account, Abi, HttpTransport, PublicClient, WalletClient } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import Safe from '@safe-global/protocol-kit';
import SafeApiKit from '@safe-global/api-kit';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(__dirname, '../artifacts');

type Wallet = WalletClient<HttpTransport, typeof base, Account>;
type Pub = PublicClient<HttpTransport, typeof base>;

const FACTORY_NAME = 'S2SPublicationModulesFactoryV6';

const FACTORY_ENV = 'PUBLICATION_FACTORY_ADDRESS';

/** OZ 4.9 UUPS: the slot every proxiable implementation must answer with. */
const ERC1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const MODULE_ABI = parseAbi([
  'function factory() view returns (address)',
  'function moduleKind() view returns (bytes32)',
  'function proxiableUUID() view returns (bytes32)',
]);

const SAFE_ABI = parseAbi([
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);

const PUBLICATION_KIND = keccak256(toHex('s2s.module.publication'));
const RECORDS_KIND = keccak256(toHex('s2s.module.records'));

type KindName = 'publication' | 'records';
type Format = 'text' | 'batch' | 'data';

/** Where the calls go, once the key has decided. */
type Print = 'batch' | 'data' | null;

interface Target {
  name: KindName;
  kind: `0x${string}`;
  env: string;
  impl: `0x${string}` | null;
}

interface Proposed {
  target: Target & { impl: `0x${string}` };
  data: `0x${string}`;
}

/**
 * The RPC key rides in the last path segment. Nothing printed may carry it into
 * terminal scrollback, so only scheme, host and the provider's path prefix stay.
 */
function redactRpc(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/[^/]+$/, '***')}`;
  } catch {
    return 'the configured RPC';
  }
}

/** One refusal, one sentence, no stack trace. */
function refuse(sentence: string): never {
  console.error(`❌ ${sentence}`);
  process.exit(1);
}

function usage(message: string): never {
  console.error(`${message}\n`);
  console.error(
    'Usage: pnpm set:impl [--kind publication|records] [--format text|batch|data] [--dry-run]',
  );
  console.error('  the factory is PUBLICATION_FACTORY_ADDRESS in .env');
  console.error('  the implementations are PUBLICATION_IMPLEMENTATION_ADDRESS and');
  console.error('  RECORDS_IMPLEMENTATION_ADDRESS; a kind with no address is skipped');
  console.error('  --format batch|data or --dry-run prints the calls and proposes nothing');
  process.exit(1);
}

/**
 * Did the call itself revert?
 *
 * viem wraps every failure in a `CallExecutionError`, so the class says nothing:
 * a dead RPC and a revert on the dispatcher arrive as the same type. Only the
 * cause chain separates them — `ExecutionRevertedError` for a revert,
 * `HttpRequestError` for a transport failure. Reading the name keeps this free
 * of a version-pinned constructor identity.
 */
function isRevert(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; node && depth < 6; depth++) {
    if (node instanceof Error && node.name === 'ExecutionRevertedError') return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/** The service's own words, on one line: its messages arrive folded and padded. */
function serviceMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim();
}

/** Hardhat writes `<artifactRoot>/<sourceDir>/<Name>.sol/<Name>.json`. */
function findArtifact(name: string): string | null {
  const stack = [ARTIFACT_ROOT];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === `${name}.json`) return path;
      if (statSync(path).isDirectory()) stack.push(path);
    }
  }
  return null;
}

/** The factory's own ABI, so the selectors encoded here are the compiled ones. */
function factoryAbi(name: string): Abi {
  const path = findArtifact(name);
  if (!path)
    refuse(`No artifact for ${name} under ${ARTIFACT_ROOT}, so the factory ABI is unknown.`);
  const artifact = JSON.parse(readFileSync(path, 'utf-8'));
  return artifact.abi as Abi;
}

function parseArgs(argv: string[]): { kind: KindName | null; format: Format; dryRun: boolean } {
  let kind: KindName | null = null;
  let format: Format = 'text';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--kind' || arg.startsWith('--kind=')) {
      const value = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      if (value !== 'publication' && value !== 'records') {
        usage(`--kind takes publication or records, not ${value ?? 'nothing'}.`);
      }
      kind = value;
      continue;
    }

    if (arg === '--format' || arg.startsWith('--format=')) {
      const value = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      if (value !== 'text' && value !== 'batch' && value !== 'data') {
        usage(`--format takes text, batch or data, not ${value ?? 'nothing'}.`);
      }
      format = value;
      continue;
    }

    usage(`Unknown argument ${arg}.`);
  }

  return { kind, format, dryRun };
}

async function safeFacts(
  safe: `0x${string}`,
  publicClient: Pub,
): Promise<{ threshold: string; owners: string }> {
  try {
    const [threshold, owners] = await Promise.all([
      publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getThreshold' }),
      publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }),
    ]);
    return { threshold: String(threshold), owners: owners.join(', ') };
  } catch {
    return {
      threshold: 'unreadable (the address did not answer getThreshold())',
      owners: 'unreadable (the address did not answer getOwners())',
    };
  }
}

async function main() {
  const { kind: kindFilter, format, dryRun } = parseArgs(process.argv.slice(2));

  // stdout carries only machine output: the batch or the calldata. Every line a
  // person reads goes here.
  const note = (line = ''): void => console.error(line);

  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) refuse('PROTOCOL_PRIVATE_KEY is not set, so there is no account to sign or derive.');

  const factoryEnv = process.env[FACTORY_ENV];
  if (!factoryEnv) {
    refuse(
      `${FACTORY_ENV} is not set, so there is no factory; deploy one with pnpm deploy:factory and put the printed address in .env.`,
    );
  }
  if (!isAddress(factoryEnv)) refuse(`${FACTORY_ENV} is not an address: ${factoryEnv}`);
  const factory = getAddress(factoryEnv);

  const safeEnv = process.env.PROTOCOL_SAFE_ADDRESS;
  if (!safeEnv) {
    refuse('PROTOCOL_SAFE_ADDRESS is not set, so the factory cannot be checked against it.');
  }
  if (!isAddress(safeEnv)) refuse(`PROTOCOL_SAFE_ADDRESS is not an address: ${safeEnv}`);
  const expectedSafe = getAddress(safeEnv);

  // Either implementation variable may be absent; a kind with no address is not
  // this run's business. Both absent means there is nothing to set.
  const catalogue: Target[] = [
    {
      name: 'publication',
      kind: PUBLICATION_KIND,
      env: 'PUBLICATION_IMPLEMENTATION_ADDRESS',
      impl: null,
    },
    { name: 'records', kind: RECORDS_KIND, env: 'RECORDS_IMPLEMENTATION_ADDRESS', impl: null },
  ];

  const targets: Target[] = catalogue
    .filter((target) => !kindFilter || target.name === kindFilter)
    .map((target) => {
      const value = process.env[target.env];
      if (!value) return target;
      if (!isAddress(value)) refuse(`${target.env} is not an address: ${value}`);
      return { ...target, impl: getAddress(value) };
    });

  const selected = targets.filter((target): target is Target & { impl: `0x${string}` } =>
    Boolean(target.impl),
  );
  if (selected.length === 0) {
    refuse(
      `No implementation to set: neither PUBLICATION_IMPLEMENTATION_ADDRESS nor RECORDS_IMPLEMENTATION_ADDRESS${
        kindFilter ? ` names one for --kind ${kindFilter}` : ' is set'
      }.`,
    );
  }

  const abi = factoryAbi(FACTORY_NAME);

  const rpcUrl =
    process.env.BASE_RPC_URL ||
    (process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : 'https://mainnet.base.org');

  const payerHex = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(payerHex);

  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  note(`Signer: ${account.address}`);
  note(`   RPC:           ${redactRpc(rpcUrl)}`);
  note(`   Factory:       ${factory}`);
  note(`   Protocol safe: ${expectedSafe}`);
  note('');

  const chainId = await publicClient.getChainId().catch(() => 0);
  if (chainId !== base.id) refuse(`The RPC answered chain ${chainId}, not Base (${base.id}).`);

  const factoryCode = await publicClient.getCode({ address: factory });
  if (!factoryCode || factoryCode === '0x')
    refuse(`No contract at ${factory}, so nothing can be set.`);

  let safeAnswers: `0x${string}`;
  try {
    safeAnswers = (await publicClient.readContract({
      address: factory,
      abi,
      functionName: 'protocolSafe',
    })) as `0x${string}`;
  } catch (error) {
    if (!isRevert(error)) {
      refuse(`The RPC failed while reading protocolSafe() on ${factory}: ${reason(error)}`);
    }
    refuse(`${factory} has no protocolSafe(), so it is not the V6 factory.`);
  }
  if (getAddress(safeAnswers) !== expectedSafe) {
    refuse(
      `The factory answers protocolSafe() ${safeAnswers}, not PROTOCOL_SAFE_ADDRESS ${expectedSafe}.`,
    );
  }

  // Per kind: the approval set has to exist and the pointer has to be readable
  // before any implementation is judged against them. A zero-address probe is
  // enough for the selector: on this factory it returns false, and on a factory
  // without the set the call reverts, which is the whole signal.
  const latest = new Map<KindName, `0x${string}`>();
  for (const target of selected) {
    try {
      await publicClient.readContract({
        address: factory,
        abi,
        functionName: 'isApproved',
        args: [target.kind, zeroAddress],
      });
    } catch (error) {
      if (!isRevert(error)) {
        refuse(`The RPC failed while reading isApproved() on ${factory}: ${reason(error)}`);
      }
      refuse(`${factory} has no isApproved(bytes32,address), so it keeps no approval set to fill.`);
    }

    try {
      const current = (await publicClient.readContract({
        address: factory,
        abi,
        functionName: 'latestImplementation',
        args: [target.kind],
      })) as `0x${string}`;
      latest.set(target.name, getAddress(current));
    } catch (error) {
      if (!isRevert(error)) {
        refuse(
          `The RPC failed while reading latestImplementation(${target.name}) on ${factory}: ${reason(error)}`,
        );
      }
      refuse(
        `${factory} does not answer latestImplementation() for ${target.name}, so the pointer is unreadable.`,
      );
    }
  }

  // Validate every selected implementation before the first proposal, so a batch
  // is never printed with a target the factory would revert on.
  for (const target of selected) {
    const impl = target.impl;
    note(`Checking ${target.name} implementation ${impl}`);

    const code = await publicClient.getCode({ address: impl });
    if (!code || code === '0x') refuse(`No code at ${impl}, which ${target.env} names.`);

    let implFactory: `0x${string}`;
    try {
      implFactory = (await publicClient.readContract({
        address: impl,
        abi: MODULE_ABI,
        functionName: 'factory',
      })) as `0x${string}`;
    } catch (error) {
      if (!isRevert(error)) {
        refuse(`The RPC failed while reading factory() on ${impl}: ${reason(error)}`);
      }
      refuse(`${impl} has no factory(), so it cannot say which factory governs its upgrades.`);
    }
    if (getAddress(implFactory) !== factory) {
      refuse(`${impl} answers factory() ${implFactory}, not the factory being set.`);
    }

    let declared: `0x${string}`;
    try {
      declared = (await publicClient.readContract({
        address: impl,
        abi: MODULE_ABI,
        functionName: 'moduleKind',
      })) as `0x${string}`;
    } catch (error) {
      if (!isRevert(error)) {
        refuse(`The RPC failed while reading moduleKind() on ${impl}: ${reason(error)}`);
      }
      refuse(`${impl} has no moduleKind(), so the kind it belongs to is unknown.`);
    }
    if (declared.toLowerCase() !== target.kind.toLowerCase()) {
      refuse(`${impl} declares kind ${declared}, not the ${target.name} kind ${target.kind}.`);
    }

    let slot: `0x${string}`;
    try {
      slot = (await publicClient.readContract({
        address: impl,
        abi: MODULE_ABI,
        functionName: 'proxiableUUID',
      })) as `0x${string}`;
    } catch (error) {
      if (!isRevert(error)) {
        refuse(`The RPC failed while reading proxiableUUID() on ${impl}: ${reason(error)}`);
      }
      refuse(
        `${impl} has no proxiableUUID(), so a module that moves onto it could never move again.`,
      );
    }
    if (slot.toLowerCase() !== ERC1967_SLOT) {
      refuse(`${impl} answers proxiableUUID() ${slot}, not the ERC-1967 implementation slot.`);
    }

    const revoked = await publicClient.readContract({
      address: factory,
      abi,
      functionName: 'isRevoked',
      args: [target.kind, impl],
    });
    if (revoked) {
      refuse(
        `${impl} is revoked for the ${target.name} kind, and a revoked build cannot be set again.`,
      );
    }
  }

  // Skip what is already in place. Writing the same pointer again emits
  // ImplementationSet and reads like a change that did not happen.
  const proposals: Proposed[] = [];
  for (const target of selected) {
    const current = latest.get(target.name)!;
    const approved = await publicClient.readContract({
      address: factory,
      abi,
      functionName: 'isApproved',
      args: [target.kind, target.impl],
    });
    if (current === target.impl && approved) {
      const version = await publicClient.readContract({
        address: factory,
        abi,
        functionName: 'versionOf',
        args: [target.kind, target.impl],
      });
      note(
        `   Skipping ${target.name}: latestImplementation already ${target.impl} (version ${version}).`,
      );
      note('');
      continue;
    }
    proposals.push({
      target,
      data: encodeFunctionData({
        abi,
        functionName: 'setImplementation',
        args: [target.kind, target.impl],
      }),
    });
    note(`   ${target.name}: ${current} -> ${target.impl}`);
    note('');
  }

  if (proposals.length === 0) {
    note('Nothing to set: every selected kind already points at its implementation.');
    return;
  }

  const signerIsSafe = account.address.toLowerCase() === expectedSafe.toLowerCase();

  // One batch, every call: the owners confirm once, the way update-protocol.ts
  // does for the whole protocol. `--format` and `--dry-run` print instead of
  // proposing; `--format data` wins when both name a shape.
  const printAs: Print = format === 'data' ? 'data' : format === 'batch' || dryRun ? 'batch' : null;

  const printBatch = (): void => {
    const batch = {
      version: '1.0',
      chainId: String(base.id),
      createdAt: Date.now(),
      meta: {
        name: `Set S2S module implementation (${proposals.map((p) => p.target.name).join(', ')})`,
        description: proposals
          .map((p) => `setImplementation(${p.target.kind}, ${p.target.impl})`)
          .join('; '),
        txBuilderVersion: '1.16.5',
        createdFromSafeAddress: expectedSafe,
        createdFromOwnerAddress: '',
      },
      transactions: proposals.map((proposal) => ({
        to: factory,
        value: '0',
        data: proposal.data,
      })),
    };
    console.log(JSON.stringify(batch, null, 2));
  };

  const printData = (): void => {
    for (const proposal of proposals) console.log(proposal.data);
  };

  if (printAs) {
    if (printAs === 'data') printData();
    else printBatch();

    const facts = await safeFacts(expectedSafe, publicClient);
    note(
      signerIsSafe
        ? 'Nothing is sent: the run asked for the calls alone.'
        : 'The signer is not the protocol safe, so nothing is sent.',
    );
    note(`   chain id:  ${base.id}`);
    note(`   safe:      ${expectedSafe}`);
    note(`   threshold: ${facts.threshold}`);
    note(`   owners:    ${facts.owners}`);
    note('\nNothing changes until that safe executes it.');
    note(
      `Until then a createModule for ${
        proposals.length === 1 ? 'that kind' : 'those kinds'
      } reverts NoImplementation(kind) wherever no implementation is set yet.`,
    );
    return;
  }

  if (!signerIsSafe) {
    note('The signer is not the protocol safe, so the calls are proposed to it.');
    for (const proposal of proposals) {
      note(`   ${proposal.target.name}: to ${factory}`);
      note(`   data: ${proposal.data}`);
    }
    note('');

    const protocolKit = await Safe.init({
      provider: rpcUrl,
      signer: payerHex,
      safeAddress: expectedSafe,
    }).catch((error) =>
      refuse(
        `The Safe kit could not open ${expectedSafe} over ${redactRpc(rpcUrl)}: ${serviceMessage(error)}`,
      ),
    );

    const apiKit = new SafeApiKit({ chainId: 8453n });

    // Whether the key may propose is the service's call, not ours: a key that
    // cannot sign for this safe gets its rejection, and the batch is printed
    // instead, so the call is still there to hand to an owner.
    let safeTxHash: `0x${string}` | undefined;
    try {
      const safeTransaction = await protocolKit.createTransaction({
        transactions: proposals.map((proposal) => ({
          to: factory,
          value: '0',
          data: proposal.data,
        })),
      });
      const hash = await protocolKit.getTransactionHash(safeTransaction);
      const senderSignature = await protocolKit.signHash(hash);

      await apiKit.proposeTransaction({
        safeAddress: expectedSafe,
        safeTransactionData: safeTransaction.data,
        safeTxHash: hash,
        senderAddress: account.address,
        senderSignature: senderSignature.data,
      });
      safeTxHash = hash as `0x${string}`;
    } catch (error) {
      printBatch();
      note('');
      refuse(`The safe service refused the proposal: ${serviceMessage(error)}`);
    }

    if (!safeTxHash) refuse(`The safe service returned no transaction hash for the proposal.`);

    note(`✅ Proposed to ${expectedSafe}: ${proposals.length} setImplementation call(s).`);
    note(`   safeTxHash: ${safeTxHash}`);
    note('\nNothing changes until that safe executes it.');
    note(
      `Until then a createModule for ${
        proposals.length === 1 ? 'that kind' : 'those kinds'
      } reverts NoImplementation(kind) wherever no implementation is set yet.`,
    );
    return;
  }

  note('The signer is the protocol safe, so each call is sent.');
  for (const proposal of proposals) {
    const { target } = proposal;
    const hash = await walletClient.writeContract({
      address: factory,
      abi,
      functionName: 'setImplementation',
      args: [target.kind, target.impl],
    });
    note(`   ${target.name} setImplementation tx: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      refuse(`setImplementation for ${target.name} failed (status ${receipt.status}).`);
    }

    const current = getAddress(
      (await publicClient.readContract({
        address: factory,
        abi,
        functionName: 'latestImplementation',
        args: [target.kind],
      })) as `0x${string}`,
    );
    if (current !== target.impl) {
      refuse(`After the ${target.name} tx the factory reports ${current}, not ${target.impl}.`);
    }

    const approved = await publicClient.readContract({
      address: factory,
      abi,
      functionName: 'isApproved',
      args: [target.kind, target.impl],
    });
    if (!approved)
      refuse(`After the ${target.name} tx the factory does not approve ${target.impl}.`);

    const version = await publicClient.readContract({
      address: factory,
      abi,
      functionName: 'versionOf',
      args: [target.kind, target.impl],
    });
    note(`   ${target.name}: latest ${current}, approved, version ${version}`);
  }

  note('\nNew modules are built over the implementations above. Existing modules keep their');
  note('addresses and move only when their own safe calls upgradeToAndCall.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
