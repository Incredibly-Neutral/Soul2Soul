# Discussion brief: the central agreements contract (portable byline, part 2)

A round of the reading-room panel. Question to each persona: **would this be an improvement over the current draft's design? Where does it help, where does it fall short, what are the risks?**

## Where the draft stands today

The draft (v1.md) treats an agreement as a per-publication object:

- Abstract: "the agreements between author and publication, which both produce and either may end, are recorded on a ledger neither party operates."
- §1: "A publication is the set of agreements currently in force — recorded on a chain neither party operates."
- §4 (Agreements): "The set of agreements currently in force is what the publication consists of. There is no separate list of articles: a work is published because an agreement covers it, and ceases to be published when that agreement ends." Agreements are recorded on a public blockchain; neither party operates the record; ending one is a fact rather than a request.

## The problem the author has found in this

The ledger — the record of agreements and the methods to change them — lives as part of each publication, albeit on neutral, on-chain infrastructure. The author assumed neutral infrastructure made that harmless. It does not: **it fragments the authoring experience.** A writer working with several publications has their bylines spread across separate ledgers, one per publication. There is no single place where "what this author has published, where, and for how long" can be seen as a whole.

There is also an asymmetry: the ledger is entangled with the publication's own record, so the author's history rides inside each publication's machinery.

## The proposal — a central agreements contract (still on chain, still decentralized)

1. **A single contract** holds the ledger for both sides. Authors and publications each have their own record of **current and past** agreements — not just what is in force now.
2. **Any change affects both parties equally** and is on the record. Ending an agreement remains a fact, not a request.
3. **Anyone can query for an author: "give me all bylines."** The result: every article — its id, a pointer to the encrypted content, the publication it ran on, and the start/end time of the agreement (i.e., when the work was published on that publication).
4. Each record states: **"a work was published at publication X from time Y till time Z,"** pointing to the encrypted data and to the **hash of the plaintext** of the work.

## The soft right to be forgotten

On top of that record: the author (the party) can decide to **hide certain works from surfacing in that query** — a generally-available call that returns the bylines "as the author wants to be known." This is **not deletion**: the records still exist on chain and a determined sleuth can find them. It is a presentation layer over the same on-chain facts.

## The solo publication (the "something more" from the fluidity round)

An author can create **their own publication — solo, a single owner — to display their archive.** Pages on that archive contain the **hash of the plaintext signed by the author**, which can be **cross-referenced against the on-chain record** that the same version was published at publication X from Y to Z. The author's own home-base archive and the neutral ledger corroborate each other: the same work appears in the author's self-hosted record and in the publication's vouched record.

## The specific questions to the panel

- Does a single central contract fix the fragmentation without quietly reintroducing a single point of control — a new "center" (in the governance sense) even though it is on chain?
- Is "anyone can query all bylines for an author" a feature, or a surveillance surface / deanonymization surface (who wants that query? a reader, an employer, a hostile state, a troll)?
- Does the soft right-to-be-forgotten work, or does it undermine verifiability, open a reputation-laundering hole, or become the first thing a censor demands?
- Does the solo-publication + cross-referenced-hash move strengthen the design or complicate it?
- What is gained, what is lost, what is still over-claimed? Where does this design still need to be made honest?

Ground your answer in your own documented views; where you have no documented position, say so rather than invent one.
