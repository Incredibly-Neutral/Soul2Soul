/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

interface ImportMetaEnv {
  readonly VITE_DRPC_API_KEY: string;
  readonly VITE_LIT_USAGE_KEY: string;
  readonly VITE_GITHUB_TOKEN: string;
  readonly VITE_PINATA_JWT: string;
  readonly VITE_FILEBASE_TOKEN: string;
  readonly VITE_FILEBASE_BUCKET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    ethers: any;
    ethereum: any;
  }
}

export {};
