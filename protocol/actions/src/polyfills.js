// Polyfills for browser environment
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

// Add any other necessary polyfills here
if (typeof process === 'undefined') {
    globalThis.process = {
        env: {
            NODE_ENV: 'production'
        }
    };
}
