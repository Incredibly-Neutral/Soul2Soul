

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

const QUERIES = {

  queryByFeed : `
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
  `,
  queryById : `
  query GetPostById($postId: PostId!) {
    post(request: { post: $postId }) {
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
  }
`
};


export const fetchById = async (
  streamId: string
) => {
  try {

    const query = QUERIES["queryById" as keyof typeof QUERIES];

    const response = await fetch('https://api.testnet.lens.xyz/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          postId: streamId,      
        }
      })
    });

    const result = await response.json();
  
    if (result.errors) {
        console.error('GraphQL errors:', result.errors);
        return undefined;
    }
   
    return formatSingle(result.data.post);

  } catch (error) {
    throw "Error in runQuery";
  }
};



export const fetchByQuery = async (
  method: string,
  args: any
) => {
  try {

    const query = QUERIES[method as keyof typeof QUERIES];

    const response = await fetch('https://api.testnet.lens.xyz/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query,
        variables: args
      })
    });

    // console.log("RRR", response)

    const result = await response.json();

  
    if (result.errors) {
        console.error('GraphQL errors:', result.errors);
        return [];
    }

    if (result.data.post != undefined) {
        return [formatSingle(result.data.post)];
    } else if (result.data.posts != undefined ) {
        return format(result.data.posts.items)
    } else {
      return []; 
    }
   
    

  } catch (error) {
    console.error("Error in runQuery:", error);
    throw error;
  }
};

const formatSingle = (post: any) => {
  if (!post) return null;
  
  const attributes = post.metadata.attributes || [];
  
  const getAttr = (key: string) => {
    const attr: any = attributes.find((a: { key: any; }) => a.key === key);
    return attr ? attr.value : null;
  };

  return {

    id: post.id,
    author: post.author.address,
  
    content: post.metadata.content,
    locale: post.metadata.locale,
    parent: getAttr('parent'),
    position: getAttr('position'),
    postType: getAttr('postType'),
    creationDate: getAttr('creationDate'),
    modifiedDate: getAttr('modifiedDate'),
    tags: post.metadata.tags
  };

};

// Also fix your format function to return the result
const format = (posts: any[]) => {
  return posts.map((post) => formatSingle(post));
};