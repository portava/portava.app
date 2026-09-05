# §36 Phase 7 — World Intelligence, as built

**Date:** 2026-09-05
**Approved by:** the owner (see the AMENDMENT in `scope-ruling-phases-6-7.md`).
**Flag:** `map_world_intelligence_enabled`, migration lane 2295, seeded **OFF**.

One flag gates all four capabilities, because they are one capability: World
Pulse without the city model is a heat cell you cannot interrogate, and the
flow graph is the movement half of the same world view. Four switches would
invite the half-enabled state where a viewer sees an aggregate they have no way
to open.

## The contract

Four kinds were appended to §18 on both mirrors
(`artifacts/api-server/src/lib/mapObjects.ts` and
`travel-buddy-standalone/src/types/mapObjects.ts`), compared in order by
`src/test/mapObjectsContract.test.ts`.

| kind | geometry | privacy rung | §17 band | producer |
|---|---|---|---|---|
| `world_pulse` | Polygon (a coarse cell) | `aggregate_only` | world | `worldPulseProducer` |
| `traveler_flow` | LineString (city centroid → city centroid) | `aggregate_only` | world | `travelerFlowProducer` |
| `city_model` | Point (city centroid) | `aggregate_only` | city | `cityModelProducer` |
| `personal_city` | Point (city centroid) | `place_level`, owner-only | world | `personalCityProducer` |

All four are in `NEVER_AGGREGATED_KINDS`. None is a `FORECAST_KIND`, and each
payload carries an explicit `basis` naming an OBSERVED origin
(`observed_aggregates`, `observed_accepted_plans`, `observed_history`,
`observed_own_history`), so a renderer never has to infer whether it is drawing
a measurement or a guess.

## Where the numbers come from

`WORLD_INTELLIGENCE_K` is `mapAggregation.MIN_ZONE_COHORT`, which is
`PRIVACY_THRESHOLD_V1.minUniqueActors`. It is **borrowed, never chosen**, and
`resolveWorldIntelligenceK` may only ever tighten it; junk returns `NaN`, which
`meetsKAnonymity` fail-closes on.

A cohort is published as an `ActivityLevel` **bucket**, banded by
`activityForCohort` on multiples of k — §7's own ladder, not a new vocabulary.
So the buckets move with the threshold, the client already has the labels, and
the coarsest bucket a publishable cohort can land in is `quiet`. `bucketCohort`
returns `null` below k rather than the bottom rung, so a sub-k cohort cannot be
published as "very quiet".

## What each producer is allowed to read

**World Pulse** is PURE and takes `MapObject[]` — the §31 aggregation's own
output — so it has no database access and therefore no path to a presence row.
Its only people-bearing inputs are `activity_zone` (already past
`summarizeCell`'s floor) and `crowd_flow` (already past §10's four gates);
`place` and `event` contribute public density and carry no cohort. Everything
person-shaped and every forecast is in `PULSE_FORBIDDEN_SOURCE_KINDS`.

Two already-published aggregates in one cell can describe overlapping people, so
their sum is a **signal weight**, not a headcount, and only a bucket is
published. `payload.people` is `null` both for "nobody" and for "below k" —
`src/test/mapWorldIntelligenceLayer.test.ts` asserts the two serialize
identically, so suppression cannot become a signal in its own right.

**The traveler-flow graph** re-uses `lib/routeHopSignal.readAcceptedPlanHops`
with a CITY resolver where §10 injects a zone resolver. `ResolveZoneForPoint`
returns an opaque area id, so this is a coarsening rather than a new capability:
the 2224 consent record, the acceptance CHECK, the coordinate quarantine, the
group key and the Set-based counting all survive untouched, and each edge is
gated independently so a lone traveller's A→B→C cannot be read back out.

**The city model** consumes `compass_city_models` and gates each time slice on
`distinctActors` — never on `count`, which sums observations whose dedup key
holds no user id (IG-07's leak) — at 15 rather than Compass's own
`COMPASS_RHYTHM_K` of 5. Tighter is the only direction the map may take.
`topZones` come from the request's own already-k-gated activity zones.

**The personal city model** is owner-scoped by SESSION identity over
`passport_stamps`. It has no k floor because the cohort is one person and is
meant to be; what replaces the floor is that the object can never be about
anybody else.

## What was traded, and what was not

One thing moved relative to §10: the **signal-family** gate. Only
`accepted_plan` reaches city granularity (the other six families are audited in
`lib/crowdFlowProducer`'s header), so requiring `MIN_SIGNAL_FAMILIES` would make
the layer permanently and dishonestly empty. Instead a single-family edge is
capped at the weakest confidence band and declares `singleFamily: true`.

Signal-family count is a **confidence** gate. The k floor, the independent-group
minimum, the dominant-group ceiling and the publication delay are
`PRIVACY_THRESHOLD_V1` and did not move.

## Deliberately NOT built

* **Zone-level city rhythm ("top zones" from a per-zone cohort).** There is no
  per-zone distinct-actor aggregate in this repository, and building one would
  mean reading presence — the one thing the brief forbids. `topZones` is
  therefore the request's own already-k-gated activity zones, which is
  viewport-scoped and says so.
* **A `trip_destinations` signal family for the flow graph.** The rows exist and
  are city-granular, but they have no publication-consent record: 2224's
  `route_flow_contribution_consent` covers accepted route plans and nothing
  else. Adding the family would have meant publishing itineraries under a
  consent nobody gave.
* **Predicted city activity ("this Friday will be busy").** That is a
  `prediction` object built by the §15 temporal path and labelled as one, not a
  field on `city_model`. Folding a forecast into a kind that renders in the
  vocabulary of a measurement is the §37 failure.
* **Phase 6.** Untouched; still out of scope on the original ruling's reasoning.
