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
`signer rotate` swaps this machine's key for a fresh one, `signer queue` shows what is waiting,
`signer confirm` signs one proposal and executes it when the confirmations are enough. Every
proposal is an ordinary `Safe` transaction — `to: safe`, zero gas fields — so the work is an HTTP
POST to the Safe Transaction Service plus, at most, one plain transaction sent from the EOA.

All four actions are **store commands**: `cli.ts` dispatches them before `buildContext`, so they
need no bundler, no paymaster and no `CliContext`. The config is loaded directly, the L2 endpoint
comes from `buildRpcEndpoints`, and the service is built from `config.safeTx` with the default
`fetch`.

## Command surface

```
s2s signer add      <safe> [--name <pet-name>] [--key <0x…> | --mnemonic <words>] [--json]
s2s signer rotate   <safe> [--name <pet-name>] [--key <0x…> | --mnemonic <words>] [--json]
s2s signer queue    [<safe>] [--json]
s2s signer confirm  <safeTxHash> [--safe <safe>] [--no-execute] [--json]
```

## `signer add <safe>`

1. The key comes from `resolveKeySource` — the same resolver `author new` uses: `--key`,
   `--mnemonic`, a line on stdin, else a generated BIP39 phrase printed **once**, with its
   mnemonic, in both output modes.
2. The Safe is read from the chain: bytecode, owners, threshold, nonce. No bytecode is
   `safe_not_deployed`, the same coded refusal `signer confirm` gives: the address is not misspelt,
   there is simply no Safe there. This command proposes an owner of a Safe that is already deployed,
   and it never deploys one.
3. An EOA that is already an owner is a usage error, and nothing is filed.
4. The key is filed with `addSigner({name, privateKey, safe})`, which marks the record
   `safeSource: 'given'` and activates it. The default name is `signer-<first 6 hex of the new
   EOA>`; a taken name, a key filed under another author, or a Safe already filed under another
   author is a usage error from `addSigner`, thrown before the store is written.
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

## `signer rotate <safe>`

Replace this machine's key on the Safe with a fresh one, in **one** Safe transaction:
`swapOwner(prevOwner, oldOwner, newOwner)`. The threshold is not a parameter of that call and does
not move — a rotation is a swap, not a remove followed by an add, so the owner count and the bar
for a signature stay as they are.

1. **Settle, then find the old key.** The Safe's owners are read first, and `settleReplacement` is
   called before anything is decided: a rotation that already executed moves the store on here,
   and a `collision` — the owners name both filed keys, or neither — is a warning, not a refusal.
   Ownership is the whole test: a replaced row that is no longer in the file (removed by a build
   that allowed it, or hand-edited out) is no old key at all, so the chase settles the moment the
   newcomer is an owner and reports the collision before that — the marker has no other way to
   clear. The old key is the row filed for this Safe whose stored key derives to one of its
   owners, preferring the active row; when the active row is not one of them, the row that is wins
   and the output names `s2s author switch <name>` (see below). No row for the Safe is a usage
   error naming `s2s signer add <safe>`; a row whose key is not an owner is `not_owner`.
2. **Take the new key and file it inactive.** It comes from `resolveKeySource`, the same resolver
   `author new` and `signer add` use: `--key`, `--mnemonic`, a line on stdin, else a generated BIP39
   phrase printed **once**, in both output modes. The row is filed with
   `addSigner({name, privateKey, safe, replaces: oldName})`, which never moves the active slot: a
   rotation is not a `author switch` and does not re-point every other command at another key. The
   default name is `<oldName>-next`; `--name` overrides; a taken name is the store's usage error.
3. **Propose the swap.** `prevOwner` comes from `predecessorOf(owners, oldEoa)` — the owner before
   the old key in the Safe's linked list, the sentinel when it is first — and never from the user:
   the list has no reverse lookup, and a wrong predecessor is a `GS005` revert that names nothing.
   The call is `to: safe`, zero gas fields, the Safe's nonce, `sender` the **new** EOA, the
   service's `0x` placeholder signature. The service is told about the Safe when it 404s
   (`register`), then given the proposal.

Refusals, all before anything is filed:

