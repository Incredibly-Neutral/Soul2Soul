---
post_type: chapter
position: 2
slug: author
tags:
  - about--s2s
modified_date: 2026-10-30T13:29:37
kubo_cid: QmbHJhiepGfgnnbAZyyxG7yHgVaVfNk9rHeE1tmi5q1uE7
genesis: "0x8b350da78dcd4ea5d43e72d6c8f6ae7d3f50f08ff0314a9d7cdc48a42b4111b1"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The author

In the white paper, the author is one of three parties to publishing, beside the publication and the press. The protocol exists so that disagreeing with a publication doesn't cost an author their work. The author signs every manuscript and encrypts it to the press's key, offers it rather than handing it over, and can end any agreement alone and at once. Behind every byline is a public account whose keys can be replaced, with a list of published work that only the author curates, so the byline outlives any publication. [White paper, section 2: The author](https://polyphony.eth.link/author)

## Account: a Safe on Base

In Soul2Soul, the account behind an author's byline is a Safe: a smart account on Base. Everything an author publishes is published by the Safe, and every manuscript names it as the author's account. The keys that sign for it are the Safe's owners, and a gate checks that whoever signed a manuscript is an owner of the author's Safe.

The goal is an account that outlives its keys. A key is a single secret: lose it, and everything tied to it goes too; replace it, and everything has to move. A Safe separates the account from the keys that control it, and records who controls it on the same ledger that holds the agreements. Gates check authorship against the ledger they already trust, without a separate registry.

We chose Safe over writing our own account contract because an author's account shouldn't depend on code written for a prototype. Safe is a widely deployed, audited standard, and it comes with its own interface. An author adds and removes owners there, such as a second key kept offline or a co-owner who can recover the account. Neither changes the account or anything published under it.

A Safe can also send ERC-4337 user operations, so a paymaster can pay the gas. An author can start without holding any tokens. Who pays is covered in *Monetization and costs*.

What it costs: an author's account is a contract on one chain, and its owners are public.

## Writing tools: Neovim and Obsidian

An author writes in Neovim or in Obsidian, each with its own plugin. Neovim is open source end to end; Obsidian gives writers an interface many already know. From a note, an author can upload a manuscript to storage, preview its page, offer it to a publication, publish it and revoke it.

Each plugin creates its own key, stored on the author's device and added as an owner of the author's Safe. How many keys must sign is the author's choice. A key on a laptop and one on a phone, either of which can sign, guards against loss. Requiring both guards against theft.

Both plugins share one method library, so the protocol logic lives in one place. Adding another frontend means writing an interface, not reimplementing the protocol, and no single client stands between an author and publishing.

## Storage: several hosts in parallel

A manuscript goes to the prototype's own Kubo node for immediate retrieval, to Pinata and Filebase for redundancy, and twice to Filecoin warm storage for the long term. All of them serve the same CID (version 0, the node's default), so any copy can be checked against the CID the author published.

## Roadmap

- **Owner history.** A module on the author's Safe that records which keys owned it and when, so a gate can check that a key was an owner at the moment it signed.
- **Portable byline.** A list of the author's manuscripts and agreements, with when each was published and for how long, kept in a module on the author's own Safe. Only the author writes it, and anyone can read it with a single call. If a publication ceases to exist, the author keeps the record of their bylines, and any frontend can show all of an author's work next to one of their pieces.
- **A name on the ledger.** A name the author records for their byline, so a page can show a name instead of the Safe's address.

