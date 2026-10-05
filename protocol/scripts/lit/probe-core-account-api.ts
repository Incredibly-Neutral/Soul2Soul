#!/usr/bin/env tsx

/**
 * Standalone Lit Core API probe.
 *
 * Grounded strictly in the official Lit documentation:
 * - https://developer.litprotocol.com/management/api_direct.md
 * - https://developer.litprotocol.com/management/api_keys.md
 * - https://developer.litprotocol.com/management/errors.md
 * - https://api.chipotle.litprotocol.com/core/v1/openapi.json
 *
 * Doc-derived contract this script intentionally verifies:
 * - Authenticated endpoints accept `X-Api-Key: <key>` (or `Authorization: Bearer <key>`).
 * - `POST /get_lit_action_ipfs_id` takes a JSON string body, not an object, and requires no auth.
 * - `POST /create_wallet` is the correct write path; `GET /create_wallet` still exists but is deprecated.
 * - `POST /add_action` and `POST /add_action_to_group` take a raw IPFS CID in `action_ipfs_cid`.
 * - `POST /remove_action_from_group` takes an already-hashed CID in `hashed_cid`.
 * - `GET /list_actions` returns action metadata objects whose `id` is the hashed CID used by
 *   remove/update/delete endpoints.
 *
 * Default mode is read-only. Pass --write to enable live mutations.
 */

type ProbeStatus = 'PASS' | 'FAIL' | 'SKIP';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ProbeResult = {
  name: string;
  status: ProbeStatus;
  method: string;
  path: string;
  attemptCount: number;
  maxAttempts: number;
  elapsedMs: number;
  httpStatus?: number;
  requestBody?: Json | string;
  responseBody?: string;
  note?: string;
  error?: string;
};

type RequestSpec = {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  retryable: boolean;
  validate?: (response: { status: number; body: string; parsed: unknown }) => {
    pass: boolean;
    note?: string;
    error?: string;
  };
};

type ActionListItem = {
  id: string;
  name: string;
  description: string;
};

type CliConfig = {
  apiKey?: string;
  apiKeySource: string;
  baseUrl: string;
  timeoutMs: number;
  pageSize: number;
  readGroupId?: string;
  write: boolean;
  writeGroupId?: number;
  actionCid?: string;
  retryCount: number;
};

const DEFAULT_BASE_URL = 'https://api.chipotle.litprotocol.com/core/v1';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_RETRY_COUNT = 1;
const MAX_PRINT_BODY_CHARS = 6_000;
const SAMPLE_LIT_ACTION_CODE = 'async function main() { return "hello"; }';

