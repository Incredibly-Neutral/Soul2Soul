export const pinCidFromRemote = async (cid: string, remote: string, pinata_jwt: string): Promise<boolean> => {
    try {
      // Make sure CID is in the correct format (remove ipfs:// prefix if present)
      if (cid.startsWith("ipfs://")) {
        cid = cid.replace("ipfs://", "");
      }

      // Format the request body according to Pinata API specifications
      const body = {
        hashToPin: cid,
        pinataMetadata: {
          name: `pinned-${Date.now()}`, // Adding timestamp to make name unique
        },
        // hostNodes is deprecated, use sourceIpfs instead
        pinataOptions: {
          sourceIpfs: {
            apiUrl: remote + "/api/v0", // Should be a complete URL like "https://ipfs.example.com/api/v0"
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
            "Content-Type": "application/json", // Make sure this header is set
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