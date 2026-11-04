---
post_type: chapter
position: 5
slug: agreement
tags:
  - about--s2s
modified_date: 2026-11-02T10:07:41
kubo_cid: QmaiZUFGiWcHNUhfxYCsm2rcLa6J55GTtUB2XEtZRjhgeN
genesis: "0x9286c900d744ffafdfdf89a1dd92d8c10fd3a9bce74a78b95e8ab3682ec2b4c2"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The agreement

In the white paper, an agreement is between an author and a publication, over a single manuscript. It records who wrote the manuscript, that the publication may publish it, how any revenue divides, and whether a reader must pass the reader gate. Both parties enter it: the publication either for each manuscript, or in advance by trusting the author. Either can end it alone. What a publication publishes is exactly the set of agreements in force. [White paper, section 5: The agreement] (https://polyphony.eth.link/agreement)

An agreement lives in the publication module, the contract the publication's Safe enables on Base. Each publication has its own. Only the publication can change the code that decides what it publishes, and no one holds a lever over every publication's agreements at once. The owners enable a new version of the rules when they choose, and a publication that disagrees keeps the one it has. Unlike a platform, the implementation can't force a change on a publication.

The module holds agreements, pending offers and the lists, and nothing else: no manuscript, no title, no reader. As long as the prototype is in active development, the publication module is upgradeable, as adding features requires changing the smart contract.

## Shape

An agreement is a genesis id and a list of versions. The genesis id is the digest the author signed on the manuscript's first version, so the key to an agreement is a commitment the author made, not a number the contract hands out. Each version is a CID and the time it was added. A revision appends a version, and the latest version becomes the current one; nothing is replaced. The ledger records who appended each version.

## Methods

Three writes move an agreement. An author offers a manuscript. If the author is on the publication's author list, the offer becomes an agreement in the same transaction; otherwise it waits as a pending offer, which the author can keep revising or withdraw. The owners admit it or decline it. A revision is another offer under the same genesis id: the agreement holds, and the site shows the latest version. Either party can end an agreement. In the contract, one function, `retract`, declines, withdraws and ends, depending on who calls it. The rules every agreement runs under fit in those three functions, so they can be checked by reading them.

## The check

Before the press decrypts a manuscript, it asks the module one question: is there an agreement for this genesis id? Agreements form a set keyed by genesis id, so the answer is a single read, and it is the same for anyone who asks the ledger. What a publication may publish is decided there, and nowhere else.

## Ending

Either party ends an agreement alone, in one transaction, and the other can't refuse it. When the author ends it, the manuscript leaves the publication's agreements and offers. When the publication ends it, the manuscript goes back among the pending offers: a publication can stop publishing a work but can't erase it, and it can admit the work again later without the author signing anew. Nothing is deleted. The versions stay in the log, the author stays the author, and the ending is recorded with who made it.

## Roadmap

- **One word for each act.** The contract's names follow the white paper: `offer`, `admit`, `decline`, `withdraw` and `end` replace `makeOffer`, `acceptOffer` and `retract`, and "agreement" replaces "deal", as in `hasAgreement` for `hasDeal`.
- **No upgradeability.** The publication module becomes immutable, one per publication, and a new version is deployed and enabled rather than upgraded in place. The code a reader can check is then the code that runs.

## Gaps

- An author on none of the publication's lists can't make an offer. The contract accepts a manuscript's first version only from the publication's Safe, a listed developer or a listed author, so pending offers come only from developers and from authors taken off the author list.