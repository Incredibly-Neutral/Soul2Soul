import { PublicClient, mainnet, testnet,  evmAddress, uri} from "@lens-protocol/client";
import { privateKeyToAccount } from "viem/accounts"
import { signMessageWith, handleOperationWith } from "@lens-protocol/client/viem";
import  { walletOnly, StorageClient } from "@lens-chain/storage-client";
import { createWalletClient, http } from 'viem';
import { chains } from '@lens-chain/sdk/viem';
import { createFeed, fetchFeed } from "@lens-protocol/client/actions";
import { feed } from "@lens-protocol/metadata";

import dotenv from "dotenv";

dotenv.config();

const metadata = feed({
  name: "Unamore",
  description: "Feed with content for Soul2Soul decentralized html generator",
});

const storageClient = StorageClient.create();


export const main = async () => {

    const { uri : metadataUri } = await storageClient.uploadAsJson(metadata);

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("PRIVATE_KEY2 environment variable is required");
    }
    const signer = privateKeyToAccount(`0x${privateKey}`);

     const publicClient = PublicClient.create(
        {
            environment: testnet,
            fragments: [],
            origin: "https://soul2soul.io"
        }
    )

    const authenticated = await publicClient.login({
        builder: {
            address: signer.address,
        },
        signMessage: signMessageWith(signer),
    });

    if (authenticated.isErr()) {
        return console.error(authenticated.error);
    }

    // SessionClient: { ... }
    const sessionClient = authenticated.value;

    const result = await fetchFeed(sessionClient, { feed: evmAddress("0x5a5Cc3f032A5c4dE76aE07b8ED188376f109f638")});

    if (result.isErr()) {
    return console.error(result.error);
    }

    // feed: Feed | null
    const feed = result.value;

    console.log(feed);
}

main();