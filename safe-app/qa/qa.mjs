#!/usr/bin/env node
// safe-app QA — headless verification of the production build inside a mocked
// Safe iframe.
//
// Purpose: catch the "tabs don't switch" class of regression (a silent
// reactivity failure like the useDefineForClassFields bug) without needing a
// real Safe UI or a funded wallet. The Safe postMessage handshake is mocked so
// SafeAppsSDK.getInfo() resolves; module detection runs against real RPC.
//
// What it checks (functional only — no typography assertions):
//   - all 5 nav tabs render enabled
//   - clicking Deals / Whitelists / Records / Storage / Website-Tree switches
//     the active tab AND swaps the rendered component
//
// Usage:
//   pnpm qa                        # build (if needed) + preview + probe
//   PROBE_URL=http://host:port pnpm qa   # probe an already-running server
//   QA_PORT=4175 pnpm qa           # pick a different preview port
//   SKIP_BUILD=1 pnpm qa           # don't build even if dist/ is missing
//
// Exit code 0 = all checks passed; 1 = a check failed; 2 = harness error.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const distRoot = path.join(appRoot, 'dist');

const PROBE_URL = process.env.PROBE_URL;
const PORT = Number(process.env.QA_PORT || 4174);
const URL = PROBE_URL || `http://127.0.0.1:${PORT}/`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Safe iframe mock — makes SafeAppsSDK.getInfo() resolve with the protocol's
// real Safe + modules, so the app boots (tabs enabled) without a Safe UI.
// ---------------------------------------------------------------------------
const PUB_MODULE = '0x4d05a336700644De60F09aF8104DC96047023C1f';
const REC_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';

const safeMockInitScript = ({ pub, rec }) => {
  const realPost = window.parent.postMessage.bind(window.parent);
  window.parent.postMessage = (request, targetOrigin) => {
    if (request && typeof request === 'object' && request.method === 'getSafeInfo') {
      setTimeout(() => {
        const evt = new MessageEvent('message', {
          data: {
            id: request.id,
            success: true,
            version: '1.0.0',
            data: {
              safeAddress: '0x24936f87442673B7c057BF3f5dCCB726baF20c6B',
              chainId: 8453,
              network: 'base',
              threshold: 1,
              owners: ['0xd804A40d9C22004457aC2455DB46222212c20594'],
              modules: [pub, rec],
            },
          },
          origin: 'https://app.safe.global',
          source: window.parent,
        });
        window.dispatchEvent(evt);
      }, 50);
      return;
    }
    return realPost(request, targetOrigin);
  };
};

// ---------------------------------------------------------------------------
// probe — load the app with the mock and exercise the tabs
// ---------------------------------------------------------------------------
async function runProbe() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(safeMockInitScript, { pub: PUB_MODULE, rec: REC_MODULE });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(URL, { waitUntil: 'load', timeout: 25000 });

  // wait for the app to boot + connect (Safe mock resolves, tabs become enabled)
  const ready = await page
    .waitForSelector('s2s-app', { timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  let results = [];
  if (!ready) {
    results.push(log('app boots and renders s2s-app', false, 'no <s2s-app> found'));
  } else {
    // wait until tabs are clickable (post-connect)
    const tabsReady = await page
      .evaluate(
        () =>
          new Promise((resolve) => {
            const app = document.querySelector('s2s-app');
            const check = () => {
              const tabs = app?.shadowRoot?.querySelectorAll('.tab');
              if (tabs && tabs.length === 5) resolve(true);
            };
            check();
            const iv = setInterval(() => {
              check();
              if (document.querySelector('s2s-app')?.shadowRoot?.querySelectorAll('.tab')?.length === 5) {
                clearInterval(iv);
                resolve(true);
              }
            }, 200);
            setTimeout(() => { clearInterval(iv); resolve(false); }, 20000);
          }),
      )
      .catch(() => false);

    if (!tabsReady) {
      results.push(log('5 nav tabs render', false, 'tab count != 5'));
    } else {
      const tabs = await page.evaluate(() =>
        [...document.querySelector('s2s-app').shadowRoot.querySelectorAll('.tab')].map((b) => b.id),
      );
      results.push(log('5 nav tabs render', true, tabs.join(', ')));
      results.push(
        log(
          'all tabs enabled',
          (await page.evaluate(
            () => [...document.querySelector('s2s-app').shadowRoot.querySelectorAll('.tab')].every((b) => !b.disabled),
          )),
        ),
      );

      const EXPECT = {
        'deals-tab': 'S2S-DEALS-TAB',
        'whitelist-tab': 'S2S-WHITELIST-TAB',
        'records-tab': 'S2S-RECORDS-TAB',
        'storage-tab': 'S2S-STORAGE-TAB',
        'website-tree-tab': 'S2S-WEBSITE-TREE-TAB',
      };

      for (const [tabId, expectedTag] of Object.entries(EXPECT)) {
        await page.evaluate((tid) => {
          document.querySelector('s2s-app').shadowRoot.querySelector('#' + tid).click();
        }, tabId);
        await page.waitForTimeout(1500);
        const st = await page.evaluate(() => {
          const app = document.querySelector('s2s-app');
          return {
            active: app.shadowRoot.querySelector('.tab.active')?.id ?? null,
            child: app.shadowRoot.querySelector('#tab-content')?.firstElementChild?.tagName ?? null,
          };
        });
        const okActive = st.active === tabId;
        const okChild = st.child === expectedTag;
        results.push(
          log(
            `click ${tabId}`,
            okActive && okChild,
            `active=${st.active} (expect ${tabId}), content=${st.child} (expect ${expectedTag})`,
          ),
        );
      }

      if (errors.length) {
        results.push(log('no page errors', false, errors.slice(0, 3).join(' | ')));
      } else {
        results.push(log('no page errors', true));
      }
    }
  }

  await browser.close();
  return results.every(Boolean);
}

// ---------------------------------------------------------------------------
// orchestrator — build + preview + probe, then clean up
// ---------------------------------------------------------------------------
async function main() {
  const results = [];

  if (PROBE_URL) {
    console.log(`Probing existing server: ${URL}`);
    const ok = await runProbe();
    results.push(ok);
  } else {
    if (!existsSync(path.join(distRoot, 'index.html'))) {
      if (process.env.SKIP_BUILD) {
        console.error('dist/ missing and SKIP_BUILD=1 — run `pnpm build` first.');
        process.exit(2);
      }
      console.log('dist/ missing — building first...');
      const b = spawn('pnpm', ['build'], { cwd: appRoot, stdio: 'inherit' });
      const code = await new Promise((res) => b.on('close', res));
      if (code !== 0) {
        console.error('build failed; aborting QA.');
        process.exit(2);
      }
    }

    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--no-open'], {
      cwd: appRoot,
      stdio: 'ignore',
    });

    // wait for the preview server to accept connections
    let up = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        const res = await fetch(URL);
        if (res.ok) { up = true; break; }
      } catch {}
    }
    if (!up) {
      console.error('preview server did not start.');
      preview.kill('SIGTERM');
      process.exit(2);
    }

    console.log(`Preview ready at ${URL} — running probe...\n`);
    try {
      const ok = await runProbe();
      results.push(ok);
    } catch (err) {
      console.error('probe crashed:', err);
      results.push(false);
    } finally {
      preview.kill('SIGTERM');
      await sleep(500);
    }
  }

  const ok = results.every(Boolean);
  console.log(`\n=== QA ${ok ? 'PASSED' : 'FAILED'} ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
