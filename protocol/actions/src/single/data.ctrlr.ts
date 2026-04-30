import { StringifyOptions } from "node:querystring";
import { decrypt } from "../libs/decrypt";
import { fetchByQuery } from "../libs/lens.factory";
import { S2SBody, S2STemplateConfig } from '@s2s/soul2soul-shared';

const createPath = (body: S2SBody, templateConfig: S2STemplateConfig) : string => {
  
  let path =
    body.locale == "nl" || body.locale == undefined
      ? templateConfig.path
      : `/en${templateConfig.path}`;
    
  if (body.slug && path.includes('{slug}')) {
    path = path.replace("{slug}", body.slug);
  }

  return path;
};

export const mergeDecrypted = (
  body: any,
  decrypted: any,
) => {

  return {
    ...body,
    base: decrypted.base || undefined,
    content: decrypted.content,
    title: decrypted.title,
    slug: decrypted.slug,
    custom: JSON.parse(decrypted.custom || "{}") || {},
  };
};

export const pathsForCollections = (item: any, config: any) => {

    // console.log("item", item);
    // console.log("config", config)

    let _templateConfig: S2STemplateConfig | undefined =
    config.mapping.templateConfig.find(
      (m: any) => m.reference === item.postType
    );
       
    return (_templateConfig != undefined) ? createPath(item, _templateConfig) :  undefined       
}

export const initTemplateData = async (
  protocolInfo: any,
  authorSafeAddress: string,
  templateConfig: S2STemplateConfig,
  body: S2SBody,
  publicationModule: string,
) => {

  let revoked = false;
  let path : string | undefined = undefined;


  let decrypted = await decrypt(body, authorSafeAddress, publicationModule);
  if (!decrypted) {
      revoked = true
  } else {
    body = mergeDecrypted(body, decrypted);
    path = createPath(body, templateConfig);
  }

  return {
    ...body,
    assets_gateway: protocolInfo.assets_gateway,
    path,
    custom: body.custom || {},
    content: (body.content || "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\"),
    revoked
  };

}

export const fetchCollections = async (
  templateConfig: S2STemplateConfig
) => {

    const collections: any = {};
    
    for (const collection of templateConfig.collections || []) {

      if (collection.source == 'lens') {

        let results = await fetchByQuery(collection.query.method,collection.query.args);

        results = results.filter(item => item != null);
        results = results.filter((item: any) => item.tags && item.tags.length > 0);

        if(collection.filters !== undefined) {
          results = results.filter( (item: any) => 
            collection.filters!.every( (filter: any) => 
              Object.entries(filter).every(([key, value]) => item[key] === value)
            )
          );
        }

        collections[collection.slug] = results;
      }
    }

    return collections;
}

// export const decryptCollection = async (collection: any, publicationModule: string, authorSafeAddress: string) => {

//   return await Promise.all(
//     collection.map(async (item: any) => {
//         return await _decryptAndMerge(item, publicationModule, authorSafeAddress);
//     })
//   );
// };

const processBase = () => {

   // Merge collections from body.base with collected arrays
    // if (body.base) {
    //   // First, handle keys that exist in both collections and body.base
    //   for (const key in collections) {
    //     if (body.base[key] && Array.isArray(body.base[key])) {
    //       // Create a map of existing items in collections using a unique identifier
    //       const collectionMap = new Map();
    //       collections[key].forEach((item: any) => {
    //         // Using stream_id as the unique identifier
    //         if (item.stream_id) {
    //           collectionMap.set(item.stream_id, item);
    //         }
    //       });

    //       // Merge items from body.base[key], prioritizing items from collections
    //       for (const item of body.base[key]) {
    //         if (item.stream_id && !collectionMap.has(item.stream_id)) {
    //           let _templateConfig = config.mapping.templateConfig.find(
    //             (m: any) => m.reference === item.post_type
    //           );
    //           if (_templateConfig != undefined) {
    //             item.path = createPath(item, _templateConfig);
    //           }
    //           collections[key].push(item);
    //         }
    //       }
    //     }
    //   }

    //   // Then, add keys that only exist in body.base but not in collections
    //   if (typeof body.base === "object") {
    //     Object.keys(body.base).forEach((key) => {
    //       const baseArray = body.base![key];
    //       if (!collections[key] && Array.isArray(baseArray)) {
    //         collections[key] = [...baseArray];
    //       }
    //     });
    //   }
    // }

    // delete body.base;
}
   
