---
    post_type : chapter
    position: 2  
    tags: [polyphony--s2s]
    slug: manuscript
--- 
# 3. The manuscript

A manuscript's identity is derived from the first version the author signs, and every revision keeps it. Agreements are made over that identity, so an agreement outlives a revision.

The author signs a manuscript once. The signature covers its public details and a hash of its text that sits among them, so it proves which account authored the manuscript, and lets anyone holding the text check later that it hasn't changed. The body is encrypted to the press's key, and anyone can encrypt to that key; without the hash, a stranger's text could be rendered under the author's account. The hash is salted with a random value kept inside the encrypted body, and the press renders a body only if it matches.

The signed part names the published format the manuscript follows, so other implementations can read and verify it. Anyone holding the text can check which account authored it without asking the publication.

### What the protocol guarantees about a manuscript

An implementation must make every manuscript:

1. Have an identity derived from its first signed version, which every revision keeps and over which agreements are made.
2. Carry, in its signed part, a salted hash of the body's plaintext.
3. Name, in its signed part, the published format it follows.
4. Be verifiable by anyone holding its text, without the publication.
