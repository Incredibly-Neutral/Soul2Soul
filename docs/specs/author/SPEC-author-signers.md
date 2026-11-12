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
s2s signer rotate   [<safe>] [--name <pet-name>] [--key <0x…> | --mnemonic <words>] [--json]
s2s signer queue    [<safe>] [--json]
s2s signer confirm  <safeTxHash> [--safe <safe>] [--no-execute] [--json]
```

`rotate` takes the Safe from the store when no argument names one (below); every other position is
required.

## `signer add <safe>`

1. The key comes from `resolveKeySource` — the same resolver `author new` uses: `--key`,
   `--mnemonic`, a line on stdin, else a generated BIP39 phrase printed **once**, with its
   mnemonic, in both output modes.
2. The Safe is read from the chain: bytecode, owners, threshold, nonce. No bytecode is
   `safe_not_deployed`, the same coded refusal `signer confirm` gives: the address is not misspelt,
   there is simply no Safe there. This command proposes an owner of a Safe that is already deployed,
   and it never deploys one.
3. An EOA that is already an owner is a usage error, and nothing is filed.
4. The key is filed with `addSigner({name, privateKey, safe, activate: false})`, which marks the
   record `safeSource: 'given'` and leaves it **inactive**: until an owner posts the proposal and
   the Safe executes it, the joining key is not an owner, and an active slot pointing at it would
   make every later `signer confirm` sign with a key the chain rejects. The active row is whatever
   it was, or `null` when the store was empty, and the result says so with `activated: false`. The
   row is also marked `unconfirmed: true`: nothing else records that the chain has never accepted
   this key, and `author list` would otherwise print a joining key as an owner of a Safe that does
   not list it. The mark clears itself the first time a chain read shows the key on the owner list:
   `settleReplacement` sweeps these rows on `rotate` and `confirm`, and `signer queue` sweeps them
   on the owner list it reads for its own columns. It is never removed by hand, and it never
   outlives the fact it records. The default name is
   `signer-<first 6 hex of the new EOA>`; a taken name, a key filed under another author, or a Safe
   already filed under another author is a usage error from `addSigner`, thrown before the store is
   written.
5. The proposal is `addOwnerWithThreshold(newEoa, threshold)` where the threshold is the Safe's
   **current** one, read from the chain and never raised: one more owner must not change how many
   signatures a transaction needs. The nonce is the Safe's, and the proposal is signed by an owner
   key this machine already signs with (the config/env key on the owner list), never by the key
   being added — the service files a proposal's signature as its sender's confirmation and refuses
   a sender that is not an owner. A machine with no such key posts nothing and reports the call —
   its `{to, data}`, its nonce, and the fact that an owner has to post it from their own machine:
   nothing in this build queues or retries it.
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
  "safeTx": { "to": "0x…", "data": "0x…" }, "file": "…/authors.json", "activated": false,
  "note": "…", "mnemonic": "…", "privateKey": "0x…" }
```

`note` is present only on failure; `mnemonic` whenever a phrase was resolved or made;
`privateKey` only when the run generated one, as `author new` does. `activated` is always `false`:
the field exists so a caller can tell "filed" from "in use", and it never becomes `true` here. The
row on disk carries `unconfirmed: true` until a chain read shows the key on the owner list:

```json
{ "privateKey": "0x…", "safe": "0x…", "safeSource": "given", "unconfirmed": true }
```

`author list` reports such a row as `ownership: "unconfirmed"`, prints it `(filed, not an owner
yet)`, and closes with the one line that says how it becomes an owner. `ownershipOf` is the only
reader of the mark, so no command has to remember it.

## `signer rotate [<safe>]`

Replace this machine's key on the Safe with a fresh one, in **one** Safe transaction:
`swapOwner(prevOwner, oldOwner, newOwner)`. The threshold is not a parameter of that call and does
not move — a rotation is a swap, not a remove followed by an add, so the owner count and the bar
for a signature stay as they are.

