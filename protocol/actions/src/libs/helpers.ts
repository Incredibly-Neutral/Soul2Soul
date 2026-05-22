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
    } finally {
        clearTimeout(timeout);
    }
};