| state | outcome |
|---|---|
| no row filed for the Safe on this machine | usage error naming `s2s signer add <safe>` |
| the filed key is not an owner | `not_owner` |
| Safe has no bytecode | `safe_not_deployed` |
| the new key _is_ the old key | `same_key` |
| the new EOA is already an owner | `already_owner` — a swap brings in a key that is not on the list |
| a replacement is already pending | `replacement_pending`, naming the pending row — one chase at a time; the message sends the user to `signer confirm` (or `signer queue`), never to `author rm`, because that row is the only stored copy of the key its swap adds |
| name taken, key filed elsewhere, Safe filed elsewhere | usage error from `addSigner` |

The record a rotation files carries `replaces`: the pet name of the row it is meant to replace.

```json
{ "privateKey": "0x…", "safe": "0x…", "safeSource": "given", "replaces": "zomi" }
```

It is present only while the replacement is pending, and it is what tells `settleReplacement` which
row to retire. The row is inactive until the swap executes, so `authors.json`'s `active` still names
the old key — or whatever was active before, which is why `s2s author switch` is part of the flow
when the two differ.

**A rotation is two rows and neither is removable until the chain answers.** `author rm` refuses a
row that a pending replacement names and a row that carries `replaces` (`rotation_pending`), naming
`s2s signer rotate` to settle it: the old row may be the last stored copy of the key that owns the
Safe, and the pending row is the last copy of the key the swap adds. `author rm --force` drops
either anyway — the way out of a swap that can no longer execute — and warns that no stored key is
guaranteed to own that Safe afterwards.

**The key survives a failed proposal**, exactly as in `signer add`: the row is filed before the
service is touched, and a `register` or `propose` failure is reported as `proposed: false` with the
reason in `note` and the `{to, data}` pair to make by hand. Filing the new key costs the old one
nothing — the old key is an owner until the swap executes.

JSON:

```json
{ "action": "signer.rotate", "name": "zomi-next", "replaces": "zomi", "eoa": "0x…",
  "oldEoa": "0x…", "safe": "0x…", "threshold": 2, "owners": ["0x…"], "nonce": 7,
  "safeTxHash": "0x…", "proposed": true, "safeTx": { "to": "0x…", "data": "0x…" },
  "switchTo": "zomi", "note": "…", "mnemonic": "…", "privateKey": "0x…" }
```

In human output the command says three things plainly: the phrase, when this run made one, is
printed once and is the only copy; the **old** key confirms this proposal, so `s2s signer confirm
<safeTxHash>` runs with that key active — and when the store's active author is not that key (a
second Safe rotated while another author is selected), the output says so and names `s2s author
switch <oldName>` first, because `signer confirm` signs with the active key and nothing else; and
the old key stops being an owner only when the swap executes, not when the proposal is filed.
`switchTo` carries that name in the JSON, and is absent when the old key is already the active one.
`note`, `mnemonic` and `privateKey` follow the rules of `signer add`.

## `signer queue [<safe>]`

Unexecuted proposals, **oldest nonce first** — a Safe executes one nonce at a time, so the queue is
a sequence, not a set. The default Safe is the stored `given` Safe this config signs for
(`givenSafeInUse`), else the active record's recorded Safe; with neither, a usage error.

Per row: nonce, the full `safeTxHash` (the argument the next command takes), the decoded method and
its new-owner argument when the service returned `dataDecoded` (`addOwnerWithThreshold`,
`removeOwner` and `swapOwner` all name the parameter `owner`), confirmations as *k of n*, and
whether this machine's key is an owner that **has not** confirmed.

*k of n* counts the confirmations `execTransaction` can pack: 65-byte signatures only. A 32-byte
entry is a contract owner's `approveHash` approval, `confirm` drops it, and a row that counted it
would print `executable: true` for a transaction `confirm` refuses to send.

Owners and threshold come from the chain, because the service's copy of a Safe it was told about
once can be older than the Safe. The threshold is the `n` and the `executable` test; the service's
`confirmationsRequired` is only the fallback for a row whose Safe could not be read, so the two
commands answer one question one way. An unreadable RPC costs the owner columns, not the listing:
the rows still print, `keyIsOwner` is `null` (not `false`), and a warning carries the reason. With
no key on this machine `keyIsOwner` is also `null`, and the human column says `no key filed here`
rather than calling this machine an owner it is not.

