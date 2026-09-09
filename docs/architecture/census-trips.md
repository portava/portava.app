# Portava Trips v4 — Requirement Census

| Field | Value |
| --- | --- |
| **Spec** | `docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt` |
| **`.docx` reconciliation** | Extracted `word/document.xml`, stripped tags, whitespace-normalised, diffed against the `.txt`. **The only differences are two XML entity escapes** (`&lt;` in §7.2's invariant, `&gt;` in §8.4's crew-transport row). The `.txt` is a faithful transcription; the "`.docx` is authority" clause never had to be exercised. |
| **Section count** | The brief said 25 sections. **25 top-level sections is correct** — and it is a serious undercount of the spec, which carries **80 numbered subsections** plus **Appendix A and Appendix B**: 107 numbered units. §4 alone (four subsections) is 28 requirements; §5 (three) is 26. A census scoped to "25 sections" would miss most of the document. |
| **Tree censused** | `claude/portava-continuation-uqta94`, HEAD `68ed59d9`. Backend paths relative to `artifacts/api-server/src/`, client paths to `travel-buddy-standalone/`, root migrations to `migrations/`. |
| **Database** | Not queried. Production storage facts come from the supplied ground truth and the committed snapshot `artifacts/api-server/baseline/20260907_production_tables.txt`. |
| **Method** | Requirement-level, four buckets, one bucket per requirement. Every BUILT verdict cites a `file:line` that was opened and read. |
| **Sibling** | `docs/architecture/census-media.md`, produced in the same pass under the same denominator rule, so the two are directly comparable. Media scores 80.0 % constructed / 64.7 % correct / **48.0 % spec-attributable** — the contrast is the most useful thing either document says. |

---

## Headline

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **451** |
| BUILT-AND-CORRECT | **78** |
| BUILT-BUT-WRONG | **110** |
| NOT-BUILT | **262** |
| CANNOT-VERIFY | **1** |
| **CONSTRUCTED%** = (C+W)/451 | **188 / 451 = 41.7 %** |
| **CORRECT%** (raw) = C/451 | **78 / 451 = 17.3 %** |
| **CORRECT% (spec-attributable)** | **0 / 451 = 0.0 %** |
| CANNOT-VERIFY share | **1 / 451 = 0.2 %** |

> ### ⚠ SUPERSEDED 2026-09-08 — read §26 before this section
>
> **The central claim below is now false, and it is the largest single error in
> this corpus.** It was true when measured at `68ed59d9`. A Trip Kernel programme
> landed afterwards — ten commits, five `*trip_kernel*` migrations — and nothing
> aged this document, because it declared no `head_commit` and had no
> `CENSUS_SCOPE` entry to age it with.
>
> Both greps below were re-run at HEAD. The first now returns **47 files**. The
> second, the one called "the whole story in one line", returns **34**;
> `aggregate_version` alone occurs in **17**. `2420_trip_kernel_foundation.sql`
> cites this spec by section number in its own header (§4.3, §5.1), which is the
> precise thing the claim says it could not find.
>
> Twelve of §4's fourteen NOT-BUILT rows are corrected in place. The headline
> figures below are the `68ed59d9` measurement and are left standing as the
> record of it; §26 carries the recount.

Read the third-from-last row first. **Not one artifact in this tree was built for this
specification, and I could not find one that has ever heard of it.**

```
grep -rliE "trips (development )?architecture spec|trip kernel|TripTodayProjection|Temporal Freedom" \
  --include=*.ts --include=*.tsx --include=*.sql --include=*.md . \
  --exclude-dir=node_modules --exclude-dir=docs/specs
→ docs/architecture/census-sensing.md   (a sibling census quoting a *different* spec)
```

```
grep -rli "trip_command\|TripCommand\|trip_events\|TripKernel\|aggregate_version\|expectedTripVersion\|sourceTripVersion" \
  artifacts/api-server/src travel-buddy-standalone/src migrations
→ (no matches)
```

*(Both greps above are the `68ed59d9` results, preserved as the record. At HEAD the
first returns 47 files and the second 34 — see the superseded notice.)*

The second grep is the whole story in one line. §4 is the Trip Kernel — commands, an event
envelope, an outbox. §19 requires every projection to carry `sourceTripVersion`. §22.4 makes
"projection `sourceTripVersion` may never exceed canonical aggregate version" a property
invariant. **The string `aggregate_version` does not occur anywhere in this repository.**
There is no version column on `trips`, no command type, no domain event, no outbox, no
snapshot, no replay.

**The trap this census had to avoid.** Production carries 26 `trip_*` and `route_*` tables
and they are all deployed. That looks like completeness and is not: **not one of the
fifteen tables §5.1 specifies exists in the shape it specifies, and eleven do not exist
at all** — `trip_stages`, `trip_legs`, `trip_commitments`, `trip_plan_participants`,
`trip_goals`, `trip_decision_tasks`, `trip_risks`, `trip_presence`, `trip_proposals`,
`trip_snapshots`, `trip_outcomes`. Three more exist only as differently-shaped ancestors
(`trip_members` for `trip_participants`, `trip_plan_items` for `trip_plans`,
`trip_activity_log` for `trip_events`), and `trips` itself is missing `version`,
`current_stage_id` and `home_timezone` — the three columns the kernel needs. What is
deployed is a different, older,
CRUD-shaped schema — `trips`, `trip_members`, `trip_plan_items`, `trip_destinations`,
`trip_notes`, `trip_checklists`, `trip_documents`, `trip_reservations` and so on — that
predates this document and answers a smaller question.

So the honest summary is: **Trips is a large, working, well-tested itinerary-and-crew
product, and this specification asks for a journey kernel that has not been started.** The
number below is not low because the code is bad. It is low because the code is a different
system.

---

## 1. Denominator: how 451 was counted

Identical rule to the Media census in this directory, so the two are comparable:

- **A bullet asserting a required property or prohibition = 1.** (§1.2's four non-goals,
  §6.2's four RLS principles, §22.4's six property invariants, §25's closing principle.)
- **A table row naming a required artifact, state, check, metric or scenario = 1.**
  (§1.1's five responsibilities, §3.2's eight phases, §5.1's fifteen tables, §5.3's five
  data classes, §7.4's four checks, §8.4's four risks, §11.3's five actions, §16.1's five
  signal interpretations, §18.3's four conflict strategies, §21.1's eight metrics, §23's
  eleven scenarios.)
- **A declared interface = 1 for the contract**, plus one per member carrying independent
  behaviour. §11.1's `TripTodayProjection` is 13 (the contract plus twelve fields each of
  which is a distinct thing that must be produced); §7.1's `Commitment` is 6; §4.3's
  `TripEvent` is 6.
- **A named object, tool, endpoint, event, reason-code family or package boundary = 1.**
  §2.1's seventeen domain objects; §4.2's ten domain events; §12.1's twelve Compass tools;
  §19.1's eight projections; §19.2's nine endpoints; Appendix B's eleven reason-code
  families.
- **ASCII diagrams contribute 0** (§1's kernel diagram, §3.1's arrow chain and §3.3's plan
  chain are counted as *state machines*, one requirement each, not per arrow).
- **Narrative and restatement = 0.** §1's opening paragraph, §21.3's north-star framing,
  and — the big one — **§24 and §25 are almost entirely restatement**. §24's six phases
  re-list §4/§5/§7/§9/§11/§18/§19 content already counted; only three clauses are new
  (Phase 0's inventory-and-freeze, Phase 1's direct-write ratchet, Phase 6's independent
  safety gates). §25's ten definition-of-done bullets restate §4/§7/§9/§10/§18/§19/§20/§22
  verbatim in checklist form; only the closing architecture principle is new. This follows
  the sensing census's ruling on its own §23 "paste-ready" restatement, and it is the
  single largest judgement call in this denominator — counting §24/§25 in full would add
  17 rows that are all duplicates of rows already scored NOT-BUILT and would flatter
  nothing.
- **Appendix A is hedged "Recommended"**, so it contributes its three package boundaries
  rather than its twenty directories.

Per-section contribution:

`§1 1 · §1.1 5 · §1.2 5 · §2.1 17 · §2.2 3 · §2.3 3 · §3.1 3 · §3.2 8 · §3.3 3 · §4.1 9 ·
§4.2 10 · §4.3 6 · §4.4 3 · §5.1 15 · §5.2 4 · §5.3 5 · §6.1 11 · §6.2 4 · §6.3 6 ·
§7.1 6 · §7.2 3 · §7.3 3 · §7.4 4 · §8.1 2 · §8.2 2 · §8.3 2 · §8.4 4 · §9.1 3 · §9.2 2 ·
§9.3 3 · §9.4 1 · §10.1 7 · §10.2 3 · §10.3 6 · §10.4 7 · §11.1 13 · §11.2 1 · §11.3 5 ·
§11.4 3 · §12.1 12 · §12.2 6 · §12.3 2 · §12.4 2 · §13.1 9 · §13.2 11 · §13.3 10 ·
§14.1 11 · §14.2 7 · §14.3 8 · §14.4 3 · §15.1 5 · §15.2 3 · §15.3 6 · §15.4 2 · §16.1 6 ·
§16.2 7 · §16.3 2 · §17.1 2 · §17.2 4 · §17.3 9 · §17.4 5 · §18.1 9 · §18.2 7 · §18.3 4 ·
§18.4 2 · §19.1 13 · §19.2 9 · §19.3 1 · §19.4 2 · §20.1 2 · §20.2 7 · §20.3 1 · §20.4 2 ·
§21.1 8 · §21.2 3 · §21.3 1 · §22.1 1 · §22.2 3 · §22.3 3 · §22.4 6 · §23 11 · §23.1 5 ·
§24 3 · §25 1 · App A 3 · App B 11` = **451**.

### The rule for prohibitions and for "a table exists"

Two rules decide more verdicts here than anywhere else:

1. **A prohibition is BUILT-AND-CORRECT only when a concrete artifact refuses the
   violation** — a type, a CHECK, an explicit refusal branch, a gate. A prohibition whose
   forbidden path merely does not exist, with nothing preventing it being added, is
   **NOT-BUILT (unguarded absence)**. This is the sibling censuses' rule and it costs
   Trips several rows in §1.2 and §12.2 where the "boundary" is really an absence.

2. **A table nothing writes satisfies nothing, and a table with a different shape is not
   the specified table.** `trip_plan_items` is not `trip_plans`; `trip_members` is not
   `trip_participants`. Where the deployed table discharges the *responsibility* under
   another name and shape, the verdict is **W** with the divergence named; where the
   responsibility itself is absent, **N**.

### Method caveat inherited from `src/scripts/checkWriterlessReads.ts`

