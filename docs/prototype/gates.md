---
post_type: chapter
position: 6
slug: gates
tags:
  - about--s2s
modified_date: 2026-11-05T12:04:06
genesis: "0x8a3e99ef8fb52ca9582e32012732104cabc8eeaf11c5db8eb13b9c15df9ad52c"
author: "0x7907cB38776936B90002057d7feF3a9662ED9A55"
cid: QmSXx4YzG2ZQWKk3WRckVKBAJQ9duRHZsdyNQeBcP1v9U4
creation_date: 2026-11-02T10:14:38
---
# The gates

In the white paper, a manuscript is encrypted to the press's key, and gates decide who can decrypt it and when. A gate is a condition fixed in advance: what it reads from the ledger can change, the gate itself cannot. The author can always decrypt their own manuscript, reviewers can while it is offered, the renderer only under an agreement in force, and a reader only when the agreed check passes. [White paper, section 6: Gates](https://polyphony.eth.link/gates)

A gate in Soul2Soul is a function that asks the L2 a fixed set of questions and combines the answers. The gates sit in one small module, written to run in the press, a browser or a command line alike: it never holds a key and never writes, so the same rules answer wherever they are asked. The answers change as authors and owners act on the ledger; the gates don't. Only the implementation's governance can change them, by a transaction on the L2 that names new actions for the press's key. That rests on Lit refusing the key to any action the protocol's Safe hasn't registered.

There are three:

- `canPublish`: may this account write to the publication? The publication admits the account (the publication's own Safe, or the Safe of a listed author or developer), and the signer owns it. Update asks it of a page it adds; a page already at its path is refreshed without it.
- `canRead`: may the press decrypt this manuscript? The publication admits the account, the signer owned the author's Safe when the manuscript was last written, and an agreement covers the genesis id. Ownership is judged at the block that version was appended in, read from the author's drafts log, so an owner the Safe has rotated out still reads what they wrote and an owner added afterwards does not read what they did not. Every decryption asks it, and the genesis id comes from the ledger, never from the ciphertext. A Safe whose drafts log cannot be resolved is refused, not judged by its current owners. A Safe with no owner-history module is refused at a recorded block and judged live where the log records none.
- `canReset`: may this signer reset the publication's site? Only if the signer owns the publication's Safe; stricter than a publish, because a reset rewrites the whole site.

The ownership question is its own function, `canAuthor`. `canRead` asks it as its second half; the press asks it alone when an author opens one of their own drafts, because a draft was never offered to a publication and no agreement is involved.

Each reads the L2 when it runs, with no cache, so an agreement's end counts from the block that records it; if the L2 can't be read, the build fails.

## Roadmap

- **The author's own manuscript.** The press decrypts a manuscript for its recorded author, whether or not the publication admits them or an agreement is in force.
- **A reviewers' gate.** The press decrypts a manuscript offered to a publication for the reviewers on its reviewer list, until the publication declines it or the author withdraws it.
- **A reader gate.** When an agreement includes monetization, a gate releases the manuscript's text to a reader only once the agreed check, such as a payment, passes on the ledger.

