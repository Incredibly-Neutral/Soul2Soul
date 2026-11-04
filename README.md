# Soul2Soul

Soul2Soul is a prototype of **Polyphony**, a protocol for independent authors and collective publications. It is early alpha, built by Incredibly Neutral; work on it began in early 2025.

Publishing has always had three parties: the author, the publication, and the press that turns a manuscript into something readers can see. The parties were never equal. The publication held the relationship with the press, and much of its power over the author came from that. Polyphony moves the press into a neutral position between the two.

Its press is open code running on sealed hardware that not even its owners can see into. It decrypts a manuscript, renders the page and signs it with its own key. It does this only while an agreement covers that manuscript, so neither the author nor the publication can produce a valid page alone. The rest follows from that:

- Anyone can start a publication with little effort, alone or with others.
- An author can end an agreement alone, at once, on a public ledger, and request a rebuild of the pages without the work.
- Every page carries proof of who wrote it, that both sides consented, and that it hasn't changed.
- Authors keep their work when they leave. A publication keeps its authors only while they choose to stay.

What remains is trust in that hardware, and in its owners not to collude. Beyond that, the design assumes the worst of whoever runs a publication and whoever hosts its pages, and is built to hold against both. It is not built to hold against a state-level adversary.

Read more:

- `polyphony.eth.link` — the white paper: what an implementation must guarantee.
- `about.soul2soul.eth.link` — this implementation: the choices made, the trade-offs accepted, where it falls short.


## Building and deploying the lit actions

```bash
# one action, end to end
pnpm actions:build                        # bundle every action
LIT_DRY_RUN=1 pnpm actions:swap <action>    # print the Safe batch; pin nothing, propose nothing
pnpm actions:swap <action>                   # pin + propose the batch to safe. sign and execute action there
pnpm update-protocol                      # record the new CIDs
pnpm deploy-action <action>                 # the three above in one go

# the group itself
pnpm deploy-group                         # provision a fresh group, writes config.json
pnpm deploy-group -- --finalize <txHash>  # finalize it from the receipt
pnpm inspect-group                        # read the group's state back off the chain
pnpm refresh-key                          # rotate the Lit usage key
pnpm actions:add-dev                      # pin + record the dev action only
pnpm actions:remove <hash>                # unbind a stale hash (--full also drops it from the account)
```
