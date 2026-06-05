/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

declare global {
  interface Window {
    ethers: any;
    ethereum: any;
  }
}

export {};