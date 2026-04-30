interface NPCollection {
    source: string
    key: string
    value: string
    query: string
    slug: string
}

interface NPRipple {
    query: string
    value: string
    post_type: string
}

interface NPTemplate {
    reference: string
    file: string
    path: string
    collections: NPCollection[]
    ripples: NPRipple[]
}

// Define interfaces for the state machine context
export interface ConfigData {
  body: {
    language: string;
    post_type: string;
    [key: string]: any;
  };
  config: any;
  mapping: NPTemplate;
  contract?: string;
  stream_id: string;
}

