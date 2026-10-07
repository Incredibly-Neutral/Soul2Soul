/**
 * Safe iframe mock for Playwright e2e.
 *
 * Ported from qa/qa.mjs (DO NOT edit qa.mjs): intercepts the SafeAppsSDK
 * `getSafeInfo` postMessage handshake and replies with the protocol's real
 * Safe + modules, so the app boots with tabs enabled inside a mocked Safe
 * iframe. `getSafeInfoMockInitScript()` returns a self-contained init-script
 * STRING that Playwright injects via `context.addInitScript`.
 */

export const SAFE_ADDRESS = '0x24936f87442673B7c057BF3f5dCCB726baF20c6B';
export const CHAIN_ID = 8453;
export const NETWORK = 'base';
export const THRESHOLD = 1;
export const OWNERS = ['0xd804A40d9C22004457aC2455DB46222212c20594'];
export const PUB_MODULE = '0x4d05a336700644De60F09aF8104DC96047023C1f';
export const REC_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';
export const MODULES = [PUB_MODULE, REC_MODULE];

/** The exact SafeInfo payload qa/qa.mjs returns for getSafeInfo. */
export const SAFE_INFO = {
  safeAddress: SAFE_ADDRESS,
  chainId: CHAIN_ID,
  network: NETWORK,
  threshold: THRESHOLD,
  owners: OWNERS,
  modules: MODULES,
} as const;

/**
 * Return the Safe getSafeInfo mock as an init-script string. Pass the string
 * straight to `context.addInitScript()` (or `page.addInitScript()`).
 *
 * Mirrors qa/qa.mjs's safeMockInitScript: patches window.parent.postMessage
 * and, for any `getSafeInfo` request, dispatches a synthetic MessageEvent with
 * the payload above. All other messages fall through to the real postMessage.
 */
export function getSafeInfoMockInitScript(info: typeof SAFE_INFO = SAFE_INFO): string {
  const payload = JSON.stringify(info);
  return `(() => {
    const info = ${payload};
    const realPost = window.parent.postMessage.bind(window.parent);
    window.parent.postMessage = (request, targetOrigin) => {
      if (request && typeof request === 'object' && request.method === 'getSafeInfo') {
        setTimeout(() => {
          const evt = new MessageEvent('message', {
            data: {
              id: request.id,
              success: true,
              version: '1.0.0',
              data: info,
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
  })();`;
}
