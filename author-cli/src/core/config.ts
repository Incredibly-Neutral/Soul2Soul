// ============================================================================
// Environment configuration for the CLI. Single source of the env surface;
// every adapter reads its settings from a CliConfig.
//
// Naming:
//   S2S_*       — CLI-specific settings
//   LIT_*       — Lit credentials (same names neutralpress/0xobsidian use)
//   GITHUB_TOKEN — GitHub API token (same name neutralpress uses)
//
// A `.env` in the current working directory is loaded by the CLI entrypoint
// before `loadConfig()` runs.
// ============================================================================

export type EntryPointVersion = '0.6' | '0.7';
export type FilecoinChain = 'mainnet' | 'calibration';

export interface FilecoinConfig {
  chain: FilecoinChain;
  /** Filecoin RPC (Synapse transport for the session signer). Defaults to a public GLIF endpoint. */
  rpcUrl: string;
  /** Path to a session-key.json (protocol-payer path). Mutually exclusive with privateKey. */
  sessionKeyPath: string | undefined;
  /** Filecoin signer private key (direct path). Mutually exclusive with sessionKeyPath. */
  privateKey: string | undefined;
}

export interface BundlerConfig {
  /** Pimlico/ERC-4337 bundler RPC URL (required for `new`). */
  baseUrl: string | undefined;
  /** Pimlico paymaster RPC URL (optional — gas sponsorship). */
  paymasterUrl: string | undefined;
  /** EntryPoint version the bundler serves. */
  entryPoint: EntryPointVersion;
}

export interface CliConfig {
  /** 'dev' → dev protocol gateways/factories + dev Lit; 'prod' → live (default). */
  environment: 'dev' | 'prod';
  /** EOA private key that signs author flows (Safe owner). Required for authoring. */
  privateKey: string | undefined;
  /** Lit master/network key (LitService account). Required for authoring. */
  litAccountKey: string | undefined;
  /** Lit usage key for action runs. Required for render paths. */
  litUsageKey: string | undefined;
  /** GitHub token used by the `new` command's assets/config build. */
  githubToken: string | undefined;
  /** Kubo RPC gateway. */
  kuboGateway: string;
  /** Kubo RPC bearer token (token-gated writes). */
  kuboToken: string | undefined;
  /** Pinata JWT for backup pinning. */
  pinataJwt: string | undefined;
  /** Pinata gateway. */
  pinataGateway: string | undefined;
  /** Filebase token for backup pinning. */
  filebaseToken: string | undefined;
  /** Lit-action runner URL (preview renders use the Bun runner). */
  runnerUrl: string;
  /** Explicit L1/L2 RPC URL lists (comma-separated), when overrides are wanted. */
  rpc: { L1: string[]; L2: string[] };
  /** Explicit ENS registry contract address, when the protocolInfo fallback must be overridden. */
  ensRegistry: string | undefined;
  filecoin: FilecoinConfig;
  bundler: BundlerConfig;
}

function envList(env: NodeJS.ProcessEnv, names: string[]): string[] {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }
  }
  return [];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const entryPoint = env.S2S_ENTRY_POINT === '0.7' ? '0.7' : '0.6';
  const filecoinChain: FilecoinChain = env.S2S_FILECOIN_CHAIN === 'calibration' ? 'calibration' : 'mainnet';
  const environment: 'dev' | 'prod' = env.S2S_ENV === 'dev' ? 'dev' : 'prod';

  return {
    environment,
    privateKey: env.S2S_PRIVATE_KEY,
    litAccountKey: env.LIT_ACCOUNT_KEY,
    litUsageKey: env.LIT_USAGE_KEY,
    githubToken: env.GITHUB_TOKEN ?? env.S2S_GITHUB_TOKEN,
    kuboGateway: env.S2S_KUBO_GATEWAY ?? 'ipfs.transport-union.dev',
    kuboToken: env.S2S_KUBO_TOKEN,
    pinataJwt: env.S2S_PINATA_JWT,
    pinataGateway: env.S2S_PINATA_GATEWAY,
    filebaseToken: env.S2S_FILEBASE_TOKEN,
    runnerUrl: env.S2S_RUNNER_URL ?? 'https://run.transport-union.dev/run',
    rpc: {
      L1: envList(env, ['S2S_RPC_L1', 'MAINNET_RPC_URL']),
      L2: envList(env, ['S2S_RPC_L2', 'BASE_RPC_URL']),
    },
    ensRegistry: env.S2S_ENS_REGISTRY,
    filecoin: {
      chain: filecoinChain,
      rpcUrl: env.S2S_FILECOIN_RPC ?? 'https://api.node.glif.io/rpc/v1',
      sessionKeyPath: env.S2S_FILECOIN_SESSION_KEY,
      privateKey: env.S2S_FILECOIN_PRIVATE_KEY,
    },
    bundler: {
      baseUrl: env.S2S_BUNDLER_URL,
      paymasterUrl: env.S2S_PAYMASTER_URL,
      entryPoint,
    },
  };
}

/** Required-setting helper — throws a clear, actionable error for a missing key. */
export function requireSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `Missing required setting \`${name}\`. Set it in the environment or in a .env file next to where you run the CLI.`,
    );
  }
  return value;
}
