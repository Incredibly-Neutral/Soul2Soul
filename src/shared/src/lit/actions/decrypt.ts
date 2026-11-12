import {
  DRAFTS_MODULE_INTERFACE_ID,
  OWNER_HISTORY_MODULE_INTERFACE_ID,
} from '../../gates/modules';

// Action: Decrypt (author draft) — the caller names the author Safe, never a
// module, and the action resolves that Safe's modules itself. Resolution is the
// one in src/shared/src/gates/modules.ts, repeated here because the action ships
// as text: the Safe's own `getModulesPaginated` says which modules it runs, each
// enabled module is asked `supportsInterface` for the drafts role id and for the
// owner-history role id, and two modules answering one role is a refusal rather
// than a pick. The drafts log must name this Safe for the genesis, the append
// block of the genesis's last version fixes which owner set is judged, and the
// owner-history module answers `isOwnerAt(signer, thatBlock)`. A version whose
// recorded block is 0 was written before blocks were recorded, so there the
// action falls back to the Safe's live `isOwner` — the same fallback, and the
// same known limit, as gates `owns()`.
//
// The caller-supplied Safe is bound twice over: the genesis must be in its
// drafts log, and the blob's own signed `public.author` must equal it — a Safe
// can log another author's genesis and ciphertext CID in its own module, and
// only the blob's signed author refuses that.
//
// No `//` comments inside the string: compactAction() collapses newlines to
// spaces before the code is sent to Lit, so a line comment would swallow the
// rest of the action. The action also logs nothing — its stdout is returned to
// the host, and the plaintext, the ciphertext, the signature and the key must
// never reach a log line (see the log-hygiene note in lit.service.ts).
export const decryptAction = `
async function main({ pkpId, genesis, authorSafe, signature, rpcs, gateway }) {
  const trace = [];
  const step = (name, address) => {
    trace.push(address ? { step: name, address: String(address) } : { step: name });
  };
  const refuse = (error) => ({ ok: false, action: 'decrypt', error, trace });

  const isTrue = (value) => value === true || value === 'true' || value === 1 || value === '1';
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const zeroAddress = /^0x0{40}$/i;
  const SENTINEL = '0x0000000000000000000000000000000000000001';
  const GET_MODULES_ABI = ['function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)'];
  const SUPPORTS_INTERFACE_ABI = ['function supportsInterface(bytes4 interfaceId) view returns (bool)'];
  const ENTRY_ABI = ['function fetch(bytes32 genesis) view returns (tuple(bytes32 genesis, address author, string cid, uint256 timestamp, uint256 versionCount))'];
  const BLOCKS_ABI = ['function blocksOf(bytes32 genesis) view returns (uint64[] blocks)'];
  const IS_OWNER_ABI = ['function isOwner(address owner) view returns (bool)'];
  const IS_OWNER_AT_ABI = ['function isOwnerAt(address who, uint256 blockNumber) view returns (bool)'];

  try {
    const raw = String(genesis || '').trim();
    const genesisId = /^0x[0-9a-fA-F]{64}$/.test(raw)
      ? raw.toLowerCase()
      : ethers.utils.keccak256(ethers.utils.toUtf8Bytes(raw));
    step('genesis', genesisId);

    const safe = String(authorSafe || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(safe) || zeroAddress.test(safe)) {
      return refuse('author Safe is not an address');
    }

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
    /* A module that reverts (no ERC-165, mid-upgrade, not a module at all)
       answers "no". The call is spent either way; a broken module must not
       break the lookup for the others. */
    const ask = async (target, abi, fn, args) => {
      try { return await read(target, abi, fn, args); } catch (error) { return undefined; }
    };

    /* The Safe's own list: only the Safe writes it, so it is where a module is
       resolved out of. One call per page of 100; a Safe with more than 32 pages
       is not an author Safe. */
    const modules = [];
    let cursor = SENTINEL;
    for (let page = 0; page < 32; page++) {
      let answer;
      try {
        answer = await read(safe, GET_MODULES_ABI, 'getModulesPaginated', [cursor, 100]);
      } catch (error) {
        return refuse('cannot read the author Safe module list');
      }
      const list = Array.isArray(answer) && Array.isArray(answer[0]) ? answer[0] : null;
      if (!list) return refuse('cannot read the author Safe module list');
      for (const module of list) {
        if (!modules.some((seen) => same(seen, module))) modules.push(String(module));
      }
      const next = Array.isArray(answer) ? answer[1] : null;
      if (list.length === 0) break;
      if (next === null || next === undefined || zeroAddress.test(String(next)) || same(next, SENTINEL)) break;
      cursor = next;
    }
    if (modules.length === 0) return refuse('author Safe has no enabled modules');

    /* Two probes per enabled module, one per role. Two modules answering one
       role is a refusal: a Safe running two drafts logs has no single answer to
       whose genesis this is, and probe order must not decide it. */
    const drafts = [];
    const history = [];
    for (const module of modules) {
      if (isTrue(await ask(module, SUPPORTS_INTERFACE_ABI, 'supportsInterface', ['${DRAFTS_MODULE_INTERFACE_ID}']))) drafts.push(module);
      if (isTrue(await ask(module, SUPPORTS_INTERFACE_ABI, 'supportsInterface', ['${OWNER_HISTORY_MODULE_INTERFACE_ID}']))) history.push(module);
    }
    if (drafts.length === 0) return refuse('no drafts module on the author Safe');
    if (drafts.length > 1) return refuse('two drafts modules answer on the author Safe');
    if (history.length === 0) return refuse('no owner history module on the author Safe');
    if (history.length > 1) return refuse('two owner history modules answer on the author Safe');
    const draftsModule = drafts[0];
    const historyModule = history[0];
    step('draftsModule', draftsModule);

    const entry = await read(draftsModule, ENTRY_ABI, 'fetch', [genesisId]);

    const count = entry.versionCount;
    const unknown = count === 0 || count === '0' ||
      (count && typeof count.isZero === 'function' && count.isZero());
    if (unknown) return refuse('unknown draft');

    const author = String(entry.author);
    if (zeroAddress.test(author) || !same(author, safe)) return refuse('draft belongs to another Safe');
    step('draft', author);

    /* The block of the genesis's last version. 0 means the version was written
       before blocks were recorded, so the owner set it was written under is not
       on chain; the live isOwner is the documented fallback. */
    const blocks = await read(draftsModule, BLOCKS_ABI, 'blocksOf', [genesisId]);
    const lastBlock = Array.isArray(blocks) && blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
    if (lastBlock === undefined) return refuse('cannot read the append block');
    const blockNumber = typeof lastBlock === 'number' ? lastBlock : Number(String(lastBlock));
    if (!isFinite(blockNumber)) return refuse('cannot read the append block');
    step('appendBlock');

    const owns = blockNumber === 0
      ? isTrue(await read(safe, IS_OWNER_ABI, 'isOwner', [signer]))
      : isTrue(await read(historyModule, IS_OWNER_AT_ABI, 'isOwnerAt', [signer, blockNumber]));
    step(blockNumber === 0 ? 'isOwner' : 'isOwnerAt', blockNumber === 0 ? safe : historyModule);
    if (!owns) return refuse('signer does not own the author Safe');

    const response = await fetch(gateway + '/api/v0/cat?arg=' + entry.cid, { method: 'POST' });
    const item = JSON.parse(await response.text());
    step('item');

    if (item.encryption !== true) return refuse('not an encrypted item');

    /* The address is the last colon-separated segment, so an item pinned with an
       older scheme-prefixed author still matches; nothing writes that form now. */
    const blobAuthor = String((item.public && item.public.author) || '')
      .split(':')
      .pop()
      .toLowerCase();
    if (!same(blobAuthor, safe)) return refuse('item author is not the draft author');
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
