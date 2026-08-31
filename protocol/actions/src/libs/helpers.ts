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

export const fetchWithTimeout = async (url: string, options = {}, timeoutMs = 5000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
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

