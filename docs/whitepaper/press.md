---
post_type: chapter
position: 6
slug: press
tags:
  - polyphony--s2s
modified_date: 2026-10-29T11:56:20
kubo_cid: QmdRaE3M8fbTfXuZYujHdnqG5cyxT2N72CauCUVVpSyvSa
genesis: "0x41d747c81665cd9c85c6424f544035beeb49799721fec4c9bc8f16478d082505"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
## 6. The press

The press turns an author's signed manuscript into a page a reader can read, and every decryption happens inside it: for the author, for a publication's reviewers, for building pages and for readers who pass the reader gate. It is the only technical part of the protocol that must hold a manuscript decrypted, so two things about it have to be trusted: the hardware and the people who own it. Everything else it does can be checked. It has three layers: the hardware, the nodes that run on it, and the code the nodes run.

### Hardware

The press runs in sealed environments: hardware that lets no one, not even its owner, see into the code as it runs or interfere with it, and that can attest to which code that is. The protocol trusts the hardware to keep that promise, and trusts its owners not to collude against the rights this paper gives authors and publications. Neither trust is ever perfect, but both can be raised to an acceptable degree: for example, by federated governance among a diverse set of node operators, or by collateral freedom: running on a compute network whose operators serve so many other clients that turning against one would cost them too much.

### Nodes

Each node runs the press's code and holds the press's keys for decryption and signing. The keys can be rotated, and there is a method to recover them. Anyone can read and run the code, but running a copy gets no one past a gate: the keys stay inside the nodes, and the hardware attests which code uses them.

### Code

The code is a set of pure functions, each addressed by its content and published by the implementation's governance. The gates (section 5) are among them, and every decryption must pass one: the decryption that opens a manuscript to its author or to a publication's reviewers, and the renderer, which builds a publication's pages.

In a build, the renderer first decrypts the manuscripts whose pages need updating, when the gates pass. It renders them into HTML with the publication's templates and configuration, which are content-addressed and recorded on the ledger by the publication. Monetized text is encrypted again under the reader gate. For each page, the renderer signs a colophon, a metadata object that carries a hash of the page and points to the manuscript and the agreement; the manuscript carries the author's address and signature. It builds a Merkle tree of the site's pages and assets and computes the address of the root. Last, it signs a transaction that updates the ledger record linking the publication's name to that root.

### What the protocol requires of the press

An implementation must:

1. Run the press only in sealed environments that let no one, their owner included, see into the code as it runs or interfere with it, and that attest to which code runs.
2. Choose node operators who are extremely unlikely to collude against the rights this paper gives authors and publications, whether through federated governance among a diverse set of them or through collateral freedom.
3. Keep the press's keys for decryption and signing inside the nodes, with a way to rotate and recover them.
4. Make the gates part of the attested code, and decrypt a manuscript, for anyone, only when a gate passes.
5. Build pages only with pure functions, each addressed by its content and published by the implementation's governance.
6. Render only with templates and configuration that the publication has recorded on the ledger by their content address.
7. Encrypt monetized text again under the reader gate.
8. Sign a colophon for every page, carrying a hash of the page and pointing to the manuscript and the agreement.
9. Record the root of the site's Merkle tree on the ledger, against the publication's name, in a transaction the press signs.
