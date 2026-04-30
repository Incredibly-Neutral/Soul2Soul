import { IMainController } from "src/main.ctrlr.js";
import { ethers} from "ethers";
import { Wallet } from "ethers/wallet";

export interface IPKPInfo {
    name: string;
    tokenId: string;
    publicKey: string;
}

export interface IOXOUser {
    name: string,
    active: boolean,
    eoa: string,
    private_key: string,
    lens: string | undefined,
    safe: string | undefined,
    setSafeAddress: (address: string) => void,
    addLensAccount: (main: IMainController) => Promise<string>
    checkLensProfile: (main: IMainController) => Promise<boolean>
}

export class OXOUser implements IOXOUser {
    name: string
    active: boolean
    eoa: string
    private_key: string
    lens: string |undefined
    safe: string | undefined


    constructor(name: string, active: boolean, private_key: string | undefined, eoa: string | undefined, safe: string | undefined) {

        if(private_key == undefined) {
            private_key = this._generatePK();
        }

        if (eoa == undefined) {
            eoa = this.__address(private_key || '');
        }

        this.name = name;
        this.active = active;
        this.eoa = eoa || "";
        // this.lens = undefined;
        this.private_key = private_key || "";
        this.safe = safe != undefined ? ethers.getAddress(safe) : undefined;   
        this.lens = undefined; 
    }

    _generatePK() {
        const w = ethers.Wallet.createRandom();
        return w.privateKey;
    } 

    __address(privateKey: string) {
        const wallet = new Wallet(privateKey);
        return wallet.address;
    }

    setSafeAddress(safe: string) {
        this.safe = ethers.getAddress(safe);
    }

    async checkLensProfile(main: IMainController) {

        let res = await main.lens.checkProfile(this);

        if(res.isErr() || res.value == null){
            return false;
        } else {
            this.lens = res.value.address;
            console.log(this)
            return true;
        }
    }

    async addLensAccount(main: IMainController) {

        return await main.lens.registerProfile(this);
    }
}