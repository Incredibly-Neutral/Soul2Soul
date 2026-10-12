#!/usr/bin/env node
// heal-observe.mjs — heal a CID, then poll ipfs-check every N seconds to watch
// when each provider's availability dot flips green.
//
//   node scripts/heal-observe.mjs <cid> [options]
//
// Options:
//   --providers kubo,pinata,filebase,filecoin   heal these (default: kubo,pinata,filebase,filecoin)
//   --interval 30                      seconds between ipfs-check polls (default 30)
//   --polls N                          stop after N polls (default: run until Ctrl-C)
//   --until-green                      stop as soon as every heal provider has served
//   --no-heal                          skip the heal phase, just observe
//   --dry-run                          validate CID + tokens and print what would run, then exit
//   --source <url>                     override the kubo source (default: IPFS_URL from env)
//   --endpoint <url>                   override the ipfs-check batch endpoint
//   --concurrency 2                    heal concurrency (default 2)
//
// Tokens come from process.env, falling back to the monorepo root .env
// (VITE_PINATA_JWT / VITE_FILEBASE_TOKEN / VITE_KUBO_TOKEN / VITE_DRPC_API_KEY).
//
// Filecoin heal uses the app's exact path: shared FilecoinStorage + the node
// CAR builder (both now in shared), the session key from
// safe-app/public/session-key.json, and the DRPC RPC endpoint
// (VITE_DRPC_API_KEY from env, glif fallback). The filecoin core (synapse-sdk,
// @ipld/car, viem, filecoin-pin, multiformats) ships as a single bundled
// scripts/vendor/filecoin.cjs — @filoz/synapse-sdk has no Node exports map, so
// plain node rejects it and esbuild (which falls back to `main`) bundles it.
// Regenerate after shared changes with:
//   pnpm exec esbuild scripts/vendor/entry.ts --bundle --format=cjs \
//     --platform=node --target=node22 --outfile=scripts/vendor/filecoin.cjs
//
// Requires `pnpm -C shared build` to have been run (this imports shared/dist).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { healCid, HEAL_PROVIDERS } from '../shared/dist/heal/index.js';
import { checkBatch, statusFromCheckLine, IPFS_CHECK_ENDPOINT } from '../shared/dist/cid-view/ipfs-check-client.js';
import { classifyProvider } from '../shared/dist/cid-view/retrieval-parser.js';
import { FilecoinStorage, nodeFilecoinBuilder } from './vendor/filecoin.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ENV = path.join(__dirname, '..', '.env');

