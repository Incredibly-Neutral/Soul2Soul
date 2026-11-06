import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ConfigError, DEFAULT_ALLOWED_METHODS, loadConfig } from '../src/config.js';

const SECRET = 'a'.repeat(32);
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_LOWER = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TARGET = '0x0000000000000000000000000000000000000001';

const BASE_ENV: NodeJS.ProcessEnv = {
  PIMLICO_API_KEY: 'pim_test_key',
  PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_test_policy',
  ALLOWED_CHAIN_IDS: '84532,10',
  ALLOWED_CALLS: `${TARGET}:0xa9059cbb`,
  CORS_ORIGINS: 'https://app.example.com',
  AUTH_JWT_SECRET: SECRET,
};

function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...overrides };
}

function expectConfigError(input: NodeJS.ProcessEnv, matcher: RegExp): void {
  assert.throws(
    () => loadConfig(input),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
      assert.match(error.message, matcher);
      return true;
    },
  );
}

describe('loadConfig', () => {
  test('parses a full valid environment into the expected config', () => {
    const config = loadConfig(makeEnv());

    assert.equal(config.pimlicoApiKey, 'pim_test_key');
    assert.equal(config.sponsorshipPolicyId, 'sp_test_policy');
    assert.equal(config.pimlicoBaseUrl, 'https://api.pimlico.io');
    assert.deepEqual([...config.allowedChainIds], [84532, 10]);
    assert.deepEqual(config.allowedCalls, [{ target: TARGET, selector: '0xa9059cbb' }]);
    assert.equal(config.allowedMethods.size, DEFAULT_ALLOWED_METHODS.length);
    assert.ok(DEFAULT_ALLOWED_METHODS.every((method) => config.allowedMethods.has(method)));
    assert.equal(config.authMode, 'jwt');
    assert.equal(config.jwtSecret, SECRET);
    assert.equal(config.jwtIssuer, undefined);
    assert.equal(config.jwtAudience, undefined);
    assert.deepEqual(config.corsOrigins, ['https://app.example.com']);
    assert.equal(config.allowNativeValue, false);
    assert.equal(config.allowDeployment, false);
    assert.deepEqual(config.allowedFactories, []);
  });

  test('applies defaults for every optional variable', () => {
    const config = loadConfig(makeEnv());

    assert.equal(config.port, 8080);
    assert.equal(config.rateLimitPerMinute, 60);
    assert.equal(config.upstreamTimeoutMs, 15000);
    assert.equal(config.trustProxy, true);
    assert.equal(config.allowNativeValue, false);
    assert.equal(config.allowDeployment, false);
  });

  test('every required variable is reported by name when missing', () => {
    const requiredVars = [
      'PIMLICO_API_KEY',
      'PIMLICO_SPONSORSHIP_POLICY_ID',
      'ALLOWED_CHAIN_IDS',
      'ALLOWED_CALLS',
      'CORS_ORIGINS',
      'AUTH_JWT_SECRET',
    ];

    for (const name of requiredVars) {
      expectConfigError(makeEnv({ [name]: undefined }), new RegExp(`${name} is required`));
    }
  });

  test('an empty required variable counts as missing', () => {
    expectConfigError(makeEnv({ PIMLICO_API_KEY: '' }), /PIMLICO_API_KEY is required/);
    expectConfigError(makeEnv({ CORS_ORIGINS: '  ' }), /CORS_ORIGINS is required/);
  });

  test('rejects an invalid ALLOWED_CALLS address', () => {
    expectConfigError(makeEnv({ ALLOWED_CALLS: '0x1234:0xa9059cbb' }), /ALLOWED_CALLS.*address/);
  });

  test('rejects an invalid ALLOWED_CALLS selector', () => {
    expectConfigError(makeEnv({ ALLOWED_CALLS: `${TARGET}:0xa9059c` }), /ALLOWED_CALLS.*selector/);
  });

  test('rejects a non-positive chain id in ALLOWED_CALLS', () => {
    expectConfigError(makeEnv({ ALLOWED_CALLS: `0:${TARGET}:0xa9059cbb` }), /ALLOWED_CALLS/);
    expectConfigError(makeEnv({ ALLOWED_CALLS: `-1:${TARGET}:0xa9059cbb` }), /ALLOWED_CALLS/);
    expectConfigError(makeEnv({ ALLOWED_CALLS: `1.5:${TARGET}:0xa9059cbb` }), /ALLOWED_CALLS/);
  });

  test('rejects an ALLOWED_CALLS entry with an empty field', () => {
    expectConfigError(makeEnv({ ALLOWED_CALLS: `:0xa9059cbb` }), /ALLOWED_CALLS/);
    expectConfigError(makeEnv({ ALLOWED_CALLS: `${TARGET}:` }), /ALLOWED_CALLS/);
    expectConfigError(makeEnv({ ALLOWED_CALLS: `84532::0xa9059cbb` }), /ALLOWED_CALLS/);
    expectConfigError(makeEnv({ ALLOWED_CALLS: `${TARGET}:0xa9059cbb,` }), /ALLOWED_CALLS/);
  });

  test('rejects an ALLOWED_CALLS entry with too many fields', () => {
    expectConfigError(makeEnv({ ALLOWED_CALLS: `1:${TARGET}:0xa9059cbb:extra` }), /ALLOWED_CALLS/);
  });

  test('lowercases checksummed addresses and selectors', () => {
    const config = loadConfig(makeEnv({ ALLOWED_CALLS: `${USDC}:0xA9059CBB` }));

    assert.deepEqual(config.allowedCalls, [{ target: USDC_LOWER, selector: '0xa9059cbb' }]);
  });

  test('address:selector entries carry no chainId and chain-scoped entries do', () => {
    const config = loadConfig(
      makeEnv({ ALLOWED_CALLS: `${TARGET}:0xa9059cbb,84532:${TARGET}:0xdeadbeef` }),
    );

    assert.deepEqual(config.allowedCalls, [
      { target: TARGET, selector: '0xa9059cbb' },
      { chainId: 84532, target: TARGET, selector: '0xdeadbeef' },
    ]);
    assert.equal('chainId' in config.allowedCalls[0]!, false);
    assert.equal(config.allowedCalls[1]!.chainId, 84532);
  });

  test('accepts a "*" selector', () => {
    const config = loadConfig(makeEnv({ ALLOWED_CALLS: `${TARGET}:*` }));

    assert.deepEqual(config.allowedCalls, [{ target: TARGET, selector: '*' }]);
  });

  test('does not require an ALLOWED_CALLS chain id to be in ALLOWED_CHAIN_IDS', () => {
    const config = loadConfig(makeEnv({ ALLOWED_CALLS: `999:${TARGET}:0xa9059cbb` }));

    assert.deepEqual(config.allowedCalls, [
      { chainId: 999, target: TARGET, selector: '0xa9059cbb' },
    ]);
  });

  test('rejects a non-positive ALLOWED_CHAIN_IDS entry', () => {
    expectConfigError(makeEnv({ ALLOWED_CHAIN_IDS: '84532,0' }), /ALLOWED_CHAIN_IDS/);
    expectConfigError(makeEnv({ ALLOWED_CHAIN_IDS: 'abc' }), /ALLOWED_CHAIN_IDS/);
    expectConfigError(makeEnv({ ALLOWED_CHAIN_IDS: '1,' }), /ALLOWED_CHAIN_IDS/);
  });

  test('AUTH_MODE=none is refused in production and accepted elsewhere', () => {
    expectConfigError(
      makeEnv({ AUTH_MODE: 'none', NODE_ENV: 'production' }),
      /AUTH_MODE=none is not allowed when NODE_ENV is production/,
    );

    const config = loadConfig(makeEnv({ AUTH_MODE: 'none', AUTH_JWT_SECRET: undefined }));
    assert.equal(config.authMode, 'none');
    assert.equal(config.jwtSecret, undefined);
  });

  test('rejects an unknown AUTH_MODE', () => {
    expectConfigError(makeEnv({ AUTH_MODE: 'basic' }), /AUTH_MODE/);
  });

  test('rejects a JWT secret shorter than 32 characters', () => {
    expectConfigError(
      makeEnv({ AUTH_JWT_SECRET: 'short-secret' }),
      /AUTH_JWT_SECRET must be at least 32 characters/,
    );
  });

  test('AUTH_JWT_ISSUER and AUTH_JWT_AUDIENCE are only set when non-empty', () => {
    const withClaims = loadConfig(
      makeEnv({ AUTH_JWT_ISSUER: 'https://auth.example.com', AUTH_JWT_AUDIENCE: 'proxy' }),
    );
    assert.equal(withClaims.jwtIssuer, 'https://auth.example.com');
    assert.equal(withClaims.jwtAudience, 'proxy');

    const withoutClaims = loadConfig(makeEnv({ AUTH_JWT_ISSUER: '', AUTH_JWT_AUDIENCE: '  ' }));
    assert.equal(withoutClaims.jwtIssuer, undefined);
    assert.equal(withoutClaims.jwtAudience, undefined);
  });

  test('ALLOWED_METHODS override replaces the default list', () => {
    const config = loadConfig(makeEnv({ ALLOWED_METHODS: 'eth_chainId, eth_sendUserOperation' }));

    assert.deepEqual([...config.allowedMethods], ['eth_chainId', 'eth_sendUserOperation']);
    assert.equal(config.allowedMethods.has('pm_sponsorUserOperation'), false);
  });

  test('rejects an invalid boolean', () => {
    expectConfigError(makeEnv({ ALLOW_NATIVE_VALUE: 'maybe' }), /ALLOW_NATIVE_VALUE/);
    expectConfigError(makeEnv({ ALLOW_DEPLOYMENT: 'on' }), /ALLOW_DEPLOYMENT/);
    expectConfigError(makeEnv({ TRUST_PROXY: 'nope' }), /TRUST_PROXY/);
  });

  test('accepts every documented boolean spelling', () => {
    for (const raw of ['true', '1', 'yes', 'TRUE', ' Yes ']) {
      assert.equal(loadConfig(makeEnv({ ALLOW_DEPLOYMENT: raw })).allowDeployment, true, raw);
    }
    for (const raw of ['false', '0', 'no', 'FALSE']) {
      assert.equal(loadConfig(makeEnv({ TRUST_PROXY: raw })).trustProxy, false, raw);
    }
  });

  test('rejects an out-of-range or non-integer PORT', () => {
    expectConfigError(makeEnv({ PORT: '0' }), /PORT/);
    expectConfigError(makeEnv({ PORT: '65536' }), /PORT/);
    expectConfigError(makeEnv({ PORT: 'eighty' }), /PORT/);
    assert.equal(loadConfig(makeEnv({ PORT: '65535' })).port, 65535);
  });

  test('rejects a UPSTREAM_TIMEOUT_MS below 1000', () => {
    expectConfigError(makeEnv({ UPSTREAM_TIMEOUT_MS: '999' }), /UPSTREAM_TIMEOUT_MS/);
    expectConfigError(makeEnv({ UPSTREAM_TIMEOUT_MS: '1.5' }), /UPSTREAM_TIMEOUT_MS/);
    assert.equal(loadConfig(makeEnv({ UPSTREAM_TIMEOUT_MS: '1000' })).upstreamTimeoutMs, 1000);
  });

  test('rejects a RATE_LIMIT_PER_MINUTE below 1', () => {
    expectConfigError(makeEnv({ RATE_LIMIT_PER_MINUTE: '0' }), /RATE_LIMIT_PER_MINUTE/);
    assert.equal(loadConfig(makeEnv({ RATE_LIMIT_PER_MINUTE: '1' })).rateLimitPerMinute, 1);
  });

  test('rejects CORS origins with a path, trailing slash or wildcard', () => {
    expectConfigError(makeEnv({ CORS_ORIGINS: 'https://app.example.com/' }), /CORS_ORIGINS/);
    expectConfigError(makeEnv({ CORS_ORIGINS: 'https://app.example.com/app' }), /CORS_ORIGINS/);
    expectConfigError(makeEnv({ CORS_ORIGINS: '*' }), /CORS_ORIGINS/);
    expectConfigError(makeEnv({ CORS_ORIGINS: 'app.example.com' }), /CORS_ORIGINS/);
  });

  test('parses multiple CORS origins', () => {
    const config = loadConfig(
      makeEnv({ CORS_ORIGINS: 'https://app.example.com, http://localhost:5173' }),
    );

    assert.deepEqual(config.corsOrigins, ['https://app.example.com', 'http://localhost:5173']);
  });

  test('strips trailing slashes from PIMLICO_BASE_URL', () => {
    assert.equal(
      loadConfig(makeEnv({ PIMLICO_BASE_URL: 'https://api.pimlico.io///' })).pimlicoBaseUrl,
      'https://api.pimlico.io',
    );
    assert.equal(
      loadConfig(makeEnv({ PIMLICO_BASE_URL: 'https://api.pimlico.io/v2/' })).pimlicoBaseUrl,
      'https://api.pimlico.io/v2',
    );
  });

  test('rejects a plain-http PIMLICO_BASE_URL that is not localhost', () => {
    expectConfigError(
      makeEnv({ PIMLICO_BASE_URL: 'http://api.pimlico.io' }),
      /PIMLICO_BASE_URL must use https/,
    );
    assert.equal(
      loadConfig(makeEnv({ PIMLICO_BASE_URL: 'http://localhost:3000' })).pimlicoBaseUrl,
      'http://localhost:3000',
    );
  });

  test('lowercases ALLOWED_FACTORIES and returns an empty list when unset', () => {
    const config = loadConfig(makeEnv({ ALLOWED_FACTORIES: ` ${USDC} , ${TARGET} ` }));

    assert.deepEqual(config.allowedFactories, [USDC_LOWER, TARGET]);
  });

  test('rejects a malformed ALLOWED_FACTORIES address', () => {
    expectConfigError(makeEnv({ ALLOWED_FACTORIES: '0xnothex' }), /ALLOWED_FACTORIES/);
  });
});