**The argument is optional.** This machine files its own Safe when it signs, so naming that address
again on the command line would be a third copy of one fact. With no argument the target is the
active row's `safe` when that row's key is on the Safe's owner list; failing that, the Safe a pending
replacement row is filed for (which is where a retry lands); failing that, a usage error naming
`<safe>`. An active row whose Safe has no bytecode is `safe_not_deployed`, naming that Safe and the
row that selected it — the address is chosen for the user here, so "does not own" would be a false
accusation. The positional stays as the override for a machine holding rows for several Safes, and
`--help` says so. More than one positional is a usage error: `rotate` swaps one key on one Safe.

1. **Settle, then find the old key.** The Safe's owners are read first, and `settleReplacement` is
   called before anything is decided: a rotation that already executed moves the store on here,
   and a `collision` — the owners name both filed keys, or neither — is a warning, not a refusal.
   Ownership is the whole test: a replaced row that is no longer in the file (removed by a build
   that allowed it, or hand-edited out) is no old key at all, so the chase settles the moment the
   newcomer is an owner and reports the collision before that — the marker has no other way to
   clear.

   **The old key is a row name, always**, and it is resolved in one order:

   - **A row that owns the Safe.** The row for this Safe whose key the chain lists as an owner — the
     active row first, then any other row filed for this Safe. This is the ordinary case, and it
     writes nothing. It is also why an effective key that happens to own the same Safe changes
     nothing about *which* key is retired: `rotate` replaces what the store says this machine holds
     on that Safe. That second key signs the swap (step 3) and is reported as `signedBy` /
     `signedBySource`, unless no row names it at all, in which case it is the key being retired.
   - **No owning row, but the effective key owns the Safe.** The effective key (`S2S_PRIVATE_KEY` >
     project config) is filed for this Safe, under `signer-<first 6 hex>`, and the row just filed is
     the old key. The result reports `oldKeySource` and `filedOldRow`, and the human line names where
     the key came from. Filing is what makes `replaces` defined on every path: a swap is recorded
     against a row, so an owner key that lives only in the environment gets one before the swap is
     built.
   - **Otherwise, refusal.**

   A row for this Safe whose key is **not** an owner is a stale row: the chain does not list it, so
   there is no owner in it to swap out and no swap is ever filed against it. It is `not_owner`,
   named with its EOA, saying the chain does not list it and that `s2s signer queue` shows what the
   Safe actually holds. Because this store keeps one key per Safe, a stale row also holds the slot
   rule 2 would use, so rule 2 cannot fire past one; the message says so, and `s2s author rm
   '<name>'` frees the slot once the key is no longer wanted.

   No row and no owner key on this machine is a usage error naming `s2s signer add <safe>`. Rows
   whose keys this build cannot derive are `not_owner` and are named (`'broken' (unreadable)`),
   never reported as "no key filed". A key that owns this Safe and is filed under another Safe's
   row cannot be given a row here — one key, one row — and that is `not_owner` naming the row it
   lives in, with the fix being to run rotate where that key is not filed.
2. **Take the new key and file it inactive** — or finish the key a failed run already filed (see
   below). Everything from here to the write-back runs under the store lock (below), so two rotates
   cannot both pass the name check and leave one key unrecorded. A fresh key comes from `resolveKeySource`, the same resolver `author new` and `signer add`
   use: `--key`, `--mnemonic`, a line on stdin, else a generated BIP39 phrase printed **once**, in
   both output modes. The row is filed with `addSigner({name, privateKey, safe, replaces:
   oldName})`, which never moves the active slot: a rotation is not a `author switch` and does not
   re-point every other command at another key. The default name is `<oldName>-next`; `--name`
   overrides; a taken name is the store's usage error.
