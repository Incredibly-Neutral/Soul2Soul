---
post_type: chapter
position: 6
slug: gates
tags:
  - about--s2s
modified_date: 2026-11-02T10:14:38
kubo_cid: QmPfxs9dED8M7gt8X8zsxwTfNce2Ppxfkhz7RGzEvG9VgL
genesis: "0x8a3e99ef8fb52ca9582e32012732104cabc8eeaf11c5db8eb13b9c15df9ad52c"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The gates

In the white paper, a manuscript is encrypted to the press's key, and gates decide who can decrypt it and when. A gate is a condition fixed in advance: what it reads from the ledger can change, the gate itself cannot. The author can always decrypt their own manuscript, reviewers can while it is offered, the renderer only under an agreement in force, and a reader only when the agreed check passes. [White paper, section 6: Gates](https://polyphony.eth.link/gates)

A gate in Soul2Soul is a function that asks the L2 a fixed set of questions and combines the answers. The gates sit in one small module, written to run in the press, a browser or a command line alike: it never holds a key and never writes, so the same rules answer wherever they are asked. The answers change as authors and owners act on the ledger; the gates don't. Only the implementation's governance can change them, by a transaction on the L2 that names new actions for the press's key. That rests on Lit refusing the key to any action the protocol's Safe hasn't registered.

There are three:

- `canPublish`: may this account write to the publication? The publication admits the account (the publication's own Safe, or the Safe of a listed author or developer), and the signer owns it. Every build except a reset asks it.
- `canRead`: may the press decrypt this manuscript? The two questions of `canPublish`, and an agreement for the manuscript's genesis id. Every decryption asks it, and the genesis id comes from the ledger, never from the ciphertext.
- `canReset`: may this signer reset the publication's site? Only if the signer owns the publication's Safe; stricter than a publish, because a reset rewrites the whole site.

Each reads the L2 when it runs, with no cache, so an agreement's end counts from the block that records it; if the L2 can't be read, the build fails.

## Roadmap

- **The author's own manuscript.** The press decrypts a manuscript for its recorded author, whether or not the publication admits them or an agreement is in force.
- **A reviewers' gate.** The press decrypts a manuscript offered to a publication for the reviewers on its reviewer list, until the publication declines it or the author withdraws it.
- **A reader gate.** When an agreement includes monetization, a gate releases the manuscript's text to a reader only once the agreed check, such as a payment, passes on the ledger.

