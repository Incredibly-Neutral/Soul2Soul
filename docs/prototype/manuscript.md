---
post_type: chapter
position: 3
slug: manuscript
tags:
  - about--s2s
modified_date: 2026-10-30T13:31:31
kubo_cid: QmTk1rK1Drd2PbZAmEW9iG24JXjya1AQVmSmaEehRk5Bzq
genesis: "0x05fffe8a31ae836e10ae9df4ebfea3d5c8cf73f0697773aff8651954fb5dbe71"
author: did:ethr:0x7907cB38776936B90002057d7feF3a9662ED9A55
---
# The manuscript

In the white paper, the manuscript is what an author offers a publication and what the press turns into pages. The author signs it and encrypts it to the press's key, leaving a few details, such as its tags, public so a publication can sort what it is offered. A revision is a new signed version, and every version is recorded. Since no one but the author can change it, a page that points back to its manuscript shows exactly what the author wrote. [White paper, section 2: The manuscript](https://polyphony.eth.link/manuscript)

In Soul2Soul, a manuscript is a JSON object with a public part, which anyone can read, and a body, which the author can encrypt. The author signs the public part, and the object is stored at its content address. The format is shared: every writing tool produces it, every publication reads it, and the renderer builds pages from it, so nothing about a manuscript depends on the tool that made it.

## Format: a signed JSON object

```ts
interface S2SContentItem {
  public: S2SPublicContent;   // signed, readable by anyone
  objectId: string;           // EIP-712 digest of the public part
  proof: { type: 'eip712'; signer: `0x${string}`; signature: `0x${string}` };
  encryption: boolean;        // true: the body is ciphertext
  body: string;               // ciphertext, or JSON.stringify({ title, slug, content, custom })
}

interface S2SPublicContent {
  specVersion: string;        // "1"
  author: string;             // 0x<the author's Safe>
  postType: string;           // post, page, or a custom type
  mediaType: string;          // how to read the body
  parent: string;             // "0" for a root
  position: string;           // for ordering
  publication: string;        // the publication's name
  locale: string;             // language
  createdAt: number;          // unix seconds, this version
  tags: string[];
  plaintextHash: string;      // keccak256 of the body before encryption
}
```

## Public part and body: split by who needs to read them

The public part holds what a publication needs before it decrypts anything: who wrote the manuscript, for which publication, what kind of post it is, when, and its tags. A publication can sort and filter what it has been offered without the press, and anyone can see what an author has signed.

The body holds the title, the slug, the text and any custom fields. The author decides per manuscript whether to encrypt it, with a boolean in the note's frontmatter. Encrypted, it can be decrypted only through the press, when a gate passes. The body is stored as a string, so encryption replaces that string and sets `encryption` to true, and the rest of the object is the same either way.

## Signing: EIP-712 over the public part

The author signs the public part as EIP-712 typed data, with a key that is an owner of their Safe. Typed data shows the signer the fields they are signing. The body enters the signature through `plaintextHash`, the hash of the text before encryption, so the signature commits to what the author wrote rather than to a ciphertext, and encryption can happen after signing. After decrypting, the renderer hashes the text again, and a body that doesn't match is not rendered. Tags are signed as a hash, and the chain id binds the signature to Base.

## Identity: the genesis id

A manuscript is identified by its genesis id: the `objectId` of its first version, the EIP-712 digest of that version's public part. It is computed on the author's machine before anything is uploaded, so a manuscript has an identity before it has a storage address, and that identity doesn't change when the storage does. The writing tool keeps it in the note's frontmatter.

## Versions: appended, never replaced

A revision is a new signed object with its own `objectId`, published under the same genesis id. Each version is stored at its own CID and recorded on the publication's contract as a CID and a timestamp, appended to the manuscript's list of versions. Earlier versions stay at their CIDs and the list only grows, so a manuscript's history can be read but not rewritten. The renderer builds the page from the latest version.

## Roadmap

- **Revisions back to review.** Every revision returns the manuscript to pending: approved at once for an author the publication trusts, and waiting for review otherwise, while the last approved version stays on the site.
