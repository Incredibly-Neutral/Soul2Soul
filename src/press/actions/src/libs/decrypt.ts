import { canRead } from './gates';

/**
 * Plaintext as produced by the decryptor — the RAW STRING is kept because it is
 * the only thing that can be hashed against the author's `plaintextHash`.
 * Re-serialising the parsed object is not equivalent (JCS orders integer-like
 * keys lexically, JSON.stringify emits them numerically; whitespace and escapes
 * differ too), so it can both false-fail and false-pass.
 */
export interface DecryptedPlaintext {
  /** Bytes to hash: the string the author signed over, exactly as received. */
  raw: string;
  /** `raw` parsed — what mergeDecrypted consumes. */
  parsed: unknown;
  /**
   * False when the decryptor returned an object instead of a string, so `raw`
   * is a re-serialisation (best effort only). True in the normal string case.
   */
  rawFromDecryptor: boolean;
}

/**
 * Decrypt a gated body, keeping the plaintext bytes.
 *
 * Returns undefined when the caller is not allowed to read the body or when
 * decryption failed (same truthiness contract the callers already rely on).
 */
export const decryptRaw = async (
  pkpId: string,
  body: any,
  authorSafeAddress: string,
  publicationModule: string,
  signerAddress: string,
  rpcs?: string[],
): Promise<DecryptedPlaintext | undefined> => {
  const ciphertext = JSON.parse(body.content);

  if (!(await canRead(body.id, authorSafeAddress, publicationModule, signerAddress, rpcs ?? []))) {
    return undefined;
  }

  let res;

  try {
    res = await Lit.Actions.Decrypt({ pkpId, ciphertext });
  } catch {
    console.log('failed to decrypt', body.id);
    res = false;
  }

  if (!res) return undefined;

  if (typeof res === 'string') {
    return { raw: res, parsed: JSON.parse(res), rawFromDecryptor: true };
  }

  const decrypted = (res as { decrypted?: unknown }).decrypted;
  if (typeof decrypted === 'string') {
    return { raw: decrypted, parsed: JSON.parse(decrypted), rawFromDecryptor: true };
  }

  // Last resort: the decryptor handed back a parsed object. Nothing better to
  // hash than its re-serialisation, so callers must treat this as best-effort.
  const raw = JSON.stringify(res);
  return { raw, parsed: JSON.parse(raw), rawFromDecryptor: false };
};

/** Decrypt and parse only. Kept for callers that do not verify (they should). */
export const decrypt = async (
  pkpId: string,
  body: any,
  authorSafeAddress: string,
  publicationModule: string,
  signerAddress: string,
  rpcs?: string[],
): Promise<any> => {
  const decrypted = await decryptRaw(
    pkpId,
    body,
    authorSafeAddress,
    publicationModule,
    signerAddress,
    rpcs,
  );
  return decrypted?.parsed;
};
