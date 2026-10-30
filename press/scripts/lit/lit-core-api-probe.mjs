#!/usr/bin/env node

/**
 * Standalone Lit Core API probe.
 *
 * Docs basis (fresh-view; not derived from local implementation code):
 * - https://developer.litprotocol.com/management/api_direct.md
 * - https://developer.litprotocol.com/management/api_keys.md
 * - https://developer.litprotocol.com/management/account_modes.md
 * - https://developer.litprotocol.com/management/errors.md
 * - https://developer.litprotocol.com/architecture/groups.md
 * - https://api.chipotle.litprotocol.com/core/v1/openapi.json
 *
 * Critical doc-derived usage verified here:
 * - Authenticated endpoints use X-Api-Key (or Authorization: Bearer).
 * - POST /create_wallet is the correct write path; GET /create_wallet is documented
 *   as still working but deprecated.
 * - GET /list_actions requires page_number and page_size; group_id is optional.
 * - POST /add_action and POST /add_action_to_group take the raw action_ipfs_cid.
 * - POST /remove_action_from_group takes a hashed_cid obtained from list_actions.
 * - POST /get_lit_action_ipfs_id takes a JSON string body, not an object.
 */

import process from 'node:process';
import { performance } from 'node:perf_hooks';

const BASE_URL = 'https://api.chipotle.litprotocol.com/core/v1';
const REQUEST_TIMEOUT_MS = 20_000;
const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 750;
const DEFAULT_PAGE_NUMBER = 0;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_GROUP_PAGE_SIZE = 100;

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const testActionName = `LIT_PROBE_TEST_ACTION__${runId}`;
const testActionDescription = `Doc-grounded Lit Core probe action. Safe to delete. Run ${runId}`;
const testGroupName = `LIT_PROBE_TEST_GROUP__${runId}`;
const testGroupDescription = `Doc-grounded Lit Core probe group. Safe to delete. Run ${runId}`;
const testActionCode = [
  `// ${testActionName}`,
  'async function main() {',
  `  return { ok: true, probe: ${JSON.stringify(testActionName)} };`,
  '}',
].join('\n');

function printHelp() {
  console.log(`Lit Core API probe\n\nUsage:\n  LIT_PROBE_API_KEY=... node press/scripts/lit/lit-core-api-probe.mjs [--write] [--group-id <id>]\n\nModes:\n  default   Read-only. Probes POST /get_lit_action_ipfs_id and GET /list_actions.\n  --write   Also probes POST /create_wallet, POST /add_action,\n            POST /add_action_to_group, and POST /remove_action_from_group.\n\nOptions:\n  --group-id <id>   Existing group id to use for action-in-group probes.\n                    Accepts decimal or the 0x-padded id form returned by\n                    list_groups. If omitted with --write, the script creates a\n                    clearly-marked temporary test group and removes it during\n                    cleanup.\n  --help            Show this help.\n\nNotes:\n  - Every request uses a ${REQUEST_TIMEOUT_MS / 1000}s timeout.\n  - Authenticated calls require LIT_PROBE_API_KEY.\n  - Write mode intentionally creates one new wallet, which cannot be cleaned up\n    by this probe. Action/group artifacts are cleaned up when possible.\n  - The probe sends the /get_lit_action_ipfs_id body as a JSON string, uses\n    POST /create_wallet, and removes group membership via hashed_cid from\n    list_actions[].id per the official docs.\n`);
}

