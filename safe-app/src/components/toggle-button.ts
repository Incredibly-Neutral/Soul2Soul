class ToggleButton extends HTMLElement {

  private bool: boolean = false
  private label: string = ''

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
  }

  static get observedAttributes() {
    return ['bool', 'label']
  }

  set checked(val: boolean) {
    this.bool = val
    if (this.shadowRoot) this.render()
  }

  get checked(): boolean {
    return this.bool
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue === newValue) return
    if (name === 'bool') this.bool = newValue === 'true'
    if (name === 'label') this.label = newValue ?? ''
    if (this.shadowRoot) this.render()
  }

  connectedCallback() {
    this.bool = this.getAttribute('bool') === 'true'
    this.label = this.getAttribute('label') ?? ''
    this.render()
  }

  private render() {
    if (!this.shadowRoot) return

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
        }

        .toggle-wrap {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .toggle-lid {
          --lid-bg: var(--gray-600, #4b5563);
          --track-bg: var(--gray-700, #374151);
          --accent: var(--color-yellow, #facc15);

          display: flex;
          width: 3.4rem;
          height: 1.7rem;
          padding: 0.35rem;
          background: var(--track-bg);
          border-radius: 2.4rem;
          cursor: pointer;
          transition: all 0.3s ease-in-out;
        }

        .toggle-knob {
          --icon-color: var(--gray-400, #9ca3af);
          display: flex;
          justify-content: center;
          align-items: center;
          width: 1.7rem;
          height: 1.7rem;
          position: relative;
          background: var(--lid-bg);
          border-radius: 50%;
          transition: all 0.3s ease-in-out;
          box-shadow: 0 0 8px rgba(0, 0, 0, 0.3);
        }

        .toggle-knob::before,
        .toggle-knob::after {
          content: "";
          position: absolute;
          width: 0.25rem;
          height: 1.1rem;
          background: var(--icon-color);
          transition: all 0.3s ease-in-out;
        }

        .toggle-knob::before {
          transform: rotate(45deg);
        }

        .toggle-knob::after {
          transform: rotate(-45deg);
        }

        .toggle-lid.active {
          background: var(--accent);
        }

        .toggle-lid.active .toggle-knob {
          --icon-color: var(--accent);
          margin-left: 50%;
          background: var(--color-yellow-light, #fef3c7);
        }

        .toggle-lid.active .toggle-knob::before {
          transform: rotate(45deg) translate(0.125rem, -0.125rem);
        }

        .toggle-lid.active .toggle-knob::after {
          height: 0.85rem;
          transform: rotate(-45deg) translate(-0.25rem, -0.125rem);
        }

        .toggle-label {
          text-transform:uppercase;
          color: var(--gray-300);
        }
      </style>

      <span class="toggle-wrap">
        <label class="toggle-lid${this.bool ? ' active' : ''}">
          <span class="toggle-knob"></span>
        </label>
        <span class="toggle-label">${this.label}</span>
      </span>
    `

    const lid = this.shadowRoot.querySelector('.toggle-lid') as HTMLElement
    lid?.addEventListener('click', () => {
      this.bool = !this.bool
      lid.classList.toggle('active', this.bool)
      this.dispatchEvent(new CustomEvent('toggle', {
        detail: { checked: this.bool },
        bubbles: true,
        composed: true
      }))
    })
  }
}

customElements.define('toggle-button', ToggleButton)

export { ToggleButton }
