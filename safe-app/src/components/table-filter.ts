// table-filter.ts — reusable dropdown filter for the safe-app tables.
//
// A self-contained lit component (label + <select>) used by the deals/offers
// and storage tabs. Options are supplied via the `options` property (they
// derive from the live rows); the current selection is read from the `value`
// property. Emits a composed, bubbling `change` CustomEvent with
// `detail.value` so the host can update its filter state.
//
// Reusable styles come from styles/filter-styles.ts.

import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { filterStyles } from '../styles/filter-styles.js';

@customElement('table-filter')
export class TableFilter extends LitElement {
  @property({ reflect: true }) label = '';

  /** Currently selected option value ('' = All). */
  @property({ reflect: true }) value = '';

  /** Available dropdown options (re-renders the select). */
  @property({ attribute: false }) options: string[] = [];

  static styles = [filterStyles];

  private handleChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.value = select.value;
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { value: select.value },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    return html`
      <label class="table-filter">
        <span class="table-filter__label">${this.label}</span>
        <select class="table-filter__select" aria-label=${this.label} @change=${this.handleChange}>
          <option value="">All</option>
          ${this.options.map(
            (o) =>
              html`<option value=${o} ?selected=${o === this.value}>${o}</option>`,
          )}
        </select>
      </label>
    `;
  }
}
