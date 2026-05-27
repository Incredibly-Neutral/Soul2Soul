class TestApp extends HTMLElement {
  constructor() {
    super();
    console.log('TestApp constructor');
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    console.log('TestApp connected');
    this.shadowRoot!.innerHTML = `
      <style>
        :host { display: block; padding: 2rem; }
        h1 { color: red; }
      </style>
      <h1>TEST - If you see this, rendering works!</h1>
    `;
  }
}

customElements.define('test-app', TestApp);