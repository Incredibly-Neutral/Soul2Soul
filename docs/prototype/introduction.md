---
post_type: chapter
position: 1
slug: introduction
tags:
  - about--s2s
modified_date: 2026-10-30T13:55:13
kubo_cid: QmX8dF4nW9eyrkN8ShMDSqQMAikiWvmQnEHwK3syhRx28H
genesis: "0xe0f3f9face812e3da45375ee85d4876936bfa3b8c25032847b6e5b0e79de79f9"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# Soul2Soul

Soul2Soul is a prototype of Polyphony, a protocol for independent authors and collective publications. It is early alpha, built by Incredibly Neutral; work on it began early 2025. The white paper says what an implementation must guarantee, never how. What follows are the choices we made, the trade-offs we accepted, and where this implementation falls short.

## Ledger: Base, an Ethereum Layer 2

Agreements live in EVM contracts on Base, because the core goal is credible neutrality. An agreement between an author and a publication should not be something either side, or the implementation's governance, can quietly rewrite. And anyone should be able to check that the rules ran as written. Each publication deploys its own contract, but the chain executes it, so author and publication hold their rights against the same code.

A smart contract also keeps the rules with the data. The agreements and the only functions allowed to change them sit in one contract, so there is no off-chain service with its own copy of the rules, slowly drifting.

Why a Layer 2? Offering a manuscript or ending an agreement should be fast and cheap. Base was the obvious choice when the prototype started, but nothing in the contracts depends on it: they run on any EVM chain. Each publication can upgrade its own contract, as long as the prototype is in active development.

## Storage: IPFS

Whoever holds the only copy has leverage. So no single party should hold the only copy. IPFS works here because content addressing separates two questions: *is this the right data?* (check the hash) and *is the data still available?* (ask whoever pins it). A host can refuse to serve a manuscript, but it can't swap one in. The private part is encrypted, so the set of acceptable hosts becomes "anyone". The prototype uses several hosts in parallel for redundancy: its own Kubo node, two pinning services and Filecoin warm storage, all serving the same CID. Adding or dropping one changes no reference.

## The press: Lit actions

The press needs something unusual: a key that neither author nor publication holds, and only specific code can use. Lit actions bound to a Programmable Key Pair (PKP) provide this. This implementation uses that one key as the press's key, both to decrypt manuscripts and to sign pages. Lit lets only the permitted actions use it. Who decides which actions are permitted? The implementation's governance, currently a Safe multisig with the developer as its only owner.

This guarantee has weakened. With Naga, the key existed only as threshold shares across an open, incentivized network. With Chipotle, in 2026, it lives in a single trusted execution environment. What remains is collateral freedom: Lit secures DeFi applications with a lot of value at stake, so turning against one small client would put that business at risk. That is an economic guarantee, not a cryptographic one.

## Names: ENS

With ENS, the right to change a publication's record can belong to the press's key alone. With DNS, the registry always keeps the final say. A publication can still walk away, by changing the resolver or letting the name lapse. That is its choice to stop being a publication, and its authors keep their work. Most readers reach the site through eth.limo or eth.link, and lookups pass a CCIP-Read gateway that fetches records from Base. Those are trust assumptions.

## Code and licence

The code is a monorepo on GitHub ([link]) under Apache-2.0. The white paper and these texts are under CC BY 4.0. Use them, fork them, build your own take on them.

