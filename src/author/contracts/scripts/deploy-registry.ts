/**
 * Deploy `S2SAuthorGate` and `S2SRegistry` on Base.
 *
 * The gate's four constructor values have no setter, so this script refuses to
 * run with an empty list or hash and refuses any chain that is not Base. The
 * values must be verified against the deployments on the chain this registry is
 * for — a wrong proxy code hash rejects every real Safe, a wrong singleton
 * accepts a proxy pointed at a fake implementation, and a wrong module proxy
 * hash rejects every real records module.
 *
 * Usage:
 *   cd src/author/contracts && pnpm deploy:registry
 *
 * Requires in .env:
 *   PROTOCOL_PRIVATE_KEY    deployer key, pays gas
 *   SAFE_SINGLETONS         comma-separated Safe singleton addresses
 *   SAFE_PROXY_CODEHASHES   comma-separated keccak256 of Safe's proxy runtime code
 *   AUTHOR_FACTORIES        comma-separated factories allowed to have made the module
 *   MODULE_PROXY_CODEHASH   keccak256 of the module proxy's runtime code
 *   GOVERNANCE_ADDRESS      the registry's governance; must have code, no default
 *
 * Optional:
 *   RESERVED_HANDLES        comma-separated seed names to reserve. The deployer
 *                           cannot call `reserve` unless it is the governance
 *                           address, so the script prints the exact `to`/`data`
 *                           to execute from governance.
 *
 * ── How to obtain the allowlists ────────────────────────────────────────────
 *
 * `SAFE_SINGLETONS`: the Safe singleton implementation(s) used on Base. Read
 * `masterCopy()` from a Safe proxy you trust on Base (the protocol Safe, for
 * example), or take the singleton for chain 8453 from Safe's own deployments.
 * If the deployment uses more than one Safe version, list every singleton those
 * proxies point at.
 *
 * `SAFE_PROXY_CODEHASHES`: `keccak256` of the runtime code of a Safe proxy on
 * Base, i.e. `keccak256(eth_getCode(<a known Safe proxy>))`. Do not hash the
 * creation code, and do not copy a hash from another chain: Safe deploys
 * different proxy bytecode per chain and per release.
 *
 * `AUTHOR_FACTORIES`: the `AuthorFactory` address(es) whose records modules this
 * gate accepts, plus any other factory the deployment uses for the records
 * kind. A module naming a factory outside this list is refused even when its
 * code and kind are correct.
 *
 * `MODULE_PROXY_CODEHASH`: `keccak256(eth_getCode(<records module>))` for a
 * module `AuthorFactory` created. The factory deploys OpenZeppelin's
 * `ERC1967Proxy`, so every records module it deploys shares that proxy runtime
 * code, and that is the value the gate compares. Do not use a creation-code
 * hash or `S2SModuleProxy`: those are different values.
 *
 * Re-verify all four after every Safe or module release. They are immutable in
 * the gate; a change needs a new gate and `setAuthorGate` on the registry.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '../../../.env') });

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactsRoot = resolve(__dirname, '../artifacts');

const REGISTRY_ABI = parseAbi([
  'function reserve(string[] handles)',
  'function authorGate() view returns (address)',
  'function governance() view returns (address)',
]);

/** Hardhat 3 writes `artifacts/src/<Name>.sol/<Name>.json`. */
function artifactPath(name: string): string {
  const candidates = [
    resolve(artifactsRoot, `src/${name}.sol/${name}.json`),
    resolve(artifactsRoot, `${name}.sol/${name}.json`),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`❌ Artifact not found. Looked in:\n   ${candidates.join('\n   ')}`);
    console.error('   Run `pnpm compile` first.');
    process.exit(1);
  }
  return found;
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  }).then((r) => r.json());
  if (response.error) {
    throw new Error(`${method}: ${response.error.message ?? JSON.stringify(response.error)}`);
  }
  return response.result as T;
}

async function waitForAddress(rpcUrl: string, hash: `0x${string}`): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const receipt = await rpc<{ contractAddress?: string } | null>(
      rpcUrl,
      'eth_getTransactionReceipt',
      [hash],
    );
    if (receipt?.contractAddress) return receipt.contractAddress;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error('❌ Timed out waiting for deploy receipt');
  process.exit(1);
}

type DeployClient = ReturnType<
  typeof createWalletClient<
    ReturnType<typeof http>,
    typeof base,
    ReturnType<typeof privateKeyToAccount>
  >
>;