That script declares its own writer attribution INCOMPLETE (*"A dynamic `.from(expr)`
anywhere makes attribution incomplete"*). Every "nothing writes X" here was settled by
opening call sites — `trip_activity_log`'s only writer is the `logActivity` helper at
`routes/trips-expansion.ts:49-60` and I enumerated its eleven call sites (`:433,461,517,539,588,658,738,817,1379,1527,1630`)
rather than trusting a grep.

---

## 2. Attribution

**0 / 451 = 0.0 %.** This matches the two sibling censuses that tested the same question
and disagrees with the Media census in this directory, which found 48 %.

Every BUILT verdict below traces to one of five *other* programmes, each of which names
itself in its own file headers or migration titles:

| Programme | Evidence it is not this spec | What it produced |
| --- | --- | --- |
| **The original Portava spine** | `migrations/0001_spine.sql:72,100` creates `trips` and `trip_members` with `trip_status` as a five-value enum; no spec citation, predates every architecture document in `docs/specs/`. | `trips`, `trip_members`, plan permission, invites |
| **Trips Expansion** | `0077_trips_expansion.sql`, `0078_trip_members_expansion.sql`, `0079_trip_sub_tables.sql`; `routes/trips-expansion.ts` (2,655 lines of CRUD) | destinations, budget, documents, notes, saved places, checklists, reminders, activity log, join requests, invite links |
| **Trip Crew Location / Safe Return** | `0041_trip_crew_location.sql`, `0065_phase7_safety.sql`, `0167_safety_ddl_reconcile.sql`; `lib/tripCrewLocation.ts:1-16` states its own privacy contract with no spec reference | crew map, ghost mode, live share, Safe Return sessions |
| **Trip Readiness / Reservations / Budget Intel** | `0170_trip_readiness.sql`, `0172_trip_reservations.sql`, `0183_budget_fx_conversion.sql`; `lib/tripReadiness.ts:1-18` describes a seven-category engine, again with no spec reference | readiness items, next-best-action, arrival board, paste-to-import reservations, cost estimates |
| **Compass** | `compass/CompassTools.ts:14` — *"`add_to_trip` proposes only. The server holds the proposal; nothing is [written]"* | three trip tools, the propose-only boundary |

None of these cites this spec, and none of them uses its vocabulary. The closest thing to
a §4 command in the tree is `CompassTools.ts:158-170`'s `add_to_trip`, which is a
proposal-only tool built for the Compass programme and predates this document.

---

## 3. Requirement-by-requirement

Verdict key: **C** BUILT-AND-CORRECT · **W** BUILT-BUT-WRONG · **N** NOT-BUILT ·
**?** CANNOT-VERIFY. A cell reading `**N** ×9` is one verdict applied to the consecutive
ids named in that row; each id remains individually addressable.

### §1 Executive Architecture · §1.1 Core responsibilities · §1.2 Non-goals

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR1 | Primary invariant: all consequential state changes pass through the Trip Kernel; no Map/Compass/Telegraph/Discovery/Buddy/UI component may independently invent canonical trip state | **N** | There is no kernel. `routes/trips.ts:1491-1535` writes `trip_plan_items.status` directly from a PATCH body; `routes/trips-expansion.ts:516` writes `trips.status` directly; `routes/tripReservations.ts:189,263` writes reservations directly. Twelve route files mutate canonical trip tables with no common command path. The one component that *does* respect the invariant does so by accident of its own programme (`compass/CompassTools.ts:14`). |
| TR2 | Trips owns canonical journey state (identity, stages, legs, commitments, plans, participants, permissions, active phase) | **W** | Identity, participants and permissions: yes (`migrations/0001_spine.sql:72,100`; `lib/http.ts:534` `canEditPlan`). Stages, legs, commitments and active phase: **no table and no type** (§5.1, §3.2). Plans exist as `trip_plan_items` (`0010_trip_plan.sql:5-30`), a flat day-keyed list, not the §2.1 `Plan`. |
| TR3 | Trips owns coordination (group availability, attendance, subgroups, meeting points, proposals, votes, readiness) | **W** | Availability: `trip_availability` (in production) + `components/TripAvailabilitySection.tsx`. Readiness: `lib/tripReadiness.ts`. Attendance, subgroups, meeting points, proposals and votes: **absent** — `grep -rli "attendance\|subgroup\|trip_proposal" ` over the trip paths returns nothing. Two of seven. |
| TR4 | Trips owns execution (Now/Next, free windows, route chains, plan start/complete, transport, disruption recovery) | **W** | "Today / Next Up" exists as a **client-side** derivation over the fetched plan list (`src/components/TripPage.tsx:155-171`), and plan completion exists as a status value (`0010_trip_plan.sql:12-13` `'done'`). Free windows, route chains, transport state and disruption recovery: absent. |
| TR5 | Trips owns context distribution (stable typed projections for Compass, Map, Telegraph, Discovery, Safety, Passport, Memory) | **W** | Exactly one typed projection exists and it points the wrong way: `services/passport/PassportConsumerProjections.ts:31` gives **Trips** a stripped Passport view, not Passport a Trip projection. Compass reads raw tables (`CompassTools.ts:405-452` selects from `trip_members`, `trips`, `trip_plan_items` directly). There is no `TripContext` type anywhere. |
| TR6 | Trips owns history (immutable domain events, decisions, snapshots, replay references, durable outcomes) | **N** | No events (§4.2), no decision ledger (§21.2), no snapshots (§22.1), no replay (§22.2), no outcomes (§20.1). `trip_activity_log` (`0079_trip_sub_tables.sql:240-247`) is a best-effort audit line, not domain history — see TR58. |
| TR7 | Trips does not become a booking engine | **C** | `0172_trip_reservations.sql:1-6` stores references and operational facts only; no payment column, no provider API, no inventory. The nearest booking system is Rent-a-Buddy and it is a separate domain. |
| TR8 | Trips does not become a payment ledger | **C** | `trip_budget` (`0079`) holds planned amounts; `0183_budget_fx_conversion.sql` converts currency for display. No ledger, no transaction table, no settlement. |
| TR9 | Trips does not become a generic messaging system | **C** | `app/trip/chat.tsx` routes into the existing Telegraph/messaging domain (`src/services/messaging.ts` `openTripChat`, used at `TripPage.tsx:203-208`); Trips stores no messages. |
| TR10 | Trips does not become a global location tracker | **C** | `lib/tripCrewLocation.ts:1-16` — exact coordinates are released only under an *active live-share grant* and are withheld anyway when hotel blur is on (`:104-146` `resolveExactCoords`); ghost mode is absolute (`:119-122`); the whole surface is behind `trip_crew_map_enabled`, seeded false (`0041_trip_crew_location.sql:63`). |
| TR11 | Specialist domains retain ownership of regulated or sensitive state | **C** | Safety lives in `services/safeReturn/` with its own tables (`0167_safety_ddl_reconcile.sql:21`), documents in `trip_documents`, identity in `services/identityVerification/`, payments outside Trips entirely. Trips references, it does not absorb. |

### §2.1 Canonical domain objects

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR12 | `Trip` — journey container and **versioned** aggregate root | **W** | `migrations/0001_spine.sql:72-89` is the container: id, owner, title, destination, dates, status, visibility, progress. It carries **no `version` column**, so it is a row, not an aggregate root — and every §4.1/§18.4/§19.1/§22.4 requirement that depends on a version depends on this one absence. |
| TR13 | `TripStage` — a bounded stay/context in a city, region, cruise stop, event or long-stay location | **W** | `trip_destinations` (`0077_trips_expansion.sql`) is the nearest thing: an ordered list of cities on a trip. It has no timezone, no state, no `starts_at`/`ends_at` as a stage boundary, and nothing hangs off it — plans key to `day_date`, not to a stage (`0010_trip_plan.sql:18`). A destination list is not a stage graph. |
| TR14 | `TripLeg` — movement/context transition (stay, transit, layover, road trip, day trip, event, cruise stop) | **N** | No leg concept. `route_legs` (`0058_trip_flow.sql:102-107`) is a geometry edge between two route stops inside a route plan — a different object at a different altitude, with no leg type and no stage endpoints. |
| TR15 | `Commitment` — hard/soft obligation with required-arrival semantics | **N** | No commitment table, type or column. `trip_plan_items` has `starts_at`/`ends_at` and a `lock_type`, and no `required_arrival_at`, `flexibility`, `prep_duration` or `lateness_tolerance`. |
| TR16 | `Plan` — executable or proposed real-world activity | **W** | `trip_plan_items` (`0010_trip_plan.sql:5-30`) is the plan object. It is flat (no stage), day-keyed rather than instant-ordered, `status` is `confirmed\|tentative\|done\|cancelled` (`:12-13`) rather than the §3.3 machine, and it has no participants relation, no privacy scope and no version. |
| TR17 | `ReservationRef` | **C** | `0172_trip_reservations.sql:10-31` — `confirmation_ref`, `cancellation_deadline_at`, typed `flight\|stay\|activity\|transport\|other`, and an explicit `pending_confirm` state so an LLM extraction never auto-commits (`:1-6`). This is the best-built object in §2.1. |
| TR18 | `TransportSegment` | **N** | `grep -rli "TransportSegment\|transport_segment"` → nothing. `trip_plan_items.category` admits `'transport'` (`0010:11`) as a label; there is no segment object, no mode, no planned departure/arrival pair, no party size, no reliability. |
| TR19 | `TripParticipant` — with role, membership_state, permissions_version | **W** | `trip_members` (`0001_spine.sql:100-106`) has `trip_id, user_id, role, created_at` and a primary key. No `membership_state` (join requests live in a separate `trip_join_requests` table) and no `permissions_version`, so a permission change has no version to invalidate a cached projection against. |
| TR20 | `TripGoal` | **N** | No goal table, type or column anywhere. |
| TR21 | `TripDecisionTask` | **N** | No decision-task table or type. `trip_readiness_items` (`0170`) is the nearest artifact and is a *derived* checklist recomputed on read (`lib/tripReadiness.ts:24-25`), not a work item with a deadline, an assignee and a consequence. |
| TR22 | `TripRisk` | **N** | No risk table or type. |
| TR23 | `TripPresence` | **W** | Presence exists but not as a Trip object: `trip_crew_location_sessions` + `trip_crew_location_preferences` + `user_location_state`, assembled at `lib/tripCrewLocation.ts:104` into a `CrewMemberCard`. There is no per-participant presence row carrying `presence_state`, `confidence` and `expires_at` on the Trip (see TR159–TR165). |
| TR24 | `TripCrew` / `Subgroup` | **N** | No subgroup concept. `services/tripCrew/` exists and operates on the whole crew. |
| TR25 | `SavedIdea` | **C** | `trip_saved_places` (`0079_trip_sub_tables.sql`), served at `routes/trips-expansion.ts:2085,2110,2163`, with a client hook (`src/hooks/useTripSavedPlaces.ts`) and a `SavedIdea` type in `src/types/models.ts`. |
| TR26 | `TripProposal` | **N** | No proposal table or governance type. `CompassTools.ts:158-170` returns a *pending proposal object to the UI* — an in-memory handoff, not a stored `TripProposal` with `decisionRule`, `affectedObjects` and `expiresAt`. |
| TR27 | `TripSnapshot` | **N** | No snapshot table or type (§22.1). |
| TR28 | `TripOutcome` | **N** | No outcome table or type. `POST /trips/:tripId/complete` (`routes/trips-expansion.ts:494-518`) flips a status and writes a log line; nothing records what happened. |

### §2.2 Aggregate boundary · §2.3 Canonical IDs

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR29 | The Trip aggregate owns ordering and invariants that require a coherent version | **N** | No version exists (TR12), so no invariant can be expressed against one. Ordering is per-table `sort_order`/`order_index` columns with no aggregate guarantee. |
| TR30 | Large read models are projections, not transactionally embedded payloads | **C** | Vacuously but genuinely: every read endpoint assembles from source tables at request time (`routes/trips-expansion.ts:2572` `GET /trips/:tripId`), and no trip row carries a denormalised payload blob. The requirement's forbidden shape is absent and the correct shape is what ships. |
| TR31 | High-volume ephemeral signals stay in specialist stores and are referenced by stable IDs | **C** | Location samples live in `user_location_state` / `trip_crew_location_events`, chat in the messaging domain, crowd intel in `intel_*`. `trip_plan_items` references places by `source_id` (`0010:16`), never by embedding. |
| TR32 | Never substitute one domain ID for another because names or coordinates look similar | **C** | Enforced by a standing ratchet rather than convention: `lib/placeIdBridge.ts` is the only sanctioned crossing, and `scripts/checkSchemaReferences.ts` + `scripts/checkWritePathColumns.ts` fail the build on an unsanctioned one. `0010_trip_plan.sql:16-17` types the external reference as `source_id text` with an explicit `source_type`. |
| TR33 | All cross-domain linkage uses explicit foreign keys or reconciliation records | **W** | True for in-domain links (`trip_plan_items.trip_id`, `route_plans.trip_id` at `0058:12`). False for the place link: `trip_plan_items.source_id` is `text` (`0010:16`) with no FK and no reconciliation record, so a plan item pointing at a deleted or merged place is undetectable. |
| TR34 | Place, hidden-gem, event, booking, buddy and flight IDs remain distinct until a canonical bridge exists | **C** | `lib/placeIdBridge.ts` is the bridge and is the only one; hidden gems carry their own `canonical_place_id` (`2044_hidden_gems_canonical_place_id.sql`) rather than being conflated; `trip_reservations` keeps a provider `confirmation_ref` as opaque text. |

### §3 Lifecycle and State Machines

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR35 | Primary lifecycle IDEA → PLANNING → BOOKED → PRE_DEPARTURE → TRAVELING → IN_DESTINATION → RETURNING → COMPLETED → MEMORY, plus DISRUPTED / CANCELLED / ABANDONED / ARCHIVED | **W** | `migrations/0001_spine.sql:10` — `trip_status as enum ('planning','upcoming','active','completed','cancelled')`, extended in practice by `'draft'` and `'archived'` (`lib/tripStatus.ts:38,40`). Seven states against thirteen: BOOKED, PRE_DEPARTURE, TRAVELING vs IN_DESTINATION vs RETURNING, MEMORY, DISRUPTED and ABANDONED have no representation, so the states that carry the spec's operational meaning are exactly the missing ones. |
| TR36 | Lifecycle is computed from canonical facts plus explicit user actions | **C** | `lib/tripStatus.ts:29-46` `computeTripStatus` derives the state from title/city presence and date boundaries **in the trip's own timezone**, honours terminal states, and `:1-10` records why it exists: two copies had diverged, one comparing UTC midnight, so *"the same trip could read 'upcoming' on one endpoint and 'active' on the other around the day boundary."* The header ends *"Never let clients override this."* |
| TR37 | Do not store boolean soup such as isActive/isStarted/isFinished/isTraveling | **C** | `trips` has no such column (`0001_spine.sql:72-89`), and the client derives display state rather than trusting the stored one (`src/components/TripPage.tsx:58-60`, `src/lib/tripStatus.ts` `deriveTripDisplayStatus`) — the prohibition is honoured on both sides. |
| TR38–TR45 | §3.2 active operational phase: ARRIVAL_DAY · FREE_TIME · ACTIVE_PLAN · TRANSIT · NIGHTLIFE · REST · DEPARTURE_DAY · DISRUPTED, each with its own primary UI/behaviour | **N** ×8 | There is no phase concept at all: no column, no enum, no derivation, no UI switch. `grep -rli "ARRIVAL_DAY\|FREE_TIME\|ACTIVE_PLAN\|DEPARTURE_DAY"` over the whole tree returns nothing. The nearest artifact is `routes/tripReadiness.ts:344` `GET /trips/:tripId/arrival-board`, which is an arrival *list*, not an arrival-day phase, and it is behind `trip_readiness_enabled`, seeded false (`0170_trip_readiness.sql:76`). |
| TR46 | Plan state machine DRAFT → PROPOSED → CONFIRMED → IN_PROGRESS → COMPLETED, with AT_RISK / MOVED / CANCELLED / SKIPPED | **W** | `0010_trip_plan.sql:12-13` — `'confirmed' \| 'tentative' \| 'done' \| 'cancelled'`. Four states against nine, and the three that carry operational meaning (IN_PROGRESS, AT_RISK, MOVED) are all absent, so a plan cannot be started, cannot be flagged at risk, and cannot record that it moved. |
| TR47 | State transitions must be commands with authorization, validation, audit and idempotency | **W** | Authorization and validation are real: `routes/trips.ts:1503-1509` runs `UpdatePlanItemSchema.safeParse` then `canEditPlan` then `canEditPlanItem` before any write. Audit and idempotency are absent — the plan-item PATCH writes no activity-log row (the eleven `logActivity` call sites are all in `trips-expansion.ts` and none covers plan items), and there is no idempotency key anywhere in the trip paths. And it is not a command: `:1520-1533` builds a column patch from the request body and issues an `update`. |
| TR48 | UI must not directly update plan status columns | **W** | It does, one hop removed. `routes/trips.ts:1523` — `if (patch.status !== undefined) dbPatch.status = patch.status;` — the client's chosen status string is copied into the column with no transition validation: `done → tentative`, `cancelled → confirmed`, any pair is accepted. The HTTP layer is doing exactly what §3.3 forbids the UI from doing. |

### §4 Trip Kernel: Command + Event Architecture

Nothing in this section exists. The evidence is one grep, run over
`artifacts/api-server/src`, `travel-buddy-standalone/src` and `migrations/`:
`trip_command|TripCommand|trip_events|TripKernel|aggregate_version|expectedTripVersion|sourceTripVersion`
→ **no matches**.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR49 | The `TripCommand` envelope (commandId, tripId, actorUserId, expectedTripVersion, idempotencyKey, type, payload, clientObservedAt) | **C** | **Moved N→C in the §26 recensus.** The row said "No type, no table, no route." All three exist: the envelope is `lib/tripKernel.ts:248#TripCommand` (commandId, tripId, actorUserId, expectedTripVersion, idempotencyKey, type, payload), the receipt table is `migrations/2420_trip_kernel_foundation.sql:139#trip_command_receipts`, and the route is the `trip_kernel_execute` RPC that `lib/tripKernel.ts:538#executeTripCommand` calls. |
| TR50 | A typed command vocabulary (ADD_PLAN, MOVE_PLAN, CONFIRM_PLAN, CANCEL_PLAN, JOIN_PLAN, LEAVE_PLAN, CREATE_SUBGROUP, SET_PRESENCE, CREATE_PROPOSAL, ACCEPT_PROPOSAL, COMPLETE_ACTIVITY) | **N** | None of the eleven exists as a command. Four have a *route* that does something adjacent (`POST /trips/:id/plan/items`, `PATCH …/items/:itemId`, `POST /trips/:id/complete`); seven have no analogue at all. |
| TR51 | Command service validates schema | **C** | This one requirement is genuinely met by the CRUD layer: every trip write parses a zod schema first (`routes/trips.ts:1499-1501`; `routes/tripReservations.ts` schemas; `routes/trips-expansion.ts` per-endpoint schemas). It is validation without a command service, which is the requirement's testable half. |
| TR52 | …validates actor capability | **C** | `lib/http.ts:534` `canEditPlan` and `:594` `canEditPlanItem` are called before every plan mutation (`routes/trips.ts:1505-1509,1443,1573`), and membership is checked through the shared `lib/tripMembership.ts:23` `isAcceptedTripMember`. |
| TR53 | …validates aggregate version | **C** | **Moved N→C.** The row said "No version exists." `trips.version` is added by `2420_trip_kernel_foundation.sql:96#version` and the kernel refuses a mismatch: `2590_trip_kernel_add_plan_attachment_columns.sql:365#TRIP_VERSION_CONFLICT` returns the current and expected versions so a caller can refetch and retry (§18.3 "explicit conflict"). |
| TR54 | …validates temporal/spatial consistency | **W** | **Moved N→W 2026-09-08, and the W is the honest half.** The row said the write "accepts any `starts_at`/`ends_at` pair, including one that overlaps a confirmed item or precedes its predecessor." ORDERING is now checked: the kernel already refused an inverted range on the TRIP (`2590:...#TRIP_TEMPORAL_RANGE_INVERTED`, on create and on update, comparing the MERGED value), and the plan-item half is now enforced by `migrations/2750_trip_plan_item_interval_ordered.sql` (a CHECK, NOT VALID, rehearsed on portava-ci — an UPDATE into an inverted range is refused) plus the typed refusal at `lib/tripKernel.ts:538#executeTripCommand`. **OVERLAP is still unchecked** — an item may still be written across a confirmed item's interval, because that is the §7 consistency engine (TR128, TR134) and needs a route provider this tree does not have. Ordering built, overlap not. **Also recorded here rather than lost:** the plan-item check lives at the kernel's entry point rather than inside `trip_kernel_execute`, because every kernel change replaces that 700-line function in full; it should ride along with the next migration that replaces it for its own reasons. |
| TR55 | …validates dependent commitments | **N** | No commitments exist (TR15). |
| TR56 | …validates sensitive-domain boundaries | **W** | Partially, by construction rather than by a validator: `trip_documents` and crew location have their own routes with their own gates (`routes/tripCrewLocation.ts:170-174`), so a plan write cannot touch them. There is no boundary *check* — there is simply no shared write path that could cross one. |
| TR57 | Successful commands write canonical state plus an immutable domain event in the same transaction where feasible | **C** | **Moved N→C.** The row said "No event is written by any trip mutation." One plpgsql function does both writes in one transaction: `2590_trip_kernel_add_plan_attachment_columns.sql:798#version` bumps `trips.version` and `:804#trip_events` appends the event, with the outbox row at `:818#trip_outbox`. `logActivity` — the thing the row measured — is no longer the nearest artifact. |
| TR63 + TR67 | §4.2 domain events `trip.participant_joined` and `trip.trip_completed` | **W** ×2 | `trip_activity_log` (`0079_trip_sub_tables.sql:240-247`) records these two through `logActivity` (`routes/trips-expansion.ts:49-60`): `join_request_approved` at `:738`, `joined_via_invite_link` at `:1379`, `trip_completed` at `:517`. **W** because the row carries no aggregate version, no sequence, no causation/correlation id and no schema version, and is written best-effort **outside** the transaction (`:56-59` `.then(undefined, () => {})`). |
| TR58–TR62 + TR64–TR66 | §4.2 domain events `trip.plan_added` · `plan_moved` · `plan_confirmed` · `commitment_at_risk` · `free_window_created` · `proposal_accepted` · `stage_started` · `trip_disrupted` | **N** ×8 | None is emitted anywhere. Note the structural reason for the first three: `logActivity` is defined in `routes/trips-expansion.ts` and **every plan route lives in `routes/trips.ts`**, which never imports it — so no plan mutation logs anything at all. The other five have no underlying concept (commitments, free windows, proposals, stages, disruption). |
| TR68 | The `TripEvent` envelope | **C** | **Moved N→C.** The row compared `trip_activity_log`'s six columns to the envelope's thirteen. The envelope is not that table: `2420_trip_kernel_foundation.sql:101#trip_events` carries event_id, trip_id, aggregate_version, sequence, type, actor_user_id, causation_id, correlation_id, payload, schema_version, occurred_at and recorded_at, append-only by trigger. |
| TR69 | `aggregateVersion` on every event | **C** | **Moved N→C.** `2420_trip_kernel_foundation.sql:104#aggregate_version`, NOT NULL, with `trip_events_positive` requiring it > 0. |
| TR70 | `sequence` on every event | **C** | **Moved N→C.** `2420_trip_kernel_foundation.sql:105#sequence`, NOT NULL, unique per trip (`trip_events_trip_sequence_unique`) — a real sequence, not a `created_at DESC` ordering. |
| TR71 | `causationId` / `correlationId` | **C** | **Moved N→C.** `2420_trip_kernel_foundation.sql:108#causation_id` (the command_id that produced the event) and `:109#correlation_id`. |
| TR72 | `schemaVersion` on the payload | **C** | **Moved N→C.** `2420_trip_kernel_foundation.sql:111#schema_version`, NOT NULL DEFAULT 1 — so a payload shape change is migrable, which the untyped `metadata JSONB` this row measured was not. |
| TR73 | `occurredAt` distinct from `recordedAt` | **C** | **Moved N→C.** `2420_trip_kernel_foundation.sql:112#occurred_at` is the client-observed instant and `:113#recorded_at` is when the database wrote it. Two columns, distinct, exactly as §4.3 asks. |
| TR74 | Outbox pattern for asynchronous consumers | **C** | **Moved N→C.** `2420_trip_kernel_foundation.sql:156#trip_outbox`, written in the same transaction as the event (`2590:818#trip_outbox`) and indexed on the unpublished set. |
| TR75 | Workers publish/retry idempotently | **W** | Two trip workers exist and both are real: `lib/tripReminderScheduler.ts` (with `is_sent` + `reminder_delivered_at` + `reminder_retry_count`, migrations `0138`–`0140`) and `lib/tripCrewLiveShareScheduler.ts`. They are timer-driven pollers over their own tables, not outbox consumers, and the reminder one is idempotent by a `is_sent` flag rather than by event id. |
| TR76 | Consumers persist processed event IDs or use deterministic projection version checks | **C** | **Moved N→C.** A projection worker exists and is registered: `lib/mapTripProjectionWorker.ts:86#runTripMapProjectionPass` drains unpublished outbox rows in `aggregate_version` order per trip and stamps `published_at`; `:124#startTripMapProjectionScheduler` is called at `index.ts:162#startTripMapProjectionScheduler`. |

### §5 Database Schema

**Not one of §5.1's fifteen tables exists.** Verified against the migration chain
(`grep -rlio "create table[^(]*\b<name>\b"` over `artifacts/api-server/src/migrations`,
`migrations/`, `supabase/`, `db/`) and against the production snapshot
`baseline/20260907_production_tables.txt`. What is deployed is a different schema.

| id | Requirement (§5.1 table) | V | Evidence |
| --- | --- | --- | --- |
| TR77 | `trips` (id, owner_user_id, title, lifecycle_state, **current_stage_id**, home_timezone, **version**) | **W** | `migrations/0001_spine.sql:72-89`. `owner_id` not `owner_user_id`; `status` not `lifecycle_state`; **no `current_stage_id`, no `home_timezone`, no `version`** — three of the seven key columns, and the three the kernel depends on. Timezone is passed in per call instead (`lib/tripStatus.ts:33`). |
| TR78 | `trip_stages` | **W** | **Moved N→W 2026-09-09; see §27.** The table exists (`2760_trip_stages.sql`) with the §5.1 columns, five CHECKs and a crew-read RLS policy, and now has the writer §4 requires (`2764_trip_kernel_stage_family.sql`). **W and not C because 2764 cannot be applied to any database**: both portava-ci and production still carry 2420's plan-family-only kernel, so a command family that nothing can execute is built, not deployed. |
| TR79 | `trip_legs` | **N** | Does not exist. |
| TR80 | `trip_participants` (with membership_state, permissions_version) | **W** | `trip_members` (`0001_spine.sql:100-106`) — four columns, no membership state, no permissions version (TR19). |
| TR81 | `trip_commitments` | **N** | Does not exist. |
| TR82 | `trip_plans` (with stage_id, privacy_scope, source_type, version) | **W** | `trip_plan_items` (`0010_trip_plan.sql:5-30`) — has `source_type` (`:14`) and a `visibility` of `'members' \| 'public'` (`:26-27`), which is not the §6.3 six-value privacy scope; **no `stage_id`, no `version`**. |
| TR83 | `trip_plan_participants` (plan_id, user_id, attendance_state, role) | **N** | Does not exist. A plan belongs to a trip and to nobody in particular; there is no way to record who is going. |
| TR84 | `trip_goals` | **N** | Does not exist. |
| TR85 | `trip_decision_tasks` | **N** | Does not exist. |
| TR86 | `trip_risks` | **N** | Does not exist. |
| TR87 | `trip_presence` | **N** | Does not exist under that shape. `trip_crew_location_sessions` (`0041_trip_crew_location.sql`) is a live-share session, not a per-participant presence row with `presence_state`/`confidence`/`expires_at`/`visibility`. |
| TR88 | `trip_proposals` | **N** | Does not exist. |
| TR89 | `trip_events` | **W** | `trip_activity_log` (`0079_trip_sub_tables.sql:240-247`) is the nearest deployed table: `(id, trip_id, actor_id, event_type, metadata, created_at)` against the spec's `(event_id, trip_id, aggregate_version, sequence, type, payload_json, occurred_at)`. Missing `aggregate_version` and `sequence` are what make it an audit log rather than an event store. |
| TR90 | `trip_snapshots` | **N** | Does not exist. (`trip_readiness_snapshots`, `0175`, is a cached readiness summary — a different object at a different altitude.) |
| TR91 | `trip_outcomes` | **N** | Does not exist. |

*Compared in both directions: the deployed set contains sixteen `trip_*` tables that §5.1
does not specify — `trip_budget`, `trip_notes`, `trip_checklists`, `trip_checklist_items`,
`trip_documents`, `trip_saved_places`, `trip_reminders`, `trip_destinations`,
`trip_join_requests`, `trip_invite_links`, `trip_invite_link_attempts`,
`trip_area_preferences`, `trip_autopilot_proposals`, `trip_autopilot_settings`,
`trip_readiness_items`, `trip_readiness_snapshots`, plus `trip_reservations`,
`trip_traveler_passports`, `trip_availability` and `trip_activity_log`. The deployed schema
is star-shaped around `trips` with no intermediate structure: nothing hangs off a stage,
because there is no stage.*

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR92 | §5.2 Cross-domain references use explicit `*_id` plus optional `source_ref`/`source_type` | **W** | The pattern is used (`0010_trip_plan.sql:14-17` `source_type` + `source_id`) but the id half is `text`, not a typed `*_id` with a constraint (TR33). |
| TR93 | §5.2 Never encode foreign IDs into generic text fields | **W** | Violated by the same two lines: `source_id text NULL` at `0010:16` is a foreign identifier in a generic text field, which is the shape the rule names. It is at least *labelled* by `source_type`, which is why this is W and not N. |
| TR94 | §5.2 Traveler-visible place identity resolves through the canonical place bridge where available | **C** | `lib/placeIdBridge.ts` is the single sanctioned crossing and `scripts/checkSchemaReferences.ts` is the ratchet that keeps it single. |
| TR95 | §5.2 Unresolved external/manual places remain typed as unresolved, not falsely canonical | **C** | `0010_trip_plan.sql:14-15` — `source_type` defaults to `'manual'` and admits `'place'`/`'meetup'`; a manual entry is typed as manual and never acquires a canonical id by default. `:22-23` additionally forbids coordinates on the label: *"public-safe label only — no GPS coordinates stored."* |
| TR96 | §5.3 Canonical durable class (trip, stages, confirmed plans, membership) retained until deletion/retention policy | **C** | `trips`, `trip_members`, `trip_plan_items` are durable with cascade deletes (`0001_spine.sql:74,101-102`; `0010:7`) and are covered by the account-deletion disposition table (`lib/deletionDispositions.ts:443`). |
| TR97 | §5.3 Operational class (decision tasks, risks, transient execution state) expires/archives after usefulness | **W** | The only operational artifact is readiness, and it does have a staleness rule — `lib/tripReadiness.ts:24-25` `READINESS_STALE_MS = 10 * 60 * 1000` with a stale-row sweep on recompute (`:5-7`). Decision tasks and risks do not exist, so two-thirds of the class has no policy because it has no rows. |
| TR98 | §5.3 Ephemeral sensitive class (precise presence, safety/location) has short TTL and strict access | **C** | `0167_safety_ddl_reconcile.sql:126-137` — `safe_return_live_shares` is `active \| stopped \| expired` with an `expires_at` index; `trip_crew_location_sessions` carries an expiry consumed at `lib/tripCrewLocation.ts:142`; `lib/tripCrewLiveShareScheduler.ts` sweeps. Strict access is `lib/tripCrewLocation.ts:1-16`'s privacy contract. |
| TR99 | §5.3 Derived class (Today/Map/Compass projections) is rebuildable with TTL/freshness metadata | **W** | Only one derived artifact exists (`trip_readiness_snapshots`, `0175`) and it *is* rebuildable with a staleness bound. The Today/Map/Compass projections it names do not exist (§11.1, §14.1, §19.1), so the class is one-eighth populated. |
| TR100 | §5.3 Historical evidence class (events, decision ledger, snapshots) is policy-controlled with minimised payloads | **W** | `trip_activity_log` is retained indefinitely with an unconstrained `metadata JSONB` (`0079:245`) — no retention policy, no payload minimisation, no size bound. The decision ledger and snapshots do not exist. |

### §6 Authorization, RLS and Policy Layer

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR101 | Roles are coarse; capabilities derive from role + trip policy + plan membership + privacy scope | **W** | Two of the four inputs are real: `lib/http.ts:544#canEditPlan` combines role with the trip's `plan_edit_permission` setting (`0021_plan_edit_permission.sql`), and `lib/http.ts:604#canEditPlanItem` adds item authorship. Plan membership does not exist (TR83) and privacy scope is a two-value column (TR82), so half the derivation has no inputs. |
| TR102 | Application code calls policy functions rather than scattering host checks | **W** | True for plans — `canEditPlan`/`canEditPlanItem` are centralised in `lib/http.ts` and called from `routes/trips.ts:1443,1505-1509,1573` and `compass/CompassTools.ts:714`. False elsewhere: `routes/trips-expansion.ts:507` (`owner_id !== user.id`), `:530`, `:583`, `routes/tripReservations.ts:426-429` and `routes/tripCrewLocation.ts:170` each inline their own ownership or role check. Scattered host checks are exactly what the rule names. |
| TR103 | `canViewTrip(actor, trip)` | **W** | The behaviour exists and the function does not: `routes/trips-expansion.ts:2572` `GET /trips/:tripId` resolves visibility inline and `src/test/tripPrivacy.test.ts:7-15` proves the outcomes (non-member → preview, accepted member → full, removed member → preview on the next request, private non-member → locked sentinel). A tested inline gate, not a policy function. |
| TR104 | `canInviteParticipant(actor, trip)` | **W** | Inline at `routes/trips.ts:927` and `routes/trips-expansion.ts:891`; no named policy. |
| TR105 | `canEditTrip(actor, trip)` | **W** | Inline owner checks at `routes/trips.ts:684` and `routes/trips-expansion.ts:350`; no named policy. |
| TR106 | `canCreatePlan(actor, trip)` | **C** | `lib/http.ts:534` `canEditPlan`, called before the create at `routes/trips.ts:1443`. |
| TR107 | `canModifyPlan(actor, plan)` | **C** | `lib/http.ts:594` `canEditPlanItem`, called at `routes/trips.ts:1509,1573`. |
| TR108 | `canManageBooking(actor, trip)` | **W** | `routes/tripReservations.ts` has `requireReservationMember` plus a stricter delete rule at `:426-429` (*"creator or trip OWNER only"*) — real authorization, expressed as a route-local helper rather than a policy function. |
| TR109 | `canSeePresence(actor, subject, trip)` | **W** | The decision is made inside `lib/tripCrewLocation.ts:104` `buildCrewCard` per member, honouring ghost mode, default visibility and safe-return opt-in. It is a card builder, not a predicate, so no caller can *ask* the question — and `routes/tripCrewLocation.ts:170-174` admits **invited-but-not-accepted** members (`getMemberRoleAny`) to the crew map. |
| TR110 | `canSeePreciseLocation(actor, subject, trip)` | **C** | `lib/tripCrewLocation.ts:96-103,131-133` `resolveExactCoords` — exact coordinates require an **active live-share grant** *and* hotel-blur off *and* populated coordinates; ghost mode short-circuits first (`:119-122`). Three independent conditions, all fail-closed, and membership alone never suffices. |
| TR111 | `canManageSafety(actor, trip)` | **W** | `services/safeReturn/SafeReturnPrivacyGuard.ts:116-129` gates by session ownership and expiry — correct, and scoped to the safety domain rather than expressed as a trip capability. |
| TR112 | §6.2 Default deny client writes to sensitive coordination/safety tables unless an explicit safe client path exists | **C** | `0041_trip_crew_location.sql:39` scopes the only client INSERT policy to the session owner; `0167_safety_ddl_reconcile.sql` puts safety tables behind service-role writes; `scripts/checkSilentSupabaseWrites.ts` and `scripts/rlsDispositions.ts:458` are the standing ratchets. |
| TR113 | §6.2 Membership does not imply precise location access, payment access, document access or safety access | **C** | Precise location: TR110. Documents: `routes/trips-expansion.ts:1792-1942` gate separately. Safety: its own session ownership. Payment: no payment state exists in Trips (TR8). Each of the four is independently gated. |
| TR114 | §6.2 Service-role mutations still pass application authorization; service role is not business authorization | **?** | Honoured in every handler I opened (`getServiceClient()` is fetched *after* `requireUser` and the role check — `routes/trips-expansion.ts:497-508`, `routes/tripCrewLocation.ts:160-174`, `routes/tripReservations.ts:420-429`), and **no artifact enforces it**: `scripts/checkSilentSupabaseWrites.ts` catches unlogged writes, not unauthorized ones, and there is no authorization ratchet over service-client use. The requirement is universally quantified over **97 trip endpoints** and I read roughly a dozen. A sample cannot settle a universal, and nothing in the tree settles it for me. Settling it needs a ratchet that asserts the ordering, or a full read of all 97 handlers. |
| TR115 | §6.2 Policy tests include negative assertions for anonymous, non-member, removed member, guest, host and service-facing paths | **W** | Four of six are proven: `src/test/tripPrivacy.test.ts:7-15` covers non-member, removed member, owner and private-visibility non-member; `src/test/tripMembers.test.ts`, `tripMembership.test.ts`, `tripNotFound.test.ts` add more. Anonymous is covered generically by `requireUser`; there is no **guest** role and no **service-facing** negative test. |
| TR116 | §6.3 Privacy scopes PRIVATE \| SELECTED_PARTICIPANTS \| CREW \| FRIENDS_NEARBY \| TRIP \| PUBLIC | **W** | Two scopes exist where six are specified: `trip_plan_items.visibility` is `'members' \| 'public'` (`0010_trip_plan.sql:26-27`) and `trips.visibility` is `trip_visibility as enum ('public','buddies','private','invite')` (`0001_spine.sql:14`) — a *third*, differently-shaped vocabulary on the parent. Neither is §6.3, and the two disagree with each other. |
| TR117 | §6.3 Public Trip content must not leak lodging detail | **C** | `src/test/tripPrivacy.test.ts:5-8` asserts hotel name is absent from `toPrivateTripPreview`. |
| TR118 | §6.3 …must not leak exact private location | **C** | `0010_trip_plan.sql:22-23` — `location_name` is *"public-safe label only — no GPS coordinates stored"*; `trip_plan_items.location_is_private` gates the coordinates that were later added (`routes/trips.ts:1531`). |
| TR119 | §6.3 …must not leak future absence from home | **N** | *Unguarded absence.* Trip dates are on the public preview by design (`show_exact_dates` toggles precision, per `tripPrivacy.test.ts:5-6`) — a public trip announces that the owner will be elsewhere on given dates, which is the exact disclosure named. Nothing guards it. |
| TR120 | §6.3 …must not leak safety state | **C** | Safe Return status is never joined into any trip read path; the crew card exposes it only when the member opted in (`lib/tripCrewLocation.ts:154-156` `shareSafeReturnStatus`). |
| TR121 | §6.3 …must not leak unconsented participant data | **C** | `tripPrivacy.test.ts:5-8` asserts the member list is absent from the private preview; `routes/trips.ts:349` gates the members endpoint on membership. |

### §7 Temporal and Spatial Consistency Engine

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR122 | The `Commitment` contract | **N** | No commitment type or table (TR15). |
| TR123 | `requiredArrivalAt` — arrival semantics distinct from start time | **N** | `trip_plan_items` has `starts_at`/`ends_at` only (`0010_trip_plan.sql:20-21`). A plan that starts at 19:00 and needs you there by 18:45 cannot be expressed. |
| TR124 | `latenessTolerance` | **N** | Absent. |
| TR125 | `prepDuration` | **N** | Absent. |
| TR126 | `flexibility` | **W** | `trip_plan_items.lock_type` (written at `routes/trips.ts:1524`) is the nearest analogue — a binary lock rather than a flexibility class, and it is not consulted by any scheduling logic because there is none. |
| TR127 | `confidence` on a commitment | **W** | The only confidence in the trip domain is `trip_reservations.extraction_confidence` (`0172_trip_reservations.sql:24`), which is the LLM's self-reported extraction confidence — *"model-reported 0..1 (never invented)"* — an honest number about a different question. |
| TR128 | The core invariant `previous.end + route(previous.place, next.place, future_departure_time) + required_buffer(next) <= next.requiredArrivalAt` | **N** | Not computed anywhere. `services/routeOptimizer.ts:1-6` estimates travel time by straight-line Haversine and labels every output `isApproximated: true`, but it optimises a route plan's stop order and is never invoked against a trip's plan items. There is no feasibility check on any write path. |
| TR129 | Confirmed timelines may contain known conflicts only when explicitly overridden and visibly marked | **N** | *Unguarded absence.* Nothing detects a conflict, so nothing can require an override. `routes/trips.ts:1520-1533` accepts any time pair. |
| TR130 | A conflict is not silently rendered as a normal itinerary | **N** | This is what happens: an impossible pair of plan items renders as an ordinary day list (`src/components/TripPage.tsx:241-264` day tabs over `TimelineDay`) with no marker. The requirement's forbidden outcome is the shipped outcome. |
| TR131 | The `FreedomWindow` contract | **N** | `grep -rli "FreedomWindow\|freedom_window\|freedomWindow"` over the whole tree → nothing. |
| TR132 | Trips queries a Temporal Freedom Engine for gaps between commitments | **N** | No engine, no gap computation. `trip_plan_items.category` admits `'free_time'` (`0010:11`) as a manually-created label — the opposite of a computed window. |
| TR133 | Discovery, Compass, Saved Ideas and Buddy matching consume these windows rather than independently calculating free time | **N** | Each does its own thing: `compass/CompassTools.ts:141-157` `check_trip_conflicts` re-derives overlap from `trip_plan_items.day_date` per call; Discovery and Buddy do not consider trip time at all. Four consumers, four independent derivations, which is the shape the rule forbids. |
| TR134 | §7.4 Travel-feasibility check | **N** | Absent (TR128). |
| TR135 | §7.4 Place-identity check (external booking and hidden gem sharing a name but not identity) | **W** | The *storage* prevents the confusion (`0010:14-17` typed `source_type` + `source_id`; `lib/placeIdBridge.ts`), so the failure mode is structurally harder — but there is no check that runs, reports or blocks. Prevention by shape, not by check. |
| TR136 | §7.4 Stage-locality check (a plan belongs to a stage whose location/timezone does not contain it) | **N** | There are no stages (TR78), so the check has no subject. |
| TR137 | §7.4 Route-availability check (feasible by taxi but transport-mode policy says no taxi) | **N** | No transport-mode policy exists. `services/routeOptimizer.ts:22` flags legs over 800 m for a rideshare recommendation under the `low_walking` style — a suggestion inside a route plan, not a policy check on a trip. |

### §8 Goals, Decisions, Readiness and Risk

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR138 | The `TripGoal` contract (type, scope, priority, status, evidence) | **N** | No goal table, type or column (TR20). |
| TR139 | Goals may be personal or shared and weighted without forcing every participant to share priorities | **N** | Nothing per-participant exists on a trip beyond role and, separately, availability. |
| TR140 | Unresolved decisions are first-class work items | **W** | `trip_readiness_items` (`0170_trip_readiness.sql`) is the nearest artifact: seven categories, a `severity` of `normal \| critical`, a `due_at`, and an `action_ref` (`lib/tripReadiness.ts:29-55`). It is *derived and recomputed*, not a durable work item — it has no assignee and no consequence, and it disappears when the underlying fact changes rather than being resolved. |
| TR141 | `decisionUrgency = f(timeRemaining, availabilityDecay, downstreamImpact, consequence)` — not merely chronological due date | **W** | `lib/tripReadiness.ts` has `dueAt` and `severity` and orders by them; there is no availability decay, no downstream-impact term and no consequence term. One of four inputs. |
| TR142 | Readiness is an explanatory projection, not a gamified truth score | **W** | Both halves are present and they fight. The gamified score exists — `lib/tripReadiness.ts:57-60` *"Mechanical: round(100 × share of categories with zero action_needed/incomplete items)"*, rendered as a `ProgressRing` percentage (`src/components/TripPage.tsx:33-49`) alongside `trips.progress` (`0001_spine.sql:86`). The explanation also exists, and is protected by an unusually good rule: `:8-12` — *"CRITICAL-VISIBILITY RULE: the aggregate score must NEVER hide critical items. The summary always carries the FULL `criticalItems` array — untruncated — no matter how high the score is."* |
| TR143 | Readiness reports critical unresolved items before departure **and by upcoming day/stage** | **W** | Before departure: yes, with a `dueAt` per item. By day/stage: no — `READINESS_CATEGORIES` (`:29-37`) are `plan \| stay \| transport \| budget \| entry \| documents \| reservations`, a domain axis, not a temporal one, and there are no stages to group by. |
| TR144 | §8.4 Risk: tight arrival (flight ETA shifts beyond threshold) → move/cancel downstream plan, alert affected participants | **N** | No risk register (TR22), no flight ETA ingestion on a trip, no downstream propagation. `services/airport/LayoverNotificationService.ts` is a Layover-programme artifact operating on its own domain. |
| TR145 | §8.4 Risk: weather-sensitive activity → prepare indoor fallback | **N** | No weather input to Trips and no fallback concept. |
| TR146 | §8.4 Risk: late check-in → contact property / alternate entry plan | **N** | Absent. |
| TR147 | §8.4 Risk: crew transport mismatch (party size > vehicle capacity) → split transport or prebook larger vehicle | **N** | Party size is not computed anywhere (there is no attendance relation, TR83), and there is no transport object (TR18). |

### §9 Collaborative Coordination Model

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR148 | `PlanScope = ALL_CREW \| OPTIONAL \| SUBGROUP \| SOLO` | **N** | No scope concept on a plan item. `visibility` (`0010:26-27`) is `members \| public`, an audience, not a scope. |
| TR149 | `Attendance = INTERESTED \| GOING \| MAYBE \| CANT_GO \| LEFT` | **N** | No attendance relation or column anywhere in the trip domain. |
| TR150 | Attendance is an explicit relation so downstream transport, reservation, meeting-point and budget calculations use the actual party | **N** | The consequence is visible: `trip_budget` and `routes/tripBudgetIntel.ts:109` `GET /trips/:tripId/cost-estimate` compute against the trip's whole membership, because there is nothing finer to compute against. |
| TR151 | Temporary subgroups allow crews to split and recombine without forking the Trip | **N** | No subgroup concept (TR24). |
| TR152 | A subgroup can own a meetup, shared transport and temporary presence sharing while the parent Trip remains canonical | **N** | Absent. `services/tripCrew/` operates on the whole crew; `trip_crew_location_sessions` is per-user, not per-subgroup. |
| TR153 | The `TripProposal` contract (type, proposedBy, affectedObjects, rationale, impactSummary, decisionRule, status, expiresAt) | **N** | No proposal table or type (TR26). |
| TR154 | `decisionRule = HOST \| MAJORITY \| UNANIMOUS \| ANYONE` | **N** | No voting or decision-rule concept. The only trip-level governance is `plan_edit_permission` (`0021_plan_edit_permission.sql`), a binary who-may-edit setting. |
| TR155 | Compass may create a proposal but cannot silently mutate other participants' commitments | **C** | The one §9 requirement that is genuinely met, and met deliberately: `compass/CompassTools.ts:14` — *"`add_to_trip` proposes only. The server holds the proposal; nothing is [written]"* — `:158-161` *"This never writes anything — it returns a pending proposal that the user must explicitly confirm in the UI before the server executes it"*, `:229` instructs the model *"never claim the item was added"*, and `:712-716` still runs `isAcceptedTripMember` + `canEditPlan` before even proposing. Built for the Compass programme, not this spec, but it satisfies this requirement exactly. |
| TR156 | §9.4 Impact preview before accepting a proposal that changes a confirmed plan (affected reservations, transport, participants, commitment conflicts, cancellation costs, safety/return implications) | **N** | Nothing computes downstream impact. `trip_reservations.cancellation_deadline_at` (`0172:21`) is stored and is read by nothing on any change path — `grep`ing its readers finds the readiness engine's own defensive read (`lib/tripReadiness.ts:14-18`) and the index at `0172:35-36`, not an impact preview. |

### §10 Presence, Location and Crew State

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR157 | Presence states AVAILABLE \| FREE \| GETTING_READY \| TRANSITING \| AT_PLAN \| RESTING \| RETURNING \| OFFLINE | **W** | `lib/tripCrewLocation.ts:20-29` `CrewStatusLabel` is `not_shared \| city_only \| neighborhood \| nearby \| arrived \| safe_return_active \| live_sharing_active \| location_hidden`. Eight values against eight, and **none of them is a presence state** — every one describes the *sharing mode*, not the person's real-world availability. `arrived` is the only overlap with `AT_PLAN`. The spec's whole point ("Presence is contextual, not 'online'") is inverted: this vocabulary is entirely about the sharing channel. |
| TR158 | Presence communicates real-world availability without requiring continuous exact GPS | **C** | Achieved, if for the wrong reason: `lib/tripCrewLocation.ts:47-53` reads `user_location_state` for city/district and requires an explicit live-share grant before coordinates (`:96-103`). Nothing streams GPS to build the crew view. |
| TR159 | Every presence row carries `observed_at` | **W** | `buildCrewCard` carries `updatedAt` from `locationState.updatedAt` (`lib/tripCrewLocation.ts:115`) — it exists on the wire and **no client renders it**: `grep -niE "freshness\|last known\|stale\|ago\|updated"` over `src/components/tripCrew/CrewMapSection.tsx` and `CrewMemberCard.tsx` returns nothing. |
| TR160 | …`expires_at` | **C** | `liveShareExpiresAt` (`lib/tripCrewLocation.ts:142`), backed by the session's expiry and swept by `lib/tripCrewLiveShareScheduler.ts`. |
| TR161 | …`source` | **N** | No source field on the crew card or the underlying state; a city derived from a check-in and one derived from a coarse geofence are indistinguishable. |
| TR162 | …`confidence` | **N** | Absent. |
| TR163 | …`visibility` | **C** | `CrewVisibility = hidden \| city_only \| neighborhood \| nearby \| arrived_only` (`lib/tripCrewLocation.ts:31`), stored per member in `trip_crew_location_preferences` and honoured at `:119-146`. |
| TR164 | Location freshness LIVE \| RECENT \| LAST_KNOWN \| OFFLINE | **N** | No freshness class is computed anywhere. `updatedAt` is passed through raw (TR159) and never classified. |
| TR165 | The Trip Map must never draw a stale location as if it were current | **W** | It does. `buildCrewCard` (`lib/tripCrewLocation.ts:131-146`) returns `statusLabel: "live_sharing_active"` with an `areaLabel` whenever a live-share **grant** is active, regardless of how old `locationState.updatedAt` is — the grant's expiry is checked, the observation's age is not. `CrewMapSection.tsx:35-38` then renders that member as `live` in the density map. A three-day-old city, under a grant issued five minutes ago, draws as live. **This is the most consequential single defect in the Trips census.** |
| TR166 | Marker visual treatment **and accessible text** must expose freshness | **N** | Neither. `src/components/tripCrew/CrewMemberCard.tsx:5` — *"No exact coordinates are ever displayed; statusLabel drives the UI"* — and `statusLabel` carries no age; `:106-120` renders `areaLabel` and two coloured status strings with no timestamp and no accessibility label for recency. |
| TR167 | §10.3 Use geofences before constant GPS | **C** | `src/services/geofence.ts` + `0035_plan_geofences.sql` / `0039_plan_geofence_full.sql`; `POST /api/location/exit-geofence` drives delayed publishing (`lib/delayedPostPublisher.ts:5-7`). |
| TR168 | §10.3 …significant location changes | **C** | `user_location_state` is updated on coarse change rather than on a tick; `0032_location_preferences.sql` / `0033_location_sessions.sql` carry the preference and session model. |
| TR169 | §10.3 …navigation callbacks | **N** | No navigation SDK integration and no callback path anywhere in the client. |
| TR170 | §10.3 …semantic checkpoints | **C** | `plan_checkins` feeds `checkInStatus` on the crew card (`lib/tripCrewLocation.ts:59-60,155-156`), and `route_stops.checkpoint_status` (`0058_trip_flow.sql:68`) is a checkpoint model. |
| TR171 | §10.3 …explicit user actions | **C** | Live share is started by an explicit act with an explicit duration (`routes/tripCrewLocation.ts:313` `POST /trips/:tripId/crew/live-share/start`; client `LiveShareSheet.tsx`). |
| TR172 | §10.3 Increase sensing frequency only when execution/safety requires it | **W** | The *effect* holds — there is no continuous sensing to increase — but there is no adaptive policy: no sampling-rate concept, no escalation on a safety event. Safe Return raises *notification* escalation (`escalationLevel: 0\|1\|2\|3`, `SafeReturnService.ts:33`), not sensing frequency. |
| TR173 | §10.4 Offline Locate-My-Friends integration for Trip Crew | **W** | `routes/locateFriends.ts` exists and scopes a session by `groupScopeId`, which `:205-215` documents as *"a `route_plans.id` — Portava's collaborative plan"* — a **route plan**, not a Trip. And its four tables (`locate_friends_sessions/_members/_positions/_audit`) are **absent from production** (`scripts/checkProductionDrift.ts:177-180`). Built, mis-scoped, undeployed. |
| TR174 | §10.4 Cached event maps | **N** | No offline map cache (see §18.1). |
| TR175 | §10.4 Last-known positions | **C** | `locate_friends_positions` holds them and the crew card carries the last known city/district (`lib/tripCrewLocation.ts:47-53`). |
| TR176 | §10.4 Opt-in Bluetooth proximity | **N** | No BLE dependency, no peer-relay code. `grep -rli "bluetooth\|BLE\|peripheral"` over the client → nothing relevant. |
| TR177 | §10.4 Meeting checkpoints | **W** | `route_stops.checkpoint_status` (`0058:68`) and `trip_plan_items.category = 'meeting_point'` (`0010:11`) both exist as labels; neither is a crew meeting-checkpoint with participants and arrival state. |
| TR178 | §10.4 Temporary relay metadata | **N** | Absent. |
| TR179 | §10.4 This must not create covert persistent tracking | **C** | Enforced, and in the strongest available way: ghost mode is absolute and checked first (`lib/tripCrewLocation.ts:119-122`), a member who has not opted in reads `not_shared` (`:148-152`), the whole surface is behind `trip_crew_map_enabled` seeded false (`0041:63`), live shares expire, and `routes/tripCrewLocation.ts:241,277` give explicit enable/disable endpoints. |

### §11 Trip Today Projection and Execution UX

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR180 | The `TripTodayProjection` contract | **N** | `grep -rli "TripToday\|trip_today\|todayProjection"` → nothing. There is no `GET /trips/:id/today` endpoint (the registered trip routes are enumerated across `routes/trips.ts`, `trips-expansion.ts`, `tripReadiness.ts`, `tripReservations.ts`, `tripCrewLocation.ts`, `tripBudgetIntel.ts`, `tripDraft.ts` and none is `/today`). |
| TR181 | `nowState` | **W** | Derived **on the client** from the fetched plan list: `src/components/TripPage.tsx:155-171` renders a "Today / Next Up" section. A client-side derivation is the shape §11.1 exists to replace, and it cannot be consumed by Compass, Map or Telegraph. |
| TR182 | `currentPlan` | **W** | Same client derivation (`TripPage.tsx:155-199`). |
| TR183 | `nextCommitment` | **W** | The "Next Up" half of the same section — over plan items, not commitments (TR15). |
| TR184 | `freeWindows[]` | **N** | No free windows exist (TR131). |
| TR185 | `crewSummary` | **W** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:156`) returns `{ members, totalCount }` — a crew summary, on a different endpoint, behind a different flag, with no relation to a Today projection. |
| TR186 | `opportunities[]` | **W** | `fetchCompassTripBrief` (`src/services/compass.ts`, used at `TripPage.tsx:16`) returns Compass recommendations for the trip — the nearest thing to an opportunity list, produced by Compass rather than by Trips and not carried on any projection. |
| TR187 | `risks[]` | **N** | No risks (TR22). |
| TR188 | `unresolvedActions[]` | **W** | `GET /trips/:tripId/next-best-action` (`routes/tripReadiness.ts:270`) is exactly this list — behind `trip_readiness_enabled`, seeded false (`0170:76`), and on its own endpoint rather than on a projection. |
| TR189 | `pulseSignals[]` | **N** | No Trip Pulse (§16). |
| TR190 | `generatedAt` | **N** | No projection to stamp. |
| TR191 | `sourceTripVersion` | **N** | No version exists (TR12). |
| TR192 | `freshness` | **N** | Absent. |
| TR193 | §11.2 The Today surface answers, in order: what is happening now · what is next · who is with me · what can I do · has anything changed | **W** | `src/components/TripPage.tsx` answers three of five and in a different order: hero + actions (`:103` Ask Compass), Today/Next Up (`:155`), plans (`:530-583`), crew via a separate tab (`CrewMapSection`). "Has anything changed" has no answer anywhere — there is no change feed, no diff, no since-last-seen. |
| TR194 | §11.3 Start plan → `START_PLAN` → state IN_PROGRESS; publishes active context | **N** | No IN_PROGRESS state (TR46), no command (TR50), no active context publication. |
| TR195 | §11.3 "Where next?" → queries feasible opportunity portfolio using current crew/time/world state | **W** | `fetchCompassTripBrief` returns trip-scoped Compass recommendations (`TripPage.tsx:16,155-178`). It is not a feasibility query — no free window, no crew composition, no travel time. |
| TR196 | §11.3 "Replan today" → creates a candidate diff; important shared mutations become proposals | **N** | No replan, no diff, no proposal (TR153). |
| TR197 | §11.3 "I am bored" → builds a short FreedomWindow + experience candidates without changing commitments | **N** | No free windows (TR131). |
| TR198 | §11.3 "Return / regroup" → creates a route/meeting operation and switches context priority | **W** | Safe Return creates a return operation with contacts and escalation (`services/safeReturn/SafeReturnService.ts:28-40` `CreateSessionInput` carries `tripId` and `planItemId`) — a safety return, not a regroup, and it does not switch any context priority. |
| TR199 | §11.4 Attention model IGNORE \| PASSIVE \| SURFACE \| NOTIFY \| INTERRUPT | **W** | A different four-value model ships: `services/notifications/NotificationTemplateService.ts:19` `NotificationPriority = 'urgent' \| 'important' \| 'normal' \| 'low'`, crossed with `NotificationChannel` at `:21`. It expresses urgency, not attention *cost*; there is no IGNORE and no INTERRUPT. |
| TR200 | §11.4 Trip events must pass an attention policy | **C** | They do: `services/notifications/NotificationRouter.ts:1-27` consults `NotificationPreferenceService`, `NotificationDeduplicationService` and `CompassNotificationEngine.evaluateNotification` before dispatching, and logs every attempt. Trip reminders route through it (`lib/tripReminderScheduler.ts`, `src/test/tripReminderPush.test.ts`). |
| TR201 | §11.4 Do not convert every social or live-intel change into a push notification | **C** | Three independent suppressors: per-user channel preferences (`NotificationPreferenceService`), dedup (`NotificationDeduplicationService`), and digesting (`NotificationDigestService`), plus per-template `defaultChannels` (`NotificationTemplateService.ts:27`) so most event types never default to push. |

### §12 Compass Trip Orchestration Contract

Three of the twelve §12.1 tools exist, all in `compass/CompassTools.ts`, all built for the
Compass programme.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR202 | `getTripContext(tripId)` | **W** | `CompassTools.ts:75-79` `get_current_trip` — *"Get the user's current or next upcoming trip (destination, dates, status) plus a few planned items"*. It selects raw rows (`:405-452`: `trip_members`, `trips`, `trip_plan_items`) rather than consuming a typed Trip context, and it resolves the *current* trip rather than taking a `tripId`. |
| TR203 | `getTodayState(tripId)` | **N** | No Today state to get (TR180). |
| TR204 | `getCrewState(tripId)` | **W** | `CompassTools.ts:180-186` `who_is_around` is a Circle-permission-gated presence tool — *"only people who opted in to Circle sharing appear, at the granularity THEY chose … Never returns precise location or coordinates"* — scoped to circles and events, not to a trip's crew state. |
| TR205 | `getFreedomWindows(tripId)` | **N** | No windows (TR131). |
| TR206 | `getCommitments(tripId)` | **N** | No commitments (TR122). |
| TR207 | `getSavedIdeas(tripId)` | **N** | `trip_saved_places` exists (TR25) and no Compass tool exposes it. |
| TR208 | `getLiveConditions(tripId)` | **N** | No trip-scoped live conditions tool (§16). |
| TR209 | `simulatePlan(tripId, proposal)` | **N** | No simulation. `routes/tripBudgetIntel.ts:157` `POST /trips/:tripId/budget/sandbox` simulates a **budget**, not a plan. |
| TR210 | `createProposal(tripId, change)` | **W** | `CompassTools.ts:158-170` `add_to_trip` returns a pending proposal object to the UI. It is not persisted, has no `decisionRule`, no `affectedObjects`, no `expiresAt`, and covers exactly one change type (add a place). |
| TR211 | `replanDay(tripId, constraints)` | **N** | Absent. |
| TR212 | `findMeetingPoint(tripId, participants)` | **N** | Absent (§14.3). |
| TR213 | `explainTripDecision(decisionId)` | **N** | No decision ledger (§21.2), so no decision to explain. |
| TR214 | §12.2 Compass may explain, compose, compare, ask clarifying questions and propose actions | **C** | `CompassTools.ts:225-229` is exactly this instruction set, and `routes/compass.ts` is a read-and-propose surface. |
| TR215 | §12.2 …may not bypass authorization | **C** | `CompassTools.ts:712-716` — `isAcceptedTripMember` then `canEditPlan`, the same gates the write endpoints use, run before a proposal is even returned; `:821` requires a shared Circle or accepted trip for the compatibility tool, *"fail-closed"*. |
| TR216 | §12.2 …may not invent canonical flight/booking/place facts | **C** | Two mechanisms: `CompassTools.ts:241-249` recursively strips coordinate-shaped and private keys from every tool result, and `compass/CompassStructuredContext.wrapUgc` wraps user text as data-not-instructions (`:694`). Facts enter Compass from canonical reads only. |
| TR217 | §12.2 …may not relax safety constraints | **C** | Compass has no write path to any safety table; `services/safeReturn/` is not reachable from `CompassTools.ts` (no import). |
| TR218 | §12.2 …may not expand certified freedom windows | **C** ⌀ | Vacuously true — there are no freedom windows to expand (TR131) — but it is a *guarded* vacuity rather than an open one: Compass cannot write any trip table at all, so it could not expand one if it existed. Flagged `⌀` for a reader who rejects vacuous satisfaction. |
| TR219 | §12.2 …may not mutate shared commitments without the command/policy path | **C** | `CompassTools.ts:14` — *"`add_to_trip` proposes only. The server holds the proposal; nothing is [written]"*; `:229` *"never claim the item was added."* |
| TR220 | §12.3 Calculate value-of-information before asking the traveller | **N** | No VOI computation. `CompassTools.ts:225-229` instructs the model to call tools rather than guess; nothing scores whether a question would change feasibility, authorization, cost or recommendation quality. |
| TR221 | §12.3 Known low-impact uncertainty remains represented as uncertainty rather than becoming questionnaire friction | **W** | The *representation* exists in one place — `trip_reservations.extraction_confidence` (`0172:24`) plus the `pending_confirm` state (`:26-27`) keep an uncertain import uncertain instead of interrogating the user. Nowhere else in the trip domain is uncertainty a value. |
| TR222 | §12.4 Trips remains operational without Compass | **C** | Structurally: every trip route is registered independently (`routes/index.ts:146,173,251-254`) and none imports the Compass engine; `src/test/tripsHostingDegraded.test.ts` exercises the degraded path. The client's Compass brief is an optional section of `TripPage` (`:16`), not a dependency. |
| TR223 | §12.4 Today, commitments, route chains, confirmed plans, crew state, safety state and notifications are deterministic services/projections; AI is not a safety dependency | **W** | The safety half is clean — `services/safeReturn/` has no AI dependency, and `NotificationRouter` dispatches deterministically. The rest is deterministic mostly because it does not exist (Today, commitments, route chains). And one input is not deterministic: `routes/tripDraft.ts:68` `POST /trips/draft-from-text` and `routes/tripReservations.ts:118` `POST /trips/:tripId/reservations/import` are LLM extractions — both correctly land in a `pending_confirm` state that requires an explicit human confirm (`0172:1-6`), which is why this is W and not a violation. |

### §13 Experience Compiler and Opportunity Engine

Nothing in this section exists. `grep -rli "ExecutableTripExperience|OpportunityEvent|activity primitive"`
→ no matches; the thirteen activity primitives (EAT, SEE, MEET, DRINK, SHOP, WALK, REST,
PHOTO, EXPLORE, PLAY, LEARN, NIGHTLIFE, TRANSIT) appear nowhere as a vocabulary.

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR224 | An experience compiler producing `ExecutableTripExperience` | **N** | No compiler. The nearest artifact is `services/routeOptimizer.ts`, which orders stops by Haversine distance with a 2-opt pass and style adjustments (`:1-23`) — a route sequencer, not an experience compiler. |
| TR225 | …compiled from place/content | **C** | The one input that exists: `trip_saved_places` and `route_stops` both carry a typed place/content source (`0058_trip_flow.sql:60-63`). |
| TR226 | …+ freedom window | **N** | TR131. |
| TR227 | …+ participants | **N** | No attendance relation (TR149). |
| TR228 | …+ live conditions | **N** | No trip-scoped live conditions (§16). |
| TR229 | …+ transport | **N** | No transport object (TR18). `routeOptimizer.ts:22` flags long legs for rideshare; it does not model transport. |
| TR230 | …+ opening/queue constraints | **W** | `route_stops` carries an `openingHoursNote` consumed by the nightlife style (`services/routeOptimizer.ts:15-17`) — a free-text note used as a sorting hint, not an opening-hours constraint, and there is no queue model. |
| TR231 | …+ goals/preferences | **W** | `route_style` (`0058:18`) and `trip_area_preferences` express preference; goals do not exist (TR138). |
| TR232 | …+ next commitment | **N** | TR122. |
| TR233 | Activity primitives EAT \| SEE \| MEET \| DRINK \| SHOP \| WALK \| REST \| PHOTO \| EXPLORE \| PLAY \| LEARN \| NIGHTLIFE \| TRANSIT | **W** | Two adjacent vocabularies exist and neither is this one: `trip_plan_items.category` is `accommodation \| activity \| dining \| transport \| free_time \| meeting_point \| other` (`0010_trip_plan.sql:10-11`, seven values), and `routeOptimizer` has `NIGHTLIFE_CATEGORIES` / `SCENIC_CATEGORIES` / `FOOD_CATEGORIES` (`:15-20`). Neither is a primitive set a compiler could reason over. |
| TR234–TR243 | Per-candidate properties: minimum/ideal duration · compressibility · interruptibility · reversibility · cost · energy cost · reservation requirement · queue distribution · accessibility constraints · failure/recovery routes | **N** ×10 | None exists. `trip_plan_items` has `starts_at`/`ends_at` (an *assigned* time, not a duration model) and nothing else from this list; `trip_budget` holds trip-level amounts, not per-candidate cost. |
| TR244 | The `OpportunityEvent` contract | **N** | Absent. |
| TR245–TR251 | `trigger` · `previousFreedomWindow` · `newFreedomWindow` · `opportunitiesAdded[]` · `opportunitiesRemoved[]` · `significance` · `expiresAt` | **N** ×7 | Absent — the four window-dependent fields have no subject (TR131) and the rest have no carrier. |
| TR252 | `reasonCodes[]` on an opportunity event | **N** | Absent. Reason codes exist elsewhere in the platform (Appendix B) but not here. |
| TR253 | Notify only when the action universe changes enough to matter ("weather changed" is raw data; "your saved rooftop is no longer viable, but an indoor plan now fits" is an opportunity-state change) | **N** | *Unguarded absence.* No opportunity state exists to change, and no notification in the trip domain is derived from one — `lib/tripReminderScheduler.ts` fires on a user-set clock time. Nothing prevents raw-data notifications being added. |

### §14 Map and Route Architecture

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR254 | The `TripMapProjection` contract | **N** | No trip map projection endpoint or type. `GET /trips/:tripId/plan/map` (`routes/trips.ts:1400`) returns plan items with coordinates — a marker list, not a projection with a version and a generated-at. |
| TR255 | Layer: stage | **N** | No stages (TR78). |
| TR256 | Layer: hotel/private anchors, **access controlled** | **W** | The control exists at the item level: `trip_plan_items.location_is_private` and `0010:22-23`'s coordinate prohibition, plus the crew card's hotel-blur (`lib/tripCrewLocation.ts:56-58`, `resolveExactCoords` at `:96-103`). There is no *anchor* concept and no projection-level exclusion rule — the safety depends on each writer setting a flag. |
| TR257 | Layer: active plans | **W** | `GET /trips/:tripId/plan/map` returns plan items; "active" cannot be expressed (no IN_PROGRESS, TR46). |
| TR258 | Layer: confirmed commitments | **N** | TR122. |
| TR259 | Layer: saved ideas | **C** | `trip_saved_places` (TR25), served at `routes/trips-expansion.ts:2085`, rendered by `src/hooks/useTripSavedPlaces.ts` on the trip page. |
| TR260 | Layer: crew presence summaries | **C** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:156`) returns per-member summary cards with no coordinates unless a live-share grant exists — a summary layer in the spec's sense; `CrewMapSection.tsx:36-53` renders it as a density map with no SDK and no exact positions. |
| TR261 | Layer: route chains | **W** | `route_plans` + `route_stops` + `route_legs` (`0058_trip_flow.sql:9,57,102`) are a chain and are a **parallel itinerary system**: `route_plans.trip_id` is nullable (`:12`), ~~the RLS policy is owner-only (`:29` `route_plans_owner_select`), so a trip's crew cannot see the trip's own route chain~~ — **STRUCK, see §32**: `route_plans_member_select` (`:32`), `route_stops_member_select` (`:85`) and `route_legs_member_select` (`:127`) all exist and RLS policies are a UNION. The row stays W for TR437's actual reason — a parallel itinerary attached through a nullable `trip_id` — and it is now a live layer in the §14.1 projection. See TR437. |
| TR262 | Layer: meetup points | **W** | `trip_plan_items.category = 'meeting_point'` (`0010:11`) is a label on an ordinary item; there is no meetup object with participants, arrival state or an alternative set. |
| TR263 | Layer: live opportunities | **N** | §13.3. |
| TR264 | Layer: safety/logistics points | **N** | No safety layer on any trip map; Safe Return has no map projection. |
| TR265 | §14.2 Trips optimises sequences, not isolated origin/destination pairs | **C** | `services/routeOptimizer.ts:1-23` — nearest-neighbour seed plus a **2-opt improvement pass** over the whole sequence, with style post-adjustments. This is genuine sequence optimisation and it is the strongest artifact in §14. |
| TR266 | Route chains carry expected departure/arrival | **C** | `route_stops.planned_arrival_time` / `planned_departure_time` (`0058_trip_flow.sql:66-67`). |
| TR267 | …future-time traffic/transit assumptions | **N** | `services/routeOptimizer.ts:1-6` — *"All distances and durations are APPROXIMATED using straight-line (Haversine) distance. Every output is labeled `isApproximated: true`."* No traffic model, no departure-time dependence. The honesty of the label is why the *product* is safe and the requirement is still unmet. |
| TR268 | …cost | **N** | No cost on a route leg; `route_legs` carries `distance_meters` (`0058:107`). |
| TR269 | …party size | **N** | Absent (TR150). |
| TR270 | …reliability | **N** | Absent. |
| TR271 | …fallback route references | **N** | No alternative or fallback route reference on `route_plans`. |
| TR272 | §14.3 A smart meeting-point service | **N** | `grep -rn "findMeetingPoint\|meetingPoint"` over the trip paths returns Wall, Safe-Return-trigger and map-test hits, none of them a meeting-point computation for a trip crew. |
| TR273–TR278 | §14.3 constraints: next commitments · accessibility · party size · venue suitability · privacy policy · transport reliability | **N** ×6 | No service, therefore no constraints. Four of the six also have no representation anywhere (commitments, accessibility, party size, transport reliability). |
| TR279 | §14.3 The service returns explanation and alternative candidates rather than a magic coordinate | **N** | No service. Worth noting the *pattern* exists elsewhere and would have been reusable: `route_plans.compass_explanation` (`0058:20-21`) caches the pipeline's explanation of stop order, which is exactly the shape §14.3 asks for. |
| TR280 | §14.4 Sensitive anchors (hotel/private lodging) never appear in public or broad social projections | **C** | `src/test/tripPrivacy.test.ts:5-8` asserts the hotel name is absent from `toPrivateTripPreview`, and `0010_trip_plan.sql:22-23` forbids coordinates on the plan-item label outright. |
| TR281 | §14.4 Traveler pins obey presence visibility and freshness contracts | **W** | Visibility yes and rigorously (`lib/tripCrewLocation.ts:119-152`). Freshness no — TR165 is exactly this failure: a pin under a live grant is drawn as live regardless of the observation's age. |
| TR282 | §14.4 Clusters and aggregate counts may be used where exact identity/location is unnecessary | **C** | `CrewMapSection.tsx:36-53` `DensityMap` renders rings and counts from status labels with **no coordinates at all** and no map SDK — the aggregate form the rule permits, chosen as the default rather than as a fallback. |

