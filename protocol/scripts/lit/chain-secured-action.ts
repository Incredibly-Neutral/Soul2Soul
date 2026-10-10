/**
 * chain-secured-action.ts — build + CID helpers for the recurring action
 * scripts (swap-action / add-action / remove-action) in ChainSecured mode.
 *
 * The server computes an action's IPFS CID with the UnixFS FileAdder
 * (`ipfs_hasher::IpfsHasher` — CIDv0 dag-pb, verified in core_features.rs),
 * which is byte-for-byte the same algorithm as `ipfs-only-hash`. We therefore
 * compute the CID locally (deterministic, offline-safe) instead of calling
 * POST /get_lit_action_ipfs_id, and cross-check it against Pinata's returned
 * CID when we actually pin in real mode.
 */
import esbuild from 'esbuild';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { compactAction } from '@s2s/soul2soul-shared';
import { of as ipfsOnlyHashOf } from 'typestub-ipfs-only-hash';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // <repo>/protocol/scripts/lit
const protocolRoot = path.resolve(__dirname, '..', '..'); // <repo>/protocol

const VALID_ACTIONS = ['prep', 'render', 'update', 'maintain-cache', 'encrypt', 'render-dev'];

export function assertValidAction(name: string): string {
  if (!VALID_ACTIONS.includes(name)) {
    throw new Error(`Unknown action "${name}". Valid actions: ${VALID_ACTIONS.join(', ')}`);
  }
  return name;
}

export function actionSourcePath(name: string): string {
  return path.join(protocolRoot, 'actions/src', name, 'main.ts');
}

export function actionDistPath(name: string): string {
  return path.join(protocolRoot, 'actions/dist', name, 'main.js');
}

/**
 * Build a single action with esbuild and apply the same post-processing as
 * protocol/scripts/lit/build-actions.cjs (strip use strict / comments, unwrap
 * the IIFE) so the resulting code (and therefore its CID) matches the pinned
 * artifacts in config.json.
 * @returns the built, post-processed action code.
 */
export async function buildAction(name: string): Promise<string> {
  const entry = actionSourcePath(name);
  if (!fs.existsSync(entry)) {
    throw new Error(`Action source not found: ${entry}`);
  }
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile: actionDistPath(name),
    format: 'iife',
    globalName: '__LitAction',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    treeShaking: false,
    mainFields: ['browser', 'module', 'main'],
    external: ['ethers', '@lit-protocol/*', 'crypto', 'stream', 'buffer', 'util'],
    define: {
      'process.env.NODE_ENV': '"production"',
      global: 'globalThis',
    },
  });

  const out = actionDistPath(name);
  let code = fs.readFileSync(out, 'utf8');
  code = code.replace(/"use strict";\s*/g, '');
  code = code.replace(/\/\/ [^\n]+\.ts\n?/g, ''); // strip esbuild source comments with newline
  code = code.replace(/(?<!['":`])\/\/[^\n]*/g, ''); // strip all remaining single-line comments

  const iife = 'var __LitAction = (() => {';
  const start = code.indexOf(iife) + iife.length;
  const end = code.lastIndexOf('})();');
  if (start < iife.length || end === -1) {
    throw new Error(`Unexpected esbuild output shape for action "${name}"`);
  }
  code = code.substring(start, end);
  code = code.replace(/\s*return __toCommonJS\(main_exports\);\s*$/, '');

  fs.writeFileSync(out, code.trim());
  return code;
}

/** Read a previously-built action from dist (throws if not built). */
export function readBuiltAction(name: string): string {
  const out = actionDistPath(name);
  if (!fs.existsSync(out)) {
    throw new Error(
      `Built action not found: ${out} — run "pnpm actions:build" or let the script build it.`,
    );
  }
  return fs.readFileSync(out, 'utf8');
}

/**
 * Compute the action's IPFS CID locally (== server's IpfsHasher / Pinata CID
 * for the same bytes). The code passed in is expected to be the post-build,
 * compacted code.
 */
export async function computeActionCid(code: string): Promise<string> {
  return ipfsOnlyHashOf(code);
}

/** compactAction wrapper so scripts don't each import it. */
export function compact(code: string): string {
  return compactAction(code);
}
