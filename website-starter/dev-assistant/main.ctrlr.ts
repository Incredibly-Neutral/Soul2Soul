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
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI0MzNhYjNkMS02YTZjLTQzMGUtODhkZC03Yzc0Y2MyZmQzMDkiLCJlbWFpbCI6ImpvZXJhQGpvZXJhbXVsZGVycy5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGluX3BvbGljeSI6eyJyZWdpb25zIjpbeyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJOWUMxIn1dLCJ2ZXJzaW9uIjoxfSwibWZhX2VuYWJsZWQiOmZhbHNlLCJzdGF0dXMiOiJBQ1RJVkUifSwiYXV0aGVudGljYXRpb25UeXBlIjoic2NvcGVkS2V5Iiwic2NvcGVkS2V5S2V5IjoiNDdlMTk2ZDI2ODNjMzNhMWJmNDUiLCJzY29wZWRLZXlTZWNyZXQiOiI4MjE0NDY0YTAyOTlmMmE1OGU4MzcwNWI4NWYxNTNjMTQ1Mzc2YWY3ODc1N2ZjOWI5NTM3YjBjNWFiZGQyNWY0IiwiZXhwIjoxNzc1MDU1NTAyfQ.PnFMDGxYGbzfqFjcENNgSEi393Pi5qE0ebZPOBEJUVk',
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