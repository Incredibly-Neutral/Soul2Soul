# Glossary (decided terms)

Terms joera has fixed. Candidates and open clashes are in [glossary-candidates.md](glossary-candidates.md); this file holds only what is decided. Once a term is here, the white paper uses it in this sense and no other.

## press
The technical third party between author and publication (section 6): sealed hardware, the nodes that run on it, and the open code they run. Every decryption happens inside it, and it is the only technical part of the protocol that holds a manuscript decrypted. It holds [its keys](#presss-keys) for decryption and signing.

*Decided 28 October 2026. Replaces "renderer" (24 October) for the whole; "renderer" now names only its build function.*

## renderer
The function of the [press](#press) that builds a publication's pages: it decrypts the manuscripts an agreement covers, renders them with the publication's templates, signs each page and records the site's root on the ledger.

*Decided 28 October 2026 (narrowed from the 24 October sense).*

## manuscript
What the author writes and keeps: everything the author produces, for themselves and for publications, before it is rendered. A manuscript is stored encrypted, and readers never see it directly. It replaces "source material", and "work" wherever "work" means the stored, encrypted thing.

*Decided 24 October 2026.*

## page
What the renderer makes from a manuscript under an agreement: signed HTML, which is what readers see. A publication's site is made of pages.

*Decided 24 October 2026.*

## work
The author's creation in the legal sense, as in "the author's rights over their work". A work covers both the manuscript and the pages made from it. Don't use "work" for the encrypted manuscript or for a rendered page.

*Decided 24 October 2026.*

## press's keys
The keys of the [press](#press), for decryption and signing. They stay inside the nodes, can be used only by the attested code and, for decryption, only when a gate passes (section 5); they can be rotated and recovered. How many keys that takes is up to the implementation.

*Decided 28 October 2026. Replaces "renderer's keys" (27 October) and "protocol key" (24 October).*

## implementation's governance
Whoever an implementation puts in charge of its renderer: it publishes the code the nodes run, the gates included (section 6). It can therefore make the renderer refuse an author, a publication or a manuscript, and it is the only party that can change the rules an agreement runs under, by publishing new code. The author and the publication each have their own governance in the same sense (sections 2 and 3).

*Decided 28 October 2026. Replaces "the operators' governance" (27 October) and, before it, "the renderer's governance".*

## collateral freedom
Protection that comes from sharing infrastructure with many others: when the operators of a compute network serve so many other clients that turning against one would cost them too much, that one inherits their reliability. Section 6 offers it as one way to raise the trust placed in the owners of the hardware. The term is borrowed from censorship circumvention, where it names hosting on services too important to block.

*Decided 28 October 2026.*

## colophon
The metadata the renderer signs for every page (section 6): a hash of the page, and pointers to the manuscript and the agreement it was built from; the manuscript carries the author's address and signature. Named after the printer's note at the end of a book saying who printed it, when and from which manuscript. Not "imprint", which stays with the publication's name and its responsibility.

*Decided 28 October 2026. Replaces "signed metadata" and "metadata object".*

## chain of authorization
The path from a publication's name to one of its pages, which lets anyone check the page without trusting whoever serves it. It runs from the name, through its record on the ledger, which only the [renderer's signing key](#presss-keys) can update, and the signed set of pages that record points to, to the proof inside each page. That proof shows that the page's text is the manuscript as the author signed it, built under an agreement in force. Section 6 introduces the chain; section 8 follows it from the reader's side. Use "chain of authorization", not "authorization chain".

*Decided 27 October 2026.*