3. **Propose the swap.** `prevOwner` comes from `predecessorOf(owners, oldEoa)` — the owner before
   the old key in the Safe's linked list, the sentinel when it is first — and never from the user:
   the list has no reverse lookup, and a wrong predecessor is a `GS005` revert that names nothing.
   The call is `to: safe`, zero gas fields, the Safe's nonce. It is posted by an **owner** and
   signed by that owner: the service files a proposal's signature as its sender's confirmation and
   refuses a sender that is not an owner, and the new key is on the owner list only after this
   transaction executes. Normally that is the old key, whether or not it is the active one. When the
   effective key is itself an owner of this Safe, *it* signs instead — it is the key every later
   command on this machine signs with, and a refusal here would leave a machine unable to rotate at
   all. The output then prints `signs it` with that key and its layer, and the JSON carries
   `signedBy` / `signedBySource`, so which key is being retired is never left to inference. The
   service is told about the Safe when it 404s (`register`), then given the proposal, and the hash it
   answers with is written back to the row with `setPendingProposal`. A proposal is only posted once the service has been asked what it already
   holds at that nonce (see the retry paragraph): the store alone cannot tell a swap that never
   left this machine from one whose reply was lost.

Refusals, all before anything is filed. Both rows of a run — the old key's, when rule 2 has to file
it, and the new key's — are built in memory first and written in a single `writeAuthors`, so a
refusal at any point leaves the store byte-identical, including when `--name` is already taken:

| state | outcome |
|---|---|
| no row filed for the Safe on this machine | usage error naming `s2s signer add <safe>` |
| a row for the Safe holds a key the chain does not list as an owner | `not_owner`, naming the row and its EOA — a stale row is not an owner to swap out, no swap is filed against it, and it holds the Safe's slot; the message points at `s2s signer queue` for what the Safe actually holds, and offers `s2s author rm` only for a stale row that carries no `replaces`: a row carrying one holds the only stored copy of the key its swap installs, `author rm` refuses it, and `--force` destroys that key, so that row is finished by the swap instead |
| no row for the Safe holds an owner, the effective key owns it, and that key is filed under another Safe's row | `not_owner`, naming that row — one key cannot be filed twice, so rotate has to run where the key is not filed |
| Safe has no bytecode | `safe_not_deployed` |
| the new key _is_ the old key | `same_key` |
| the new EOA is already an owner | `already_owner` — a swap brings in a key that is not on the list |
| a replacement is already **queued** | `replacement_pending`, naming the pending row and its hash, and sending the user to `s2s signer confirm <hash>` — which executes it — never to a command that drops the row: the row holds the only stored copy of the key its swap adds. A pending row with **no** `proposal` is not refused; it is finished (below) |
| a retry is given `--key`, `--mnemonic` or a different `--name` | usage error — the filed row's key is the only copy of what that swap adds, so a retry keeps it |
| more than one positional | usage error — one Safe at a time |
| another process holds the store lock | `store_locked`, naming the lock file and the pid that holds it |
| the service holds a **different** transaction at the Safe's nonce | `nonce_taken`, naming that hash and `s2s signer queue` — the swap cannot queue behind it, and adopting it would execute something else |
| name taken, key filed elsewhere, Safe filed elsewhere | usage error from `addSigner` |

**A failed proposal is finished, not re-filed.** A row with `replaces` set and no `proposal` means the
key was filed and the swap never reached the service: the phrase was printed once and that row is
the only copy of it. A run against that Safe reuses the row — same name, same EOA, same key — calls
`propose` again with the old key's signature, and on success writes the returned hash with
`setPendingProposal`. It generates no key, prints no phrase, and says `reusing the key filed by the
failed run`. This is why `--key`, `--mnemonic` and a different `--name` are refused there: accepting
them would abandon the one copy of a key that may already be the Safe's next owner.

