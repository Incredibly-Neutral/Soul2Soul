import { z } from 'zod';
import { S2SAsset, S2SPublicationConfig } from './types';
import { S2STemplateConfig, S2SRipple } from '../rendering';



// ============================================================================
// Body Schema
// ============================================================================
const bodySchema = z.object({
    // Lens fields
    id: z.string(), // Lens post ID (big number as string)
    author: z.string(), // Ethereum address
    content: z.string(), // JSON string containing encrypted data
    locale: z.string(), // language code
    
    // S2S attributes (nested object)
    attributes: z.object({
        parent: z.string(), // stored as string in Lens
        position: z.string(), // stored as string in Lens
        postType: z.string(),
        creationDate: z.string(), // Unix timestamp as string
        modifiedDate: z.string() // Unix timestamp as string
    }),
    
    // Tags
    tags: z.array(z.string())
});

// ============================================================================
// Mapping Schemas
// ============================================================================

const querySchema = z.object({
    method: z.string(),
    args: z.any()
});


const rippleSchema = z.object({
    origins: z.array(z.string()),
    destination: z.string(),
    reference: z.string(),
    query: querySchema,
    filters: z.array(z.any()).optional(),
});


const assetSchema = z.object({
    path: z.string(),
    cid: z.string()
}) satisfies z.ZodType<S2SAsset>;


const collectionSchema = z.object({
    source: z.string(),
    query: querySchema,
    filters: z.array(z.any()),  // ✅ Already optional
    key: z.string(),
    value: z.string(),
    slug: z.string()
});

const templateConfigSchema = z.object({
    reference: z.string(),
    file: z.string(),
    path: z.string(),
    collections: z.array(collectionSchema).optional(),
    filters: z.array(z.any()).optional()  // ✅ ADD THIS - top-level filters
});

const mappingSchema = z.object({
    templateConfig: z.array(templateConfigSchema),  // ✅ This is correct
    ripples: z.array(rippleSchema)
});

const publicationConfigSchema = z.object({
    assets: z.array(assetSchema),
    assetsGateway: z.string(),
    contract: z.string(),
    dataGateway: z.string(),
    mapping: mappingSchema,  // ✅ Single object (not array)
    name: z.string(),
    renderAction: z.string().optional(),
    stylesheets: z.array(assetSchema).optional(),
    templateCid: z.string(),
    // templates: z.array(templateConfigSchema)  // ← WAIT, this is confusing!
    // Do you have BOTH mapping.templateConfig AND templates?
}).passthrough() satisfies z.ZodType<S2SPublicationConfig>;




const jobSchema = z.object({
    templateConfig: templateConfigSchema,
    path: z.string().optional(),
    templateData: z.any(),
    html: z.string()
});

// ============================================================================
// Protocol Schemas
// ============================================================================
// const protocolConfigSchema = z.object({
//     chain_id: z.number(),
//     db_model: z.string(),
//     db_context: z.string(),
//     db_gateway: z.string(),
//     rpc_url: z.string(),
//     data_gateway: z.string(),
//     assets_gateway: z.string()
// });

const pkpSchema = z.object({
    ethAddress: z.string(),
    publicKey: z.string(),
    tokenId: z.string()
});

const protocolSchema = z.object({
    addr: z.string(),
    recordsModule: z.string(),
    dataGateway: z.string(),
    assetsGateway: z.string(),
    lensApp: z.string(),
    ensRecords: z.string(),
    pkp: pkpSchema,
    litActionPrep: z.string(),
    litActionSingle: z.string(),
    litActionCbor: z.string(),
    litActionRootUpdate: z.string()
});

// ============================================================================
// Config Schemas
// ============================================================================



// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates the config object against its schema
 * @throws Error if config is missing or invalid
 */
export const validateConfig = (config: S2SPublicationConfig): void => {
    if (!config) {
        throw new Error('Config is required');
    }
    try {
        publicationConfigSchema.parse(config);
        console.log('Config validation successful');
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            const issues = error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
            console.error('Config validation failed:', issues);
            throw new Error(`Invalid config structure:\n${issues}`);
        }
        throw error;
    }
};

/**
 * Validates the mapping object and checks if it exists in the config
 * @throws Error if mapping is missing or invalid
 */
export const validateMapping = (templateConfig: S2STemplateConfig, rippleConfigs: S2SRipple[]): void => {
    if (!templateConfig) {
        throw new Error('Template config is required');
    }
    try {
        templateConfigSchema.parse(templateConfig);
        z.array(rippleSchema).parse(rippleConfigs);
        // console.log('Template config and ripple configs validation successful');
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            const issues = error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
            console.error('Template config validation failed:', issues);
            throw new Error(`Invalid template config structure:\n${issues}`);
        }
        throw error;
    }
};

/**
 * Validates the protocol object against its schema
 * @throws Error if protocol is invalid
 */
export const validateProtocol = (protocol: any): void => {
    try {
        protocolSchema.parse(protocol);
        // console.log('Protocol validation successful');
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            const issues = error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
            console.error('Protocol validation failed:', issues);
            throw new Error(`Invalid protocol structure:\n${issues}`);
        }
        throw error;
    }
};

/**
 * Validates the body object against its schema
 * @throws Error if body is invalid
 */
export const validateBody = (body: any): void => {
    try {
        bodySchema.parse(body);
        // console.log('Body validation successful');
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            const issues = error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
            console.error('Body validation failed:', issues);
            throw new Error(`Invalid body structure:\n${issues}`);
        }
        throw error;
    }
};