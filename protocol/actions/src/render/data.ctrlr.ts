import { decrypt } from '../libs/decrypt';
import { fetchByPublication } from '../libs/module.factory';
import { S2SBody, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';
import { transformContent } from './content-transforms';

const createPath = (body: S2SBody, templateConfig: S2STemplateConfig): string => {
  if (templateConfig.path == null) return '/';
  let path =
    body.locale == 'nl' || body.locale == undefined
      ? templateConfig.path
      : `/en${templateConfig.path}`;

  if (!body.encryption && body.slug && path.includes('{slug}')) {
    path = path.replace('{slug}', body.slug);
  }

  return path;
};

export const mergeDecrypted = (body: S2SBodyEncrypted, decrypted: any): S2SBodyPlain => {
  return {
    id: body.id,
    author: body.author,
    locale: body.locale,
    parent: body.parent,
    position: body.position,
    postType: body.postType,
    creationDate: body.creationDate,
    modifiedDate: body.modifiedDate,
    tags: body.tags,
    attributes: body.attributes,
    publication: body.publication,
    base: decrypted.base || undefined,
    encryption: false as const,
    content: decrypted.content,
    title: decrypted.title,
    slug: decrypted.slug,
    custom:
      typeof decrypted.custom === 'string'
        ? JSON.parse(decrypted.custom || '{}')
        : decrypted.custom || {},
  };
};

export const pathsForCollections = (item: any, config: any) => {
  // console.log("item", item);
  // console.log("config", config)

  let _templateConfig: S2STemplateConfig | undefined = config.mapping.templateConfig.find(
    (m: any) => m.reference === item.postType,
  );

  return _templateConfig != undefined ? createPath(item, _templateConfig) : undefined;
};

export const initTemplateData = async (
  protocolInfo: any,
  authorSafeAddress: string,
  signerAddress: string,
  templateConfig: S2STemplateConfig,
  body: S2SBody,
  publicationModule: string,
  rpcs?: string[],
) => {
  if (body.encryption) {
    const decrypted = await decrypt(
      protocolInfo.pkp,
      body,
      authorSafeAddress,
      publicationModule,
      signerAddress,
      rpcs,
    );
    if (!decrypted)
      return {
        ...body,
        path: createPath(body, templateConfig),
        custom: {},
        content: '',
        revoked: true,
      };
    body = mergeDecrypted(body, decrypted);
  }

  const path = createPath(body, templateConfig);

  return {
    ...body,
    gateway: protocolInfo.gateway,
    path,
    custom: body.custom || {},
    content: transformContent(
      (body.content || '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
    ),
    revoked: false,
  };
};

export const fetchCollections = async (
  templateConfig: S2STemplateConfig,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
) => {
  const collections: any = {};

  // Fetch all deals once — every collection filters the same set.
  let allDeals: any[] = [];
  if ((templateConfig.collections || []).length > 0) {
    allDeals = await fetchByPublication(publicationModule, rpcs, gateway);
    allDeals = allDeals.filter((item) => item != null);
  }

  for (const collection of templateConfig.collections || []) {
    let results = allDeals;

    if (collection.filters !== undefined) {
      results = results.filter((item: any) =>
        collection.filters!.every((filter: any) =>
          Object.entries(filter).every(([key, value]) => {
            const itemVal = item[key];
            return Array.isArray(itemVal) ? itemVal.includes(value) : itemVal === value;
          }),
        ),
      );
    }

    collections[collection.slug] = results;
  }

  return collections;
};

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
};
