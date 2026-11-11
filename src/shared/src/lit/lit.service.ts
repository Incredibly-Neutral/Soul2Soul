import { keccak256, toBytes } from "viem";
import { callWithTimeout, isAbortError, withRetry } from "../helpers/index.js";
import { decryptAction } from "./actions/decrypt.js";
import { encryptAction } from "./actions/encrypt.js";
import { compactAction } from "./actions/index.js";
import type { ActionResult, DecryptData, DecryptParams } from "./actions/types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Log hygiene — nothing in this module may put a Lit usage key, a plaintext
// body or a ciphertext on stdout/stderr. Two proven routes:
//
//   1. Lit error payloads. A live 403 body from /lit_action echoed a numeric
//      rendering of the X-Api-Key that was sent (`…861850`), and on
//      /lit_action a body can echo `js_params` — i.e. `message` (plaintext) on
//      the encrypt path or `ciphertext` on the decrypt path.
//   2. Action `logs`. `/lit_action` returns the action's own stdout. Actions on
//      the decrypt/render path log rendered output
//      (`console.log('HTML', html.slice(0, 400))`, handlebars helper dumps),
//      and prep logs `endpoints` (which can carry a gateway auth token). Any of
//      those can be derived from decrypted plaintext.
//
// So: log response *shape*, not bodies; summarise action logs by size, not
// content; scrub anything that still reaches a log line or an Error message.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Key/blob-shaped runs: a 44-char base64 usage key (`9i8zKrv71/…=`), a
 * ciphertext or signature hex blob, any CID. Deliberately excludes `-`/`_` so
 * ordinary hyphenated prose in an error reason survives.
 */
const SECRET_RUN = /[A-Za-z0-9+/=]{16,}/g;
/** Lit has echoed numeric renderings of a key, e.g. a 403 body ending `…861850`. */
const LONG_DIGITS = /\d{8,}/g;

/**
 * Mask credential-shaped runs and bound the length, so a Lit error reason stays
 * readable without carrying the key (or payload) that produced it.
 */
const redact = (value: unknown, limit = 200): string =>
  String(value ?? '')
    .replace(SECRET_RUN, '<redacted>')
    .replace(LONG_DIGITS, '<n>')
    .slice(0, limit);

/** Describe a JSON body by shape only — keys, never values. */
const bodyShape = (data: unknown): string => {
  if (Array.isArray(data)) return `array[${data.length}]`;
  if (data && typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>);
    return keys.length ? `{${keys.slice(0, 8).join(',')}}` : '{}';
  }
  return typeof data;
};

/**
 * Action logs are the action's own stdout and can contain decrypted plaintext
 * or js_params. Report how much was emitted, never what: enough to tell a
 * silent failure from a chatty one without echoing the payload.
 */
const describeActionLogs = (logs: unknown): string => {
  if (!Array.isArray(logs) || logs.length === 0) return 'no action logs';
  const bytes = logs.reduce((n, line) => n + String(line ?? '').length, 0);
  return `${logs.length} action log line(s), ${bytes} byte(s) withheld`;
};

type LitEnvironment = 'dev' | 'prod';

interface LitServiceConfig {
  environment: LitEnvironment;
  accountKey?: string;
}

export class LitService {
  private baseUrl: string;
  private accountKey?: string;
  private poolKeys = new Map<string, string>(); // poolId → usageKey

  constructor(config: LitServiceConfig) {
    this.baseUrl = config.environment === 'dev'
      ? 'https://api.dev.litprotocol.com/core/v1'
      : 'https://api.chipotle.litprotocol.com/core/v1';
    this.accountKey = config.accountKey;

    // (no config dump here on purpose — it printed `accountKey`)
  }

  // ============================================================
  // Private
  // ============================================================

