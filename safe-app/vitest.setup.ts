import { config } from 'dotenv';
import { resolve } from 'path';

// Load the monorepo root .env (same pattern as 0xobsidian/vitest.setup.ts and
// shared/vitest.setup.ts). Runs in the node-env unit project only — browser
// (component) tests get their VITE_* vars via envDir in vitest.config.ts.
config({ path: resolve(process.cwd(), '../.env') });
