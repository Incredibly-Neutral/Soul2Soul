/**
 * add-dev-action.ts — build + upload the dev "render-dev" action to Pinata.
 *
 * LIGHTER than add-action.ts by design: the dev action is a no-key, no-sign
 * pure renderer that runs on the Bun runner (S2S_RUNNER_URL), so it needs NO
 * Lit registration, NO PKP binding, NO group membership. All we do is:
 *
 *   1. build protocol/actions/dist/render-dev/main.js via build-actions.cjs
 *   2. compactAction(code)
 *   3. ipfs.uploadToPinata(_action, 'render-dev')   (IPFS_URL / PINATA_JWT /
 *      PINATA_GATEWAY env)
 *   4. print + record the CID in protocol/scripts/lit/dev-actions.json
 *
 * The website-starter kit then points its `S2S_RUNNER_URL` + dev-action CID at
 * this artifact and POSTs `{ cid, inputs }` to render locally.
 *
 * Usage (from repo root, or via `pnpm actions:add-dev`):
 *   tsx --require dotenv/config protocol/scripts/lit/add-dev-action.ts
 */
import { compactAction, S2SIPFSMethods } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // <root>/protocol/scripts/lit

// Repo root (three levels up from protocol/scripts/lit)
const root = path.resolve(__dirname, '../../..');

// Load env from repo root .env (also fall back to protocol/.env).
dotenv.config({ path: path.join(root, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const ACTION_NAME = 'render-dev';

async function main() {
  // 1. Build all actions (the render-dev entry is wired into build-actions.cjs).
  console.log('→ building actions (render-dev entry) ...');
  execSync('node protocol/scripts/lit/build-actions.cjs', {
    cwd: root,
    stdio: 'inherit',
  });

  const actionPath = path.join(root, 'protocol/actions/dist/render-dev/main.js');
  if (!fs.existsSync(actionPath)) {
    throw new Error(`Built action not found: ${actionPath}`);
  }
  const code = fs.readFileSync(actionPath, 'utf-8');

  // 2. Compact the IIFE bundle.
  const _action = compactAction(code);

  // 3. Upload to Pinata. No LitService — no registerAction / addActionToGroup.
  const ipfs = new S2SIPFSMethods(
    process.env.IPFS_URL!,
    process.env.PINATA_JWT!,
    process.env.PINATA_GATEWAY!,
    process.env.VITE_FILEBASE_TOKEN || '',
  );
  const cid = await ipfs.uploadToPinata(_action, ACTION_NAME);
  console.log(`\nUploaded ${ACTION_NAME} (${_action.length} chars compact)`);
  console.log(`CID: ${cid}`);

  // 4. Record the CID in dev-actions.json next to this script.
  const recordPath = path.join(__dirname, 'dev-actions.json');
  let record: Record<string, unknown> = {};
  if (fs.existsSync(recordPath)) {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  }
  record[ACTION_NAME] = {
    cid,
    bytes: _action.length,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

  console.log(`Recorded → ${recordPath}`);
  console.log('FINISHED');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