**"Never queued" is checked against the service, not believed from the store.** Before reusing the
row, `rotate` calls `service.pending(safe)` and compares the queued records with the
call it would post — nonce, `to`, `operation`, `data`, `value`. The same call means the earlier
run's POST landed and only its reply was lost: the row adopts that `safeTxHash` (printed,
`alreadyQueued: true`, `proposed: true`) and nothing is posted again. A different call at that nonce
is `nonce_taken`, and the run refuses rather than posting a swap the Safe will reject or that
executes in the wrong order. Nothing at that nonce, or a service that cannot be read, means the POST
goes out; a read failure is a warning, because the store's row is still the right thing to propose.
The queue is paged, so "nothing at that nonce" is only concluded from a walk that says it finished:
`pending` returns `{records, complete}`. The walk reads up to five pages of 100 and stops early at
nothing — completeness cannot rest on `ordering=nonce`, which the same read does not verify. The
absence of `next` is not the end of the queue either: a last page that is exactly full (100 records)
or that arrives short of the `count` the service declared is `complete: false`, because a truncated
page and a real last page end the walk the same way. An unfinished walk is neither "not queued" nor a
refusal — `proposed` is `false`, `note` says the service did not answer with a whole queue, and it
points at `s2s signer queue`, because a second proposal at a used nonce is refused and a swap queued
twice is worse than one queued late.

A run whose proposal failed says what failed. Only a note that names ownership is reported as the
service refusing a sender that is not an owner; a socket or route error is reported as that error,
with the sentence that the call can be posted by hand from any owner of the Safe. The sender cannot
be a non-owner here — `rotate` acquires its signing key from the row whose key the chain lists — so
asserting it would send the user to a fix that does not exist.

The record a rotation files carries `replaces`: the pet name of the row it is meant to replace.
It is present on every path, because the old key is always a row — either one the store already
held or one this run filed for the effective key.

```json
{ "privateKey": "0x…", "safe": "0x…", "safeSource": "given", "replaces": "zomi" }
```

`proposal` sits beside it once the swap is queued, and is absent until then:

```json
{ "privateKey": "0x…", "safe": "0x…", "safeSource": "given", "replaces": "zomi",
  "proposal": "0x…" }
```

`replaces` is present only while the replacement is pending, and it is what tells `settleReplacement`
which row to retire. `proposal` is the hash the swap was queued under; absent means the run never
queued it, and ownership — not the hash — decides whether the swap landed. Both are dropped together
when the swap settles. The row is inactive until the swap executes, so `authors.json`'s `active` still names
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
nothing — the old key is an owner until the swap executes. That failure is also what leaves the
retryable row: the next run against the Safe finishes it with the key already filed.

JSON:

```json
{ "action": "signer.rotate", "name": "zomi-next", "replaces": "zomi", "eoa": "0x…",
  "oldEoa": "0x…", "safe": "0x…", "threshold": 2, "owners": ["0x…"], "nonce": 7,
  "safeTxHash": "0x…", "proposed": true, "safeTx": { "to": "0x…", "data": "0x…" },
  "oldKeySource": "env|project|store|user", "filedOldRow": "signer-7e5f45",
  "signedBy": "0x…", "signedBySource": "env|project|store|user",
  "reused": true, "alreadyQueued": true, "switchTo": "zomi", "confirmFix": "…",
  "note": "…", "mnemonic": "…", "privateKey": "0x…" }
```

In human output the command says what the proposal now is: the phrase, when this run made one, is
printed once and is the only copy; the **old** key signed the proposal, so its signature is already
in it — at threshold 1 the swap is executable as soon as the service holds it, so `s2s signer
confirm <safeTxHash>` sends it without adding a signature and there is nothing left for another
machine to sign; above 1 the remaining owners confirm. And the old key stops being an owner only
when the swap executes, not when the proposal is filed. A retry says `reusing the key filed by the
failed run` instead of printing a phrase; an adopted hash says `already queued`; a key filed for an
environment-only owner says `filed first : the owner key from S2S_PRIVATE_KEY as '<row>'`.

