---
post_type: chapter
slug: reader
position: 8
tags:
  - polyphony--s2s
modified_date: 2026-10-29T11:54:39
kubo_cid: QmRFTwpas9yNZSktcjbvmg3FjSFSwFMLnJSKAmdw3pNa4o
genesis: "0xfa0c4831eaf0d21722c1ce2572432239f55c9aa26c5b6cbb999829f29d598d3a"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
## 8. The reader 

A reader can check a page without trusting whoever serves it, by following a chain of authorization from the publication's name to the page. Each link vouches for the next.

The first link is the name's record on the ledger. It holds the content address of the site's root, not the location of a server, and while the publication stays in the protocol, only the press can change it; every change is a public, dated entry.

The second link is the site. Every page in the tree is addressed by its content (section 6). A host can store and serve the site, but cannot change a page without changing its address and the root with it, so an altered page no longer matches what the name points to.

The last link is the page's colophon, signed by the press. It carries a hash of the page and points to the manuscript, which carries the author's signature, and to the agreement on the ledger. Together they show whose manuscript the page carries, that author and publication agreed to publish it, and that it has not changed since it was built.

Because the chain starts at the name, it also shows that a page is current. A copy of a page from an older build, even one whose author has since withdrawn it, still carries valid signatures, but the name's record no longer leads to it.

### What the protocol guarantees a reader

An implementation must let any reader:

1. See every change to the name's record.
2. Check any page against the root the name points to.
3. Check the colophon's signature.
4. Trace the page to the author's signature and to the agreement.
