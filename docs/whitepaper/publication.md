---
post_type: chapter
position: 4
tags:
  - polyphony--s2s
slug: publication
modified_date: 2026-11-02T22:10:35
kubo_cid: QmPYU7GzNCEKHhhA2wmSSMs6XgJGVQuqHPSW4sYPPgji4x
genesis: "0x9d83adbfd9aad1933c3e0d6026924dc499c02f97f60a712129021acc0a547f38"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The publication
A publication is a name, a look and an editorial line: which authors it works with, and which manuscripts it publishes. The name is the address its pages are served from, and it is the publication's own, not space rented on someone else's platform. Keeping its pages available is the publication's own responsibility, as keeping manuscripts available is the author's. There are no constraints on how it looks: the publication writes its own templates and styles. It is its own thing and looks like it.

How it decides is up to the publication. It may have one holder or several, and set whatever threshold it likes for acting. Holders make the publication's decisions; editors and reviewers are the people they authorise to read and judge manuscripts. The protocol does not fix that shape; it makes it public. Every decision is an act on the ledger: trusting an author, admitting a manuscript, changing the site's design, changing the governance itself. All of them go through the same procedure, and none is silent. The holders and editors may be pseudonymous, as authors may, but the trail of their decisions is public. No decision by the publication reaches the next build of the site any other way.

A manuscript reaches the site by one of two routes. An author the publication trusts offers a manuscript, and the agreement takes effect at once: the manuscript goes straight to the renderer. Any other author's manuscript waits for review: the publication's reviewers can read it, and the publication then admits or declines it. The publication can change its stance toward an author at any time. It can decline a manuscript, on the record, but it cannot change one. An editor can propose a new version, and it becomes one only when the author accepts it and signs it. The protocol leaves room for that; whether an author can receive such proposals depends on their writing tool. That suits what Polyphony is for: signed writing, such as opinion, essays and analysis, where the byline answers for the text. It is not built for a news desk, where the masthead answers for every word.

An author can also revise a manuscript after it is published, and every revision puts it back among the manuscripts waiting for review. From an author the publication does not trust, it waits there like any new manuscript, and the last approved version stays on the site in the meantime. From a trusted author, it is approved at once and goes straight to the site, and the publication cannot stop it. The publication does see every change: each revision is recorded, and it is notified. If it does not want to carry the new version, it can end the agreement, and the manuscript comes off the site. Until it does, the new version stands under its name. A publication that does not want that risk trusts no one and reviews everything.

For an author's ending of an agreement to mean anything, the publication must not be able to keep its name pointing at an old site. So the name is kept on the ledger, and when it joins, the publication gives the protocol the sole right to change what the name points to. From then on only the renderer changes what the name points to, and only to a site it has just built from the agreements in force. The publication takes that right back only by leaving. A publication that leaves can point its name anywhere, an old build included. That cannot be prevented, but it can be detected: anyone checking the name can see that the protocol no longer controls it, and any tool that checks a page's signature can check this too.

### What the protocol guarantees a publication
An implementation must let every publication:

1. Use its own name, and design its site with its own templates and styles.
2. Choose its own governance, with one holder or several and any threshold, recorded in public.
3. Let its holders and editors act pseudonymously; the protocol never holds their legal names.
4. Decide which authors it trusts and which manuscripts it admits, and change either at any time, on the record.
5. Read any manuscript offered to it, through the reviewers it has authorised, until it declines it or the author withdraws it.
6. Decline any manuscript, and end any agreement from its side, with immediate effect.
7. Trigger a rebuild of its site at any time.
8. Keep its name pointing only at sites the renderer has built from the agreements in force.
9. Take back the right to change what its name points to by leaving the protocol.
10. See every revision of a manuscript it carries, be notified of it, and review it first unless it trusts the author.
11. Keep a record of everything it has published and every byline it has carried; an ended agreement is marked as ended, never removed.
12. Carry every manuscript exactly as its author signed it; no one, the publication included, can alter one.
13. Be paid directly, at a wallet it names.





















