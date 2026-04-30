import { AppMetadataLensPlatformsItem, PublicClient, mainnet, testnet } from "@lens-protocol/client";
import { chains } from '@lens-chain/sdk/viem';
import { privateKeyToAccount } from "viem/accounts"
import { signMessageWith } from "@lens-protocol/client/viem";
import { MetadataAttributeType, app, Platform } from "@lens-protocol/metadata";
import  { walletOnly, StorageClient } from "@lens-chain/storage-client";
import { evmAddress, uri } from "@lens-protocol/client";
import { createApp, fetchAppFeeds, fetchFeed } from "@lens-protocol/client/actions";
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

const APP_ADDRESS = "0x984eB47F0A6E66bb81aC31c34157d1BAa4B10ae5";
 

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
    const result = await fetchApp(sessionClient, { app : evmAddress(APP_ADDRESS)});

    if (result.isErr()) {
    return console.error(result.error);
    }

    const app = result.value;

    console.log(app);


    const feeds = await fetchAppFeeds(sessionClient, {
        app: evmAddress(APP_ADDRESS)
    });

    if (feeds.isErr()) {
    return console.error(feeds.error);
    }

    // items: Array<Feed>: [{feed: evmAddress, timestamp: DateTime}, …]
    const { items, pageInfo } = feeds.value;

    for (let item of items) {

        const result = await fetchFeed(sessionClient, { feed: evmAddress(item.feed)});
        
        if (result.isErr()) {
        return console.error(result.error);
        }
    
        const feed = result.value;
    
        console.log(feed);
    }
}





main()