const SOURCES = ['kubo', 'pinata', 'filebase', 'filecoin'];
const COLOR = process.stdout.isTTY
  ? { green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
  : { green: (s) => s, red: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s };

// ---- env loading -----------------------------------------------------------

function loadEnvFile() {
  try {
    const text = readFileSync(MONOREPO_ENV, 'utf8');
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

const envFile = loadEnvFile();
function env(key, fallback = '') {
  return process.env[key] ?? envFile[key] ?? fallback;
}

// ---- filecoin uploader -----------------------------------------------------

const SESSION_KEY_PATH = path.join(__dirname, '..', 'safe-app', 'public', 'session-key.json');

function filecoinReadiness() {
  let sk = null;
  let skError = null;
  try {
    sk = JSON.parse(readFileSync(SESSION_KEY_PATH, 'utf8'));
  } catch (e) {
    skError = e instanceof Error ? e.message : String(e);
  }
  const rpcKey = env('VITE_DRPC_API_KEY');
  const exp = sk?.expiresAt ? new Date(sk.expiresAt) : null;
  return {
    skOk: !!sk && typeof sk?.sessionPrivateKey === 'string',
    skError,
    expired: exp ? exp.getTime() < Date.now() : false,
    expiredAt: exp,
    rpcOk: !!rpcKey,
    rpcUrl: rpcKey ? `https://lb.drpc.live/filecoin/${rpcKey}` : 'https://api.node.glif.io/rpc/v1',
  };
}

/**
 * Build the filecoin uploader exactly like safe-app's healToFilecoin: fetch the
 * CAR from the kubo source (dag/export) and commit 2x copies via
 * FilecoinStorage.uploadTree, fail-open (returns copyCount:0 instead of
 * throwing) so the shared healCid records it as a per-provider failure.
 * Initialised with the session key (safe-app/public/session-key.json) over the
 * DRPC RPC endpoint, same as the app's initFC().
 */
async function createFilecoinUploader(kuboToken) {
  const fr = filecoinReadiness();
  if (!fr.skOk) {
    throw new Error(`session key unreadable: ${fr.skError ?? 'missing sessionPrivateKey'} (${SESSION_KEY_PATH})`);
  }
  if (fr.expired) {
    console.log(COLOR.yellow(`  note: session key expired at ${fr.expiredAt.toISOString()} — session sync may fail.`));
  }
  const storage = new FilecoinStorage({}, nodeFilecoinBuilder);
  await storage.initWithSessionKey(JSON.parse(readFileSync(SESSION_KEY_PATH, 'utf8')), fr.rpcUrl);
  return async (cid, source) => {
    const headers = {};
    if (kuboToken) headers.Authorization = `Bearer ${kuboToken}`;
    try {
      const res = await fetch(`${source}/api/v0/dag/export?arg=${encodeURIComponent(cid)}`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        console.warn(`filecoin: dag/export failed (HTTP ${res.status})`);
        return { copyCount: 0, pieceCid: '' };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const r = await storage.uploadTree(bytes, [], 'heal');
      return { pieceCid: r.pieceCid, copyCount: r.copyCount, copies: r.copies };
    } catch (e) {
      console.warn('filecoin: upload failed', e instanceof Error ? e.message : String(e));
      return { copyCount: 0, pieceCid: '' };
    }
  };
}

// ---- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
  const args = { providers: null, interval: 30, polls: Infinity, untilGreen: false, noHeal: false, dryRun: false, source: null, endpoint: null, concurrency: 2 };
  const cids = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--providers') args.providers = argv[++i].split(',');
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--polls') args.polls = Number(argv[++i]);
    else if (a === '--until-green') args.untilGreen = true;
    else if (a === '--no-heal') args.noHeal = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--endpoint') args.endpoint = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else cids.push(a);
  }
  if (cids.length !== 1) throw new Error('usage: node scripts/heal-observe.mjs <cid> [--interval 30] [--polls N] [--until-green] [--no-heal] [--dry-run]');
  args.cid = cids[0];
  return args;
}

// ---- display helpers -------------------------------------------------------

const dot = (on) => (on ? COLOR.green('●') : COLOR.red('○'));
const dotUnknown = () => COLOR.yellow('?');

function dotFor(source, status) {
  if (!status) return dotUnknown();
  if (status.state === 'inconclusive' && status.copies === 0) return dotUnknown();
  return dot(!!status.sources[source]);
}

function hostLabel(provider) {
  const cp = classifyProvider(provider);
  if (cp.addrs && cp.addrs.length) {
    const host = cp.addrs[0].match(/\/?([^/]+)$/)?.[1] ?? cp.addrs[0];
    return `${host}${cp.agent ? ` · ${cp.agent}` : ''}`;
  }
  return cp.id || cp.source || 'unknown';
}

function servingDetail(row) {
  if (!Array.isArray(row.result) || row.result.length === 0) return null;
  const lines = [];
  for (const p of row.result) {
    const cp = classifyProvider(p);
    const ok = cp.servedHttp || cp.servedBitswap;
    const what = cp.servedHttp ? 'http' : cp.servedBitswap ? 'bitswap' : '';
    lines.push(
      ok
        ? `  ${COLOR.green('serves ')} [${(cp.platforms.join('|') || '?').padEnd(8)}] ${hostLabel(p)} (${what})`
        : `  ${COLOR.dim('no     ')} [${(cp.platforms.join('|') || '?').padEnd(8)}] ${hostLabel(p)}${p.ConnectionError ? ` — ${p.ConnectionError}` : ''}`,
    );
  }
  return lines.join('\n');
}

// ---- main ------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(COLOR.red(`error: ${e.message}`));
    process.exit(2);
  }

  const source = (args.source ?? env('IPFS_URL', 'https://ipfs.transport-union.dev')).replace(/\/+$/, '');
  const endpoint = args.endpoint ?? IPFS_CHECK_ENDPOINT;
  let providers = (args.providers ?? ['kubo', 'pinata', 'filebase', 'filecoin']).filter((p) => HEAL_PROVIDERS.includes(p));
  const filecoinRequested = providers.includes('filecoin');
  const pinataJwt = env('VITE_PINATA_JWT', env('PINATA_JWT'));
  const filebaseToken = env('VITE_FILEBASE_TOKEN');
  const kuboToken = env('VITE_KUBO_TOKEN');

  const tokens = [
    ['pinata', !!pinataJwt],
    ['filebase', !!filebaseToken],
    ['kubo', !!kuboToken],
  ];

  console.log(COLOR.bold(`cid       : ${args.cid}`));
  console.log(`source    : ${source}`);
  console.log(`check     : ${endpoint}/batch`);
  console.log(`providers : ${providers.join(', ')} (observe: ${SOURCES.join(',')})`);
  console.log(`tokens    : ${tokens.map(([k, v]) => `${k}=${v ? COLOR.green('✓') : COLOR.red('✗')}`).join('  ')}`);
  console.log(`interval  : ${args.interval}s${args.polls !== Infinity ? `, ${args.polls} polls max` : ''}${args.untilGreen ? ', stop when all green' : ''}`);

  const config = { source, pinataJwt, filebaseToken, kuboToken };

  let filecoinActive = false;
  let filecoinWarn = null;
  if (filecoinRequested && !args.dryRun && !args.noHeal) {
    try {
      config.filecoin = await createFilecoinUploader(kuboToken);
      filecoinActive = true;
    } catch (e) {
      filecoinWarn = e instanceof Error ? e.message : String(e);
      providers = providers.filter((p) => p !== 'filecoin');
    }
  }

  const scope =
    filecoinActive
      ? COLOR.green(`${providers.join(', ')} — filecoin upload ACTIVE (2x via session key + node builder)`)
      : filecoinRequested
        ? args.dryRun || args.noHeal
          ? COLOR.yellow(`${providers.join(', ')} — filecoin requested but skipped (${args.dryRun ? 'dry-run' : 'observe-only'})`)
          : COLOR.red(`${providers.join(', ')} — filecoin UNAVAILABLE: ${filecoinWarn}`)
        : COLOR.yellow(`${providers.join(', ')} — filecoin not requested`);
  console.log(`\nHEAL SCOPE: ${scope}.`);
  if (filecoinRequested && !filecoinActive && !args.dryRun && !args.noHeal) {
    console.log(COLOR.yellow('  Any green filecoin dot below is a pre-existing deal, NOT this run.'));
  }

  if (args.dryRun) {
    if (filecoinRequested) {
      const fr = filecoinReadiness();
      console.log(`filecoin  : ${fr.skOk ? COLOR.green('session-key ✓') : COLOR.red('session-key ✗')}  ${fr.rpcOk ? COLOR.green('drpc ✓') : COLOR.yellow('drpc ✗ (glif fallback)')}${fr.expired ? COLOR.yellow('  [KEY EXPIRED]') : ''}`);
    }
    console.log(COLOR.yellow('\ndry-run: no heal, no check calls. Exiting.'));
    return;
  }

  // ---- heal phase ----
  if (!args.noHeal) {
    console.log(`\n${COLOR.bold('— heal —')}`);
    const started = Date.now();
    const outcome = await healCid(args.cid, config, providers, { concurrency: args.concurrency });
    const ms = Date.now() - started;
    console.log(`healCid done in ${ms}ms — ${outcome.ok ? COLOR.green('OK') : outcome.partial ? COLOR.yellow('PARTIAL') : COLOR.red('FAILED')}`);
    for (const r of outcome.results) {
      const tag = r.ok ? COLOR.green('ok  ') : COLOR.red('fail');
      console.log(`  [${tag}] ${r.provider.padEnd(8)}${r.ok ? '' : ` — ${r.error ?? 'no error'}`}${r.ms !== undefined ? ` (${r.ms}ms)` : ''}${r.copyCount !== undefined ? ` copies=${r.copyCount}` : ''}`);
    }
    if (filecoinRequested && !filecoinActive) {
      console.log(COLOR.yellow('  filecoin: not attempted this run (see HEAL SCOPE above). Any green filecoin dot below is a pre-existing deal, NOT this run.'));
    }
  }

  // ---- observe phase ----
  console.log(`\n${COLOR.bold('— observe (first poll immediately, then every ' + args.interval + 's; Ctrl-C to stop) —')}`);
  const header = `  ${'t'.padEnd(9)}${SOURCES.map((s) => s.padStart(3)).join('')} ${'copies'.padEnd(7)} state`;
  console.log(header);

  const firstSeen = {};
  let poll = 0;
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    console.log('\n' + COLOR.yellow('interrupt — finishing current poll, then summary'));
  });

  while (!stopping && poll < args.polls) {
    poll += 1;
    const t0 = Date.now();
    let row = null;
    let status = null;
    let error = null;
    try {
      const signal = AbortSignal.timeout(Math.max(args.interval * 1000, 90_000));
      await checkBatch(
        [args.cid],
        (line) => {
          row = line;
          status = statusFromCheckLine(line);
        },
        { endpoint, signal },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const took = Math.round(Date.now() - t0);

    if (error) {
      console.log(`  ${new Date().toISOString().slice(11, 19)}  ${COLOR.red('poll error: ' + error)}`);
    } else if (row?.error) {
      console.log(`  ${new Date().toISOString().slice(11, 19)}  ${COLOR.red('check error: ' + row.error)}`);
    } else {
      const t = new Date().toISOString().slice(11, 19);
      const dots = SOURCES.map((s) => dotFor(s, status)).join(' ');
      const fresh = [];
      for (const s of SOURCES) {
        if (status?.sources?.[s] && !firstSeen[s]) {
          firstSeen[s] = t;
          fresh.push(s);
        }
      }
      const state = status?.state ?? '?';
      const msTxt = row?.ms !== undefined ? ` (${row.ms}ms local)` : '';
      const freshTxt = fresh.length ? COLOR.green(`  ← NEW: ${fresh.join(', ')}`) : '';
      console.log(`  ${t}  ${dots} ${String(status?.copies ?? 0).padEnd(7)} ${state}${msTxt}${freshTxt}`);
      const detail = servingDetail(row);
      if (detail) console.log(detail);

      if (args.untilGreen && providers.every((p) => firstSeen[p])) {
        console.log(COLOR.green(`\nall requested providers serving — stopping.`));
        stopping = true;
      }
    }

    if (!stopping && poll < args.polls) {
      const wait = args.interval * 1000 - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  // ---- summary ----
  console.log(`\n${COLOR.bold('— first-seen-serving —')}`);
  for (const s of SOURCES) {
    console.log(`  ${s.padEnd(8)} ${firstSeen[s] ? COLOR.green('●') : COLOR.red('○')}  ${firstSeen[s] ?? 'never (still not serving)'}`);
  }
  if (poll >= args.polls) console.log(COLOR.dim(`reached poll cap (${args.polls})`));
}

main().catch((e) => {
  console.error(COLOR.red(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.exit(1);
});
