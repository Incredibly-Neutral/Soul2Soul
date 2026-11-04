---
post_type: chapter
position: 8
slug: monetization-and-costs
tags:
  - about--s2s
modified_date: 2026-11-02T10:25:01
kubo_cid: QmR77xBQyhYpr7bwcSXNQbTk6wJYg25goLL956gVKP4kDU
genesis: "0x0742f92a62f624c4466de0eefe621c2ec84fadb1bfef22db63e8a990bbf0bf9d"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# Monetization and costs

In the white paper, the protocol lays three rails for direct payment: a wallet for every author and publication, a division of revenue recorded in the agreement and carried out on the ledger, and the reader gate. Whether a publication uses them is up to its business model. Using the protocol also costs something, and an implementation can pay those costs for its users or leave them with the users. [White paper, section 8: Monetization and costs](https://polyphony.eth.link/monetization-and-costs)

## Monetization: the wallet, not yet the rest

The first rail is already there: every author and every publication has a Safe, and a Safe on the ledger can receive a payment directly, with no party in between. The other two are not built yet: no agreement records a division, and there is no reader gate. Every page Soul2Soul publishes is free to read.

## Costs: the developer pays

The developer pays for Pinata, Filebase, Filecoin, DRPC, Pimlico and Lit, with the keys built into the code. Lit is the expensive part: one cent per second of compute, or 10 to 20 cents to publish a new page. These costs make Soul2Soul a niche product.

## Roadmap

- **A first monetized publication.** A publication on Soul2Soul runs a monetization model on the three rails.
- **Their own services.** Authors and publications bring their own keys for IPFS and RPC services.
- **Away from Lit.** The press moves off Lit, and with it goes the largest cost.