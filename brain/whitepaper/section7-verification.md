### 7. Verification

Reading begins at a name. From the name to a page, the path runs through the name's record, the site that record addresses, and the page itself — and at no point is the reader asked to trust whoever happens to be serving the page.

The name is an ENS domain. Its record is a content hash — the CID of the site's current root, written by the generator when it publishes, and only then. The record addresses content, not a host or an operator, so what the name resolves to is the site as it is now — readable as it is, nothing to maintain.

The site is a tree of content-addressed pages. Each page's address is derived from its content, so any change to a page changes its address, and the root with it. A host can store and serve the site, but it cannot alter a page and have the record still point at it: the altered page no longer matches the address the name resolves to.

Each page is signed HTML. At render, the generator signs the page and embeds the proof in the page itself, so the document proves what it is without any external file: who wrote it, who published it, that it is what was rendered, and that it has not been altered. What you see is what was verified — by a reader, a plugin, or an auditor, using nothing but the page.

When the reader reads a page, they can verify that what they read is what the author wrote and the publication accepted for publication. An author's account, identified by its DID, can accumulate verified reputation — and, if the author chooses, proof of humanity or of a real, administrative identity. The protocol requires none of it: pseudonymity remains an option, and what an author attaches to their account is their own decision.