async function deployArtifact(
  client: DeployClient,
  account: Account,
  label: string,
  artifact: { abi: unknown; bytecode: `0x${string}` },
  args: any[],
  rpcUrl: string,
): Promise<string> {
  if (!artifact.bytecode || artifact.bytecode === '0x') {
    console.error(`❌ No bytecode for ${label} — is it abstract?`);
    process.exit(1);
  }
  const hash = await client.deployContract({
    abi: artifact.abi as any,
    bytecode: artifact.bytecode,
    account,
    chain: base,
    args,
  });
  console.log(`   Deploy tx: ${hash}`);
  return waitForAddress(rpcUrl, hash);
}

function loadArtifact(name: string): { abi: unknown; bytecode: `0x${string}` } {
  return JSON.parse(readFileSync(artifactPath(name), 'utf-8'));
}

/**
 * The byte rules `register` and `reserve` apply, checked before anything is
 * sent: `reserve` validates the whole batch, so one bad seed would revert every
 * good one and leave nothing reserved.
 */
function handleProblem(handle: string): string | null {
  const bytes = new TextEncoder().encode(handle);
  if (bytes.length < 3 || bytes.length > 32) return `is ${bytes.length} bytes, not 3..32`;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const allowed =
      (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d;
    if (!allowed) return `has byte 0x${b.toString(16).padStart(2, '0')} at index ${i}`;
  }
  if (bytes[0] === 0x2d || bytes[bytes.length - 1] === 0x2d) {
    return 'starts or ends with a hyphen';
  }
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] === 0x2d && bytes[i - 1] === 0x2d) return 'has a doubled hyphen';
  }
  return null;
}

/** A comma-separated env value, trimmed, blanks dropped, duplicates removed. */
function listFromEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
}

