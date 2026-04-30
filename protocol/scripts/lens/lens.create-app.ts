import { AppMetadataLensPlatformsItem, PublicClient, mainnet, testnet } from "@lens-protocol/client";
import { chains } from '@lens-chain/sdk/viem';
import { privateKeyToAccount } from "viem/accounts"
import { signMessageWith } from "@lens-protocol/client/viem";
import { MetadataAttributeType, app, Platform } from "@lens-protocol/metadata";
import  { walletOnly, StorageClient } from "@lens-chain/storage-client";
import { evmAddress, uri } from "@lens-protocol/client";
import { createApp } from "@lens-protocol/client/actions";
import { handleOperationWith } from "@lens-protocol/client/viem";
import { fetchApp } from "@lens-protocol/client/actions";
import { createWalletClient, http } from 'viem';

import dotenv from "dotenv";

dotenv.config();

const metadata = app({
  name: "Soul2Soul",
  tagline: "publishing without platforms",
  description: "think decentralized WordPress where every article proves who wrote it. Also: there is no frontend!",
  logo: "https://raw.githubusercontent.com/lens-protocol/brand-kit/main/logos/lens-logo-icon.svg",
  developer: "Joera <joera@joeramulders.com>",
  url: "https://soul2soul.io",
  termsOfService: "https://soul2soul.io/terms",
  privacyPolicy: "https://soul2soul.io/privacy",
  platforms: [Platform.WEB] as any
});

const storageClient = StorageClient.create();
 

const main = async () => {

    const privateKey = process.env.PRIVATE_KEY2;
    if (!privateKey) {
        throw new Error("PRIVATE_KEY2 environment variable is required");
    }
    const signer = privateKeyToAccount(`0x${privateKey}`);

    const client = PublicClient.create(
        {
            environment: testnet,
            fragments: [],
            origin: "https://soul2soul.io"
        }
    )

    const walletClient = createWalletClient({
        account: signer,
        chain: chains.testnet,
        transport: http('https://rpc.testnet.lens.dev')
    });

    const authenticated = await client.login({
        builder: {
            address: signer.address,
        },
        signMessage: signMessageWith(signer),
    });

    if (authenticated.isErr()) {
        return console.error(authenticated.error);
    }

    const sessionClient = authenticated.value;
    const { uri: metadataUri } = await storageClient.uploadAsJson(metadata);
    const result = await createApp(sessionClient, {
        admins: [evmAddress("0x2546905e21E9108BD8442eE631e1065C7e55d239"), evmAddress("0x4729d7061db66Bc8EDe9d7eB5c71c5fd0a47749c")],
        metadataUri: uri(metadataUri), 
        // feeds: [
            
        // ],
        defaultFeed: {
             globalFeed: true,
        },
         graph: {
            none: true,
        },
        namespace: {
            none: true,
        },
    })
    .andThen(handleOperationWith(walletClient))
    .andThen(sessionClient.waitForTransaction)
    .andThen((txHash) => fetchApp(sessionClient, { txHash }));

    if (result.isErr()) {
    return console.error(result.error);
    }

    const app = result.value;

    console.log(app);


}





main()