import { LocalConfigBuilder } from "./local-config-builder";
import { createSessionSignatures, getProtocolInfo, renderwithLitActions, mintCapacityToken, getProviders } from "@s2s/soul2soul-shared"
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LIT_NETWORK, LIT_RPC } from "@lit-protocol/constants";
import { Wallet as Wallet5, providers } from "ethers5";
import * as ethers from 'ethers';

const epk = process.env.PRIVATE_KEY_UNAMORE || process.env.PRIVATE_KEY || "";
const SELECTED_LIT_NETWORK = LIT_NETWORK.Datil;
const alchemy_key = process.env.ALCHEMY_KEY || "";

export class MainController {

    protocolInfo: any;
    builder: any;
    litNodeClient: any; 
    ethersWallet: any;
    sessionSignatures: any;

    constructor() {}

    async init() {

        const { l1Provider, l2Provider } = await getProviders(alchemy_key)

        this.protocolInfo = await getProtocolInfo(false, l1Provider, l2Provider)

        this.builder = new LocalConfigBuilder(
            'REDACTED',
            this.protocolInfo.assets_gateway,
            this.protocolInfo.data_gateway
        );

        this.litNodeClient = new LitNodeClient({
            litNetwork: SELECTED_LIT_NETWORK,
            debug: false,
        });

        await this.litNodeClient.connect();
        const provider5 = new providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE);
        this.ethersWallet = new Wallet5(epk, provider5);

        const capacityTokenId = await mintCapacityToken(this.ethersWallet, SELECTED_LIT_NETWORK)

        this.sessionSignatures = await createSessionSignatures(this.litNodeClient, this.ethersWallet, capacityTokenId)
      
        console.log("ready")
    }

    async runAction(authorSafeAddress: string, publication: string, STREAM_IDS: string[], configCid: string) {

        const update = false;
        const dev = true;
        const notice = false;
        const debug = false;

        return await renderwithLitActions(this.litNodeClient, this.sessionSignatures, this.protocolInfo, notice, authorSafeAddress, publication, STREAM_IDS, update, dev, debug, configCid );

    }

    async renewConfig(publication: string) {

        return await this.builder.buildConfig(publication,"");
    }
}