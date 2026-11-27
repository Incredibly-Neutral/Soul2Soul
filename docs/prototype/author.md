---
post_type: chapter
position: 2
slug: author
tags:
  - about--s2s
modified_date: 2026-11-05T10:59:19
genesis: "0x8b350da78dcd4ea5d43e72d6c8f6ae7d3f50f08ff0314a9d7cdc48a42b4111b1"
author: "0x7907cB38776936B90002057d7feF3a9662ED9A55"
cid: QmYPyTxNLfjg1Bj9sZLxFcmvnk1886fL8LY3PQo2n9RoT9
creation_date: 2026-10-30T13:29:37
---
# The author

In the white paper, the author is one of three parties to publishing, beside the publication and the press. The protocol exists so that disagreeing with a publication doesn't cost an author their work. The author signs every manuscript and encrypts it to the press's key, offers it rather than handing it over, and can end any agreement alone and at once. Behind every byline is a public account whose keys can be replaced, with a list of published work that only the author curates, so the byline outlives any publication. [White paper, section 2: The author](https://polyphony.eth.link/author)

## Account: a Safe on Base

In Soul2Soul, the account behind an author's byline is a Safe: a smart account on Base. Everything an author publishes is published by the Safe, and every manuscript names it as the author's account. The keys that sign for it are the Safe's owners, and a gate checks that whoever signed a manuscript is an owner of the author's Safe.

The goal is an account that outlives its keys. A key is a single secret: lose it, and everything tied to it goes too; replace it, and everything has to move. A Safe separates the account from the keys that control it, and records who controls it on the same ledger that holds the agreements. Gates check authorship against the ledger they already trust, without a separate registry.

We chose Safe over writing our own account contract because an author's account shouldn't depend on code written for a prototype. Safe is a widely deployed, audited standard, and it comes with its own interface. An author adds and removes owners there, such as a second key kept offline or a co-owner who can recover the account. Neither changes the account or anything published under it.

A Safe can also send ERC-4337 user operations, so a paymaster can pay the gas. An author can start without holding any tokens. Who pays is covered in *Monetization and costs*.

What it costs: an author's account is a contract on one chain, and its owners are public.

A pen name and a bio sit on the Safe as two strings, in a records module the protocol's module factory deploys for it. The pen name is the pet name the author is filed under; the bio is free text of up to 1024 characters. The author sets and clears the bio with `s2s author bio`, which reads both. Neither is a document on IPFS: each is a string the Safe writes itself, and only the Safe's owners can write it.

## Writing tools: Neovim and Obsidian

An author writes in Neovim or in Obsidian, each with its own plugin. Neovim is open source end to end; Obsidian gives writers an interface many already know. From a note, an author can upload a manuscript to storage, preview its page, offer it to a publication, publish it and revoke it. The preview command keeps its name, because that is what the author gets, and it never writes on chain: signed page proof is left out, and nothing is appended to a log or a ledger. It renders the version the publication records, not the file just uploaded, so what opens is what a reader would get. A plaintext version previews on a local runner, which holds no key and has nothing to open. An encrypted one previews on Lit instead, which holds the key, so the body comes back readable; the page carries its colophon and no signature. Lit opens it only while the manuscript is under an offer or an agreement that admits the signer, and only when the publication's manifest is new enough to render without a signature. A preview that cannot open still renders on the runner, and the command says why: no version recorded yet for an encrypted note, a read that did not answer, a gate that refused, or a pinned render action too old to render without a signature. One case is silent, a plaintext note the publication does not hold yet, because nothing of it is there to decrypt.

A folder with a `_collection.md` publishes as one signed manuscript. The manifest is the folder's own page, and every other note in the folder becomes a page of its own; one offer, one deal and one revocation cover them all. A reader who can open one member can open every member, and a member whose page type the publication does not template is left out.

Each plugin creates its own key, stored on the author's device and added as an owner of the author's Safe. How many keys must sign is the author's choice. A key on a laptop and one on a phone, either of which can sign, guards against loss. Requiring both guards against theft.

Both plugins share one method library, so the protocol logic lives in one place. Adding another frontend means writing an interface, not reimplementing the protocol, and no single client stands between an author and publishing.

## Storage: several hosts in parallel

A manuscript goes to the prototype's own Kubo node for immediate retrieval, to Pinata and Filebase for redundancy, and twice to Filecoin warm storage for the long term. All of them serve the same CID (version 0, the node's default), so any copy can be checked against the CID the author published.

## Roadmap

- **Owner history.** A module on the author's Safe that records which keys owned it and when, so a gate can check that a key was an owner at the moment it signed.
- **Portable byline.** A list of the author's manuscripts and agreements, with when each was published and for how long, kept in a module on the author's own Safe. Only the author writes it, and anyone can read it with a single call. If a publication ceases to exist, the author keeps the record of their bylines, and any frontend can show all of an author's work next to one of their pieces.
- **The pen name in the byline.** The name is recorded on the author's Safe; pages still show the Safe's address, and reading the name into a page's byline is not built.

