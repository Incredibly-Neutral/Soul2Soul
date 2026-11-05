---
post_type: chapter
position: 7
slug: press
tags:
  - about--s2s
modified_date: 2026-11-05T12:04:49
genesis: "0x103d2295ba191c0dc9b770e7f933d3afdb3ba5495adcfdd4c9f2dd5af38efb72"
author: "0x7907cB38776936B90002057d7feF3a9662ED9A55"
cid: QmbUv6pg8eJCKMGTiP9Jx6swmQPxi2AQUs3HVHC4vc8vHK
creation_date: 2026-11-02T10:01:22
---
# The press

In the white paper, the press turns an author's signed manuscript into a page, and every decryption happens inside it. It runs in sealed environments, holds the keys for decryption and signing, and runs only pure functions that the implementation's governance publishes by their content address. Two things about it are trusted, the hardware and its owners; everything else it does can be checked. [White paper, section 7: The press](https://polyphony.eth.link/press)

The press in Soul2Soul is a set of Lit actions bound to one key. Why Lit, and what that choice trusts, is argued in the [introduction](introduction.md#the-press-lit-actions).

Lit runs Chipotle as one confidential VM on Phala Cloud, built on dstack and Intel TDX. Its enclave holds a root key and derives the press's key from it, never storing it, and only for an action in the key's group. The implementation's governance registers the press's key and its actions, each by its CID, to that group on Lit's smart contract on the L2. The group also has a usage key, which runs the actions and pays for the compute.

## Code: actions addressed by their content

Each action is a bundle of JavaScript, identified by its CID; there are five: prep, render, update, maintain-cache and repoint-archive. To change what the press does, the implementation's governance publishes a new CID and adds it to the group. The protocol's Safe records the current CIDs, and every build reads them there, so a client can't choose the code that builds a page.

## Keys: one key for everything

The press has one key, and it does four things. Authors encrypt manuscripts with it, through Lit. Render decrypts them and signs each page's colophon. Update signs the transaction that points the name at the new site. The records contract knows the press by that key's address, and every page is verified against it. So everything rests on one key.

Encryption has no gate. Any author can encrypt with the press's key, which lets an author offer a manuscript before any agreement exists. Decryption always has one, and the action's own code enforces it: render calls `canRead` before it asks Lit to decrypt. Lit only keeps the key from any code but the permitted actions. The gate holds because that code runs it.

The protocol Safe's owners rotate the key: in one batch, they register a new key in a new group, record its address and authorise it on the records contract.

## Build: three actions, each checking for itself

A build is three action calls. Prep decides what to build, render builds each page, and update assembles the site and points the name at it.

Prep takes the manuscripts the author asks to publish, reads the publication's config from its records, and returns a list of jobs, one per page, ripples included: a home page, for example, depends on a new post. When a manuscript's slug has changed, prep marks the old path for removal. Prep uses no key and writes nothing; its output is a list of requests.

Render runs once per job. It looks up the manuscript's latest version in the publication module, fetches it by CID, decrypts it if `canRead` passes, and checks the plaintext against the hash the author signed. A manuscript that doesn't match is left off the page. Render then lays out the page with the templates and config the publication recorded, signs the colophon and stores the page by CID. If the agreement for a manuscript the author published has ended, render returns that page's path for removal instead.

Update is where the site changes, so it checks the most. It runs `canPublish`, or `canReset` for a reset. For each page, it fetches the stored bytes by CID and checks that the colophon's signature recovers to the press's key, that the page hashes to the digest in the colophon, and that the colophon names the job's genesis id. A page that fails any check stays out of the site. A path comes out only when the ledger shows no agreement for it. Update then builds the new tree on IPFS and writes its root to the name.

No step relies on the one before it. Prep holds no key, and render and update re-read the ledger and the bytes before anything is decrypted, signed or placed.

## Tree: a directory on IPFS

The site is a directory: `index.html` at the root, one folder per page with its own `index.html`, and the publication's assets under `/assets`. Update starts from the previous root, copies it whole and replaces only the pages that changed; a page whose CID already sits at its path is left alone. The assets come as one subtree, from the CID in the publication's config, so a file removed there disappears from the site. A reset starts from an empty directory.

The IPFS node computes the root CID over the directory, and the press pins it there. On a publish, the author's client mirrors the same root to two pinning services and to Filecoin, which keeps at least two copies, all under the same CID.

## Colophon: the page vouches for itself

Each page carries its colophon inside it, as JSON-LD, outside the part of the page its hash covers. It names the manuscript by its genesis id and the author by their DID, which is their Safe's address, with the author's own signature. It carries the page's SHA-256 and the hash and CID of the manuscript's text. It points to the publication module, where the agreement is kept under that genesis id, and to the render action that built the page, by CID. The press signs it with its key. With the page alone, anyone can check that the press built it, from which manuscript, written by whom, and with which code.

## Name: one transaction

Update writes the new root to the publication's name in one transaction, signed by the press's key: the root on the publication's name and on each alias in its config, and an empty value on any alias it dropped. The records contract on the L2 accepts writes only from callers the protocol's Safe has authorised, and the press's key is authorised in the same batch that records its address. If the transaction fails or reverts, the build fails. A site is published when its name points to it, and not before.

## Preview: the same code, without the key

A preview runs the same actions outside Lit, on a Bun runner that fetches each action by its CID, as Lit does, and stands in for Lit with a shim that holds no key: it can't sign and can't decrypt. A preview therefore renders only unencrypted text, its colophons carry no signature, and update never writes to the ledger. It still builds and pins a real tree, at `<cid>.preview.transport-union.dev`. The address is the root's CID: no one finds the preview without it, and anyone who has it can open it.

## Cache: a shortcut the ledger checks

A page that lists other manuscripts, such as a home page, needs the latest version of each, and a Lit session allows fifty requests. So each publication keeps those versions in one archive file, pointed to by a text record. The archive is a shortcut, never a source: each build compares it with the agreements on the ledger, and every item in it carries the author's signature and is checked before use. Maintain-cache brings it up to date after a build; repoint-archive replaces a lost one only when an owner of the publication's Safe signs. A poisoned cache costs a rebuild, never a page the gates wouldn't allow.

## Roadmap
- **Monetized text, encrypted for readers.** When an agreement includes monetization, the press encrypts the text again under the reader gate, so a page releases it only to a reader who passes.
- **A press no single party holds.** The press's key moves out of Lit's single trusted execution environment into several, run by operators unlikely to collude, as the white paper requires.