### §15 Transport, Booking and External References

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR283 | The `TransportSegment` contract | **N** | TR18. |
| TR284 | `state = PLANNED \| BOOKED \| WAITING \| IN_PROGRESS \| COMPLETED \| DISRUPTED` | **N** | No transport state machine. `trip_reservations.status` is `pending_confirm \| confirmed \| dismissed` (`0172:26-27`) — an import lifecycle, not a transport lifecycle. |
| TR285 | `providerRef` | **C** | `trip_reservations.confirmation_ref` (`0172:20`), kept as opaque text with no attempt to parse or canonicalise it. |
| TR286 | `partySize` | **N** | Absent. |
| TR287 | `reliability` | **N** | Absent. |
| TR288 | §15.2 Trips stores booking references and operational facts needed for coordination, not payment credentials | **C** | `0172_trip_reservations.sql:10-31` — type, title, times, location name, confirmation ref, cancellation deadline. **No payment column of any kind.** |
| TR289 | §15.2 Booking ownership remains with the booking/provider domain | **C** | Nothing in Trips creates or cancels a booking with a provider; `routes/tripReservations.ts` is import-and-record only (`:118` paste-import, `:189` manual create). |
| TR290 | §15.2 Cancellation/refund policies imported as versioned facts, treated with provenance/confidence | **W** | Provenance and confidence are genuinely there: `0172:22-24` keeps `raw_text` (*"original pasted text (audit / re-extract)"*), `extraction` (*"model output for this row, verbatim"*) and `extraction_confidence` (*"model-reported 0..1 (never invented)"*). **Versioning is not** — a re-import overwrites; there is no policy version and no history of what the policy said when. |
| TR291–TR295 | §15.3 On invalidating a booked activity the planner returns explicit side effects: booking at risk · cancellation deadline · potential cost · affected participants · required user confirmation | **N** ×5 | There is no planner and no invalidation path, so no side effects are computed. `cancellation_deadline_at` is stored (`0172:21`) and read by nothing on any change path. |
| TR296 | §15.3 Automatic replanning may not silently cancel purchases | **C** ⌀ | Satisfied structurally: there is no automatic replanning (TR196) **and** no code path anywhere cancels a reservation as a side effect — the only reservation state changes are the explicit `/confirm` (`routes/tripReservations.ts:309`), `/dismiss` (`:390`) and `DELETE` (`:416`), each requiring a direct user action and an authorization check. Flagged `⌀` because the guarantee rests partly on the absence of the feature it guards. |
| TR297 | §15.4 Booking/reservation history is append-only: confirmed then cancelled, not confirmed row deleted | **W** | Violated by a live endpoint. `routes/tripReservations.ts:416-437` — `DELETE /trips/:tripId/reservations/:id` issues `sc.from("trip_reservations").delete().eq("id", …)` and returns 204. The row is gone: no tombstone, no cancelled state (the `status` CHECK at `0172:26-27` has no `cancelled` value), no event. The authorization is stricter than for edit (*"creator or trip OWNER only"*, `:426-429`), which makes it a deliberate hard delete rather than an oversight. |
| TR298 | §15.4 Compensation is represented as a new state/event so replay remains accurate | **N** | No compensating state, no event, no replay (TR406). |

