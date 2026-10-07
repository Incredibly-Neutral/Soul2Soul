import { afterEach } from 'vitest';
import { cleanupMounted } from './mount';

// Browser-mode (component) tests all share one document. Tear down whatever
// the previous test mounted so each spec starts from a clean <body>.
afterEach(() => {
  cleanupMounted();
});