  private async call<T>(
      endpoint: string,
      options: {
        method?: 'GET' | 'POST';
        body?: Record<string, unknown>;
        key?: string | null;
        retries?: number;
      } = {},
      signal?: AbortSignal
  ): Promise<T> {
      const { method = 'GET', body, key, retries = 3 } = options;
      const apiKey = key === null ? undefined : (key ?? this.accountKey);

      const headers: Record<string, string> = {
          'Content-Type': 'application/json',
      };

      if (apiKey) {
          headers['X-Api-Key'] = apiKey;
      }

      // return withRetry<T>(
      //     async (retrySignal) => {
      const tFetch = Date.now();
      // Bound every Lit core-API call so a hung node/session can't hang the
      // orchestrator (or silently drain Lit compute). An explicit signal
      // (e.g. from runAction's callWithTimeout) wins; otherwise a default
      // timeout applies — configurable via LIT_API_TIMEOUT_MS.
      const effectiveSignal =
        signal ?? AbortSignal.timeout(Number(process.env.LIT_API_TIMEOUT_MS ?? 120_000));
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${endpoint}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: effectiveSignal,
        });
      } catch (err: unknown) {
        // undici hides an abort behind `TypeError: fetch failed` — see
        // isAbortError. Without this, a 120s timeout reads as "fetch failed".
        if (isAbortError(err)) {
          throw new Error(`Lit API call to ${endpoint} timed out`, { cause: err });
        }
        throw err;
      }

      const text = await response.text();
      let data: any;

      try {
          data = JSON.parse(text);
      } catch {
          // Body withheld on purpose: on /lit_action it can be the plaintext.
          throw new Error(`Lit API returned non-JSON: HTTP ${response.status} (${text.length} bytes)`);
      }

      if (!response.ok) {
          // Shape only — never the body (see the log-hygiene note above).
          console.error(
            `[Lit API] ${method} ${endpoint} -> ${response.status}` +
            ` (body ${text.length} bytes, json ${bodyShape(data)})`,
          );
          const reason = data?.error ?? data?.message ?? data?.detail;
          throw new Error(
            `HTTP ${response.status} from ${endpoint}` + (reason ? `: ${redact(reason)}` : ''),
          );
      }

      return data;
          // },
          // {
          //     retries,
          // }
      //);
  }

  // ============================================================
  // Public (no auth)
  // ============================================================

  async getChainConfig() {
    return this.call<{
      chain_name: string;
      chain_id: number;
      contract_address: string;
    }>('/get_node_chain_config', { key: null });
  }

  async getActionCid(code: string): Promise<string> {

    const url = `${this.baseUrl}/get_lit_action_ipfs_id`;

    // console.log(`[Lit API] ${url}`, code ? JSON.stringify(code).slice(0, 500) : '');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(code),  // just stringify the string itself
    });

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Lit API returned non-JSON: HTTP ${response.status} (${text.length} bytes)`);
    }

    if (!response.ok) {
      const reason = data?.error ?? data?.message;
      throw new Error(
        `HTTP ${response.status} from /get_lit_action_ipfs_id` + (reason ? `: ${redact(reason)}` : ''),
      );
    } 

    return data;
  }

  // ============================================================
  // Management (account key)
  // ============================================================

  async createPkp() {
    const pkp = await this.call<{ wallet_address: string }>('/create_wallet');
    console.log("PKP", pkp)
    return pkp.wallet_address;
  }

  async listPKPInGroup(groupId: number) {
    const pkps = await this.call<any>(`/list_wallets_in_group?group_id=${groupId}&page_number=0&page_size=100`);
    console.log("Wallets", pkps);
    return pkps;
  }

  async listAllPKPs() {
    const pkps = await this.call<any>(`/list_wallets?page_number=0&page_size=100`);
    console.log("All Wallets:", JSON.stringify(pkps, null, 2));
    return pkps;
  }


  async createGroup(name: string, description?: string, pkpIds?: string[], cidHashes?: string[]) {
    // Log what we're sending
    console.log('createGroup body:', {
        group_name: name,
        group_description: description ?? '',
        pkp_ids_permitted: pkpIds ?? [],
        cid_hashes_permitted: cidHashes ?? [],
    });
    
    const result = await this.call<{ group_id: number | string; success: boolean }>('/add_group', {
        method: 'POST',
        body: {
            group_name: name,
            group_description: description ?? '',
            pkp_ids_permitted: pkpIds ?? [],
            cid_hashes_permitted: cidHashes ?? [],
        },
    });
    
    return {
        ...result,
        group_id: Number(result.group_id),
    };
  }

  async inspectGroup(id: number) {
    
    const actions = await this.call<{ success: boolean }>(`/list_actions?[${id}]&page_number=0&page_size=500`, {
        method: 'GET'
    });

    const pkps = await this.call<{ success: boolean }>(`/list_wallets_in_group?group_id=${id}&page_number=0&page_size=200`, {
        method: 'GET'
    });

    // const keys = await this.call<{ success: boolean }>(`/list_wallets_in_group?group_id=${id}&page_number=0&page_size=20`, {
    //     method: 'GET'
    // });

    return {
      actions,
      pkps
      // keys
    }

  }

  async registerAction(cid: string, name: string): Promise<{ success: boolean; hashedCid: string }> {
    const result = await this.call<{ success: boolean }>('/add_action', {
        method: 'POST',
        body: {
            action_ipfs_cid: cid,
            name,
            description: name,
        },
    });
    
    // Compute the hashed CID
    const hashedCid = keccak256(toBytes(cid));
    
    return { ...result, hashedCid };
  }

  async addActionToGroup(groupId: number, actionCid: string) {
    return this.call<{ success: boolean }>('/add_action_to_group', {
      method: 'POST',
      body: { group_id: groupId, action_ipfs_cid: actionCid },
    });
  }

  async removeActionFromGroup(groupId: number, actionCidHashed: string) {
    console.log(`[Lit API] removeActionFromGroup request group_id=${groupId} hashed_cid=${actionCidHashed}`);
    const result = await this.call<{ success: boolean }>('/remove_action_from_group', {
      method: 'POST',
      body: { group_id: groupId, hashed_cid: actionCidHashed },
    });
    console.log(`[Lit API] removeActionFromGroup success group_id=${groupId} hashed_cid=${actionCidHashed} response=${JSON.stringify(result)}`);
    return result;
  }

  async addPkpToGroup(groupId: number, pkpId: string) {
    return this.call<{ success: boolean }>('/add_pkp_to_group', {
      method: 'POST',
      body: { group_id: groupId, pkp_id: pkpId },
    });
  }

  async createUsageKey(params: { executeInGroups: number[] }) {
    return this.call<{ usage_api_key: string }>('/add_usage_api_key', {
      method: 'POST',
      body: {
        name: 'pool-usage-key',           // add this
        description: 'Auto-generated',     // add this
        execute_in_groups: params.executeInGroups,
        can_create_pkps: false,
        can_create_groups: false,
        can_delete_groups: false,
        manage_ipfs_ids_in_groups: [],
        add_pkp_to_groups: [],
        remove_pkp_from_groups: [],
      },
    });
  }

  async removeUsageKey(usageKey: string) {
    return this.call<{ success: boolean }>('/remove_usage_api_key', {
      method: 'POST',
      body: { usage_api_key: usageKey },
    });
  }

  // ============================================================
  // Execution (pool key)
  // ============================================================

  async executeAction(
    code: string,
    jsParams: Record<string, unknown> = {},
    key: string | undefined = undefined,
    signal?: AbortSignal
  ) {
    const endpoint = '/lit_action';

    const result = await this.call<{ response: unknown; logs?: string[]; has_error?: boolean }>(
      endpoint,
      {
        method: 'POST',
        body: { code, js_params: jsParams },
        key,
        retries: 0,
      },
      signal,
    );

    // `has_error` means the action itself failed. Its `response` is usually the
    // action's own error envelope, but the *logs* — the action's console output,
    // the only place the real reason tends to appear — were being dropped, which
    // is why a failing render said nothing. Print them; the caller still decides
    // whether the envelope counts as a failure (throwing here would collapse the
    // retry/classification logic that distinguishes transport failures).
    if (result?.has_error) {
      const logs = result.logs ?? [];
      console.error(
        `[lit_action] action reported an error; logs (${logs.length}):\n${logs.join('\n')}`,
      );
    }

    return result;
  }

  // ============================================================
  // Encrypt / Decrypt
  // ============================================================

  async encrypt(key: string, pkpId: string, message: string): Promise<string> {
    // Deliberately unlogged: `key` is the Lit usage key (a credential) and
    // `message` is the plaintext being gated. Never print either — not before
    // the call, not in the catch below.
    if (!message || typeof message !== 'string') {
      throw new Error(`encrypt: message must be a non-empty string, got: ${typeof message}`);
    }

    const code = compactAction(encryptAction);

    try {
      const result: any = await this.call<{ response: { ciphertext: string } }>(
        '/lit_action',
        {
          method: 'POST',
          body: { code, js_params: { pkpId, message } },
          key,
        }
      );

      if (result.has_error) {
        // The action's log lines can carry js_params / rendered plaintext, so
        // the message reports their size rather than their content.
        throw new Error(`Encrypt failed: ${describeActionLogs(result.logs)}`);
      }

      return result.response.ciphertext;

    } catch(error: any) {
      // Log the reason, never the error object: call() errors embed the Lit
      // response body, and this same string is returned as the "ciphertext",
      // so an unredacted print would put the payload back on stdout.
      console.error(`[Lit] encrypt failed: ${redact(error?.message ?? error)}`);

      return error.toString()
    }
  }

  /**
   * Decrypt a draft for its author. `params` carries no author Safe — the action
   * reads it from the drafts module and refuses unless the signer owns it.
   * Returns the plaintext; throws on a refusal envelope.
   */
  async decrypt(key: string, params: DecryptParams): Promise<string> {
      const code = compactAction(decryptAction);

      const result: any = await this.call<{ response: ActionResult<DecryptData>; logs?: string[]; has_error?: boolean }>(
          '/lit_action', {
              method: 'POST',
              body: { code, js_params: params },
              key,
          }
      );

      const envelope = result?.response as ActionResult<DecryptData> | undefined;

      if (result?.has_error || !envelope || envelope.ok !== true) {
          // Reason only, redacted: a refusal's `error` is the action's own words,
          // and the fallback (action logs) can carry js_params, i.e. the
          // ciphertext.
          const reason = envelope && envelope.ok === false
              ? envelope.error
              : describeActionLogs(result?.logs);
          throw new Error(`Decrypt failed: ${redact(reason)}`);
      }

      const plaintext = envelope.data?.plaintext;
      if (typeof plaintext !== 'string') {
          // Shape only: the response body can be the plaintext itself.
          throw new Error(`Decrypt returned no plaintext (response ${bodyShape(envelope)})`);
      }

      return plaintext;
  }
}