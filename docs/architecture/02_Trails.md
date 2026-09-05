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
| `lib/trailServe.ts` | The production caller of the aggregate + block filter; serves origin→destination cohorts for the INTERNAL dashboard (§29 Included). | reads correctly; **cannot form a cohort** — see below |
| `lib/trailLiveIntel.ts` + `routes/trails.ts` | `GET /v1/trails/:id/live-intel` — the LIVE claims along a trail's (route_plan's) place stops, inheriting every live gate from `lib/liveClaimRead`. Mounted in `routes/index.ts`. | works server-side; **no client caller** |
| `routes/intel.ts` `GET /v1/internal/intel/trail/movement` | requireAdmin cohort read. Never publication. | works, but see the cohort note |

### The one thing that keeps IG-06 inert

`IntelCaptureService.writeObservation` derives a `group_key` **only for the `quick_signal` surface**.
`experience.next_move` is storable **only** on the `trail` surface, so no `next_move` row in
`intel_observations` can ever carry a group key — and `aggregateNextMoves` drops an ungrouped row
rather than counting it as an independent party (fail-closed, by design). The §13 independent-group
floor therefore **cannot clear**, `cohortFloorMet` can never be true, and `mayPublishMovement` can
never return true for real data. This is visible in the numbers (`droppedUngrouped`) and is pinned by
a test, but it is the single blocker between IG-06 and a working movement aggregate. Lifting it is an
**owner decision** — it means asking, or server-resolving, the "who are you here with?" signal on the
Trail sheet as well — not a bug fix.

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

**If Trails is ever revived** it must be re-scoped first (the ruling), and any graph
representation would come through a *new* migration lane admitting a `trail` node with a real
source — not by relaxing `2290`.
