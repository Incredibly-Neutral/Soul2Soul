/**
 * lastmile — config.toml loader + validation.
 *
 * Reads the server config (TOML) and produces an {@link AppConfig}. Strict:
 * unknown keys are rejected by name, required fields must be present, and
 * numeric fields must be positive numbers.
 */
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

/** A single magazine: one .com domain bound to one .eth name. */
export interface MagazineConfig {
  /** e.g. s3ntiment.com */
  domain: string;
  /** e.g. s3ntiment.eth */
  ensName: string;
  /** absolute path of the nginx include lastmile writes (e.g. /etc/nginx/lastmile/s3ntiment.conf) */
  nginxInclude: string;
  /** absolute path (e.g. /var/lib/lastmile/s3ntiment) */
  stateDir: string;
  /** nginx proxy_pass target base (e.g. http://127.0.0.1:28080) */
  kuboGatewayUrl: string;
  /** per-magazine override; falls back to app.kuboApiUrl */
  kuboApiUrl?: string;
}

/** Fully-resolved application config (defaults filled in). */
export interface AppConfig {
  magazines: MagazineConfig[];
  /** >= 2 REQUIRED */
  rpcUrls: string[];
  /** default http://127.0.0.1:25011 */
  kuboApiUrl: string;
  /** default http://127.0.0.1:28080 */
  kuboGatewayUrl: string;
  /** default 60_000 */
  pollIntervalMs: number;
  /** default 5, must be >= 1 */
  rollbackDepth: number;
  /** default "sudo -n nginx -t" */
  nginxTestCmd: string;
  /** default "sudo -n nginx -s reload" */
  nginxReloadCmd: string;
  /** default null */
  alertCmd: string | null;
}

const TOP_LEVEL_KEYS = new Set<string>([
  "magazines",
  "rpc_urls",
  "kubo_api_url",
  "kubo_gateway_url",
  "poll_interval_ms",
  "rollback_depth",
  "nginx_test_cmd",
  "nginx_reload_cmd",
  "alert_cmd",
]);

const MAGAZINE_KEYS = new Set<string>([
  "domain",
  "ens_name",
  "nginx_include",
  "state_dir",
  "kubo_gateway_url",
  "kubo_api_url",
]);

