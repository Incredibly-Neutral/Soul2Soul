---
post_type: chapter
slug: publication
position: 4
tags:
  - about--s2s
modified_date: 2026-10-30T13:34:39
kubo_cid: QmYTamQWhc6YrPAmU7w2Jy2ZboKf57NDFnhaytPz3vXxPN
genesis: "0xc7bfa0322bf92497b131c1697d9e86b921d02f9e40e13b9ee6fab4b60f660c7f"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The publication

In the white paper, a publication is a name, a look and an editorial line: which authors it works with, and which manuscripts it publishes. It is the party that gives writing a home and an audience, and the protocol makes its decisions public. It sets its own governance, and every decision, from trusting an author to changing the design, is an act on the ledger. Its name points only at sites the press has built from the agreements in force, so an author's ending of an agreement is visible to readers. [White paper, section 3: The publication](https://polyphony.eth.link/publication)

A publication in Soul2Soul is a Safe. Safe's contracts are in wide use: together they held some $27 billion in assets in mid-2026. A publication can arrange itself the way its people work, with one owner or several, and a threshold that says how many must agree. Every decision is a transaction the owners sign, so how a publication governs itself is public.

Safe takes modules, and the protocol's own logic lives in them. A publication has two. The records module keeps its name and points to its config files, such as templates and assets. The publication module keeps the agreements, the offers still waiting, and the lists of authors, developers and reviewers. As long as the prototype is in active development, the publication module is upgradeable, as adding features requires changing the smart contract.

The owners run their publication from an app inside Safe's web interface. Safe already handles queuing, signing and execution, with the wallets and signing devices the owners have in hand. The app brings only what belongs to a publication: reading offers, admitting or declining them, ending agreements, keeping the lists and the config. It also lets the owners check that their manuscripts, config files and web content (pages and assets) can still be retrieved from IPFS, and replicate anything falling short onto more pinning services. Safe's interface and the app both sit on top of the contracts. Neither holds keys, records or an author's manuscript. What a publication rests on is the contracts.

## Domain

A publication's name lives on ENS, on Ethereum mainnet, so its Safe has a presence on mainnet too, at the same address as on Base. Every publication first registers a subdomain of soul2soul.eth, and that is where its site is rendered from the start.

A publication can add an alias: a .eth name it buys and owns itself. It wraps the name and points its resolver at Soul2Soul's resolver contract, and the site is then also served at that name. The address readers know is the publication's own, not space on someone else's domain.

## Permissions

The owners keep three lists, recorded in the publication module and managed from the app. Each names the people the publication trusts with one thing. Authors on the author list take the fast track: what they offer becomes an agreement at once, while anyone else's offer waits for the owners to admit or decline it. Developers on the developer list can preview their work while they design new templates. Reviewers on the reviewer list can read the manuscripts offered to the publication. The gates read these lists from the module when they decide who can publish and who can read, so access follows the record on Base and nothing else.

## Templates and design

A publication's design is its templates and CSS. The templates are written in Handlebars, a small language that covers what a site needs. Handlebars is a logic-less template language: a template lays out data but runs no code. The press renders every publication's design, and never runs code a publication wrote.

The templates are read from the publication's GitHub repository. A developer pushes a new version there, and the owners update the config to reflect it, in a transaction on the ledger.

Developers define the publication's post types and custom fields in a mapping, which ties each post type to a template and a path.

An excerpt from a publication's mapping. The home page lists the posts in a collection, each post gets a page of its own, and a ripple rebuilds the home page whenever a post is published.

```json
{
  "templateConfig": [
    {
      "reference": "home",
      "file": "home.handlebars",
      "path": "/",
      "collections": [
        { "slug": "posts", "filters": [{ "postType": "post" }], "sortBy": "date" }
      ]
    },
    { "reference": "post", "file": "post.handlebars", "path": "/posts/{slug}/" }
  ],
  "ripples": [
    { "origins": ["post"], "destination": "home", "reference": "home" }
  ]
}
```

## Roadmap

- **One owner or the threshold.** A publication decides which acts any single owner can take, such as admitting or declining a manuscript, and which need the Safe's full threshold, such as changing the lists, the config or the module.
- **Its own IPFS services.** A publication configures the IPFS services its content is stored and pinned on.
- **Invited authors.** A publication sends an author an invite, and only invited authors can make offers.
- **A reading interface for reviewers.** Reviewers on the reviewer list read the manuscripts offered to the publication in an interface made for it.
- **No upgradeability.** The publication module becomes immutable, one per publication, and a new version is deployed and enabled rather than upgraded in place. The code a reader can check is then the code that runs.
