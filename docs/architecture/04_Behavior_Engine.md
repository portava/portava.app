# Behavior Engine — current state

*Derived from the repository, 2026-09-04. Defers to `docs/fact-layer-20260810/` and
`docs/discovery/event-truth-schema-packet.md`.*

## The store that exists: `rank_events` (mutable state, not an event log)

The only behaviour store the discovery surface writes today is `rank_events`
(migration `0153`). It is a **mutable-state** table, not an append-only event log:

- One row is written per **served item** at `served_at`.
- An **outcome** (tap / save / join / rsvp / attended) **UPDATEs that same row in place**
  (`outcome`, `outcome_at`; fact layer §4.1) rather than appending a second event.
- Assembly-phase analytics are written as separate rows tagged `outcome = 'analytics'`
  (`FeedSlotAllocator`), kept out of impression/outcome queries by that tag.

Because a row is overwritten by its own outcome, **behaviour chains as the original `04`
specified them are structurally impossible on this table**: the intermediate states are not
retained. This has not changed since the 2026-08-10 review; it is a property of the schema.

### The `living_page` defect is fixed

The review noted `rank_events` "silently dropped `living_page` for months": the `surface` CHECK
rejected values production code was already writing, and the rejects were swallowed. Migration
`0202` widened the CHECK to admit `living_page` and `watch_feed`, and `check:rank-events-surfaces`
now guards the surface set so a future writer cannot reintroduce a silently-rejected surface.

### Ranked-ness is now recorded on the row

Every serve-point writer since Stage 0 stamps `features.rankedInRequest` (true/false) on the
row, so whether a ranker ran during a request is a **fact on the row**, not an inference from its
serve point. This is what lets the pde serve path (which ranks cache-A points that legacy leaves
unranked) be measured correctly — see `01` and `06`, and the reader in
`lib/discoveryServePointReport.ts`.

## The store that is specified but NOT built: Event Truth

The roadmap's answer to the mutable-state problem is a separate **append-only Event Truth**
store (ROADMAP step 2) that can reconstruct, for a recommendation made months ago, what the
traveller saw, what viable alternatives existed, why each candidate was considered or removed,
what context held, and what the traveller eventually did.

**It is not built, by design.** `event-truth-schema-packet.md` answers the six-month
counterfactual **NO on the current system, on five independent grounds**, and step 2 is **gated
behind Phase B**. There are **no migrations** for Event Truth in the tree, and unit D3 added
none — building it now would violate the gate. The retention question the packet escalated is
*ruled* (owner 2026-08-15; packet §7): preserve the decision evidence (12 months) not every
sensitive input (raw context ≤ 90 days), and redefine reproducibility as reconstructing the
historical decision, not rerunning the computation.

**The governing invariant this store must one day encode** (ROADMAP): *absence of evidence must
never silently become evidence of absence* — a window with no rows is an investigation result,
not a measured zero.
