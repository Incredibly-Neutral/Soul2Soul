export const addressToUserId = (address: string): Uint8Array => {
    // Remove 0x prefix if present
    const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;
    
    // Convert hex string to Uint8Array
    const bytes = new Uint8Array(cleanAddress.length / 2);
    for (let i = 0; i < cleanAddress.length; i += 2) {
        bytes[i/2] = parseInt(cleanAddress.slice(i, i + 2), 16);
    }
    return bytes;
};

// Kubo RPC bearer token for the data gateway, set once per action run from
// `endpoints.ipfsGatewayAuth` (see each action's main()). Applied ONLY to Kubo
// RPC URLs (`/api/v0/`) so the token never leaks to GitHub/Filecoin/runner
// fetches. Reads are public on the gateway, but sending the token on reads too
// is harmless and keeps the actions working once Kubo `API.Authorizations`
// (node-wide auth) is enabled as defense-in-depth.
let rpcAuth: string | undefined;

export const setRpcAuth = (auth?: string): void => {
    rpcAuth = auth;
};

export const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = 5000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = new Headers((options.headers as Record<string, string> | undefined) ?? {});
        if (rpcAuth && url.includes('/api/v0/')) {
            headers.set('Authorization', rpcAuth);
        }
        const res = await fetch(url, { ...options, headers, signal: controller.signal });
        return res;
    } catch (e) {
        // A bare fetch rejection on abort is `AbortError: The signal has been
        // aborted` — useless for diagnosing which gateway/op hit its bound.
        // Relabel it with the URL (host = gateway, path = kubo op) + timeout.
        if (isAbortLikeError(e)) {
            throw new Error(`timed out after ${timeoutMs}ms calling ${url}`);
        }
        throw e;
    } finally {
        clearTimeout(timeout);
    }
};

const isAbortLikeError = (e: unknown): boolean => {
    return (
        typeof e === 'object' &&
        e !== null &&
        'name' in e &&
        (e as { name?: string }).name === 'AbortError'
    );
};

export function requireFields<T extends object>(obj: T, fields: (keyof T)[]): void {
  const missing = fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === "");
  if (missing.length) throw `missing required field(s): ${missing.join(", ")}`;
}

