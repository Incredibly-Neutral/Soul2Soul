import { breakpoints } from '@/styles/breakpoints.js';

class CopyContentId extends HTMLElement {
  private value: string = ''
  private display: string = ''
  private copied: boolean = false
  private timeout: number | null = null

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot!.adoptedStyleSheets = []
  }

  static get observedAttributes() {
    return ['value', 'display']
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (oldValue === newValue) return
    if (name === 'value') this.value = newValue
    if (name === 'display') this.display = newValue
    if (this.shadowRoot) this.render()
  }

  connectedCallback() {
    if (!this.value) this.value = this.textContent?.trim() || ''
    if (!this.display) this.display = this.getAttribute('display') || this.value
    this.render()
  }

  disconnectedCallback() {
    if (this.timeout) clearTimeout(this.timeout)
  }

  private async copy() {
    try {
      // execCommand('copy') directly — in the Safe iframe the async
      // Clipboard API is blocked by permissions policy, so skip it.
      const textarea = document.createElement('textarea')
      textarea.value = this.value
      textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      if (!document.execCommand('copy')) throw new Error('execCommand copy failed')
      document.body.removeChild(textarea)

      this.copied = true
      this.render()
      if (this.timeout) clearTimeout(this.timeout)
      this.timeout = window.setTimeout(() => {
        this.copied = false
        this.render()
      }, 1500)
    } catch (e) {
      console.error('Copy failed', e)
    }
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

        .text {
          margin: 0;
          user-select: all;
          font-family: ${this.display.length < 20 ? 'inherit' : 'monospace'};
        }

        button {
          all: unset;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.15rem;
          border-radius: 3px;
          color: #666;
          transition: color 0.2s ease;
        }

        button:hover {
          color: #fff;
        }

        button.copied {
          color: #2e7d32;
        }

        svg {
          width: 16px;
          height: 16px;
          stroke: var(--color-too-dark);
        }
      </style>

      <span class="text" title="${this.value}">${this.display}</span>
      <button class="${this.copied ? 'copied' : ''}" aria-label="Copy content ID to clipboard">
        ${this.copied
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>`
        }
      </button>
    `

    this.shadowRoot.querySelector('button')?.addEventListener('click', (e: Event) => {
      e.stopPropagation()
      this.copy()
    })
  }
}

customElements.define('copy-content-id', CopyContentId)

export { CopyContentId }