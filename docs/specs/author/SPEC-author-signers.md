# SPEC-author-signers — `s2s signer`: a key that joins a Safe it did not create

> **Parent:** [SPEC-author-cli](SPEC-author-cli.md) — the headless binary this group is part of.
> The Safe-side primitives are [SPEC-author-identity](SPEC-author-identity.md); the given-Safe
> record shape is [SPEC-author-cli](SPEC-author-cli.md) (`safeSource: 'given'`).
>
> **Type:** host specification — the `signer` command group of `@s2s/author-cli`.
>
> **Status:** IMPLEMENTED. Unit-tested offline (fake chain reads, fake service); never run against a
> live Safe Transaction Service in this build.
>
> **Origin:** joera direction — "a key should be able to join a Safe it did not create: propose
> itself as an owner, see what is queued, confirm it". The authoring flow assumes the CLI created
> the Safe (`author new`); a co-signer on someone else's Safe has no command that starts from a
> Safe address.

---

## The one-paragraph model

The Safe exists and belongs to somebody else. This key is not an owner yet, the CLI will not
deploy anything, and no bundler is involved: `signer add` proposes the key as one more owner,
`signer queue` shows what is waiting, `signer confirm` signs one proposal and executes it when the
confirmations are enough. Every proposal is an ordinary `Safe` transaction — `to: safe`, zero gas
fields — so the work is an HTTP POST to the Safe Transaction Service plus, at most, one plain
transaction sent from the EOA.

All three actions are **store commands**: `cli.ts` dispatches them before `buildContext`, so they
need no bundler, no paymaster and no `CliContext`. The config is loaded directly, the L2 endpoint
comes from `buildRpcEndpoints`, and the service is built from `config.safeTx` with the default
`fetch`.

## Command surface

```
s2s signer add      <safe> [--name <pet-name>] [--key <0x…> | --mnemonic <words>] [--json]
s2s signer queue    [<safe>] [--json]
s2s signer confirm  <safeTxHash> [--safe <safe>] [--no-execute] [--json]
```

## `signer add <safe>`

1. The key comes from `resolveKeySource` — the same resolver `author new` uses: `--key`,
   `--mnemonic`, a line on stdin, else a generated BIP39 phrase printed **once**, with its
   mnemonic, in both output modes.
2. The Safe is read from the chain: bytecode, owners, threshold, nonce. No bytecode is a usage
   error — this command proposes an owner of a Safe that is already deployed, and it never deploys
   one.
3. An EOA that is already an owner is a usage error, and nothing is filed.
4. The key is filed with `addSigner({name, privateKey, safe})`, which marks the record
   `safeSource: 'given'` and activates it. The default name is `signer-<first 6 hex of the new
   EOA>`; a taken name or a key filed under another author is a usage error from `addSigner`, thrown
   before the store is written.
5. The proposal is `addOwnerWithThreshold(newEoa, threshold)` where the threshold is the Safe's
   **current** one, read from the chain and never raised: one more owner must not change how many
   signatures a transaction needs. `sender` is the new EOA, the nonce is the Safe's, and the
   service's placeholder signature is `"0x"` — the proposer's own signature is a confirmation, and
   a proposal is not a confirmation.
6. The service is told about the Safe when it 404s (`register`), then given the proposal.

**The key survives a failed proposal.** Filing happens before the service is touched. When
`register` or `propose` fails — unreachable, 4xx, no `safeTx.url` configured — the command reports
`proposed: false`, a `note` with the reason, and the `{to, data}` pair it would have posted, so the
call can be made by hand from an owner's wallet. The key is the part that cannot be recovered, so a
network failure never costs it.

JSON:

```json
{ "action": "signer.add", "name": "signer-2b5ad5", "eoa": "0x…", "safe": "0x…",
  "threshold": 2, "owners": ["0x…"], "nonce": 7, "safeTxHash": "0x…", "proposed": true,
  "safeTx": { "to": "0x…", "data": "0x…" }, "file": "…/authors.json",
  "note": "…", "mnemonic": "…", "privateKey": "0x…" }
```

`note` is present only on failure; `mnemonic` whenever a phrase was resolved or made;
`privateKey` only when the run generated one, as `author new` does.

## `signer queue [<safe>]`

