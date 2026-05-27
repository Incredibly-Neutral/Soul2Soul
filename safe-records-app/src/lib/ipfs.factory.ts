export const fetchFromIPFS = async (ipfsGateway: string, cid: string): Promise<any> => {
        const url = `${ipfsGateway}/api/v0/cat?arg=${cid}`;

        console.log(url)
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
            'Content-Type': 'application/json',
            // Add auth if needed:
            // 'Authorization': 'Bearer YOUR_TOKEN'
            }
        });

        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('IPFS error response:', errorText);
            throw new Error(`Failed to fetch from IPFS: ${response.status} ${response.statusText}`);
        }
        
        const text = await response.text();

        console.log(text)
        
        try {
            return JSON.parse(text);
        } catch (error) {
            console.error('Failed to parse IPFS response as JSON:', text);
            throw new Error('Invalid JSON response from IPFS');
        }
    }


export const add = async (
  fileContent: string,
  name: string,
  ipfs_endpoint: string,
  onlyHash?: boolean,
): Promise<string> => {
  const formData = new FormData();
  
  // Create a blob with the file content
  const blob = new Blob([fileContent], { type: 'text/plain' });
  formData.append('file', blob, name);

  const apiPath = onlyHash ? "api/v0/add?only-hash=true" : "api/v0/add";

  const response = await fetch(
    `https://${fixEndpoint(ipfs_endpoint)}/${apiPath}`,
    {
      method: 'POST',
      body: formData,
      // Don't set Content-Type header - browser will set it automatically with correct boundary
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`IPFS add failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result = await response.json();
  return result.Hash || result.Cid?.['/'] || result.Cid;
};

export const dagPut = async (
  fileContent: string,
  name: string,
  ipfs_endpoint: string,
): Promise<string> => {
  const formData = new FormData();
  
  // Create a blob with the JSON data
  const blob = new Blob([fileContent], { type: 'application/json' });
  formData.append('object data', blob, name || 'dag.json');

  const response = await fetch(
    `https://${fixEndpoint(ipfs_endpoint)}/api/v0/dag/put`,
    {
      method: 'POST',
      body: formData,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DAG put failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result = await response.json();
  return result.Cid['/'] || result.Cid || result.Hash;
};

const fixEndpoint = (endpoint: string) => {
  return endpoint
    .replace(/^(https?:\/\/)/, "") // Remove protocol if present
    .replace(/\/+$/, ""); // Remove trailing slashes
};