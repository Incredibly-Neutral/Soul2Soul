import { IMainController } from "src/main.ctrlr.js";
import { BaseAccountService, IBaseAccountService } from "./base.account.service.js";

import { AuthenticationMethod, initWaaP } from "@human.tech/waap-sdk";

declare global {
    interface Window {
        waap: {
            login: () => Promise<'waap' | 'injected' | 'walletconnect' | null>;
            request: (any) => Promise<any>;
        };
    }
}

const initConfig = {
  config: {
    allowedSocials: [],
    authenticationMethods: ['email', 'phone'] as AuthenticationMethod[],
    styles: { darkMode: false },
  },
  useStaging: false,
  walletConnectProjectId: "<PROJECT_ID>", // Required if 'wallet' in authenticationMethods
  referralCode: "", // Optional
};


export interface IWaapService extends IBaseAccountService{

//   updateSigner: (pk: string) => Promise<string>;
//   connectToFreshSafe: (salt: string) => Promise<string>
//   connectToExistingSafe: (safe_address: string) => Promise<string>
//   genericRead: (address: string, abi: string, method: string, args: string[]) => Promise<any>;
//   genericTx: (address: string, abi: string, method: string, args: string[], deploy: boolean, wait?: boolean) => Promise<string>;
//   batchGenericTx: (calls: Array<{ address: string; abi: string; method: string; args: any[]; }>) => Promise<string[]>;
//   valueTx: (to: string, amount: string) => Promise<string>;
//   getSafeAddress: (salt: string) => Promise<string>;
//   isDeployed: () => Promise<boolean>;

    login: () => Promise<void>
  
}

export class WaapService extends BaseAccountService implements IWaapService  {

    constructor(main: IMainController, chain: string) {
        super(main, chain); // Call parent constructor
        this.initWaap();
    }

   async initWaap() { 
        await initWaaP(initConfig);
    }

    async login() {

        if (!window.waap) {
            console.error("WaaP not initialized");
            return;
        }

        const loginType = await window.waap.login();

        switch (loginType) {
        case "waap":
            console.log("User chose WaaP");

            const accounts = await window.waap.request({ 
                method: 'eth_requestAccounts' 
            });

            console.log(accounts)
        
            break;
        case "injected":
            console.log("User chose injected wallet (for example, MetaMask)");
            break;
        case "walletconnect":
            console.log("User chose WalletConnect");
            break;
        case null:
            console.log("User cancelled login");
            break;
        }
    }


}