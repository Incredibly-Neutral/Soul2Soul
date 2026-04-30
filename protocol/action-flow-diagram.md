# NeutralPress Protocol Action Flow

This diagram illustrates the sequence of calls in the NeutralPress protocol starting from `main.ts`.

```mermaid
sequenceDiagram
    participant Client
    participant LA as Lit Action
    participant ENS
    participant Lit
    participant IPFS
    participant DB as OrbisDB
    participant Render
    
    Client->>LA: Execute action
    LA->>ENS: getContractAddress
    ENS-->>LA: publicationAddress
    
    alt publish is true
        LA->>Lit: checkConditions
        Lit-->>LA: authResult
        alt authResult is false
            LA-->>Client: Auth error
        end
    end
    
    LA->>IPFS: getProtocolInfoOnce
    IPFS-->>LA: protocolInfo
    LA->>IPFS: getConfigOnce
    IPFS-->>LA: config
    
    loop Each stream
        LA->>DB: getBodyOnce
        DB-->>LA: body
        
        alt body is undefined
            LA->>LA: Continue
        else body exists
            LA->>LA: getTaskConfig
            LA-->>LA: templateConfig & rippleConfigs
            
            LA->>LA: prepareTemplateData
            Note over LA: Decrypt & process collections
            LA-->>LA: templateData
            
            LA->>LA: Add to jobs array
            
            alt single stream mode
                loop Each rippleConfig
                    LA->>DB: getRipplesOnce
                    DB-->>LA: ripples
                     
                    loop Each ripple
                        LA->>LA: prepareTemplateData
                        LA-->>LA: rippleTemplateData
                        LA->>LA: Add to jobs
                    end
                end
            end
        end
    end
    
    LA->>LA: Filter unique jobs by stream_id
    
    loop Each uniqueJob
        LA->>Render: LitActions.call
        Render-->>LA: rendered HTML
        LA->>LA: addMetadata
        LA-->>LA: enhanced HTML
    end
    
    LA->>IPFS: updateRoot
    IPFS-->>LA: newRootCid
    
    LA-->>Client: Success with rootCid & paths
```

## Flow Summary

1. **Setup Phase**:
   - Resolve publication ENS name to contract address
   - Verify publishing permissions (when publish=true)
   - Fetch protocol info and publication config

2. **Content Processing Phase**:
   - Process each stream: fetch body → determine template → prepare data → add to jobs
   - For single streams: process related "ripples" content for comprehensive updates
   - Includes collection processing from OrbisDB and merging from body.base

3. **Rendering & Publishing Phase**:
   - Deduplicate jobs by stream_id
   - Render HTML via secondary Lit Action
   - Add metadata to enhance SEO and presentation
   - Calculate new IPFS root CID
   - Publish changes (when publish=true)

## Data Flow Details

In `prepareTemplateData`:
1. Decrypt content with appropriate keys
2. Process collections from OrbisDB queries
3. Merge collections from body.base
4. Create paths and format template data

The rendering process supports multiple templates and content types, enabling structured websites with interconnected content.