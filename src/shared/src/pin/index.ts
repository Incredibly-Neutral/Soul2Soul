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
    console.log(`✓ filebase ${cid}`);

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
      throw new Error(`Filebase pin failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // Drain the body: the pin request's response is not printed (it is a
    // provider payload — requestid, delegate list, pin metadata — that says
    // nothing an operator can act on; the start line already names the CID).
    await response.json();
    return true;
  } catch (error) {
    console.error(
      `✗ filebase ${cid}: ${error instanceof Error ? error.message : String(error)}`,
    );
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

    console.log(`✓ pinata ${cid}`);

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
      throw new Error(`Pinata pin failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // Body drained, not printed — see the Filebase leg.
    await response.json();
    return true;
  } catch (error) {
    console.error(
      `✗ pinata ${cid}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
