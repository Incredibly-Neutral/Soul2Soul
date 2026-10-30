// export function setupFetchInterceptor(debug: boolean = false) {
//     const originalFetch = globalThis.fetch;
//     globalThis.fetch = async (url: string | URL | Request, options: RequestInit = {}) => {
//         const modifiedOptions = { ...options };
//         modifiedOptions.credentials = 'omit';

//         // Ensure content-type is set for POST requests
//         if (modifiedOptions.method === 'POST' && modifiedOptions.headers && !('content-type' in modifiedOptions.headers)) {
//             modifiedOptions.headers = {
//                 ...modifiedOptions.headers,
//                 'content-type': 'application/json'
//             };
//         }
        
//         if (debug) {
//             let bodyText = '(no body)';
//             if (modifiedOptions?.body) {
//                 if (modifiedOptions.body instanceof ReadableStream) {
//                     bodyText = '(stream)';
//                 } else if (typeof modifiedOptions.body === 'string') {
//                     try {
//                         // Try to parse and pretty print if it's JSON string
//                         bodyText = JSON.stringify(JSON.parse(modifiedOptions.body), null, 2);
//                     } catch {
//                         bodyText = modifiedOptions.body;
//                     }
//                 } else {
//                     try {
//                         bodyText = JSON.stringify(modifiedOptions.body, null, 2);
//                     } catch (e) {
//                         bodyText = '(unstringifiable body)';
//                     }
//                 }
//             }

//             console.log('Fetch request details:', {
//                 url,
//                 method: modifiedOptions.method || 'GET',
//                 headers: modifiedOptions.headers,
//                 credentials: modifiedOptions.credentials,
//                 body: bodyText
//             });
//         }

//         try {
//             const response = await originalFetch(url, modifiedOptions);
//             if (debug) {
//                 const clonedResponse = response.clone();
//                 let responseText = '';
//                 try {
//                     responseText = await clonedResponse.text();
//                     // Try to parse and pretty print JSON responses
//                     try {
//                         const jsonResponse = JSON.parse(responseText);
//                         responseText = JSON.stringify(jsonResponse, null, 2);
//                     } catch (e) {
//                         // Not JSON, use text as is
//                     }
//                 } catch (e) {
//                     responseText = '(error reading response body)';
//                 }

//                 // Convert headers to object safely
//                 const responseHeaders: Record<string, string> = {};
//                 response.headers.forEach((value, key) => {
//                     responseHeaders[key] = value;
//                 });

//                 console.log('Fetch response:', {
//                     url,
//                     status: response.status,
//                     statusText: response.statusText,
//                     headers: responseHeaders,
//                     body: responseText
//                 });
//             }
//             return response;
//         } catch (error) {
//             if (debug) {
//                 console.error('Fetch error:', {
//                     url,
//                     error: error instanceof Error ? error.message : error,
//                     stack: error instanceof Error ? error.stack : undefined,
//                     request: {
//                         method: modifiedOptions.method || 'GET',
//                         headers: modifiedOptions.headers,
//                         credentials: modifiedOptions.credentials
//                     }
//                 });
//             }
//             throw error;
//         }
//     };
// }