### §16 Trip Pulse and World Intelligence

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR299 | Trip Pulse is not a generic city feed; it projects world intelligence through the active Trip context (stage, location band, goals, saved ideas, commitments, crew, attention state) | **N** | `grep -rli "tripPulse\|trip_pulse\|TripPulse"` → nothing. Portava has a Pulse (`routes/pulse.ts`) and it is the generic city feed the requirement contrasts against; nothing filters it through a trip. |
| TR300 | Signal: crowd rising → saved nightlife venue may be better now; queue risk may increase later | **N** | `crowd_flow` and `world_pulse` producers exist (`lib/mapProducers/`) and no trip consumes them. |
| TR301 | Signal: rain arriving → invalidate weather-sensitive plan; create indoor fallback opportunity | **N** | No weather input to the trip domain at all. |
| TR302 | Signal: taxi demand high → increase future transport uncertainty/cost for affected route chains | **N** | No transport uncertainty model (TR287). |
| TR303 | Signal: event delayed → new free window may appear or downstream commitment may conflict | **N** | No free windows, no commitments, no downstream propagation. |
| TR304 | Signal: friend nearby → meetup opportunity subject to both parties' privacy/presence | **W** | The capability exists outside Trips and is correctly gated: `compass/CompassTools.ts:180-186` `who_is_around` — *"Fully permission-gated: only people who opted in to Circle sharing appear, at the granularity THEY chose … Never returns precise location or coordinates."* It is Circle-scoped, produces no opportunity, and is not projected through a trip. |
| TR305 | The `SignalEstimate` contract | **N** | No trip-side signal type. (The platform's intel layer has a comparable contract in `lib/intelContracts.ts`; nothing in Trips consumes it.) |
| TR306 | `value` + `confidence` | **N** | Absent in the trip domain. |
| TR307 | `sourceClass` | **N** | Absent in the trip domain. |
| TR308 | `observedAt` + `expiresAt` | **W** | Present for crew presence only (`lib/tripCrewLocation.ts:115,142`) and not as a signal estimate; `observedAt` is never rendered (TR159). |
| TR309 | `fallbackUsed` | **N** | Absent. |
| TR310 | `contradictorySources[]` | **N** | Absent. |
| TR311 | Contradictory sources increase uncertainty; the system must not silently select whichever source makes a recommendation easier | **N** | *Unguarded absence.* No trip-side signal has a source at all, so contradiction cannot be represented — and nothing prevents a future single-source pick. |
| TR312 | §16.3 Completed actions may generate privacy-safe operational observations only through explicit contribution policy | **C** | Enforced by a hard boundary that a sibling census verified independently: **no intel module writes any `trip_*` table, and no trip module writes any `intel_*` table.** Trip contribution to intelligence therefore cannot happen at all, let alone without a policy. The platform's contribution consent model (`2172_intel_contribution_consent.sql`, `route_flow_contribution_consent`) is separate and opt-in. |
| TR313 | §16.3 Temporary personal state is not automatically public intelligence | **C** | Same boundary, plus `lib/tripCrewLocation.ts:1-16`'s contract: crew location is visible only to the trip's own members at the granularity the member chose, and there is no path from it to any aggregate. |

### §17 Disruption, Safe Return and Rescue

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR314 | Trip health HEALTHY → ATTENTION → AT_RISK → DISRUPTED | **W** | `lib/tripReadiness.ts:57-60`'s score plus `ReadinessStatus = ready \| action_needed \| incomplete \| unknown` (`:40`) is a four-value health-shaped summary — of *preparation*, not of the journey, with no DISRUPTED state and no runtime input. And it is behind `trip_readiness_enabled`, seeded false (`0170:76`). |
| TR315 | Health is a summary projection; it does not replace concrete risks/reason codes | **C** | The best-stated rule in the trip domain: `lib/tripReadiness.ts:8-12` — *"CRITICAL-VISIBILITY RULE: the aggregate score must NEVER hide critical items. The summary always carries the FULL `criticalItems` array — untruncated — no matter how high the score is. Consumers must render criticalItems independently of the score."* |
| TR316 | NORMAL priority: discovery / execution / social | **C** | The default and only mode; `TripPage.tsx` composes hero → Compass brief → Today/Next → plans → posts. |
| TR317 | AT_RISK priority: logistics / affected commitments / recovery | **N** | No priority switch. Nothing changes what a trip surface shows based on trip state. |
| TR318 | SAFETY_EVENT priority: safety / official help / location coordination | **W** | The *content* exists — `services/safeReturn/` escalates through `escalationLevel: 0\|1\|2\|3` (`SafeReturnService.ts:33`) with contacts, notifications and an optional live share — but it escalates **notifications**, not the surface: no trip screen re-prioritises during an active Safe Return, and `app/safety-history.tsx` is a separate destination. |
| TR319 | Commercial recommendations and entertainment discovery are suppressed when a severe operational or safety state requires attention | **N** | *Unguarded absence.* Nothing consults safety or disruption state before rendering recommendations. `TripPage.tsx:16` fetches the Compass brief unconditionally; there is no suppression hook anywhere on the trip surfaces. |
| TR320 | A rescue entry point | **N** | No rescue surface. `app/safety-*.tsx` and `services/safeReturn/` cover the timer-and-contacts flow; there is no typed-problem entry point. |
| TR321–TR327 | Typed problems: missed transport · hotel issue · lost crew · no ride · travel-document issue · stranded traveller · emergency assistance | **N** ×7 | No typed-problem taxonomy exists. `SafeReturnService.ts:32` has a free-text `triggerReason` and an `emergencyNote` (`:38`) — unstructured strings, not a routed problem type. |
| TR328 | Compass may organise context but must escalate to airline, airport, embassy/consulate, local emergency or human support where appropriate | **W** | Escalation exists and is human-directed, not institution-directed: `SafeReturnService` notifies the user's own contacts and trusted circle through `SafeReturnNotificationService`, with `SafeReturnTriggerService` driving it. There is no airline, airport, embassy or emergency-services handoff anywhere, and `services/appeals/` is a moderation path, not human support for a stranded traveller. |
| TR329 | §17.4 Safe Return attaches to solo, subgroup or full-crew execution contexts | **W** | Solo: yes. Full-crew: yes — `SafeReturnService.ts:36-37` carries `notifyHostEnabled` and `notifyTripCrewEnabled`, and `CreateSessionInput` takes `tripId` and `planItemId` (`:30-31`), so a session is genuinely attached to a trip and a plan. Subgroup: impossible (TR151). Two of three. |
| TR330 | §17.4 Status sharing is opt-in | **C** | Every channel is a separate boolean on the session (`SafeReturnService.ts:35-38`), and the crew card surfaces safe-return status only when the member set `shareSafeReturnStatus` (`lib/tripCrewLocation.ts:154-156`). |
| TR331 | §17.4 …purpose-limited | **C** | `safe_return_live_shares` is a distinct table from `trip_crew_location_sessions` (`0167_safety_ddl_reconcile.sql:126`), with its own contacts and its own `canReceiveLiveLocation` per contact (`SafeReturnService.ts:25`) — a safety share cannot be read as a social share. |
| TR332 | §17.4 …time-limited | **C** | `0167:126-137` — `status IN ('active','stopped','expired')` with an `expires_at` index; `SafeReturnPrivacyGuard.ts:128` refuses an expired session on read. |
| TR333 | §17.4 It exposes operational states such as RETURNING / ARRIVED / NEEDS_HELP rather than unnecessary continuous location | **C** | `SafeReturnService.ts:17` — `SafeReturnStatus = "pending" \| "active" \| "safe" \| "missed" \| "cancelled"`: `active` ≈ RETURNING, `safe` ≈ ARRIVED, `missed` ≈ NEEDS_HELP. Different words, exactly the semantics, and location sharing is a **separate opt-in** rather than the mechanism (`canReceiveLiveLocation`, `:25`). |

### §18 Offline, Sync and Multi-Device

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR334 | A signed/versioned offline bundle | **N** | No bundle, signed or otherwise. `grep -rli "offlineBundle\|offline.*queue\|queuedOperation"` over the client → nothing. |
| TR335–TR341 | Bundle contents: next commitments · active plan · selected route · meeting points · critical addresses · cached map tiles where permitted · most recent certified context | **N** ×7 | None is cached. Four of the seven have no representation to cache (commitments, active plan, meeting points, certified context); the other three simply are not persisted. |
| TR342 | Stale / live-unavailable must be visible | **N** | The one requirement in §18.1 that could be met without a bundle, and it is not: the crew surface renders no age at all (TR159, TR166) and no trip surface shows a last-updated or offline banner. |
| TR343 | The `QueuedTripOperation` contract | **N** | No operation queue. Every trip mutation is a direct `fetch` that fails on a dropped connection. |
| TR344–TR348 | Offline-safe operations: join/leave plan · ready/presence change · complete activity · save idea · selected low-risk edits | **N** ×5 | No queue, and three of the five have no operation to queue (join/leave a plan requires plan participants, TR83; ready/presence has no set-presence write; complete-activity has no command). |
| TR349 | Sensitive or high-conflict mutations may require revalidation after reconnect | **N** | No reconnect path to revalidate on. |
| TR350 | §18.3 Saved ideas / reactions merge as set operations with idempotency | **W** | The *storage* is a set — `trip_saved_places` with a per-place row and a delete-by-entry endpoint (`routes/trips-expansion.ts:2110,2163`) — so a duplicate add is naturally absorbed. There is no idempotency key and no merge on reconnect, because there is no offline write. |
| TR351 | §18.3 Presence: newest valid observation with expiry/confidence; never simple last-write-wins across stale devices | **W** | Expiry is honoured (`lib/tripCrewLocation.ts:142`); confidence does not exist (TR162); and the underlying `user_location_state` is a single mutable row — last write wins, and a stale device's write is indistinguishable from a fresh one because there is no observation timestamp comparison on write. |
| TR352 | §18.3 Confirmed booking/time: optimistic concurrency with explicit conflict/proposal | **N** | No version, no `If-Match`, no conflict response. `routes/tripReservations.ts:263` `PATCH …/reservations/:id` is last-write-wins. |
| TR353 | §18.3 Membership/permissions: server authority; stale offline writes rejected/reconciled | **C** | Server authority is real and tested: membership is resolved server-side on every read and write (`lib/tripMembership.ts:23`), a removed member loses access on the next request (`src/test/tripPrivacy.test.ts:11`), and no membership state is client-authoritative. There are no offline writes to reject, which makes this partly structural. |
| TR354 | §18.4 Server aggregate version is canonical | **N** | No version (TR12). |
| TR355 | §18.4 Clients must not declare local write time as authoritative ordering across devices | **C** | They do not: `trips.updated_at` is set by a database trigger (`migrations/0001_spine.sql:91-93` `trg_trips_updated`), `trip_plan_items.updated_at` is set server-side (`routes/trips.ts:1520`), and `lib/tripStatus.ts:1-10` exists precisely to stop two *servers* disagreeing about time. No client clock reaches an ordering column. |

### §19 Projections and APIs

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR356 | `TripTodayProjection` | **N** | TR180. |
| TR357 | `TripTimelineProjection` | **W** | `GET /trips/:tripId/plan` (`routes/trips.ts:1330`) returns the ordered plan; the client builds `TimelineDay[]` (`src/types/models.ts`, rendered at `TripPage.tsx:241-264`). A client-assembled day list, not a server projection with a version and a freshness. |
| TR358 | `TripMapProjection` | **W** | `GET /trips/:tripId/plan/map` (`routes/trips.ts:1400`) — plan items with coordinates and nothing else from §14.1's eleven layers. |
| TR359 | `TripCrewProjection` | **W** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:156`) is the closest thing to a real projection in the trip domain — it is assembled server-side, privacy-resolved before serialization, and returns a typed card list. It carries no `generatedAt`, no version and no freshness, and it is behind `trip_crew_map_enabled`, seeded false. |
| TR360 | `TripCompassProjection` | **N** | Compass reads raw tables (`CompassTools.ts:405-452`). |
| TR361 | `TripSafetyProjection` | **N** | Safety has services and endpoints, not a trip projection. |
| TR362 | `TripMemoryProjection` | **N** | Nothing projects a trip into Memory. |
| TR363 | `TripPassportProjection` | **W** | It exists and points the other way: `services/passport/PassportConsumerProjections.ts:31` builds a **Trips-facing view of the Passport** (*"trips → TABLE 22 Trips row"*), and `src/test/tripsPassportProjection.test.ts` proves it. Trip completion does feed Passport, but through stamps (`src/test/passportStatsFromTripCompletion.test.ts:1-13` — `awardTripCompletionStamps` → `user_stamps` with `source_type="trips"`), not through a projection. |
| TR364 | Every projection includes `generatedAt` | **N** | None does. |
| TR365 | …`sourceTripVersion` | **N** | No version exists (TR12). |
| TR366 | …`projectionSchemaVersion` | **N** | Absent. |
| TR367 | …`freshness` status | **N** | Absent — and TR165 is what that absence costs. |
| TR368 | Consumers reject or visibly degrade on stale/incompatible critical projections | **W** | Degradation is real and tested where it exists: `routes/tripCrewLocation.ts:164-167` returns `{ featureEnabled: false, members: [], totalCount: 0 }` rather than an error when the flag is off; `src/test/tripsHostingDegraded.test.ts` covers the degraded host path; `lib/tripReadiness.ts:14-18` wraps every optional source read so *"absence degrades to 'no data' instead of an error."* None of it is staleness-driven, because nothing carries freshness. |
| TR369 | `GET /trips/:id/context` | **N** | Not registered. |
| TR370 | `GET /trips/:id/today` | **N** | Not registered. |
| TR371 | `GET /trips/:id/map` | **W** | `GET /trips/:tripId/plan/map` (`routes/trips.ts:1400`) — a plan-marker list under a different path. |
| TR372 | `GET /trips/:id/crew` | **W** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:156`) plus four sibling crew endpoints (`:187,213,241,313`). |
| TR373 | `GET /trips/:id/timeline` | **W** | `GET /trips/:tripId/plan` (`routes/trips.ts:1330`). |
| TR374 | `POST /trips/:id/commands` | **N** | Not registered, and no command exists to post (TR49). |
| TR375 | `POST /trips/:id/simulate` | **N** | Not registered. |
| TR376 | `GET /trips/:id/decisions/:decisionId/explain` | **N** | Not registered; no decision ledger. |
| TR377 | `GET /trips/:id/snapshots/:version` | **N** | Not registered; no snapshots, no versions. |
| TR378 | §19.3 Public/mobile write endpoints issue typed commands; they do not expose broad direct CRUD over canonical Trip tables | **W** | The exact opposite is what ships, and at scale: **97 registered trip endpoints** across seven route files (21 in `trips.ts`, 52 in `trips-expansion.ts`, 8 crew, 7 reservations, 5 budget, 3 readiness, 1 draft), of which roughly half are direct CRUD over canonical tables — `POST/PATCH/DELETE /trips/:tripId/plan/items[/:itemId]`, `/destinations`, `/notes`, `/documents`, `/saved-places`, `/checklists[/items]`, `/reminders`, `/budget`, `/members`, `/reservations`. `routes/trips.ts:1520-1533` is the canonical example: fourteen `if (patch.X !== undefined) dbPatch.y = patch.X` lines feeding one `update`. It is **W** and not **N** because the writes are authorized (TR52) and schema-validated (TR51) — the discipline the rule was protecting is partly present; the shape it mandates is absent. |
| TR379 | §19.4 Projection workers consume domain events/outbox entries and are idempotent by event id + aggregate version | **N** | No projection workers. The two trip workers that exist (`lib/tripReminderScheduler.ts`, `lib/tripCrewLiveShareScheduler.ts`) are timer-driven pollers over their own tables (TR75). |
| TR380 | §19.4 Rebuild jobs can regenerate projections from canonical state/events without changing business state | **W** | One exists and it is genuinely a rebuild: `lib/tripReadiness.ts:1-7` recomputes readiness from source tables and upserts by `(trip_id, dedupe_key)` with a stale-row sweep, changing no business state. It rebuilds from canonical *state*, not from events, and it is the only one. |

