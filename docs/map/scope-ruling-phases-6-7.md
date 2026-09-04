# §36 phases 6–7 — a roadmap, not a specification

**Date:** 2026-09-03
**Decided by:** Claude Code, from the spec text, and recorded for the owner to overturn if they disagree.

## The question

A completeness audit marked §36 (Implementation Phases) PARTIAL, on the grounds
that Phase 6 (Route optimization, next-move predictions, Along My Way,
recovery, group decision, smart meeting points) and all of Phase 7 (City
models, personal city models, World Pulse, traveler-flow graph) return nothing
on grep.

It declined to decide whether "the spec is complete" includes them, and handed
that back as a scope call.

## The finding

§36 is **two lines of prose** — one sentence per phase, listing capability
names. It specifies nothing: no surfaces, no data contracts, no privacy rungs,
no interaction model.

Every capability named in phases 6 and 7 appears **exactly once in the entire
document**, and that one occurrence is the §36 line itself:

| term | occurrences in the spec |
|---|---|
| Along My Way | 1 |
| smart meeting points | 1 |
| group decision | 1 |
| City models | 1 |
| personal city models | 1 |
| World Pulse | 1 |
| traveler-flow graph | 1 |
| next-move predictions | 1 |

Contrast §§1–35, where each surface has its own numbered section with data
contracts, privacy classes, interaction rules and non-goals.

## The ruling

**Phases 6 and 7 are out of scope for "implement this spec."**

Building them would mean inventing a product from a two-word mention, not
implementing a design. "World Pulse" could be a dozen different things; the
document does not say which, and a guess would be indistinguishable from
scope creep with a spec reference attached.

§36 is a **sequencing plan for work the document does not itself specify**. The
implementable surface is §§1–35, §37 (non-goals), §38 (the north-star
scenario) and §39 (the final architecture rule). §36 describes the order in
which those were built and where the product goes next.

## What this does NOT excuse

Phases 1–5 name capabilities that ARE specified elsewhere, and those are in
scope. Where a phase-1–5 item is unbuilt, it is a gap and is counted as one.

If the owner wants phases 6–7, they need specification first — at the same
level of detail §§1–35 carry. That is a design task, not an implementation one.
