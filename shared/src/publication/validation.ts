import { z } from 'zod';
import {
  templateConfigSchema,
  rippleSchema,
  protocolSchema,
} from '../protocol/schemas';
import { S2SPublicationConfig } from './types';
import { S2STemplateConfig, S2SRipple } from '../protocol/types';



// ============================================================================
// Body Schema — discriminated union on encryption
// ============================================================================

// Shared base fields for both encrypted and plaintext bodies
const bodyBase = {
    id: z.string(),
    author: z.string(),
    locale: z.string(),
    parent: z.string(),
    position: z.string(),
    postType: z.string(),
    creationDate: z.string(),
    modifiedDate: z.string(),
    tags: z.array(z.string()),
    attributes: z.any().optional(),
    publication: z.string().optional(),
    base: z.string().optional(),
};

const bodySchema = z.discriminatedUnion('encryption', [
    z.object({
        ...bodyBase,
        encryption: z.literal(false),
        content: z.string(),
        title: z.string(),
        slug: z.string(),
        custom: z.any().optional(),
    }),
    z.object({
        ...bodyBase,
        encryption: z.literal(true),
        // title, slug, content live inside the ciphertext — not present here
    }),
]);

// ============================================================================
// Mapping Schemas
// ============================================================================

const mappingSchema = z.object({
    templateConfig: z.array(templateConfigSchema),  // ✅ This is correct
    ripples: z.array(rippleSchema)
});

const publicationConfigSchema = z.object({
    assetsCid: z.string(),
    contract: z.string(),
    dataGateway: z.string(),
    mapping: mappingSchema,  // ✅ Single object (not array)
    name: z.string(),
    templateCid: z.string(),
    localePaths: z.record(z.string(), z.string()).optional(),
    domain: z.string().optional(),
    aliases: z.array(z.string()).optional(),
}).passthrough() satisfies z.ZodType<S2SPublicationConfig>;

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