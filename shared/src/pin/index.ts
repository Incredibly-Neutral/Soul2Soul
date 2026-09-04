/**
 * Pin (repin) an existing CID to either Filebase or Pinata depending on provider.
 *
 * @param cid    - IPFS CID to pin
 * @param remote - Remote IPFS gateway URL (used by Pinata sourceIpfs)
 * @param token  - Auth token for the chosen provider
 * @param provider - 'filebase' (default) or 'pinata'
 */
export const pinCidFromRemote = async (
  cid: string,
  remote: string,
  token: string,
  provider: 'filebase' | 'pinata' = 'filebase',
): Promise<boolean> => {
  // Make sure CID is in the correct format (remove ipfs:// prefix if present)
  if (cid.startsWith('ipfs://')) {
    cid = cid.replace('ipfs://', '');
  }

  if (provider === 'pinata') {
    return pinCidPinata(cid, remote, token);
  }

  return pinCidFilebase(cid, token);
};

async function pinCidFilebase(cid: string, token: string): Promise<boolean> {
  try {
    console.log('[shared/pin] Pinning CID with Filebase:', cid);

    const response = await fetch('https://api.filebase.io/v1/ipfs/pins', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cid,
        name: `pinned-${Date.now()}`,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[shared/pin] Filebase pin error:', errorText);
      throw new Error(
        `Filebase pin failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();
    console.log('[shared/pin] Filebase pin result:', result);
    return true;
  } catch (error) {
    console.error('[shared/pin] Error pinning CID with Filebase:', error);
    return false;
  }
}

async function pinCidPinata(cid: string, remote: string, pinataJwt: string): Promise<boolean> {
  try {
    const body = {
      hashToPin: cid,
      pinataMetadata: {
        name: `pinned-${Date.now()}`,
      },
      pinataOptions: {
        sourceIpfs: {
          apiUrl: `${remote}/api/v0`,
        },
      },
    };

    console.log('[shared/pin] Pinning CID with Pinata:', body);

    const response = await fetch('https://api.pinata.cloud/pinning/pinByHash', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pinataJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[shared/pin] Pinata pin error:', errorText);
      throw new Error(
        `Pinata pin failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();
    console.log('[shared/pin] Pinata pinByHash result:', result);
    return true;
  } catch (error) {
    console.error('[shared/pin] Error pinning CID with Pinata:', error);
    return false;
  }
}