### §20 Memory, Passport and Post-Trip Lifecycle

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR381 | Operational logs do not become permanent memory wholesale | **C** | They cannot: nothing reads `trip_activity_log` except the trip's own activity endpoint (`routes/trips-expansion.ts:2532`), and no Memory or Passport path touches it. The prohibited path does not exist and there is nothing that would create it, because Memory is fed by stamps and posts. |
| TR382 | Durable post-trip projections are based on meaningful outcomes (places visited, activities completed, people intentionally associated, stamps, media, milestones, user-approved story elements) | **W** | One outcome channel works: trip completion awards stamps that drive Passport counts — `src/test/passportStatsFromTripCompletion.test.ts:1-13` proves a completed trip yields non-zero Countries and Cities *"even if they never make a GPS-verified post from that location."* The other six are absent: no visited-place record, no completed-activity record, no intentional-association record, no milestone, no user-approved story step. |
| TR383 | §20.2 Closeout: stop/expire temporary presence | **N** | `routes/trips-expansion.ts:494-518` — the whole `POST /trips/:tripId/complete` handler is an authorization check, a status update and a `logActivity` line. It touches no presence table. Live shares expire on their own timer (`lib/tripCrewLiveShareScheduler.ts`) rather than on completion. |
| TR384 | §20.2 …dissolve temporary crews where appropriate | **N** | Same handler; no crew action. There are no temporary crews (TR151). |
| TR385 | §20.2 …reconcile uncertain plan outcomes | **N** | Same handler. Plan items keep whatever status they had; a `tentative` item stays tentative forever. |
| TR386 | §20.2 …close operational decision tasks | **N** | No decision tasks (TR21). |
| TR387 | §20.2 …preserve decision/audit evidence per policy | **W** | `trip_activity_log` preserves eleven event types indefinitely with no retention policy (TR100) — evidence preserved by default rather than by policy, and not including any plan decision (TR58). |
| TR388 | §20.2 …project Passport/Memory candidates | **W** | Stamps are awarded on completion (TR382) — a projection of a kind, produced by the Passport programme's own award engine rather than by a trip closeout step. No Memory candidate is produced. |
| TR389 | §20.2 …archive rebuildable operational projections | **N** | Nothing is archived on completion; `trip_readiness_snapshots` keeps recomputing for a completed trip. |
| TR390 | §20.3 Minimal reconciliation — ask only the smallest useful post-trip question set | **N** | No post-trip questions at all. Neither the minimal form the spec wants nor the exhaustive form it warns against exists. |
| TR391 | §20.4 A trip-specific preference must not automatically become a permanent user preference | **C** | The path is closed: `trip_area_preferences` is trip-scoped storage read and written only by `routes/neighborhoods.ts:75,170,189` (three call sites, verified by opening them), and `services/passport/` derives durable preference from stamps and posts. No writer moves a trip preference into a profile. |
| TR392 | §20.4 Durable preference projection requires the separate memory inference policy and confidence/evidence thresholds | **C** | That policy exists and is enforced elsewhere: `memory_remembers_for_user` plus `PassportRemembersService`'s deny gate (expired / non-active / sensitive / sensitive-category inference / deleted-subject), which `services/media/MyWorldMemoryService.ts:14-23` documents as the shared boundary. Trips has no bypass. |

### §21 Observability and Decision Ledger

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR393 | `trip_command_rejected_total` by reason | **N** | No commands (TR49), no metric. |
| TR394 | `projection_lag_seconds` | **N** | No projections, no metric. |
| TR395 | `temporal_conflict_total` | **N** | No conflict detection (TR128). |
| TR396 | `plan_at_risk_total` | **N** | No AT_RISK state (TR46). |
| TR397 | `opportunity_created_total` / accepted / completed | **N** | No opportunities (TR244). |
| TR398 | `notification_actionability_rate` | **N** | `notification_delivery_attempts` is logged (`NotificationRouter.ts:3-4`) — delivery, not actionability. No metric relates a notification to a subsequent action. |
| TR399 | `stale_presence_render_attempt_total` | **N** | The single most telling absence in §21: the metric exists to catch exactly the defect at TR165, and neither the metric nor the detection exists, so the regression is not merely unmeasured — it is unmeasurable. |
| TR400 | `trip_event_replay_mismatch_total` | **N** | No replay (TR406). |
| TR401 | The `TripDecision` ledger contract (inputs, sources, assumptions, constraints, result, confidence, engineVersions, calculatedAt) | **N** | No decision ledger. `trip_activity_log.metadata` holds `{ fields: [...] }` on an update (`routes/trips-expansion.ts:433`) — which columns changed, not why. |
| TR402 | Any consequential automated suggestion/replan is explainable from stored inputs and versioned algorithms | **W** | One narrow instance is genuinely explainable: `route_plans.compass_explanation` (`0058_trip_flow.sql:20-21`) caches *"Compass pipeline output explaining stop order"* and `services/routeOptimizer.ts:23` generates it, and `route_plans.is_approximated` (`:22`) records the algorithm's own limitation. There is no engine version, no stored inputs and no other explainable decision. |
| TR403 | …without retaining unnecessary sensitive raw data | **W** | Mostly honoured — `route_plans` stores an explanation, not the inputs. The counter-example is `trip_reservations.raw_text` (`0172:22`), which retains the traveller's entire pasted booking email verbatim, indefinitely, for re-extraction. Justified in its header (*"audit / re-extract"*) and it is exactly the retention this rule asks to avoid. |
| TR404 | §21.3 Optimise for successful real-world action and coordination, not screen time | **C** ⌀ | No screen-time metric exists in the trip domain, and the surfaces are task-shaped: `trips.progress` (`0001_spine.sql:86`) and `lib/tripReadiness.ts:57-60` both measure *completeness of preparation*. Flagged `⌀` — the guarantee rests on the absence of an engagement metric rather than on a positive real-world-action metric, of which there is none either. |

### §22 Snapshots, Replay, Simulation and CI

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR405 | The `TripSnapshot` contract | **N** | No snapshot table or type (TR27). `trip_readiness_snapshots` (`0175`) is a cached readiness summary with none of the contract's fields. |
| TR406 | Replay a Trip from a snapshot plus ordered events and compare resulting state | **N** | No snapshots, no ordered events (TR70), no replay harness. |
| TR407 | Event payloads are schema-versioned | **N** | TR72. |
| TR408 | Migration adapters are deterministic and covered by fixtures | **W** | Migration *discipline* is exceptional platform-wide — `scripts/certifyMigrations.ts`, `scripts/checkMigrationLedger.ts`, `scripts/checkMigrationPrefixes.ts`, `scripts/auditMigrationsVsLive.ts`, `scripts/checkProductionDrift.ts` — but these certify **schema** migrations, not event-payload adapters, which do not exist because events do not. |
| TR409 | Decision-diff CI: planner/coordination changes run against historical or synthetic Trip scenarios | **N** | No scenario corpus and no diff harness. The trip test suite (30 backend files) is unit and route-integration; none replays a scenario. |
| TR410 | …reporting changed decisions, increased/decreased conservatism, new conflicts, unexplained large diffs | **N** | Absent. |
| TR411 | Safety/authorization invariants block merge regardless of product experiment | **C** | This one is met, and by the platform's strongest machinery: ~40 `src/scripts/check*.ts` ratchets run in CI, including `checkAuthorizationContract.ts`, `checkSilentSupabaseWrites.ts`, `checkLocationPurposes.ts`, `checkDataRights.ts`, `rlsDispositions.ts` (which carries `trip_activity_log` at `:458` and `trip_area_preferences` at `:459`) and `checkWriterlessReads.ts`. A trip change that weakened an authorization contract would fail the build. |
| TR412 | §22.4 An earlier hard commitment cannot increase the preceding certified free window | **N** | Vacuous and unguarded: no commitments, no windows, no invariant test. |
| TR413 | §22.4 A closed-before-arrival activity cannot remain executable | **N** | No opening hours as a constraint (TR230), no executability concept. |
| TR414 | §22.4 A removed participant cannot receive future precise trip presence through that Trip | **C** | Proven, and it is the only §22.4 invariant with a test: removal deletes the `trip_members` row (`routes/trips.ts:1647` `DELETE /trips/:tripId/members/:userId`), `routes/tripCrewLocation.ts:170-174` refuses a non-member with `not_member`, and `src/test/tripPrivacy.test.ts:11` asserts *"A removed member immediately receives the preview on the next request."* Caveat recorded at TR109: the same gate admits *invited* members, so the invariant holds for removal and is looser than it should be for admission. |
| TR415 | §22.4 An unknown place identity cannot be silently treated as a canonical place match | **C** | `0010_trip_plan.sql:14-15` types the source (`'manual'` default), `lib/placeIdBridge.ts` is the only sanctioned crossing, and `scripts/checkSchemaReferences.ts` is the ratchet. An unresolved place stays typed as manual. |
| TR416 | §22.4 A projection's `sourceTripVersion` may never exceed the canonical aggregate version | **N** | Neither side of the comparison exists (TR12, TR365). |
| TR417 | §22.4 A duplicate command with the same idempotency key cannot produce a duplicate state transition | **N** | No idempotency key anywhere in the trip domain. The nearest artifact is a route-level short-circuit — `routes/trips-expansion.ts:508` returns `{ status: "completed", idempotent: true }` when a trip is already completed — a per-endpoint guard, not the invariant. |

### §23 Test Matrix and Certification Scenarios

Thirty backend test files carry a trip in their name and the client adds roughly twenty
more. None of them is a §23 scenario: every one is a unit or route-integration test of a
single endpoint or helper. The verdicts below ask whether the scenario's *must-prove*
column is proven anywhere.

| id | Scenario | V | Evidence |
| --- | --- | --- | --- |
| TR418 | Solo 3-day city trip — lifecycle, Today, free windows, saved-to-plan conversion | **W** | Lifecycle is proven (`src/test/tripCompletion.test.ts`, `tripsExpansion.test.ts`, `src/lib/tripStatus.ts` unit tests, and the client's `TripsTab.staleActiveStatus.component.test.tsx`); saved-to-plan conversion exists (`src/services/tripPlan.ts` `createPlanItem` from `AddToPlanSheet.tsx`). Today and free windows have nothing to prove. |
| TR419 | 6-person nightlife trip — attendance, subgroup split/rejoin, presence privacy, route chain | **W** | Presence privacy is proven thoroughly (`src/test/tripCrewLocation.test.ts`, `tripCrewMap.test.ts`, `tripPrivacy.test.ts`) and route chains exist (`tripRoutePlan.test.ts`). Attendance and subgroups do not exist. One and a half of four. |
| TR420 | Flight delay on arrival — dependency propagation, downstream proposal/replan | **N** | No dependency graph, no propagation, no replan. |
| TR421 | Offline member for 6h — queue/reconnect, stale presence, no destructive last-write-wins | **N** | No queue (TR343), and stale presence is the live defect (TR165), not a tested case. |
| TR422 | Concurrent host edits — optimistic concurrency and impact preview | **N** | No concurrency control (TR53) and no impact preview (TR156). |
| TR423 | Rain invalidates tour — risk trigger, fallback opportunity, booking side-effect explanation | **N** | None of the three exists. |
| TR424 | Cross-timezone multi-city — correct instant ordering and stage local-time display | **W** | Timezone correctness is real and hard-won at the trip level: `lib/tripStatus.ts:1-10,13-23` compares dates in the trip's IANA timezone (`en-CA` formatting for direct comparability) and its header records the bug that motivated it. Multi-city is `trip_destinations` with no per-destination timezone (TR13), so *stage* local-time display cannot be done. |
| TR425 | Layover nested in journey — Trip leg delegates layover execution while preserving journey context | **W** | A Layover programme exists (`services/airport/LayoverNotificationService.ts`, `app/layover/`) and is **not nested in a trip**: there is no leg (TR14) to delegate from, and no trip field references a layover. Two systems, no seam. |
| TR426 | Member removed mid-plan — authorization revoked immediately; sensitive projections updated | **C** | The first half is proven (TR414). The second is satisfied structurally: there are no cached projections to update, so revocation takes effect on the next read by construction. |
| TR427 | Long-stay 45 days — recurring commitments, routine-aware context, no bloated itinerary model | **W** | The third clause holds by accident — `trip_plan_items` is day-keyed and unbounded, so a 45-day trip is not structurally worse than a 3-day one. Recurring commitments and routine-aware context do not exist. |
| TR428 | Trip closeout — presence expiry, crew closure, outcome reconciliation, Memory/Passport candidates | **W** | One of four: `src/test/passportStatsFromTripCompletion.test.ts` and `tripCompletion.test.ts` prove the Passport half. Presence expiry, crew closure and outcome reconciliation are TR383–TR385, all N. |
| TR429 | §23.1 Unit tests cover pure invariants/policies | **C** | `src/lib/tripStatus.ts` and `lib/tripCrewLocation.ts` are pure by construction (`:1-6` *"pure functions (no DB calls)"*) and are unit-tested; `lib/tripReadiness.ts` is covered by `src/test/tripReadiness.test.ts`. |
| TR430 | §23.1 Database tests cover RLS, FK/unique constraints, idempotency, migrations | **W** | RLS and constraints: yes, via `scripts/rlsDispositions.ts` and the migration certification chain. Idempotency: nothing to test (TR417). |
| TR431 | §23.1 Service integration tests cover command → event → projection | **N** | None of the three stages exists. |
| TR432 | §23.1 Mobile tests cover state-driven UI and degraded/offline behaviour | **W** | State-driven UI is well covered (`TripsTab.staleActiveStatus.component.test.tsx`, `TripBudgetSection.*.test.tsx`, `TripReservationsSection.importError.component.test.tsx`, `TripEntrySection`, `TripNLDraft`, `TripPage.remindMeEntry`). Offline behaviour has nothing to test (§18). |
| TR433 | §23.1 Scenario/replay tests cover cross-domain lifecycle behaviour | **N** | No scenario or replay tests (TR409). |

### §24 Migration and Rollout · §25 Definition of Done · Appendices

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR434 | §24 Phase 0 — inventory the existing Trip tables/routes/services against the new kernel and freeze semantic drift by documenting current write paths; do not big-bang rewrite | **N** | No such inventory exists. `docs/` holds `TRIP_PASS_2_REPORT.md` (a product QA pass) and no map of trip write paths to a kernel. This census is, so far as I can find, the first enumeration of the trip write surface — which is itself the finding: **Phase 0 was never done, and every later phase depends on it.** |
| TR435 | §24 Phase 1 — ratchet direct writes: new code must use commands; legacy paths are enumerated and reduced | **N** | No ratchet, no enumeration, no reduction. The platform demonstrably *can* build such ratchets (~40 `check*.ts` scripts, including table-specific write-boundary migrations like `2158_post_media_write_boundary.sql` and `2147_hidden_gems_write_boundary.sql`) — none exists for trips, and the direct-write count grew rather than shrank (97 endpoints). |
| TR436 | §24 Phase 6 — safety, security, privacy, cost and irreversible-action gates remain independent controls | **C** | They are independent and they are separate flags: `trip_crew_map_enabled`, `trip_crew_live_share_enabled`, `trip_crew_ghost_mode_enabled` (`0041_trip_crew_location.sql:63`) and `trip_readiness_enabled` (`0170:76`) are four distinct gates, all seeded false, each guarding a different class of exposure — plus the platform-wide kill switches (`lib/featureFlags.isKillSwitchEngaged`, consumed at `lib/mediaPipeline.ts:44`). |
| TR437 | §25 New capabilities integrate by consuming Trip Context, issuing Trip Commands, emitting/consuming typed events and projecting outcomes — **not by adding another isolated itinerary feature** | **N** | The tree contains the counter-example the clause was written to prevent: `route_plans` / `route_stops` / `route_legs` (`0058_trip_flow.sql:9,57,102`) is a **second itinerary system** with its own stop ordering, its own optimizer, its own checkpoint state and its own checkpoint state, attached to a trip through a *nullable* `trip_id` (`:12`). ~~A trip's crew cannot read the trip's own route plan.~~ **STRUCK, see §32** — three member-read policies exist and the sentence was an inverted reading of `:29`. Everything else in this row stands: two itineraries, no shared context, no events. |
| TR438 | App A `src/domain/trips/` (contracts, commands, events, policies, invariants, services, projections, replay) | **N** | No `src/domain/` directory exists in `artifacts/api-server/src`. Trip logic lives in `routes/` (10,606 lines across seven files), `lib/trip*.ts` (eight modules) and `services/tripCrew/`. |
| TR439 | App A `src/features/trips/` (today, timeline, crew, map, planning, disruption) | **W** | `travel-buddy-standalone/src/features/` contains `map`, `media`, `passport` and `wall` — **no `trips`**. Trip UI lives in `src/components/TripPage.tsx`, `TripsTab.tsx`, `components/trip/`, `components/tripCrew/` and `app/trip/`. Two of the six named concerns (crew, planning) have a directory; today, timeline, map and disruption do not. |
| TR440 | App A `server/trips/` (commandRoute, readRoutes, outboxWorker, projectionWorkers, integrationAdapters) | **W** | Read routes exist and are substantial; `lib/tripReminderScheduler.ts` and `lib/tripCrewLiveShareScheduler.ts` are workers of a kind; `routes/tripReservations.ts:118` is an integration adapter of a kind. The command route, the outbox worker and the projection workers do not exist. |
| TR441 | App B `TRIP_AUTH_*` reason codes | **W** | The *behaviour* is there and the codes are not: `lib/http.ts` `sendError` emits `"forbidden"` / `"not_found"` / `"not_member"` (`routes/tripCrewLocation.ts:172`) — a platform-wide vocabulary with no `TRIP_AUTH_` family and no per-reason granularity. |
| TR442 | `TRIP_VERSION_*` | **N** | No versioning (TR12). |
| TR443 | `TRIP_TEMPORAL_*` | **N** | No temporal checks (TR128). |
| TR444 | `TRIP_SPATIAL_*` | **N** | No spatial checks (TR134). |
| TR445 | `TRIP_PRIVACY_*` | **N** | Privacy is enforced (TR117–TR121) and never reported as a coded reason. |
| TR446 | `TRIP_PRESENCE_*` | **N** | Presence refusals return a status label, not a reason code. |
| TR447 | `TRIP_BOOKING_*` | **N** | `routes/tripReservations.ts` returns generic `db_error` / `forbidden`. |
| TR448 | `TRIP_DISRUPTION_*` | **N** | No disruption model (§17.2). |
| TR449 | `TRIP_PROJECTION_*` | **N** | No projections (§19.1). |
| TR450 | `TRIP_IDENTITY_*` | **N** | Identity discipline is enforced by build-time ratchets (TR415), which fail a build rather than returning a runtime reason code. |
| TR451 | `TRIP_OFFLINE_*` | **N** | No offline path (§18). |

---

## 4. Sub-scores — the headline hides two different systems

The single number is misleading in both directions. The spec contains a large, deployed,
well-tested product and a kernel that was never started, and they score very differently.

| Sub-score | Denominator | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- |
| **The Trip Kernel and everything that depends on a version or an event** — §4, §5.1, §11.1, §13, §19.1, §19.4, §21, §22, Appendix B (TR49–TR91, TR180–TR192, TR224–TR253, TR356–TR368, TR379–TR380, TR393–TR417, TR441–TR451) | 137 | **24.8 %** | **5.1 %** |
| **The deployed coordination product** — §3, §6, §10, §14, §15, §17.4, §20, §23 (TR35–TR48, TR101–TR121, TR157–TR179, TR254–TR298, TR329–TR333, TR381–TR392, TR418–TR433) | 136 | **57.4 %** | **28.7 %** |
| Everything else — domain model, semantics, prohibitions, Compass boundary, offline, disruption, rollout | 178 | **42.7 %** | **18.0 %** |

Read the first row again: of the 137 requirements that constitute the Trip Kernel and its
dependents, **seven are correct** — TR51 (command-service schema validation), TR52 (actor
capability), TR225 (compiler input: place/content), TR404 (north-star ⌀), TR411
(safety/authorization invariants block merge), TR414 (removed participant loses presence)
and TR415 (unknown place identity) — and every one of the seven is an artifact from another
programme that happens to land inside a kernel requirement. The 27 BUILT-BUT-WRONG verdicts
in that row are almost entirely the *deployed* schema being scored against the *specified*
schema: `trip_plan_items` for `trip_plans`, `trip_members` for `trip_participants`,
`trip_activity_log` for `trip_events`.

## 5. The three findings I would put above the percentage

**1. A stale crew location is drawn as live (TR165, TR164, TR166, TR281, TR399).**
`lib/tripCrewLocation.ts:131-146` returns `statusLabel: "live_sharing_active"` with an area
label whenever a live-share **grant** is active. The grant's expiry is checked (`:142`); the
underlying observation's age is not. `updatedAt` is carried on the wire (`:115`) and **no
client renders it** — `CrewMemberCard.tsx:5` states *"statusLabel drives the UI"*, and a
grep for `freshness|last known|stale|ago|updated` over `CrewMapSection.tsx` and
`CrewMemberCard.tsx` returns nothing. So a member who last updated their coarse location
three days ago, and who started a live share five minutes ago, renders as live in the
density map. §10.2 says *"The Trip Map must never draw a stale location as if it were
current"*; §21.1 asks for a `stale_presence_render_attempt_total` metric to catch exactly
this. Neither the guard nor the metric exists, so the defect is not merely present — it is
unmeasurable. This is a privacy-and-truth defect on a live surface, and it is the one thing
in this census I would fix first.

The mitigating facts, which are real: the whole surface is behind `trip_crew_map_enabled`
seeded false (`0041_trip_crew_location.sql:63`), no exact coordinate is exposed without a
live-share grant plus hotel-blur-off (`lib/tripCrewLocation.ts:96-103`), and ghost mode is
absolute and checked first (`:119-122`). The privacy architecture is good. The **freshness**
architecture is absent.

**2. Phase 0 was never done, and it is the phase everything else depends on (TR434).**
§24 Phase 0 is *"Map the existing Trip tables/routes/services to the new kernel. Freeze
semantic drift by documenting current write paths … Do not big-bang rewrite."* No such
document exists anywhere in `docs/`. In the meantime the write surface grew to **97
endpoints across seven route files**, roughly half of them direct CRUD over canonical
tables — which is precisely the drift Phase 0 exists to freeze, and precisely what §19.3
forbids. The platform demonstrably knows how to build the ratchet Phase 1 asks for
(`2147_hidden_gems_write_boundary.sql`, `2158_post_media_write_boundary.sql`,
`scripts/checkSilentSupabaseWrites.ts`); it has never been pointed at trips.

**3. There are two itinerary systems, which is the thing §25's closing principle forbids
by name (TR437, TR261).** `route_plans` / `route_stops` / `route_legs`
(`0058_trip_flow.sql:9,57,102`) has its own stop ordering, its own optimizer
(`services/routeOptimizer.ts`), its own checkpoint state machine (`:68`), its own
explanation cache (`:20-21`) and its own **owner-only** RLS (`:29`). Its link to a trip is
a *nullable* `trip_id` (`:12`). So a trip's crew cannot read the trip's own route plan, the
route optimizer never sees a plan item, and the plan list never sees a route. §25 ends:
*"New capabilities should integrate by consuming Trip Context … not by adding another
isolated itinerary feature."* One already exists.

## 6. What is genuinely good here, and should not be lost in a 17 % correct score

Five things in the trip domain are better than the spec asks for, and a rewrite would be
foolish to discard them:

- **`lib/tripStatus.ts:1-10`** — status is computed server-side from canonical facts in the
  trip's own IANA timezone, and the header records the exact bug that motivated it (two
  copies, one comparing UTC midnight, disagreeing at the day boundary). It ends *"Never let
  clients override this."* That is §3.1 done properly.
