---
post_type: chapter
slug: gates
position: 5
tags:
  - polyphony--s2s
modified_date: 2026-10-29T11:56:51
kubo_cid: QmUcg5jaohj78V4WL85yaYgvN1uG4vW4mmG56S8iFTuG1x
genesis: "0x32131c8187132fde3e11f1f0977ec783a9bdf085feb9f05d52bac1e32b5cc479"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
## 5. Gates
## 5. Gates

A manuscript is encrypted to the press's key. Who can decrypt it, and when, is settled by gates: conditions fixed in advance, which no one can change afterwards. What a gate reads from the ledger, such as whether an agreement is in force, can change; the gate itself cannot. Each gate is checked at the moment someone asks, and must pass before anything is decrypted. A gate decides only whether a manuscript can be decrypted, not what is done with it afterwards. Where the gates run, and what has to be trusted about them, is the subject of section 6.

Two gates open a manuscript to people. The author can decrypt their own manuscript at any time. The reviewers of a publication can decrypt a manuscript offered to it, until the publication declines it or the author withdraws it. What they have read by then stays read; they just cannot decrypt it again.

Two gates open it to the renderer, the part of the press that builds a publication's pages. The renderer decrypts a manuscript only while an agreement covering it is in force, and only the version the publication has approved. And it builds and publishes a site only when asked by someone with the right to ask: the author of a manuscript the site carries or has carried, a holder of the publication, or someone the holders have authorised. A request cannot put anything on the site, because the renderer builds only from the agreements in force.

The last gate is for readers, and only when an agreement includes monetization (section 7). Whether a manuscript sits behind it, and for how long, is agreed by both parties along with the split, and holds for as long as the agreement does; what the gate asks of a reader, such as a payment or a membership, is the publication's choice (section 7). Neither party can change what they agreed alone: changing it means ending the agreement, which takes the manuscript off the site, and making a new one. While they hold, a reader gets the manuscript's text only when the check passes on the ledger. The check answers yes or no; it never holds the money.

### What the protocol guarantees about its gates

An implementation must:

1. Let the author decrypt their own manuscript at any time.
2. Let the reviewers of a publication decrypt a manuscript offered to it until the publication declines it or the author withdraws it, and refuse them any new decryption after that.
3. Let the renderer decrypt a manuscript only while an agreement covering it is in force, and only the version the publication has approved.
4. Let the renderer build and publish a site when asked by the author of a manuscript the site carries or has carried, a holder, or someone the holders have authorised.
5. Make a manuscript's gates immutable once it is encrypted, so that no one but the implementation's governance, by publishing new code, can change them.
6. Check every gate against the ledger at the moment it is asked, so that an ending or a withdrawal counts from the moment it is recorded.
7. When an agreement includes monetization, release the manuscript's text to a reader only once the agreed check passes on the ledger.
8. Keep whether, and for how long, a manuscript sits behind the reader gate unchanged for as long as the agreement lasts, so that changing it takes a new agreement.
