/**
 * Pin (repin) an existing CID to Filebase via their Pinning Service API (PSA).
 *
 * Filebase PSA endpoint: POST https://api.filebase.io/v1/ipfs/pins
 * Auth: Authorization: Bearer <access-token>
 * Body: { "cid": "<cid>", "name": "optional-name" }
 *
 * The old Pinata implementation is commented out and kept for reference.
 * Switch reason: eth.link team reports Pinata has been unreliable; they recommend Filebase.
 */
export const pinCidFromRemote = async (
  cid: string,
  _remote: string,
  filebase_token: string,
): Promise<boolean> => {
  try {
    // Make sure CID is in the correct format (remove ipfs:// prefix if present)
    if (cid.startsWith('ipfs://')) {
      cid = cid.replace('ipfs://', '');
    }

    console.log('Pinning CID with Filebase:', cid);

    // Filebase Pinning Service API: repin existing CID
    const response = await fetch('https://api.filebase.io/v1/ipfs/pins', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${filebase_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cid,
        name: `pinned-${Date.now()}`,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Filebase pin error response:', errorText);
      throw new Error(
        `Filebase pin failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();
    console.log('Filebase pin result:', result);
    return true;
  } catch (error) {
    console.error('Error pinning CID:', error);
    return false;
  }
};

/* ── Pinata pinCidFromRemote (disabled in favor of Filebase — eth.link recommends Filebase) ──
export const pinCidFromRemote_pinata = async (cid: string, remote: string, pinata_jwt: string): Promise<boolean> => {
    try {
      if (cid.startsWith("ipfs://")) {
        cid = cid.replace("ipfs://", "");
      }

      const body = {
        hashToPin: cid,
        pinataMetadata: {
          name: `pinned-${Date.now()}`,
        },
        pinataOptions: {
          sourceIpfs: {
            apiUrl: remote + "/api/v0",
          },
        },
      };

      console.log("Pinning CID with Pinata:", body);

      const response = await fetch(
        "https://api.pinata.cloud/pinning/pinByHash",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pinata_jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Pinata error response:", errorText);
        throw new Error(
          `Pinata upload failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const result = await response.json();
      console.log("Pinata pinByHash result:", result);
      return true;
    } catch (error) {
      console.error("Error pinning CID:", error);
      return false;
    }
  }
*/
