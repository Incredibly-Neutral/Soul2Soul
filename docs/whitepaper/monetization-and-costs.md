---
post_type: chapter
slug: monetization-and-costs
position: 7
tags:
  - polyphony--s2s
modified_date: 2026-10-29T11:55:44
kubo_cid: QmaofjSipD37JRdWWygaommpHwBT4mA15kbJrRwWobz7Ar
genesis: "0x1681d22f7a18dbeefcba4fd30214a7d8c8ecef45d73b3a14504bacab78333006"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
## 7. Monetization and costs

The protocol lays three rails for direct payment, and nothing more. First, a destination: every author account can name a wallet, and so can every publication, so whatever a reader pays goes straight there, with no party in between to hold it. Second, a division: the agreement records how any revenue divides, and the ledger carries out the division, so neither party is paid from the other's hand. Neither party can change it alone: changing it means ending the agreement, which takes the manuscript off the site, and making a new one. Finally, a condition: the reader gate (section 5) can ask for anything the ledger can confirm, such as a payment, a membership or a subscription. It answers only yes or no, and never holds the money.

Whether a publication uses these rails is up to its business model, and charging nothing is a business model too. So is how a payment that opens many manuscripts, such as a subscription, is divided among them. Whether a manuscript sits behind the gate, and for how long, is part of the agreement; what the gate asks of a reader is the publication's choice. The protocol neither chooses the model nor needs to know it; what it guarantees is what happens on the rails. How money gets into a reader's wallet before they pay, or out of a wallet after, is up to its owner: the protocol requires no particular route and forbids none.

### What the protocol requires of payment

An implementation must:

1. Offer every publication the three rails: wallets for authors and publications, a division recorded in the agreement, and the reader gate.
2. Pay every payment made on the rails straight to the wallets the author and the publication name, with no party in between.
3. Divide it on the ledger as the agreement records it.
4. Keep the division unchanged for as long as the agreement lasts.

### Costs

Using the protocol costs something: writing to the ledger, storing manuscripts and pages, and running the press. The costs follow the responsibilities of sections 2 and 3: the author keeps their manuscripts available, and the publication keeps its pages available. An implementation can pay these costs for its users, or leave them with the users, who then pay their own way or through a service of their choice.
