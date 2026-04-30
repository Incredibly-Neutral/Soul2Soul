declare module 'ipfs-only-hash' {
    export function of(input: Buffer | Uint8Array | string): Promise<string>;
    export function of(input: Buffer | Uint8Array | string, options: { cidVersion?: number }): Promise<string>;
}
