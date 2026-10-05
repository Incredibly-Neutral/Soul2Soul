import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['scripts/lit/**/*.test.ts'],
    root: '.',
  },
});
