import { IMainController } from "../main.ctrlr.js";
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
    /** Encrypted blob (base64) for on-disk storage. Only populated during
     * serialization; replaced with plaintext `private_key` after loading. */
    key_blob?: string,
    safe: string | undefined,
    setSafeAddress: (address: string) => void,
}

export class OXOUser implements IOXOUser {
    name: string
    active: boolean
    eoa: string
    private_key: string
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
        this.private_key = private_key || "";
        this.safe = safe != undefined ? ethers.getAddress(safe) : undefined;   
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
}