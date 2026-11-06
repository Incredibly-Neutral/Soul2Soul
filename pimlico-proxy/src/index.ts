/**
 * Process entrypoint: load config, listen, log once, shut down cleanly.
 *
 * No argument parsing. A bad environment is a startup failure with a message
 * naming the variable and nothing else.
 */
import { ConfigError, loadConfig } from './config.js';
import { createServer } from './server.js';

import type { Config } from './types.js';

/** A hung socket must never hold a shutdown open past this. */
const FORCE_EXIT_MS = 20_000;

function loadOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`pimlico-proxy: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function main(): void {
  const cfg = loadOrExit();
  const server = createServer(cfg);

  server.listen(cfg.port, (): void => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : cfg.port;
    console.log(
      JSON.stringify({
        event: 'listening',
        port,
        chains: [...cfg.allowedChainIds],
        allowlistEntries: cfg.allowedCalls.length,
        authMode: cfg.authMode,
      }),
    );
  });

  let closing = false;
  const shutdown = (): void => {
    if (closing) process.exit(0);
    closing = true;
    setTimeout(() => process.exit(0), FORCE_EXIT_MS).unref();
    server.close((): void => {
      process.exit(0);
    });
  };

  server.on('error', (error: Error): void => {
    const code = (error as NodeJS.ErrnoException).code;
    process.stderr.write(`pimlico-proxy: ${code ?? error.message}\n`);
    process.exit(1);
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