**The advice for `confirm` names the layer that supplies its key.** `confirm` signs with the
effective key, and the store's active row is only one of four possible sources. When the old key is
not the active row *and* the active row is what supplies the key, the output names `s2s author switch
<oldName>` first. When the effective key comes from `S2S_PRIVATE_KEY`, from the project config file
or from a user config file, switching authors changes nothing — the output says which layer holds
the key and how to remove it (`unset it`, `s2s config unset privateKey --local`, `s2s config unset
privateKey`). `switchTo` carries the name only in the first case, and `confirmFix` only in the
others; both are absent when the effective key is itself an owner of the Safe, because then `confirm`
signs with it and the Safe accepts the signature — the advice closes a gap that does not exist. `reused` is present only
on a retry, `alreadyQueued` only when the hash came from the service, `filedOldRow` only when this
run filed the old key. `note`, `mnemonic` and `privateKey` follow the rules of `signer add`.

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

Nothing is proposed, signed or spent. The one write is the store: a row `signer add` filed
`unconfirmed` is marked confirmed here when the owner list this command already read contains its
key, so the mark never outlives the fact it records, whatever command noticed it first.

JSON:

```json
{ "action": "signer.queue", "safe": "0x…", "eoa": "0x…", "threshold": 2,
  "owners": ["0x…"],
  "pending": [{ "nonce": 7, "safeTxHash": "0x…", "method": "addOwnerWithThreshold",
    "newOwner": "0x…", "to": "0x…", "data": "0x…", "confirmations": 1,
    "confirmationsRequired": 2, "executable": false, "keyIsOwner": true,
    "keyConfirmed": false }], "complete": true }
```

`eoa` is `null` with no key; `method` and `newOwner` are absent when the service decoded nothing;
`confirmationsRequired` is the chain's threshold whenever the Safe could be read. `complete` is
`false` when the walk stopped at its page cap: `pending` is then the first pages of the queue, not
the queue, and a reader that ignored the flag would take a truncated list for an exhaustive one. The
same fact is said in the human block (`unread      : …`) and as a warning, in both output modes,
because a short list that looks whole is how an owner misses the transaction they were waiting for.

## `signer confirm <safeTxHash> [--safe <safe>] [--no-execute]`

Before anything is read from the service, the store is reconciled against the owners on chain:
`settleReplacement` is called here too, so a run that died after executing its swap still settles
on the next confirmation attempt instead of leaving the old key filed.

1. **Read, then sign if it is needed.** The record is fetched first and its confirmations are
   checked for one that **recovers to this key** over the digest. Recovery is the test, not the
   `owner` label and not a string compare: a signature over the wrong digest recovers to some other
   valid address rather than failing, so only "it recovers to *this* owner" is evidence that this key
   already signed. Both schemes count — a bare signature over the digest (`sign({hash})`, `v` 27/28,
   which is what `signer rotate` and `signer add` attach to their proposals) and an `eth_sign`
   signature (`signMessage` over the raw 32 bytes, `v` 31/32) — and each is tried against both the
   record's hash and `hashMessage` of it. On a hit nothing is signed and nothing is posted: the swap
   was proposed *by* this key, so this key's signature is already the quorum it was going to add.
2. **Post, unless the record already carries it.** The signature goes to the service as a
   confirmation, which files it as the sender's. When step 1 found it already there, the POST is
   skipped and the result says `posted: false`; at threshold 1 that is the difference between a run
   that executes the swap and one that posts a signature to a transaction it could have sent.
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
| the record already carries this key's signature | not a refusal: the POST is skipped and the run goes straight to execute (`posted: false`) |
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
  "nonce": 7, "confirmations": 2, "required": 2, "confirmed": true, "posted": false,
  "executed": true, "txHash": "0x…", "settled": "zomi-next", "note": "…" }