function usage(): string {
  return [
    'Usage:',
    '  pnpm exec tsx --require dotenv/config protocol/scripts/lit/probe-core-account-api.ts [options]',
    '',
    'Options:',
    '  --write                    Enable live write probes (mutates the authenticated account).',
    '  --group-id <id>            Existing group id for add_action_to_group/remove_action_from_group (decimal or 0x-hex).',
    '  --list-group-id <value>    Optional group_id query param for an extra read-only list_actions probe.',
    '  --action-cid <cid>         Raw IPFS CID to use for write probes that register/attach an action.',
    '  --base-url <url>           Base URL to probe. Default: official hosted Core API.',
    '  --timeout-ms <ms>          Per-request timeout. Default: 20000.',
    '  --page-size <n>            Page size for list_actions probes. Default: 10.',
    '  --retry-count <n>          Retries for retryable read-only probes. Default: 1.',
    '  --help                     Show this help.',
    '',
    'Environment:',
    '  LIT_PROBE_API_KEY          Preferred authenticated account key for this probe.',
    '  LIT_ACCOUNT_KEY            Fallback if LIT_PROBE_API_KEY is unset.',
    '',
    'Notes:',
    '  - Default mode is read-only and never mutates state.',
    '  - --write may create a wallet and register/attach a clearly-marked test action.',
    '  - Write probes are intentionally NOT retried automatically to avoid duplicate mutations.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliConfig {
  let baseUrl = DEFAULT_BASE_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let pageSize = DEFAULT_PAGE_SIZE;
  let readGroupId: string | undefined;
  let write = false;
  let writeGroupId: number | undefined;
  let actionCid: string | undefined;
  let retryCount = DEFAULT_RETRY_COUNT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
      case '--write':
        write = true;
        break;
      case '--group-id': {
        const raw = nextValue(argv, ++i, '--group-id');
        writeGroupId = parseGroupIdAsNumber(raw, '--group-id');
        readGroupId = raw;
        break;
      }
      case '--list-group-id':
        readGroupId = nextValue(argv, ++i, '--list-group-id');
        break;
      case '--action-cid':
        actionCid = nextValue(argv, ++i, '--action-cid');
        break;
      case '--base-url':
        baseUrl = normalizeBaseUrl(nextValue(argv, ++i, '--base-url'));
        break;
      case '--timeout-ms':
        timeoutMs = parsePositiveInt(nextValue(argv, ++i, '--timeout-ms'), '--timeout-ms');
        break;
      case '--page-size':
        pageSize = parsePositiveInt(nextValue(argv, ++i, '--page-size'), '--page-size');
        break;
      case '--retry-count':
        retryCount = parseNonNegativeInt(nextValue(argv, ++i, '--retry-count'), '--retry-count');
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  const apiKey = process.env.LIT_PROBE_API_KEY || process.env.LIT_ACCOUNT_KEY;
  const apiKeySource = process.env.LIT_PROBE_API_KEY
    ? 'LIT_PROBE_API_KEY'
    : process.env.LIT_ACCOUNT_KEY
      ? 'LIT_ACCOUNT_KEY'
      : 'unset';

  return {
    apiKey,
    apiKeySource,
    baseUrl,
    timeoutMs,
    pageSize,
    readGroupId,
    write,
    writeGroupId,
    actionCid,
    retryCount,
  };
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer. Received: ${raw}`);
  }
  return value;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer. Received: ${raw}`);
  }
  return value;
}

function parseGroupIdAsNumber(raw: string, flag: string): number {
  if (!/^(?:\d+|0x[0-9a-fA-F]+)$/.test(raw)) {
    throw new Error(
      `${flag} must be an unsigned integer in decimal or 0x-hex form. Received: ${raw}`,
    );
  }

  const asBigInt = BigInt(raw);
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${flag} exceeds JavaScript's safe integer range: ${raw}`);
  }

  return Number(asBigInt);
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

