### 5. Gates

The generator is open code, readable and runnable by anyone. What keeps it from being used for anything is the gate: a condition read from the public record at the moment the generator acts, which must pass before it will render or sign. A gate is enforced by the machinery itself — by what the code will do and what the key will sign — not by a decision any party makes when the moment comes.

The first gate is the right to publish. It is open to the author of a work, an owner of the publication, or someone the publication has authorized; no one else may set the generator in motion or write a new site root. The second gate is the deal: the source material of a work is decrypted only while the work is under a current agreement between its author and the publication. Both gates must pass before the generator reveals a work's source material — the deal shows the work belongs to this publication now, and the right to publish shows the caller may act on its behalf. A right to publish over a work without a deal publishes nothing; a deal without the right to publish reveals nothing. The ciphertext is useless on its own: reading is a capability the gates grant inside the generator, not a file that can be opened. No operator, host, or node can read what the gates have not opened for it.

The third gate is the one the protocol reserves for money. A publication may place a work behind it, and the generator will reveal the work's source material to a reader only when the record shows that the reader has paid — per read or by subscription, as the publication chooses. Revenue is then distributed to the author and the publication independently, each according to the agreement, without passing through the other's hands. This gate is optional: the protocol makes room for a payment model to be plugged in, and does not require one. It is described here but not yet built. The paper sets out the shape the protocol allows, and does not claim the shape is delivered.

---

## REMOVED from Gates — pending placement (kept per author instruction)

*Removed: this does not belong in the Gates section. Kept in mind for later placement (candidates: closing of §6 Protocol on machinery/continuity; or the Abstract/Introduction money pass).*

> Running a publication costs something — the storage that keeps content retrievable, the nodes that render it, the record writes that publish it. None of it is free, and the protocol does not pretend otherwise. A publication meets the cost one of two ways. On the serviced path it pays protocol fees, and the protocol's machinery — storage, rendering, resolution — does the work. On the bring-your-own-keys path it runs its own keys and its own infrastructure, at the cost of running them. The protocol permits both and promises neither: not free infrastructure, and not machinery that keeps itself alive.
