import { JsonRpcProvider } from "ethers";
import { IMainController } from "src/main.ctrlr.js";
import { getRPCUrl, getNetwork, getChainId } from "./chains.factory.js";

export interface IBaseAccountService {
    main: IMainController;
    chainId: number;
    signer: any;
    provider: any;
    address: string;
}

export class BaseAccountService implements IBaseAccountService {

    main: IMainController;
    chainId: number;
    signer: any;
    provider: any;
    address!: string;


    constructor(main: IMainController, chain: string) {

        this.main = main;
        this.chainId = getChainId(chain);
        const rpc = getRPCUrl(this.chainId, main.plugin.settings.alchemy_key);
        const network = getNetwork(this.chainId);
        this.provider = new JsonRpcProvider(rpc, network)
            
    }
}