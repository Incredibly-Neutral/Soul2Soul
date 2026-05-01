import { IMainController } from "src/main.ctrlr.js";
import { privateKeyToAccount, type Account } from "viem/accounts";
import { createLitClient, type LitClient } from "@lit-protocol/lit-client";
import { nagaTest } from "@lit-protocol/networks";
import { ViemAccountAuthenticator } from '@lit-protocol/auth';
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import { encryptString } from '@lit-protocol/encryption';

const CHAIN_ID = "CRONICLE_YELLOWSTONE";

//we cannot mint pkp's on other chains than yellowstone. And yellowstone does not have contracts to do account abstraction.
// so we can only mint as a signer. 

export class LitService {

    main: IMainController
    client!: any
    account!: Account
    authManager: any
    authContext: any

    constructor(main: IMainController) {
        this.main = main;

        this.init()
    }


    async init() { 

        this.client = await createLitClient({
            network: nagaTest,
        });

        this.account = privateKeyToAccount(
            this.main.user.private_key as `0x${string}`
        );

        if (this.account == undefined) throw 'lit client not ready';
    
        this.authManager = createAuthManager({
            storage: storagePlugins.localStorage({
                appName: "s2s",
                networkName: "naga-test",
            }),
        });

        await ViemAccountAuthenticator.authenticate(this.account);

        console.log("auth with", this.account.address)

        this.authContext = await this.authManager.createEoaAuthContext({
            config: { account: this.account },
            authConfig: {
                resources: [
                    ["lit-action-execution", "*"]
                ],
                expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
            litClient: this.client,
        })
    }

    async getAuthContext() {

       return this.authContext; 
    }



    async runAction(action_cid: string, params: any) {
   
        // Get session sigs from auth manager
        const sessionSigs = this.getAuthContext();

        const response = await this.client!.executeJs({
            authContext: this.authContext,
            ipfsId: action_cid,
            jsParams: params,
        });

        return response;
    }  

    async encryptWithUcc(content: string, unifiedAccessControlConditions: any[]) {
        if (!this.client) {
            await this.init();
        }

        console.log(unifiedAccessControlConditions)

        const { ciphertext, dataToEncryptHash } = await encryptString(
            {
                unifiedAccessControlConditions,
                dataToEncrypt: content,
            },
            this.client,
        );

        return { ciphertext, dataToEncryptHash };
    }

    async encryptWithAcc(content: string, conditions: any[]) {
        if (!this.client) {
            await this.init();
        }

        const { ciphertext, dataToEncryptHash } = await encryptString(
            {
                accessControlConditions: conditions,
                dataToEncrypt: content,
            },
            this.client,
        );

        return { ciphertext, dataToEncryptHash };
    }
}
