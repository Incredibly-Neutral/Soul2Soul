import type { LitElement } from 'lit';

/**
 * Component-test support for @vitest/browser (Lit custom elements).
 *
 * `mountLit` creates the element, assigns props, attaches it to document.body,
 * and waits for its first render (updateComplete) before returning.
 * `unmount` detaches it (fires disconnectedCallback). `cleanupMounted` empties
 * document.body — the afterEach hook in setup-browser.ts calls it so specs
 * start from a clean <body>.
 *
 * The element's module must be imported before mounting so the custom element
 * is registered, e.g.:
 *   import '../../src/components/toggle-button';
 *   const el = await mountLit<ToggleButton>('toggle-button', { label: 'on' });
 */
export async function mountLit<E extends LitElement>(
  tagName: string,
  props: Record<string, unknown> = {},
): Promise<E> {
  const el = document.createElement(tagName) as E;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Detach a mounted element (fires disconnectedCallback). */
export function unmount<E extends HTMLElement>(el: E): void {
  el.remove();
}

/** Remove every element currently mounted under document.body. */
export function cleanupMounted(): void {
  document.body.replaceChildren();
}
