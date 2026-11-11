---
post_type: chapter
slug: reader
position: 9
tags:
  - about--s2s
modified_date: 2026-11-02T19:10:06
kubo_cid: QmVyqDdcHs4zY59dJWUPx4JAz4FVsSTPsfcWDuMfWF8L2b
genesis: "0x261445d6a8e7ed0d0c85df20b14afcb97067f7fe568de546114d03fa96bab519"
author: 0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The reader

In the white paper, a reader can check a page without trusting whoever serves it, by following a chain of authorization: from the name's record on the ledger, to the content-addressed site, to the colophon the press signs. The colophon leads on to the author's signature and the agreement. Because the chain starts at the name, it also shows that a page is current. [White paper, section 9: The reader](https://polyphony.eth.link/reader)

Why names live on ENS is argued in the [introduction](/introduction#names-ens).

## Name: the record on the L2

The name lives on ENS, on Ethereum mainnet; its record doesn't. Every build writes a new root, and only the L2 makes that write affordable. Three contracts carry this: a registry hands out subdomains of soul2soul.eth, each name points to a resolver on mainnet, and the resolver looks the record up in a records contract on the L2. Only callers the protocol's Safe has authorised can write there, the press's key among them. Every write emits an event, so each change to the record is a public, dated entry.

## Lookup: a gateway we host

The resolver on mainnet can't read the L2. It answers with an offchain lookup (CCIP-Read), and the reader's software asks a gateway to fetch the record from the L2. We host that gateway ourselves, at `ccip.transport-union.dev`, and nothing on mainnet checks its answer. Whoever controls it, by compromise or by coercion, can point any name at any root. It is arguably the weakest link in the implementation.

## Site: through eth.limo and eth.link

Most browsers can't open a .eth name, and whether they ever will is out of our hands. Readers reach a site through eth.limo or eth.link, gateways that resolve the name and serve the site from IPFS. A reader trusts them as they trust ours: to serve what the name points to.

## Page: the colophon

Each page carries its colophon, signed with the press's key (see [the press](/press)). A reader checks it in four steps: recover the signer and compare it with the press's address in the protocol's records; hash the page and compare it with the digest in the colophon; recover the signer of the author's signature the page carries, and check that it is the author or an owner of the author's Safe; and ask the publication module whether an agreement is in force for the manuscript's genesis id.

## Roadmap

- **A browser plugin that checks the chain.** The reader's browser checks every page as it loads: that it belongs to the root the name points to, the press's signature, the page's hash, the author's signature, and that the agreement on the ledger covers the manuscript the page carries. It also shows the history of the name's record.