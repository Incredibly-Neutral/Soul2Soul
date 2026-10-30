import { config } from 'dotenv';
import { resolve } from 'path';

// Load the monorepo root .env (same pattern as 0xobsidian / shared).
// Missing file (e.g. inside a git worktree) is silently ignored — unit
// tests must not depend on live env vars.
config({ path: resolve(process.cwd(), '../.env') });