async function main() {
  const pk = process.env.PROTOCOL_PRIVATE_KEY;
  if (!pk) {
    console.error('❌ PROTOCOL_PRIVATE_KEY not set');
    process.exit(1);
  }

  const singletonInputs = listFromEnv('SAFE_SINGLETONS');
  if (singletonInputs.length === 0) {
    console.error('❌ SAFE_SINGLETONS is empty. The gate has no admin: list the Safe singletons now.');
    process.exit(1);
  }
  const codehashInputs = listFromEnv('SAFE_PROXY_CODEHASHES');
  if (codehashInputs.length === 0) {
    console.error('❌ SAFE_PROXY_CODEHASHES is empty. The gate has no admin: list the proxy code hashes now.');
    process.exit(1);
  }

  const invalidSingleton = singletonInputs.find((value) => !isAddress(value));
  if (invalidSingleton) {
    console.error(`❌ SAFE_SINGLETONS contains a non-address: ${invalidSingleton}`);
    process.exit(1);
  }
  const singletons = singletonInputs.map((value) => getAddress(value)) as `0x${string}`[];

  const invalidCodehash = codehashInputs.find((value) => !/^0x[0-9a-fA-F]{64}$/.test(value));
  if (invalidCodehash) {
    console.error(`❌ SAFE_PROXY_CODEHASHES contains a non-bytes32 value: ${invalidCodehash}`);
    process.exit(1);
  }
  const codehashes = codehashInputs.map((value) => value.toLowerCase()) as `0x${string}`[];

  const factoryInputs = listFromEnv('AUTHOR_FACTORIES');
  if (factoryInputs.length === 0) {
    console.error('❌ AUTHOR_FACTORIES is empty. The gate has no admin: list the allowed factories now.');
    process.exit(1);
  }
  const invalidFactory = factoryInputs.find((value) => !isAddress(value));
  if (invalidFactory) {
    console.error(`❌ AUTHOR_FACTORIES contains a non-address: ${invalidFactory}`);
    process.exit(1);
  }
  const authorFactories = factoryInputs.map((value) => getAddress(value)) as `0x${string}`[];

  const moduleProxyInput = process.env.MODULE_PROXY_CODEHASH;
  if (!moduleProxyInput || !/^0x[0-9a-fA-F]{64}$/.test(moduleProxyInput)) {
    console.error('❌ MODULE_PROXY_CODEHASH not set or not a bytes32 (there is no default)');
    process.exit(1);
  }
  const moduleProxyCodehash = moduleProxyInput.toLowerCase() as `0x${string}`;

  const governanceInput = process.env.GOVERNANCE_ADDRESS;
  if (!governanceInput || !isAddress(governanceInput)) {
    console.error('❌ GOVERNANCE_ADDRESS not set or not an address (there is no default)');
    process.exit(1);
  }
  const governance = getAddress(governanceInput);

  const rpcUrl = process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
    : 'https://mainnet.base.org';

  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  const transport = http(rpcUrl);
  const client = createWalletClient({ account, chain: base, transport });
  const publicClient = createPublicClient({ chain: base, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== base.id) {
    console.error(`❌ RPC answers chainId ${chainId}, not Base (${base.id}). Refusing to deploy.`);
    process.exit(1);
  }

  const governanceCode = await publicClient.getCode({ address: governance });
  if (!governanceCode || governanceCode === '0x') {
    console.error(`❌ GOVERNANCE_ADDRESS ${governance} has no code (the registry requires code)`);
    process.exit(1);
  }

  for (const singleton of singletons) {
    const code = await publicClient.getCode({ address: singleton });
    if (!code || code === '0x') {
      console.error(`❌ SAFE_SINGLETONS entry ${singleton} has no code on Base`);
      process.exit(1);
    }
  }

  for (const factory of authorFactories) {
    const code = await publicClient.getCode({ address: factory });
    if (!code || code === '0x') {
      console.error(`❌ AUTHOR_FACTORIES entry ${factory} has no code on Base`);
      process.exit(1);
    }
  }

  console.log(`Deploying from ${account.address}`);
  console.log(`   Network: ${rpcUrl} (chainId ${chainId})`);
  console.log(`   Governance: ${governance}`);
  console.log(`   Singletons: ${singletons.join(', ')}`);
  console.log(`   Proxy code hashes: ${codehashes.join(', ')}\n`);

  console.log('1/2 Deploying S2SAuthorGate(singletons, proxyCodehashes, authorFactories, moduleProxyCodehash)...');
  const gate = await deployArtifact(
    client,
    account,
    'S2SAuthorGate',
    loadArtifact('S2SAuthorGate'),
    [singletons, codehashes, authorFactories, moduleProxyCodehash],
    rpcUrl,
  );
  console.log(`   ✅ S2SAuthorGate at ${gate}\n`);

  console.log('2/2 Deploying S2SRegistry(gate, governance)...');
  const registry = await deployArtifact(
    client,
    account,
    'S2SRegistry',
    loadArtifact('S2SRegistry'),
    [gate, governance],
    rpcUrl,
  );
  console.log(`   ✅ S2SRegistry at ${registry}\n`);

  const recordedGate = await publicClient.readContract({
    address: registry as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: 'authorGate',
  });
  const recordedGovernance = await publicClient.readContract({
    address: registry as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: 'governance',
  });
  if (getAddress(recordedGate) !== getAddress(gate)) {
    console.error(`❌ Registry ${registry} answers authorGate ${recordedGate}, not ${gate}`);
    process.exit(1);
  }
  if (getAddress(recordedGovernance) !== governance) {
    console.error(`❌ Registry ${registry} answers governance ${recordedGovernance}, not ${governance}`);
    process.exit(1);
  }

  const seeds = listFromEnv('RESERVED_HANDLES');
  const badSeed = seeds
    .map((seed) => [seed, handleProblem(seed)] as const)
    .find(([, problem]) => problem);
  if (badSeed) {
    console.error(`❌ RESERVED_HANDLES entry "${badSeed[0]}" ${badSeed[1]}. Nothing was sent.`);
    process.exit(1);
  }
  if (seeds.length > 0) {
    const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'reserve', args: [seeds] });
    if (account.address === governance) {
      console.log(`Reserving ${seeds.length} seed handle(s) from the deployer...`);
      const hash = await client.writeContract({
        address: registry as `0x${string}`,
        abi: REGISTRY_ABI,
        functionName: 'reserve',
        args: [seeds],
        account,
        chain: base,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        console.error(`❌ reserve reverted in ${hash}; nothing was reserved.`);
        process.exit(1);
      }
      console.log(`   ✅ Reserved in ${hash}\n`);
    } else {
      console.log(`Reserved seed list: ${seeds.length} name(s) from RESERVED_HANDLES.`);
      console.log('The deployer is not governance, so this is not sent. Execute from governance:');
      console.log(`   to:   ${registry}`);
      console.log(`   data: ${data}\n`);
    }
  }

  console.log('Deployed on Base:\n');
  console.log(`  S2SAuthorGate   ${gate}`);
  console.log(`  S2SRegistry     ${registry}\n`);
  console.log('Nothing else is installed. The registry is non-upgradeable and has no owner.');
  console.log('The gate values are immutable: re-verify them after any Safe or module release');
  console.log('and deploy a new gate plus setAuthorGate if the Safe proxy, a singleton, an');
  console.log('author factory or the module proxy code changes.');
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