A row whose nonce is behind the Safe's current nonce is still listed — the service has not dropped
it — and `confirm` refuses it as `stale_nonce` before signing.

A pending replacement row is **not** an owner: it is filed inactive and waits for its swap to
execute, so until then this machine's key for the Safe is the old row, and `keyIsOwner` answers for
that one.

Read-only: nothing is proposed, signed or spent.

JSON:

```json
{ "action": "signer.queue", "safe": "0x…", "eoa": "0x…", "threshold": 2,
  "owners": ["0x…"],
  "pending": [{ "nonce": 7, "safeTxHash": "0x…", "method": "addOwnerWithThreshold",
    "newOwner": "0x…", "to": "0x…", "data": "0x…", "confirmations": 1,
    "confirmationsRequired": 2, "executable": false, "keyIsOwner": true,
    "keyConfirmed": false }] }
```

`eoa` is `null` with no key; `method` and `newOwner` are absent when the service decoded nothing;
`confirmationsRequired` is the chain's threshold whenever the Safe could be read.

## `signer confirm <safeTxHash> [--safe <safe>] [--no-execute]`

Before anything is read from the service, the store is reconciled against the owners on chain:
`settleReplacement` is called here too, so a run that died after executing its swap still settles
on the next confirmation attempt instead of leaving the old key filed.

1. **Sign.** `signMessage` over the raw 32-byte `safeTxHash` — the eth_sign scheme, `v` 27/28.
   Signing a different digest produces a signature that recovers to another owner and the Safe
   answers `GS026`.
2. **Post.** The signature goes to the service as a confirmation.
3. **Re-read.** The confirmations are read back and this key's own signature is merged in, because
   the service may not have indexed it yet. A 32-byte entry is a contract owner's `approveHash`
   approval and cannot be packed, so only 65-byte confirmations count.
4. **Execute** when the signable confirmations meet the Safe's threshold **and** the proposal's
   nonce is still the Safe's: `packVerifiedSignatures` in ascending signer order, then
   `execTransactionArgs` with the chain id, then one plain transaction from the EOA. The packer
   recovers every signature against the digest and refuses one that recovers to nobody
   (`signature_not_owner`) or that is not a point on the curve (`signature_malformed`), so what
   gets executed is provably what the signers signed. The chain id is passed because the record's
   own hash check proves only that its fields reproduce *its* hash: with the id,
   `execTransactionArgs` re-hashes and refuses a record that is not the proposal this command was
   given (`safe_tx_hash_mismatch`), before anything is sent.

Refusals, all before anything is signed:

| state | outcome |
|---|---|
| key is not an owner of the Safe | `not_owner` |
| Safe has no bytecode | `safe_not_deployed` |
| proposal already executed | `already_executed` |
| proposal nonce below the Safe's | `stale_nonce` — it can never execute; propose it again |
| the hash-keyed read answers a different proposal | `safe_tx_wrong_transaction` — the record is not the hash that was passed, whatever its own fields say |
| owner entry is a contract (the EOA has code) | `contract_owner` — it confirms by calling `approveHash` from its own code |

A proposal with a nonce **ahead** of the Safe is not a refusal: its confirmation is posted and the
command reports why it did not execute (it is queued behind the transaction at the front). Same for
a confirmation that leaves the threshold unmet.

`--no-execute` stops after step 2, for a key that should not spend.

After a successful execution the owners are read again and `settleReplacement` runs a second time:
the new row becomes the active record, the old row disappears, and the outcome is printed as
`settled: <new name> is now the key for <safe>`. It is a note, never an error — a store write that
fails after the transaction landed is a warning, and the next `signer` run settles it.

JSON:

```json
{ "action": "signer.confirm", "safe": "0x…", "safeTxHash": "0x…", "eoa": "0x…",
  "nonce": 7, "confirmations": 2, "required": 2, "confirmed": true, "executed": true,
  "txHash": "0x…", "settled": "zomi-next", "note": "…" }
```

`txHash` is present only when `execTransaction` was sent; `settled` only when a pending replacement
was reconciled by this run; `note` only when `executed` is false, and carries why (queued behind the
front nonce, threshold short, `--no-execute`).

## Gas

