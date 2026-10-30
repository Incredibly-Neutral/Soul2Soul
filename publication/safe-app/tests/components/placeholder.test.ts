// Placeholder smoke spec for the vitest BROWSER (component) project.
//
// Proves the plumbing end to end: @vitest/browser + playwright provider boots,
// a real Lit custom element mounts through tests/helpers/mount.ts, and the
// afterEach cleanup leaves a clean <body>. Component workers will add real
// specs alongside this file (and may delete it once real specs exist).
import { describe, it, expect } from 'vitest';
import type { LitElement } from 'lit';
import { mountLit, unmount } from '../helpers/mount';
import '../../src/components/toggle-button';

describe('component test plumbing', () => {
  it('mounts a Lit custom element and cleans up after itself', async () => {
    const el = await mountLit<LitElement>('toggle-button', { label: 'plumbing-ok' });
    expect(el.shadowRoot?.textContent).toContain('plumbing-ok');

    unmount(el);
    expect(document.querySelector('toggle-button')).toBeNull();
  });
});