function parseArgs(argv) {
  const options = {
    write: false,
    groupId: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--group-id') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--group-id requires a value');
      }
      options.groupId = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--group-id=')) {
      options.groupId = arg.slice('--group-id='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function parseJson(text) {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatBody(text) {
  const json = parseJson(text);
  const normalized = json === undefined ? text : JSON.stringify(json, null, 2);
  const maxLength = 4000;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\n... <truncated ${normalized.length - maxLength} chars>`;
}

function parseGroupIdToNumber(groupId) {
  let asBigInt;
  if (/^\d+$/.test(groupId)) {
    asBigInt = BigInt(groupId);
  } else if (/^0x[0-9a-fA-F]+$/.test(groupId)) {
    asBigInt = BigInt(groupId);
  } else {
    throw new Error(`group_id must be a decimal or 0x-prefixed unsigned integer, got: ${groupId}`);
  }

  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`group_id exceeds Number.MAX_SAFE_INTEGER and cannot be sent as a JSON number safely: ${groupId}`);
  }

  return Number(asBigInt);
}

function printResult(result) {
  const headline = `[${result.ok ? 'PASS' : result.skipped ? 'SKIP' : 'FAIL'}] ${result.method} ${result.path} (${result.elapsedMs}ms)`;
  console.log(headline);
  if (result.note) {
    console.log(`  note: ${result.note}`);
  }
  if (result.url) {
    console.log(`  url: ${result.url}`);
  }
  if (result.status !== undefined) {
    console.log(`  status: ${result.status}`);
  }
  if (result.error) {
    console.log(`  error: ${result.error}`);
  }
  if (result.bodyText !== undefined) {
    console.log('  body:');
    const lines = formatBody(result.bodyText).split('\n');
    for (const line of lines) {
      console.log(`    ${line}`);
    }
  }
  console.log('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callEndpoint({
  method,
  path,
  query,
  apiKey,
  body,
  validator,
  note,
  retryable = false,
}) {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    Accept: 'application/json',
  };

  let requestBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  const maxAttempts = retryable ? READ_RETRY_ATTEMPTS : 1;
  let lastResult;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const bodyText = await response.text();
      const elapsedMs = Math.round(performance.now() - started);
      const parsed = parseJson(bodyText);
      const validation = validator(response, parsed, bodyText);
      const result = {
        ok: validation.ok,
        method,
        path: `${path}${url.search}`,
        url: url.toString(),
        status: response.status,
        bodyText,
        elapsedMs,
        note: validation.note ?? note,
        parsed,
      };

      const shouldRetry = retryable && attempt < maxAttempts && [429, 500, 503].includes(response.status);
      if (!shouldRetry) {
        printResult(result);
        return result;
      }

      lastResult = {
        ...result,
        note: `${result.note ?? note ?? ''}${result.note ?? note ? ' ' : ''}(retrying after HTTP ${response.status}, attempt ${attempt}/${maxAttempts})`,
      };
      await sleep(READ_RETRY_DELAY_MS);
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - started);
      const result = {
        ok: false,
        method,
        path: `${path}${url.search}`,
        url: url.toString(),
        elapsedMs,
        error: error?.name === 'TimeoutError'
          ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
        note,
      };

      if (!retryable || attempt >= maxAttempts) {
        printResult(result);
        return result;
      }

      lastResult = {
        ...result,
        note: `${note ? `${note} ` : ''}(retrying after network failure, attempt ${attempt}/${maxAttempts})`,
      };
      await sleep(READ_RETRY_DELAY_MS);
    }
  }

  if (lastResult) {
    printResult(lastResult);
    return lastResult;
  }

  const impossibleResult = {
    ok: false,
    method,
    path: `${path}${url.search}`,
    url: url.toString(),
    elapsedMs: 0,
    error: 'Unexpected retry state.',
    note,
  };
  printResult(impossibleResult);
  return impossibleResult;
}

function skipResult({ method, path, note }) {
  const result = {
    ok: false,
    skipped: true,
    method,
    path,
    elapsedMs: 0,
    note,
  };
  printResult(result);
  return result;
}

function expectJsonString(response, parsed) {
  if (!response.ok) {
    return { ok: false, note: `Expected HTTP 2xx with JSON string; got ${response.status}` };
  }
  if (typeof parsed !== 'string') {
    return { ok: false, note: 'Expected a JSON string response body.' };
  }
  return { ok: true };
}

function expectCidString(response, parsed) {
  const base = expectJsonString(response, parsed);
  if (!base.ok) {
    return base;
  }
  const cidLike = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+)$/;
  if (!cidLike.test(parsed)) {
    return { ok: false, note: 'Expected an IPFS CID string response.' };
  }
  return { ok: true };
}

function expectSuccessObject(response, parsed) {
  if (!response.ok) {
    return { ok: false, note: `Expected HTTP 2xx with { success: true }; got ${response.status}` };
  }
  if (!isObject(parsed) || typeof parsed.success !== 'boolean') {
    return { ok: false, note: 'Expected an object response with boolean success.' };
  }
  if (!parsed.success) {
    return { ok: false, note: 'Endpoint returned success=false.' };
  }
  return { ok: true };
}

function expectCreateWalletResponse(response, parsed) {
  if (!response.ok) {
    return { ok: false, note: `Expected HTTP 2xx with { wallet_address }; got ${response.status}` };
  }
  if (!isObject(parsed) || !isNonEmptyString(parsed.wallet_address)) {
    return { ok: false, note: 'Expected an object response with wallet_address string.' };
  }
  return { ok: true };
}

function expectAddGroupResponse(response, parsed) {
  if (!response.ok) {
    return { ok: false, note: `Expected HTTP 2xx with { success: true, group_id }; got ${response.status}` };
  }
  if (!isObject(parsed) || parsed.success !== true || !isNonEmptyString(parsed.group_id)) {
    return { ok: false, note: 'Expected { success: true, group_id: string }.' };
  }
  return { ok: true };
}

function expectListActionsResponse(response, parsed) {
  if (!response.ok) {
    return { ok: false, note: `Expected HTTP 2xx with an array; got ${response.status}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, note: 'Expected an array response.' };
  }
  const invalidItem = parsed.find(
    (item) => !isObject(item)
      || !isNonEmptyString(item.id)
      || typeof item.name !== 'string'
      || typeof item.description !== 'string',
  );
  if (invalidItem) {
    return { ok: false, note: 'Expected every list_actions item to contain string id/name/description.' };
  }
  return { ok: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const apiKey = process.env.LIT_PROBE_API_KEY;
  if (!apiKey) {
    console.error('Missing LIT_PROBE_API_KEY. Export your Lit account key before running this probe.');
    process.exitCode = 2;
    return;
  }

  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Timeout per request: ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`Mode: ${options.write ? 'read-write probe (--write)' : 'read-only probe'}`);
  console.log('');

  const results = [];
  let createdGroupId;
  let groupIdForMembership = options.groupId;
  let actionCid;
  let hashedCid;
  let createdWalletAddress;

  results.push(await callEndpoint({
    method: 'POST',
    path: '/get_lit_action_ipfs_id',
    body: testActionCode,
    validator: expectCidString,
    note: 'Docs require a raw JSON string body and no auth for this endpoint.',
    retryable: true,
  }));

  const ipfsIdResult = results.at(-1);
  if (ipfsIdResult.ok && typeof ipfsIdResult.parsed === 'string') {
    actionCid = ipfsIdResult.parsed;
  }

  results.push(await callEndpoint({
    method: 'GET',
    path: '/list_actions',
    query: {
      page_number: DEFAULT_PAGE_NUMBER,
      page_size: DEFAULT_PAGE_SIZE,
    },
    apiKey,
    validator: expectListActionsResponse,
    note: 'Docs require page_number and page_size query params; group_id is optional.',
    retryable: true,
  }));

  if (!options.write) {
    const failures = results.filter((result) => !result.ok);
    console.log(`Summary: ${results.filter((r) => r.ok).length} passed, ${failures.length} failed, 0 skipped.`);
    process.exitCode = failures.length === 0 ? 0 : 1;
    return;
  }

  if (!actionCid) {
    results.push(skipResult({
      method: 'POST',
      path: '/create_wallet',
      note: 'Skipped remaining write probes because /get_lit_action_ipfs_id did not produce a CID.',
    }));
    results.push(skipResult({
      method: 'POST',
      path: '/add_action',
      note: 'Skipped because a doc-grounded action_ipfs_cid was not available.',
    }));
    results.push(skipResult({
      method: 'POST',
      path: '/add_action_to_group',
      note: 'Skipped because a doc-grounded action_ipfs_cid was not available.',
    }));
    results.push(skipResult({
      method: 'POST',
      path: '/remove_action_from_group',
      note: 'Skipped because hashed_cid can only be sourced from list_actions after a successful add.',
    }));
    const failures = results.filter((result) => !result.ok && !result.skipped);
    const skipped = results.filter((result) => result.skipped).length;
    console.log(`Summary: ${results.filter((r) => r.ok).length} passed, ${failures.length} failed, ${skipped} skipped.`);
    process.exitCode = failures.length === 0 ? 0 : 1;
    return;
  }

  if (!groupIdForMembership) {
    const addGroupResult = await callEndpoint({
      method: 'POST',
      path: '/add_group',
      apiKey,
      body: {
        group_name: testGroupName,
        group_description: testGroupDescription,
        pkp_ids_permitted: [],
        cid_hashes_permitted: [],
      },
      validator: expectAddGroupResponse,
      note: 'Setup only: auto-created temporary probe group because no --group-id was provided.',
    });
    results.push(addGroupResult);
    if (addGroupResult.ok && isObject(addGroupResult.parsed) && isNonEmptyString(addGroupResult.parsed.group_id)) {
      createdGroupId = addGroupResult.parsed.group_id;
      groupIdForMembership = createdGroupId;
    }
  }

  const createWalletResult = await callEndpoint({
    method: 'POST',
    path: '/create_wallet',
    apiKey,
    validator: expectCreateWalletResponse,
    note: 'Docs say POST /create_wallet is the correct metered write path; GET also works but is deprecated.',
  });
  results.push(createWalletResult);
  if (createWalletResult.ok && isObject(createWalletResult.parsed) && isNonEmptyString(createWalletResult.parsed.wallet_address)) {
    createdWalletAddress = createWalletResult.parsed.wallet_address;
  }

  const addActionResult = await callEndpoint({
    method: 'POST',
    path: '/add_action',
    apiKey,
    body: {
      action_ipfs_cid: actionCid,
      name: testActionName,
      description: testActionDescription,
    },
    validator: expectSuccessObject,
    note: 'Docs specify raw action_ipfs_cid plus name/description.',
  });
  results.push(addActionResult);

  if (!groupIdForMembership) {
    results.push(skipResult({
      method: 'POST',
      path: '/add_action_to_group',
      note: 'Skipped because no group_id was available; add_group setup failed or was not provided.',
    }));
    results.push(skipResult({
      method: 'POST',
      path: '/remove_action_from_group',
      note: 'Skipped because no group_id was available.',
    }));
  } else {
    const numericGroupId = parseGroupIdToNumber(groupIdForMembership);

    const addActionToGroupResult = await callEndpoint({
      method: 'POST',
      path: '/add_action_to_group',
      apiKey,
      body: {
        group_id: numericGroupId,
        action_ipfs_cid: actionCid,
      },
      validator: expectSuccessObject,
      note: 'Docs specify raw action_ipfs_cid here; the server hashes it.',
    });
    results.push(addActionToGroupResult);

    const listGroupActionsResult = await callEndpoint({
      method: 'GET',
      path: '/list_actions',
      query: {
        group_id: groupIdForMembership,
        page_number: DEFAULT_PAGE_NUMBER,
        page_size: DEFAULT_GROUP_PAGE_SIZE,
      },
      apiKey,
      validator: expectListActionsResponse,
      note: 'Used to source hashed_cid from list_actions[].id for remove_action_from_group.',
      retryable: true,
    });
    results.push(listGroupActionsResult);

    if (listGroupActionsResult.ok && Array.isArray(listGroupActionsResult.parsed)) {
      const match = listGroupActionsResult.parsed.find((item) => item.name === testActionName);
      if (match && isNonEmptyString(match.id)) {
        hashedCid = match.id;
      }
    }

    if (!hashedCid) {
      results.push(skipResult({
        method: 'POST',
        path: '/remove_action_from_group',
        note: 'Skipped because list_actions did not return the probe action id needed as hashed_cid.',
      }));
    } else {
      const removeActionFromGroupResult = await callEndpoint({
        method: 'POST',
        path: '/remove_action_from_group',
        apiKey,
        body: {
          group_id: numericGroupId,
          hashed_cid: hashedCid,
        },
        validator: expectSuccessObject,
        note: 'Docs require hashed_cid here, not the raw CID used by add_action_to_group.',
      });
      results.push(removeActionFromGroupResult);

      const verifyRemovalResult = await callEndpoint({
        method: 'GET',
        path: '/list_actions',
        query: {
          group_id: groupIdForMembership,
          page_number: DEFAULT_PAGE_NUMBER,
          page_size: DEFAULT_GROUP_PAGE_SIZE,
        },
        apiKey,
        validator(response, parsed) {
          const base = expectListActionsResponse(response, parsed);
          if (!base.ok) {
            return base;
          }
          const stillPresent = parsed.some((item) => item.name === testActionName);
          return stillPresent
            ? { ok: false, note: 'Probe action still present in group after remove_action_from_group.' }
            : { ok: true };
        },
        note: 'Verification read after remove_action_from_group.',
        retryable: true,
      });
      results.push(verifyRemovalResult);
    }
  }

  if (hashedCid) {
    results.push(await callEndpoint({
      method: 'POST',
      path: '/delete_action',
      apiKey,
      body: {
        hashed_cid: hashedCid,
      },
      validator: expectSuccessObject,
      note: 'Cleanup only: delete_action uses the hashed CID returned by list_actions.',
    }));
  }

  if (createdGroupId) {
    results.push(await callEndpoint({
      method: 'POST',
      path: '/remove_group',
      apiKey,
      body: {
        group_id: createdGroupId,
      },
      validator: expectSuccessObject,
      note: 'Cleanup only: remove the temporary probe group created for this run.',
    }));
  }

  const failures = results.filter((result) => !result.ok && !result.skipped);
  const skipped = results.filter((result) => result.skipped).length;

  console.log('Summary:');
  console.log(`  passed: ${results.filter((result) => result.ok).length}`);
  console.log(`  failed: ${failures.length}`);
  console.log(`  skipped: ${skipped}`);
  if (createdWalletAddress) {
    console.log(`  created wallet_address: ${createdWalletAddress}`);
  }
  if (actionCid) {
    console.log(`  probe action_ipfs_cid: ${actionCid}`);
  }
  if (groupIdForMembership) {
    console.log(`  group_id used: ${groupIdForMembership}`);
  }
  if (hashedCid) {
    console.log(`  hashed_cid observed via list_actions: ${hashedCid}`);
  }

  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