- **`lib/tripReadiness.ts:8-12`** — the CRITICAL-VISIBILITY RULE: *"the aggregate score must
  NEVER hide critical items … no matter how high the score is."* §8.3's warning about
  gamified truth scores, anticipated and answered.
- **`lib/tripCrewLocation.ts:96-103,119-122`** — three independent fail-closed conditions
  before an exact coordinate, ghost mode absolute and checked first. §6.2's "membership
  does not imply precise location access" enforced structurally.
- **`compass/CompassTools.ts:14,158-161,229`** — propose-only, with the authorization check
  run *before the proposal is returned* (`:712-716`) and an explicit instruction to the
  model never to claim the item was added. §12.2's hard boundary, met exactly.
- **`0172_trip_reservations.sql:1-6,22-24`** — an LLM extraction that lands in
  `pending_confirm`, keeps its `raw_text` and its self-reported confidence, and *"NEVER
  auto-commits to the trip plan."* §12.3's "uncertainty stays uncertainty" and §15.2's
  provenance requirement, both met.

## 7. What could not be verified

| id | Requirement | Why the tree cannot settle it | What would settle it |
| --- | --- | --- | --- |
| **TR114** | §6.2 Service-role mutations still pass application authorization; service role is not business authorization | Universally quantified over **97 trip endpoints**. Every handler I opened honours it — the service client is fetched after `requireUser` and the role check (`routes/trips-expansion.ts:497-508`, `routes/tripCrewLocation.ts:160-174`, `routes/tripReservations.ts:420-429`) — and I read roughly a dozen of the 97. **No artifact enforces the ordering**: `scripts/checkSilentSupabaseWrites.ts` flags unlogged writes, not unauthorized ones, so there is nothing in the tree that would have caught a violation. A sample cannot settle a universal. | A static ratchet asserting that `getServiceClient()` is never reached before an authorization call in a route handler — or a full read of all 97. |

**Deliberately not folded into CANNOT-VERIFY**, because the code question is settled even
though the effect is not:

| Verdict | What is unresolved | What would settle it |
| --- | --- | --- |
| TR157–TR166, TR260, TR281, TR359 (crew presence and the Trip Map) | All behind `trip_crew_map_enabled`, seeded false (`0041:63`), alongside `trip_crew_live_share_enabled` and `trip_crew_ghost_mode_enabled`. The stale-live defect at TR165 is real code and may never have rendered for a user. | The production flag value. |
| TR140–TR143, TR188, TR314–TR315 (readiness, next-best-action, arrival board) | Behind `trip_readiness_enabled`, seeded false (`0170:76`). | The production flag value. |
| TR173–TR178 (Locate My Friends) | `locate_friends_sessions`, `_members`, `_positions`, `_audit` are **absent from production** (`scripts/checkProductionDrift.ts:177-180`). Built, mis-scoped to `route_plans` rather than trips, and undeployed. | Applying the migration, and a decision about the scope. |
| TR12, TR77 (no `version` column on `trips`) | Established from the migration chain plus the production table snapshot, which lists tables and not columns. A column added out-of-band would not appear. | A column-level production snapshot — though the verdict would not move: **no code anywhere reads or writes a trip version**, which is the load-bearing half. |

## 8. Three method caveats

1. **Writer attribution is incomplete by the repo's own analyzer's admission.**
   `src/scripts/checkWriterlessReads.ts:39-41` — *"A dynamic `.from(expr)` anywhere makes
   attribution incomplete, and the run says so rather than pretending otherwise."* Every
   "nothing writes X" here was settled by opening call sites: `trip_activity_log`'s single
   writer is `logActivity` (`routes/trips-expansion.ts:49-60`) and I enumerated its eleven
   call sites; `trip_area_preferences`' three call sites are all in `routes/neighborhoods.ts`.
   A `from("table")` grep alone would have missed the first (a shared helper) and
   over-reported the second.

2. **No database was queried.** Production facts come from the supplied ground truth and
   the committed snapshot `baseline/20260907_production_tables.txt`, cross-checked against
   `scripts/checkProductionDrift.ts`'s classification table. Where a migration disagrees
   with a production fact, the production fact wins.

