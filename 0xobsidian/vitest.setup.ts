import { config } from 'dotenv';
import { resolve } from 'path';

// Load root .env from monorepo root (same pattern as shared/)
config({ path: resolve(process.cwd(), '../.env') });