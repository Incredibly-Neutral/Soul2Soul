import { PublicClient, mainnet, testnet, txHash } from "@lens-protocol/client";
import { privateKeyToAccount } from "viem/accounts"
import { signMessageWith } from "@lens-protocol/client/viem";
import { evmAddress, uri, postId } from "@lens-protocol/client";
import { article } from "@lens-protocol/metadata";
import { editPost, post, createAccountWithUsername, canCreateUsername, fetchAccount, fetchPost, addAccountManager, createFeed, fetchFeed } from "@lens-protocol/client/actions";
import  { walletOnly, StorageClient } from "@lens-chain/storage-client";
import { chains } from '@lens-chain/sdk/viem';
import { createWalletClient, http } from 'viem';
import { handleOperationWith } from "@lens-protocol/client/viem";
import { feed } from "@lens-protocol/metadata";


import { IMainController } from "src/main.ctrlr.js";
import { Notice } from "obsidian";

const APP_ADDRESS = "0x984eB47F0A6E66bb81aC31c34157d1BAa4B10ae5";
// const FEED = "0x3D8db01C34f6CA96BE88f4c8A59623665E5569F0"
const storageClient = StorageClient.create();


export class LensService {

    main: IMainController


    constructor (main: IMainController) {
        this.main = main;
    }

    async auth (mode?: string)  {

        const pk: any = this.main.user.private_key;

        const signer = privateKeyToAccount(pk);

        const wallet = createWalletClient({
            account: signer,
            chain: chains.testnet,
            transport: http('https://rpc.testnet.lens.dev')
        });

        const client = PublicClient.create(
            {
                environment: testnet,
                fragments: [],
                origin: "https://soul2soul.io"
            }
        );

        let session;

        switch (mode) {

            case "new":

                // console.log("auth as new")

                session = await client.login({
                    onboardingUser: {
                        app: evmAddress(APP_ADDRESS),
                        wallet: signer.address,
                    },
                    signMessage: signMessageWith(wallet),
                });

                break;

            case "builder":

                console.log("auth as builder")

                session = await client.login({
                    builder: {
                        address: signer.address,
                    },
                    signMessage: signMessageWith(signer),
                });
                break

            case 'owner': 

                console.log("auth as owner")
                
                session = await client.login({
                    accountOwner: {
                        account: this.main.user.lens,
                        app: evmAddress(APP_ADDRESS),
                        owner: signer.address,
                    },
                    signMessage: signMessageWith(signer),
                });

            default: 
            
                console.log("auth as manager")
                
                session = await client.login({
                    accountManager: {
                        account: this.main.user.lens,
                        app: evmAddress(APP_ADDRESS),
                        manager: signer.address,
                    },
                    signMessage: signMessageWith(signer),
                });            
        }

        return { session, client: session.value, wallet}
    }

    lensUsername() {

        return this.main.user.name.split(".")[0] + "_" + this.main.user.safe?.slice(-4).toLowerCase() + "-v1";
    }

     async getAddress () {


        const name = this.lensUsername();
        const { session, client, wallet } = await this.auth("builder");

        if (session.isErr()) {
            return console.error(session.error);
        }

        let profile: any =  await fetchAccount( client, { 
            username: {
                localName: name,
            },
        });

        console.log(profile.value.username)

        return profile.value.address || "";
    }

    async checkProfile() {


        const name = this.lensUsername();
        const { session, client, wallet } = await this.auth("new");

        if (session.isErr()) {
            return console.error(session.error);
        }

        let profile: any =  await fetchAccount( client, { 
            username: {
                localName: name,
            //    namespace: evmAddress("0x1234…"), // the Username namespace address
            },
        });

        if (profile && profile.value) { console.log("LensUser", profile.value.username) }

        return profile;
    }


    async registerProfile(user: any)  {

        new Notice("registering Lens account",2500)

        const name = this.lensUsername();

        let { session, client, wallet } = await this.auth("new");

        if (session.isErr()) {
            return console.error(session.error);
        }

        const { uri: metadataUri } = await storageClient.uploadAsJson({ 
                name: user.name || 'anonymous', 
                picture: "https://via.placeholder.com/200x200", 
                bio: "" 
        });

        const isAvailable = await canCreateUsername(client, {
            localName: name,
        });
        console.log("Username available:", isAvailable);

        const res: any = await createAccountWithUsername(client, {
            username: { localName: name},
            metadataUri: uri(metadataUri),
            owner: evmAddress(this.main.user.safe || "0x"),
            accountManager:[evmAddress(this.main.user.eoa) || "0x"],
            enableSignless: true
        })
        .andThen(handleOperationWith(wallet));

        if (res.value != undefined) {

            console.log("account_created", res.value)

            const _txHash = res.value;
            await client.waitForTransaction(_txHash);
            const account: any = await fetchAccount(client, { txHash: txHash(_txHash)});

            console.log("new account", account.value)

            return account.value.address || undefined;
        }
    }

    // delegateAccountManagerToSigner = async () => {

    //     let { session, client, wallet } = await this.auth();

    //      if (session.isErr()) {
    //         return console.error(session.error);
    //     }

    //     console.log(session)

    //     console.log(this.main.user)


    //     // cant set accountmanager to same address as owner 
    //     // const result = await addAccountManager(client, {
    //     //     address: evmAddress(this.main.user.msca || "0x"),
    //     //     permissions: {
    //     //         canExecuteTransactions: true,
    //     //         canTransferTokens: false,
    //     //         canTransferNative: false,
    //     //         canSetMetadataUri: true,
    //     //     },
    //     // })
    //     // .andThen(handleOperationWith(wallet))
    //     // .andThen(client.waitForTransaction);

    //     // console.log("addAccountManager",result)

    // }

    post = async (metadataUri: string, publicationFeed: string) => {

        console.log("postin")

        const { session, client, wallet } = await this.auth();

        if (session.isErr()) {
            return console.error(session.error);
        }

        const result: any = await post(
            client, 
            { 
                contentUri: uri(metadataUri),
                feed: evmAddress(publicationFeed)
            }
        )
        .andThen(handleOperationWith(wallet))
        .andThen(client.waitForTransaction)
        .andThen((txHash) => fetchPost(client,{txHash}));

        return !result.isErr() ? result.value.id : false; 

    }


    update = async (metadataUri: string, streamId: string) => {

        console.log("updating")

        const { session, client, wallet } = await this.auth();

        if (session.isErr()) {
            return console.error(session.error);
        }

        await editPost(
            session.value, 
            { 
                contentUri: uri(metadataUri),
                post: postId(streamId)
            }
        )
        .andThen(handleOperationWith(wallet))
        .andThen(client.waitForTransaction);


        const result: any = await fetchPost(client,{ post: streamId});

        console.log("after update", streamId, result)

        return result.value;
        
    }

    createFeed = async (name: string, description: string, safeAddress: string) => {

        const metadata = feed({
            name,
            description
        });
        
        const { uri : metadataUri } = await storageClient.uploadAsJson(metadata);

        let { session, client, wallet } = await this.auth("builder");

         const result = await createFeed(client, {
            admins: [evmAddress(safeAddress)],
            metadataUri: uri(metadataUri),
        })
        .andThen(handleOperationWith(wallet))
        .andThen(client.waitForTransaction)
        .andThen((txHash) => fetchFeed(client, { txHash }));

        if (result.isErr()) {
            return console.error(result.error);
        }

        const f = result.value;

        if (f != null) {
            return f.address;
        }
    }
}

