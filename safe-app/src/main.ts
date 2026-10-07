// main.ts
import { ethers } from 'ethers'

window.ethers = ethers;

import { initFontToggles } from './styles/font-toggles.js';
initFontToggles();

import './components/s2s-app.js';
import './components/s2s-deals-tab.js';
import './components/s2s-whitelist-tab.js';
import './components/s2s-records-tab.js';