/** Defaults for every optional field (empty magazines + rpcUrls). */
export function configDefaults(): AppConfig {
  return {
    magazines: [],
    rpcUrls: [],
    kuboApiUrl: "http://127.0.0.1:25011",
    kuboGatewayUrl: "http://127.0.0.1:28080",
    pollIntervalMs: 60_000,
    rollbackDepth: 5,
    nginxTestCmd: "sudo -n nginx -t",
    nginxReloadCmd: "sudo -n nginx -s reload",
    alertCmd: null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Read + parse + validate a lastmile config file.
 * Throws `Error` with a clear message on any problem (unreadable file,
 * invalid TOML, missing/insufficient rpc_urls, invalid magazine fields,
 * non-positive numeric fields, or unknown keys).
 */
export function loadConfig(filePath: string): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let toml: unknown;
  try {
    toml = parse(raw);
  } catch (err) {
    throw new Error(
      `invalid TOML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(toml)) {
    throw new Error(`invalid config ${filePath}: root must be a table`);
  }

  for (const key of Object.keys(toml)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`unknown config key "${key}" at top level of ${filePath}`);
    }
  }

  const cfg = configDefaults();

  // rpc_urls — required, >= 2, all strings.
  if (toml.rpc_urls === undefined) {
    throw new Error(
      `config ${filePath}: missing required "rpc_urls" (need at least 2 independent RPC endpoints)`,
    );
  }
  if (!Array.isArray(toml.rpc_urls) || toml.rpc_urls.some((v) => !isNonEmptyString(v))) {
    throw new Error(`config ${filePath}: "rpc_urls" must be an array of URL strings`);
  }
  if (toml.rpc_urls.length < 2) {
    throw new Error(
      `config ${filePath}: "rpc_urls" must contain at least 2 endpoints (got ${toml.rpc_urls.length})`,
    );
  }
  cfg.rpcUrls = [...toml.rpc_urls];

  // Kubo API / gateway endpoints.
  if (toml.kubo_api_url !== undefined) {
    if (!isNonEmptyString(toml.kubo_api_url)) {
      throw new Error(`config ${filePath}: "kubo_api_url" must be a string`);
    }
    cfg.kuboApiUrl = toml.kubo_api_url;
  }
  if (toml.kubo_gateway_url !== undefined) {
    if (!isNonEmptyString(toml.kubo_gateway_url)) {
      throw new Error(`config ${filePath}: "kubo_gateway_url" must be a string`);
    }
    cfg.kuboGatewayUrl = toml.kubo_gateway_url;
  }

  // poll_interval_ms / rollback_depth — positive numbers when present.
  if (toml.poll_interval_ms !== undefined) {
    if (!isPositiveNumber(toml.poll_interval_ms)) {
      throw new Error(
        `config ${filePath}: "poll_interval_ms" must be a positive number (got ${JSON.stringify(toml.poll_interval_ms)})`,
      );
    }
    cfg.pollIntervalMs = toml.poll_interval_ms;
  }
  if (toml.rollback_depth !== undefined) {
    if (!isPositiveNumber(toml.rollback_depth)) {
      throw new Error(
        `config ${filePath}: "rollback_depth" must be a positive number (got ${JSON.stringify(toml.rollback_depth)})`,
      );
    }
    cfg.rollbackDepth = toml.rollback_depth;
  }

  // nginx command overrides.
  if (toml.nginx_test_cmd !== undefined) {
    if (!isNonEmptyString(toml.nginx_test_cmd)) {
      throw new Error(`config ${filePath}: "nginx_test_cmd" must be a string`);
    }
    cfg.nginxTestCmd = toml.nginx_test_cmd;
  }
  if (toml.nginx_reload_cmd !== undefined) {
    if (!isNonEmptyString(toml.nginx_reload_cmd)) {
      throw new Error(`config ${filePath}: "nginx_reload_cmd" must be a string`);
    }
    cfg.nginxReloadCmd = toml.nginx_reload_cmd;
  }

  // alert_cmd — optional string (TOML has no null; absence => null).
  if (toml.alert_cmd !== undefined) {
    if (!isNonEmptyString(toml.alert_cmd)) {
      throw new Error(`config ${filePath}: "alert_cmd" must be a string (or omitted)`);
    }
    cfg.alertCmd = toml.alert_cmd;
  }

  // magazines.
  if (toml.magazines !== undefined) {
    if (!Array.isArray(toml.magazines)) {
      throw new Error(`config ${filePath}: "magazines" must be an array of tables`);
    }
    cfg.magazines = toml.magazines.map((entry, i) => {
      const where = `magazines[${i}]`;
      if (!isRecord(entry)) {
        throw new Error(`config ${filePath}: ${where} must be a table`);
      }
      for (const key of Object.keys(entry)) {
        if (!MAGAZINE_KEYS.has(key)) {
          throw new Error(`config ${filePath}: unknown key "${key}" in ${where}`);
        }
      }

      const requireStr = (v: unknown, name: string): string => {
        if (!isNonEmptyString(v)) {
          throw new Error(`config ${filePath}: ${where} missing or invalid "${name}"`);
        }
        return v;
      };

      const domain = requireStr(entry.domain, "domain");
      if (!domain.includes(".")) {
        throw new Error(
          `config ${filePath}: ${where} "domain" must contain a dot (got "${domain}")`,
        );
      }
      const ensName = requireStr(entry.ens_name, "ens_name");
      if (!ensName.endsWith(".eth")) {
        throw new Error(
          `config ${filePath}: ${where} "ens_name" must end in .eth (got "${ensName}")`,
        );
      }
      const nginxInclude = requireStr(entry.nginx_include, "nginx_include");
      const stateDir = requireStr(entry.state_dir, "state_dir");

      // Per-magazine overrides fall back to the top-level defaults.
      let kuboGatewayUrl = cfg.kuboGatewayUrl;
      if (entry.kubo_gateway_url !== undefined) {
        if (!isNonEmptyString(entry.kubo_gateway_url)) {
          throw new Error(`config ${filePath}: ${where} "kubo_gateway_url" must be a string`);
        }
        kuboGatewayUrl = entry.kubo_gateway_url;
      }

      let kuboApiUrl: string | undefined;
      if (entry.kubo_api_url !== undefined) {
        if (!isNonEmptyString(entry.kubo_api_url)) {
          throw new Error(`config ${filePath}: ${where} "kubo_api_url" must be a string`);
        }
        kuboApiUrl = entry.kubo_api_url;
      }

      return {
        domain,
        ensName,
        nginxInclude,
        stateDir,
        kuboGatewayUrl,
        ...(kuboApiUrl !== undefined ? { kuboApiUrl } : {}),
      };
    });
  }

  return cfg;
}
