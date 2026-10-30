import { css } from 'lit';

// Shared chip filter styles for the <s2s-table> chips mode (multi-select pill
// chips with counts). Moved verbatim from s2s-cid-view-section.ts — class
// names preserved (`.chips-top .chips-row .chips-group .chip .chip.active
// .chip-value`). The CID view keeps its own copy of these rules until a later
// wave migrates it onto <s2s-table>.
//
// <s2s-table> renders into LIGHT DOM (createRenderRoot() => this), so it has
// no shadow root to carry component styles. Like the existing tableStyles /
// filterStyles, these rules are meant to be adopted by the host's shadow
// tree; <s2s-table> also injects this block into its own light DOM so the
// chips render styled inside whatever host uses it (the rules land in the
// host's shadow tree, so they stay scoped to that host).

export const chipStyles = css`
  .chips-top {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .chips-row {
    display: flex;
    align-items: flex-start;
    gap: 1.5rem;
    margin-bottom: 1rem;
  }
  .chips-group {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .chips-group + .chips-group {
    border-left: 1px solid var(--gray-700, #374151);
    padding-left: 1.5rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.65rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--gray-700, #374151);
    color: var(--gray-200, #e5e7eb);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  button.chip {
    font: inherit;
    cursor: pointer;
    transition: border-color 120ms, background 120ms;
    font-size: 0.75rem;
    text-transform: none;
  }
  button.chip:hover:not(.active) {
    border-color: var(--gray-500, #6b7280);
  }
  .chip.active {
    border-color: rgba(59, 130, 246, 0.65);
    background: rgba(59, 130, 246, 0.12);
    color: var(--blue-300, #93c5fd);
  }
  .chip .chip-value {
    font-weight: 700;
    color: var(--gray-50, #f9fafb);
  }
  .chip.active .chip-value {
    color: #bfdbfe;
  }
`;
