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

---

# SUPERSEDED FOR PHASE 6 — owner approval, 2026-09-05

**The 2026-09-03 ruling above stands as the record of why phases 6–7 were held.
The owner has now APPROVED Phase 6 and it is in scope.** Phase 7 is untouched
by this approval and remains held on the reasoning above.

## What the approval changes, and what it does not

It does not turn §36's one line into a specification. It authorises building
the three named Phase-6 capabilities **on the machinery that already exists**,
with the §§1–35 rules that already govern that machinery — not inventing a
parallel product from the phrase. Concretely, the approved build is:

1. **Along My Way** — a CORRIDOR FILTER on the existing Map Intelligence
   Gateway (§19 `GET /api/map/projection`). The corridor is a bbox plus a
   distance-to-polyline predicate applied to objects the gateway already
   decided this viewer may see, ranked by the §31 ladder the gateway already
   applies, with an explicit detour-cost line per surviving object. **It is not
   a new privacy surface**: it can only ever REMOVE objects from an answer the
   viewer could already obtain by asking for the same bbox.
2. **Group decision** — a bounded shared shortlist over the EXISTING trip plan
   (`trip_plan_items`, status `tentative`), with a simple accept/decline per
   crew member. The crew IS `trip_members`; no new social graph is created.
   Accepting writes through the EXISTING plan write path. Crew members appear
   as **coarse area labels only** (§23) — the group-decision projection carries
   no coordinate field at all, so a live-share `exactCoords` cannot reach it.
3. **Recovery** — when a planned stop becomes unreachable (a LIVE
   `access.walk_in` denial, a closure, or a missed window), the next-best
   alternative in the same category, with the reason and its claim reference.
   It reuses the Compass Plan-B seam (`lib/CompassLiveConstraints.computePlanB`
   and `evaluateLiveConstraints`) rather than re-deriving one.

## What was NOT built under this approval

§36's Phase-6 line also names **route optimization**, **next-move
predictions** and **smart meeting points**. The first and the third are
already built (Optimize Today in `tripMapModel`/`tripMapSources`, and
`meeting_point` pins via `lib/mapProducers/meetingPointProducer`), so they
needed no new work. **Next-move predictions are still unspecified and are NOT
built**: the spec gives them no surface, no horizon, no confidence contract and
no §37 labelling rule, and a guess there would be a prediction rendered without
the rules §37 exists to impose. That remains a design task.

## The gate

Everything approved here ships behind `map_journey_intelligence_enabled`
(migration 2292), **seeded OFF**. Nothing above changes a single served byte
until the owner presses it.
