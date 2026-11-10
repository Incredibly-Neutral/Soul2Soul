// Action: Decrypt (author draft) — the author is resolved from their own drafts
// module, never taken from the caller. The module names the Safe that appended
// the genesis, that Safe answers `isOwner` for the signer, and the blob's own
// signed `public.author` must agree with the module before any plaintext is
// released.
//
// No `//` comments inside the string: compactAction() collapses newlines to
// spaces before the code is sent to Lit, so a line comment would swallow the
// rest of the action. The action also logs nothing — its stdout is returned to
// the host, and the plaintext, the ciphertext, the signature and the key must
// never reach a log line (see the log-hygiene note in lit.service.ts).
export const decryptAction = `
async function main({ pkpId, genesis, authorModule, signature, rpcs, gateway }) {
  const trace = [];
  const step = (name, address) => {
    trace.push(address ? { step: name, address: String(address) } : { step: name });
  };
  const refuse = (error) => ({ ok: false, action: 'decrypt', error, trace });

  try {
    const raw = String(genesis || '').trim();
    const genesisId = /^0x[0-9a-fA-F]{64}$/.test(raw)
      ? raw.toLowerCase()
      : ethers.utils.keccak256(ethers.utils.toUtf8Bytes(raw));
    step('genesis', genesisId);

    const signer = ethers.utils.recoverAddress(ethers.utils.hashMessage('lit actions auth'), signature);
    step('signer', signer);

    const urls = (rpcs && rpcs.L2) || [];
    if (urls.length === 0) return refuse('no L2 rpc');

    const read = async (target, abi, fn, args) => {
      let lastError = null;
      for (const url of urls) {
        try {
          const provider = new ethers.providers.StaticJsonRpcProvider(
            { url, timeout: 8000 },
            { chainId: 8453, name: 'base' },
          );
          return await new ethers.Contract(target, abi, provider)[fn](...args);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('no L2 rpc answered');
    };

    const entry = await read(
      authorModule,
      ['function fetch(bytes32 genesis) view returns (tuple(bytes32 genesis, address author, string cid, uint256 timestamp, uint256 versionCount))'],
      'fetch',
      [genesisId],
    );

    const count = entry.versionCount;
    const unknown = count === 0 || count === '0' ||
      (count && typeof count.isZero === 'function' && count.isZero());
    if (unknown) return refuse('unknown draft');

    const author = String(entry.author);
    step('draft', author);

    const owns = await read(
      author,
      ['function isOwner(address owner) view returns (bool)'],
      'isOwner',
      [signer],
    );
    step('isOwner', author);
    if (!owns) return refuse('signer does not own the author Safe');

    const response = await fetch(gateway + '/api/v0/cat?arg=' + entry.cid, { method: 'POST' });
    const item = JSON.parse(await response.text());
    step('item');

    if (item.encryption !== true) return refuse('not an encrypted item');

    const blobAuthor = String((item.public && item.public.author) || '')
      .replace(/^did:ethr:/i, '')
      .toLowerCase();
    if (blobAuthor !== author.toLowerCase()) return refuse('item author is not the draft author');
    step('blobAuthor', blobAuthor);

    const res = await Lit.Actions.Decrypt({ pkpId, ciphertext: item.body });
    const plaintext = typeof res === 'string'
      ? res
      : (res && typeof res.decrypted === 'string' ? res.decrypted : null);
    if (plaintext === null) return refuse('decrypt returned no plaintext');
    step('decrypt');

    const digest = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(plaintext));
    const signed = String((item.public && item.public.plaintextHash) || '').toLowerCase();
    if (digest.toLowerCase() !== signed) return refuse('plaintext does not match the signed hash');
    step('plaintextHash');

    return { ok: true, action: 'decrypt', data: { plaintext, author, cid: entry.cid }, trace };
  } catch (error) {
    return refuse('decrypt failed: ' + String((error && error.message) || error).slice(0, 160));
  }
}
`;