```

`posted` is `false` when the confirmation was already on the record and no POST was made; `txHash` is
present only when `execTransaction` was sent; `settled` only when a pending replacement
was reconciled by this run; `note` only when `executed` is false, and it always leads with what the
run did to the service before saying why nothing was executed — four cases, four sentences:

| `posted` | `executed` | note |
|---|---|---|
| `true` | `false` | `confirmation posted; not executed (--no-execute)`, or `… not executed — the Safe is at nonce N …`, or `… not executed — K more confirmations needed` |
| `false` | `false` | `already signed by this key, nothing posted; not executed …` with the same three tails |

"confirmed, not executed" claimed a confirmation on a run that posted nothing, which is why the
first clause names the POST rather than the outcome.

## The store lock

`authors.json` is read-modify-written by every command that files a key, and `rotate` does it twice
in one run (the old row when an environment key has to be filed, then the new one). Two rotates
started at once would both read the same file, both pass the duplicate-name check, and the second
write would drop the first key: a printed phrase with no row behind it. So the writes hold an
exclusive lock.

The lock is a file beside the store, `<authors.json>.lock`, created with `wx` and mode `0600`,
holding the writer's pid, and removed in a `finally` — on success, on a refusal, and on a throw. On
`EEXIST` the pid is read and `process.kill(pid, 0)` asked: `ESRCH` (no such process) means the
writer is gone, so the file is a leftover rather than a claim. A running pid — or `EPERM`, which
means it exists — is `store_locked` naming the path and the pid.

**A leftover is claimed by moving it, never by deleting it.** Read-then-unlink is two steps, and
between them a second command can release the leftover and create its own lock, which the first
would then delete: two writers, one lock. So the takeover renames `<store>.lock` to
`<store>.lock.<pid>.<n>` and then reads what it moved. `rename` moves exactly one file: two commands
that both saw the same dead pid both try, one succeeds and the other gets `ENOENT` and goes back to
`open`, which is right whether or not the winner has finished. If the file that arrived is not the
dead pid that was judged (the leftover was released and replaced in the window between the read and
the rename), it is put back with `link`, which fails rather than overwrite a lock created in the
meantime, and the run refuses `store_locked` naming both paths. What that buys: the lock file is
never deleted on a stale read. What it does not buy: there is still a window between the pid check
and the rename, and a command that takes the lock inside it has its file moved aside for a moment;
the refusal names the private path so nothing is lost, but nothing stops another command from
creating a new lock while this one is refusing.

A lock that exists and names no pid is read again for about a quarter of a second (ten reads, 25 ms
apart). The window it covers is real: a holder creates the file with `wx` and writes its pid in the
next statement, so a reader can catch it empty and a live writer's lock must not be treated as a
claim to the file. A lock still empty after the wait is `store_locked` as a holder, never as a
leftover, and an empty file is never removed.

A lock that cannot be read at all is its own case: `EACCES`, `EISDIR` or `EIO` is not a writer
mid-write and not a leftover, it is a file whose permissions or type are wrong, and deleting it
would be a guess. It is `store_locked` naming the lock path and the errno, because the remedy is
that file and not the other process. Age is never the test. Within one process the lock is
re-entrant (the module counts holders), so a command can file two rows without deadlocking against
itself, and `signer add` / `signer confirm` / `author` writes take it by the same seam. `rotate`
passes the same `onStaleLock` handler to both store transactions it makes — the settle and the
decide-and-file — because either may be the first to meet a leftover, and `signer confirm` passes
one to both of its reconciles (before signing, and after executing) for the same reason: a cleared
lock is always reported.

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

- The Safe-scoped collection is **list-only** and **paged**: `GET
  /api/v1/safes/{safe}/multisig-transactions/?executed=false&ordering=nonce&limit=100`, following
  `next` up to five pages — which is where `queue` and `rotate` read. A `next` link is absolute, and
  only its path and query are used: every request goes to the configured base. A single transaction and its confirmations are keyed by hash alone:
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
untouched until the swap executes. A run with no `<safe>` is checked to take the active row's Safe,
and to refuse naming `<safe>` when nothing this machine holds owns one. A pending row with no
`proposal` is checked to be reused — same EOA, one key in the store, no phrase printed, the posted
signature recovering to the old key — and a row with a `proposal` to refuse `replacement_pending`
naming `signer confirm`. A failed proposal is checked to leave the `{to, data}` in the result and no
hash in the row, so the next run finishes it. The confirm fixtures compute the hash from the
record's own fields, so the chain-id re-hash in step 4 is a live check; one fixture breaks that tie
deliberately and is refused before a send.
