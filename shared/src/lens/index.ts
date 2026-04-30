import { MetadataAttributeType } from "@lens-protocol/metadata";
import  { StorageClient } from "@lens-chain/storage-client";
import type { FragmentOf } from "@lens-protocol/client";
import { graphql } from "@lens-protocol/client";
import { textOnly } from "@lens-protocol/metadata";

const APP_ADDRESS = "0x984eB47F0A6E66bb81aC31c34157d1BAa4B10ae5";

const storageClient = StorageClient.create();

const S2SContentFragment: any = graphql(
  `
    fragment S2SContent on S2SContent {
        content,
        locale,
        attributes {
            tags,
            parent,
            language,
            position,
            postType,
            creationDate,
            modifiedDate
        }
    }
  `,
  []
);

declare module "@lens-protocol/client" { 
    export type S2SContent = FragmentOf<typeof S2SContentFragment>;
}


const createPostMetadata = (user: any, item: any) => {

  return textOnly({
    content: item.encrypted, // Required readable content
    locale: item.language || "en",
    attributes: [
      { 
        type: MetadataAttributeType.STRING,
        key: "parent", 
        value: item.parent?.toString() || "0" 
      },
      { 
        type: MetadataAttributeType.STRING,
        key: "position", 
        value: item.position || "0"
      },
      { 
        type: MetadataAttributeType.STRING,
        key: "postType", 
        value: item.postType || "post" 
      },
      { 
        type: MetadataAttributeType.NUMBER,
        key: "creationDate", 
        value: item.creationDate?.toString() 
      },
      { 
        type: MetadataAttributeType.NUMBER,
        key: "modifiedDate", 
        value: item.modifiedDate?.toString() 
      },
      { 
        type: MetadataAttributeType.STRING,
        key: "plainTextHash", 
        value: item.plainTextHash || "" 
      },
    ],
    tags: item.tags || ["unamore--web"]
  });
};

// USES oxo.lens
export const postToLens = async (user: any, lens: any, item: any, publicationFeed: string) => {

    const metadata = createPostMetadata(
        user,
        item
    );

    console.log(metadata)

    const { uri : metadataUri } = await storageClient.uploadAsJson(metadata)

    return await lens.post(metadataUri, publicationFeed);
    
}


// USES oxo.lens
export const updateToLens = async (user: any, lens: any, item: any, streamId: string) => {

    const metadata = createPostMetadata(
        user,
        item
    );

    const { uri : metadataUri } = await storageClient.uploadAsJson(metadata)

    return await lens.update(metadataUri, streamId);
    
}

const LENS_API = 'https://api-v2.lens.dev';

const GET_PUBLICATION_AUTHOR = `
  query GetPublicationAuthor($publicationId: PublicationId!) {
    publication(request: { forId: $publicationId }) {
      ... on Post {
        by {
          id
          handle {
            fullHandle
            localName
          }
          ownedBy {
            address
          }
          createdAt
        }
      }
      ... on Comment {
        by {
          id
          handle {
            fullHandle
            localName
          }
          ownedBy {
            address
          }
          createdAt
        }
      }
      ... on Quote {
        by {
          id
          handle {
            fullHandle
            localName
          }
          ownedBy {
            address
          }
          createdAt
        }
      }
    }
  }
`;

export const fetchAuthorInfo = async (lensId: string) => {
  
  const authorResponse = await fetch(LENS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: GET_PUBLICATION_AUTHOR,
      variables: { publicationId: lensId }
    })
  });

  const { data } = await authorResponse.json();

  return {
    lens: data.publication.by.handle.fullHandle,
    address: data.publication.by.ownedBy.address,
    createdAt: data.publication.by.createdAt
  };

}

