export const buttonStylesString = `
        .button-group {
          display: flex;
          gap: 1rem;
          margin-top: 2rem;
        }

        button {
          
          background: var(--gray-500);
          color: white;
          padding: 0.5rem 1rem;
          border-radius: 0.5rem;
          cursor: pointer;
          font-size: 1rem;
          font-weight: 500;
          transition: background-color 0.2s, transform 0.1s;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          text-transform: uppercase;

        }

        .button:hover:not(:disabled) {
          background: var(--color-yellow);
          transform: translateY(-1px);
        }

        .button:disabled {
          background var();
          cursor: not-allowed;
          transform: none;
        }

        .button.thin {
          padding: 0.25rem .5rem;
        }

        .btn-primary {
          background: var(--color-yellow);
          color: black;
        }

        .btn-secondary {
          background: var(--color-green);
        }

        .btn-danger {
          background: var(--color-red);
        }

        .btn-danger:hover {
          background: var(--color-red);
        }

        .button.has-icon {
          background: transparent;
          border: none;
          padding: 0.25rem 0.5rem;
        }
      
`

export const buttonStyles = new CSSStyleSheet();
buttonStyles.replaceSync(buttonStylesString)