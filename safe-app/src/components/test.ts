// test.ts — throwaway smoke-test element ("If you see this, rendering works!").
// Not imported by the app; kept as a minimal LitElement reference.
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('test-app')
export class TestApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 2rem;
    }
    h1 {
      color: red;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    console.log('TestApp connected');
  }

  render() {
    return html`<h1>TEST - If you see this, rendering works!</h1>`;
  }
}
