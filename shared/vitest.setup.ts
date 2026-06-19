import { config } from 'dotenv';
import { resolve } from 'path';

// Load root .env from monorepo root
config({ path: resolve(process.cwd(), '../.env') });