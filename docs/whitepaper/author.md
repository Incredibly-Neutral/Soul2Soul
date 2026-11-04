---
slug: author
post_type: chapter
position: 2
tags:
  - polyphony--s2s
modified_date: 2026-11-03T12:50:22
kubo_cid: QmaQchSNXtasyoBAkc6KcVpZyqRrnQ9BaeBymyXzNyqgRg
genesis: "0x4a0ef0df8d9aba4e036e9d7eec105ed0e6e40511f32d94da56341812442cceb5"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The author
Writing is local, and publishing is a separate, deliberate act. An author writes and revises on their own machine, and nothing in the protocol has to be reachable for that. The protocol defines an interface, not an application, so no single program stands between an author and their manuscripts: any number of writing tools can publish through it, and ideally the same tool works with more than one implementation.

To publish, the author signs the manuscript and encrypts it, not to any person or company, but to the press's key. After that, only the author can decrypt it at any time; the reviewers of a publication it has been offered to can decrypt it while they consider it; and the renderer can decrypt it while an agreement with that publication exists. A few details stay public, such as its tags, so that a publication can sort what it has been offered, and organise its pages by topic, before anything is decrypted. Anyone can read them, and so anyone can see that an author offered a manuscript to a publication.

The encrypted manuscript goes to distributed storage, and the author's own copy stays with them. Keeping the stored copy available is the author's responsibility, on their own storage or through a service of their choice. A revision is a new signed version of the same manuscript, and every version is recorded. Sharing a manuscript is an offer, not a transfer, and the author can make the same offer to anyone else.

The author can end an agreement at any time, alone, and the ending takes effect at once. It is one entry on the ledger. From that moment the renderer can no longer decrypt the manuscript for that publication, and the author can trigger the rebuild themselves instead of waiting for the publication to do it. The publication cannot keep showing the old site under its name, because only the protocol can change what that name points to, and it points it at the rebuilt site, which no longer carries the work. Copies already read, saved or archived elsewhere cannot be recalled. What the author can stop is the publication presenting the work as part of what it publishes now.

Behind every byline is an account. The account is public and permanent. The keys that control it are neither: they stay private, and they can be replaced, so an author's history does not hang on a single secret. If every key is lost, a recovery method restores control of the account. The account may be pseudonymous; the protocol never holds a legal name, though an author is free to tell anyone they like. Pseudonymous is not anonymous: everything an account publishes stays linked to it. An account may also name a wallet, so that any payment due to the author arrives there directly, not through the publication's hands. It may likewise carry a name recorded on the ledger, so that a byline can show a name rather than an address.

Every author also keeps a public list of what they have published: their works and their agreements with publications, past and current. The list sits on the ledger, holds references and proofs rather than the manuscripts themselves, and only the author curates it. This makes the byline portable. Long after leaving a publication, an author can still prove what they published there and when, and anyone can check it against the ledger. For the work to be read again, the author offers the manuscript to another publication.

### What the protocol guarantees an author
An implementation must let every author:

1. Write and revise without the network; publishing is a separate, deliberate act.
2. Sign every manuscript and encrypt it to the press's key, so that only they, the reviewers of a publication it is offered to, and the renderer under an agreement can decrypt it.
3. End any agreement alone, at any time, with immediate effect, and trigger the rebuild of the site without the work.
4. Revise and reissue a manuscript, with every version signed and recorded.
5. Rotate keys, or recover the account through a recovery method, without losing their account, history or reputation.
6. Publish pseudonymously; the protocol never holds a legal name.
7. Be paid directly, at a wallet their account names.
8. Offer the same manuscript to any other publication; the protocol imposes no exclusivity, and any exclusive is a contract between the parties.
9. Keep a public list of their works and agreements, past and current, that only they curate and that survives leaving any publication. 
