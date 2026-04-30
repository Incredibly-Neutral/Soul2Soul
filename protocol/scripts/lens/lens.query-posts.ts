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



const storageClient = StorageClient.create();

const APP_ADDRESS = "0x984eB47F0A6E66bb81aC31c34157d1BAa4B10ae5";

// Types for the GraphQL response
interface PostAuthor {
  address: string;
}


interface MetadataAttribute {
  key: string;
  value: string;
  type: string;
}

interface TextOnlyMetadata {
  content: string;
  locale: string;
  attributes: MetadataAttribute[];
  tags: string[];
}

interface Post {
  id: string;
  author: PostAuthor;
  metadata: TextOnlyMetadata;
}

interface PageInfo {
  prev: string | null;
  next: string | null;
}

interface PostsResponse {
  items: Post[];
  pageInfo: PageInfo;
}

interface GraphQLResponse {
  data?: {
    posts: PostsResponse;
  };
  errors?: Array<{
    message: string;
    locations: any[];
  }>;
}

// Types for your S2S structure
interface S2SAttributes {
  controller: string | null;
  streamId: string | null;
  parent: string | null;
  position: string | null;
  postType: string | null;
  creationDate: string | null;
  modifiedDate: string | null;
}

interface S2SContent {
  // Lens data
  id: string;
  author: string;
  
  // Your S2S structure
  content: string;
  locale: string;
  attributes: S2SAttributes;
  tags: string[];
}


const query = `
  query GetS2SPosts($feedAddress: EvmAddress!) {
    posts(request: {
      filter: {
        feeds: [
          {
            feed: $feedAddress
          }
        ]
      }
    }) {
      items {
        ... on Post {
          id
          author {
            address
          }
          metadata {
            ... on TextOnlyMetadata {
              content
              locale
              attributes {
                key
                value
                type
              }
              tags
            }
          }
        }
      }
      pageInfo {
        prev
        next
      }
    }
  }
`;

// Updated function with correct field names
const queryS2SContent = async (feedAddress: string, postType: string) => {
  
    const response = await fetch('https://api.testnet.lens.xyz/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          feedAddress: feedAddress
        }
      })
    });

  const result = await response.json();
  
  if (result.errors) {
    console.error('GraphQL errors:', result.errors);
    return [];
  }

  const posts = result.data.posts.items;
  
  // Transform and filter posts to match your S2S structure
  const s2sData = posts.map((post: { metadata: { attributes: never[]; content: any; locale: any; tags: any; }; id: any; author: { address: any; }; }) => {
    const attributes = post.metadata.attributes || [];
    
    // Helper to get attribute value by key
    const getAttr = (key: string) => {
      const attr : any = attributes.find((a: { key: any; }) => a.key === key);
      return attr ? attr.value : null;
    };

    // Extract your stored data structure
    const s2sContent = {
      // Lens data
      id: post.id,
      author: post.author.address,
      
      // Your S2S structure
      content: post.metadata.content, // This is your encrypted content
      locale: post.metadata.locale,
      attributes: {
        controller: getAttr('controller'),
        streamId: getAttr('streamId'),
        parent: getAttr('parent'),
        position: getAttr('position'),
        postType: getAttr('postType'),
        creationDate: getAttr('creationDate'),
        modifiedDate: getAttr('modifiedDate')
      },
      tags: post.metadata.tags
    };

    return s2sContent;
  });

  return s2sData;
}


const main = async () => {

    const allS2SPosts: S2SContent[] = await queryS2SContent("0x3D8db01C34f6CA96BE88f4c8A59623665E5569F0","post");

    console.log(allS2SPosts)
 
}






main()