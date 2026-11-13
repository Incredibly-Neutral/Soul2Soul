/// <reference path="../action_globals.ts" />

/**
 * Encrypt — seal a body under the PKP the press holds, so only an execution
 * inside the enclave can open it again.
 *
 * The whole action is the enclave call: access is decided by the action group
 * the PKP is bound to, so there is no on-chain check to make here. The
 * ciphertext is the action's return value; the plaintext is never logged.
 */
async function main({ pkpId, message }: { pkpId: string; message: string }) {
  const ciphertext = await Lit.Actions.Encrypt({ pkpId, message });
  return { ciphertext };
}
