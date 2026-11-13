/// <reference path="../action_globals.ts" />

import type { ActionResult, DecryptData, DecryptParams } from '@s2s/soul2soul-shared/lit-actions';
import { decryptAuthorDraft } from '../libs/author-draft';
import {
  extractSignerAddress,
  isOwnerAt,
  resolveAuthorModules,
} from '../libs/gates';
import { evmRead } from '../libs/evm';
import { catFile } from '../libs/ipfs.factory';

const ACTION = 'decrypt';

// The message the caller signs to prove the signer address it names is its own.
const AUTH_MESSAGE = 'lit actions auth';

/**
 * Decrypt (author draft) — GATES-1, opening a draft for the author Safe that
 * keeps it.
 *
 * The wrapper is only wiring: the modules, the pin and every refusal live in
 * ../libs/author-draft, which takes them as injected dependencies so they run in
 * a unit test. `gateway` arrives from `LitService`, which owns it; the action
 * cats the entry CID the pinned read returned.
 */
async function main(input: DecryptParams & { gateway: string }): Promise<ActionResult<DecryptData>> {
  const rpcs = input.rpcs?.L2;

  const outcome = await decryptAuthorDraft(input, {
    resolveModules: (authorSafe) => resolveAuthorModules(authorSafe, rpcs),
    readValue: (target, abi, fn, args) => evmRead('L2', target, abi, fn, args, rpcs),
    isOwnerAt: (safe, who, block, ownerHistory) =>
      isOwnerAt(safe, who, block, ownerHistory, rpcs),
    read: (target, abi, fn, args, block) => evmRead('L2', target, abi, fn, args, rpcs, block),
    cat: (cid) => {
      if (!input.gateway) throw new Error('no gateway');
      return catFile(input.gateway, cid);
    },
    decrypt: (ciphertext) => Lit.Actions.Decrypt({ pkpId: input.pkpId, ciphertext }),
    recoverSigner: (signature) =>
      extractSignerAddress(ethers.utils.hashMessage(AUTH_MESSAGE), signature),
  });

  return { ...outcome, action: ACTION };
}
