import { canRead } from "./gates";

export const decrypt = async (
  pkpId: string,
  body: any,
  authorSafeAddress: string,
  publicationModule: string,
  signerAddress: string
): Promise<any> => {
  
  const ciphertext = JSON.parse(body.content);

  if (await canRead(body.id, authorSafeAddress, publicationModule, signerAddress)) {

    let res; 

    try {

      res = await Lit.Actions.Decrypt({ pkpId, ciphertext });

    } catch (error) {
      console.log("failed to decrypt", body.id)
      res = false;
    }

    return typeof res === 'string'                                        
     ? JSON.parse(res)                                                   
     : JSON.parse(res?.decrypted || JSON.stringify(res))  

  }
};
