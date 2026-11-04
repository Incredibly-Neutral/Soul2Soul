---
post_type: chapter
position: 5
slug: agreement
tags:
  - polyphony--s2s
modified_date: 2026-11-03T11:54:03
kubo_cid: QmdYRvvtsUMnMx4P7t26zam1LemqprKmKgkQdn5WMgctZn
genesis: "0x39160f9682c10ffe3fdc0d9638bdf0c07c5a237562aa04b238794452225718b4"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The agreement

An agreement is between an author and a publication, over a single manuscript. It records who wrote the manuscript, that the publication may publish it, and how any revenue divides between them. The split is public, because a reader who pays needs to know where the money goes; section 7, on monetization, describes how it is paid. Both parties enter it: the author by offering the manuscript, the publication by admitting it, or in advance, by trusting the author. Withdrawing that trust later affects only future offers; agreements already made stand.

What a publication publishes is exactly the set of agreements in force, each showing the latest version the publication has approved; from a trusted author, that is always the latest. There is no separate list: a manuscript is published because an agreement covers it, and stops being published when that agreement ends, every version with it. Admitting a manuscript is all it takes to put it on the site; the next build carries it.

Agreements are recorded on the ledger, where neither party can rewrite them. Nor can either party change the rules an agreement runs under, meaning how it is entered and ended, and who may decrypt under it: those change only through the protocol's governance, in public (section 6), never through the publication's own. A rule change can stop the renderer from using a manuscript that is under an agreement, but it can never make a manuscript usable once its agreement has ended. An agreement transfers nothing: the work always remains the author's, and the publication's permission to publish it lasts only as long as the agreement

### What the protocol guarantees about an agreement
An implementation must make every agreement:

1. Cover a single manuscript, and show the latest version the publication has approved.
2. Record the author, the publication's permission to publish, and how any revenue divides.
3. Need the consent of both parties, the publication's given per manuscript or in advance by trusting the author.
4. End when either party ends it, alone, from the moment the ending is recorded on the ledger.
5. Be the only grounds on which the renderer decrypts a manuscript for a publication.
6. Sit on the ledger, where neither party can rewrite it, and stay there when it ends, marked as ended.
7. Stay ended: no rule change can make a manuscript usable again under an agreement that has ended.
