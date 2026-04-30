// Polyfills for browser environment
if (typeof window !== 'undefined') {
    window.global = window;
    window.process = {
        env: {
            NODE_ENV: process.env.NODE_ENV || 'development'
        }
    };

    // Base64URL utilities
    window.base64urlToJSON2 = window.base64urlToJSON = function(str) {
        console.log('Input base64url:', str);
        
        if (!str) {
            throw new Error('Input string is empty or undefined');
        }

        // Handle URL-safe characters
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        console.log('After replacing chars:', str);
        
        // Add padding
        let paddedStr = str;
        const mod4 = str.length % 4;
        if (mod4) {
            paddedStr = str + '='.repeat(4 - mod4);
        }
        console.log('After padding:', paddedStr);

        try {
            // Decode base64 to binary string
            const binaryStr = atob(paddedStr);
            console.log('After atob:', binaryStr);
            
            // Convert binary string to JSON
            const jsonStr = decodeURIComponent(escape(binaryStr));
            console.log('After decodeURIComponent:', jsonStr);
            
            return JSON.parse(jsonStr);
        } catch (e) {
            console.error('Error decoding base64url:', e);
            throw e;
        }
    };

    window.JSONToBase64url = function(obj) {
        // Convert JSON to string
        const jsonStr = JSON.stringify(obj);
        
        // Convert to binary string
        const binaryStr = unescape(encodeURIComponent(jsonStr));
        
        // Convert to base64
        const base64 = btoa(binaryStr);
        
        // Make URL safe
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };

    // Stream polyfill
    if (!window.ReadableStream) {
        const { ReadableStream, WritableStream, TransformStream } = require('web-streams-polyfill');
        window.ReadableStream = ReadableStream;
        window.WritableStream = WritableStream;
        window.TransformStream = TransformStream;
    }

    // TextEncoder/TextDecoder polyfill
    if (!window.TextEncoder) {
        const util = require('util');
        window.TextEncoder = util.TextEncoder;
        window.TextDecoder = util.TextDecoder;
    }

    // Web Crypto polyfill
    if (!window.crypto || !window.crypto.subtle) {
        const { webcrypto } = require('crypto');
        if (!window.crypto) {
            Object.defineProperty(window, 'crypto', {
                get() {
                    return webcrypto;
                },
                configurable: true
            });
        }
    }

    // Buffer polyfill
    const BufferImpl = {
        from(data, encoding) {
            if (typeof data === 'string') {
                return new Uint8Array(new TextEncoder().encode(data));
            }
            if (Array.isArray(data)) {
                return new Uint8Array(data);
            }
            if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                return new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
            }
            throw new Error('Unsupported data type for Buffer.from');
        },

        alloc(size, fill, encoding) {
            const buf = new Uint8Array(size);
            if (fill !== undefined) {
                buf.fill(fill);
            }
            return buf;
        },

        allocUnsafe(size) {
            return new Uint8Array(size);
        },

        allocUnsafeSlow(size) {
            return new Uint8Array(size);
        },

        isBuffer(obj) {
            return obj instanceof Buffer;
        },

        byteLength(string, encoding) {
            return new TextEncoder().encode(string).length;
        },

        concat(list, totalLength) {
            if (totalLength === undefined) {
                totalLength = list.reduce((acc, val) => acc + val.length, 0);
            }
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const buf of list) {
                result.set(new Uint8Array(buf.buffer || buf), offset);
                offset += buf.length;
            }
            return result;
        }
    };

    // Create Buffer constructor that inherits from Uint8Array
    class Buffer extends Uint8Array {
        constructor(arg, encodingOrOffset, length) {
            if (typeof arg === 'number') {
                super(arg);
            } else {
                const buf = BufferImpl.from(arg, encodingOrOffset);
                super(buf.buffer, buf.byteOffset, buf.length);
            }
        }

        toString(encoding = 'utf8') {
            return new TextDecoder(encoding).decode(this);
        }

        slice(start, end) {
            return new Buffer(super.slice(start, end));
        }

        write(string, offset = 0) {
            const buf = new TextEncoder().encode(string);
            this.set(buf, offset);
            return buf.length;
        }
    }

    // Copy static methods
    Object.assign(Buffer, BufferImpl);

    // Make Buffer available globally
    window.Buffer = Buffer;
}
