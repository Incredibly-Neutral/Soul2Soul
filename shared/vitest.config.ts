import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config.base';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      root: '.',
      setupFiles: ['./vitest.setup.ts'],
    },
  }),
);
