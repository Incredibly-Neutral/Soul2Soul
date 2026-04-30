
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

// declare module "@lens-protocol/client" { 
//     export type S2SContent = FragmentOf<typeof S2SContentFragment>;
// }


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
        value: item.post_type || "post" 
      },
      { 
        type: MetadataAttributeType.NUMBER,
        key: "creationDate", 
        value: item.creation_date?.toString() 
      },
      { 
        type: MetadataAttributeType.NUMBER,
        key: "modifiedDate", 
        value: item.modified_date?.toString() 
      }
    ],
    tags: item.tags || ["unamore--web"]
  });
};


export const postToLens = async (user: any, lens: any, item: any, publicationFeed: string) => {

    const metadata = createPostMetadata(
        user,
        item
    );

    console.log(metadata)

    const { uri : metadataUri } = await storageClient.uploadAsJson(metadata)

    return await lens.post(metadataUri, publicationFeed);
    
}


export const updateToLens = async (user: any, lens: any, item: any, streamId: string) => {

    const metadata = createPostMetadata(
        user,
        item
    );

    const { uri : metadataUri } = await storageClient.uploadAsJson(metadata)

    return await lens.update(metadataUri, streamId);
    
}



