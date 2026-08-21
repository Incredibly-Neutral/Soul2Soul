// table-filter.ts — reusable dropdown filter for the safe-app tables.
//
// A self-contained custom element (label + <select>) used by the deals/offers
// and storage tabs. Options are supplied via the `options` property (set after
// mount, since they derive from the live rows); the current selection is read
// from the `value` attribute/property. Emits a composed, bubbling `change`
// CustomEvent with `detail.value` so the host can update its filter state.
//
// Follows the existing custom-element + shadow-DOM pattern (toggle-button.ts,
// copy-content-id.ts); reusable styles come from styles/filter-styles.ts.

import { filterStyles } from '../styles/filter-styles.js';

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

class TableFilter extends HTMLElement {
  private labelValue = '';
  private optionsValue: string[] = [];
  private valueValue = '';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [filterStyles];
  }

  static get observedAttributes() {
    return ['label', 'value'];
  }

  /** Available dropdown options (re-renders the select). */
  set options(list: string[]) {
    this.optionsValue = list ?? [];
    if (this.shadowRoot) this.render();
  }

  get options(): string[] {
    return this.optionsValue;
  }

  /** Currently selected option value ('' = All). */
  set value(v: string) {
    this.valueValue = v ?? '';
    if (this.shadowRoot) this.render();
  }

  get value(): string {
    return this.valueValue;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue === newValue) return;
    if (name === 'label') this.labelValue = newValue ?? '';
    if (name === 'value') this.valueValue = newValue ?? '';
    if (this.shadowRoot) this.render();
  }

  connectedCallback() {
    this.labelValue = this.getAttribute('label') ?? '';
    this.valueValue = this.getAttribute('value') ?? '';
    this.render();
  }

  private render() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <label class="table-filter">
        <span class="table-filter__label">${escapeHtml(this.labelValue)}</span>
        <select class="table-filter__select" aria-label="${escapeHtml(this.labelValue)}">
          <option value="">All</option>
          ${this.optionsValue
            .map(
              (o) =>
                `<option value="${escapeHtml(o)}"${o === this.valueValue ? ' selected' : ''}>${escapeHtml(o)}</option>`,
            )
            .join('')}
        </select>
      </label>
    `;

    const select = this.shadowRoot.querySelector('.table-filter__select') as HTMLSelectElement;
    select?.addEventListener('change', () => {
      this.valueValue = select.value;
      this.dispatchEvent(
        new CustomEvent('change', {
          detail: { value: select.value },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }
}

customElements.define('table-filter', TableFilter);

export { TableFilter };
