import { describe, it, expect } from 'vitest';

/**
 * UIStore seam: `src/state/ui.store.ts` is currently fully commented out
 * (every line is a comment) — the module exports nothing at runtime. These
 * tests pin that state so a later worker re-enabling the slice knows what
 * the disabled baseline looks like, and that the state barrel does not
 * re-export it.
 */
describe('ui.store (disabled seam)', () => {
  it('exports no runtime bindings (module is commented out)', async () => {
    const mod = await import('../../src/state/ui.store.js');
    expect(Object.keys(mod)).toEqual([]);
    expect((mod as Record<string, unknown>).UIStore).toBeUndefined();
  });

  it('is not re-exported from the state barrel', async () => {
    const mod = await import('../../src/state/index.js');
    expect('UIStore' in mod).toBe(false);
    expect('uiStore' in mod).toBe(false);
  });

  it('importing the module is side-effect free and does not throw', async () => {
    await expect(import('../../src/state/ui.store.js')).resolves.toBeDefined();
  });
});