3. **Route coverage is a sample, and TR114 is where that bites.** I opened roughly a dozen
   of the 97 trip handlers in full and grepped the registration lines of all of them. A
   universally-quantified requirement over handlers (TR114) is therefore CANNOT-VERIFY
   rather than verified; existentially-quantified ones ("there is no command route", "there
   is no `/today`") are settled by the registration listing, which is complete.

---

## 9. If I had to say one thing

Portava has a good trip *product* — invites, membership, plans, destinations, budget,
documents, checklists, reservations with an honest LLM-import boundary, crew location with
a careful privacy contract, Safe Return, and thirty backend tests holding it together. It
has **none of the journey runtime this document specifies**: no kernel, no commands, no
events, no version, no projections, no stages, no commitments, no attendance, no free
windows, no replay. Those are not partially built; the strings do not occur.

So the useful reading of 17.3 % is not "the code is 83 % broken". It is: **this spec
describes a system that has not been started, on top of a system that already exists and
works.** The first thing anyone acting on this document should do is §24 Phase 0 — the
inventory and write-path freeze — because it was skipped, and skipping it is why the write
surface grew to 97 endpoints while the kernel stayed at zero.

---

## 26. Recensus of §4 at `2b680bdb` — and a correction to this document's headline

The §3 pass was taken at HEAD `68ed59d9`. This section re-reads **§4 only** and
corrects the attribution claim the document leads with. It does **not** re-read
the other twenty-four sections, and the headline table is deliberately left at
its original figures — see "What this does not claim" below.

### The attribution claim was true when written and is false now

The document opens with *"Not one artifact in this tree was built for this
specification, and I could not find one that has ever heard of it"*, and rests it
on two greps that returned essentially nothing. Both were re-run at HEAD:

| grep | at `68ed59d9` | at `2b680bdb` |
|---|---|---|
| spec / kernel / projection names | 1 file (a sibling census) | **47 files** |
| `TripCommand` / `trip_events` / `trip_command` | 0 | **34 files** |
| `aggregate_version` alone | 0 | **17 files** |

`2420_trip_kernel_foundation.sql` cites this spec **by section number in its own
header** (§4.3 for the TripEvent envelope, §5.1 for `trips.version` and
`trip_events`) — which is exactly the artifact the claim says does not exist.

**Why it went unnoticed for a whole programme of work:** this census declared no
`head_commit` and had no entry in `CENSUS_SCOPE`, so `check:census-freshness`
reported it CANNOT BE CHECKED rather than STALE. It is the strongest argument
available for the P3 recensus work — an unmeasurable census does not merely age,
it can inverted-report a surface's most important fact and nothing objects.

### §4: twelve of fourteen NOT-BUILT rows corrected

| id | was | now | what exists |
|---|---|---|---|
| TR49 | N | **C** | `TripCommand` envelope, `trip_command_receipts`, the RPC |
| TR53 | N | **C** | `trips.version` + `TRIP_VERSION_CONFLICT` |
| TR54 | N | **W** | ordering enforced (2750 + the kernel entry point); **overlap still not** |
| TR57 | N | **C** | canonical state and event written by one function in one transaction |
| TR68 | N | **C** | `trip_events` is the envelope — twelve columns, append-only by trigger |
| TR69 | N | **C** | `aggregate_version`, NOT NULL, `> 0` by constraint |
| TR70 | N | **C** | `sequence`, unique per trip — a real sequence, not `created_at DESC` |
| TR71 | N | **C** | `causation_id` / `correlation_id` |
| TR72 | N | **C** | `schema_version` NOT NULL DEFAULT 1 |
| TR73 | N | **C** | `occurred_at` and `recorded_at`, distinct columns |
| TR74 | N | **C** | `trip_outbox`, written in the event's transaction |
| TR76 | N | **C** | `mapTripProjectionWorker`, registered in `index.ts` |

**TR55 stays N** — the `Commitment` contract genuinely does not exist (TR15), so
there are no dependent commitments to validate. **TR54 is W, not C**, and the
distinction is the point: an inverted interval is now refused on both the trip
and the plan item, but an item may still be written across a confirmed item's
interval. Overlap is the §7 consistency engine (TR128, TR134) and needs a route
provider this tree does not have. Ordering built; overlap not.

### What this section does NOT claim

- **The other 24 sections are unaudited.** §7, §11, §12, §13, §14, §16, §19, §21
  and §22 still carry their `68ed59d9` verdicts, and the Trip Kernel programme
  plausibly moved rows in §5 and §19 too. Those were not opened.
- **No `head_commit` is declared here.** Declaring one would make
  `check:census-freshness` report FRESH about 24 sections nobody re-read — the
  same lie census-passport declines for the same reason. This census joins the
  checkable set when it is recensused whole.
- The headline table is unchanged and now understates the surface. Correcting it
  from a partial re-read would be inventing a number; §4's twelve rows are
  itemised above so the arithmetic is available to whoever finishes the job.

---

## 27. §5.1 recensus at `HEAD` — the stage spine, and the kernel deployment gap

This section re-reads **§5.1's table roster only** (TR77–TR90) plus the rows that
depend on stages existing. It does **not** re-read the other twenty-three
sections, and the headline table stays where §26 left it, for the reason §26
gives.

### The fact that changes how every other Trips row should be read

> **Corrected 2026-09-09, later the same day. The table below is the second
> measurement; the first is kept in §28 with what it got wrong, because the
> mistake it made is one this document is otherwise built to prevent.**

Measured read-only against both databases, comparing `pg_proc.prosrc` — the
verbatim function body — rather than `pg_get_functiondef` length:

| | md5 of the installed body | verdict |
|---|---|---|
| repo `2420` | `d621c513ef2093054aea014702733649` | — |
| production | `d621c513ef2093054aea014702733649` | **byte-identical to the repo** |
| portava-ci | `ed202dc5664f7f46e3b27c7810fb1a2e` | the same file, comments stripped |

portava-ci's kernel is the repo's 2420 with all nine whole-line `--` comments
removed and **nothing else** — proven by reproducing its exact md5 from the
repo's body by deleting comment lines. Same commands, same reason codes, same
branch count. Neither database is behind the other.

**Both databases carry 2420, and neither carries 2450, 2500 or 2590.** The
reason is not that a lane rehearsed and rolled back: `.github/workflows/
live-db.yml` applies pending migrations to the sanctioned CI project only when
`github.ref == refs/heads/main`, and **none of 2420, 2450, 2500, 2590, 2750,
2760–2763 or 2767 is on main** — this branch is 417 commits ahead of it. The
designed applier has never seen any of them. 2420 reached both databases by
hand, which portava-ci's own ledger records in its notes column, and which is
also how it arrived with its comments stripped.

This is the same class of error §26 found and larger. §26 corrected twelve rows
from N to C on the strength of migrations that are in the tree; every one of
those C verdicts is a claim about *code that exists*, and this table is the
reminder that none of it is a claim about *a database that has it*. The
programme's own rule already says this — BUILT ON BRANCH IS NOT MERGED, MERGED
IS NOT DEPLOYED — and here is the measurement that makes it concrete for §4.

It is also why `2764_trip_kernel_stage_family.sql` refused to apply to
portava-ci. Its base assertion checks for `SET_TRIP_COVER` before touching
anything, found none, and raised. Without that assertion the file would have
applied cleanly and produced a kernel with the stage family and without three
migrations' worth of commands.

The three are therefore not blocked on anything but the merge, and applying
them by hand would route around the dry run, the one-transaction-with-ledger-row
guarantee, the certification pass and the sanctioned-project assertion —
reproducing the exact mechanism that produced the drifted 2420. That assertion
is not advisory: `artifacts/api-server/src/lib/ciSupabaseGuard.mjs` runs it in
the execution path and refused this session's attempt to run even the dry run.

### §5.1: one row moves, and only to W

| id | was | now | what exists |
|---|---|---|---|
| TR78 | N | **W** | `trip_stages` exists (`2760_trip_stages.sql`) with the §5.1 columns, five CHECK constraints and a crew-read RLS policy, and now has the writer §4 requires: `ADD_STAGE` / `UPDATE_STAGE` / `REMOVE_STAGE` in `2764_trip_kernel_stage_family.sql`. **W and not C because 2764 cannot be applied anywhere** — see the table above. A command family that no database can execute is built, not deployed. |

**TR79, TR81, TR84–TR90 stay N.** `trip_legs`, `trip_commitments`, `trip_goals`,
`trip_decision_tasks`, `trip_risks`, `trip_presence`, `trip_proposals`,
`trip_snapshots` and `trip_outcomes` all have tables now (2761–2763) and **no
writer**. Rule 2 of this census is unchanged and decides them: *a table nothing
writes satisfies nothing.* They are N until their command families land, exactly
as TR78 was N between 2760 and 2764.

**TR83 stays N and is blocked, not merely unbuilt.** `trip_plan_participants` is
keyed on `plan_id`, and `trip_plans` does not exist — `trip_plan_items` is a
different shape (TR82). Building the table against `trip_plan_items` would be
inventing the specified table rather than building it.

**TR136 and TR255 stay N.** Both say "there are no stages"; there are now stages
in the repository, but stage-locality (TR136) is a §7.4 consistency check with no
implementation, and the stage map layer (TR255) has no consumer. Neither becomes
W because a table they would read now exists.

### What was actually verified, and how

2764 is not rehearsed on Supabase and cannot be. It is rehearsed on
`db/harness/run.sh`, a local PostgreSQL 16 cluster built for it: the 2590 body is
sliced out of 2590's own file rather than transcribed, the **real** 2760 runs
with all its postconditions, then 2764 applies and its commands **execute** —
rows written, events emitted, `trips.version` bumped, receipts and outbox rows
agreeing, refusals refusing and leaving nothing behind. The rollback must restore
`pg_get_functiondef` byte-for-byte or the run fails.

The harness found a defect the seven contract tests could not: the first draft
set `v_event_type` on all three branches and `v_family` on none, so every stage
event was filed in the ledger under family `plan`. The names all agreed with
TypeScript; only executing the command found it.

**What a green harness run is not:** it is bare PostgreSQL, not Supabase. Every
table except `trip_stages` is a column-shape stub taken from portava-ci with keys
and defaults added back, so a constraint that exists there and not here refuses
nothing here. Four enum types are text `DOMAIN`s. Every probe runs as superuser,
so RLS is bypassed — the same bypass `service_role` has, which is why the
kernel's own writes still mean something and why nothing here says anything about
client access.

### What this section does NOT claim

- **No `head_commit` is declared here either**, for §26's reason: twenty-three
  sections were not re-read.
- **The headline is unchanged.** One row moved N→W; correcting a percentage from
  that would be inventing a number.
- **Nothing here is a deployment claim.** 2760–2763 are applied to portava-ci
  and to nothing else; 2764 is applied to nothing at all.


---

## 28. Correction to §27's first measurement, and the two defects behind it

§27 originally opened with this table, and drew from it the conclusion that
portava-ci and production carry *different* kernels:

| | repo | portava-ci | production |
|---|---|---|---|
| `trip_kernel_execute` length | 44,343 ch | 11,314 ch | 11,976 ch |

Every number is correct. The conclusion is not. `pg_get_functiondef` length
counts comments, and portava-ci's copy of 2420 has had its nine whole-line
comments stripped. The two databases carry the SAME LOGIC: same command
vocabulary, same reason codes, same five `WHEN` branches. Production's body is
byte-identical to the repository's.

**The method error is the one worth recording.** A length is a proxy. Three
lengths that differ tell you the texts differ and nothing about how. The
measurement that settles it — `md5(prosrc)`, and then reproducing the
difference from the repo by a stated transformation — costs one more query and
answers the actual question. This census's own rule about verdicts, that a
BUILT claim cites a `file:line` that was opened and read, has a database
equivalent that was not being applied: **a claim about a deployed object cites a
hash of that object, not a size.**

### The two kernel defects the corrected rehearsal found

Running the ancestry as real migrations and then EXECUTING commands against it
found two things no amount of reading had:

| | what it is | fixed by |
|---|---|---|
| co_host is unreachable | 2500 added the `host` capability as "owner OR an accepted co_host row" and gated two commands on it, but `SET_PARTICIPANT_ROLE` refuses any role outside `('member','invited')`. No kernel command can create a co_host, so `host` and `owner` are the same capability and every co_host came from a writer outside the kernel — what §1 forbids. `viewer` has the same hole, and `authz.accepted_trip_ids` counts a viewer as crew. | `2769` |
| COMPLETED is not terminal | `CANCEL_TRIP` succeeds on a completed trip. §3.1 runs "… → COMPLETED → MEMORY" and §20.1 builds durable memory from a completed trip's outcomes, which `RECORD_OUTCOME` (2768) may already have written. A trip cannot both have happened and have been called off. | `2769` |

Neither is a row this census had open. Both were invisible to every contract
test, and both were found in the first minute of executing the ancestry rather
than reading it — which is the same lesson as the `v_family` defect §27 records,
arriving a second time.

---

## 29. Recensus of Trips WHOLE, at `head_commit` `823b6d67`

**This is the first section of this document that declares a `head_commit`, and
it is the first that re-reads every §5 row rather than a slice.** §26 and §27
both declined to declare one and said so; that was correct of them and it is
also why this document could go stale twice without noticing. It is declared
here so the next reader can age this section mechanically.

| Field | Value |
| --- | --- |
| `head_commit` | `42aeac38` — RE-DECLARED 2026-09-09 from `6c6995e1`, and the move is a measurement rather than a judgement: `git diff --name-only 6c6995e1 42aeac38` over this census's 35 scoped paths returns **0 files**, so every verdict is exactly as true at one as at the other. It was necessary because `6c6995e1` is a PRE-SQUASH commit — this repository squash-merges, so it is an ancestor of nothing and is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). `42aeac38` is #476's squash, where this document's content actually reached `main`. Measurement lineage unchanged: §29 measured `823b6d67`; §30 re-measured §7.4 at `c3f76a49`; §31 re-measured §9.3 and §14 at `6d3e7a56`; §32 corrected TR261/TR437 at `1ec4d903`; §34 re-read the three §5 read routes at `6c6995e1`; §35 executed the kernel live. ONE declaration, kept current, because `check:census-freshness` reads the first one it finds and a second row further down is a decoration that ages nothing. |
| Branch | `claude/portava-continuation-uqta94` |
| Scope re-read | §5.1's twelve tables, §7, §8, §9.1, §9.3, §10, §11, §20.1, §22 |
| NOT re-read | §1–§3, §6, §12–§19, §21, §23–§25. The headline stays where §26 left it. |
| Databases | Unchanged since §27: production and portava-ci both carry 2420 and nothing after it. Verified by `md5(prosrc)`, not by length — see §28. |

### 29.1 The finding this recensus exists for

Every previous Trips section, this document's own rule 2 included, measured
**writers**:

> *A table nothing writes satisfies nothing.*

That rule is right and it is half a rule. Measured at `a05971b0`, before the
work in this section:

```
for tbl in trip_stages trip_legs trip_commitments trip_goals \
           trip_decision_tasks trip_risks trip_proposals trip_proposal_votes \
           trip_outcomes trip_plan_participants; do
  grep -rl "\"$tbl\"" src/routes src/services src/lib | wc -l
done
→ 0 0 1 0 0 0 0 0 0 0
```

**Nine of the ten had a kernel writer and no reader anywhere** — not in the
server, not in the app. `trip_commitments` had exactly one, and that one is
covered in 29.3 because it turned out not to be a reader either.

The rule needs its mirror, and this section adds it as **rule 2b**:

> **A table nothing READS satisfies nothing either.** A row a user can never be
> shown is not a feature; it is a filing cabinet with a very good lock.

This was invisible for a specific and repeatable reason: §26 and §27 were
counting migrations, and every migration in the 2760–2777 band adds a WRITER.
Counting the thing being built is how a build measures itself as complete while
being unreachable. The check that would have caught it is one line, and it is
now three tests (`tripStructureRoute`, `tripDecisionsRoute`, `tripPresenceRoute`
each assert the route is registered in `routes/index.ts`).

### 29.2 The full vertical slice, per §5.1 table

The directive's rule is that a table alone counts as 0 %, and that a capability
counts only with UI/route → authorization → kernel command → validation → DB
mutation → event → projection → client-visible state. This is that chain,
measured rather than asserted. **W** = kernel writer, **R** = HTTP reader,
**S** = a screen that calls it.

| §5.1 table | W (migration) | R (route) | S (component) |
|---|---|---|---|
| `trip_stages` | 2764 ADD/UPDATE/REMOVE_STAGE | `tripStructure.ts` | `TripStageSpineCard` |
| `trip_legs` | 2765 ADD/UPDATE/REMOVE_LEG | `tripStructure.ts` | `TripStageSpineCard` |
| `trip_commitments` | 2765 ADD/UPDATE/REMOVE_COMMITMENT | `tripFeasibility.ts`, `tripStructure.ts` | `TripFeasibilityCard`, `TripStageSpineCard` |
| `trip_goals` | 2766 ADD/UPDATE/REMOVE_GOAL | `tripDecisions.ts` | `TripDecisionsCard` |
| `trip_decision_tasks` | 2766 ADD/UPDATE/REMOVE_DECISION_TASK | `tripDecisions.ts` | `TripDecisionsCard` |
| `trip_risks` | 2766 ADD/UPDATE/REMOVE_RISK | `tripDecisions.ts` | `TripDecisionsCard` |
| `trip_presence` | 2768 SET/CLEAR_PRESENCE, 2777 ordering | `tripPresence.ts` (via `trip_presence_current`) | `TripCrewPresenceCard` (reads **and writes**) |
| `trip_proposals` | 2768 CREATE/ACCEPT/REJECT, 2775 apply | `tripDecisions.ts` | `TripDecisionsCard` |
| `trip_proposal_votes` | 2775 VOTE_ON_PROPOSAL | **aggregate only**, via `trip_proposal_tally` | `TripDecisionsCard` (counts, not ballots) |
| `trip_snapshots` | 2773 `trip_snapshot_write` | `tripCommands.ts` | **none** |
| `trip_outcomes` | 2768 RECORD_OUTCOME | `tripStructure.ts` | `TripStageSpineCard` (served, not yet rendered per-outcome) |
| `trip_plan_participants` | 2772 JOIN/LEAVE/SET_PLAN_ATTENDANCE | `tripStructure.ts` | `TripStageSpineCard` (party size) |

**Two honest gaps in that table, stated rather than rounded away:**

- **`trip_proposal_votes` has no row-level reader.** The tally is served and
  that is the decision-relevant read, but §9.3 gives proposing and deciding
  different verbs and a crew member cannot currently see *who* voted. This is
  a real gap, not a design choice, and it is small.
- **`trip_snapshots` has a route and no screen.** `GET /trips/:id/snapshots/
  :version` is reachable from `services/tripCommands.ts` and nothing renders
  it. A snapshot is an operator-facing object and there is a defensible reading
  in which that is fine; this census does not make that call, it records that
  the slice stops at the service.

### 29.3 A category the four buckets cannot express, found twice

C / W / N / CANNOT-VERIFY has no cell for **built, wired, tested, and inert** —
code that runs, is reached, and cannot produce its own primary output. Two
things in this tree were exactly that, and both would have censused as W.

**§7 feasibility.** `GET /trips/:tripId/feasibility` hardcoded both endpoints of
every hop to `null`, with a comment explaining that `trip_commitments.place_id`
carries no foreign key. The absent FK is real and deliberate (§5.2); the
conclusion drawn from it was not. `place_id` denotes `public.places.id`, the
table carrying `latitude`/`longitude`. Until `resolvePlaces` landed, the
provider answered `NO_COORDINATES` on every hop and **the route could return
only UNKNOWN** — an engine with 44 tests proving it can establish INFEASIBLE,
behind a route that could never ask it to.

The old route test asserted the file still carried the "no foreign key" comment.
It was pinning the inertness, and it passed every time.

**§8 decision engine.** Three tables (2762) and nine kernel commands (2766), and
nothing joined a proposal to a decision task, a risk to the plan element it
endangers, or a §7 verdict to the option it should disqualify. The rows were
correct and the chain §8 describes did not exist.

**What to do with this in the buckets.** Nothing — the buckets stay. What
changes is the *evidence rule*: this census already requires a BUILT verdict to
cite a `file:line` that was opened and read, and §28 added that a claim about a
deployed object cites a hash. **A claim that a capability WORKS now requires a
test that observed its primary output**, not a test that observed its shape. The
13 behaviour tests in `tripFeasibilityRouteBehaviour.test.ts` exist because the
16 shape tests beside them could not tell the difference.

### 29.4 Row moves

| id | was | now | why |
|---|---|---|---|
| TR78 `trip_stages` | W (§27) | **W** | Writer (2764), reader (`tripStructure.ts`), screen (`TripStageSpineCard`). Stays W for one reason only: **no database has 2764**. |
| TR79 `trip_legs` | N | **W** | 2765 writer, structure route, spine card. |
| TR81 `trip_commitments` | N | **W** | 2765 writer; read by feasibility *and* structure. |
| TR84 `trip_goals` | N | **W** | 2766 writer, decisions route, decisions card. |
| TR85 `trip_decision_tasks` | N | **W** | 2766 writer; recommendations computed per pending task. |
| TR86 `trip_risks` | N | **W** | 2766 writer; §8.4 propagation implemented and served. |
| TR87 `trip_presence` | N | **W** | 2767 vocabulary, 2768 writer, 2776 freshness, 2777 ordering; read AND written from one card. |
| TR88 `trip_proposals` | N | **W** | 2768 + 2775; served with the §9.3 tally. |
| TR89 `trip_snapshots` | N | **W** | 2773 fold/replay/verify; served by `tripCommands.ts`. No screen (29.2). |
| TR90 `trip_outcomes` | N | **W** | 2768 RECORD_OUTCOME; served by `tripStructure.ts` with `planPresent`. |
| TR83 `trip_plan_participants` | N (**"blocked"**) | **W** | §27 said this was "blocked, not merely unbuilt" because `trip_plans` does not exist. **That was wrong and it contradicted TR82 in the same document**, which already said `trip_plan_items` IS §5.1's `trip_plans`. Migration 2770 made the identity explicit, 2771 built the table, 2772 wrote it. The correction is recorded here rather than silently applied. |
| TR136 stage-locality | N | **N** | §7.4's consistency check still has no implementation. Stages existing does not build it. |
| TR144 risk propagation | N | **W** | `propagateRisks` in `TripDecisionEngine.ts`, served as `elementRisks`, rendered by `TripDecisionsCard`. |
| TR123 arrival semantics | N | **W** | `required_arrival_at` exists (2761) and is now *used*: the feasibility engine judges against it, and a behaviour test drives the spec's own 19:00/18:45 example. |
| TR255 stage map layer | N | **N** | Still no map consumer for stages. `TripStageSpineCard` is a list, not the map layer §5.1 describes. |

**Not one row moves to C, and that is the whole point of the next section.**

### 29.5 Why nothing is C, stated once so it is not re-litigated

C requires the thing to work. Every row above is code in a branch:

```
BUILT ON BRANCH → not merged  (this branch is 400+ commits ahead of main)
MERGED          → not deployed (live-db.yml applies only from main)
DEPLOYED        → not flag enabled
FLAG ENABLED    → not production realized
```

Concretely, at this `head_commit`:

- **None of 2750 or 2760–2777 is on `main`.** `.github/workflows/live-db.yml`
  applies pending migrations to the sanctioned CI project only when
  `github.ref == refs/heads/main`, so the designed applier has never seen any
  of them.
- **Production and portava-ci both carry 2420 and nothing after it.** Neither
  has 2450, 2500 or 2590, let alone the 2764–2777 chain. §27 has the `md5`.
- **The exception is disclosed, not hidden**: 2760–2763 and 2767 were applied
  to portava-ci by hand in earlier sessions. That is how 2420 arrived with its
  comments stripped, and it is the mechanism `ciSupabaseGuard.mjs` exists to
  refuse. It refused this session's attempt to run even a dry run, which is the
  control working.
- **The rehearsal that DID happen** is `db/harness/run.sh`: a local PostgreSQL
  16 cluster that applies the real ancestry (2420 → 2450 → 2500 → 2590), then
  the schema migrations, then the fourteen transforms; runs 10 probe files that
  EXECUTE the commands; then rolls every transform back in reverse, checking
  `pg_get_functiondef` is byte-identical at each step. 18 rollback files, all
  exercised. What that is not: it is bare PostgreSQL, every table but the ones
  under test is a column-shape stub, four enums are text DOMAINs, and every
  probe runs as superuser so RLS is bypassed. It says nothing about client
  access and nothing about Supabase.

So the honest summary of the §5 rows is: **built, wired, reachable, rehearsed,
and undeployed.** Four of the five, and the fifth is not an engineering
blocker — it is a merge.

### 29.6 The fail-closed pass, and what it changed about earlier verdicts

Seventeen defects of one shape, audited and fixed at `d112f215`/`018d44f0`:
a read that FAILED was reported as an empty, clean, or finished result.
`supabase-js` **resolves** on a database error, so an unbound `error` is not a
latent crash — it is a confident wrong answer.

The ones that bear on Trips verdicts specifically:

| where | what it claimed | now |
|---|---|---|
| `GET /trips/:id/plan` | an unreadable `trips` row → no date warnings; an unreadable `meetups` read → no `cancelled_source` warning. A plan item pointing at a **cancelled** meetup served as clean. | 503 |
| five `trips` owner reads | "Trip not found" — a **non-retryable** claim about a trip nobody looked at | 503 |
| `canEditPlanItem` | "Plan item not found" — the 404 for someone else's item, said about your own | throws `TripAccessUnavailableError` |
| `lib/tripReadiness.ts` | `readyish = ready + unknown`, so a category nobody could measure **raised** the score. The less of a trip could be checked, the readier it scored. | score is a fraction of the MEASURED categories; `null` when none could be; `unmeasuredCategories` names the rest |
| `fetchTripReadiness` (client) | one `null` for "flag off" and "the request failed"; the card vanished for both, and `app/trip/[id].tsx` then painted a **0 %** ring from `trips.progress`, a column nothing writes | three states; the ring renders "—" |
| `listMyTrips`, `getInviteLinks`, … | `[]` for a failed request — "you have no trips", "this trip has no live invite links" | throw `TripsReadUnavailableError` |
| `useMapEntities` legacy path | every per-layer failure swallowed into `[]`; a map with no trips looked like a map whose trip layer failed | failures recorded in `unreadLayers`, the signal the gateway path already had |

**Two tests asserted the defect verbatim** and are corrected in place rather
than deleted, with the old text quoted: `tripReadiness.test.ts`'s
"Reservations treated as absent … `categories.reservations === 'ready'`", and
`TripReadinessCard.component.test.tsx`'s "renders nothing when
fetchTripReadiness throws — throw is treated same as null".

The unchecked-read allowlist shrank by four entries, which is the only
direction it may move.

### 29.7 Two static guards were wrong, and that is a census finding

Fixing the above made three guards fail. One was right (`check:async-handlers`
— two new route files had bare handlers). **Two were the guard being wrong**,
and both had the same root cause: a static check that cannot see a construct
reports its absence as a fact.

1. **`splitStatements` understood `$$` but not `$tag$`.** Every
   `DO $mig$ … ; … $mig$` in the corpus was shredded at each `;` INSIDE the
   block and each fragment handed to callers as a top-level statement.
   Postgres accepts any tag; this repo's migrations use named tags throughout.

2. **`checkSecurityDefinerOracles` resolved reference edges only from
   `CREATE FUNCTION` bodies.** The Trips kernel migrations author bodies a
   sixth way — read with `pg_get_functiondef`, splice, install with `EXECUTE` —
   so the check reported `public.trip_proposal_tally`, called **twice** by the
   branches 2775 installs, as referenced by nothing, and demanded it be dropped
   or ledgered. The drop breaks proposal acceptance; the ledger entry would
   have recorded a sentence that is false.

The second is the one worth keeping: **a guard that cannot see a construct will
report its absence with total confidence**, and the remedy it proposes will be
destructive. `lib/transformedFunction.ts` now recognises a transform and
deliberately requires BOTH halves, so a postcondition that merely CALLS a
function — 2774's does — still buys it nothing.

### 29.8 What this section does NOT claim

- **The headline is unchanged.** Fifteen rows move; §26's and this section's
  moves together are not a recount of 451 requirements, and re-deriving a
  percentage from a partial re-read is exactly the error §26 was written to
  correct.
- **Nothing here is a deployment claim.** See 29.5.
- **No production data was fabricated or inferred.** The only production facts
  used are the read-only `md5(prosrc)` measurement recorded in §27.
- **The owner decisions stay open.** `APPEAL_RESTORE_SEMANTICS`,
  `TRUST_OVERRIDE_PIN_OR_CAP`, `EVENT_START_TRANSITION`,
  `MAP_CANCELLED_TRIP_VISIBILITY`, `STORY_HIGHLIGHT_VISIBILITY`,
  `PASSPORT_CREW_PRESENCE_AUDIENCE` and the rest are in
  `docs/architecture/blocker-ledger.md` and were not decided here.
- **`API_TOKEN_SIGNED_OUT_VS_UNREADABLE` is recorded, not fixed.**
  `services/apiToken.ts` returns one `null` for "signed out" and for "the
  refresh failed", and every service module in the app is built on it. Fixing
  it inside Trips would leave two contradictory conventions for one helper
  alive at once. It is in the blocker ledger with what is bounded (nothing is
  granted — a null token sends no Authorization header) and what is not (what
  the user is told).

---

## 30. §7.4 at `head_commit` `c3f76a49` — three quarters of a section, and the check that cannot be built

**This section moves the document's `head_commit` to `c3f76a49`.** §29 measured
`823b6d67`; this section re-reads §7.4 only, at the newer commit. Everything
else §29 says stands as measured at `823b6d67` and is not re-derived here.

The declaration itself lives in §29's field table and is UPDATED there rather
than re-declared here, because `check:census-freshness` reads the first
`head_commit` row it finds: a second row further down looks like a declaration,
ages nothing, and would have left this document reporting itself fresh from a
line no checker reads.

| Field | Value |
| --- | --- |
| Measured at | `c3f76a49` — declared in §29's field table, which is the document's single `head_commit` row |
| Scope re-read | §7.4 (four checks), and TR136 |
| Supersedes | §29's `head_commit` VALUE only. §29's findings are unchanged and were measured at `823b6d67`. |

### 30.1 What §7.4 actually says, against what was built

§7.4 is a four-row table. Every previous reading of it in this document treated
the first row as the section:

| §7.4 check | spec's failure example | before | now |
|---|---|---|---|
| Travel feasibility | "Dinner in Da Nang 19:00; Hoi An event 19:30." | built (§29) | built |
| Stage locality | "Plan belongs to a stage whose location/timezone does not contain it." | **absent** | built |
| Place identity | "External booking and hidden gem share a name but not canonical identity." | **absent** | built |
| Route availability | "Plan is feasible by taxi but transport mode policy says no taxi." | absent | **cannot be built — see 30.2** |

The route was serving one of four checks from a path called `/feasibility`,
with nothing beside it. A client receiving a travel verdict and no consistency
findings has no way to know the other three were never examined — which is the
same shape as §29.3's "built, wired, tested and inert", one level up: not an
inert capability, an inert *fraction of a section* hidden by a plausible name.

### 30.2 Route availability is a FINDING, not a TODO

It requires a transport-mode **policy** — a statement that this trip, or this
traveller, will not use a taxi. Measured across both trees:

```
grep -rn "transport_mode|transportMode|mode_policy|allowed_modes" --include=*.ts --include=*.sql
→ services/memoryProjections/episodeDetection.ts only
```

and there `transport_mode` is an **observed attribute of a past journey**, not
a permission. There is no table, column, preference or flag anywhere in this
system that expresses "no taxi".

So the check has no input, and inventing one means inventing the policy. It
emits a **permanent UNCHECKABLE finding** rather than being omitted, for the
reason this whole pass keeps arriving at: a report covering three of four
checks reads as a clean bill of health on all four.

Two consequences are pinned by tests rather than left implicit:

- the finding is **included** in `checkSpatialConsistency`, so it cannot be
  tidied away by someone cleaning up a noisy list;
- `foldConsistency` therefore **cannot return CONSISTENT for a real trip
  today**, and that is correct rather than a bug. A green §7.4 verdict would be
  claiming three checks are four.

**This is the first row in this census whose blocker is a MISSING PRODUCT
DECISION rather than missing engineering**, and it is deliberately not filed as
an owner decision in the blocker ledger, because nobody has asked for the
feature. It is recorded here as what it is: a spec row with no input in the
system, whose absence is now visible in the response instead of silent.

### 30.3 Row moves

| id | was | now | why |
|---|---|---|---|
| TR136 stage-locality | N (§29) | **W** | `checkStageLocality` in `services/trips/TripSpatialConsistency.ts`, wired into `GET /trips/:tripId/feasibility`, rendered by `TripFeasibilityCard`. W and not C for §29.5's reason: nothing is deployed. |

**TR136's §29 verdict was right and its §27 reasoning was not.** §27 said TR136
stays N because "stage-locality is a §7.4 consistency check with no
implementation", and added that stages existing does not build it. Both true.
What neither section noticed is that §7.4 has three *other* rows, and two of
them were equally unbuilt and were never censused as anything at all — they had
no TR id, because the §5.1-shaped reading of §7.4 never got past its first row.

### 30.4 Two decisions inside the implementation worth recording

**The locality radius is 60 km, and it deliberately does not catch the spec's
own first example.** Da Nang and Hoi An are 30 km apart. §7.4 files that pair
under travel **feasibility**, and flagging it under locality as well would
report one problem as two. The threshold is a named constant with that
reasoning attached, rather than a number inside a condition.

**Time and place are separate findings.** A plan on the wrong day is a
scheduling mistake; a plan in the wrong city is an attachment mistake. They are
fixed in different places, and one merged "locality" verdict would send a user
to the wrong one half the time.

### 30.5 Two fail-closed rules this section adds to the pile

- **An unparseable stage date is UNCHECKABLE, not an open bound.** Treating a
  date that will not parse as "no limit" converts a data defect into
  permission. A genuinely `null` bound *is* open — someone wrote null on
  purpose — and the two are handled separately.
- **A non-finite `lat`/`lng` is not a coordinate.** Coercing it puts a plan at
  0,0, off the coast of Ghana, and then measures its distance from a stage in
  earnest. Declining to measure is better than measuring a value that was never
  a coordinate.

### 30.6 What this section does NOT claim

- **The headline is unchanged**, for §29.8's reason.
- **Nothing here is a deployment claim.** §29.5 stands.
- **§7.4's fourth check is not "coming".** It has no input. If a transport-mode
  policy is ever added, this is the row that turns on; until then the honest
  state is the one now visible in the response.

---

## 31. §9.3 ballots and §14.1's projection, at `head_commit` `6d3e7a56`

**This section moves the document's `head_commit` to `6d3e7a56`.** As in §30,
the declaration itself is updated in §29's field table rather than re-declared
here — the checker reads the first row it finds, and a second one further down
ages nothing while looking like it does. (That behaviour is now itself a
guarded contract; see 31.4.)

| Field | Value |
| --- | --- |
| Measured at | `6d3e7a56` |
| Scope re-read | §9.3's ballot read, §14 (TR254–TR262), and §29.2's two named gaps |

### 31.1 §29.2's first gap is closed

§29.2 named two honest gaps. The first:

> `trip_proposal_votes` has no row-level reader. The tally is served and that is
> the decision-relevant read, but §9.3 gives proposing and deciding different
> verbs and a crew member cannot currently see *who* voted.

The consequence was concrete: a crew member could not tell whether **they
themselves** had voted, and would be sent to vote twice — which the kernel then
refuses, so the missing information surfaced as a confusing error.

`GET /trips/:tripId/decisions` now carries `myVote` per proposal: `yes | no |
abstain`, or `null` for "has not voted". `null` is deliberately not rendered as
`abstain`, because migration 2774's own column comment draws that line — an
abstention is a recorded decision not to decide and counts toward a unanimous
rule being SATISFIED; a silence does not, because nobody knows what it means.
The unanimous rule turns on exactly that difference.

**Nobody else's ballot is served**, and a test asserts it by scanning the whole
serialised response body for another user's id.

### 31.2 The half that is a decision, not a build

Whether a crew member may see **another** member's ballot is product policy.
It is recorded as `VOTE_BALLOT_VISIBILITY` in
`docs/architecture/blocker-ledger.md` with the three defensible answers, and
shipped narrow.

The asymmetry is the whole argument and is worth repeating here because this
census will be read by someone deciding it: widening later is a one-line change
to one route; narrowing after people have seen each other's ballots is not —
the disclosure has already happened and no migration undoes it.

The ledger also records the argument AGAINST the narrow answer, which is real:
on a three-person crew, the tally plus your own ballot already tells you the
other two. That is a reason to think the wide answer is the honest end state.
It is not a reason to ship it unasked.

### 31.3 §14 — the projection, and a section read one row at a time

§14.1 gives a contract:

> `TripMapProjection { stage · hotel/private anchors (access controlled) ·
> active plans · confirmed commitments · saved ideas · crew presence summaries
> · route chains · meetup points · live opportunities · safety/logistics points
> · generatedAt · sourceTripVersion }`

Ten layers and two envelope fields. `GET /trips/:tripId/map-projection` is
that contract.

| id | was | now | why |
|---|---|---|---|
| TR254 `TripMapProjection` | N | **W** | The endpoint and the type exist, with `generatedAt` and `sourceTripVersion` (= `trips.version`, the kernel aggregate version). |
| TR255 Layer: stage | N | **W** | The stage layer resolves each stage's anchor to coordinates. §29's TR78 made stages exist; this makes them projectable. |
| TR256 Private anchors, access controlled | W | **W** (stronger) | Still W, and for a better reason. See 31.3.1. |
| TR257 Layer: active plans | W | **W** | Unchanged in kind: "active" still cannot mean IN_PROGRESS (TR46). What changed is that the projection now SAYS which reading it used, in an `activePlanReading` field, instead of leaving a reader to assume. |
| TR258 Layer: confirmed commitments | N | **W** | Commitments resolve to points through `public.places`, the identity `routes/tripFeasibility.ts` established. |
| TR259 saved ideas | C | **C** | Now also a projection layer. |
| TR260 crew presence summaries | C | **C** | Deliberately `no_source` in the projection: §14.4 makes it a summary layer with no coordinates unless a live-share grant exists, and synthesising coordinates for it would be the §14.4 violation, not the fix. |
| TR261 route chains | W | **W** | Served as `no_source` here on a FALSE premise — **corrected in §32**, where the layer is built for real. The claim that a trip's crew cannot read its own route chain was an inverted reading of one policy out of three. |
| TR262 meetup points | W | **W** | A projection layer now, still built on `category = 'meeting_point'` — a label on an ordinary item, which is what keeps it at W. |

#### 31.3.1 Why TR256 stays W, and what actually improved

TR256's W was justified thus: *"the safety depends on each writer setting a
flag."* That is still true — `location_is_private` is still the input — so the
row does not move.

What the projection adds is that the flag is no longer the LAST line of
defence:

- private lodging goes into its own layer, so a consumer iterating one list
  cannot receive it by accident;
- the privacy check runs **before** the category check, so a private lodging
  labelled `meeting_point` does not land in a shareable layer;
- `assertNoPrivateLeak` re-checks the assembled projection and **throws** — a
  postcondition, because the failure it guards is a coding mistake in the
  assembly and a convention cannot catch one of those. It throws rather than
  filtering: filtering hides the leak and leaves the bug;
- on the client, the convenient accessor `allPoints` EXCLUDES anchors, so the
  easy call is the safe one, and the card does not even show a COUNT of them —
  on a two-stop trip "1 private location" is close to naming it.

TR256 becomes C when a writer cannot fail to set the flag — which means the
concept §14.1 calls an *anchor* existing as a thing, rather than a boolean on a
plan item.

#### 31.3.2 Four of ten layers have no producer, and the projection says so

`crewPresenceSummaries`, `liveOpportunities` and `safetyPoints` return
`{status: "no_source"}` with a reason naming the actual obstacle. This is the
same device §30 used for §7.4's route availability, and the same argument: a
projection carrying seven layers must not be read as ten with three empty.

**`routeChains` was a fourth, and it should not have been.** Its reason cited
TR261's owner-only-RLS claim, which §32 strikes; the layer is real and is now
built. That is the strongest claim this projection makes about a layer —
nothing produces it — made from a citation nobody re-read.

`no_source` is deliberately distinct from `unread`. One means a retry may work;
the other means no retry will.

#### 31.3.3 The one place a partial answer is right

Every other Trips read surface in this pass refuses the WHOLE response when any
input fails, because a partial answer there is a *different* answer. The map
projection does not, and the route says why: a trip whose saved-ideas read
failed still has stages, and refusing everything would hide nine working layers
behind one broken one.

The rule that makes that safe is the per-layer status. A failed read is
`unread`, never an empty layer, and the client card's load-bearing line names
the layers that failed — because a map missing its saved places looks exactly
like a trip with none saved.

### 31.4 A guard defect this document caused, and now pins

Writing §30 required moving the `head_commit`, and it was written as
`` | **`c3f76a49`** — … `` — bold marks between the pipe and the hash.
`check:census-freshness` reported *"no head_commit declared — CANNOT BE
CHECKED"* and then **passed**.

The checker had two branches where it needed three. An absent declaration is
legitimate (census-passport.md declares none, deliberately, and says so in
prose) and does not fail. A MALFORMED one fell into the same branch, so a
document whose author had just written a commit hash into it was silently
reclassified as one that never had — and was then aged by nothing while
appearing to be aged.

`src/scripts/lib/censusHeadCommit.ts` is the three-state reader, and
`censusHeadCommit.test.ts` pins the exact string that passed on 2026-09-09,
plus two contracts this document now depends on: **census-trips must declare
exactly one `head_commit` row** (the parser reads the first), and the error
message must keep describing what the regex accepts, or it sends the next
author to write the same bug.

That is why §30 and §31 update §29's row instead of declaring their own.

### 31.5 What this section does NOT claim

- **The headline is unchanged**, for §29.8's reason.
- **Nothing here is a deployment claim.** §29.5 stands: none of 2750 or
  2760–2777 is on `main`, and both databases still carry 2420. The new routes
  read tables that exist only in this branch, so on any live database today
  every §5-backed layer would answer `unread`. That is the honest state and it
  is what the three-valued layer exists to express.
- **§29.2's SECOND gap is still open.** `trip_snapshots` has a route and no
  screen. It is left as recorded rather than closed, because a snapshot is an
  operator-facing object and building a user-facing snapshot browser would be
  scope this spec does not ask for. Recorded, not rounded.

---

## 32. A correction: TR261 and TR437 cited a policy and stopped one line short

**This is a census defect, found by trying to build against the census's own
claim, and it had already propagated into shipped code before it was caught.**

### 32.1 The claim

TR261 and TR437 both say, in slightly different words:

> `route_plans` … the RLS policy is owner-only (`0058_trip_flow.sql:29`
> `route_plans_owner_select`), so **a trip's crew cannot see the trip's own
> route chain**.

`0058_trip_flow.sql:29` is real and says exactly what is quoted. Three lines
later, at `:32`:

```sql
CREATE POLICY "route_plans_member_select" ON route_plans
  FOR SELECT USING (
    trip_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM trip_members tm
                 WHERE tm.trip_id = route_plans.trip_id
                   AND tm.user_id = auth.uid()
                   AND tm.role IN ('owner', 'member')));
```

and the same pattern again for `route_stops` (`:85`
`route_stops_member_select`) and `route_legs` (`:127`
`route_legs_member_select`). **A trip's crew can read the trip's own route
chain, and has been able to since that file landed.**

RLS policies are a UNION — any permissive policy that passes grants the row —
so citing the first one and stopping is not a partial reading, it is an
inverted one.

### 32.2 How far it travelled before it was caught

Into shipped code. §31's `routeChains` layer was served as
`{status: "no_source", reason: "route_plans/route_stops are owner-only by RLS
(census-trips TR261), so a trip's crew cannot read the trip's own route
chain."}`

`no_source` is the strongest claim that projection makes about a layer — that
**nothing in the system produces it**. It was made from a citation nobody
re-read, and it was doubly wrong, because `GET /trips/:tripId/map-projection`
reads through the service client after `requireTripMember` and **bypasses RLS
entirely**. The policy was irrelevant to that route even if it had said what
the census claimed.

The route chains layer is now built: `route_stops.structured_location` is a
jsonb `{label, lat, lng}`, so a stop is a point when that object holds finite
coordinates. Six tests, including the one that would have caught this — *"route
stops with coordinates ARE points"*.

### 32.3 The method rule this adds

This census already requires a BUILT verdict to cite a `file:line` that was
opened and read (§Method), §28 added that a claim about a deployed object cites
a hash rather than a size, and §29.3 added that a claim a capability WORKS
needs a test that observed its output. This adds the fourth:

> **A claim that something is FORBIDDEN must cite every policy on the object,
> not the first one found.** A permission is a union over policies; a
> prohibition is an intersection over their absence. The two need different
> reading, and a grep that stops at the first match answers the wrong one.

### 32.4 Row corrections

| id | was | now | correction |
|---|---|---|---|
| TR261 Layer: route chains | W ("crew cannot see it") | **W** | The verdict is unchanged and its REASON was wrong. It stays W because `route_plans` remains a parallel itinerary system attached through a nullable `trip_id`, which is TR437's real point — not because the crew cannot read it. It is now a live layer in the §14.1 projection. |
| TR437 no second itinerary system | N | **N** | Unchanged, and its evidence is corrected: `route_plans`/`route_stops`/`route_legs` IS a second itinerary system with its own stop ordering, its own optimizer and its own checkpoint state, attached through a nullable `trip_id`, with no shared context and no events. Every one of those is still true. "A trip's crew cannot read the trip's own route plan" is struck. |

### 32.5 ~~Two things that ARE true about those policies~~ — WITHDRAWN, see §32.6

This subsection originally reported two narrower findings from re-reading
`0058_trip_flow.sql`: that the member policies gate on
`tm.role IN ('owner', 'member')` and so exclude `co_host` and `viewer`, and
that they check `role` without checking `status`, letting an invited-but-not-
accepted member read a route chain.

**Both are false at HEAD, and §32.6 explains how they were produced by the very
error §32.3 had just finished defining.**

### 32.6 The correction to the correction, recorded at full strength

§32.3 states a method rule:

> A claim that something is FORBIDDEN must cite EVERY policy on the object, not
> the first one found.

§32.5 was written in the same sitting, about the same three policies, and broke
a sibling of that rule immediately: **it cited the file that CREATED the
policies and never followed the chain to the one that REPLACED them.**

`2334_route_plan_crew_visibility.sql` — a migration whose filename is the
subject — drops and recreates all three:

```sql
DROP POLICY IF EXISTS "route_plans_member_select" ON public.route_plans;
CREATE POLICY "route_plans_member_select" ON public.route_plans
  FOR SELECT USING (trip_id IS NOT NULL AND authz.is_trip_crew(trip_id));
```

and the same for `route_stops_member_select` (`:196`) and
`route_legs_member_select` (`:208`). `authz.is_trip_crew` is exactly the helper
§32.5 said these policies predate: it checks
`role IN ('owner','co_host','member','viewer')` **and**
`coalesce(status,'accepted') = 'accepted'`, with the owner fallback for a trip
whose owner has no membership row.

So in the repository's migration chain, at HEAD:

- **a co_host CAN read a route plan** — `is_trip_crew` includes the role;
- **an invited-but-not-accepted member CANNOT** — `is_trip_crew` requires
  acceptance;
- both of §32.5's findings are the state of the tree *before* 2334, described
  as if it were the present.

### 32.7 The rule §32.3 was missing, added here

The rule as written says to read every policy ON THE OBJECT. It does not say
where to look for them, and that is the hole §32.5 fell through: all three
policies WERE read, in the file that created them, and the file that replaced
them was never opened.

> **A schema claim is a claim about the END of the chain, not about the file
> that first wrote it.** `CREATE POLICY` in migration N is a fact about
> migration N. The current policy is whatever the LAST `CREATE POLICY` for that
> name established, and finding it means grepping the policy NAME across the
> whole chain, not the table name in the file you already have open.

This is the same failure as §28's — where three `pg_get_functiondef` lengths
were correct and the conclusion drawn from them was wrong — and the same as
§29.1's, where writers were counted and readers were not. Three times in one
document, a measurement was made on the wrong object and reported with full
confidence.

**What did NOT go wrong is worth stating too.** §32.5 explicitly declined to
fix what it found, on the grounds that shipping a policy change alongside a
correction to a claim about the same policy would make the correction harder to
audit. That instinct was right for the wrong reason: had it shipped, the
"fix" would have been a migration rewriting three policies to say what they
already said.

### 32.8 What remains genuinely unverified

Whether any DATABASE has 2334 is the standing question of §29.5 and is not
answered here. Everything above is a claim about the repository's migration
chain, which is what was read. Production carries 2420 and 2334 numerically
precedes it, but §27 established that 2420 reached both databases BY HAND
rather than through the applier — so ordering in the tree is not evidence of
ordering in a database, and this section does not treat it as such.

---

## 33. The databases, measured — and a ledger that had stopped being true

**A database measurement, not a code one.** The tree is unchanged from §32's
`head_commit`; what follows was measured read-only against both Supabase
projects on 2026-09-09, after the branch reached `205fc095`.

Every previous section's deployment claim rests on §27's single measurement of
`trip_kernel_execute`. This re-measures it and asks the questions §27 did not.

### 33.1 Production (`ajrurzioarfkagpuxfnb`) — 43 real trips

| what | measured |
|---|---|
| `trip_kernel_execute` `md5(prosrc)` | `d621c513ef2093054aea014702733649` — **still byte-identical to the repo's 2420** |
| `trip_events` | present |
| `trip_kernel_enabled` | **`false`** |
| Trips v4 tables (the twelve of §5.1) | **0 of 12** |
| `trip_snapshot_fold` / `trip_proposal_tally` / `trip_presence_freshness` | 0 of 3 |
| `trip_presence_current` view | absent |
| `public.schema_migration_ledger` | **does not exist on production at all** |

Production is exactly where §27 left it, and the flag reading matters: the
kernel is **deployed and switched off**. `BUILT ON BRANCH → MERGED → DEPLOYED →
FLAG ENABLED → PRODUCTION REALIZED` — production has reached the third rung for
2420 and no further, and nothing from this branch has touched it.

**Nothing was written to production.** Every statement above came from a
`SELECT`.

### 33.2 portava-ci (`hwokxgbmezheskbzskfr`)

| what | measured |
|---|---|
| `trip_kernel_execute` `md5(prosrc)` | `ed202dc5664f7f46e3b27c7810fb1a2e` — 2420 with its nine whole-line comments stripped, as §27 established |
| `SET_TRIP_COVER` in the kernel body | **absent** → 2590 is not applied, so 2450/2500/2590 are not either |
| `ADD_STAGE` in the kernel body | **absent** → none of 2764–2777 is applied |
| Trips v4 tables | **10 of 12** — everything from 2760–2763; `trip_plan_participants` (2771) and `trip_proposal_votes` (2774) absent |
| 2770's plan columns / 2774's proposal columns | 0 and 0 |
| `trip_presence` `source` column + the eight §10.1 states | **present** → 2767 is applied |
| 2773 / 2774 / 2776 functions and the presence view | 0 |

So portava-ci carries **2750, 2760, 2761, 2762, 2763, 2767** and nothing else
from this branch — each verified by its own schema effect (a constraint, a
table, a column), not by trusting a history table.

### 33.3 The finding: the repo's own ledger had stopped being true

`public.schema_migration_ledger` is the repo's ledger — the one whose row
`check:migration-ledger` reads to answer "what has this database seen", and
whose row is meant to be written **in the same transaction as the DDL**. On
portava-ci it holds 427 rows and its highest Trips-band entry was:

```
2420_trip_kernel_foundation.sql   2026-09-07   "Applied to portava-ci only."
```

**Six migrations were applied and none of them was recorded.** Supabase's own
`supabase_migrations.schema_migrations` had them — 2750 at `20260908224327`,
2760–2763 across `20260909045549`–`20260909050113`, 2767 at `20260909055621` —
so the two histories disagreed, and the one the repo's tooling reads was the
wrong one.

This is the predicted consequence of the mechanism §29.5 names. Applying by
hand routes around the dry run, `certify:migrations`, the sanctioned-project
assertion **and the ledger-row-in-the-same-transaction guarantee**. The first
three were discussed; the fourth is the one that actually bit, and it bit
silently, because `check:migration-ledger` exits 2 without credentials and had
never run here.

**Repaired.** Six rows written, each with `applied_by = 'manual'` and
`checksum = 'backfill'`:

- `'manual'` because that is what happened, and the column's CHECK constraint
  admits exactly `ci | manual | backfill`;
- **`'backfill'` rather than a sha256 on purpose.** A sha256 would assert that
  the database ran the exact bytes now on disk, and that was NOT verified —
  what was verified is the schema EFFECT. `isComparableChecksum` treats a
  non-sha256 as NOT COMPARED, which is precisely the claim available. Writing
  today's file hash would have made the gate green by asserting something
  nobody measured, which is the failure this whole pass is about.

Each row's note says it was back-filled, that it was not written in the
transaction, which history table corroborates it, what the schema evidence was,
and that it is **not applied to production**.

`check:migration-ledger` will now report 2764, 2765, 2766 and 2768–2777 as
unapplied, and that is true.

### 33.4 Why the rest was NOT applied to portava-ci

The obvious next move is to apply the ancestry and the chain to ci so it matches
the branch. `.github/workflows/live-db.yml` says not to, in its own words:

> the real apply and the certification are restricted to the default branch,
> **because applying an unmerged branch's migrations to the shared CI database**
> …

The applier runs `--dry-run` off the default branch by design. portava-ci is
shared: other lanes' `CI (live DB)` runs read it, and a table only this branch
declares is a fact those lanes did not ask for. The six migrations already there
are that violation, sitting in the shared database — which is how 33.3 happened.

Doing it again by hand would repeat the exact mechanism that produced the drift
this section repairs. **The gate is a merge, not a command**, and it stays shut.

### 33.5 One piece of history left in place

`supabase_migrations.schema_migrations` on portava-ci carries a row named
`tmp_comment_fidelity_probe` (`20260909061433`) — §28's experiment, which
created a throwaway function to establish how Postgres treats comments in
`prosrc`. **The function is already gone**; only the history row remains, and it
is left alone. It records something that genuinely happened, no repo tooling
reads that table, and deleting audit history to tidy an unfamiliar name is the
wrong instinct. Named here so the next reader does not have to wonder.

### 33.6 The standing answer, now measured rather than cited

Both databases are **correct for their stage and neither is current with this
branch**, and those are different sentences:

- production: 2420 deployed, flag off, no v4 tables — correct, and untouched;
- portava-ci: six migrations ahead of main and fourteen behind this branch —
  now accurately *recorded*, still not something to "fix" by applying more.

Nothing here changes §29.5. It replaces its citation with a measurement.

## 34. The three §5 read routes, re-read at `6c6995e1`

**This section moves the document's `head_commit` to `6c6995e1`.** §33 measured at
`1ec4d903`. Nothing in §29–§33's verdicts changes; three of the files those
sections certified were edited, and this says what changed and what it does not
disturb.

| Field | Value |
| --- | --- |
| Measured at | `6c6995e1` — declared in §29's field table, the document's single `head_commit` row |
| Supersedes | §29's `head_commit` VALUE only |
| Scope re-read | `routes/tripStructure.ts`, `routes/tripDecisions.ts`, `routes/tripMapProjection.ts` — their read construction, not their verdicts |
| Trigger | `check:write-path-columns` on portava-ci, first run of this branch's code against a live schema |

### 34.1 What the check found

Each of the three routes read its tables through a shared helper that took the
table NAME:

```ts
async function readTrip(table: string, cols: string, order?: string) {
  let q = sc!.from(table).select(cols).eq("trip_id", tripId);
```

`check:write-path-columns` resolves `.from()` and `.select()` **statically**. A
variable table name resolves to nothing, so the guard recorded
`src/routes/tripStructure.ts|select|dynamic table name` — a blind spot — and
with it every column those routes select.

That is ten §5 tables' worth of columns, on the three routes that read them,
invisible to the check whose entire job is to catch a select list naming a
column the live schema does not have. PostgREST fails the WHOLE read with
PGRST100 in that case; it does not return the other columns. §29.1's finding was
that nine of ten §5 tables had a writer and no reader. This is its sibling: the
readers exist and were **unverifiable**.

The helpers now take a built query and use the table name only for the log line,
so each call site carries its own literal `.from("trip_stages").select("…")`.
supabase-js builders are lazy, so a query the short-circuit never awaits costs
nothing.

### 34.2 What it did NOT find, and what it did find instead

No phantom column on any of the three routes. Once they resolved, the check
reported what it could finally see, and it is a database fact rather than a code
one — the columns are declared by migrations portava-ci does not have:

| Missing on portava-ci | Declared in | How verified |
|---|---|---|
| `trip_plan_items.stage_id`, `.place_id`, `.privacy_scope`, `.plan_scope`, `.version` | 2770 | direct query, `information_schema.columns` |
| `trip_proposals.decision_rule`, `.proposed_by` | 2774 | same |
| `trip_events.actor_role`, `trip_command_receipts.actor_role` | **2450** | same |
| tables `trip_plan_participants`, `trip_proposal_votes`; view `trip_presence_current` | 2771, 2774, 2776 | `to_regclass` |

The **2450** row corrects §29's field table, which said portava-ci "carries 2420
and nothing after it" and treated the kernel ancestry as settled there. 2450's
two `actor_role` columns are absent, so 2450 is not applied to portava-ci — the
harness rehearsal proved the chain, it did not deploy it. §33's ledger repair
covered 2750 and 2760–2763 and 2767; it did not cover 2450, and nothing claimed
it did.

None of this is fixed by this document or by any command. §33.4's gate stands:
the apply is restricted to the default branch, and the way to close it is the
merge followed by the sanctioned applier.

### 34.3 A contract that approved a grant nobody had opened

Same run, `check:authorization-contract`, four layover tables. The entries added
on 2026-09-07 are headed **PINNED AS MEASURED** and listed anon/authenticated
grants of `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE`.

`information_schema.role_table_grants` on portava-ci returns
`DELETE, INSERT, SELECT, UPDATE`. **REFERENCES and TRIGGER were never granted.**
They were inferred from the phrase "the default ALL grant" and written into a
document whose heading says they were measured.

The direction matters. The contract was WIDER than the database, so it did not
hide an open hole — it pre-approved one. The day a migration or a Supabase
default handed `REFERENCES` to `anon`, the check would have stayed green and the
contract would have read as a considered approval of it.

This is the §32 mistake in a different file: a claim sourced from a plausible
sentence rather than from a query. §32.7's rule — *read the object, not the
sentence about the object* — is not specific to policies, and this is the second
instance in three days.

### 34.4 One more scope hole, closed

`routes/tripMapProjection.ts` was not in `CENSUS_SCOPE["census-trips.md"]`, so a
change to §14.1's route could not age this census. It is in the list now. §31
certified that route; until this commit, nothing would have told anyone when its
certification went out of date.

---

## 35. The kernel, executed — a live vertical slice against portava-ci

**Measured 2026-09-09** against project `hwokxgbmezheskbzskfr` (portava-ci), the
sanctioned rehearsal database, at repository head `2c9ca4a5` with §29's
migration chain fully applied. Every statement below ran inside
`BEGIN … ROLLBACK`, so the database is unchanged by this measurement; the
fixture rows (two `auth.users`, two `profiles`, one trip) exist only for the
duration of the transaction.

### Why this section exists

§29 through §34 grade the kernel from its SOURCE and from tests that run against
doubles. Both are worth having and neither executes the function. `tripKernel.ts`
and the 49 `trip*.test.ts` suites (993 tests, 0 skipped, all passing at this
head) prove the TypeScript around the RPC and the SHAPE of the contract; ask
what would turn them red and the answer is "editing the TypeScript or the fake",
which is not a property of `public.trip_kernel_execute`. The kernel is 103,400
characters of PL/pgSQL — the largest single object in this architecture — and
until now nothing in this repository had run it end to end. Memory has such a
proof (`test/memoryKernelTransactionLive.test.ts`, script
`test:memory-kernel-transaction`); **Trips did not**, and that absence is the
subject of the finding at the end of this section.

### The object, measured

| Fact | Measured |
| --- | --- |
| `trip_kernel_execute(p_command jsonb) → jsonb` | present; `pg_get_functiondef` **103,400** chars; `md5(prosrc)` **`5fd683a457c26a4d084887e365a1fb73`** |
| §5 tables | **12 / 12** present (`trip_stages`, `trip_legs`, `trip_commitments`, `trip_goals`, `trip_decision_tasks`, `trip_risks`, `trip_presence`, `trip_proposals`, `trip_proposal_votes`, `trip_snapshots`, `trip_outcomes`, `trip_plan_participants`) |
| RLS | **12 / 12** `relrowsecurity`, 1 policy each |
| `trip_*` functions in `public` | **15** |
| `trip_presence_current` view | present |
| Ledger | **500** rows, last applied `2026-09-09 18:17:43Z` |

The table list is measured, not recited: an earlier version of this check asked
for `trip_decisions` and got 11/12. There is no such table — 2762 creates
`trip_decision_tasks`. The gap was in the question, and it is recorded here
because a certification that invents a name proves nothing when it passes and
raises a false alarm when it fails.

### The eighteen migration files, against the ledger

All **18 / 18** are present in `public.schema_migration_ledger`. Comparing each
row's `checksum` to `sha256` of the file on disk:

| | count | files |
| --- | --- | --- |
| `applied_by='ci'`, checksum **matches the repo file exactly** | **13** | 2764–2766, 2768–2777 |
| `applied_by='manual'`, `checksum='backfill'` — **NOT COMPARED** | **5** | 2760, 2761, 2762, 2763, 2767 |

The five are the ones hand-applied from an unmerged branch before the applier
was sanctioned (`CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES`). `backfill` is the
ledger's own sentinel for "this row records that something was applied and
cannot say what", so for those five the ledger proves nothing about file
identity. What stands in for it is object-level: `audit:schema` compares the
objects every migration CLAIMS against the objects that are live, and the tables,
columns, RLS flags and policies those five create are all present and are all in
the counts above. **That is parity of OBJECTS, not proof that the applied TEXT
was this text**, and the difference is why this row is written out rather than
folded into "18/18 applied".

### The slice

Thirteen commands, one trip, one actor, in order. Every one returned
`ok: true` with a monotonic version and an `event_id`:

| # | command | version | result |
| --- | --- | --- | --- |
| 1 | `CREATE_TRIP` | 1 | trip row, `trip.created` |
| 2 | `ADD_STAGE` seq 1 | 2 | `trip.stage_added` |
| 3 | `ADD_STAGE` seq 2 | 3 | `trip.stage_added` |
| 4 | `ADD_LEG` s1→s2 | 4 | leg id |
| 5 | `ADD_COMMITMENT` on s2 | 5 | starts 19:00, required arrival 18:45, prep 20 min, tolerance 5 min |
| 6 | `ADD_PLAN` | 6 | plan id, `status: tentative` |
| 7 | `JOIN_PLAN` | 7 | `attendance_state: going` |
| 8 | `SET_PRESENCE` | 8 | `applied: true`, `expires_at` = now + TTL |
| 9 | `CREATE_PROPOSAL` | 9 | `status: pending`, `decision_rule: host` |
| 10 | `VOTE_ON_PROPOSAL` | 10 | tally inline: `electorate 1, yes 1, majority_met, unanimous_met` |
| 11 | `ACCEPT_PROPOSAL` | 11 | `status: accepted` |
| 12 | `RECORD_OUTCOME` | 12 | outcome id |

Three properties were then asserted against the same live aggregate:

- **§22.4 idempotency.** Replaying command 7 with the SAME `idempotency_key`
  returned `ok: true, duplicate: true, version: 6` — the version it originally
  produced, not a new one. No second transition.
- **§22 optimistic concurrency.** A command carrying
  `expected_trip_version: 2` against an aggregate at 12 was refused with
  `TRIP_VERSION_CONFLICT`.
- **§10 presence freshness.** `trip_presence_freshness(observed, expires, at)`
  returned `"live"` for an unexpired row and `"offline"` for one whose
  `expires_at` is fifty minutes in the past.

### Replay determinism, at a cut point

The claim is that a snapshot plus the events after it reconstructs the same state
as folding the whole log from the seed. Both sides were computed live:

    trip_snapshot_replay(T, trip_snapshot_seed(T), 0, head)
      =  trip_snapshot_replay(T, <snapshot written at version 1>, 1, head)
    -> true

**`true`, as jsonb equality on the whole state**, not on a digest of it. The
state on both sides is populated — plans, stages, `lifecycle_state: planning`,
`aggregate_version` — so this is a comparison of two real projections and not
two empty objects; that was checked, because `equal: true` over `{}` = `{}`
would have been a green light meaning nothing.

`trip_snapshot_verify_replay(T, 11)` returned
`{ok: true, equal: true, differing_keys: [], snapshot_version: 11, head_version: 12}`.
Asked for a version with NO snapshot it returned
`{ok: false, reason: "TRIP_SNAPSHOT_NOT_FOUND"}` — it refuses rather than
seeding one and reporting agreement with itself.

Two honest absences survive into the snapshot rather than being filled in:
`free_window_summary: {available: false, reason: "SECTION_7_ENGINE_ABSENT"}` and
`source_refs: {available: false, reason: "NOT_CARRIED_BY_EVENTS"}`.

### What the kernel refused, and why that is the good news

Four commands in the first pass were rejected because MY payloads were wrong, and
each refusal names the reason:

| payload error | kernel answer |
| --- | --- |
| stage with neither `place_id` nor `city_id` | `TRIP_COMMAND_MALFORMED` · `trip_stages_one_anchor` |
| `confidence: "high"` on a numeric column | `TRIP_COMMAND_MALFORMED` · invalid input syntax for numeric |
| `proposal_type: "change_stage"` (the real value is `stage_change`) | `TRIP_COMMAND_MALFORMED` · `trip_proposals_type_known` |
| `type: "show"` on a commitment | `TRIP_COMMAND_MALFORMED` · `trip_commitments_type_known` |

Each is a CHECK constraint caught by the family's own `BEGIN … EXCEPTION` and
returned as a structured, permanent rejection. That is the behaviour §22 asks
for, measured rather than asserted.

### FINDING — `TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT`

**`CREATE_TRIP` has no such exception handler, and one legitimate payload proves
it.** `POST /trips` supports drafts — its own comment says *"Trips without
title/city are saved as drafts"* and `computeTripStatus` takes
`destinationCity ?? null`. It then passes `destination_city: destinationCity`
straight into the command. With no city, the kernel's
`INSERT INTO public.trips` hits `destination_city`'s NOT NULL and the
exception **escapes the function entirely**:

    ERROR: 23502 null value in column "destination_city" of relation "trips"
    CONTEXT: PL/pgSQL function trip_kernel_execute(jsonb) line 165

Measured, not inferred: that is the verbatim error from this rehearsal. Every
other family wraps its INSERT (2764's `ADD_STAGE` catches `check_violation` and
`unique_violation` and returns `TRIP_COMMAND_MALFORMED`); the trip family, which
is older (2450), does not.

**What it costs.** `executeTripCommand` sees a thrown RPC and returns
`TRIP_KERNEL_UNAVAILABLE` — a reason whose whole meaning is *"the kernel could
not be reached, try again"*. A malformed command is reported as a transient
outage, so a client with retry-on-unavailable retries a command that can never
succeed. The row is never written either way, so nothing is corrupted; what is
wrong is the ANSWER.

**Not fixed here, deliberately.** The fix is a new verified-transform migration
against `trip_kernel_execute`, which widens the migration scope this
certification is measuring. It does not invalidate anything above — the twelve
commands, the idempotency receipt, the version conflict and the replay equality
are all unaffected — so it is recorded as a finding and left for its own change.
It is also NOT a regression the kernel introduced: the flag-off legacy path
inserts the same NULL and fails the same constraint, returning `db_error`. The
kernel path is not worse at writing; it is worse at explaining.

### FINDING — `TRIPS_HAS_NO_LIVE_KERNEL_SUITE`

Everything in this section was executed by hand through the Supabase management
API and is reproducible only by re-reading this document. Memory has the equivalent FILE
(`memoryKernelTransactionLive.test.ts`, script `test:memory-kernel-transaction`)
and — measured, after the first draft of this section claimed otherwise — **CI
invokes it nowhere**: `run-live-suite.sh` is called for 26 suites in
`live-db.yml` and that is not one of them, and the file is on
`UNREGISTERED_TESTS_ALLOWLIST.json` so the curated `npm test` skips it too. So
the precedent is weaker than stated: Trips has neither the file nor the script,
and the one existing example is itself inert
(`MEMORY_LIVE_KERNEL_SUITE_NEVER_RUNS`). Nothing here turns red on its own if
the kernel changes. **The measurements above
are a snapshot; they are not a guard**, and the distinction is the same one this
census draws between BUILT and CERTIFIED everywhere else.

### §35.1 — the snapshot, made executable (same day)

`src/test/tripKernelLive.test.ts` now encodes everything above that a test can
reach: the twelve-command slice with its monotonic versions, the rows the §5.1
read routes serve, §22.4 idempotency (a replayed key returns `duplicate: true`
**at the original version** — the load-bearing half, since `duplicate: true` with
a NEW version would mean the command ran twice and the receipt followed), the
stale-version refusal, the four malformed-payload refusals, and
`TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT` pinned as CURRENT behaviour so that
closing the blocker turns this file red on purpose. It is registered as
`test:trip-kernel-live` and invoked from `live-db.yml` through
`run-live-suite.sh`, which scores it on pass > 0 AND skipped == 0.

`test:memory-kernel-transaction` is wired in the same change. It had a package
script and no caller anywhere under `.github/` — found while looking for the
precedent to copy, and recorded as `MEMORY_LIVE_KERNEL_SUITE_NEVER_RUNS`. **The
first draft of this section asserted the opposite** ("Memory's equivalent proof
is a registered test, scored by `run-live-suite.sh`"); it was registered as a
package script and scored by nobody, and the correction stands above.

**What is NOT yet true, stated rather than implied.** This suite has never
executed. This container holds no service-role credential, so everything above
was proven through the management API as raw SQL and the TypeScript path —
`executeTripCommand` → `sc.rpc("trip_kernel_execute", { p_command })` over
PostgREST as `service_role` — is asserted, not measured. What IS measured is
that `service_role` holds EXECUTE on the function, and that each assertion
matches a value this database actually returned. The first live-DB job to run it
is the first evidence that the suite itself is right, and if it is wrong there,
the fix belongs in the suite, not in the reading above.

Snapshot/replay determinism stays outside it, deliberately: `trip_snapshot_write`
and `trip_snapshot_verify_replay` are granted to `service_role` and reachable,
but no module in this repository owns those RPC names, and a test that is the
only place a function name appears is a second source of truth for it. The
measurement stands in §35; the guard waits for an owner.
