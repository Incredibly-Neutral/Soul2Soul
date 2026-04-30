import { canRead } from "@s2s/soul2soul-shared/lit-actions";


export const decrypt = async (
  body: any,
  authorSafeAddress: string,
  publicationModule: string,
): Promise<any> => {
  
  const { ciphertext, dataToEncryptHash } = JSON.parse(body.content);
  const ucc = canRead(body.id, authorSafeAddress, publicationModule);
  const decryptionParams = {
      accessControlConditions: ucc,
      ciphertext: ciphertext,
      dataToEncryptHash: dataToEncryptHash,
      authSig: null,
      chain: "base",
  };
  let decrypted; 

  try {
    decrypted = JSON.parse(await Lit.Actions.decryptAndCombine(decryptionParams));

    console.log(decrypted)

  } catch (error) {
    console.log("failed to decrypt", body.id)
    decrypted = undefined;
  }

  return decrypted
};
