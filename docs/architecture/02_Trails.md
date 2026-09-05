# Trails — current state

*Derived from the repository, 2026-09-04.*

## Ruling: Trails as a peer scoring system is STALE

The original `02` proposed Trails as a first-class discovery primitive — permanent branching
discovery spaces with their own health and moderation, ranked as a **peer** of the other
components. The owner redirect of 2026-08-15 marks anything that "assumes the six P1 components
are peer scoring systems" as **STALE — must be re-scoped before implementation**
(`docs/discovery/ROADMAP.md`). ROADMAP **step 7** keeps trails only as a **future modifier** to
the ranker, never a parallel engine, and lists them alongside "graph, behaviour … and capped
`local_momentum` as modifiers only".

**Consequence for construction:** there is no Trails scoring engine to build or document as one,
and none is built. Unit D3 honoured this in two concrete places:

- **The graph does not admit a `trail` node kind.** Migration `2290` widened
  `compass_graph_nodes.node_type` to add `circle` and `experience` and *deliberately excluded*
  `trail`; the migration's postcondition **fails** if `trail` is ever admitted, and
  `CompassGraphEngine.GRAPH_NODE_KINDS` carries no `trail`. There is also no trail construct in
  the app to build such a node from.
- **No trail term enters `portavaRank`.** The ranker's modifiers are place-affinity and capped
  local momentum; trails are not among them.

## What of "trails" actually exists in the code

*Corrected 2026-09-05 — the previous sentence ("Only `lib/trailFollowup.ts`") was wrong: three more
modules and a mounted router carry the name.* None of them is the proposed Trails scoring primitive;
all of them sit on the intel-capture side (IG-06, `03`-adjacent) and are untouched by unit D3.

| Module | What it is | State |
|---|---|---|
| `lib/trailFollowup.ts` | §6 Exit/Movement vocabulary, the §13 movement-privacy threshold and confidence floor, the aggregate over captured `experience.next_move`, the AT-10 block filter, and the §14 outcome derivation. Pure functions, no table of its own. | mixed — see below |
| `lib/trailServe.ts` | The production caller of the aggregate + block filter; serves origin→destination cohorts for the INTERNAL dashboard (§29 Included). Applies the §13 cohort floor as a FILTER. | reads correctly; **cannot form a cohort** — see below |
| `lib/trailLiveIntel.ts` + `routes/trails.ts` | `GET /v1/trails/:id/live-intel` — the LIVE claims along a trail's (route_plan's) place stops, inheriting every live gate from `lib/liveClaimRead`. Mounted in `routes/index.ts`. | works server-side; **no client caller** |
| `routes/intel.ts` `GET /v1/internal/intel/trail/movement` | requireAdmin cohort read. Never publication. | works, but see the cohort note |

### The one thing that keeps IG-06 inert

`IntelCaptureService.writeObservation` derives a `group_key` **only for the `quick_signal` surface**.
`experience.next_move` is storable **only** on the `trail` surface, so no `next_move` row in
`intel_observations` can ever carry a group key — and `aggregateNextMoves` drops an ungrouped row
rather than counting it as an independent party (fail-closed, by design). The §13 independent-group
floor therefore **cannot clear** and `mayPublishMovement` can never return true for real data. The
internal read shows this WITHOUT publishing a number: `buckets` stays empty while
`withheldBelowFloor` stays true — "cohorts are forming and none has reached the floor", which is not
the same answer as "nobody is moving". It is pinned by a test, and it is the single blocker between
IG-06 and a working movement aggregate. Lifting it is an **owner decision** — it means asking, or
server-resolving, the "who are you here with?" signal on the Trail sheet as well — not a bug fix.

### Fixed 2026-09-05

`TRAIL_OUTCOME_VERBS` held `arrival_confirmed | next_stop | entry_succeeded | entry_failed` under a
comment claiming they mirrored `canonical_event_families` family `outcome`. They mirrored nothing:
the `canonical_events` verb CHECK (2120, widened by 2277) admits none of them, so the §14 derivation
could never count a real event and its test was green only because the fixture used the same phantom
vocabulary. The constant is now DERIVED from `lib/eventFamilies.VERB_FAMILY`
(`arrival | completion | rejection`) and guarded against the migration text.

The §26 flag chain (`INTEL_FLAG_DEPENDENCIES`: `intel_trail_followup → intel_capture_quick_signal`)
was declared and unit-tested but enforced nowhere for this surface; both the capture path and the
serve path now walk it, as `lib/liveClaimRead.liveLabelsServable` already did for its own chain.

`readTrailMovement` treated the §13 cohort floor as a **label, not a filter**. It built every bucket
as `{ ...aggregate, cohortFloorMet }` and served the lot, so a bucket standing on ONE person went to
an admin fully populated — `uniqueActors: 1`, `groups: 1`, `maxSingleGroupShare: 1`, plus the
(origin, destination area, 30-minute window) tuple naming where that person said they were going —
merely flagged `cohortFloorMet: false`. `requireAdmin` did not save it: *internal is an access
control, not an anonymity guarantee*, and differencing an unscoped read against an origin-scoped one
recovered the same number arithmetically. Sub-floor buckets are now dropped **before** projection,
and `TrailMovementBucket` is an enumerated projection rather than a spread of the internal aggregate,
so no present or future field of `OriginDestAggregate` can reach the wire by default. The refusal
stays visible as `withheldBelowFloor`, a monotone existence bit — `f(A ∪ B) = f(A) ∨ f(B)` is not
invertible, so no combination of scopes recovers a magnitude. Three read-level counts computed over
rows that were never served went with it: `droppedUngrouped` and `droppedIneligible` became existence
bits, and the AT-10 `hiddenByBlock` count was removed outright — announcing that a blocked person's
contribution exists is the one thing AT-10 is for hiding.

`MOVEMENT_PRIVACY_V1` hard-coded `PRIVACY_THRESHOLD_V1`'s five values instead of deriving them, so
tightening the shared gate would have left every movement reader on the old floor with nothing red to
show for it. It is now derived, and the derivation is pinned field by field.

**If Trails is ever revived** it must be re-scoped first (the ruling), and any graph
representation would come through a *new* migration lane admitting a `trail` node with a real
source — not by relaxing `2290`.