Proposing and confirming are HTTP only and cost nothing. **Execution costs gas, paid by the EOA that
sends `execTransaction`**, and nothing is refunded to it: the proposals this CLI makes carry zero
gas fields, so the Safe does not repay the sender. A rotation follows the same rule — proposing the
swap is HTTP only, and executing it costs gas from whichever owner sends it, old key or not. The
help text and the human output say so; a failed send surfaces as an error after the confirmation is
already posted, because the confirmation is worth keeping.

## The transport

What the code relies on, checked against `@safe-global/api-kit` 3.0.2 and `@safe-global/types-kit`
3.1.0 in this build:

- The Safe-scoped collection is **list-only**: `GET /api/v1/safes/{safe}/multisig-transactions/`,
  which is where `queue` reads. A single transaction and its confirmations are keyed by hash alone:
  `GET /api/v1/multisig-transactions/{hash}/` and `POST /api/v1/multisig-transactions/{hash}/confirmations/`.
  The only Safe-scoped write is the proposal, `POST /api/v1/safes/{safe}/multisig-transactions/`.
- A record carries the Safe it belongs to. On a hash-keyed read that field is required, and a
  disagreement with the Safe the caller named is `safe_tx_safe_mismatch` — never relabelled to the
  caller's address, which would execute another Safe's transaction.
- A record carries its own `safeTxHash`, and the fields are re-hashed before execution: a
  disagreement is `safe_tx_hash_mismatch`. That check is what makes the five gas fields safe to
  carry — an omitted or misread `safeTxGas`, `baseGas`, `gasPrice`, `gasToken` or `refundReceiver`
  changes the digest and the Safe would answer `GS026` with no field named. On a hash-keyed read the
  record that comes back must also be the hash the route names: a self-consistent record for a
  different proposal is `safe_tx_wrong_transaction`, refused before it can be signed or
  confirmed.
- A proposal is posted with the transaction's own gas fields, the ones its
  `contractTransactionHash` was computed from. The CLI proposes zeros; a body of zeros under a hash
  computed from other values would be a proposal its own fields do not produce.
- The hash is EIP-712 over the `SafeTx` struct with domain `{chainId, verifyingContract}` — the
  domain shape from Safe v1.3.0 on. The singleton is not in the domain in any version.

## Guesses and open items

Recorded as guesses, not contracts — each one is a place a live service may disagree:

1. **Registration payload.** `POST /api/v1/safes/` with `{address, owners, threshold, singleton,
   fallbackHandler, implementationVersion, delegate}`, plus `modules` only when the caller states
   one — the field is omitted rather than sent empty, because `[]` would assert that an ERC-4337
   Safe has no module. The field names are the service's
   own and are taken from its documented shape, not from a request this build made.
2. **API-key header.** `Authorization: Bearer <safeTx.key>`. The public host answers unauthenticated
   requests at a rate a busy queue will hit; a Safe account's key is the remedy if the header is the
   one the service reads.
3. **The chain id.** `8453`. The hash is EIP-712 over `{chainId, verifyingContract}`, so a service
   indexing another chain rejects the proposal as a mismatch. `SAFE_TX_CHAIN_ID` in the adapter is
   the one place it is written; `signer-store` imports it as `SIGNER_CHAIN_ID` for the commands.
4. **`dataDecoded` parameter names.** Read as `owner` for the OwnerManager methods; a service that
   decodes differently loses the new-owner column, not the row.
5. **The queue filter.** `?executed=false&ordering=nonce`, with a local sort on nonce so the order
   does not depend on the service honouring the parameter.

## Tests

`test/signer-add.test.ts`, `test/signer-rotate.test.ts`, `test/signer-queue.test.ts`,
`test/signer-confirm.test.ts`. Every chain
read and every service call is injected through `SignerDeps`; no test opens a socket. The signature
is checked by `verifyMessage` recovery against the raw hash, and the packed list is decoded back out
of the `execTransaction` calldata. The rotation's calldata is decoded back to the three addresses
`swapOwner` takes, in order, and the store is checked on disk: the new row inactive, the old row
untouched until the swap executes. The confirm fixtures compute the hash from the record's own
fields, so the chain-id re-hash in step 4 is a live check; one fixture breaks that tie deliberately
and is refused before a send.
