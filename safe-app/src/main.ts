// main.ts
import { ethers } from 'ethers'

window.ethers = ethers;

// Apply the design tokens and the self-hosted font registry once, at the
// document level, so every component (shadow DOM included) inherits the
// CSS custom properties. Both live in src/styles per the repo convention.
import { theme } from '@/styles/theme.js';
import { fonts } from '@/styles/fonts.js';

const globalSheets = [theme.styleSheet, fonts.styleSheet]
  .filter((s): s is CSSStyleSheet => s !== undefined);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, ...globalSheets];

// Register every ph-* Phosphor icon element before any component renders.
import './components/icon.js';

import './components/s2s-app.js';
import './components/s2s-deals-tab.js';
import './components/s2s-whitelist-tab.js';
import './components/s2s-records-tab.js';