function redactApiKey(apiKey?: string): string {
  if (!apiKey) {
    return '(unset)';
  }
  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}…${apiKey.slice(-2)}`;
  }
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function toPrintableBody(value: unknown): string {
  const rendered =
    typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));

  if (rendered.length <= MAX_PRINT_BODY_CHARS) {
    return rendered;
  }

  return `${rendered.slice(0, MAX_PRINT_BODY_CHARS)}\n… [truncated ${rendered.length - MAX_PRINT_BODY_CHARS} chars]`;
}

function parseJsonIfPossible(text: string): unknown {
  if (!text.length) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function classifyHttpStatus(status: number): string | undefined {
  switch (status) {
    case 400:
      return 'bad_request — malformed JSON or wrong parameter shape';
    case 401:
      return 'unauthorized — missing or invalid API key';
    case 402:
      return 'payment_required — account exists but lacks credits for this billed write';
    case 403:
      return 'forbidden — key is valid but lacks the required permission/scope';
    case 404:
      return 'not_found — wrong path or resource missing';
    case 422:
      return 'unprocessable_entity — JSON parsed but does not match endpoint schema';
    case 429:
      return 'too_many_requests — node is shedding load';
    case 500:
      return 'internal_error — upstream server-side failure';
    case 503:
      return 'service_unavailable — upstream dependency is temporarily unavailable';
    default:
      return undefined;
  }
}

function mergeNotes(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length ? present.join(' | ') : undefined;
}

function validateJsonStringResponse(response: { status: number; body: string; parsed: unknown }): {
  pass: boolean;
  note?: string;
  error?: string;
} {
  if (response.status < 200 || response.status >= 300) {
    return { pass: false };
  }
  if (typeof response.parsed !== 'string' || response.parsed.length === 0) {
    return {
      pass: false,
      error: 'Expected a non-empty JSON string response per the docs/OpenAPI schema.',
    };
  }
  return { pass: true };
}

function validateListActionsResponse(response: { status: number; body: string; parsed: unknown }): {
  pass: boolean;
  note?: string;
  error?: string;
} {
  if (response.status < 200 || response.status >= 300) {
    return { pass: false };
  }
  if (!ensureArrayOfActionItems(response.parsed)) {
    return {
      pass: false,
      error:
        'Expected an array of { id, name, description } objects; docs/OpenAPI say list_actions items are action metadata and id is the hashed CID.',
    };
  }
  return { pass: true };
}

function validateWalletResponse(response: { status: number; body: string; parsed: unknown }): {
  pass: boolean;
  note?: string;
  error?: string;
} {
  if (response.status < 200 || response.status >= 300) {
    return { pass: false };
  }
  const parsed = response.parsed;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { wallet_address?: unknown }).wallet_address !== 'string'
  ) {
    return {
      pass: false,
      error: 'Expected a JSON object containing wallet_address per the docs/OpenAPI schema.',
    };
  }
  return { pass: true };
}

function validateMutationResponse(response: { status: number; body: string; parsed: unknown }): {
  pass: boolean;
  note?: string;
  error?: string;
} {
  if (response.status < 200 || response.status >= 300) {
    return { pass: false };
  }

  if (typeof response.parsed === 'string') {
    return {
      pass: response.parsed.length > 0,
      note: 'Docs/OpenAPI allow a JSON string response for endpoint-specific outcomes.',
      error: response.parsed.length > 0 ? undefined : 'Received an empty string response.',
    };
  }

  if (
    response.parsed &&
    typeof response.parsed === 'object' &&
    typeof (response.parsed as { success?: unknown }).success === 'boolean'
  ) {
    const success = (response.parsed as { success: boolean }).success;
    return {
      pass: success,
      error: success ? undefined : 'Response included success: false.',
    };
  }

  return {
    pass: false,
    error:
      'Expected either a JSON string or a { success: boolean } object per the docs/OpenAPI schema.',
  };
}

async function sendRequest(spec: RequestSpec, config: CliConfig): Promise<ProbeResult> {
  const maxAttempts = spec.retryable ? config.retryCount + 1 : 1;
  const startedAt = Date.now();
  let lastError: string | undefined;
  let lastStatus: number | undefined;
  let lastBody = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();

    try {
      const response = await fetch(`${config.baseUrl}${spec.path}`, {
        method: spec.method,
        headers: spec.headers,
        body: spec.body,
        signal: makeTimeoutSignal(config.timeoutMs),
      });

      const responseBody = await response.text();
      const parsedResponseBody = parseJsonIfPossible(responseBody);
      const elapsedMs = Date.now() - startedAt;
      lastStatus = response.status;
      lastBody = responseBody;

      const shouldRetry =
        spec.retryable &&
        attempt < maxAttempts &&
        (response.status === 429 || response.status >= 500);

      if (shouldRetry) {
        const backoffMs = Math.min(1_000 * attempt, 2_000);
        await sleep(backoffMs);
        continue;
      }

      const validation = spec.validate?.({
        status: response.status,
        body: responseBody,
        parsed: parsedResponseBody,
      });
      const statusNote = classifyHttpStatus(response.status);
      return {
        name: spec.name,
        status: response.ok && (validation?.pass ?? true) ? 'PASS' : 'FAIL',
        method: spec.method,
        path: spec.path,
        attemptCount: attempt,
        maxAttempts,
        elapsedMs,
        httpStatus: response.status,
        requestBody: spec.body ? parseJsonIfPossible(spec.body) : undefined,
        responseBody,
        note: mergeNotes(statusNote, validation?.note),
        error: validation?.error,
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const attemptElapsedMs = Date.now() - attemptStartedAt;
      const renderedError =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      lastError = renderedError;

      if (spec.retryable && attempt < maxAttempts) {
        const backoffMs = Math.min(1_000 * attempt, 2_000);
        await sleep(backoffMs);
        continue;
      }

      return {
        name: spec.name,
        status: 'FAIL',
        method: spec.method,
        path: spec.path,
        attemptCount: attempt,
        maxAttempts,
        elapsedMs,
        requestBody: spec.body ? parseJsonIfPossible(spec.body) : undefined,
        responseBody: lastBody || undefined,
        error: `${renderedError} (attempt duration ${attemptElapsedMs}ms)`,
      };
    }
  }

  return {
    name: spec.name,
    status: 'FAIL',
    method: spec.method,
    path: spec.path,
    attemptCount: maxAttempts,
    maxAttempts,
    elapsedMs: Date.now() - startedAt,
    httpStatus: lastStatus,
    requestBody: spec.body ? parseJsonIfPossible(spec.body) : undefined,
    responseBody: lastBody || undefined,
    error: lastError ?? 'Unknown failure',
  };
}

function printResult(result: ProbeResult): void {
  console.log(`\n[${result.status}] ${result.name}`);
  console.log(`  request: ${result.method} ${result.path}`);
  console.log(`  attempts: ${result.attemptCount}/${result.maxAttempts}`);
  console.log(`  elapsed_ms: ${result.elapsedMs}`);

  if (typeof result.httpStatus === 'number') {
    console.log(`  http_status: ${result.httpStatus}`);
  }
  if (result.note) {
    console.log(`  note: ${result.note}`);
  }
  if (typeof result.requestBody !== 'undefined') {
    console.log('  request_body:');
    console.log(indentBlock(toPrintableBody(result.requestBody), '    '));
  }
  if (result.responseBody) {
    console.log('  response_body:');
    console.log(indentBlock(toPrintableBody(parseJsonIfPossible(result.responseBody)), '    '));
  }
  if (result.error) {
    console.log(`  error: ${result.error}`);
  }
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function makeAuthHeaders(apiKey: string, includeJsonContentType = false): Record<string, string> {
  return {
    ...(includeJsonContentType ? { 'Content-Type': 'application/json' } : {}),
    'X-Api-Key': apiKey,
  };
}

function ensureArrayOfActionItems(value: unknown): ActionListItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const isValid = value.every((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const candidate = item as Partial<ActionListItem>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.description === 'string'
    );
  });

  return isValid ? (value as ActionListItem[]) : undefined;
}

function makeListActionsPath(pageNumber: number, pageSize: number, groupId?: string): string {
  const params = new URLSearchParams({
    page_number: String(pageNumber),
    page_size: String(pageSize),
  });

  if (groupId) {
    params.set('group_id', groupId);
  }

  return `/list_actions?${params.toString()}`;
}

async function findHashedCidByMetadata(
  config: CliConfig,
  apiKey: string,
  name: string,
  description: string,
): Promise<{ hashedCid?: string; probes: ProbeResult[] }> {
  const probes: ProbeResult[] = [];
  const maxPages = 10;
  const pageSize = Math.max(config.pageSize, 50);

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const probe = await sendRequest(
      {
        name: `GET /list_actions page ${pageNumber} (locate hashed CID)`,
        method: 'GET',
        path: makeListActionsPath(pageNumber, pageSize),
        headers: makeAuthHeaders(apiKey),
        retryable: true,
        validate: validateListActionsResponse,
      },
      config,
    );
    probes.push(probe);

    if (probe.status !== 'PASS' || typeof probe.responseBody !== 'string') {
      return { probes };
    }

    const parsed = parseJsonIfPossible(probe.responseBody);
    const items = ensureArrayOfActionItems(parsed);
    if (!items) {
      return { probes };
    }

    const match = items.find((item) => item.name === name && item.description === description);
    if (match) {
      return { hashedCid: match.id, probes };
    }

    if (items.length < pageSize) {
      break;
    }
  }

  return { probes };
}

async function run(): Promise<number> {
  const config = parseArgs(process.argv.slice(2));

  console.log('Lit Core API probe');
  console.log(`  base_url: ${config.baseUrl}`);
  console.log(`  api_key_source: ${config.apiKeySource}`);
  console.log(`  api_key: ${redactApiKey(config.apiKey)}`);
  console.log(`  timeout_ms: ${config.timeoutMs}`);
  console.log(`  page_size: ${config.pageSize}`);
  console.log(`  retry_count_for_reads: ${config.retryCount}`);
  console.log(`  write_mode: ${config.write ? 'ENABLED' : 'disabled'}`);
  if (config.readGroupId) {
    console.log(`  read_group_id: ${config.readGroupId}`);
  }
  if (typeof config.writeGroupId === 'number') {
    console.log(`  write_group_id: ${config.writeGroupId}`);
  }
  if (config.actionCid) {
    console.log(`  action_cid: ${config.actionCid}`);
  }

  const results: ProbeResult[] = [];
  let failures = 0;
  let skips = 0;

  const unauthProbe = await sendRequest(
    {
      name: 'POST /get_lit_action_ipfs_id (JSON string body, no auth)',
      method: 'POST',
      path: '/get_lit_action_ipfs_id',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE_LIT_ACTION_CODE),
      retryable: true,
      validate: validateJsonStringResponse,
    },
    config,
  );
  results.push(unauthProbe);
  printResult(unauthProbe);

  const computedCid =
    unauthProbe.status === 'PASS' && typeof unauthProbe.responseBody === 'string'
      ? parseJsonIfPossible(unauthProbe.responseBody)
      : undefined;

  if (!config.apiKey) {
    const missingKeyResult: ProbeResult = {
      name: 'Authenticated probes',
      status: 'FAIL',
      method: 'N/A',
      path: '(requires API key)',
      attemptCount: 0,
      maxAttempts: 0,
      elapsedMs: 0,
      error: 'Missing LIT_PROBE_API_KEY and LIT_ACCOUNT_KEY.',
      note: 'Per docs, these endpoints require X-Api-Key or Authorization: Bearer.',
    };
    results.push(missingKeyResult);
    printResult(missingKeyResult);
  } else {
    const listAccountActions = await sendRequest(
      {
        name: 'GET /list_actions (account-wide)',
        method: 'GET',
        path: makeListActionsPath(0, config.pageSize),
        headers: makeAuthHeaders(config.apiKey),
        retryable: true,
        validate: validateListActionsResponse,
      },
      config,
    );
    results.push(listAccountActions);
    printResult(listAccountActions);

    if (config.readGroupId) {
      const listGroupActions = await sendRequest(
        {
          name: 'GET /list_actions?group_id=... (group-scoped read)',
          method: 'GET',
          path: makeListActionsPath(0, config.pageSize, config.readGroupId),
          headers: makeAuthHeaders(config.apiKey),
          retryable: true,
          validate: validateListActionsResponse,
        },
        config,
      );
      results.push(listGroupActions);
      printResult(listGroupActions);
    }

    if (config.write) {
      const probeStamp = new Date().toISOString();
      const testActionName = `[PROBE][WRITE][${probeStamp}] lit-core-account-api`;
      const testActionDescription =
        'Standalone documentation-grounded probe action registration. Safe to remove.';

      if (config.actionCid) {
        const addAction = await sendRequest(
          {
            name: 'POST /add_action (raw action_ipfs_cid + metadata)',
            method: 'POST',
            path: '/add_action',
            headers: makeAuthHeaders(config.apiKey, true),
            body: JSON.stringify({
              action_ipfs_cid: config.actionCid,
              name: testActionName,
              description: testActionDescription,
            }),
            retryable: false,
            validate: validateMutationResponse,
          },
          config,
        );
        results.push(addAction);
        printResult(addAction);

        if (typeof config.writeGroupId === 'number') {
          const addActionToGroup = await sendRequest(
            {
              name: 'POST /add_action_to_group (raw action_ipfs_cid + numeric group_id)',
              method: 'POST',
              path: '/add_action_to_group',
              headers: makeAuthHeaders(config.apiKey, true),
              body: JSON.stringify({
                group_id: config.writeGroupId,
                action_ipfs_cid: config.actionCid,
              }),
              retryable: false,
              validate: validateMutationResponse,
            },
            config,
          );
          results.push(addActionToGroup);
          printResult(addActionToGroup);

          if (addAction.status === 'PASS' && addActionToGroup.status === 'PASS') {
            const findResult = await findHashedCidByMetadata(
              config,
              config.apiKey,
              testActionName,
              testActionDescription,
            );
            for (const probe of findResult.probes) {
              results.push(probe);
              printResult(probe);
            }

            if (findResult.hashedCid) {
              const removeActionFromGroup = await sendRequest(
                {
                  name: 'POST /remove_action_from_group (hashed_cid from list_actions[].id)',
                  method: 'POST',
                  path: '/remove_action_from_group',
                  headers: makeAuthHeaders(config.apiKey, true),
                  body: JSON.stringify({
                    group_id: config.writeGroupId,
                    hashed_cid: findResult.hashedCid,
                  }),
                  retryable: false,
                  validate: validateMutationResponse,
                },
                config,
              );
              results.push(removeActionFromGroup);
              printResult(removeActionFromGroup);
            } else {
              const missingHashedCid: ProbeResult = {
                name: 'POST /remove_action_from_group (precondition)',
                status: 'FAIL',
                method: 'POST',
                path: '/remove_action_from_group',
                attemptCount: 0,
                maxAttempts: 0,
                elapsedMs: 0,
                note: 'Docs imply list_actions[].id is the hashed CID needed here.',
                error:
                  'Could not find the newly-registered action in account-wide list_actions results, so hashed_cid could not be derived safely.',
              };
              results.push(missingHashedCid);
              printResult(missingHashedCid);
            }
          } else {
            const skippedRemove: ProbeResult = {
              name: 'POST /remove_action_from_group',
              status: 'SKIP',
              method: 'POST',
              path: '/remove_action_from_group',
              attemptCount: 0,
              maxAttempts: 0,
              elapsedMs: 0,
              note: 'Skipped because add_action or add_action_to_group did not succeed, so remove_action_from_group would not be a clean doc-shape verification.',
            };
            results.push(skippedRemove);
            printResult(skippedRemove);
          }
        } else {
          const skipGroupWrite: ProbeResult = {
            name: 'Group action write probes',
            status: 'SKIP',
            method: 'POST',
            path: '/add_action_to_group + /remove_action_from_group',
            attemptCount: 0,
            maxAttempts: 0,
            elapsedMs: 0,
            note: 'Provide --group-id <u64> to probe group attachment/removal endpoints.',
          };
          results.push(skipGroupWrite);
          printResult(skipGroupWrite);
        }
      } else {
        const skipActionWrites: ProbeResult = {
          name: 'Action registration write probes',
          status: 'SKIP',
          method: 'POST',
          path: '/add_action + /add_action_to_group + /remove_action_from_group',
          attemptCount: 0,
          maxAttempts: 0,
          elapsedMs: 0,
          note: 'Provide --action-cid <raw IPFS CID> to probe doc-correct action registration and group attachment/removal flows.',
          error:
            typeof computedCid === 'string'
              ? 'A CID computed via /get_lit_action_ipfs_id was available, but this probe intentionally does not assume that an unpublished CID is acceptable for add_action.'
              : undefined,
        };
        results.push(skipActionWrites);
        printResult(skipActionWrites);
      }

      const createWallet = await sendRequest(
        {
          name: 'POST /create_wallet (correct doc path; GET exists but is deprecated)',
          method: 'POST',
          path: '/create_wallet',
          headers: makeAuthHeaders(config.apiKey),
          retryable: false,
          validate: validateWalletResponse,
        },
        config,
      );
      results.push(createWallet);
      printResult(createWallet);
    }
  }

  for (const result of results) {
    if (result.status === 'FAIL') {
      failures += 1;
    } else if (result.status === 'SKIP') {
      skips += 1;
    }
  }

  console.log('\nSummary');
  console.log(`  total: ${results.length}`);
  console.log(`  pass: ${results.filter((r) => r.status === 'PASS').length}`);
  console.log(`  fail: ${failures}`);
  console.log(`  skip: ${skips}`);

  return failures > 0 ? 1 : 0;
}

void run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(rendered);
    process.exitCode = 1;
  });
