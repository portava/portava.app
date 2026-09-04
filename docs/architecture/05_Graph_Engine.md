# Graph Engine — current state

*Derived from the repository, 2026-09-04.*

A graph engine already ships. It is `CompassGraphEngine` (Compass Phase 15), rebuilt on a
schedule (`intelligenceGraphScheduler`) from data the app already collects. The original `05`
described *building* one; this document describes the running one and the two node kinds unit D3
added.

## The substrate: typed nodes and edges

Two service-role-only tables (`20260730_compass_intelligence_graph.sql`):

- `compass_graph_nodes` — typed nodes, `node_type` bounded by a CHECK constraint.
- `compass_graph_edges` — typed, timestamped, observation-counted edges. Cross-trip
  relationships persist: a returning visitor accumulates `observed_count` on the visited edge and
  gains an explicit `returned_to` edge on a second trip.

`buildGraphFromSources` (`CompassGraphEngine.ts`) is the batch builder. Its fail-soft upserts
mean a builder that emits an unknown `node_type` writes rows the DB **silently rejects** — so the
admitted kinds are mirrored in code as `GRAPH_NODE_KINDS`, and a test pins that list to the CHECK
so the mismatch is caught at build time, not lost at runtime.

## Node kinds

The nine original kinds: `person`, `place`, `event`, `trip`, `city`, `time_slice`, `vibe`,
`behavior`, `outcome`. Unit D3 (migration `2290`) admits two more that `05` names and the app has
real sources for:

| Kind | Source | Builder | Edges emitted |
|---|---|---|---|
| `circle` | `public.circles` (owner, city, visibility) + `events.circle_id` | §6 | `person —owns_circle→ circle`, `circle —in_city→ city`, `event —hosted_by→ circle` |
| `experience` | `public.memories` (published, not `only_me`) | §7 | `person —experienced→ experience`, `experience —at_place / during_trip / at_event / in_city→ …` |

Privacy is built into the builders, not bolted on:

- The `circle` node carries only **visibility** and the canonical **city** — never the
  member-authored name or description. `circle_memberships` (a person↔person pairing) is **not**
  read: a person-to-person edge is a social fact the read-time privacy guards were not designed to
  aggregate.
- The `experience` node reads **only published** memories and **never `only_me`** ones — that
  visibility is the owner's explicit choice and the graph does not override it even under
  service_role (filtered in the query *and* re-checked per row). The node carries which anchors
  exist (`has_place`/`has_trip`/`has_event`) and the country — never the title, caption or media.

`trail` is **deliberately not admitted** (ROADMAP: Trails as a peer system is STALE; there is no
trail construct to source from). Migration `2290`'s postcondition fails if `trail` ever appears
in the CHECK. See `02`.

## Derived reads: world model and city confidence

- **Destination world model** (`compass_city_models`) — per-city time-sliced activity profiles
  (day-of-week × daypart, plus seasonal buckets) derived from the graph.
- **City confidence** (`compass_city_confidence`, `computeCityConfidenceIndex` →
  `getCityConfidence`) — a per-city **data-depth** score 0–100 with a tier, built from aggregate
  graph signals (visitors, returners, events, outcomes, slice coverage). It says how much the
  world model *knows* about a city; it says nothing about any individual place.

Unit D3 lets the discovery ranker consume city confidence as a **bounded, documented input**
(`lib/discoveryModifiers.ts`): it scales `local_momentum` in `[0.5, 1.0]` and sets the
exploration-governor budget in `[15, 25] %` — thin cities trust velocity less and explore more.
It is **never** a per-candidate feature, and absence of a confidence row defaults to the *thin*
end (absence of evidence ≠ knowing enough). This consumption is behind
`discovery_ranking_modifiers_enabled` (seeded OFF); with the flag off, no confidence read
happens. See `06`.