Unexecuted proposals, **oldest nonce first** — a Safe executes one nonce at a time, so the queue is
a sequence, not a set. The default Safe is the stored `given` Safe this config signs for
(`givenSafeInUse`), else the active record's recorded Safe; with neither, a usage error.

Per row: nonce, the full `safeTxHash` (the argument the next command takes), the decoded method and
its new-owner argument when the service returned `dataDecoded` (`addOwnerWithThreshold`,
`removeOwner` and `swapOwner` all name the parameter `owner`), confirmations as *k of n*, and
whether this machine's key is an owner that **has not** confirmed.

Owners and threshold come from the chain, because the service's copy of a Safe it was told about
once can be older than the Safe. An unreadable RPC costs the owner columns, not the listing: the
rows still print, `keyIsOwner` is `null` (not `false`), and a warning carries the reason.

Read-only: nothing is proposed, signed or spent.

## `signer confirm <safeTxHash> [--safe <safe>] [--no-execute]`

1. **Sign.** `signMessage` over the raw 32-byte `safeTxHash` — the eth_sign scheme, `v` 27/28, which
   `packSignatures` bumps to 31/32 for the Safe. Signing a different digest produces a signature
   that recovers to another owner and the Safe answers `GS026`.
2. **Post.** The signature goes to the service as a confirmation.
3. **Re-read.** The confirmations are read back and this key's own signature is merged in, because
   the service may not have indexed it yet. A 32-byte entry is a contract owner's `approveHash`
   approval and cannot be packed, so only 65-byte confirmations count.
4. **Execute** when the signable confirmations meet the Safe's threshold **and** the proposal's
   nonce is still the Safe's: `packSignatures` in ascending owner order, `execTransactionArgs`, one
   plain transaction from the EOA.

Refusals, all before anything is signed:

| state | outcome |
|---|---|
| key is not an owner of the Safe | `not_owner` |
| Safe has no bytecode | `safe_not_deployed` |
| proposal already executed | `already_executed` |
| proposal nonce below the Safe's | `stale_nonce` — it can never execute; propose it again |
| owner entry is a contract (the EOA has code) | `contract_owner` — it confirms by calling `approveHash` from its own code |

A proposal with a nonce **ahead** of the Safe is not a refusal: its confirmation is posted and the
command reports why it did not execute (it is queued behind the transaction at the front). Same for
a confirmation that leaves the threshold unmet.

`--no-execute` stops after step 2, for a key that should not spend.

## Gas

Proposing and confirming are HTTP only and cost nothing. **Execution costs gas, paid by the EOA that
sends `execTransaction`**, and nothing is refunded to it: the proposal's gas fields are zero, so the
Safe does not repay the sender. The help text and the human output say so; a failed send surfaces as
an error after the confirmation is already posted, because the confirmation is worth keeping.

## Guesses and open items

Recorded as guesses, not contracts — each one is a place a live service may disagree:

1. **Registration payload.** `POST /api/v1/safes/` with `{address, owners, threshold, singleton,
   fallbackHandler, implementationVersion, modules: [], delegate}`. The field names are the service's
   own and are taken from its documented shape, not from a request this build made.
2. **API-key header.** `Authorization: Bearer <safeTx.key>`. The public host answers unauthenticated
   requests at a rate a busy queue will hit; a Safe account's key is the remedy if the header is the
   one the service reads.
3. **The chain id.** `8453`. The hash is EIP-712 over `{chainId, verifyingContract}`, so a service
   indexing another chain rejects the proposal as a mismatch; `SIGNER_CHAIN_ID` is the one place it
   is written.
4. **`dataDecoded` parameter names.** Read as `owner` for the OwnerManager methods; a service that
   decodes differently loses the new-owner column, not the row.
5. **The queue filter.** `?executed=false&ordering=nonce`, with a local sort on nonce so the order
   does not depend on the service honouring the parameter.

## Tests

`test/signer-add.test.ts`, `test/signer-queue.test.ts`, `test/signer-confirm.test.ts`. Every chain
read and every service call is injected through `SignerDeps`; no test opens a socket. The signature
is checked by `verifyMessage` recovery against the raw hash, and the packed list is decoded back out
of the `execTransaction` calldata.
