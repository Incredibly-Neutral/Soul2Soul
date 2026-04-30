
import { AuthSig } from "@lit-protocol/auth-helpers";

// Helper function to safely parse authSig
export const parseAuthSig = (authSig: any): AuthSig | null => {
    if (typeof authSig === 'string') {
        try {
            const cleaned = authSig.replace(/\\\\n/g, '\\n');
            return JSON.parse(cleaned) as AuthSig;
        } catch (e) {
            console.error('Error parsing authSig:', e);
            return null;
        }
    } else if (typeof authSig === 'object' && authSig !== null) {
        return authSig as AuthSig;
    }
    return null;
};

// Helper function to extract Ethereum address from authSig
export const getEthAddressFromCapability = (authSig: any): string => {
    try {
        if (typeof authSig === 'string') {
            authSig = JSON.parse(authSig);
        }
        
        // Parse signedMessage if it's a string
        if (authSig.signedMessage && typeof authSig.signedMessage === 'string') {
            const signedMessageObj = JSON.parse(authSig.signedMessage);
            
            interface Capability {
                sig: string;
                address: string;
                derivedVia: string;
                signedMessage: string;
            }
            
            // Get the first capability that has an Ethereum address
            if (signedMessageObj.capabilities && Array.isArray(signedMessageObj.capabilities)) {
                const capability = signedMessageObj.capabilities.find((cap: Capability) => cap.address?.startsWith('0x'));
                if (capability) {
                    return capability.address;
                }
            }
        }
    } catch (e) {
        console.error('Error extracting Ethereum address:', e);
    }
    return '';
};

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