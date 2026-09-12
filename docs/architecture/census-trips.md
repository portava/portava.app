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

**RECOUNTED FROM ZERO 2026-09-11 against merged `main` `014a25d5` — see §36.** Every
figure below is now the document's own 451 rows, counted mechanically by
`check:census-integrity`, which reads all 451 of them for the first time. The
`68ed59d9` figures this table used to carry (78 / 110 / 262 / 1 — 41.7 % / 17.3 %) are
preserved in §36.1 as the record of that measurement.

| Measure | Value |
| --- | --- |
| **Denominator (testable requirements)** | **451** |
| BUILT-AND-CORRECT | **286** |
| BUILT-BUT-WRONG | **140** |
| NOT-BUILT | **24** |
| CANNOT-VERIFY | **1** |
| **CONSTRUCTED%** = (C+W)/451 | **426 / 451 = 94.5 %** |
| **CORRECT%** (raw) = C/451 | **286 / 451 = 63.4 %** |

> **RESTATED 2026-09-11 (§38): 89 → 87 CORRECT, 127 → 129 WRONG.** §38 re-derived
> 39 of the C rows against the code and **two did not hold**, both for the same
> reason — a universal claim nobody had counted:
>
> - **TR51** said *every* trip write parses a zod schema first. 8 of 53 do not.
> - **TR200** said trip events pass an attention policy. 10 trip push sites never
>   reach the router that applies it.
>
> CONSTRUCTED is unchanged at 47.9 %: both requirements are still BUILT, and are
> now graded WRONG rather than CORRECT. These are the first verdicts either §37
> or §38 has moved, and both moved DOWN — the direction a re-derivation has to be
> able to go if it means anything.

> **RESTATED AGAIN 2026-09-11 (§39): 234 → 200 NOT-BUILT, 129 → 162 WRONG,
> 87 → 88 CORRECT. CONSTRUCTED 47.9 % → 55.4 %, CORRECT 19.3 % → 19.5 %.** §39
> re-derived N rows for the first time and **thirty-four are falsified by code on
> merged `main`** — all thirty-four by the same squash merge (`42aeac38e`, #476)
> whose commit this document declares as its `head_commit`. §29.4 re-graded
> fifteen rows at that commit and stopped; the rest were never revisited.
>
> Thirty-three of the thirty-four are built and **not shown to work**, so they
> land in WRONG. **One, TR417, is proven live and moves into CORRECT** — the
> first row any pass has moved into that bucket, on this document's own TR49/TR57
> precedent and with the same caveat: `trip_kernel_enabled` is seeded FALSE, so
> the guarantee is proven in portava-ci and protects nothing in production. §39.7.
>
> §38's two verdicts moved DOWN and these thirty-four move UP. Until §39, every
> pass this document had run could only travel downward, because only C rows had
> ever been re-read.

> **RESTATED 2026-09-12 (§40.1): 88 → 100 CORRECT, 162 → 157 WRONG, 200 → 193
> NOT-BUILT. CONSTRUCTED 55.4 % → 57.0 %, CORRECT 19.5 % → 22.2 %.** §40 is the
> first section that BUILDS rather than re-reads: §40.1 named the nine §6.1
> policy functions, put Appendix B reason codes on the wire, and ratcheted the
> inline copies. Twelve rows into C, four N→W, four held — each with the file
> and line. §40 opens by stating the ceiling: "100 %" as a system claim needs
> owner actions (production migration, certification, the flag) that no pass
> here can take, and every percentage below carries that caveat.

> **RESTATED 2026-09-12 (§40.2): 100 → 117 CORRECT, 157 → 145 WRONG, 193 → 188
> NOT-BUILT. CONSTRUCTED 57.0 % → 58.1 %, CORRECT 22.2 % → 25.9 %.** §40.2 put
> the §19.1 envelope on every projection that exists, opened §19.2's
> `/timeline`, `/map`, `/crew`, `/context` and a `/safety` projection, and made
> Compass, the discovery consumer and the client decide through one consumer
> rule. Seventeen rows into C, one N→W (TR416: the §22.4 check exists and no
> live consumer yet hands it a canonical version), `/today` held N because its
> engine does not exist. Same caveat: built on a branch, not merged, not
> deployed.

> **RESTATED 2026-09-12 (§40.3): 117 → 121 CORRECT, 145 → 150 WRONG, 188 → 179
> NOT-BUILT. CONSTRUCTED 58.1 % → 60.1 %, CORRECT 25.9 % → 26.8 %.** §40.3 built
> the §7.3 Temporal Freedom Engine (windows as lower bounds on free time,
> conflicts returned beside them, Compass consuming them) and, in writing
> §22.4's property test, found that the straight-line travel adapter was not a
> lower bound under two kilometres — fixed, with the feasibility engine's one
> claim now true at every distance. Same caveat.

> **RESTATED 2026-09-12 (§40.4–§40.5): 121 → 138 CORRECT, 150 → 152 WRONG,
> 179 → 160 NOT-BUILT. CONSTRUCTED 60.1 % → 64.3 %, CORRECT 26.8 % → 30.6 %.**
> §40.4 derived the §3.2 phase and §17.1 health (never stored) and the §3.3
> AT_RISK state; §40.5 composed the §11.1 Today projection from them, opened
> `/today` and `/health`, gave Compass `get_today_state`, and checked §22.4
> live. All three sit behind `trip_operational_projections_enabled`, seeded
> FALSE, because `check:flag-schema-prerequisites` caught Compass reaching a
> table production lacks — the class that guard exists for. Same caveat, and
> a new one: that flag stays FALSE on production until 2420/2760–2762 land.

> **RESTATED 2026-09-12 (§40.6–§40.7): 138 → 145 CORRECT, 152 → 156 WRONG,
> 160 → 149 NOT-BUILT. CONSTRUCTED 64.3 % → 66.7 %, CORRECT 30.6 % → 32.2 %.**
> §40.6 put §10.1's `source`, `confidence`, `observed_at` and §10.2's four
> freshness classes on the crew card, judged on the position's own clock, and
> made the stale-render refusal countable; §40.7 made `POST /complete` perform
> §20.2's presence stop and report the other six steps, ask §20.3's questions,
> and gave every projection a §21.2 decision record — in a per-process ring,
> not a table, which is why the ledger rows are W. Same caveat.

> **RESTATED 2026-09-12 (§41): 145 → 148 CORRECT, 156 → 180 WRONG,
> 149 → 122 NOT-BUILT. CONSTRUCTED 66.7 % → 72.7 %, CORRECT 32.2 % → 32.8 %.**
> §41.1 built a throwaway database from production's structure dump plus the
> canonical chain and executed the kernel on it — command → event → outbox →
> projection → snapshot → replay, with a tampered snapshot failing to verify —
> which is what moved three §23.1/§22.2 rows to C. §41.2 then executed seven
> new kernel families on it (2779–2785): §3.3's nine states with §7.2 refused
> at the write and the override recorded, subgroups, a persisted decision
> ledger, transport segments, goal scope, append-only reservation history,
> disruptions and the four §4.2 events that had "zero occurrences". Twenty-four
> N → W and none to C, for one reason stated thirty-one times in §41.3: no
> database has these migrations. Same caveat; the two flags stay FALSE.

> **RESTATED 2026-09-12 (§42): 148 → 170 CORRECT, 180 → 176 WRONG,
> 122 → 104 NOT-BUILT. CONSTRUCTED 72.7 % → 76.7 %, CORRECT 32.8 % → 37.7 %.**
> §42 built §16.2's `SignalEstimate` with its contradiction rule enforced by
> construction, §16.1's Trip Pulse as a projection over the trip's own places
> with three named sources, §11.4's five-level attention model with every
> trip push routed through it, §17.2's priority switch fed by 2785's
> disruption register, two more §21.1 metrics and three §12.1 tools. Twenty-two
> rows to C, one N → W (TR319: the suppression is derived and applied to
> signals and pushes, not yet to the Compass brief). No migration; the
> ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§43): 170 → 201 CORRECT, 176 → 174 WRONG,
> 104 → 75 NOT-BUILT. CONSTRUCTED 76.7 % → 83.1 %, CORRECT 37.7 % → 44.6 %.**
> §43 built §13: the thirteen primitives with their ten properties, the
> compiler over the eight inputs with EXECUTABLE / NOT_EXECUTABLE /
> UNCERTAIN and §22.4 as a generated property, the opportunity event as a
> diff whose significance is a function of the diff alone, the projection
> that feeds them from the trip and records a significant change through
> the kernel (2786, applied and rolled back on a fresh replica), and the
> three §21.1 conversion counters. Thirty-one rows to C; TR229 holds at W
> (travel by estimator, 2782's segments not yet consulted). Same ceiling.

> **RESTATED 2026-09-12 (§44): 201 → 237 CORRECT, 174 → 170 WRONG,
> 75 → 43 NOT-BUILT. CONSTRUCTED 83.1 % → 90.2 %, CORRECT 44.6 % → 52.5 %.**
> §44 built the operational judgement: §8.2's urgency on every decision
> task, §8.3's readiness by day and stage, §8.4's four register triggers on
> Today, §9.4's impact preview with §15.3's five booking side effects,
> §11.3's replan diff whose shared mutations become `CREATE_PROPOSAL`,
> §12.1's simulate and create-proposal tools, §12.3's value of information,
> §14.3's meeting point with its six constraints by name, §17.3's rescue over
> the seven typed problems, and §23's flight-delay and rain scenarios as
> tests. Thirty-six rows to C, one N → W (TR146: the late check-in trigger
> is built, nothing produces its inputs); TR144 holds at W for the same
> reason. No migration; the ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§45): 237 → 251 CORRECT, 170 → 168 WRONG,
> 43 → 31 NOT-BUILT. CONSTRUCTED 90.2 % → 92.9 %, CORRECT 52.5 % → 55.7 %.**
> §45 built §24's decision-diff CI (eight synthetic scenarios, a canonical
> record, a golden with a note, the four report classes) and the Phase 0
> write-path inventory that CI holds to the tree; closed TR51's last seven
> writes; gave the map its tenth layer; made the closeout's two deferred
> steps act; ran §23's concurrent-edit scenario on the real kernel; and
> re-derived five rows the tree had already earned. Fourteen rows to C
> (three of them from W), one N → W (TR150). No migration; the ceiling is
> §41.3's, unchanged.

> **RESTATED 2026-09-12 (§46): 251 → 264 CORRECT, 168 → 155 WRONG,
> 31 NOT-BUILT unchanged. CONSTRUCTED 92.9 % unchanged, CORRECT 55.7 % → 58.5 %.**
> §46 gave the activity log §5.3's policy (2789: retention, a prune, a
> minimised-payload CHECK), closed open risks at closeout, proved the
> kernel's participant_joined / trip_completed and the map rebuild on a real
> database, carried three Appendix B families to the wire
> (TRIP_TEMPORAL_INFEASIBLE / _UNKNOWN, TRIP_PRESENCE_GHOST / _HIDDEN, the
> new TRIP_COMMAND_SENSITIVE_DOMAIN), let "active" mean in_progress on the
> map, and re-derived TR186 and TR221. Thirteen rows W → C. One migration
> on a production table; the ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§47): 264 → 268 CORRECT, 155 → 153 WRONG,
> 31 → 29 NOT-BUILT. CONSTRUCTED 92.9 % → 93.3 %, CORRECT 58.5 % → 59.4 %.**
> §47 built four rows end to end: the §6.3 absence guard behind 2790's
> flag (TR119), the §7.4 transport-mode policy and route-availability
> check on 2793's table (TR137), a thirty-day bound on the pasted booking
> text and the retention sweep that enforces it and 2789's prune behind
> 2792's flag (TR403), and stage local time with instant order on the
> timeline from 2760's zones (TR424). Two N → C, two W → C. Four
> migrations, two flags seeded FALSE; the ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§48): 268 → 271 CORRECT, 153 → 155 WRONG,
> 29 → 24 NOT-BUILT. CONSTRUCTED 93.3 % → 94.5 %, CORRECT 59.4 % → 60.1 %.**
> §48 built the server's half of §18: the signed, versioned offline bundle
> and its staleness rule (TR334 W — no client stores it), the
> QueuedTripOperation contract and the replay / revalidate / reject rule
> behind `POST /trips/:tripId/operations` (TR343, TR349, TR451), and the
> §22.4 duplicate and the §23 offline member executed on the real kernel
> (TR417 holds C on a second proof, TR421 W). Three N → C, two N → W. No
> migration; the ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§49): 271 → 275 CORRECT, 155 → 151 WRONG,
> 24 NOT-BUILT unchanged. CONSTRUCTED 94.5 % unchanged, CORRECT 60.1 % → 61.0 %.**
> §49 made presence the newest valid observation (a stale device's fix is
> not written over a fresher one, `TRIP_PRESENCE_STALE`; TR351), replayed
> saved ideas from the reconnect queue as idempotent set operations
> (TR350), gave the late-check-in trigger its two inputs from the freedom
> projection's arrival estimates and a lodging's required arrival (TR146),
> and re-derived the §7.4 place-identity check that §40.3 had built
> (TR135). Four W → C. No migration; the ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§50): 275 → 276 CORRECT, 151 → 150 WRONG,
> 24 NOT-BUILT unchanged. CONSTRUCTED 94.5 % unchanged, CORRECT 61.0 % → 61.2 %.**
> §50 converted the thirty-eight inline owner / host / member / creator
> checks in the trip routes into five policy decisions in lib/tripPolicy.ts
> (with the role reader and two pure helpers), kept every message and
> status, added the Appendix B reason to each refusal, and lowered
> `check:trip-policy-callsites` to a floor of zero (TR102). One W → C. No
> migration, no flag; the ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§51): 276 → 282 CORRECT, 150 → 144 WRONG,
> 24 NOT-BUILT unchanged. CONSTRUCTED 94.5 % unchanged, CORRECT 61.2 % → 62.5 %.**
> §51 built §10.3's sensing policy — idle, execution, safety, with the
> reasons that raise it — and published it on Today (TR172); gave Compass a
> trip-scoped `get_crew_state` over the crew map, coordinate-free and
> flag-gated (TR204); and re-derived four rows graded before §40.3, §43 and
> §44 built what they name — "Where next?" (TR195), §12.4's determinism
> (TR223) and the two §23 scenarios (TR418, TR419). Six W → C. No
> migration, no flag; the ceiling is §41.3's, unchanged.

> **RESTATED 2026-09-12 (§52): 282 → 286 CORRECT, 144 → 140 WRONG,
> 24 NOT-BUILT unchanged. CONSTRUCTED 94.5 % unchanged, CORRECT 62.5 % → 63.4 %.**
> §52 built 2794 — §10.4 meeting checkpoints with participants and arrival
> state, the kernel's meeting family, `safe_return_sessions.subgroup_id` —
> and on it §11.3's regroup (`POST /trips/:tripId/regroup`, §14.3's
> computation attached, `REGROUP_OPEN` → `SAFETY_EVENT` until met or closed;
> TR198), the map's checkpoint points and the bundle's meeting points
> (TR262), and §17.4's subgroup context for Safe Return (TR329, TR177).
> Four W → C. One migration, applied / rolled back / re-applied on the
> replica; the ceiling is §41.3's, now 2779–2794.
| **CORRECT% (spec-attributable)** | **WITHDRAWN — not measured. See §36.4** |
| CANNOT-VERIFY share | **1 / 451 = 0.2 %** |

> **22.2 % is a CEILING on nothing and a FLOOR on nothing — it is the document
> counted, not the code read.** `check:census-integrity` checks that this document
> agrees with itself, and says in its own output that it does not check any verdict
> against the code. §37, §38 and §39 have now read parts of it against the code —
> 44 of the C rows and 34 of the N rows — and every pass that looked moved
> something. §36.5 lists what remains open. Read §36, §38 and §39 before quoting
> either percentage.
>
> *(This paragraph read `19.7 %` until 2026-09-11. §38 restated CORRECT% to 19.3 %
> and did not reach here — the same failure mode §39 is about, one paragraph away
> from the number it restated.)*

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
| **Compass** | `compass/CompassTools.ts:15#add_to_trip` — *"`add_to_trip` proposes only. The server holds the proposal; nothing is [written]"* | three trip tools, the propose-only boundary |

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
| TR1 | Primary invariant: all consequential state changes pass through the Trip Kernel; no Map/Compass/Telegraph/Discovery/Buddy/UI component may independently invent canonical trip state | **N** | There is no kernel. `routes/trips.ts:1491-1535` writes `trip_plan_items.status` directly from a PATCH body; `routes/trips-expansion.ts:516` writes `trips.status` directly; `routes/tripReservations.ts:189,263` writes reservations directly. Twelve route files mutate canonical trip tables with no common command path. The one component that *does* respect the invariant does so by accident of its own programme (`compass/CompassTools.ts:15#add_to_trip`). |
| TR2 | Trips owns canonical journey state (identity, stages, legs, commitments, plans, participants, permissions, active phase) | **W** | Identity, participants and permissions: yes (`migrations/0001_spine.sql:72,100`; `lib/http.ts:554#canEditPlan` `canEditPlan`). Stages, legs, commitments and active phase: **no table and no type** (§5.1, §3.2). Plans exist as `trip_plan_items` (`0010_trip_plan.sql:5-30`), a flat day-keyed list, not the §2.1 `Plan`. |
| TR3 | Trips owns coordination (group availability, attendance, subgroups, meeting points, proposals, votes, readiness) | **W** | Availability: `trip_availability` (in production) + `components/TripAvailabilitySection.tsx`. Readiness: `lib/tripReadiness.ts`. Attendance, subgroups, meeting points, proposals and votes: **absent** — `grep -rli "attendance\|subgroup\|trip_proposal" ` over the trip paths returns nothing. Two of seven. |
| TR4 | Trips owns execution (Now/Next, free windows, route chains, plan start/complete, transport, disruption recovery) | **W** | "Today / Next Up" exists as a **client-side** derivation over the fetched plan list (`src/components/TripPage.tsx:155-171`), and plan completion exists as a status value (`0010_trip_plan.sql:12-13` `'done'`). Free windows, route chains, transport state and disruption recovery: absent. |
| TR5 | Trips owns context distribution (stable typed projections for Compass, Map, Telegraph, Discovery, Safety, Passport, Memory) | **W** | Exactly one typed projection exists and it points the wrong way: `services/passport/PassportConsumerProjections.ts:31` gives **Trips** a stripped Passport view, not Passport a Trip projection. Compass reads raw tables (`CompassTools.ts:405-452` selects from `trip_members`, `trips`, `trip_plan_items` directly). There is no `TripContext` type anywhere. |
| TR6 | Trips owns history (immutable domain events, decisions, snapshots, replay references, durable outcomes) | **N** | No events (§4.2), no decision ledger (§21.2), no snapshots (§22.1), no replay (§22.2), no outcomes (§20.1). `trip_activity_log` (`0079_trip_sub_tables.sql:240-247`) is a best-effort audit line, not domain history — see TR58. |
| TR7 | Trips does not become a booking engine | **C** | `0172_trip_reservations.sql:1-6` stores references and operational facts only; no payment column, no provider API, no inventory. The nearest booking system is Rent-a-Buddy and it is a separate domain. |
| TR8 | Trips does not become a payment ledger | **C** | `trip_budget` (`0079`) holds planned amounts; `0183_budget_fx_conversion.sql` converts currency for display. No ledger, no transaction table, no settlement. |
| TR9 | Trips does not become a generic messaging system | **C** | `app/trip/chat.tsx` routes into the existing Telegraph/messaging domain (`src/services/messaging.ts` `openTripChat`, used at `TripPage.tsx:211#openTripChat`); Trips stores no messages. |
| TR10 | Trips does not become a global location tracker | **C** | `lib/tripCrewLocation.ts:1-16` — exact coordinates are released only under an *active live-share grant* and are withheld anyway when hotel blur is on (`:320#resolveExactCoords` `resolveExactCoords`); ghost mode is absolute (`:217-218#TRIP_PRESENCE_GHOST`); the whole surface is behind `trip_crew_map_enabled`, seeded false (`0041_trip_crew_location.sql:63`). |
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
| TR32 | Never substitute one domain ID for another because names or coordinates look similar | **C** | Enforced by a standing ratchet rather than convention: `lib/placeIdBridge.ts` is the only sanctioned crossing, and `src/scripts/checkPlaceIdBridge.ts#SANCTIONED` is the ratchet that keeps it single — **added 2026-09-11 (§38), because until then there was none**: the script this row previously named, `checkSchemaReferences.ts`, verifies that a select-list column exists on the table being read and says nothing about id spaces. The crossing WAS single (measured: the only caller is the bridge), so the verdict was true and its stated reason was false. Also `scripts/checkWritePathColumns.ts` fail the build on an unsanctioned one. `0010_trip_plan.sql:16-17` types the external reference as `source_id text` with an explicit `source_type`. |
| TR33 | All cross-domain linkage uses explicit foreign keys or reconciliation records | **W** | True for in-domain links (`trip_plan_items.trip_id`, `route_plans.trip_id` at `0058:12`). False for the place link: `trip_plan_items.source_id` is `text` (`0010:16`) with no FK and no reconciliation record, so a plan item pointing at a deleted or merged place is undetectable. |
| TR34 | Place, hidden-gem, event, booking, buddy and flight IDs remain distinct until a canonical bridge exists | **C** | `lib/placeIdBridge.ts` is the bridge and is the only one; hidden gems carry their own `canonical_place_id` (`2044_hidden_gems_canonical_place_id.sql`) rather than being conflated; `trip_reservations` keeps a provider `confirmation_ref` as opaque text. |

### §3 Lifecycle and State Machines

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR35 | Primary lifecycle IDEA → PLANNING → BOOKED → PRE_DEPARTURE → TRAVELING → IN_DESTINATION → RETURNING → COMPLETED → MEMORY, plus DISRUPTED / CANCELLED / ABANDONED / ARCHIVED | **W** | `migrations/0001_spine.sql:10` — `trip_status as enum ('planning','upcoming','active','completed','cancelled')`, extended in practice by `'draft'` and `'archived'` (`lib/tripStatus.ts:38,40`). Seven states against thirteen: BOOKED, PRE_DEPARTURE, TRAVELING vs IN_DESTINATION vs RETURNING, MEMORY, DISRUPTED and ABANDONED have no representation, so the states that carry the spec's operational meaning are exactly the missing ones. |
| TR36 | Lifecycle is computed from canonical facts plus explicit user actions | **C** | `lib/tripStatus.ts:30-46#computeTripStatus` `computeTripStatus` derives the state from title/city presence and date boundaries **in the trip's own timezone**, honours terminal states, and `:1-10` records why it exists: two copies had diverged, one comparing UTC midnight, so *"the same trip could read 'upcoming' on one endpoint and 'active' on the other around the day boundary."* The header ends *"Never let clients override this."* |
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
| TR49 | The `TripCommand` envelope (commandId, tripId, actorUserId, expectedTripVersion, idempotencyKey, type, payload, clientObservedAt) | **C** | **Moved N→C in the §26 recensus.** The row said "No type, no table, no route." All three exist: the envelope is `lib/tripKernel.ts:263#TripCommand` (commandId, tripId, actorUserId, expectedTripVersion, idempotencyKey, type, payload), the receipt table is `migrations/2420_trip_kernel_foundation.sql:139#trip_command_receipts`, and the route is the `trip_kernel_execute` RPC that `lib/tripKernel.ts:649#executeTripCommand` calls. |
| TR50 | A typed command vocabulary (ADD_PLAN, MOVE_PLAN, CONFIRM_PLAN, CANCEL_PLAN, JOIN_PLAN, LEAVE_PLAN, CREATE_SUBGROUP, SET_PRESENCE, CREATE_PROPOSAL, ACCEPT_PROPOSAL, COMPLETE_ACTIVITY) | **N** | None of the eleven exists as a command. Four have a *route* that does something adjacent (`POST /trips/:id/plan/items`, `PATCH …/items/:itemId`, `POST /trips/:id/complete`); seven have no analogue at all. |
| TR51 | Command service validates schema | **W** | **MOVED C → W, 2026-09-11 (§38) — the first verdict this census has moved on a re-derivation.** The row read C on the sentence *"every trip write parses a zod schema first"*, which is its testable half. Counted across the three files it cites: **53 write endpoints, 8 reading `req.body` with no schema at all** — `POST /trips` (the primary create), `/invite`, `/members`, `/join-request`, `/invite-link` and the three checklist writes. 45 of 53 do validate, so the capability is built and used and this is BUILT-BUT-WRONG, not NOT-BUILT; the word *every* had never been counted. `POST /trips` is now closed by `CreateTripSchema` (`routes/trips.ts:791#CreateTripSchema`), mirroring `PatchTripSchema` field for field so it cannot reject what PATCH already accepts, and the remaining seven are held shrink-only by `check:trip-write-validation`. **What the gap costs is TYPE validation, not authorization** — `requireUser` runs first and `check:route-auth-gate` guards that independently — so a malformed payload became a 500 from the database where a 400 belongs. Returns to C when the list reaches zero. |
| TR52 | …validates actor capability | **C** | `lib/http.ts:554#canEditPlan` `canEditPlan` and `:614#canEditPlanItem` `canEditPlanItem` are called before every plan mutation (`routes/trips.ts:1713,1809,1925#canEditPlan`), and membership is checked through the shared `lib/tripMembership.ts:45#isAcceptedTripMember` `isAcceptedTripMember`. |
| TR53 | …validates aggregate version | **C** | **Moved N→C.** The row said "No version exists." `trips.version` is added by `2420_trip_kernel_foundation.sql:96#version` and the kernel refuses a mismatch: `2590_trip_kernel_add_plan_attachment_columns.sql:365#TRIP_VERSION_CONFLICT` returns the current and expected versions so a caller can refetch and retry (§18.3 "explicit conflict"). |
| TR54 | …validates temporal/spatial consistency | **W** | **Moved N→W 2026-09-08, and the W is the honest half.** The row said the write "accepts any `starts_at`/`ends_at` pair, including one that overlaps a confirmed item or precedes its predecessor." ORDERING is now checked: the kernel already refused an inverted range on the TRIP (`2590:...#TRIP_TEMPORAL_RANGE_INVERTED`, on create and on update, comparing the MERGED value), and the plan-item half is now enforced by `migrations/2750_trip_plan_item_interval_ordered.sql` (a CHECK, NOT VALID, rehearsed on portava-ci — an UPDATE into an inverted range is refused) plus the typed refusal at `lib/tripKernel.ts:649#executeTripCommand`. **OVERLAP is still unchecked** — an item may still be written across a confirmed item's interval, because that is the §7 consistency engine (TR128, TR134) and needs a route provider this tree does not have. Ordering built, overlap not. **Also recorded here rather than lost:** the plan-item check lives at the kernel's entry point rather than inside `trip_kernel_execute`, because every kernel change replaces that 700-line function in full; it should ride along with the next migration that replaces it for its own reasons. |
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
| TR76 | Consumers persist processed event IDs or use deterministic projection version checks | **C** | **Moved N→C.** A projection worker exists and is registered: `lib/mapTripProjectionWorker.ts:86#runTripMapProjectionPass` drains unpublished outbox rows in `aggregate_version` order per trip and stamps `published_at`; `:124#startTripMapProjectionScheduler` is called at `index.ts:163#startTripMapProjectionScheduler`. |

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
| TR94 | §5.2 Traveler-visible place identity resolves through the canonical place bridge where available | **C** | `lib/placeIdBridge.ts` is the single sanctioned crossing and `src/scripts/checkPlaceIdBridge.ts#SANCTIONED` is the ratchet that keeps it single. **Corrected 2026-09-11 (§38):** this row named `checkSchemaReferences.ts` as the ratchet and that was wrong — it checks select-list columns against the schema, not id spaces, and no guard mentioned the bridge at all. The crossing was single by convention; it is now single by enforcement. |
| TR95 | §5.2 Unresolved external/manual places remain typed as unresolved, not falsely canonical | **C** | `0010_trip_plan.sql:14-15` — `source_type` defaults to `'manual'` and admits `'place'`/`'meetup'`; a manual entry is typed as manual and never acquires a canonical id by default. `:22-23` additionally forbids coordinates on the label: *"public-safe label only — no GPS coordinates stored."* |
| TR96 | §5.3 Canonical durable class (trip, stages, confirmed plans, membership) retained until deletion/retention policy | **C** | `trips`, `trip_members`, `trip_plan_items` are durable with cascade deletes (`0001_spine.sql:74,101-102`; `0010:7`) and are covered by the account-deletion disposition table (`lib/deletionDispositions.ts:443`). |
| TR97 | §5.3 Operational class (decision tasks, risks, transient execution state) expires/archives after usefulness | **W** | The only operational artifact is readiness, and it does have a staleness rule — `lib/tripReadiness.ts:24-25` `READINESS_STALE_MS = 10 * 60 * 1000` with a stale-row sweep on recompute (`:5-7`). Decision tasks and risks do not exist, so two-thirds of the class has no policy because it has no rows. |
| TR98 | §5.3 Ephemeral sensitive class (precise presence, safety/location) has short TTL and strict access | **C** | `0167_safety_ddl_reconcile.sql:126-137` — `safe_return_live_shares` is `active \| stopped \| expired` with an `expires_at` index; `trip_crew_location_sessions` carries an expiry consumed at `lib/tripCrewLocation.ts:142`; `lib/tripCrewLiveShareScheduler.ts` sweeps. Strict access is `lib/tripCrewLocation.ts:1-16`'s privacy contract. |
| TR99 | §5.3 Derived class (Today/Map/Compass projections) is rebuildable with TTL/freshness metadata | **W** | Only one derived artifact exists (`trip_readiness_snapshots`, `0175`) and it *is* rebuildable with a staleness bound. The Today/Map/Compass projections it names do not exist (§11.1, §14.1, §19.1), so the class is one-eighth populated. |
| TR100 | §5.3 Historical evidence class (events, decision ledger, snapshots) is policy-controlled with minimised payloads | **W** | `trip_activity_log` is retained indefinitely with an unconstrained `metadata JSONB` (`0079:245`) — no retention policy, no payload minimisation, no size bound. The decision ledger and snapshots do not exist. |

### §6 Authorization, RLS and Policy Layer

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR101 | Roles are coarse; capabilities derive from role + trip policy + plan membership + privacy scope | **W** | Two of the four inputs are real: `lib/http.ts:554#canEditPlan` combines role with the trip's `plan_edit_permission` setting (`0021_plan_edit_permission.sql`), and `lib/http.ts:614#canEditPlanItem` adds item authorship. Plan membership does not exist (TR83) and privacy scope is a two-value column (TR82), so half the derivation has no inputs. |
| TR102 | Application code calls policy functions rather than scattering host checks | **W** | True for plans — `canEditPlan`/`canEditPlanItem` are centralised in `lib/http.ts` and called from `routes/trips.ts:1443,1505-1509,1573` and `compass/CompassTools.ts:714`. False elsewhere: `routes/trips-expansion.ts:507` (`owner_id !== user.id`), `:530`, `:583`, `routes/tripReservations.ts:426-429` and `routes/tripCrewLocation.ts:170` each inline their own ownership or role check. Scattered host checks are exactly what the rule names. |
| TR103 | `canViewTrip(actor, trip)` | **W** | The behaviour exists and the function does not: `routes/trips-expansion.ts:2572` `GET /trips/:tripId` resolves visibility inline and `src/test/tripPrivacy.test.ts:7-15` proves the outcomes (non-member → preview, accepted member → full, removed member → preview on the next request, private non-member → locked sentinel). A tested inline gate, not a policy function. |
| TR104 | `canInviteParticipant(actor, trip)` | **W** | Inline at `routes/trips.ts:927` and `routes/trips-expansion.ts:891`; no named policy. |
| TR105 | `canEditTrip(actor, trip)` | **W** | Inline owner checks at `routes/trips.ts:684` and `routes/trips-expansion.ts:350`; no named policy. |
| TR106 | `canCreatePlan(actor, trip)` | **C** | `lib/http.ts:554#canEditPlan` `canEditPlan`, called before the create at `routes/trips.ts:1713#canEditPlan`. |
| TR107 | `canModifyPlan(actor, plan)` | **C** | `lib/http.ts:614#canEditPlanItem` `canEditPlanItem`, called at `routes/trips.ts:1929,1999#canEditPlanItem`. |
| TR108 | `canManageBooking(actor, trip)` | **W** | `routes/tripReservations.ts` has `requireReservationMember` plus a stricter delete rule at `:426-429` (*"creator or trip OWNER only"*) — real authorization, expressed as a route-local helper rather than a policy function. |
| TR109 | `canSeePresence(actor, subject, trip)` | **W** | The decision is made inside `lib/tripCrewLocation.ts:104` `buildCrewCard` per member, honouring ghost mode, default visibility and safe-return opt-in. It is a card builder, not a predicate, so no caller can *ask* the question — and `routes/tripCrewLocation.ts:170-174` admits **invited-but-not-accepted** members (`getMemberRoleAny`) to the crew map. |
| TR110 | `canSeePreciseLocation(actor, subject, trip)` | **C** | `lib/tripCrewLocation.ts:320#resolveExactCoords` `resolveExactCoords`, gated on a grant this module now checks for expiry itself (`:238#grantIsActive`) — exact coordinates require an **active live-share grant** *and* hotel-blur off *and* populated coordinates; ghost mode short-circuits first (`:217-218#TRIP_PRESENCE_GHOST`). Three independent conditions, all fail-closed, and membership alone never suffices. |
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
| TR155 | Compass may create a proposal but cannot silently mutate other participants' commitments | **C** | The one §9 requirement that is genuinely met, and met deliberately: `compass/CompassTools.ts:15#add_to_trip` — *"`add_to_trip` proposes only. The server holds the proposal; nothing is [written]"* — `:158-161` *"This never writes anything — it returns a pending proposal that the user must explicitly confirm in the UI before the server executes it"*, `:229` instructs the model *"never claim the item was added"*, and `:712-716` still runs `isAcceptedTripMember` + `canEditPlan` before even proposing. Built for the Compass programme, not this spec, but it satisfies this requirement exactly. |
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
| TR163 | …`visibility` | **C** | `CrewVisibility = hidden \| city_only \| neighborhood \| nearby \| arrived_only` (`lib/tripCrewLocation.ts:31`), stored per member in `trip_crew_location_preferences` and honoured at `:210-282#canSeePresence`. |
| TR164 | Location freshness LIVE \| RECENT \| LAST_KNOWN \| OFFLINE | **N** | No freshness class is computed anywhere. `updatedAt` is passed through raw (TR159) and never classified. |
| TR165 | The Trip Map must never draw a stale location as if it were current | **W** | It does. `buildCrewCard` (`lib/tripCrewLocation.ts:131-146`) returns `statusLabel: "live_sharing_active"` with an `areaLabel` whenever a live-share **grant** is active, regardless of how old `locationState.updatedAt` is — the grant's expiry is checked, the observation's age is not. `CrewMapSection.tsx:35-38` then renders that member as `live` in the density map. A three-day-old city, under a grant issued five minutes ago, draws as live. **This is the most consequential single defect in the Trips census.** |
| TR166 | Marker visual treatment **and accessible text** must expose freshness | **N** | Neither. `src/components/tripCrew/CrewMemberCard.tsx:5` — *"No exact coordinates are ever displayed; statusLabel drives the UI"* — and `statusLabel` carries no age; `:106-120` renders `areaLabel` and two coloured status strings with no timestamp and no accessibility label for recency. |
| TR167 | §10.3 Use geofences before constant GPS | **C** | `src/services/geofence.ts` + `0035_plan_geofences.sql` / `0039_plan_geofence_full.sql`; `POST /api/location/exit-geofence` drives delayed publishing (`lib/delayedPostPublisher.ts:5-7`). |
| TR168 | §10.3 …significant location changes | **C** | `user_location_state` is updated on coarse change rather than on a tick; `0032_location_preferences.sql` / `0033_location_sessions.sql` carry the preference and session model. |
| TR169 | §10.3 …navigation callbacks | **N** | No navigation SDK integration and no callback path anywhere in the client. |
| TR170 | §10.3 …semantic checkpoints | **C** | `plan_checkins` feeds `checkInStatus` on the crew card (`lib/tripCrewLocation.ts:59-60,155-156`), and `route_stops.checkpoint_status` (`0058_trip_flow.sql:68`) is a checkpoint model. |
| TR171 | §10.3 …explicit user actions | **C** | Live share is started by an explicit act with an explicit duration (`routes/tripCrewLocation.ts:400#live-share/start` `POST /trips/:tripId/crew/live-share/start`; client `LiveShareSheet.tsx`). |
| TR172 | §10.3 Increase sensing frequency only when execution/safety requires it | **W** | The *effect* holds — there is no continuous sensing to increase — but there is no adaptive policy: no sampling-rate concept, no escalation on a safety event. Safe Return raises *notification* escalation (`escalationLevel: 0\|1\|2\|3`, `SafeReturnService.ts:33`), not sensing frequency. |
| TR173 | §10.4 Offline Locate-My-Friends integration for Trip Crew | **W** | `routes/locateFriends.ts` exists and scopes a session by `groupScopeId`, which `:205-215` documents as *"a `route_plans.id` — Portava's collaborative plan"* — a **route plan**, not a Trip. And its four tables (`locate_friends_sessions/_members/_positions/_audit`) are **absent from production** (`scripts/checkProductionDrift.ts:177-180`). Built, mis-scoped, undeployed. |
| TR174 | §10.4 Cached event maps | **N** | No offline map cache (see §18.1). |
| TR175 | §10.4 Last-known positions | **C** | `locate_friends_positions` holds them and the crew card carries the last known city/district (`lib/tripCrewLocation.ts:47-53`). |
| TR176 | §10.4 Opt-in Bluetooth proximity | **N** | No BLE dependency, no peer-relay code. `grep -rli "bluetooth\|BLE\|peripheral"` over the client → nothing relevant. |
| TR177 | §10.4 Meeting checkpoints | **W** | `route_stops.checkpoint_status` (`0058:68`) and `trip_plan_items.category = 'meeting_point'` (`0010:11`) both exist as labels; neither is a crew meeting-checkpoint with participants and arrival state. |
| TR178 | §10.4 Temporary relay metadata | **N** | Absent. |
| TR179 | §10.4 This must not create covert persistent tracking | **C** | Enforced, and in the strongest available way: ghost mode is absolute and checked first (`lib/tripCrewLocation.ts:217-218#TRIP_PRESENCE_GHOST`), a member who has not opted in reads `not_shared` (`:282#not_shared`), the whole surface is behind `trip_crew_map_enabled` seeded false (`0041:63`), live shares expire, and `routes/tripCrewLocation.ts:241,277` give explicit enable/disable endpoints. |

### §11 Trip Today Projection and Execution UX

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR180 | The `TripTodayProjection` contract | **N** | `grep -rli "TripToday\|trip_today\|todayProjection"` → nothing. There is no `GET /trips/:id/today` endpoint (the registered trip routes are enumerated across `routes/trips.ts`, `trips-expansion.ts`, `tripReadiness.ts`, `tripReservations.ts`, `tripCrewLocation.ts`, `tripBudgetIntel.ts`, `tripDraft.ts` and none is `/today`). |
| TR181 | `nowState` | **W** | Derived **on the client** from the fetched plan list: `src/components/TripPage.tsx:155-171` renders a "Today / Next Up" section. A client-side derivation is the shape §11.1 exists to replace, and it cannot be consumed by Compass, Map or Telegraph. |
| TR182 | `currentPlan` | **W** | Same client derivation (`TripPage.tsx:155-199`). |
| TR183 | `nextCommitment` | **W** | The "Next Up" half of the same section — over plan items, not commitments (TR15). |
| TR184 | `freeWindows[]` | **N** | No free windows exist (TR131). |
| TR185 | `crewSummary` | **W** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:233#crew/map`) returns `{ members, totalCount }` — a crew summary, on a different endpoint, behind a different flag, with no relation to a Today projection. |
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
| TR200 | §11.4 Trip events must pass an attention policy | **W** | **MOVED C → W, 2026-09-11 (§38).** The row read C because `services/notifications/NotificationRouter.ts` consults `NotificationPreferenceService`, `NotificationDeduplicationService` and `CompassNotificationEngine.evaluateNotification` before dispatching. **It does — and ten trip push sites never reach it.** They call `sendPushWithRetry` directly (`lib/pushWithRetry.ts`), which is a pure transport wrapper: it filters malformed tokens, retries transient Expo failures and clears dead ones, and consults no policy whatever. Counted: 4 in `routes/trips.ts`, 5 in `routes/trips-expansion.ts`, 1 in `lib/tripReminderScheduler.ts`. The bypass is DELIBERATE — one site carries the comment *"notifRouter.route() is intentionally NOT called here; push was already sent above via sendPushWithRetry to avoid double-delivery"* — which is why it is counted rather than patched in passing. **The cost is concrete:** `NotificationPreferenceService` holds per-user channel preferences, per-category preferences and QUIET HOURS (it computes `localMinutesOfDay` against the user's timezone), so a user who has switched a category off, or who is inside their quiet hours, receives all ten regardless. Held shrink-only by `check:trip-push-policy`, keyed on `file:line` rather than a total so the check cannot stay green across a substitution. Returns to C when that list reaches zero. |
| TR201 | §11.4 Do not convert every social or live-intel change into a push notification | **C** | Three independent suppressors exist and are real: per-user channel preferences (`NotificationPreferenceService`), dedup (`NotificationDeduplicationService`) and digesting (`NotificationDigestService`), plus per-template `defaultChannels`. **Evidence corrected 2026-09-11 (§38): those three do NOT cover the trip surfaces.** Ten trip pushes bypass the router entirely — see TR200. The verdict nonetheless stands, and the reason it stands is worth stating rather than assuming: this requirement is that not *every* change becomes a push, and the ten bypasses are discrete, deliberately chosen events (invitation received, join request, decision, review prompt, reminders), not a firehose of social or live-intel deltas. Trips does not push on every plan edit, presence beat or member move. What is wrong is the *mechanism* named — TR200 — not the outcome this row grades. |

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
| TR219 | §12.2 …may not mutate shared commitments without the command/policy path | **C** | `CompassTools.ts:15#add_to_trip` — *"`add_to_trip` proposes only. The server holds the proposal; nothing is [written]"*; `:229` *"never claim the item was added."* |
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
| TR256 | Layer: hotel/private anchors, **access controlled** | **W** | The control exists at the item level: `trip_plan_items.location_is_private` and `0010:22-23`'s coordinate prohibition, plus the crew card's hotel-blur (`lib/tripCrewLocation.ts:56-58`, `resolveExactCoords` at `:320#resolveExactCoords`). There is no *anchor* concept and no projection-level exclusion rule — the safety depends on each writer setting a flag. |
| TR257 | Layer: active plans | **W** | `GET /trips/:tripId/plan/map` returns plan items; "active" cannot be expressed (no IN_PROGRESS, TR46). |
| TR258 | Layer: confirmed commitments | **N** | TR122. |
| TR259 | Layer: saved ideas | **C** | `trip_saved_places` (TR25), served at `routes/trips-expansion.ts:2085`, rendered by `src/hooks/useTripSavedPlaces.ts` on the trip page. |
| TR260 | Layer: crew presence summaries | **C** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:233#crew/map`) returns per-member summary cards with no coordinates unless a live-share grant exists — a summary layer in the spec's sense; `CrewMapSection.tsx:37-53#DensityMap` renders it as a density map with no SDK and no exact positions. |
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
| TR282 | §14.4 Clusters and aggregate counts may be used where exact identity/location is unnecessary | **C** | `CrewMapSection.tsx:37-53#DensityMap` `DensityMap` renders rings and counts from status labels with **no coordinates at all** and no map SDK — the aggregate form the rule permits, chosen as the default rather than as a fallback. |

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
| TR315 | Health is a summary projection; it does not replace concrete risks/reason codes | **C** | The best-stated rule in the trip domain: `lib/tripReadiness.ts:9-12#CRITICAL-VISIBILITY` — *"CRITICAL-VISIBILITY RULE: the aggregate score must NEVER hide critical items. The summary always carries the FULL `criticalItems` array — untruncated — no matter how high the score is. Consumers must render criticalItems independently of the score."* |
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
| TR332 | §17.4 …time-limited | **C** | `0167:126-137` — `status IN ('active','stopped','expired')` with an `expires_at` index; `SafeReturnPrivacyGuard.ts:144#expired` refuses an expired session on read. |
| TR333 | §17.4 It exposes operational states such as RETURNING / ARRIVED / NEEDS_HELP rather than unnecessary continuous location | **C** | `SafeReturnService.ts:18#SafeReturnStatus` — `SafeReturnStatus = "pending" \| "active" \| "safe" \| "missed" \| "cancelled"`: `active` ≈ RETURNING, `safe` ≈ ARRIVED, `missed` ≈ NEEDS_HELP. Different words, exactly the semantics, and location sharing is a **separate opt-in** rather than the mechanism (`canReceiveLiveLocation`, `:25`). |

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
| TR353 | §18.3 Membership/permissions: server authority; stale offline writes rejected/reconciled | **C** | Server authority is real and tested: membership is resolved server-side on every read and write (`lib/tripMembership.ts:45#isAcceptedTripMember`), a removed member loses access on the next request (`src/test/tripPrivacy.test.ts:11`), and no membership state is client-authoritative. There are no offline writes to reject, which makes this partly structural. |
| TR354 | §18.4 Server aggregate version is canonical | **N** | No version (TR12). |
| TR355 | §18.4 Clients must not declare local write time as authoritative ordering across devices | **C** | They do not: `trips.updated_at` is set by a database trigger (`migrations/0001_spine.sql:91-93` `trg_trips_updated`), `trip_plan_items.updated_at` is set server-side (`routes/trips.ts:1520`), and `lib/tripStatus.ts:1-10` exists precisely to stop two *servers* disagreeing about time. No client clock reaches an ordering column. |

### §19 Projections and APIs

| id | Requirement | V | Evidence |
| --- | --- | --- | --- |
| TR356 | `TripTodayProjection` | **N** | TR180. |
| TR357 | `TripTimelineProjection` | **W** | `GET /trips/:tripId/plan` (`routes/trips.ts:1330`) returns the ordered plan; the client builds `TimelineDay[]` (`src/types/models.ts`, rendered at `TripPage.tsx:241-264`). A client-assembled day list, not a server projection with a version and a freshness. |
| TR358 | `TripMapProjection` | **W** | `GET /trips/:tripId/plan/map` (`routes/trips.ts:1400`) — plan items with coordinates and nothing else from §14.1's eleven layers. |
| TR359 | `TripCrewProjection` | **W** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:233#crew/map`) is the closest thing to a real projection in the trip domain — it is assembled server-side, privacy-resolved before serialization, and returns a typed card list. It carries no `generatedAt`, no version and no freshness, and it is behind `trip_crew_map_enabled`, seeded false. |
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
| TR372 | `GET /trips/:id/crew` | **W** | `GET /trips/:tripId/crew/map` (`routes/tripCrewLocation.ts:233#crew/map`) plus four sibling crew endpoints (`:187,213,241,313`). |
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
| TR381 | Operational logs do not become permanent memory wholesale | **C** | **Evidence corrected 2026-09-11 (§38): there are TWO readers, not one.** The trip's own activity endpoint (`routes/trips-expansion.ts:3167#trip_activity_log`) AND the invite-links endpoint (`routes/trips-expansion.ts:1412#trip_activity_log`), which filters to `joined_via_invite_link` to decorate each link with its joiners. **The verdict is unchanged and the reason it survives is worth stating**: both readers are trip-scoped (`.eq("trip_id", tripId)`), both serve the trip's own surface, and neither writes the log into a durable projection — so the log still does not become permanent memory. What was wrong was the word *nothing*: a universal claim that had never been counted. No Memory or Passport path touches it. The prohibited path does not exist and there is nothing that would create it, because Memory is fed by stamps and posts. |
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
| TR414 | §22.4 A removed participant cannot receive future precise trip presence through that Trip | **C** | Proven, and it is the only §22.4 invariant with a test: removal deletes the `trip_members` row (`routes/trips.ts:2182#members/:userId` `DELETE /trips/:tripId/members/:userId`), `routes/tripCrewLocation.ts:170-174` refuses a non-member with `not_member`, and `src/test/tripPrivacy.test.ts:11` asserts *"A removed member immediately receives the preview on the next request."* Caveat recorded at TR109: the same gate admits *invited* members, so the invariant holds for removal and is looser than it should be for admission. |
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
absolute and checked first (`:166-168#ghostMode`). The privacy architecture is good. The **freshness**
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
- **`lib/tripReadiness.ts:9-12#CRITICAL-VISIBILITY`** — the CRITICAL-VISIBILITY RULE: *"the aggregate score must
  NEVER hide critical items … no matter how high the score is."* §8.3's warning about
  gamified truth scores, anticipated and answered.
- **`lib/tripCrewLocation.ts:96-103,119-122`** — three independent fail-closed conditions
  before an exact coordinate, ghost mode absolute and checked first. §6.2's "membership
  does not imply precise location access" enforced structurally.
- **`compass/CompassTools.ts:15,158-161,229`** — propose-only, with the authorization check
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
| `head_commit` | `014a25d5` — RE-DECLARED 2026-09-11 from `42aeac38` by §36's from-zero recount, on the same mechanical test: `git diff --name-only 42aeac38 014a25d5` over this census's **34** scoped paths returns **0 files**, so every verdict is exactly as true at one as at the other. `014a25d5` is #481's squash and is the tip of `main`; declaring it is what makes "recounted against merged `main`" a checkable statement rather than a claim. Previously — RE-DECLARED 2026-09-09 from `6c6995e1`, and that move was a measurement rather than a judgement too: `git diff --name-only 6c6995e1 42aeac38` over this census's scoped paths returned **0 files**. It was necessary because `6c6995e1` is a PRE-SQUASH commit — this repository squash-merges, so it is an ancestor of nothing and is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). `42aeac38` is #476's squash, where this document's content actually reached `main`. Measurement lineage unchanged: §29 measured `823b6d67`; §30 re-measured §7.4 at `c3f76a49`; §31 re-measured §9.3 and §14 at `6d3e7a56`; §32 corrected TR261/TR437 at `1ec4d903`; §34 re-read the three §5 read routes at `6c6995e1`; §35 executed the kernel live. ONE declaration, kept current, because `check:census-freshness` reads the first one it finds and a second row further down is a decoration that ages nothing. |
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
| TR90 `trip_snapshots` | N | **W** | 2773 fold/replay/verify; served by `tripCommands.ts`. No screen (29.2). |
| TR91 `trip_outcomes` | N | **W** | 2768 RECORD_OUTCOME; served by `tripStructure.ts` with `planPresent`. |
| TR83 `trip_plan_participants` | N (**"blocked"**) | **W** | §27 said this was "blocked, not merely unbuilt" because `trip_plans` does not exist. **That was wrong and it contradicted TR82 in the same document**, which already said `trip_plan_items` IS §5.1's `trip_plans`. Migration 2770 made the identity explicit, 2771 built the table, 2772 wrote it. The correction is recorded here rather than silently applied. |
| TR136 stage-locality | N | **N** | §7.4's consistency check still has no implementation. Stages existing does not build it. |
| TR144 risk propagation | N | **W** | `propagateRisks` in `TripDecisionEngine.ts`, served as `elementRisks`, rendered by `TripDecisionsCard`. |
| TR123 arrival semantics | N | **W** | `required_arrival_at` exists (2761) and is now *used*: the feasibility engine judges against it, and a behaviour test drives the spec's own 19:00/18:45 example. |
| TR255 stage map layer | N | **N** | Still no map consumer for stages. `TripStageSpineCard` is a list, not the map layer §5.1 describes. |

> **CORRECTED 2026-09-11 (§39.3).** The last two table rows above were written
> as `TR89 `trip_snapshots`` and `TR90 `trip_outcomes``. This
> census's §5.1 body assigns TR89 `trip_events`, TR90 `trip_snapshots` and TR91
> `trip_outcomes`: from TR89 on, the ids ran one ahead of the objects. The ids
> are corrected here to the objects the evidence in each row actually describes.
>
> The cost was not the two rows. It was the **third**: TR91 `trip_outcomes` was
> never moved at all, and kept the verdict NOT-BUILT with the evidence "Does not
> exist." while `CREATE TABLE public.trip_outcomes` sat at
> `2763_trip_presence_proposals_snapshots_outcomes.sql:124` on merged `main`.
> TR89 `trip_events` was already **W**, so the row claiming to move it N→W moved
> nothing and attached `trip_snapshots`' evidence to the wrong object. §39.4
> moves TR91, and `check:census-row-move-labels` now fails on either half of
> this pair restored.

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

---

## 36. Recount from zero, at `head_commit` `014a25d5` — merged `main`

This is the recount the previous nine sections kept deferring. §26 closed by saying
the headline was left uncorrected because *"correcting it from a partial re-read
would be inventing a number"* and itemised §4's twelve moves *"so the arithmetic is
available to whoever finishes the job."* This finishes it.

**It is a recount of the DOCUMENT, not a re-reading of the CODE.** Every one of the
451 verdicts below was written by an earlier pass; none was re-derived from the
implementation here. What changed is that all 451 are now *counted*, mechanically and
reproducibly, for the first time — and that four factual premises those verdicts rest
on were re-measured against merged `main` and the live databases. §36.5 is the list
of what that still does not settle, and it is long.

### 36.1 The number

| Bucket | `68ed59d9` headline | **Recount at `014a25d5`** | Move |
|---|---:|---:|---|
| C (BUILT-AND-CORRECT) | 78 | **89** | +11 |
| W (BUILT-BUT-WRONG) | 110 | **127** | +17 |
| N (NOT-BUILT) | 262 | **234** | −28 |
| X (CANNOT-VERIFY) | 1 | **1** | — |
| **Total** | 451 | **451** | — |

**CONSTRUCTED 47.9 % (216/451) · CORRECT 19.7 % (89/451).** Against the headline this
document carried for eleven sections — 41.7 % / 17.3 % — that is +6.2 and +2.4 points.

Reproduce it with `node --import tsx/esm src/scripts/checkCensusIntegrity.ts`, which
now prints `trips 451 89 127 234 1 … 0 counted where this tool cannot read`. The
final zero is the point: **every requirement in the denominator is now machine-read.**
It was 69 before.

### 36.2 Why nobody could count this document until now

The headline was never the hard part. The hard part is that `check:census-integrity`
was reading **382 of 451 rows** and reporting 86 / 110 / 186, and both numbers were
wrong in ways no reader could see. Three row shapes this census uses were invisible to
it, and all three are shapes the census *documents itself as using*:

| Shape | Example | Cost |
|---|---|---|
| **Range** | `\| TR38–TR45 \| …phases… \| **N** ×8 \|` | The row was dropped whole — not read as 8, not read as 1. The census's own key says *"A cell reading `**N** ×9` is one verdict applied to the consecutive ids named in that row"*. |
| **Compound** | `\| TR58–TR62 + TR64–TR66 \| … \|` | Same, and it deliberately skips TR63, which is scored **W** separately. |
| **Labelled id** | `` \| TR78 `trip_stages` \| W \| **W** \| why \| `` | The id is there; the label made the cell unparseable. |

The third is the damaging one. **Every "Row moves" table in §29.4, §30.3 and §31.3,
and every "Row corrections" table in §32.4, writes its id cell that way.** Those
tables are where this document records its *newest* verdicts — 28 revisions in all.
So the checker was counting the superseded originals and silently discarding every
correction that superseded them. A census whose corrections are the one thing its
guard cannot read is worse than an uncounted one: it reports the state that a later
pass already found to be wrong, with a guard's authority behind it.

`checkCensusIntegrity.ts` now reads all three, plus `?` (the CANNOT-VERIFY token,
which was absent from its alias table) and `⌀` (the vacuity flag, which is a footnote
on a verdict and not a verdict). Each was mutation-tested: break the `×8` and the
multiplier check fires; break the range and 7 requirements vanish; hide one labelled
id and TR79 falls back from **W** to the **N** §29.4 superseded.

**This is not a Trips-only fix, and the other twelve censuses moved too.** Corpus
rows read: 2,921 → 3,087. Requirements counted where the tool cannot read: **369 →
203**. Six censuses now have no prose gap at all (layover, media, passport, sensing,
trips, wall), up from two. The verdict distributions of the other twelve changed only
by rows that were always there and never counted — no verdict was edited by this pass
outside this file.

### 36.3 A guard bug this recount had to fix before it could land

`checkCensusIntegrity.ts` matched its headline buckets with `CANNOT-VERIFY[^|]*`,
which also matches the `CANNOT-VERIFY share` row every census writes directly
beneath. Last-block-wins then took the share row, and "last number on the line" read
`**1 / 451 = 0.2 %**` as **2**.

It had never fired, because the check it feeds runs only when parsed rows equal the
denominator — which no affected census reached while whole row shapes were being
dropped. Fixing the parser reaches it for six censuses at once. **Measured both ways:**
unanchored, the sums come out media 168, passport 174, trips 452, wall 206 against
denominators of 450 / 169 / 451 / 205 — four false failures on arithmetic that was
never wrong. Anchored, all four sum exactly to their denominator.

This is the §0 rule paying out in the other direction: a guard that had been green for
its whole life was green only because nothing had ever reached it.

Two checks were added on top, both of which fire only where a census has **no prose
gap**, so they accuse nobody of prose-counting:

1. **The headline must EQUAL the rows, not merely sum to the denominator.** Summing
   proves the four numbers partition the right total; it does not prove they are
   *this* document's partition. 78 / 110 / 262 / 1 and 89 / 127 / 234 / 1 both sum to
   451. Applied to the six eligible censuses, five already agree to the row. The only
   one that did not was this one, which is how the check earned its place.
2. **A `×N` must equal the number of ids in its own cell.** `| TR38–TR45 | … | N ×9 |`
   claims nine requirements on eight ids; whichever is right, the headline is wrong by
   one in a row no reader would re-count. Zero mismatches exist today.

### 36.4 Four premises that merged `main` falsified, measured not assumed

The merge of #481 (`014a25d5`) and the live databases were read directly. Four
load-bearing statements in this document are now false, and one is now true only of
production:

| Stated | Where | Measured at `014a25d5` |
|---|---|---|
| *"None of 2750 or 2760–2777 is on `main`"* | §29.5 | **False.** All 21 are on `main`. |
| *"Production and portava-ci both carry 2420 and nothing after it"* | §29.5 | **False for portava-ci**, which carries through `2777`. Of the eighteen 2760–2777 rows, **thirteen are `applied_by='ci'`** — the sanctioned applier, which runs only on `refs/heads/main`. The five `manual` rows are exactly the ones §29.5 disclosed (2760–2763, 2767). **True for production.** |
| *"eleven do not exist at all"* (the §5.1 tables) | Headline | **False on portava-ci** — all eleven exist. **True in production**: `trip_stages`, `trip_legs`, `trip_commitments`, `trip_plan_participants`, `trip_goals`, `trip_decision_tasks`, `trip_risks`, `trip_presence`, `trip_proposals`, `trip_snapshots`, `trip_outcomes` — 0 of 11 present. |
| *"no code anywhere reads or writes a trip version"* | §7, on TR12/TR77 | **False.** 61 files on `main` carry `sourceTripVersion` / `expectedTripVersion` / `aggregate_version` / `trips.version`. `trips.version` exists on portava-ci as `bigint DEFAULT 0`. `current_stage_id` and `home_timezone` are still absent, so that clause is 1 of 3 falsified, not 3 of 3. |

The document's two opening greps, re-run on merged `main`: the spec/kernel/projection
grep returns **56 files** (1 at `68ed59d9`, 47 at §26); the one this census calls *"the
whole story in one line"* returns **76** (0 at `68ed59d9`, 34 at §26); `aggregate_version`
alone, **32** (0, then 17).

**No verdict moves because of any of this, and that is deliberate.** §29.5 held every
§5 row at W on the rule *"C requires the thing to work"*, and its chain — BUILT ON
BRANCH → MERGED → DEPLOYED → FLAG ENABLED → PRODUCTION REALIZED — has advanced by
exactly two links, not five. Merged: yes. Deployed to the CI project: yes, by the
sanctioned applier. Deployed to production: **no, 0 of 11 tables**. So the verdicts
stand and their *stated reasons* were wrong; §29.5's reasoning is corrected here
rather than quietly left to be quoted. The +11 C and +17 W in §36.1 come entirely from
revisions this document had already written and its guard could not read — **not one
verdict was moved by this pass.**

The **spec-attributable 0.0 %** is withdrawn rather than restated. §26 established
that `2420_trip_kernel_foundation.sql` cites this spec by section number, so 0 is
false; how many of the 89 C rows are attributable has not been measured, and
substituting a guess for a falsified zero is the error §26 refused to make.

### 36.5 What this section does NOT claim

- **Not one of the 451 verdicts was re-derived from the code.** This is the document
  counted correctly, not the surface re-read. `check:census-integrity` states the same
  limit in its own output. The 19.7 % is neither floor nor ceiling on correctness — it
  is a faithful count of what earlier passes concluded.
- **Sections §5–§25 outside the ones §26–§35 reopened are still `68ed59d9` verdicts.**
  §26 listed §7, §11, §12, §13, §14, §16, §19, §21 and §22 as unaudited; §30–§34
  reopened parts of §7, §9 and §14, and §35 executed §4's kernel. The rest stand
  unexamined, and the Trip Kernel programme plausibly moved rows in several.
- **Nothing here is a production claim.** Production carries none of the eleven tables
  and Batch C of `manual-production-migration-runbook.md` is unapplied. Every C and W
  in §36.1 describes code that is merged and, at most, applied to portava-ci.
- **The five `manual` ledger rows are still a disclosed exception**, not a clean
  application. 2760–2763 and 2767 carry `checksum='backfill'`, which is the mechanism
  `ciSupabaseGuard.mjs` exists to refuse.
- **`CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES` is untouched by this pass** and `main`
  remains red on `CI (live DB)` for it. It concerns 2311 / 2320 / 2325, which are not
  Trips files and belong to branches this lane does not own.

---

## 37. The first pass that read this census against the code

Every earlier section measured this document against itself. §36 said so in its own
first line and listed it as the largest remaining gap. This is the first pass to open
the files the verdicts cite and look at the lines they name.

**It did not move a verdict.** Every claim checked is still true; what had rotted is
*where* the document says to look. That is a smaller finding than a wrong verdict and
a much larger one than a typo, because a citation nobody can follow is the only thing
standing between a reader and re-deriving 451 rows by hand.

### 37.1 What was measured

`census-trips.md` carries **338 file:line citations**. At `014a25d5`: **0** name a file
that does not exist, **0** name a line past the end of one — and **315 of 338 were
range-only**, which is the weak half of `check:doc-citations`. A range check asks
whether the file is still long enough. It cannot notice that the thing moved inside it.

Restricting to the rows that make the strongest claim — the **89 BUILT-AND-CORRECT
verdicts**, carrying 134 citations — 114 were range-only. Of those, the ones opening on
a line with no identifier on it at all were read one at a time against the tree.

### 37.2 The drift, measured

| citation as written | what it claims | where it actually is | off by |
|---|---|---:|---:|
| `routes/trips-expansion.ts:2532` | the only reader of `trip_activity_log` | `:3173` | **641** |
| `routes/trips.ts:1647` | `DELETE /trips/:tripId/members/:userId` | `:2127` | **480** |
| `routes/trips.ts:1509,1573` | `canEditPlanItem` call sites | `:1878,1946` | **369** |
| `routes/trips.ts:1443` | `canEditPlan` before plan create | `:1662` | **219** |
| `lib/tripCrewLocation.ts:104-146` | `resolveExactCoords` | `:239` | **135** |
| `routes/tripCrewLocation.ts:313` | `POST …/crew/live-share/start` | `:400` | **87** |
| `routes/tripCrewLocation.ts:156` | `GET …/crew/map` | `:233` | **77** |
| `lib/tripCrewLocation.ts:119-122` | ghost mode checked first | `:163-164` | **44** |
| `lib/tripMembership.ts:23` | `isAcceptedTripMember` | `:45` | **22** |
| `SafeReturnPrivacyGuard.ts:128` | refuses an expired session | `:144` | **16** |
| `lib/http.ts:534` / `:594` | `canEditPlan` / `canEditPlanItem` | `:544` / `:604` | **10** |
| `TripPage.tsx:203-208` | `openTripChat` call site | `:211` | **8** |
| `CompassTools.ts:158-161` | the `add_to_trip` tool | `:161` | 3 |
| `lib/tripStatus.ts:29-46` | `computeTripStatus` | `:30` | 1 |
| `CrewMapSection.tsx:36-53` | `DensityMap` | `:37` | 1 |
| `lib/tripReadiness.ts:8-12` | the CRITICAL-VISIBILITY RULE | `:9` | 1 |
| `SafeReturnService.ts:17` | `SafeReturnStatus` | `:18` | 1 |

**Every one of these stayed IN RANGE**, so `check:doc-citations` was green on all of
them, every run, for as long as they have been wrong. This is precisely the class that
script's own header predicted — *"the IN-RANGE-BUT-WRONG class is much larger than the
out-of-range one"* — now measured on a second document and larger there too.

One citation was wrong in a different way: TR216 attributes `wrapUgc` to `CompassTools.ts`
by inheritance, when `wrapUgc` is defined in `CompassStructuredContext.ts:77`. The
sentence names the right module and the citation grammar resolved the wrong one.

**37 citations were corrected and given `#anchor` needles**, which pin the FIRST line of
each cited range. The repo-wide anchored count goes **243 → 278** and the ratchet floor
moves with it, so the next drift of this kind is a red build rather than a discovery.

### 37.3 A false finding, caught before it was written

This section nearly recorded that TR10 was wrong. The census says the crew map is behind
`trip_crew_map_enabled`, *"seeded false (`0041_trip_crew_location.sql:63`)"*, and the
first resolution of that citation showed line 130 seeding it **`true`**.

**Three different files in this repository are named `0041_trip_crew_location.sql`** —
under `src/migrations/` (seeds `false`, at line 63), under `artifacts/api-server/migrations/`
(seeds `true`, at line 130), and at the repo root (seeds `false`, line 81). The census
means the first, its line number is exactly right, and the audit had resolved the second
because a bare basename matches all three and it took the first candidate.

`check:doc-citations` reports **593 citations whose path matches multiple repo files**
and Trips contributes 53 of them. The rule this adds: **a basename that resolves to more
than one file has not been resolved.** The near-miss cost nothing only because the flag's
value was checked in every candidate rather than in the first one found.

### 37.4 The structural reason this rotted unseen

`check:census-freshness` reported this census FRESH throughout. It was telling the truth
about the scope it had been given, and the scope was the wrong half.

Measured: the census cites **49 distinct files; 10 were in `CENSUS_SCOPE`.** The 39
missing were led by `lib/tripCrewLocation.ts` (34 citations), `routes/trips-expansion.ts`
(28) and `compass/CompassTools.ts` (26) — the deployed coordination product. What the
scope *did* cover was the Trip Kernel programme: `tripKernel.ts`, `2760`–`2777`, the new
routes.

**So the scope watched the W rows and left the C rows unguarded** — the verdicts that say
something is *not* right were protected, and the ones asserting something *works* were
not. That is the wrong way round, and it is how citations under six BUILT-AND-CORRECT
rows drifted by 200+ lines while the document reported FRESH. The scope is now 60 paths;
the 26 added are named with their reason in `checkCensusFreshness.ts`.

### 37.5 What this section does NOT claim

- **No verdict was re-derived, and none moved.** This checked that each cited artifact
  exists and still says what the row says it says. It did not re-answer whether the row's
  BUILT-AND-CORRECT judgement was right in the first place — that is still the open work
  §36.5 describes.
- **Only the C rows' unreadable citations were opened.** The 132 range-only citations on
  W rows and the 40 on N rows were not read; they are as likely to have drifted, and the
  anchors added here do not cover them.
- **An anchor pins a line, not a meaning.** `#canEditPlan` asserts that token is on that
  line. It cannot tell that the function's behaviour changed underneath a stable name.
- **593 ambiguous-path citations remain corpus-wide**, 53 of them here. Every one is a
  citation whose resolution depends on which candidate a reader happens to open.

---

## 38. The first pass that re-derived VERDICTS, not citations

§37 read this census against the code and repaired 37 rotted citations. It ended
by saying exactly what it had not done:

> **No verdict was re-derived.** §37 checked that each cited artifact exists and
> still says what the row says — not whether the judgement was right.

This section does that, for 44 of the 89 BUILT-AND-CORRECT rows. A C row is the
one that matters most: a W row that rots stays wrong, but a C row that rots
becomes a false assurance, and nothing in this repository had ever asked whether
one was true.

**42 of the 44 held. Two did not**, and they failed the same way: a universal
claim that had never been counted. TR51 said *every* trip write parses a zod
schema first; 8 of 53 do not. TR200 said trip events pass an attention policy;
10 trip push sites never reach the router that applies one. Both moved **C → W**
— the first verdicts either §37 or §38 has moved, and both moved DOWN, which is
the direction a re-derivation has to be able to go if it means anything. The
headline is restated at the top of this document: 89 → 87 CORRECT, 127 → 129
WRONG, CONSTRUCTED unchanged at 47.9 % because both requirements are still built.

**That is the method finding, and it is worth more than either row.** 35 of the
89 C rows make a universal claim — *every*, *only*, *never*, *nothing*,
*cannot*, *always*. Those are the falsifiable ones, and both failures came from
that set. A row saying "X is handled" is hard to disprove; a row saying "EVERY X
is handled" is a count, and until this pass none of them had been counted.

### What was re-derived, and how

| rows | what was checked, by reading the object |
| --- | --- |
| TR68–TR74, TR76 | The eleven kernel rows that moved N→C in §36's recount. Every envelope column against `2420_trip_kernel_foundation.sql` DDL: `aggregate_version` NOT NULL with `CHECK (> 0)`, `CONSTRAINT trip_events_trip_sequence_unique UNIQUE (trip_id, sequence)`, `causation_id`/`correlation_id`, `schema_version NOT NULL DEFAULT 1`, `occurred_at` and `recorded_at` as distinct columns, and append-only as a **TRIGGER** (`trg_trip_events_append_only`) rather than a convention. TR70's sequence is `coalesce(max(sequence), 0) + 1`, a real sequence and not `created_at DESC`. TR74's outbox INSERT is in the same function body as the event INSERT. TR76's scheduler is **called** at `index.ts:162`, not merely imported — the distinction this repository keeps paying for. |
| TR117, TR118, TR120, TR121 | `toPrivateTripPreview` is a **whitelist**: it names its output fields and never spreads the row, so a column added to `trips` tomorrow cannot reach a non-member by default. That is a stronger fact than the test the rows cite. TR118's coordinate opt-in is strict `=== true`, not truthiness. Wiring checked too: the trip-detail route blocks first, serves the authorized view to members/owner, the stripped preview to public and mutual-buddy viewers, and a `{ locked: true }` sentinel to everyone else. |
| TR216, TR215, TR219 | `sanitizeToolResult` recurses through arrays and objects and strips coordinate-shaped and private keys at every depth. **Wiring**: `executeCompassTool`'s switch assigns every branch to `raw` and has exactly ONE exit, through the sanitiser — no branch returns around it. TR215's `isAcceptedTripMember` then `canEditPlan` are the same gates the write endpoints use; TR219's `add_to_trip` builds a proposal and issues no INSERT. |
| TR10, TR110, TR160, TR179, TR112 | The crew privacy guard, and the one defect this pass found — see below. TR112's only client INSERT policy on `trip_crew_location_sessions` scopes to `auth.uid() = user_id`. |
| TR52, TR106, TR107 | Every plan write is gated. All six plan-write endpoints checked individually. |
| TR7, TR17, TR285 | `trip_reservations` carries no payment, amount, currency or provider column — references and operational facts only; `status` defaults to `pending_confirm`, so an LLM extraction never auto-commits; `confirmation_ref` is opaque text. |
| TR32, TR94 | The crossing is single — and the ratchet that was claimed to keep it single did not exist. See below. |
| TR30, TR289, TR391 | TR30: no trip read path touches a projection, snapshot or cache table — every one assembles from source at request time, as claimed. TR289: `routes/tripReservations.ts` contains **no** provider, booking-API or payment reference at all. TR391: **stronger than the row states** — `trip_area_preferences` has no writer anywhere in `src/` outside RLS and deletion dispositions, so the path to a permanent user preference is not merely closed, it was never opened. |
| TR330, TR353 | TR330's four safe-return channels are four separate opt-in booleans on the session, as claimed. TR353's server authority holds — see the false-positive note below, which is the more useful half. |
| TR355, TR429, TR222 | `trg_trips_updated BEFORE UPDATE ON trips` exists exactly where cited, so client write time is not authoritative. `tripStatus.ts` and `tripCrewLocation.ts` contain **zero** DB references — pure as claimed, measured not asserted. No trip route imports Compass, so Trips is structurally operational without it. |
| TR331, TR332, TR414, TR37, TR381 | See the corrections below. |

### THE FIRST FINDING — the privacy guard did not check the grant it was guarding

TR110 and TR160 say exact coordinates require an **active** live-share grant.
`lib/tripCrewLocation.ts` calls itself a Privacy Guard, states that contract in
its header, accepts `now`, spends it on position freshness — and never compared
it to `liveShare.expiresAt`. The comment at the live-share branch asserted *"the
GRANT has not expired"* as a premise. `raw.liveShare != null` was the whole test.

**It was not a live leak, and the distinction is the point.**
`TripCrewLocationService` is the only caller and filters `.gt("expires_at", now)`
in SQL and gates on `allowed_member_ids.includes(viewerId)`; verified by reading
it. So the premise held — because of a WHERE clause in a different file. That is
§32.7's hazard in its exact form: the guard asserted a fact it did not establish,
and a second caller or an edit to that clause would have released coordinates
with nothing in this module objecting.

Fixed. The expiry already arrives on the grant and `now` was already a parameter,
so the check is one comparison, and it fails closed on an unparseable timestamp.
Seven tests, **five of which failed against the unfixed guard**; the two that
passed were the positive control and ghost-mode precedence, which is what stops a
suite passing for the wrong reason. Both rules mutation-tested.

### THE VERDICT THAT MOVED — TR51, "Command service validates schema"

The row read **C** on this sentence, which is its own testable half:

> every trip write parses a zod schema first

Counted across the three files it cites: **53 write endpoints, 8 of which read
`req.body` with no schema at all** — `POST /trips` (the primary create),
`/invite`, `/members`, `/join-request`, `/invite-link`, and the three checklist
writes. 45 of 53 do validate, so the capability is built and used: this is
BUILT-BUT-WRONG, not NOT-BUILT. The word *every* had never been counted.

**What the gap costs, stated precisely so it is not read as worse than it is.**
Not authorization — `requireUser` runs first on every one of these and is the
only place the ban/suspend gate is applied, and `check:route-auth-gate` guards
that independently. What was missing is TYPE validation, so a malformed payload
reached PostgREST and returned a 500 where a 400 belongs, and each endpoint's
accepted shape was written down nowhere.

`POST /trips` is now closed by `CreateTripSchema`, which mirrors `PatchTripSchema`
field for field: a client able to PATCH a field can create with it, so the schema
cannot reject a payload the API already accepted through the other door. Nine
tests, **five of which failed against the unvalidated endpoint**. The remaining
seven endpoints are held shrink-only by `check:trip-write-validation`, and TR51
returns to C when that list reaches zero.

**One gap pinned rather than closed:** `z.url()` accepts `javascript:alert(1)`,
because it is a well-formed URI. Restricting the scheme to http/https is the
right fix and belongs on `PatchTripSchema` at the same time — closing it here
alone would make create stricter than patch and leave the same value reachable
through the other door. Pinned as current behaviour in the test, so closing it is
a deliberate diff.

### THE SECOND VERDICT THAT MOVED — TR200, "Trip events must pass an attention policy"

The row read **C** because `NotificationRouter` consults
`NotificationPreferenceService`, `NotificationDeduplicationService` and
`CompassNotificationEngine.evaluateNotification` before dispatching. It does.

**Ten trip push sites never reach it.** They call `sendPushWithRetry` directly,
and that function is a pure transport wrapper — it filters malformed tokens,
retries transient Expo failures, clears dead tokens, and consults no policy at
all. Counted: 4 in `routes/trips.ts`, 5 in `routes/trips-expansion.ts`, 1 in
`lib/tripReminderScheduler.ts`.

**The bypass is deliberate**, which is why it is counted rather than patched in
passing — one site carries the comment *"notifRouter.route() is intentionally NOT
called here; push was already sent above via sendPushWithRetry to avoid
double-delivery."* Re-plumbing delivery through the router is a design change
with a hazard the code already names, and it belongs to whoever owns
notifications.

**What it costs is concrete, not theoretical.** `NotificationPreferenceService`
holds per-user channel preferences, per-category preferences and QUIET HOURS — it
computes `localMinutesOfDay` against the user's own timezone. A user who has
switched a trip category off, or who is inside their quiet hours, receives all
ten of these pushes anyway.

Held shrink-only by `check:trip-push-policy`, keyed on `file:line` rather than a
count: a bare total stays green across a substitution, where one site is fixed
and another appears. TR200 returns to C when the list reaches zero.

**TR201 was checked in the same pass and STAYS C.** Its three suppressors do not
cover these ten either, and its evidence is corrected to say so — but the
requirement it grades is that not *every* social or live-intel change becomes a
push, and the ten are discrete deliberate events, not a firehose. Trips does not
push on every plan edit, presence beat or member move. What was wrong there is
the mechanism named, which is TR200's problem, not the outcome.

### THE THIRD FINDING — a "standing ratchet" that did not exist

TR32 and TR94 both said the single place id-space crossing was **"Enforced by a
standing ratchet rather than convention"**, naming `scripts/checkSchemaReferences.ts`
as that ratchet.

Measured: it is not. `checkSchemaReferences.ts` verifies that a select-list
column exists on the table being read — the `places.country` / `country_code`
defect — and says nothing about id spaces. **No file under `src/scripts/` or
`scripts/` mentioned `placeIdBridge` at all.**

The verdict survives, and only because the crossing really was single: the one
call carrying `p_subject_type: "place"` is in `lib/placeIdBridge.ts` itself,
verified by reading every caller in the tree. So TR32 and TR94 were **true by
convention while claiming to be true by enforcement** — which is the more
dangerous of the two, because the sentence invites the reader to stop checking.

`check:place-id-bridge` now exists and is run from `check:all`, so the claim is
enforced as written. It matches the RPC ARGUMENT rather than the RPC name,
deliberately: that primitive has already been renamed once
(`memory_is_new_to_user` → `memory_are_new_to_user`) and a guard keyed on the old
name would have gone silently blind at the rename while still reporting a pass.
It carries a positive control that FAILS when the crossing appears nowhere at
all, because a pattern matching nothing looks exactly like a clean tree. Both
mutation-tested.

### Three evidence corrections, none of which moves a verdict

**TR381 said *nothing* reads `trip_activity_log` except one endpoint. There are
two.** The invite-links endpoint reads it at `:1382` to decorate each link with
its joiners. The verdict survives because both readers are trip-scoped and
neither writes the log into a durable projection — but *nothing* was a universal
claim that had never been counted. The row is corrected above.

**TR107's citation is accurate but incomplete.** `canEditPlanItem` has four call
sites (`:1878`, `:1946`, `:1995`, `:2215`); the row names two.

**TR37 cites an ambiguous basename.** Two files carry `0001_spine.sql` and
neither is in the canonical `src/migrations/` tree. Per §37's rule a basename
resolving to more than one file has not been resolved, so the claim was asserted
against **both** candidates. They agree — which is what makes TR37 safe, and the
opposite of the `0041` case where three same-named files disagreed.

### A latent shape recorded rather than fixed, because it is another lane's file

`safe_return_live_shares.expires_at` is **nullable**, and
`SafeReturnPrivacyGuard` checks expiry as `if (s.expires_at && …)` — so a row
with a NULL expiry would skip the check entirely and read as a live share with no
end. `startShare` is the only writer and always sets it, so this is not
reachable today. It is the same shape as the defect fixed above and the same fix
would close it (treat NULL as expired), but the file belongs to the Safety lane
(TR11: specialist domains retain ownership) and this lane does not cross that
boundary to harden it. Recorded here so the next Safety pass has it.

### One bounded observation, measured because it sounded worse than it is

TR37 and TR355 both rest on `0001_spine.sql`, which is NOT in the canonical
`artifacts/api-server/src/migrations/` tree the sanctioned applier manages — so
`certify:migrations` and `audit:schema` do not cover the objects those two rows
depend on (the `trips` table itself, and `trg_trips_updated`).

Counted rather than left as a worry: census-trips cites **29 distinct `.sql`
files and 27 are canonical**. The spine is the only exception, it is the
foundational file that predates the ledger, and both rows' claims were verified
against it directly. This is a note for whoever next asks why the applier's
coverage and this census's evidence are not the same set — not a defect.

### THE COUNTING METHOD HAS FALSE POSITIVES, AND THEY MUST BE OPENED

The quantifier grep is how TR51 and TR200 were caught, so it is worth stating
precisely where it misleads.

Applied to TR353 ("membership resolved server-side on every read and write"), a
per-endpoint scan for a membership or ownership gate reported **five trip-scoped
endpoints with none**, two of which mutate trip content. Every one was opened,
and **every one was a false positive**:

| endpoint | why the scan missed the gate |
| --- | --- |
| `POST …/destinations/reorder` and `…/items/reorder` | both are one-line registrations delegating to a shared `handleDestinationsReorder`, which does `requireUser` → `requireTripMember` → role check. The scan read the registration line, not the handler. |
| `DELETE …/reminders/:reminderId` | gated on `user_id !== user.id` — own-resource ownership, STRICTER than membership, and a form the pattern did not recognise. |
| `POST …/decline-invite`, `…/join-requests/:requestId/cancel` | acting on your own invitation or your own request; membership is not the right gate and its absence is correct. |

**TR353 holds.** The lesson is the one this document keeps relearning: a count is
evidence for opening a file, never a substitute for opening it. TR51 and TR200
moved because the absence was confirmed by reading the code — `sendPushWithRetry`
really does consult no policy, `POST /trips` really did destructure the body —
not because a grep said so.

### What this pass did NOT do, stated rather than implied

1. **45 of the 89 C rows are not re-derived.** They remain as §36 counted them.
2. **No W or N row was re-derived at all.** 129 W and 234 N rows stand entirely
   on earlier passes. A W row asserting something is broken could have been
   fixed since without anyone noticing — that is the cheaper error, but it is
   still an error, and it is untested here.
3. **A test pins an invariant, not a judgement.** `tripsCensusRederivation.test.ts`
   makes these 28 derivations repeatable; it does not make them complete.
4. **I wrote a test that could not fail, and the mutation caught it.** The first
   draft of the preview test listed forbidden snake_case column names while the
   serializer emits camelCase, so leaking `ownerId` passed it 13/13. Replaced
   with an exact allowed-key-set assertion. Recorded because the lesson is the
   census's own: a fixture that pins a fiction is worse than no fixture, and the
   only thing that found it was breaking the code on purpose.

---

## 39. The first pass that re-derived N rows — and the merge they were taken before

§38 closed by naming what it had not done: *"No W or N row was re-derived at
all. 129 W and 234 N rows stand entirely on earlier passes. A W row asserting
something is broken could have been fixed since without anyone noticing —
**that is the cheaper error**, but it is still an error."*

It is not the cheaper error. **Thirty-four of the 234 N rows are falsified by
code on merged `main`**, and every one of them is falsified by the *same merge*
whose commit this document declares as its `head_commit`. Thirty were found by
two mechanical routes (§39.2); the last four by a third route run after §39.6
had already said the pass was over (§39.7).

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §38 | 87 | 129 | 234 | 1 | 216 / 451 = **47.9 %** | 87 / 451 = **19.3 %** |
| after §39 routes 1–2 | 87 | **159** | **204** | 1 | **246 / 451 = 54.5 %** | 87 / 451 = **19.3 %** |
| **after §39 route 3** | **88** | **162** | **200** | 1 | **250 / 451 = 55.4 %** | **88 / 451 = 19.5 %** |

**CONSTRUCTED moves up 7.5 points and CORRECT up 0.2.** §38's two verdicts
moved DOWN; these thirty-four move UP — thirty-three into WRONG and **one, TR417,
into CORRECT, the first row any pass has moved into that bucket** (§39.7). A re-derivation that can only travel in one
direction is not a measurement, and until this pass every pass this document had
run could only travel down, because **only C rows had ever been re-read**.

### 39.1 Why an N row rots, and why nothing noticed

An N row says a thing is not built. It is falsified by the thing being built —
which is the *normal outcome of working on the product*. So N rows rot by
default, silently, and in the direction that makes the architecture look worse
than it is.

Every one of the thirty was falsified by **one squash merge: `42aeac38e`,
"Trips v4 architecture, and three days of accumulated work, onto main (#476)"**.
That merge landed migrations 2420 and 2760–2777, `lib/tripKernel.ts`,
`services/trips/TripFeasibilityEngine.ts`, `routes/tripStructure.ts`,
`routes/tripFeasibility.ts`, `routes/tripDecisions.ts`, `routes/tripCommands.ts`
and `lib/tripDiscoveryProjection.ts`. §26–§35.1 of this document were appended
**at that commit** and §29.4 moved fifteen rows — so the pass that knew about
the merge re-graded a *subset* and stopped. §57 is the proof it was row-by-row
rather than a sweep: TR57 was moved N→C by the very plpgsql function that also
falsifies TR50 and half of TR58–TR66, and those were left standing.

### 39.2 How the thirty were found — two mechanical routes, then a file opened per row

Neither route is a verdict. Each is a reason to open a file, and every row below
was graded from the file, not from the count. The TR353 rule from §38 holds:
*a count is evidence for opening a file, never a substitute for opening it.*

**Route 1 — the code cites the row it falsifies.** 65 distinct `TR\d+` ids are
cited from non-`docs/` files, measured at `a86fe8796` — the tree as it stood
before this section existed. **Re-run today it reports 73**, because this
section's own guard and its test cite eight more as examples. Every count in
§39.2 and §39.7 is stated against `a86fe8796` for that reason: a measurement a
document takes of a tree it is part of moves when the document does. Sixteen of them are scored **N** by this document.
`services/trips/TripFeasibilityEngine.ts:8` is the clearest case and it says so
in its own header: *"census-trips TR128 records that this 'is not computed
anywhere' and TR134 that the §7.4 travel-feasibility check is absent. **This file
is that computation.**"* Six of the sixteen are false leads —
`checkCensusIntegrity.ts` cites TR38/TR45/TR58/TR62/TR64/TR66 as *parser
examples*, and `routes/tripMapProjection.ts:330` cites TR252/TR253 to confirm
they are absent.

**Route 2 — the row names an object it says does not exist.** 46 N rows name a
backticked identifier in the absence position (`` `trip_outcomes` `` — "Does not
exist."; `` `TripGoal` `` — "No goal table, type or column anywhere"). Grepping
each outside `docs/` found twelve with hits. Route 2 catches what Route 1 misses:
TR14/TR15/TR20/TR21/TR22/TR26/TR27/TR28 name no row id in any source file.

### 39.3 THE STRUCTURAL FINDING — §29.4's labelled ids went off by one, and a requirement fell through the gap

`| TR89 `trip_snapshots` | N | **W** | … |` — that row is in §29.4, and **TR89
is `trip_events`**. The body's §5.1 table reads TR89 `trip_events`, TR90
`trip_snapshots`, TR91 `trip_outcomes`. §29.4's last two move rows read TR89
`trip_snapshots` and TR90 `trip_outcomes`. From TR89 onward the label and the id
name different objects, and the author's list ran out one row early.

Three consequences, each different:

| row | what §29.4 did | what it cost |
| --- | --- | --- |
| TR89 `trip_events` | recorded as moving N→**W** | Nothing numerically — TR89 was **already W**. But its "was" column is wrong, and the evidence attached to it (*"2773 fold/replay/verify; served by `tripCommands.ts`"*) describes `trip_snapshots`. |
| TR90 `trip_snapshots` | moved N→**W** with `trip_outcomes`' evidence | Nothing numerically — W is right for `trip_snapshots` too. Accidentally correct. |
| **TR91 `trip_outcomes`** | **nothing** | **A requirement stayed N with the evidence "Does not exist." while `CREATE TABLE public.trip_outcomes` sits at `2763_trip_presence_proposals_snapshots_outcomes.sql:124` on `main`.** |

**The mislabelling propagated into the code.**
`2768_trip_kernel_presence_proposal_outcome_families.sql:7` carries the comment
`RECORD_OUTCOME -> trip_outcomes (TR90)`. It is citing the census's own
off-by-one back at it. Two documents now agreed on a wrong id, which is how a
wrong id survives review.

**Measured corpus-wide, and it is precise rather than fuzzy.** A labelled id is
only suspicious when its label is the body identifier of a **different row in
the same census**. Five labelled ids in the corpus name an identifier the body
does not; three are legitimate refinements (census-media MD36 `media_assets` for
`MediaAsset`, census-trips TR12 `version` on the `Trip` aggregate, census-trust
C13 `gps_coordinate_jump` under `applyEventCaps`) and **two are this defect** —
TR89 and TR90, consecutive, exactly as an off-by-one looks.
`check:census-row-move-labels` (new, registered, in `check:all`) enforces the
precise form: **zero false positives on the corpus today, and it goes red on
either half of the TR89/TR90 pair restored.**

### 39.4 The thirty rows

Verdicts are **W**, not C, for the reason §29.5 already fixed for their
siblings: merged is not deployed. `checkProductionDrift.ts:135` classifies
`trip_outcomes` "unapplied — in portava-ci, absent from production", and
`trip_kernel_enabled` is seeded **FALSE** (`2420_trip_kernel_foundation.sql:190`).
Every row below is built, reachable and tested; none of it is realized.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR1 `Trip Kernel` | N | **W** | *"There is no kernel."* There is: `lib/tripKernel.ts` (709 lines, 36 command types), `public.trip_kernel_execute` (`2420_trip_kernel_foundation.sql`), `routes/tripCommands.ts` registered at `routes/index.ts:158`. The **invariant** is still unmet and that is why it is not C: `tripKernelWriterBaseline.ts:31-33` measures **47 direct writes in 18 files — 41 kernel-gated, 5 declared non-aggregate, 1 ungated** — and the flag is off, so every direct count is live. |
| TR6 `history` | N | **W** | Four of the five named absences are now built: events (`2420:419` `INSERT INTO public.trip_events`), snapshots (`2763:108`), replay (`2773_trip_snapshot_fold_and_replay.sql`), outcomes (`2763:124`). The fifth — a decision ledger — is genuinely absent, and TR401 still says so. |
| TR14 `TripLeg` | N | **W** | *"No leg concept."* `trip_legs` (`2761_trip_legs_and_commitments.sql:60`), writer `2765_trip_kernel_leg_and_commitment_families.sql:118`, read at `routes/tripStructure.ts:109`. |
| TR15 `Commitment` | N | **W** | Falsified in its own words four times. The row says `trip_plan_items` has *"no `required_arrival_at`, `flexibility`, `prep_duration` or `lateness_tolerance`"* — `trip_commitments` has all four, at `2761:101`, `:110`, `:107`, `:106`, plus the `confidence` TR127 measures at `:113`. |
| TR20 `TripGoal` | N | **W** | *"No goal table, type or column anywhere."* `trip_goals` (`2762_trip_goals_decisions_risks.sql:45`), writer `2766:114`. |
| TR21 `TripDecisionTask` | N | **W** | *"No decision-task table or type."* `trip_decision_tasks` (`2762:64`), writer `2766:181`. |
| TR22 `TripRisk` | N | **W** | *"No risk table or type."* `trip_risks` (`2762:84`), writer `2766:249`. |
| TR24 `TripCrew` | N | **N** | **Holds.** `Subgroup` has zero occurrences outside `docs/`. Listed here because it is the one §3.1 type the merge did not build, and an unmoved row beside twenty-nine moved ones is a claim too. |
| TR26 `TripProposal` | N | **W** | *"No proposal table or governance type."* `trip_proposals` (`2763:86`), writer `2768:208`, and the governance the row names by name: `2774_trip_proposal_governance.sql` with `trip_proposal_votes` (`:88`) and its writer `2775:198`. |
| TR27 `TripSnapshot` | N | **W** | *"No snapshot table or type."* `trip_snapshots` (`2763:108`), writer `2773:411`. |
| TR28 `TripOutcome` | N | **W** | *"No outcome table or type."* `trip_outcomes` (`2763:124`), writer `2768:288` (`RECORD_OUTCOME`). |
| TR29 `version` | N | **W** | *"No version exists (TR12), so no invariant can be expressed against one."* `trips.version` is `2420:96` — `ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0`, **and it is in production**, since production carries 2420. An invariant IS expressed against it: `trip_proposals.affected_version` (`2763:93`) is the version a proposal was computed against, *"so a stale proposal is detectable rather than silently applied"*. |
| TR50 `command vocabulary` | N | **W** | *"None of the eleven exists as a command."* **Ten of the eleven do**, in the kernel's own union: ADD_PLAN, MOVE_PLAN, CONFIRM_PLAN, CANCEL_PLAN, JOIN_PLAN, LEAVE_PLAN, SET_PRESENCE, CREATE_PROPOSAL, ACCEPT_PROPOSAL, COMPLETE_ACTIVITY. Only `CREATE_SUBGROUP` is absent — consistent with TR24, which is why TR24 stays N. |
| TR58, TR59, TR60, TR64 | N | **W** ×4 | *"None is emitted anywhere."* Four of the eight are: `trip.plan_added` (`2420:312`), `trip.plan_moved` and `trip.plan_confirmed` (`2420:352-353`), `trip.proposal_accepted` (`2768:248`). These are `v_event_type :=` assignments inside `trip_kernel_execute`, written to `public.trip_events` in the same transaction (`2420:419`) — the same function §4 already credited at TR57. |
| TR61, TR62, TR65, TR66 | N | **N** ×4 | **Hold.** `commitment_at_risk`, `free_window_created`, `stage_started` and `trip_disrupted` have zero occurrences outside `docs/`. The row scored eight ids as one; four of them were right. |
| TR91 `trip_outcomes` | N | **W** | `CREATE TABLE public.trip_outcomes` at `2763:124`; writer `2768:288`; **read** at `routes/tripStructure.ts:118`; asserted live at `tripKernelLive.test.ts:305`. This is the row §29.4 missed — see §39.3. |
| TR122 `Commitment` contract | N | **W** | *"No commitment type or table (TR15)."* `trip_commitments` (`2761:92`) with a typed vocabulary (`CHECK (type IN ('lodging','transport','event','booking','meeting','other'))`) and a flexibility vocabulary (`:110`). |
| TR124 `latenessTolerance` | N | **W** | *"Absent."* `lateness_tolerance interval` (`2761:106`), served at `routes/tripStructure.ts:197`, and **used**: `TripFeasibilityEngine.ts:207` computes the deadline as `deadlineBase + latenessToleranceMinutes * MS_PER_MIN`. |
| TR125 `prepDuration` | N | **W** | *"Absent."* `prep_duration interval` (`2761:107`), served at `routes/tripStructure.ts:197`. |
| TR128 `core invariant` | N | **W** | *"Not computed anywhere."* `services/trips/TripFeasibilityEngine.ts` is that computation and names this row in its header. Not C for the reason the file states before anything else: **there is no routing provider in this repository**, so a straight-line lower bound can prove INFEASIBLE soundly but can never return FEASIBLE — only FEASIBLE_UNVERIFIED. |
| TR134 `§7.4 feasibility check` | N | **W** | *"Absent (TR128)."* `GET /trips/:tripId/feasibility` (`routes/tripFeasibility.ts`), registered at `routes/index.ts:153`, with `tripFeasibilityRoute.test.ts` and `tripFeasibilityRouteBehaviour.test.ts`. |
| TR138 `TripGoal` contract | N | **W** | *"No goal table, type or column (TR20)."* `trip_goals` carries four of the contract's five fields — `type`, `priority`, `status`, `evidence_json` (`2762:45-51`). **`scope` is genuinely missing**, which is why it is W and not C. |
| TR153 `TripProposal` contract | N | **W** | *"No proposal table or type (TR26)."* `trip_proposals` carries `proposal_type`, `status`, `expires_at` and `affected_version` as columns (`2763:86-93`). `proposedBy`, `affectedObjects`, `rationale`, `impactSummary` and `decisionRule` are **not columns** — they would have to live in `payload_json`, which is a shape the contract does not specify. W, not C. |
| TR362 `TripMemoryProjection` | N | **W** | *"Nothing projects a trip into Memory."* `services/memoryProjections/projectionRegistry.ts:314` — id `TripMemoryProjection`, audience `TRIP_RECAP`, destination `trip.recap`, `availability: "BUILDABLE"`, scoped by `trip_id`. It points the **other way** (Memory→trip recap, not trip→Memory), which is precisely the grading this document already gave TR363 for the Passport. W for the same reason, stated the same way. |
| TR364 `generatedAt` | N | **W** | *"None does."* `lib/tripDiscoveryProjection.ts:102`. **One of nine**, which is exactly why it is W: the requirement says *every* projection, and the §19 list TR356–TR363 still carries none. The count is stated because §38's finding was that a universal claim nobody counted is where these break. |
| TR365 `sourceTripVersion` | N | **W** | *"No version exists (TR12)."* Falsified twice — `trips.version` (`2420:96`) and the projection field itself (`tripDiscoveryProjection.ts:104`). |
| TR366 `projectionSchemaVersion` | N | **W** | *"Absent."* `lib/tripDiscoveryProjection.ts:100`, with a consumer that rejects on mismatch (`lib/discoveryTripProjectionConsumer.ts:288`). |
| TR367 `freshness` | N | **W** | *"Absent."* `lib/tripDiscoveryProjection.ts:105`, typed `TripDiscoveryFreshness` with one honest value — `"live"`, documented as *"No other value exists yet (no projection worker)"*. |
| TR405 `TripSnapshot` contract | N | **W** | *"No snapshot table or type (TR27). `trip_readiness_snapshots` … with none of the contract's fields."* `trip_snapshots` (`2763:108`) carries `aggregate_version`, `snapshot_json` and `engine_versions_json`, and is UNIQUE per `(trip_id, aggregate_version)` — the constraint §22.4's determinism guarantee needs. |

### 39.5 Evidence corrections that move no verdict

Recorded because §37's rule holds: a row can be right for a reason that has
stopped being true, and the next reader trusts the reason.

1. **TR12 `Trip`** (W) says the trips table *"carries **no `version` column**, so
   it is a row, not an aggregate root"*. It carries one — `2420:96` — and the
   column is in production. The verdict stays W: a version column that the
   kernel bumps only when a flag seeded FALSE is on is not yet an aggregate root.
2. **TR89 `trip_events`** (W) says *"`trip_activity_log` is the nearest deployed
   table"*. `public.trip_events` exists and the kernel writes it (`2420:419`).
   The verdict stays W — `trip_activity_log` is still what the *route* layer
   writes — but "nearest table" is no longer true.
3. **TR334** (N) says `grep -rli "offlineBundle|offline.*queue|queuedOperation"`
   over the client returns *nothing*. It returns `travel-buddy-standalone/src/services/layover.ts:355`
   and four more — the **Layover** offline bundle. The verdict holds (there is
   no *trip* bundle, signed or otherwise); the grep as written does not.
4. **TR213 `explainTripDecision`** (N) holds, and so does its reason — there is
   no decision ledger. Checked because TR401 was checked: `trip_decision_tasks`
   (`2762:64`) is a work-item table, not `TripDecision`, and no `trip_decisions`
   table exists anywhere in the migration set.

### 39.6 What this pass did NOT do

1. **204 N rows remain un-re-derived.** Thirty were checked because two
   mechanical routes pointed at them. The other 204 were not looked at, and the
   §39.1 argument — N rows rot in the direction of being built — applies to them
   exactly as much.
2. **No W row was re-derived.** 159 W rows now stand entirely on earlier passes,
   thirty of them placed there by this section on evidence of *existence*, not
   on a re-reading of what §38 would call the judgement.
3. **Route 2 is a grep and greps lie in both directions.** It found twelve
   candidates and four of them (`partySize`, `sourceClass`, `confidence`,
   `freshness` as bare tokens) matched code in other domains entirely.
   TR286/TR287 stay N because `TransportSegment` has zero occurrences — the
   object those fields belong to does not exist, so its fields cannot.
4. **CORRECT% does not move on routes 1–2 and nothing there argues it should.**
   Thirty rows moved from "not built" to "built and wrong". Not one of them was
   shown to work, and `trip_kernel_enabled` is still FALSE. §39.7 is the one
   exception and it is argued separately.
5. **Two of this section's own citations were off by one line, and only a
   re-read caught them.** `sourceTripVersion` and `freshness` were written as
   `tripDiscoveryProjection.ts:103` and `:104`; they are at `:104` and `:105`,
   because a doc comment sits between them. `check:doc-citations` was GREEN on
   both — they stayed inside the file's range — which is exactly the §37 finding
   reproducing itself inside the section that cites §37. Corrected by checking
   every `file:line` in this section against the line it names, one at a time.

### 39.7 A third route, run after §39.6 was written — and it moves CORRECT

§39.6 item 1 said 204 N rows were never looked at. A third mechanical route was
run against them before this section was pushed, and it found four more. **The
paragraph above is left standing rather than edited**, because "I stopped
looking and then looked again and found more" is the honest shape of this and
editing it away would hide the rate.

**Route 3 — the row claims an endpoint is not registered.** **Eleven** N rows at
`a86fe8796` match "Not registered", "no … endpoint" or "no such route".
`routes/index.ts` registers five trip routers added by the same merge
(`:153-158`), and their paths are a five-line grep.

**Seven of the eleven are genuine endpoint claims and four are regex noise — and
two of the four moved anyway.** TR361 and TR14 matched on the words "endpoints"
and "event" and are not endpoint claims at all. **TR417 and TR435 matched on
"endpoint" in passing, were opened for that reason, and are two of this route's
four findings** — including the only row this pass moves into CORRECT. A
deliberately loose pattern found what a precise one would have filtered out,
which is an argument for opening the false positives rather than tightening the
grep.

| id | was | now | why |
|---|---|---|---|
| TR374 `commands` | N | **W** | *"Not registered, and no command exists to post (TR49)."* `router.post("/trips/:tripId/commands")` at `routes/tripCommands.ts:119`, registered at `routes/index.ts:158`, behind `requireUser`, refusing a body that names its own actor. The second clause was already contradicted inside this document: **TR49 has been C since §26**, and it is the envelope this endpoint posts. |
| TR377 `snapshots` | N | **W** | *"Not registered; no snapshots, no versions."* `router.get("/trips/:tripId/snapshots/:version")` at `routes/tripCommands.ts:252`, accepting `latest` or a non-negative integer. Snapshots are `trip_snapshots` (`2763:108`) and versions are `trips.version` (`2420:96`). All three clauses false. |
| TR435 `§24 Phase 1 ratchet` | N | **W** | *"No ratchet, no enumeration, no reduction."* All three, in one file that names §24 Phase 1 in its first line: `scripts/tripKernelWriterBaseline.ts` enumerates **47 direct writes in 18 files**, `checkTripKernelWriters.ts` fails on a file not listed or a count that grows, and it is in `check:all`. The reduction is recorded in the baseline's own header: **8 ungated → 1**. W not C for that last one, and because the flag is off, so every legacy path is still live. |
| **TR417** `§22.4 idempotency` | N | **C** | *"No idempotency key anywhere in the trip domain."* `trip_command_receipts` (`2420:139`) is `PRIMARY KEY (trip_id, idempotency_key)` and its own COMMENT states the requirement verbatim: *"A second command with the same key returns this row and performs no transition (Trips spec §22.4)."* |

#### TR417 is the first row any pass has moved INTO correct, and the reason is a live test, not a schema read

`tripKernelLive.test.ts:325-342` runs against portava-ci and asserts the load-bearing
half, which a shape test cannot reach: replaying `JOIN_PLAN`'s key returns
`duplicate: true` **at the original version** — *"`duplicate: true` with a new
version would mean the command ran again and the receipt was written afterwards"* —
and a second read proves `trip_plan_participants` still holds exactly one row.
That is the requirement's own words: a duplicate command cannot produce a
duplicate state transition.

**C is this document's own precedent, not a new standard.** §26 moved **TR49**
(the `TripCommand` envelope) and **TR57** (canonical state and event in one
transaction) to C with the flag in the same position. TR417 is TR57's sibling:
a kernel behaviour, proven live, on merged code.

**What C does NOT say here**, since §29.5's chain still applies to everything
after MERGED: `trip_kernel_enabled` is seeded **FALSE**, so in production no
command is issued and the guarantee protects nothing there. It is proven in
portava-ci. A reader quoting 19.5 % must carry that sentence with it.

#### The count after all three routes

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §38 | 87 | 129 | 234 | 1 | 216 / 451 = **47.9 %** | 87 / 451 = **19.3 %** |
| after §39 routes 1–2 | 87 | 159 | 204 | 1 | 246 / 451 = **54.5 %** | 87 / 451 = **19.3 %** |
| **after §39 route 3** | **88** | **162** | **200** | 1 | **250 / 451 = 55.4 %** | **88 / 451 = 19.5 %** |

**Thirty-four N rows falsified, by three routes, in one pass over one census.**
Six N rows were checked and **held** and are named beside them (TR24, TR61/62/65/66,
TR286/287, TR369, TR370, TR375, TR376, TR401, TR213, TR131, TR180, TR18, TR211,
TR212, TR252/253, TR334), because an unmoved row that was actually looked at is a
different claim from one that was not.

**Route 3's false-lead rate is the highest of the three and its yield is not.**
Seven of eleven candidates held — `/context`, `/today`, `/simulate` and
`/decisions/:id/explain` are genuinely not among the registered paths (checked
against `routes/index.ts`, not assumed), TR180's `TripTodayProjection` still
greps to nothing, and TR361 and TR14 were never endpoint claims. Four moved,
**two of them found only because the pattern was loose enough to be wrong.**

---

## 40. Building toward the ceiling — one cluster at a time, graded as it lands

§39 left Trips at **88 C / 162 W / 200 N / 1 X — 55.4 % constructed, 19.5 %
correct**. The owner then asked for construction and correctness to be brought
to 100. This section is that work, and it opens by stating where the ceiling
is, because a number that omits it is the kind of number this document exists
to refuse.

**The ceiling.** Per §29.5 and the standing directive this repository carries,
"100 %" as a claim about the SYSTEM requires PRODUCTION-MIGRATED,
PRODUCTION-CERTIFIED and ENABLED — owner actions no engineering pass can take.
What a pass CAN do is drive every row through BUILT → WIRED → REACHABLE →
TESTED → MERGE-READY, and grade it **C** on this document's own precedent
(TR106/TR107: a named function, tested, called from a route; TR49/TR57/TR417:
a kernel behaviour proven live against portava-ci). That is the bar every move
below is held to, and the production caveat travels with every percentage.

**The method, per cluster.** Verify the rows against the code FIRST (§39 showed
the document rots), build only the genuine gap, see the tests red before
green, mutation-test any guard, then move the rows with `file:line` evidence.
Rows that were looked at and held are named beside the ones that moved.

### 40.1 §6.1 policy functions and Appendix B reason codes

**What was measured.** TR101–TR111 found every §6.1 BEHAVIOUR present and two
of nine NAMED (`canEditPlan`, `canEditPlanItem`). The other seven were inline:
`owner_id !== user.id` in seven places, `["owner", "co_host"].includes(role)` in
thirty-eight, a visibility ladder written out inside `GET /trips/:tripId`, a
delete rule inside the reservations route. TR441–TR451 found the kernel
emitting four Appendix B families and every other refusal in the domain
reaching the client as a bare `forbidden` / `not_found`.

**What was built.**

- `lib/tripPolicy.ts` — all nine §6.1 names: `canViewTrip` (`:138`, the
  whole §6.3 ladder — block first, then crew/owner, then public / buddies /
  private), `canInviteParticipant` (`:185`, owner — the kernel's
  INVITE_PARTICIPANT capability), `canManageJoinRequests` (`:199`, host —
  owner or accepted co_host, as 2500 defines `host`), `canEditTrip` (`:215`),
  `canCreatePlan` / `canModifyPlan` (`:233`, `:244` — the two that existed,
  under the spec's names), `canManageBooking` (`:273`, crew reads and edits;
  delete is creator or owner), `canSeePresence` (re-exported at `:294` from
  `lib/tripPresencePolicy.ts:39`, PURE, so `buildCrewCard` can call it for its
  own fork without an import cycle), `canManageSafety` (`:310`) and
  `canSeePreciseLocation` (`:328`, delegating to the graded-C resolver).
  Unreadable inputs THROW `TripAccessUnavailableError`; no policy answers "no"
  on a failed read.
- `lib/tripReasonCodes.ts` — the ONE Appendix B vocabulary: eleven families
  (`:43`), every code (`:55`), the kernel's non-Appendix-B reasons listed as
  extensions rather than misfiled (`:122`), `INTERNAL_ONLY_REASONS` (`:160`) and
  `sendTripRefusal` (`:169`), which THROWS on an internal-only reason.
  `sendError` gains an optional `reason` (`lib/http.ts:172`) — every existing
  envelope byte-identical.
- **Eight call sites converted:** `routes/trips.ts:874` (PATCH → `canEditTrip`),
  `:1180` and `:2114` (invite, add member → `canInviteParticipant`);
  `routes/trips-expansion.ts:1023`, `:1149` (approve/decline join request →
  `canManageJoinRequests`), `:3219` (`GET /trips/:tripId` → `canViewTrip`,
  with the locked sentinel now carrying the reason at `:3255`);
  `routes/tripReservations.ts:95` (gate) and `:497` (delete →
  `canManageBooking`); `routes/safeReturn.ts:306` (session create →
  `canManageSafety`); `lib/tripCrewLocation.ts:170` (`buildCrewCard` →
  `canSeePresence`).
- `scripts/checkTripPolicyCallsites.ts` — the ratchet. Measured with its OWN
  file set against the pre-conversion tree: **47 inline owner/host checks, 38
  after** (`BASELINE` at `:72`; a hand survey had said 46 and had not looked at
  `tripBudgetIntel.ts`, which the check found). Per-file counts may only
  shrink; a §6.1 function with no caller outside the module fails the build
  (`:85`). Seen red both ways: an inline check appended to a route, and a call
  site renamed away.

**A gap this closed, found by reading the route it converted.**
`POST /me/safe-return/sessions` wrote `trip_id` from the request body with **no
membership check** — any signed-in user could attach a Safe Return session,
and its `notify_trip_crew_enabled`, to any trip id. `canManageSafety` refuses
it `TRIP_AUTH_NOT_CREW` (`routes/safeReturn.ts:306`). Recorded under TR111.

**Tests.** `tripPolicy.test.ts` is the §6.2 matrix — anonymous, non-member,
removed, invited, viewer (the schema's nearest to "guest": crew, read-only),
member, co_host (host), owner, blocked, and service-facing (an UNRESTRICTED
fake client that can read every row, asked on behalf of a non-member, must
still refuse — `:353`) — 41 cases, 79 assertions-as-tests.
`tripReasonCodes.test.ts` (11) scans `.ts` AND `.sql` for emissions and found,
on its first run, a second vocabulary nobody had declared:
`TRIP_SNAPSHOT_NOT_FOUND` / `TRIP_SNAPSHOT_NO_EVENTS` from 2773 (now at
`tripReasonCodes.ts:138`). **491/491** across every route test that pins the
converted behaviour.

#### Row moves

Reason-code families are graded on **emission** — a live refusal puts the code
on the wire — not on declaration. `tripReasonCodes.test.ts` prints which
declared codes nothing emits; that list is what keeps "declared" from being
mistaken for "built".

| id | was | now | why |
|---|---|---|---|
| TR101 `capabilities derive from role + trip policy + plan membership + privacy scope` | W | **C** | All four inputs, by name: `canViewTrip` combines role with **privacy scope** (`visibility`); `canCreatePlan` combines role with **trip policy** (`plan_edit_permission` + `plan_editors`); `canModifyPlan` and `canManageBooking("delete")` combine role with **plan/row membership** (creator). |
| TR102 `application code calls policy functions rather than scattering host checks` | W | **W** | **Holds W, and now says by how much.** Nine functions exist and eight sites call them; **38 inline copies remain** in three route files, down from 47, under a ratchet that fails on growth (`checkTripPolicyCallsites.ts:72`). "Rather than" is not yet true — it is true at 8 of 46 sites, and the number is now measured every build instead of once. |
| TR103 `canViewTrip(actor, trip)` | W | **C** | `lib/tripPolicy.ts:138`; called from `GET /trips/:tripId` (`routes/trips-expansion.ts:3219`); `tripPrivacy.test.ts` pins every outcome through the route and the matrix pins the rule. |
| TR104 `canInviteParticipant(actor, trip)` | W | **C** | `:185`; called at `routes/trips.ts:1180` and `:2114`. Owner only — the kernel's INVITE_PARTICIPANT capability — with `canManageJoinRequests` (`:199`) kept apart for the host rule, because the kernel keeps them apart. |
| TR105 `canEditTrip(actor, trip)` | W | **C** | `:215`; called at `routes/trips.ts:874`. |
| TR108 `canManageBooking(actor, trip)` | W | **C** | `:273`; the crew gate at `routes/tripReservations.ts:95` and the stricter delete rule at `:497`, which had been a route-local comparison. |
| TR109 `canSeePresence(actor, subject, trip)` | W | **C** | `lib/tripPresencePolicy.ts:39` — a PREDICATE, not a card: ghost wins, an active (checked, unexpired, fail-closed on unparseable) live-share grant overrides a hidden default, else the default decides. `buildCrewCard` calls it for its fork (`lib/tripCrewLocation.ts:170`), so card and predicate cannot disagree; 46 crew-card tests unchanged and green. |
| TR111 `canManageSafety(actor, trip)` | W | **C** | `:310`; called at `routes/safeReturn.ts:306`. Its first live effect is the gap above: a session can no longer be attached to a trip its owner is not on. |
| TR115 `negative assertions for anonymous, non-member, removed member, guest, host, service-facing` | W | **C** | All six in one matrix (`tripPolicy.test.ts`), per capability. "Guest" has no row in `member_role`; the nearest is `viewer` (crew, read-only) and it is tested as such, stated rather than assumed. Service-facing at `:353`. |
| TR441 `TRIP_AUTH_*` | W | **C** | Emitted by the kernel (SQL, 2420–2500) AND by every converted route through `sendTripRefusal` — `TRIP_AUTH_NOT_OWNER`, `TRIP_AUTH_NOT_HOST`, `TRIP_AUTH_NOT_CREW` on the wire with the `forbidden` envelope. `TRIP_AUTH_BLOCKED` is internal-only and `sendTripRefusal` throws rather than leak it (`tripReasonCodes.ts:160`, `:169`). |
| TR442 `TRIP_VERSION_*` | N | **C** | *"No versioning (TR12)."* Falsified since 2420: `TRIP_VERSION_CONFLICT` is emitted by `trip_kernel_execute`, mapped to 409 with `currentVersion`/`expectedVersion` (`lib/tripKernel.ts` `sendKernelRejection`), and **proven live** — `tripKernelLive.test.ts` "§22 concurrency: a stale expectedTripVersion is refused TRIP_VERSION_CONFLICT". The §39 pattern, one more time. |
| TR443 `TRIP_TEMPORAL_*` | N | **W** | `TRIP_TEMPORAL_RANGE_INVERTED` is emitted (kernel SQL and `lib/tripKernel.ts`). `_CONFLICT`, `_INFEASIBLE`, `_UNKNOWN` are declared and nothing emits them until §7's engine (§40.3). One of four: W. |
| TR444 `TRIP_SPATIAL_*` | N | **N** | **Holds.** Four codes declared; `routes/tripFeasibility.ts`'s §7.4 findings are served as `consistency` entries without a reason code. Nothing emits. |
| TR445 `TRIP_PRIVACY_*` | N | **C** | `TRIP_PRIVACY_NOT_VISIBLE` / `TRIP_PRIVACY_BUDDIES_ONLY` on the locked sentinel (`routes/trips-expansion.ts:3255`) — the first time a privacy refusal has said which rule refused. Route-tested (`tripPrivacy.test.ts`) and matrix-tested. |
| TR446 `TRIP_PRESENCE_*` | N | **W** | *"Presence refusals return a status label, not a reason code."* Half false already: `TRIP_PRESENCE_NOT_SELF` / `_NOT_FOUND` are emitted by 2768. `_GHOST` / `_HIDDEN` are now DECIDED by `canSeePresence` and consumed by `buildCrewCard` — but the crew card still renders a label, not the reason, so they do not reach the wire. W. |
| TR447 `TRIP_BOOKING_*` | N | **C** | `TRIP_BOOKING_NOT_MEMBER` at `routes/tripReservations.ts:95`, `TRIP_BOOKING_NOT_CREATOR_OR_OWNER` at `:497`, through `sendTripRefusal`. `tripReservations.test.ts`'s 403 cases pass unchanged against them. |
| TR448 `TRIP_DISRUPTION_*` | N | **N** | **Holds.** Declared; no disruption model emits (§17.2 is §40's later work). |
| TR449 `TRIP_PROJECTION_*` | N | **W** | *"No projections (§19.1)."* Falsified since 42aeac38: `TRIP_PROJECTION_UNAVAILABLE` is emitted by `lib/tripDiscoveryProjection.ts:240`. One projection, one code; `_STALE` / `_SCHEMA_MISMATCH` / `_VERSION_AHEAD` declared for §40.2. W. |
| TR450 `TRIP_IDENTITY_*` | N | **W** | *"...build-time ratchets ... rather than returning a runtime reason code."* `TRIP_IDENTITY_ALREADY_EXISTS` IS a runtime reason: emitted by 2450's CREATE_TRIP and mapped to 409. Not C: CREATE_TRIP carries the open `TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT` finding (§35), so the family's one emitter is not one this document calls proven. |
| TR451 `TRIP_OFFLINE_*` | N | **N** | **Holds.** Declared; no offline path exists. |

**Rows looked at that did not move:** TR106, TR107, TR110 (already C; the spec
names now resolve to them from one module), TR112–TR114 (unchanged), TR116
(§6.3 scopes — unchanged; the ladder is now a function but the scope
vocabulary is still `visibility`'s).

#### The count after §40.1

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §39 | 88 | 162 | 200 | 1 | 250 / 451 = **55.4 %** | 88 / 451 = **19.5 %** |
| **after §40.1** | **100** | **157** | **193** | 1 | **257 / 451 = 57.0 %** | **100 / 451 = 22.2 %** |

Twelve rows into C (nine from W, three from N), four from N to W, four held.
Nothing here is deployed; `trip_kernel_enabled` is still seeded FALSE.

### 40.2 §19.1 projection envelope and §19.2 read endpoints

**What was measured.** §39 found the four §19.1 envelope fields on ONE
projection (`lib/tripDiscoveryProjection.ts`) and two of them on the §14.1 map
projection, and the eight-projection list TR356–TR363 carrying none. Of §19.2's
five read paths, `/map` and `/timeline` and `/crew` resolved to older endpoints
under other paths (TR371–TR373 W), `/context` and `/today` to nothing (TR369,
TR370 N). Compass read the plan raw and ignored the read's error (TR360, TR202).
No consumer anywhere rejected a projection for staleness, because nothing
carried a freshness (TR368). No metric measured read-model lag (TR394).

**What was built.**

- `services/trips/TripProjectionEnvelope.ts` — the ONE envelope
  (`:60#TripProjectionEnvelope`): `projectionSchemaVersion`,
  `generatedAt`, `sourceTripVersion`, `freshness`. `liveEnvelope`
  (`:70#liveEnvelope`) is `"live"` when the version is known and
  `"unattributable"` when it is not — never `0`, never `"live"` on a null.
  `readTripVersion` (`:85#readTripVersion`) reads `trips.version`
  BEFORE the rows, the order `routes/tripMapProjection.ts` established.
  `acceptTripProjection` (`:138#acceptTripProjection`) is the
  §19.1 consumer rule, three refusals in the only order a consumer can evaluate
  them: `TRIP_PROJECTION_SCHEMA_MISMATCH` (`:146`), §22.4's
  `TRIP_PROJECTION_VERSION_AHEAD` (`:158`), `TRIP_PROJECTION_STALE`
  (`:165`). On acceptance it observes `projection_lag_seconds`
  (`:174#projection_lag_seconds`) — at the consumer, because a producer
  measuring its own lag reads zero and measures nothing. Four freshness values
  are declared (`:56#TRIP_PROJECTION_FRESHNESS`); **two are emitted**
  (`live`, `unattributable`); `cached` and `stale` have no producer (§19.4,
  TR379) and the file says so.
- `lib/tripMetrics.ts` — the in-process registry (`:50#observeTripMetric`,
  `:69#readTripMetric`). The kernel's `trip_command_rejected_total`
  predates it and keeps its own counter; nothing in the kernel moved.
- `services/trips/TripTimelineProjection.ts:83#buildTripTimeline` —
  PURE; one day per calendar date of the trip, empty or not, then out-of-range
  days that carry items, `undated` stated rather than dropped, UTC labels so two
  servers group alike.
- `services/trips/TripSafetyProjection.ts` — §17.4 as a projection:
  `operationalState` (`:101#operationalState`: active→RETURNING,
  escalated or missed→NEEDS_HELP, safe→ARRIVED for 24 h, pending/cancelled→none)
  and `projectTripSafety` (`:127#projectTripSafety`), which shows a
  member's state to another member only when opted in
  (`:142#optedIn` — `share_safe_return_status` or the session's
  `notify_trip_crew_enabled`), counts the withheld rather than hiding them,
  and carries NO location field — the test asserts the key set.
- `services/trips/TripCompassProjection.ts:75#buildTripCompassProjection` —
  the trip row and its version from ONE read (`:73#TRIP_COLUMNS`),
  a three-valued `planItems` layer (`ok` / `unread`, reusing §14.1's `Layer`),
  and `planItemsTruncated` said rather than guessed (cap + 1 rows are read).
- `routes/tripProjections.ts` — §19.2's paths: `/timeline`
  (`:85#timeline`), `/map` (`:253#map` — calls
  `serveMapProjection`, `routes/tripMapProjection.ts:80#serveMapProjection`,
  so the two paths cannot serve two projections), `/crew` (`:261#crew`),
  `/context` (`:303#context`), `/safety` (`:327#safety`);
  registered at `routes/index.ts:163#tripProjectionsRouter`. Every
  response spreads the envelope; every failed read that a projection IS is
  refused with `TRIP_PROJECTION_UNAVAILABLE` on the wire
  (`:108#TRIP_PROJECTION_UNAVAILABLE`), and a flag-off crew
  projection is served visibly degraded with `freshness: "unattributable"`
  (`:275#featureEnabled`). The map projection's own response
  now spreads the envelope too (`routes/tripMapProjection.ts:456#liveEnvelope`).
  `/plan`, `/plan/map`, `/crew/map`, `/map-projection` keep their shapes.
- **Consumers.** `compass/CompassTools.ts:639#toolGetCurrentTrip`
  builds the context projection (`:521#buildTripCompassProjection`)
  and consumes it through `acceptTripProjection` (`:525#acceptTripProjection`);
  a refused or unreadable projection is SAID to be so (the old read handed the
  model an empty plan when the table could not be read). The tool now takes an
  optional `tripId` (`:87#tripId`), gated by
  `isAcceptedTripMember` (`:464#isAcceptedTripMember`) — §12.1's
  `getTripContext(tripId)`. `lib/discoveryTripProjectionConsumer.ts:294#acceptTripProjection`
  decides through the same function and reports its refusals by reason. On the
  client, `travel-buddy-standalone/src/services/tripProjectionEnvelope.ts:40#acceptProjection`
  is the same rule minus §22.4 (no canonical version to hand), and
  `travel-buddy-standalone/src/services/tripMapProjection.ts:90#acceptProjection`
  refuses before drawing.
- **Tests.** `src/test/tripProjectionEnvelope.test.ts` (24: the rule, its
  order, the metric, the two pure builders), `src/test/tripProjections.test.ts`
  (23: every endpoint's envelope, gate, reason and refusal; Compass consuming;
  the discovery consumer), and the client's
  `travel-buddy-standalone/src/services/__tests__/tripProjectionEnvelope.test.ts`
  (4). Four mutations went red before commit: dropping §22.4, dropping the
  safety opt-in gate, serving an empty timeline on an unreadable plan, and
  claiming `live` on a null version.
- **Also in this commit, and not a §19 fact:** `checkTripPushPolicy.ts`'s
  `KNOWN_BYPASSES` re-anchored to the nine lines §40.1's edits moved. That
  guard was red on the branch between the two commits; TR200's count is
  unchanged.

**What is NOT built, said before the table.** `/today` — §11.1's projection
needs the Temporal Freedom Engine (§7.3), which does not exist (TR131); a
`/today` that returned the plan under another name would be TR371/TR373's
finding again. `TripMemoryProjection` and `TripPassportProjection` still point
the other way (TR362, TR363, unchanged). No projection worker: every
projection here is generated in the request that serves it, so the observed
lag is ~0 by construction and `cached`/`stale` are words with no producer.
§22.4 is ENFORCED by `acceptTripProjection` when a consumer hands it a
canonical version, and today no live consumer does — Compass's version comes
from the same row as the summary, so comparing them would be comparing a
number to itself. Enforced-in-a-function is not enforced-live; TR416 is W.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR357 `TripTimelineProjection` | W | **C** | Server-built (`buildTripTimeline`), under the envelope, at `/timeline`; the client's `TimelineDay[]` (`src/types/models.ts`) is now something it can fetch rather than derive. Route-tested including the refusal on an unreadable plan. |
| TR358 `TripMapProjection` | W | **C** | *"`/plan/map` … and nothing else from §14.1's eleven layers."* §14.1's ten-layer projection has existed since 42aeac38 (TR254); it now carries all four envelope fields and answers at §19.2's path. |
| TR359 `TripCrewProjection` | W | **C** | *"carries no generatedAt, no version and no freshness."* Now all three plus the schema version, at `/crew`. The flag it sits behind (`trip_crew_map_enabled`, seeded FALSE) is a deployment fact and is stated in the response (`featureEnabled`), not hidden by it. |
| TR360 `TripCompassProjection` | N | **C** | *"Compass reads raw tables."* It builds and ACCEPTS `TripCompassProjection` — the object `/context` serves — and says when it could not. The census-compass row CT-02 (*"zero occurrences"*) is falsified by this commit and is that census's to re-derive. |
| TR361 `TripSafetyProjection` | N | **C** | §17.4's three operational states, opt-in per member, withheld counted, no location. |
| TR364 every projection includes `generatedAt` | W | **C** | Six projections exist (timeline, map, crew, context, safety, discovery); six carry it, from one function. The three that do not exist (today, memory, passport) are their own N/W rows, not exceptions to this one. |
| TR365 …`sourceTripVersion` | W | **C** | Same six; `trips.version` and nothing else, null when unreadable. |
| TR366 …`projectionSchemaVersion` | W | **C** | Same six. The discovery projection keeps its own constant (its shape has its own history); the consumer rule is shared. |
| TR367 …`freshness` status | W | **C** | Same six; two values emitted and two declared with no producer, stated in the type and above. |
| TR368 consumers reject or visibly degrade on stale/incompatible projections | W | **C** | Three live consumers decide through one rule and name the refusal: Compass, the discovery consumer, the client map. Flag-off crew is visibly degraded WITH the envelope. Tested at all three. |
| TR369 `GET /trips/:id/context` | N | **C** | Registered, gated (accepted crew, `TRIP_AUTH_NOT_CREW`), tested. |
| TR370 `GET /trips/:id/today` | N | **N** | **Holds.** See above. |
| TR371 `GET /trips/:id/map` | W | **C** | §19.2's path serves §14.1's projection — byte-identical to `/map-projection` less `generatedAt`, and the test says so. |
| TR372 `GET /trips/:id/crew` | W | **C** | As TR359. Invitees may look, as `/crew/map`'s header explains; strangers get `TRIP_AUTH_NOT_CREW`. |
| TR373 `GET /trips/:id/timeline` | W | **C** | As TR357. |
| TR202 `getTripContext(tripId)` | W | **C** | Both halves of the row closed: the content is a typed projection, and the tool takes a `tripId`. Named-trip access is gated by the same membership check the routes use and tested for a member, a stranger and a missing trip. |
| TR394 `projection_lag_seconds` | N | **C** | Observed by every in-process consumer on acceptance, under the projection's name, readable by `readTripMetric`. Its value is ~0 because there is no read model to lag — the metric is true, and it is the number a projection worker would move. |
| TR416 §22.4 `sourceTripVersion` may never exceed the canonical version | N | **W** | *"Neither side of the comparison exists."* Both exist and the comparison is written and tested (`acceptTripProjection`, `TRIP_PROJECTION_VERSION_AHEAD`). No live consumer supplies a canonical version yet — see above. W, not C. |
| TR449 `TRIP_PROJECTION_*` | W | **C** | All four codes emitted: `_UNAVAILABLE` on the wire by five routes and the discovery projection; `_SCHEMA_MISMATCH`, `_VERSION_AHEAD`, `_STALE` returned by the consumer rule and surfaced (Compass `info`, discovery `reasons`, client `detail`). |

**Rows looked at that did not move:** TR5 (typed projections for seven
consumers — now Compass, Map, Discovery, Safety; not Telegraph, Passport,
Memory; W by count, 4 of 7), TR254 (already C), TR362/TR363 (unchanged, W),
TR203 `getTodayProjection` (N, with TR370), TR379 (no projection workers, N).

#### The count after §40.2

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §40.1 | 100 | 157 | 193 | 1 | 257 / 451 = 57.0 % | 100 / 451 = 22.2 % |
| **after §40.2** | **117** | **145** | **188** | 1 | **262 / 451 = 58.1 %** | **117 / 451 = 25.9 %** |

Seventeen rows into C (thirteen from W, four from N), one N→W, one held.
Nothing here is deployed; `trip_kernel_enabled` is still seeded FALSE, and so
is `trip_crew_map_enabled`.

### 40.3 §7.3 Temporal Freedom Engine and §7.2 conflict detection

**What was measured.** TR131: `grep -rli "FreedomWindow"` over the tree →
nothing. TR132: no gap computation; `trip_plan_items.category` admits
`'free_time'` as a label a person types. TR129/TR130: nothing detects a
conflict, so an impossible pair renders as an ordinary day list. TR133: four
consumers, four independent derivations of "free time" — Compass's
`check_trip_conflicts` re-derives overlap from `day_date` per call. TR395: no
metric. TR412: vacuous. What existed was the §7.2 invariant per hop
(`services/trips/TripFeasibilityEngine.ts`, W since §39 for the reason its
header states: no routing provider, so a lower bound can prove INFEASIBLE and
never FEASIBLE).

**What was built.**

- `services/trips/TripFreedomEngine.ts` — PURE. §7.3's `FreedomWindow`, every
  field (`:102#FreedomWindow`): `beginsAt` is when the previous
  commitment releases the traveller — its end when known, else its start, and
  never before the latest moment they were allowed to arrive at it
  (`:195#leaveAt`); `endsAt` is when they must LEAVE to make the
  next: deadline + tolerance − travel − prep, against the feasibility engine's
  lower-bound travel term. An unknown travel term is NOT zero: the window ends
  at the deadline less prep, carries `TRAVEL_UNKNOWN`, is graded INSUFFICIENT.
  Six named hard constraints (`:77#HARD_CONSTRAINT_KINDS`).
  `certified` (`:230#certified`) is HIGH with no unknown term
  — computed, and never true today. `computeFreedomWindows`
  (`:213#computeFreedomWindows`) emits `before_first`, `between`
  and `after_last` windows and, where `endsAt ≤ beginsAt`, a
  `TRIP_TEMPORAL_CONFLICT` instead: `OVERLAP` (`:278`) when the
  next deadline falls before release, `NO_TIME_TO_TRAVEL` (`:307`)
  when travel + prep eat the gap — each with the shortfall in minutes, and
  `overridden: false` typed as the literal (`:132#TemporalConflict`)
  because no override path exists. `detectPlanOverlaps`
  (`:371#detectPlanOverlaps`) is §7.2 on the plan itself.
- `services/trips/TripFreedomProjection.ts:103#buildTripFreedomProjection` —
  the reads (trips, commitments, places, members — each REFUSED when it fails;
  a window over "no commitments" is the whole trip), the hop travel terms from
  the feasibility engine (`:151#checkFeasibility`, the same provider
  as `/feasibility`, so a verdict and a window cannot disagree about a hop),
  the engine, the §19.1 envelope, and `temporal_conflict_total` incremented
  at detection by kind (`:162#temporal_conflict_total`;
  `lib/tripMetrics.ts:64#incrementTripMetric`).
- `GET /trips/:tripId/freedom-windows`
  (`routes/tripProjections.ts:229#freedom-windows`) — §12.1's
  `getFreedomWindows(tripId)` as a read; accepted crew; refusals by reason.
  `/timeline` now carries `conflicts` and each day's `conflictIds`
  (`:156#detectPlanOverlaps`, `:159#conflictIds`),
  so a renderer that only reads days still sees the mark.
- **Compass consumes the engine.** `get_freedom_windows`
  (`compass/CompassTools.ts:183#get_freedom_windows`, implemented
  at `:801#toolGetFreedomWindows`, dispatched at
  `:1343#get_freedom_windows`) returns the same object the route
  serves, through `acceptTripProjection`, and with `at` returns the window
  containing that instant — §11.3's "I am bored" input, without touching a
  commitment. Twelve tools now; the header says so.
- **A defect the property test found, and its fix.** §22.4's property
  ("an earlier hard commitment cannot increase the preceding certified free
  window") was written as a seeded 60-itinerary test over the REAL provider
  (`src/test/tripFreedomEngine.test.ts:215#seeded`). It went red on
  round 46 — and the cause was not the engine. `straightLineTravelTimeProvider`
  chose WALK for any hop under 2 km and DRIVE above it, routeOptimizer's
  planning heuristic; a 1.9 km hop came back as 26 minutes on foot when a taxi
  covers it in 7. For every hop under two kilometres the term was NOT a lower
  bound, so the feasibility engine's one claim — "a straight-line INFEASIBLE
  is a real verdict" — was false there, and a 2001 m drive being "faster" than
  a 2000 m walk is what let free time grow. The adapter now takes the MINIMUM
  over its modes when none is requested (`services/trips/TravelTimeProvider.ts:162#Math.min`;
  header `:126#FASTEST`), which is monotone and subadditive — the
  two properties a bound needs — pinned by two new provider tests
  (`src/test/tripFeasibilityEngine.test.ts:261#FASTEST`,
  `:276#subadditive`). An explicitly requested mode is honoured as
  before. The property then holds for every conflict-free insertion, and the
  test says why a conflicted one is excluded: §7.2 marks it, and the invariant
  is about consistent timelines.
- **Tests.** `src/test/tripFreedomEngine.test.ts` (15: the arithmetic, both
  conflict kinds, the trip's ends, ordering, the plan rule, the property),
  `src/test/tripFreedomWindows.test.ts` (9: the route's envelope, travel term
  and refusals; Compass consuming with `at`; the timeline's marked day; both
  metrics). Four mutations went red before commit: a window beginning before
  the latest allowed arrival, unknown travel read as zero, the provider's old
  walk rule, and windows served over unreadable commitments.

**Found by a guard after the commit was written, and fixed before it was
made.** `check:flag-schema-prerequisites` reported the class it exists for:
COMPASS_ENABLED is ON in production and Compass's new `get_freedom_windows`
reached `trip_commitments`, a table production lacks (2761 is not
production-applied). The projections that need kernel-era schema — §7.3
windows, and §40.4/§40.5's health and today — now consult a capability of
their own FIRST: `trip_operational_projections_enabled`
(`lib/tripOperationalProjections.ts:29#TRIP_OPERATIONAL_PROJECTIONS_FLAG`,
definition `:31#TRIP_OPERATIONAL_PROJECTIONS`, gate
`:72#tripOperationalProjectionsGate`, registered at
`lib/capability/registry.ts:160#TRIP_OPERATIONAL_PROJECTIONS`), seeded
FALSE by `2778_trip_operational_projections_flag.sql`. The gate is a pure
helper in the ratchet's sense, so the builders that call it first
(`services/trips/TripFreedomProjection.ts:112#tripOperationalProjectionsGate`)
are gate boundaries and their schema belongs to this flag, OFF everywhere;
the ratchet now reports it LATENT, which is what it is. Off, the routes answer
`feature_disabled` and Compass says "not enabled"; an UNVERIFIABLE probe is
`TRIP_PROJECTION_UNAVAILABLE`, retryable, not "disabled"
(`:101#refusalForGate`) — a distinction a mutation test holds.
The migration seeds one row and nothing else; it is not applied anywhere
until CI runs it, and it is not production-applied by this document.

**What is NOT built.** No override path: §7.2's "only when explicitly
overridden" needs a command that records the override, and `overridden` is
always false until it exists. Discovery, Saved Ideas and Buddy matching still
do not consume windows (Compass does). `trip_commitments` has no end column,
so every window after a commitment begins at its START and says so
(`PREVIOUS_END_UNKNOWN`) — a lower bound on free time, not the free time.
No window is certified: no routed provider (TR128's reason, unchanged). The
client still renders `/plan` rather than `/timeline`, so the marked day
reaches the wire and not yet the screen.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR131 `FreedomWindow` contract | N | **C** | All seven fields, computed, served, consumed, tested. |
| TR132 Trips queries a Temporal Freedom Engine for gaps between commitments | N | **C** | `buildTripFreedomProjection` behind `/freedom-windows` and the Compass tool; the gap computation is the engine, not a label. |
| TR205 `getFreedomWindows(tripId)` | N | **C** | The route and the Compass tool, by §12.1's name, through the §19.1 rule. |
| TR395 `temporal_conflict_total` | N | **C** | Incremented at detection, by kind, in both places conflicts are detected; read back in both suites. |
| TR129 confirmed timelines may contain known conflicts only when explicitly overridden and visibly marked | N | **W** | Detected and marked (`TRIP_TEMPORAL_CONFLICT`, shortfall, `overridden: false`). No override path — the "only when explicitly overridden" half has nothing to record an override in. |
| TR130 a conflict is not silently rendered as a normal itinerary | N | **W** | The timeline projection names the conflict and marks its day; the shipped client still renders `/plan`. Wire, not screen. |
| TR133 Discovery, Compass, Saved Ideas and Buddy matching consume these windows rather than independently calculating free time | N | **W** | One of four: Compass's `get_freedom_windows` consumes the engine. `check_trip_conflicts` (cross-trip date overlap) is a different question and stays. |
| TR197 §11.3 "I am bored" → short FreedomWindow + candidates without changing commitments | N | **W** | The window half: `get_freedom_windows` with `at` returns the window containing now, touching nothing. The candidate half is Discovery's and is not wired to it. |
| TR412 §22.4 an earlier hard commitment cannot increase the preceding certified free window | N | **W** | Holds for every window the engine emits on a consistent timeline, tested over 60 seeded itineraries with the real provider — and the test is what found the provider defect. W, not C: no window is certified without a routed provider, so the property is proven on uncertified windows and vacuous on certified ones. |
| TR128 core invariant | W | **W** | **Holds W, and the reason is now true.** The header's "a straight-line INFEASIBLE is a real verdict" was false under two kilometres until this pass; it is true at every distance now. Still W: FEASIBLE is still unprovable. |

**Rows looked at that did not move:** TR134 (§7.4 feasibility check, W —
same provider fix applies, same reason for W), TR184 (`freeWindows[]` on the
Today projection — §40.5's), TR226 (`+ freedom window` on an experience
compiler that does not exist — N holds), TR122–TR127 (the commitment
contract, unchanged).

#### The count after §40.3

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §40.2 | 117 | 145 | 188 | 1 | 262 / 451 = 58.1 % | 117 / 451 = 25.9 % |
| **after §40.3** | **121** | **150** | **179** | 1 | **271 / 451 = 60.1 %** | **121 / 451 = 26.8 %** |

Four rows into C, five N→W, one held W with its reason corrected. Nothing here
is deployed.

### 40.4 §3.2 operational phase, §17.1 trip health, §3.3 AT_RISK derived

**What was measured.** TR38–TR45: "There is no phase concept at all: no
column, no enum, no derivation, no UI switch." TR314: readiness is "a
four-value health-shaped summary — of PREPARATION, not of the journey, with
no DISRUPTED state and no runtime input." TR317: nothing changes what a
surface shows by trip state. TR46: four plan states of nine; IN_PROGRESS,
AT_RISK, MOVED absent. TR194: no START_PLAN. TR396: no metric.

**What was built.**

- `services/trips/TripOperationalPhase.ts` — PURE. The eight phases
  (`:44#OPERATIONAL_PHASES`) with §3.2's second column verbatim as
  `primaryFocus` (`:50#PRIMARY_FOCUS`), and `deriveOperationalPhase`
  (`:126#deriveOperationalPhase`): first clause wins, in the order
  disruption → the trip's edges → what the traveller is doing (TRANSIT past a
  window's leave-by; ACTIVE_PLAN for an item under way, an explicit
  `in_progress` honoured when the kernel has one) → the clock (NIGHTLIFE needs
  a reason: an active Safe Return or a nightlife-category plan today; else
  REST in rest hours) → FREE_TIME. Every answer carries the clause and the
  evidence. Outside the trip's dates the phase is null: a trip that has not
  started is not in FREE_TIME. The clock is the trip's zone
  (`:114#localClock`). §3.1's rule is kept: derived from facts,
  never stored.
- `services/trips/TripHealth.ts` — PURE. §17.1's ladder
  (`:38#TRIP_HEALTH_LEVELS`), a closed reason vocabulary
  (`:41#HEALTH_REASON_CODES`), and `deriveTripHealth`
  (`:82#deriveTripHealth`): health is the WORST concrete reason —
  a realised risk or a NEEDS_HELP member → DISRUPTED; a temporal conflict, a
  high/high open risk or an infeasible hop → AT_RISK; an elevated risk or an
  unjudgeable hop → ATTENTION — and every reason stays in `reasons[]`, because
  §17.1's second sentence is the design. Readiness is NOT an input, on
  purpose. `surfacePriority` (`:122#surfacePriority`) is §17.2's
  logistics / affected commitments / recovery order, present only at AT_RISK
  or worse.
- `services/trips/TripHealthProjection.ts:56#buildTripHealthProjection` —
  one builder for both, from the §7.3 projection (conflicts, windows, hop
  verdicts), the risk register, Safe Return with the safety projection's own
  opt-in rule, and today's plan; every read refused when it fails, because a
  health computed over "no risks" is HEALTHY by construction. Behind the
  §40.3 gate (`:59#tripOperationalProjectionsGate`).
- `GET /trips/:tripId/health` (`routes/tripProjections.ts:259#health`),
  accepted crew, under the envelope.
- **§3.3 AT_RISK, derived.** The timeline projection marks plan items in a
  temporal conflict as at risk (`:162#atRiskPlanIds`) and
  `plan_at_risk_total` counts them (`:163#plan_at_risk_total`)
  — a state computed from facts (§3.1) rather than a column the UI writes.
- **Tests.** `src/test/tripOperationalPhase.test.ts:27#clause`
  (13: every clause and its order, the zone, the health ladder),
  `src/test/tripHealthProjection.test.ts:66#buildTripHealthProjection`
  (8: the builder's reads, refusals, opt-in, the gate). Two mutations went
  red: disruption no longer first; a realised risk graded AT_RISK.

**What is NOT built.** IN_PROGRESS and START_PLAN (TR46, TR194): a kernel
migration (a new command branch in `trip_kernel_execute`, a status the
plan-state check admits) that this environment cannot execute — no database,
no docker daemon — and that this document will not call built on a text
test alone. Stated, deferred, not disguised as the derived AT_RISK. MOVED,
likewise. The UI switch §3.2 describes: `primaryFocus` is served; no client
reads it yet. Readiness stays behind its own flag and out of health.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR38–TR45 §3.2 active operational phase, each with its own primary UI/behaviour | N ×8 | **W ×8** | All eight DERIVED and served with §3.2's primary focus per phase, on `/health` and (§40.5) `/today`, tested clause by clause. W and not C: the row is derivation AND UI switch, and no screen switches on it yet. |
| TR46 plan state machine, nine states | W | **W** | **Holds, and moves by one state:** AT_RISK is now derived and served (never stored — §3.1). IN_PROGRESS and MOVED still absent; four stored states of nine, one derived. |
| TR194 START_PLAN → IN_PROGRESS | N | **N** | **Holds.** Needs a kernel migration this environment cannot run. Stated above. |
| TR314 trip health HEALTHY → ATTENTION → AT_RISK → DISRUPTED | W | **C** | A summary of the JOURNEY over concrete reasons (conflicts, the register, Safe Return, feasibility), with DISRUPTED and runtime input; the reasons never replaced by the word; served and consumed (§40.5). |
| TR317 AT_RISK priority: logistics / affected commitments / recovery | N | **W** | `surfacePriority` served at AT_RISK or worse; no surface applies it yet. |
| TR396 `plan_at_risk_total` | N | **C** | Recorded per at-risk plan where AT_RISK is derived; read back in the test. |

#### The count after §40.4

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §40.3 | 121 | 150 | 179 | 1 | 271 / 451 = 60.1 % | 121 / 451 = 26.8 % |
| **after §40.4** | **123** | **158** | **169** | 1 | **281 / 451 = 62.3 %** | **123 / 451 = 27.3 %** |

Two rows into C, nine N→W, two held. Nothing here is deployed;
`trip_operational_projections_enabled` is seeded FALSE.

### 40.5 §11.1 TripTodayProjection and `GET /trips/:id/today`

**What was measured.** TR180: no `TripTodayProjection`, no `/today`. TR181–
TR183: `nowState`, `currentPlan`, `nextCommitment` derived on the CLIENT from
the plan list — "the shape §11.1 exists to replace". TR184, TR187, TR189–
TR192: no windows, no risks, no pulse, no envelope. TR193: the client answers
three of §11.2's five questions in a different order. TR203, TR356, TR370:
nothing to get.

**What was built.**

- `services/trips/TripTodayProjection.ts` — every §11.1 field
  (`:91#TripTodayProjection`), COMPOSED from §40.2–§40.4's
  projections rather than re-derived: `nowState` and `risks[]` from
  TripHealthProjection, `freeWindows[]` from TripFreedomProjection,
  `nextCommitment` with its LEAVE-BY from the window that ends at it,
  `crewSummary` from the roster and — when its flag is on — the crew map,
  in its own gate-boundary helper (`:129#readCrewSummary`).
  `unresolvedActions[]` is derived from what the projection already knows
  (`:253#unresolvedActions`): conflicts, NEEDS_HELP, realised or
  high risks, unplaced commitments. `opportunities[]` and `pulseSignals[]`
  have no producer and are `no_source` layers, stated
  (`:279#no_source`). `answers` names, in §11.2's order, the
  field that answers each question (`:115#TODAY_ANSWERS`).
- **§22.4 checked LIVE.** `buildTripTodayProjection`
  (`:155#buildTripTodayProjection`) reads `trips.version` FIRST
  (`:167#canonical`) and accepts each sub-projection through
  `acceptTripProjection` with it as the canonical version
  (`:180#acceptTripProjection`): a command landing between the
  reads makes a sub-projection AHEAD and the Today projection is refused
  `TRIP_PROJECTION_VERSION_AHEAD` rather than assembled from two states. The
  test drives it with a stateful fake
  (`src/test/tripTodayProjection.test.ts:105#LIVE`) and a
  mutation that stops handing the version over went red.
- `GET /trips/:tripId/today` (`routes/tripProjections.ts:279#today`);
  one refusal mapping for the three gated builders
  (`:202#refuseBuild`). Compass `get_today_state`
  (`compass/CompassTools.ts:199#get_today_state`,
  `:840#toolGetTodayState`, dispatched at
  `:1344#get_today_state`) consumes the same object through
  the §19.1 rule — §12.1's `getTodayState(tripId)`. Thirteen tools now.
- **Tests.** `src/test/tripTodayProjection.test.ts` (16: every field,
  §11.2's order, actions from conflicts, the live §22.4 refusal, the crew
  summary's nulls, the gate, both routes, Compass, and
  `:170#AT_RISK` for §40.4's derived state);
  `src/test/tripFreedomWindows.test.ts:172#feature_disabled`
  for the flag off.

**What is NOT built.** Nothing produces opportunities or pulse signals; the
projection says so rather than serving `[]`. The Today SURFACE (TR193) is
still the client's own: the server answers the five questions in order and
the shipped screen does not read it yet. Readiness's next-best-action list
stays on its flag-gated endpoint and is not merged into `unresolvedActions`.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR180 the `TripTodayProjection` contract | N | **C** | Every field, composed, served at `/today`, consumed by Compass, tested. |
| TR181 `nowState` | W | **C** | The §3.2 phase with its clause, on the server; consumable by Compass (it is). |
| TR182 `currentPlan` | W | **C** | The item under way now, from the same clause that set ACTIVE_PLAN. |
| TR183 `nextCommitment` | W | **C** | Over COMMITMENTS (TR15 is closed since 2761), with `arriveBy` and `mustLeaveBy` from the §7.3 window. |
| TR184 `freeWindows[]` | N | **C** | The §7.3 windows still open now. |
| TR185 `crewSummary` | W | **C** | On the projection: roster counts always; presence counts when the crew map's flag is on, and NULL — not zero — when it is off or unavailable, with the reason. |
| TR186 `opportunities[]` | W | **W** | **Holds.** `no_source`, stated. Compass's trip brief still exists elsewhere and is still not this field. |
| TR187 `risks[]` | N | **C** | The register's open and realised rows, beside the §17.1 reasons. |
| TR188 `unresolvedActions[]` | W | **C** | Derived on the projection from conflicts, safety, risks and unplaced commitments. The readiness list is a different subsystem and is said to be. |
| TR189 `pulseSignals[]` | N | **N** | **Holds.** No Trip Pulse; `no_source`, stated. |
| TR190 `generatedAt` | N | **C** | Envelope. |
| TR191 `sourceTripVersion` | N | **C** | Envelope — read first, and the canonical version the sub-projections are checked against. |
| TR192 `freshness` | N | **C** | Envelope. |
| TR193 §11.2 the Today surface answers, in order, the five questions | W | **W** | **Holds.** The projection answers them in order and names the field for each; the surface is still the client's own and does not read it. |
| TR203 `getTodayState(tripId)` | N | **C** | `get_today_state`, through the §19.1 rule. |
| TR356 `TripTodayProjection` | N | **C** | As TR180. |
| TR370 `GET /trips/:id/today` | N | **C** | Registered, gated (accepted crew; `trip_operational_projections_enabled`), tested. |
| TR416 §22.4 `sourceTripVersion` may never exceed the canonical version | W | **C** | *"No live consumer supplies a canonical version yet."* One does: the Today builder, and the refusal is tested against a fake that moves the version between reads. |

**Rows looked at that did not move:** TR197 (W since §40.3; `get_today_state`
does not add candidates), TR205 (C), TR226 (N), TR379 (no projection worker —
every projection here is generated in the request that serves it).

#### The count after §40.5

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §40.4 | 123 | 158 | 169 | 1 | 281 / 451 = 62.3 % | 123 / 451 = 27.3 % |
| **after §40.5** | **138** | **152** | **160** | 1 | **290 / 451 = 64.3 %** | **138 / 451 = 30.6 %** |

Fifteen rows into C (nine from N, six from W), three held. Nothing here is
deployed; every projection in §40.3–§40.5 is behind a flag seeded FALSE, and
that flag must stay FALSE on production until 2420, 2760, 2761 and 2762 are
applied there — an owner action this document does not take.

### 40.6 §10.1/§10.2 presence: freshness class, source, confidence, and the stale-render guard

**What was measured.** TR159: `updatedAt` on the wire and no client renders it.
TR161/TR162: no `source`, no `confidence` — "a city derived from a check-in
and one derived from a coarse geofence are indistinguishable." TR164: no
freshness class; `updatedAt` passed through raw. TR165: a pin under a live
grant drawn as live regardless of the observation's age. TR399: the metric
that would catch exactly that does not exist, "so the regression is not
merely unmeasured — it is unmeasurable." Two of those absences had their
columns already: `user_location_state.source` (written by
`routes/location.ts` from the client's report) and `accuracy_meters`; nothing
forwarded them.

**What was built.**

- `lib/tripPresenceFreshness.ts` — PURE. §10.2's four classes
  (`:42#PRESENCE_FRESHNESS_CLASSES`), `classifyPresence`
  (`:84#classifyPresence`) and `presenceConfidence`
  (`:77#presenceConfidence`: the device's accuracy, banded; INSUFFICIENT
  when unknown; carried SEPARATELY from freshness because a precise fix from
  a week ago is precise and stale). The class is judged on the POSITION's own
  clock: `user_location_state.updated_at` moves on any patch — a hand-picked
  city this morning — while `last_known_at` moves only with a coordinate, and
  judging currency on the former called a week-old point LIVE. The card says
  which clock it used.
- The crew card carries §10.1's fields by the spec's names
  (`lib/tripCrewLocation.ts:136#freshnessClass`): `freshnessClass`,
  `observedAt` + `observedAtSource`, `source`, `confidence`. `buildCrewCard`
  classifies first (`:170#classifyPresence`), and "current" is
  now the class's `drawableAsCurrent` (`:182#drawableAsCurrent`):
  under an active grant a LAST_KNOWN or OFFLINE position withholds exact
  coordinates AND the attempt is counted —
  `stale_presence_render_attempt_total` (`:260#stale_presence_render_attempt_total`)
  — so TR399's regression is measurable where it is refused.
  `services/tripCrew/TripCrewLocationService.ts:169#last_known_at`
  forwards the three columns (`:297#lastKnownAt`). The legacy
  `freshness` bucket stays on the card, computed on the same instant.
- **Tests.** `src/test/tripPresenceFreshnessClass.test.ts` (8): the classes at
  their bounds, expiry, the two clocks, confidence bands, and the card —
  `:65#LAST_KNOWN` (grant active, coordinates withheld,
  metric counted) and `:73#last_known_at`. The 46
  existing crew-card tests pass unchanged. Two mutations went red: judging
  on the row's clock; dropping the metric.

**What is NOT built.** The marker's visual treatment and accessible text
(TR166) are the client's, and the shipped client renders `statusLabel`
alone; `freshnessClass` reaches the wire and not the screen. `source` is the
client's own word (`gps`, `manual`, …) — carried, not vocabularised. Newest-
valid-observation ordering across devices (TR351) is a write-path rule this
pass did not touch.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR159 every presence row carries `observed_at` | W | **C** | `observedAt`, with the clock it came from, on every card. Rendering it is TR166's row. |
| TR161 …`source` | N | **C** | Forwarded from `user_location_state.source`; null when the client said nothing. |
| TR162 …`confidence` | N | **C** | Banded from `accuracy_meters`; INSUFFICIENT when unknown; independent of freshness. |
| TR164 freshness LIVE / RECENT / LAST_KNOWN / OFFLINE | N | **C** | Computed by the spec's names on the position's clock, with expiry → OFFLINE. |
| TR165 the Trip Map must never draw a stale location as if it were current | W | **C** | Exact coordinates only for LIVE/RECENT judged on `last_known_at`; the grant is the choice to share, not a claim about age; the refusal is counted. |
| TR166 marker visual treatment and accessible text expose freshness | N | **N** | **Holds.** Client. |
| TR342 §18.1 stale / live-unavailable must be visible | N | **W** | Visible on the wire (`freshnessClass`, `observedAt`); the surface does not render it. |
| TR399 `stale_presence_render_attempt_total` | N | **C** | Recorded where the stale render is refused; read back in the test. |

**Rows looked at that did not move:** TR157 (presence states — W; not
derived), TR160/TR163 (C), TR281 (W — the map projection's crew layer is
still `no_source`; the crew card obeys), TR308 (W), TR351 (W).

#### The count after §40.6

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §40.5 | 138 | 152 | 160 | 1 | 290 / 451 = 64.3 % | 138 / 451 = 30.6 % |
| **after §40.6** | **144** | **151** | **155** | 1 | **295 / 451 = 65.4 %** | **144 / 451 = 31.9 %** |

Six rows into C (two from W, four from N), one N→W, one held.

### 40.7 §20.2 closeout, §20.3 reconciliation, §21.2 decision ledger

**What was measured.** TR383–TR390: `POST /trips/:tripId/complete` was "an
authorization check, a status update and a logActivity line" — no presence
table touched, nothing reconciled, no question asked. TR401: no decision
ledger. TR402: one cached paragraph explains one thing. TR213/TR376: nothing
to explain and no route.

**What was built.**

- `services/trips/TripCloseout.ts` — PURE. §20.2's seven steps in order
  (`:38#CLOSEOUT_STEPS`), each planned as actionable, not
  applicable or deferred with the reason (`:85#planCloseout`);
  §20.3's questions (`:74#reconciliationQuestions`): one per
  dated plan not already done or cancelled, in the spec's own words, with the
  two `trip_outcomes` answers it admits.
- `services/trips/TripCloseoutService.ts:41#runTripCloseout` reads
  the inputs, performs the ONE step this deployment can perform — stopping the
  trip's temporary presence with the live-share service's own update shape
  (`:79#stopped`) — and reports every step. `POST /trips/:tripId/complete`
  calls it AFTER the transition (`routes/trips-expansion.ts:738#runTripCloseout`),
  so a failed step cannot un-complete a trip, and the response carries the
  closeout rather than implying it. `GET /trips/:tripId/closeout`
  (`routes/tripProjections.ts:594#closeout`) is the same plan as a
  dry run.
- `services/trips/TripDecisionLedger.ts` — §21.2's `TripDecision`, every
  field (`:56#TripDecision`), versioned engines
  (`:43#TRIP_ENGINE_VERSIONS`), `recordTripDecision`
  (`:81#recordTripDecision`) and `explainTripDecision`
  (`:114#explainTripDecision`) — sentences from the record. Every
  §40.3–§40.5 build records one (`services/trips/TripFreedomProjection.ts:201#recordTripDecision`,
  `TripHealthProjection.ts:204#recordTripDecision`,
  `TripTodayProjection.ts:353#recordTripDecision`) naming ids,
  versions and counts — never a coordinate or a name — and carries its
  `decisionId`. `GET /trips/:tripId/decisions/:decisionId/explain`
  (`routes/tripProjections.ts:569#explain`) and Compass
  `explain_trip_decision` (`compass/CompassTools.ts:364#explain_trip_decision`,
  `:889#toolExplainTripDecision`, dispatched at
  `:1371#explain_trip_decision`; fourteen tools now) answer
  a crew member for their own trip; another trip's decision is answered as
  not retained, exactly like one that never was.
- **Tests.** `src/test/tripCloseout.test.ts` (11): the question set, the seven
  steps, the service performing and reporting, the ledger
  (`:102#§21.2`), the routes (`:187#complete`,
  `:213#explain`) and the tool. Two mutations went red:
  reporting "performed" without stopping; serving another trip's decision.

**What is NOT built, and said.** The ledger is IN-PROCESS — a ring of
`TRIP_DECISION_RING` (`services/trips/TripDecisionLedger.ts:83#TRIP_DECISION_RING`)
records, not a `trip_decisions` table, because that table is a migration
this environment cannot execute; a decision from another process is "not
retained", never recomputed and passed off. Of §20.2's seven steps, one is
performed; reconciliation ANSWERS are RECORD_OUTCOME commands (kernel, not
enabled), closing decision tasks is UPDATE_DECISION_TASK (same), temporary
crews do not exist, evidence retention has no policy, Passport stamps are
awarded by the completion path already, and nothing stored exists to
archive. No screen asks the §20.3 questions.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR383 closeout: stop/expire temporary presence | N | **C** | Performed on `POST /complete`, reported, tested against the session rows. |
| TR384 …dissolve temporary crews where appropriate | N | **N** | **Holds.** No temporary crew exists (TR24); the step says so. |
| TR385 …reconcile uncertain plan outcomes | N | **W** | The uncertain set is computed and the §20.3 questions attached; recording an answer is a kernel command not enabled here. |
| TR386 …close operational decision tasks | N | **N** | **Holds.** Deferred by name: the table is behind the operational flag and closing is a kernel command. |
| TR387 …preserve decision/audit evidence per policy | W | **W** | **Holds.** Kept by default, still no policy; the decision ledger adds evidence that is not persisted. |
| TR388 …project Passport/Memory candidates | W | **W** | **Holds.** |
| TR389 …archive rebuildable operational projections | N | **N** | **Holds.** Nothing stored to archive; the step says so. |
| TR390 §20.3 minimal reconciliation | N | **W** | The smallest set, in the spec's words, on the completion response and `/closeout`; no screen asks it. |
| TR401 the `TripDecision` ledger contract | N | **W** | Every field, recorded by every build, explainable — in a per-process ring, not a table. |
| TR402 consequential suggestions explainable from stored inputs and versioned algorithms | W | **W** | **Holds, stronger:** every §40.3–§40.5 projection is now explainable with engine versions; retention is what keeps it W. |
| TR213 `explainTripDecision(decisionId)` | N | **W** | The tool, crew-gated, over the in-process ledger. |
| TR376 `GET /trips/:id/decisions/:decisionId/explain` | N | **W** | Registered, crew-gated, tested; "not retained" is a real answer it gives. |
| TR428 trip closeout (presence expiry, crew closure, outcome reconciliation, Memory/Passport candidates) | W | **W** | **Holds:** two of four now (Passport, presence expiry); crew closure has no subject; reconciliation asks and cannot record. |

#### The count after §40.7

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §40.6 | 144 | 151 | 155 | 1 | 295 / 451 = 65.4 % | 144 / 451 = 31.9 % |
| **after §40.7** | **145** | **156** | **149** | 1 | **301 / 451 = 66.7 %** | **145 / 451 = 32.2 %** |

One row into C, five N→W, seven held. Nothing here is deployed.

## 41. Executing the kernel — the database, then seven families on it

§40 built where it could and said, three times, that the rest "needs a kernel
migration this environment cannot run". §41 removes that sentence's premise:
a PostgreSQL 16 server was present on this machine, PostGIS installs from apt,
and the repository already ships production's structure as a dump. Nothing in
§41 was graded on a reading of SQL; every migration was applied to a database
built from that dump plus the canonical chain, seen refused on a database
built without it, and replayed in order on a fresh build at the end. The
ceiling stated in §40 is unchanged and is restated in §41.3: nothing here is
merged, deployed, or flag-enabled, and every kernel-era row stays W for
exactly that reason.

### 41.1 The database: `scripts/local-db`, and the pipeline executed (§23.1, §22.2, §19.4)

**What was measured.** TR431 read *"None of the three stages exists"* for
command → event → projection integration tests. All three stages existed in
SQL — 2420 (events, outbox, receipts), 2520 (the projection worker), 2773
(snapshot fold and replay) — and nothing outside the live CI project had ever
executed them; this environment holds no credentials for that project, so
`tripKernelLive.test.ts` skips every suite here. TR430 said idempotency had
"nothing to test", TR406 that no replay harness existed, TR433 that no
scenario or replay test existed.

**What was built.**

- `scripts/local-db/up.sh` builds a throwaway PostgreSQL carrying the trip
  domain's real schema: the Supabase surface the chain references, measured
  over all 498 canonical files (`scripts/local-db/shim.sql:41#auth.uid` —
  `auth.uid()/role()/jwt()` read the GUCs PostgREST sets, so RLS sees a test's
  `set_config` exactly as a signed-in user); then
  `baseline/20260819_baseline_structure.sql` (`scripts/local-db/up.sh:30#BASELINE`),
  production's structure on 2026-08-19; then the canonical chain from `2093`,
  the first file whose objects the baseline lacks, each file as `psql` runs it.
  Eight files do not replay and are listed with their verbatim errors in
  `scripts/local-db/KNOWN_UNREPLAYABLE.json` (`scripts/local-db/up.sh:35#KNOWN_UNREPLAYABLE.json`);
  a listed file that replays in order aborts the run, so the list can only
  shrink. None is a trip-domain file; every `trip_*` object, the kernel and the
  worker replay, and `up.sh` refuses to finish unless they are present.
- `src/test/db/localDb.ts` — `psql` over a child process, the convention
  `scripts/src/saved-places-truncate-guard.test.ts` set; nothing added to the
  lockfile. `scripts/local-db/run-tests.sh:21#skip` refuses a vacuous pass:
  `skipped` must be 0.
- `src/test/db/tripKernelPipeline.db.test.ts` on the REAL functions: one event
  at the next aggregate version and one receipt per command; a replay by key is
  a duplicate that appends nothing (`test/db/tripKernelPipeline.db.test.ts:101#replaying`);
  the worker applies each outbox event once, a second drain applies nothing,
  and `source_trip_version` equals `trips.version` (`:127#projection`); a
  snapshot written at version *v* replays to the state at *v* and a
  **tampered** snapshot fails to verify (`:149#snapshot`); RLS hides a private
  trip and its events from a non-member (`:163#RLS`).
- A CI job runs it on a `postgis/postgis:16-3.4` service container
  (`.github/workflows/ci.yml:646#api-server-local-db`); the verdict job requires
  it. The same files sit in the ordinary `test` list and skip there without a
  database, exactly as `tripKernelLive.test.ts` skips without credentials.

**What it does not prove.** Drift. `docs/ci/BOOTSTRAP.md` §1's argument
stands: replaying the chain into the CI project would make
`check:schema-references` compare the files to themselves. This database is
never that project, is never audited, and holds no data. A migration that
replays here is *replayable on this baseline*; what is applied anywhere is what
`public.schema_migration_ledger` and the runbook say.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR430 §23.1 database tests cover RLS, FK/unique, idempotency, migrations | W | **C** | All four, executed: RLS through the `authenticated` role, the receipt's unique key, idempotency by replay on the real kernel, and 217 migrations replayed in order on every run. |
| TR431 §23.1 service integration tests cover command → event → projection | N | **C** | `tripKernelPipeline.db.test.ts` on `trip_kernel_execute` → `trip_events` → `trip_outbox` → `trip_map_projection_drain`, in CI. |
| TR406 replay a Trip from a snapshot plus ordered events and compare | N | **C** | `trip_snapshot_write` then `trip_snapshot_verify_replay` on the real rows, and the tampered case fails — a verifier that compares something. |
| TR433 §23.1 scenario/replay tests cover cross-domain lifecycle behaviour | N | **W** | One scenario (create → stage → plan → join → drain → snapshot → replay) is a scenario, not a corpus; TR409's diff harness does not exist. |
| TR409 decision-diff CI over historical/synthetic scenarios | N | **N** | **Holds.** The harness can run one; nothing records a corpus or diffs two runs. |

### 41.2 Seven families, executed: 2779–2785

**What was measured.** The §40 rows that ended "needs a kernel migration this
environment cannot run": TR194 (START_PLAN), TR46 (four stored states of
nine), TR55 (no dependent-commitment validation), TR129 (no override path),
TR61/TR62/TR65/TR66 (four §4.2 events with zero occurrences), TR24/TR151/TR152
(no subgroup), TR401/TR402/TR387 (a ledger in a ring, not a table), TR18 and
TR283–TR287 (no transport object), TR297/TR298/TR352 (hard delete, no
compensation, last-write-wins), TR138/TR139 (no goal scope), TR19/TR80 (no
permissions version), TR448 (TRIP_DISRUPTION_* emitted nowhere). And three
rows this pass found already false on the branch and never re-read: TR148
(plan_scope, 2770), TR149 (attendance, 2771/2772), TR154 (decision_rule,
2774) — moved on evidence, with the file and line, not on the merge.

**How each was built.** Every migration is a TRANSFORM of the installed
kernel by 2764's method: the definition is read from `pg_proc`, each anchor is
counted before it is replaced, the branch count is checked after, and the
pre-existing guarantees — version conflict, receipt, outbox, crew check — are
asserted on the INSTALLED text. Each was applied to the replica, seen refused
on a replica built without it (eight of eight tests `TRIP_COMMAND_UNKNOWN_TYPE`
before 2779), then green; the fresh build at the end replayed all seven in
order: 217 files, 35 database tests, 0 skipped.

- **2779** (`migrations/2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql`)
  — §3.3's vocabulary as a validated CHECK (`:68#trip_plan_items_status_known`):
  draft, proposed, tentative, confirmed, in_progress, done, moved, cancelled,
  skipped. `START_PLAN` / `SKIP_PLAN` (`:179#START_PLAN`), `MOVE_PLAN` on a
  confirmed plan leaves it moved (`:125#moved`), `START_STAGE` /
  `COMPLETE_STAGE` emit `trip.stage_started` / `trip.stage_completed`
  (`:214#START_STAGE`). And §7.2 AT THE WRITE: a move whose new interval
  overlaps a commitment's approach window is refused
  `TRIP_TEMPORAL_CONFLICT` naming the commitment (`:154#TRIP_TEMPORAL_CONFLICT`)
  unless the command says `override_conflicts: true` (`:151#override_conflicts`),
  in which case the EVENT records `{ commitment_id, overridden: true }` — the
  path TR129 found missing, tested at
  `test/db/tripPlanLifecycle.db.test.ts:115#override`. The harness found the
  first draft's guard threw on an inverted interval; the guard now survives it
  and the plan's own CHECK refuses it.
- **2780** (`migrations/2780_trip_subgroups.sql`) — `trip_subgroups`
  (`:62#trip_subgroups`), `trip_subgroup_members` (`:80#trip_subgroup_members`),
  `plan_scope = 'subgroup'` must name a subgroup (`:93#trip_plan_items_subgroup_scope_named`)
  and the kernel requires an ACTIVE one the actor is in; a live-share scoped
  to a subgroup (`:100#subgroup_id`) reaches its current members only
  (`services/tripCrew/TripCrewLocationService.ts:250#subgroupScoped`,
  `:277#subgroup_id`); `DISSOLVE_SUBGROUP` (`:267#DISSOLVE_SUBGROUP`) is the
  creator's or a host's and stops those shares; a named member who is not
  crew is `TRIP_SUBGROUP_MEMBER_NOT_CREW` (`:220#TRIP_SUBGROUP_MEMBER_NOT_CREW`).
  The §20.2 closeout issues the dissolution as the completing user, keyed
  `closeout:dissolve:<id>` (`services/trips/TripCloseoutService.ts:128#DISSOLVE_SUBGROUP`,
  `services/trips/TripCloseout.ts:98#dissolve_temporary_crews`).
- **2781** (`migrations/2781_trip_decisions_ledger.sql`) — `trip_decisions`
  (`:47#trip_decisions`) with §5.3's retention as a column (`:61#retain_until`,
  90 days) and a prune function (`:80#trip_decisions_prune`); inputs refuse a
  coordinate by CHECK (`:65#trip_decisions_inputs_minimised`). The ledger
  persists under the operational gate
  (`services/trips/TripDecisionLedger.ts:131#persistTripDecision`) and explains
  from the table when the ring has forgotten (`:144#readTripDecisionFrom`).
- **2782** (`migrations/2782_trip_transport_segments.sql`) — §15.1's object
  (`:43#trip_transport_segments`): mode, planned and actual pairs, party size
  (`:58#party_size`), reliability 0..1 (`:59#reliability`), cost, booking
  reference, `fallback_of` (`:63#fallback_of`), and the state machine planned →
  booked → waiting → in_progress → completed, disrupted from any non-terminal
  state; an illegal arrow is `TRIP_TRANSPORT_INVALID_TRANSITION`
  (`:183#TRIP_TRANSPORT_INVALID_TRANSITION`), tested arrow by arrow at
  `test/db/tripTransportAndDisruption.db.test.ts:55#SET_TRANSPORT_STATE`.
- **2783** (`migrations/2783_trip_goal_scope_and_member_permissions_version.sql`)
  — `trip_goals.scope` (`:41#scope`) personal | shared with a 0..1 weight; a
  personal goal is readable by its owner only (`:51#trip_goals_select_scoped`)
  and editable by its owner only (`TRIP_AUTH_NOT_CREATOR`);
  `trip_members.permissions_version` (`:56#permissions_version`) bumped by
  `SET_PARTICIPANT_ROLE` and carried on its event
  (`test/db/tripLedgerGoalsReservations.db.test.ts:76#permissions_version`).
- **2784** (`migrations/2784_trip_reservation_history.sql`) — on a PRODUCTION
  table, additively: `version` bumped by trigger (`:55#version`), cancelled as
  a state, an append-only `trip_reservation_events` history
  (`:63#trip_reservation_events`, written by `:110#trip_reservations_history`;
  UPDATE and DELETE on a history row refused by trigger), clients lose DELETE
  (`:175#REVOKE`), and compensation as a new event
  (`:150#trip_reservation_record_compensation`). `routes/tripReservations.ts`
  honours `If-Match` (`:125#readIfMatch`, 409 `TRIP_VERSION_CONFLICT`), cancels
  instead of deleting (`:557#cancelled`), serves the history (`:577#history`)
  and records compensation (`:603#compensation`) — all behind the operational
  gate through `lib/tripReservationHistory.ts:20#reservationHistoryGate`,
  byte-identical legacy behaviour otherwise
  (`test/tripKernelFamiliesWiring.test.ts:223#reservation`; the trigger and the
  append-only refusals at `test/db/tripLedgerGoalsReservations.db.test.ts:86#2784`).
- **2785** (`migrations/2785_trip_disruptions_and_derived_events.sql`) —
  `trip_disruptions` (`:52#trip_disruptions`): `DECLARE_DISRUPTION` →
  `trip.trip_disrupted` (`:147#trip_disrupted`), `RESOLVE_DISRUPTION` →
  `trip.disruption_resolved`; `trip_commitments.at_risk_*` (`:77#at_risk_reason`);
  and the derived events under a new **`engine`** capability
  (`:125#engine` — actor_role `system` with no user, or accepted crew):
  `MARK_COMMITMENT_AT_RISK` → `trip.commitment_at_risk` (`:196#commitment_at_risk`),
  `OPEN_FREE_WINDOW` → `trip.free_window_created` (`:221#free_window_created`).
  `lib/tripDerivedEvents.ts:49#recordDerivedEvents` issues them from
  `TripFreedomProjection` (`services/trips/TripFreedomProjection.ts:198#recordDerivedEvents`)
  with the fact's identity as the idempotency key
  (`lib/tripDerivedEvents.ts:42#freeWindowKey`), so a re-read is a duplicate
  at the receipt and the aggregate does not churn — tested on the real kernel
  (`test/db/tripTransportAndDisruption.db.test.ts:134#engine`) and on the API
  side (`test/tripKernelFamiliesWiring.test.ts:118#derived`); skipped by name
  while `trip_kernel_enabled` is false.
- The client of all of this: `lib/tripKernel.ts:198#TripSubgroupCommandType`,
  `:205#TripTransportCommandType`, `:219#TripDisruptionCommandType`, the
  reasons (`:385#TRIP_TEMPORAL_CONFLICT`; Appendix B at
  `lib/tripReasonCodes.ts:100#TRIP_DISRUPTION_NOT_FOUND`); the `/commands`
  endpoint issues the seventeen new types (`routes/tripCommands.ts:86#START_PLAN`)
  and the client's mirror list matches (`src/services/tripCommands.ts:58#START_PLAN`).
  One operational gate for the whole 2760–2785 batch, on purpose
  (`lib/tripOperationalProjections.ts:52#trip_subgroups`): the registry is
  keyed by flag, the batch ships together, and a database with half of it is
  one the flag must refuse. `check:flag-schema-prerequisites`: 0 unguarded.

#### Row moves

| id | was | now | why |
|---|---|---|---|
| TR46 plan state machine, nine states | W | **W** | **Nine of nine now** — eight stored under a validated CHECK, AT_RISK derived (§40.4) — with the arrows in the kernel. Stays W for one reason: no database has 2779. |
| TR194 START_PLAN → IN_PROGRESS | N | **W** | `START_PLAN` on the real kernel: confirmed → in_progress, `trip.plan_started`, plan version bumped. No database has 2779. |
| TR55 …validates dependent commitments | N | **W** | §7.2 at the write: a move into a commitment's approach window is `TRIP_TEMPORAL_CONFLICT` naming it; nothing changes. |
| TR129 confirmed timelines may contain known conflicts only when explicitly overridden | W | **W** | **The override path exists:** `override_conflicts: true` applies the move and the event records the commitment and `overridden: true`. The engine's own conflicts stay `overridden: false` — they are detections. No database has 2779. |
| TR61 §4.2 domain events (the four with zero occurrences) | N | **W** | `trip.commitment_at_risk` — emitted by `MARK_COMMITMENT_AT_RISK`, issued by the freedom projection's engine path. |
| TR62 §4.2 domain events (the four with zero occurrences) | N | **W** | `trip.free_window_created` — `OPEN_FREE_WINDOW`, keyed by the window's identity. |
| TR65 §4.2 domain events (the four with zero occurrences) | N | **W** | `trip.stage_started` — `START_STAGE`, family `stage`. |
| TR66 §4.2 domain events (the four with zero occurrences) | N | **W** | `trip.trip_disrupted` — `DECLARE_DISRUPTION`. All four: no database has 2779/2785. |
| TR24 `TripCrew` | N | **W** | `trip_subgroups` + members, four commands, tested. The parent trip stays canonical: the dissolution test asserts `trips.status` unchanged. |
| TR151 temporary subgroups split and recombine without forking the Trip | N | **W** | `LEAVE_SUBGROUP` keeps the membership as history; `JOIN_SUBGROUP` re-activates the same row. |
| TR152 a subgroup can own a meetup, shared transport and temporary presence sharing | N | **W** | Presence: a subgroup-scoped live-share, served to members only, stopped on leave/dissolve. Plans: `plan_scope = 'subgroup'`. Shared transport: a segment has no subgroup column yet — one of three is why this is W beyond deployment. |
| TR148 `PlanScope = ALL_CREW \| OPTIONAL \| SUBGROUP \| SOLO` | N | **W** | **Re-derived:** 2770's `plan_scope` had the four values since before §40; the SUBGROUP value now has a subject and a CHECK. |
| TR149 `Attendance = INTERESTED \| GOING \| MAYBE \| CANT_GO \| LEFT` | N | **W** | **Re-derived:** `trip_plan_participants.attendance_state` (2771) with exactly those five, written by `SET_PLAN_ATTENDANCE` (2772). The row's "no attendance relation anywhere" was false on the branch it was written against. |
| TR150 attendance is an explicit relation so downstream calculations use the actual party | N | **N** | **Holds.** The relation exists; no transport, reservation, meeting-point or budget calculation reads it. Transport segments carry a `party_size` the caller states, not one derived from attendance. |
| TR154 `decisionRule = HOST \| MAJORITY \| UNANIMOUS \| ANYONE` | N | **W** | **Re-derived:** `trip_proposals.decision_rule` (2774) with those four, counted by `VOTE_ON_PROPOSAL` / `ACCEPT_PROPOSAL` (2775). |
| TR116 §6.3 privacy scopes, six values | W | **W** | **Re-derived, stronger:** `trip_plan_items.privacy_scope` has all six (2770) and `visibility` is derived from it by CHECK. W because the client still writes `visibility`. |
| TR19 `TripParticipant` with role, membership_state, permissions_version | W | **W** | membership_state is `trip_members.status` (2337, in production); `permissions_version` (2783) bumped by `SET_PARTICIPANT_ROLE`. No database has 2783. |
| TR80 `trip_participants` (with membership_state, permissions_version) | W | **W** | Same evidence as TR19. |
| TR138 `TripGoal` contract | W | **W** | `scope` — the field "genuinely missing" — is present, with the owner-only rule it implies. No database has 2783. |
| TR139 goals personal or shared, weighted, without forcing shared priorities | N | **W** | personal \| shared with owner-only RLS and kernel checks; `weight` 0..1. |
| TR6 history: events, snapshots, replay, outcomes, decision ledger | W | **W** | **Five of five now.** The ledger is a table with a retention policy. No database has 2781. |
| TR401 the `TripDecision` ledger contract | W | **W** | Every field as a column, kept 90 days by policy, read back and explained from the table. No database has 2781. |
| TR402 consequential suggestions explainable from stored inputs and versioned algorithms | W | **W** | **Holds, stronger:** stored, with the engine versions beside them. |
| TR387 …preserve decision/audit evidence per policy | W | **W** | The policy exists for decisions (`retain_until`, prune). `trip_activity_log` still has none. |
| TR100 §5.3 historical evidence class is policy-controlled with minimised payloads | W | **W** | Decisions: policy-controlled and minimised by CHECK. The activity log: neither, still. |
| TR18 `TransportSegment` | N | **W** | `trip_transport_segments`, four commands, the machine tested arrow by arrow. No database has 2782. |
| TR283 the `TransportSegment` contract | N | **W** | Mode, planned/actual pairs, endpoints, party size, reliability, cost, booking reference, fallback reference, state. |
| TR284 `state = PLANNED \| BOOKED \| WAITING \| IN_PROGRESS \| COMPLETED \| DISRUPTED` | N | **W** | Those six (plus cancelled) as a CHECK, with the arrows in the kernel and an illegal one refused by name. |
| TR286 `partySize` | N | **W** | A positive integer on the segment. Stated by the caller, not derived (TR150). |
| TR287 `reliability` | N | **W** | 0..1 on the segment. Nothing estimates it yet (§16 is later work). |
| TR297 §15.4 booking history append-only | W | **W** | Behind the gate: cancel instead of delete, history by trigger, DELETE revoked from clients, UPDATE/DELETE on history refused. Legacy behaviour byte-identical without 2784 — which no database has. |
| TR298 §15.4 compensation as a new state/event | N | **W** | `trip_reservation_record_compensation` writes a `compensated` event against a cancelled reservation; the row is untouched. |
| TR352 §18.3 confirmed booking/time: optimistic concurrency with explicit conflict | N | **W** | `version` by trigger; `If-Match` → 409 `TRIP_VERSION_CONFLICT`, nothing written; a stale keyed UPDATE touches nothing. |
| TR354 §18.4 server aggregate version is canonical | N | **W** | **Re-derived:** `trips.version` (2420) is in production and the kernel refuses a stale `expected_trip_version`; the row's "no version (TR12)" predates 2420. W: the kernel path is off everywhere. |
| TR448 `TRIP_DISRUPTION_` | N | **W** | `TRIP_DISRUPTION_NOT_FOUND` / `_NOT_ACTIVE` emitted by `RESOLVE_DISRUPTION`; `_SUPPRESSED` / `_ACTIVE` still declared only (§17.2's surface suppression is later work). |
| TR443 `TRIP_TEMPORAL_` | W | **W** | `_CONFLICT` is now emitted by the kernel at the write and by the engine; `_INFEASIBLE` / `_UNKNOWN` still declared only. Two of four. |
| TR384 …dissolve temporary crews where appropriate | N | **W** | The closeout names the active subgroups and issues `DISSOLVE_SUBGROUP` for each, keyed; deferred by name while `trip_kernel_enabled` is false. |
| TR407 event payloads are schema-versioned | N | **W** | **Re-derived:** every `trip_events` row carries `schema_version = 1` (2420; TR72 is C). W, not C: one version exists and no adapter (TR408) has ever read another. |
| TR3 Trips owns coordination (…subgroups…) | W | **W** | **Holds, stronger:** subgroups now exist as an object. |
| TR4 Trips owns execution (…plan start/complete, transport, disruption recovery) | W | **W** | **Holds, stronger:** plan start/complete, a transport object and a disruption object exist; recovery (§17.3) does not. |

#### The count after §41.2

| | C | W | N | X | CONSTRUCTED | CORRECT |
| --- | --- | --- | --- | --- | --- | --- |
| after §40.7 | 145 | 156 | 149 | 1 | 301 / 451 = 66.7 % | 145 / 451 = 32.2 % |
| after §41.1 | 148 | 156 | 146 | 1 | 304 / 451 = 67.4 % | 148 / 451 = 32.8 % |
| **after §41.2** | **148** | **180** | **122** | 1 | **328 / 451 = 72.7 %** | **148 / 451 = 32.8 %** |

§41.1: one W → C, two N → C, one N → W, one held. §41.2: twenty-four N → W,
fourteen W held with stronger reasons, one N held. Nothing here is deployed.

### 41.3 The ceiling, restated with the rows that sit on it

Every row §41.2 moves or holds at W is capped by the same fact: **no database
has 2760–2785.** That is the merge of this branch, then `live-db.yml`'s apply
to portava-ci, then Batch C of the production runbook (an owner action, manual
by design), then the two flags — `trip_kernel_enabled` and
`trip_operational_projections_enabled` — which stay FALSE until an owner
decides otherwise. Thirty-one rows in §41.2 carry that cap and nothing else
(TR6, TR18, TR19, TR24, TR46, TR55, TR61, TR62, TR65, TR66, TR80, TR129,
TR139, TR148, TR149, TR151, TR154, TR194, TR283, TR284, TR286, TR287, TR297,
TR298, TR352, TR354, TR384, TR387, TR401, TR402, TR448); §29.5's kernel-era
rows carry it too. Their next verdict is not this document's to give.

## 42. World intelligence through the trip, and the events that may cost attention

**Read against the branch `claude/sweet-fermat-fmx7up`.** §41 left every §16
row at N, §11.4 at W, and four §21.1 metrics standing; this section builds the
signal contract (§16.2), the Trip Pulse projection (§16.1), the attention
model (§11.4), the disruption priority switch (§17.2), two more §21.1 metrics
and three §12.1 tools, and moves twenty-three rows on the same rule as §40:
BUILT is a `file:line` that was opened; CORRECT is a test that was seen red
before it was seen green. Nothing here needs a migration: every table these
read is in 2760–2785 or older, so the ceiling (§41.3) is unchanged — it is
the merge, the apply, Batch C and two flags.

### 42.1 What was built, and where

- **§16.2 `SignalEstimate`** — `services/trips/TripSignals.ts:44#export interface SignalEstimate`:
  the seven fields plus `support`. `estimateFromObservations`
  (`services/trips/TripSignals.ts:107#export function estimateFromObservations`) picks the
  best-SUPPORTED value, breaks ties by source-class rank
  (`services/trips/TripSignals.ts:77#export const SOURCE_CLASS_RANK`) then by the
  serialised value — never by input order — lists every disagreeing observation
  in `contradictorySources` and multiplies confidence by the agreeing share. It
  has no notion of a recommendation, which is how "must not silently select
  whichever source makes a recommendation easier" is enforced rather than
  promised. `fallbackUsed` is true for a pattern or prediction source
  (`services/trips/TripSignals.ts:89#export const FALLBACK_SOURCE_CLASSES`) or a
  source that said so. `src/test/tripSignals.test.ts:73#shuffle-invariant` shuffles the
  inputs and asserts the same estimate.
- **§16.1 the five signals** — `SIGNAL_INTERPRETATIONS`
  (`services/trips/TripSignals.ts:185#export const SIGNAL_INTERPRETATIONS`) is the spec's
  table, verbatim. `interpretSignal`
  (`services/trips/TripSignals.ts:312#export function interpretSignal`) keeps a signal only
  when it touches something the trip holds — a saved idea or plan at that
  place, a weather-sensitive plan on that date, a taxi-like segment or a
  commitment within six hours, a commitment or plan at that event, a crew
  member — and returns typed effects (`services/trips/TripSignals.ts:194#export const SIGNAL_EFFECT_KINDS`)
  and the context axes it passed on (`services/trips/TripSignals.ts:211#export const PULSE_RELEVANCE`).
  Attention state is the seventh axis: SAFETY_EVENT drops every signal and
  AT_RISK the discovery ones, each with `TRIP_DISRUPTION_SUPPRESSED`
  (`services/trips/TripSignals.ts:319#TRIP_DISRUPTION_SUPPRESSED: a safety event`). Friend
  nearby is dropped unless BOTH parties share
  (`services/trips/TripSignals.ts:399#TRIP_PRIVACY_SCOPE`).
- **The projection** — `services/trips/TripPulseProjection.ts:113#export async function buildTripPulseProjection`:
  version first, health accepted against it, the trip context read (stage,
  saved ideas, plans, commitments, transport segments, goals, crew), then three
  sources reported BY NAME with a status (`services/trips/TripPulseProjection.ts:55#export const PULSE_SOURCES`):
  `intel_state_snapshots` for the saved places' `crowd.level` /
  `crowd.trajectory` / `event.status` / `transit.condition`
  (`services/trips/TripPulseProjection.ts:94#export const PULSE_CLAIM_TYPES`); `weather_cache`
  READ, never fetched (`services/trips/TripPulseProjection.ts:268#Read, not fetched`);
  crew presence through the crew map, which applies every §10 rule before this
  file sees a coordinate (`services/trips/TripPulseProjection.ts:5#through the crew map`).
  A source that cannot be read is UNREAD, not empty; context that cannot be
  read refuses. Served at `GET /trips/:id/pulse`
  (`routes/tripProjections.ts:299#/trips/:tripId/pulse`), to Compass as
  `get_live_conditions` (`compass/CompassTools.ts:225#name: "get_live_conditions"`), and
  into Today's `pulseSignals` layer, which was `no_source` since §40.3
  (`services/trips/TripTodayProjection.ts:220#pulseSignals = okLayer`). Ledgered as
  `pulse_projection`.
- **§11.4 the attention model** — `services/trips/TripAttentionPolicy.ts:27#export const ATTENTION_LEVELS`
  is the spec's five, read as a COST ladder, and `decideAttention`
  (`services/trips/TripAttentionPolicy.ts:85#export function decideAttention`) is the
  policy: safety is always INTERRUPT; a safety-event mode makes everything
  else PASSIVE and AT_RISK makes the discovery kinds PASSIVE; significance
  sets the base; an onlooker's event is a SURFACE; an actionable deadline
  raises it (2 h → NOTIFY, 30 min → INTERRUPT); the hourly budget
  (`services/trips/TripAttentionPolicy.ts:74#export const NOTIFY_BUDGET_PER_HOUR`) and quiet
  hours turn a NOTIFY into a SURFACE and say so. Every trip push kind has a
  profile (`services/trips/TripAttentionPolicy.ts:145#export const TRIP_PUSH_EVENT_PROFILES`).
- **The ten sites §38 found** — now call `sendTripPush`
  (`lib/tripPush.ts:92#export async function sendTripPush`), which refuses a kind with no
  profile, decides per recipient, pushes only at NOTIFY / INTERRUPT through
  the unchanged `sendPushWithRetry`, and counts every decision under
  `trip_notification_attention_total` {kind, level}.
  `src/test/tripAttentionPolicy.test.ts:81#a trip push bypasses the attention policy` reads
  the three files and fails on any remaining direct call. Two pushes changed
  behaviour: `trip_archived` and `review_prompt` are SURFACE now
  (`services/trips/TripAttentionPolicy.ts:157#Informational; the trip's own surfaces carry it`).
- **§17.2** — `deriveTripHealth` takes the 2785 register
  (`services/trips/TripHealth.ts:68#export interface DisruptionForHealth`): an active
  critical disruption is DISRUPTED, major AT_RISK, minor ATTENTION, each a
  `TRIP_DISRUPTION_ACTIVE` reason. `prioritySwitch`
  (`services/trips/TripHealth.ts:180#export function prioritySwitch`) is the spec's three
  modes with their orders (`services/trips/TripHealth.ts:159#export const PRIORITY_BY_MODE`)
  and the suppression, carrying `TRIP_DISRUPTION_SUPPRESSED`. The health
  projection reads the register and refuses without it
  (`services/trips/TripHealthProjection.ts:136#trip_disruptions unreadable — refusing`) and
  serves `attention`; Today and the pulse carry it.
- **§21.1** — `notification_actionability_rate`: sent is counted at dispatch,
  acted at `POST /trips/:id/notifications/acted`
  (`routes/tripProjections.ts:520#/trips/:tripId/notifications/acted`), and
  `readNotificationActionability` (`lib/tripPush.ts:147#export function readNotificationActionability`)
  divides per kind, null over zero. `trip_event_replay_mismatch_total`:
  `verifyTripReplay` (`lib/tripReplayVerify.ts:35#export async function verifyTripReplay`)
  calls 2773's `trip_snapshot_verify_replay` and increments on `equal = false`,
  reached from `POST /trips/:id/replay/verify`
  (`routes/tripProjections.ts:546#/trips/:tripId/replay/verify`).
- **Appendix B** — every §7.4 consistency finding now carries `reasonCode`
  from `SPATIAL_REASON_CODES` (`services/trips/TripSpatialConsistency.ts:90#export const SPATIAL_REASON_CODES`),
  stamped by the check functions themselves, so the feasibility route's
  `consistency.findings` emit `TRIP_SPATIAL_*` (TR444 has held N since §38).
- **§12.1** — `get_commitments` (`compass/CompassTools.ts:238#name: "get_commitments"`)
  under the gate that owns `trip_commitments`, and `get_saved_ideas`
  (`compass/CompassTools.ts:251#name: "get_saved_ideas"`) with names wrapped as user
  content.

**Seen red.** 262 tests over the touched suites, 0 skipped, after: the
signal suite (15) with the shuffle and the one-sided-share cases; the policy
suite (12) with the budget crossing and the bypass detector, which was seen to
fail against a file still calling `sendPushWithRetry`; the projection suite
(20) with an unread source, a refused context and a disagreeing pair of
zones; the replay suite (12) with a counted mismatch. `typecheck:tests`
ratchet unchanged (864 across 116); `check:schema-references`,
`check:writerless-reads`, `check:enum-literals`, `check:doc-citations`,
`check:flag-schema-prerequisites` (16 read sites, 0 unguarded) green.

### 42.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR199 `IGNORE \| PASSIVE \| SURFACE \| NOTIFY \| INTERRUPT` | W | **C** | `ATTENTION_LEVELS` is the spec's five as a cost ladder; `decideAttention` maps significance, party, deadline, budget, quiet hours and §17.2 mode to one level with reason codes. Twelve tests, budget and quiet hours among them. |
| TR200 §11.4 Trip events must pass an attention policy | W | **C** | The ten sites call `sendTripPush`; a kind with no profile is refused; only NOTIFY / INTERRUPT push; a test fails on any `sendPushWithRetry(` left in those files. |
| TR206 `getCommitments(tripId)` | N | **C** | `get_commitments`, under the gate that owns 2761's table. |
| TR207 `getSavedIdeas(tripId)` | N | **C** | `get_saved_ideas` over `trip_saved_places`, names as UGC. |
| TR208 `getLiveConditions(tripId)` | N | **C** | `get_live_conditions` → the pulse projection through the §19.1 rule; a stranger gets nothing. |
| TR299 Trip Pulse is not a generic city feed; it projects world intelligence through the active Trip context | N | **C** | `PulseContext` carries all seven axes; every kept signal names the axes it passed on, every dropped one its reason; the projection looks up only places the trip holds. |
| TR300 Signal: crowd rising | N | **C** | `crowd.level` / `crowd.trajectory` snapshots for saved places → `saved_idea_better_now` + `queue_risk_later`; interpretation is the spec's sentence. |
| TR301 Signal: rain arriving | N | **C** | `weather_cache` read → `plan_invalidated` for weather-sensitive plans that day + `fallback_opportunity` naming the indoor saved ideas. |
| TR302 Signal: taxi demand high | N | **C** | `transit.condition` → `transport_uncertainty` on taxi-like 2782 segments and commitments within six hours. |
| TR303 Signal: event delayed | N | **C** | `event.status` → `free_window_may_appear` + `downstream_conflict` on the later commitments. |
| TR304 Signal: friend nearby → meetup opportunity subject to both parties' privacy/presence | W | **C** | From the crew map, so every §10 rule applies first; surfaced only when BOTH share, the one-sided case dropped with `TRIP_PRIVACY_SCOPE`. |
| TR305 The `SignalEstimate` contract | N | **C** | `SignalEstimate<T>`: the seven fields plus `support`. |
| TR306 `value` + `confidence` | N | **C** | Best-supported value; confidence = best agreeing source × agreeing share, never raised by disagreement. |
| TR307 `sourceClass` | N | **C** | intel's `SourceClass`, ranked for tie-breaks only. |
| TR308 `observedAt` + `expiresAt` | W | **C** | Latest agreeing observation, earliest agreeing expiry; an expired observation is inadmissible, an expired estimate is dropped. |
| TR309 `fallbackUsed` | N | **C** | True for a pattern or prediction source, or a source that said so. |
| TR310 `contradictorySources[]` | N | **C** | Every disagreeing observation, with class, value, time and confidence. |
| TR311 Contradictory sources increase uncertainty; the system must not silently select | N | **C** | Support, then rank, then lexical value; shuffle-invariant by test; the function has no recommendation to make easier. |
| TR319 Commercial recommendations and entertainment discovery are suppressed when a severe operational or safety state requires attention | N | **W** | `prioritySwitch` derives it with `TRIP_DISRUPTION_SUPPRESSED`; the pulse drops discovery signals and the policy holds discovery pushes under it. The Compass brief (`TripPage.tsx:16`) and `search_places` / `search_events` do not consult it yet. |
| TR398 `notification_actionability_rate` | N | **C** | sent at dispatch / acted at `POST …/notifications/acted`, per kind, null over zero. No client calls the acted side yet (Cluster 13), so the rate reads truthfully low, not absent. |
| TR400 `trip_event_replay_mismatch_total` | N | **C** | Incremented by `verifyTripReplay` on `equal = false`; the kernel's own refusals are not mismatches; reached from `POST …/replay/verify`. |
| TR444 `TRIP_SPATIAL_*` | N | **C** | Every consistency finding carries `reasonCode` from `SPATIAL_REASON_CODES`; served in the feasibility route's `consistency.findings`. |
| TR448 `TRIP_DISRUPTION_*` | W | **C** | `_ACTIVE` from the register in `deriveTripHealth`, `_SUPPRESSED` from `prioritySwitch` and the pulse, `_NOT_FOUND` / `_NOT_ACTIVE` from the kernel — all four declared codes emit. |

**Held, with the reason.** TR317 and TR318 stay W: the switch now exists for
all three modes with the spec's orders, and no client surface applies them
(Cluster 13). TR396 / TR394 / TR395 / TR399 were C already; TR393 and TR397
are §41's and §13.3's respectively.

### 42.3 The ceiling, unchanged

Every row above reads a table 2760–2785 created, behind
`trip_operational_projections_enabled`, or pushes through a policy that runs
wherever the routes run. The projection rows carry §41.3's cap verbatim — no
database has the batch, the flag is FALSE in both — and the attention rows
carry none: `sendTripPush` is live the moment this branch is deployed. The
only rows whose next verdict is a client's to give are TR319, TR317 and TR318.

## 43. From content to executable experience, and the events that change the action universe

**Read against the branch `claude/sweet-fermat-fmx7up`.** §13 was the
largest block of N rows left in this document — thirty of them, from
"an experience compiler" (TR224) to `opportunity_created_total` (TR397) —
and every one described the same absence: nothing in the tree turned a
saved place into a plan that fits a free window, and nothing said when the
set of such plans had changed enough to matter. This section builds the
compiler (§13.1, §13.2), the opportunity engine (§13.3), the projection
that feeds them from the trip and records a significant change through the
kernel (2786), and the three §21.1 conversion metrics. Three migrations —
the engine command, the fold vocabulary (2787) and the ledger vocabulary
(2788) — applied on the replica; 2786 and 2787 also on a fresh build from the
production baseline through the chain: 39 database tests, 0 skipped.

### 43.1 What was built, and where

- **§13.2 the thirteen primitives** — `services/trips/TripExperienceCompiler.ts:37#export const ACTIVITY_PRIMITIVES`,
  the spec's vocabulary verbatim, with `primitiveFor` mapping a place type
  or name to one (`services/trips/TripExperienceCompiler.ts:58#export function primitiveFor`).
  Each has the ten per-candidate properties §13.2 names as defaults
  (`services/trips/TripExperienceCompiler.ts:101#export const PRIMITIVE_DEFAULTS`) that a
  candidate overrides field by field: minimum / ideal duration,
  compressibility, interruptibility, reversibility, cost band, energy cost,
  reservation requirement, queue distribution, accessibility constraints,
  failure / recovery routes. Six of the ten decide a verdict or a score
  (duration, compressibility, energy, reservation, queue, accessibility);
  the other four are carried on every experience for the consumer that
  needs them.
- **§13.1 the compiler** — `services/trips/TripExperienceCompiler.ts:286#export function compileExperiences`:
  the eight inputs as one typed record (`services/trips/TripExperienceCompiler.ts:165#export interface CompileInputs`)
  — candidates from content, the freedom window, participants, live signals
  (the pulse's), a travel estimator, goals and preferences, the next
  commitment — and one `ExecutableTripExperience` per candidate
  (`services/trips/TripExperienceCompiler.ts:209#export interface ExecutableTripExperience`)
  with three verdicts: EXECUTABLE, NOT_EXECUTABLE with the reason, and
  UNCERTAIN when something needed is unknown, which is never promoted
  (`services/trips/TripExperienceCompiler.ts:184#export const EXPERIENCE_VERDICTS`). §22.4's
  "closed-before-arrival activity cannot remain executable" is
  `EXPERIENCE_CLOSED_BEFORE_ARRIVAL` (`services/trips/TripExperienceCompiler.ts:19#§22.4`)
  and a property test over 300 generated windows and hours
  (`src/test/tripExperienceCompiler.test.ts:144#§22.4 property`). Deterministic: the same
  inputs give the same experiences in the same order, shuffled inputs
  included.
- **§13.3 the opportunity engine** — `services/trips/TripOpportunityEngine.ts:66#export interface OpportunityEvent`
  is the contract's eight fields plus `best` and `detail`; `diffOpportunities`
  (`services/trips/TripOpportunityEngine.ts:97#export function diffOpportunities`) is the
  change between two portfolios of one window, and significance is a
  function of that diff alone: none when the executable set is unchanged,
  low for a change that leaves the best option standing, medium when the
  best changes or an added option serves an open goal, high when an option
  was removed for a hard reason (`services/trips/TripOpportunityEngine.ts:84#export const HARD_REMOVAL_REASONS`)
  — the spec's rooftop — critical when the window or every option goes.
  `shouldNotify` is significance ≥ high (`services/trips/TripOpportunityEngine.ts:145#export function shouldNotify`);
  "weather changed" with no viable change is none, and the test says so in
  those words (`src/test/tripExperienceCompiler.test.ts:199#raw data`).
- **The projection** — `services/trips/TripOpportunityProjection.ts:182#export async function buildTripOpportunityProjection`:
  version first; health, freedom and pulse accepted against it; candidates
  from the crew's saved ideas with `closure.state` / `queue.wait` /
  `crowd.level` / `access.reservation` from `intel_state_snapshots` for the
  ones that name a canonical place; goals, accepted members, the viewer's
  position as origin when the window has none. Opening hours: this system
  stores none for a place, so a venue-bound candidate is UNCERTAIN, stated
  (`services/trips/TripOpportunityProjection.ts:255#no hours source in this system`). Compiled per
  open window, current-or-next first; the first window's portfolio is
  ledgered as `opportunity_portfolio` and diffed against the last one
  (`services/trips/TripOpportunityProjection.ts:139#async function readPreviousPortfolio`). Under
  AT_RISK / SAFETY_EVENT the executable list is served empty with the
  suppression named (`services/trips/TripOpportunityProjection.ts:294#suppressed`).
  Served at `GET /trips/:id/opportunities`
  (`routes/tripProjections.ts:321#/trips/:tripId/opportunities"`), to Compass as
  `get_opportunities` — §11.3's "Where next?"
  (`compass/CompassTools.ts:264#name: "get_opportunities"`) — as Today's
  `opportunities` layer, `no_source` since §40.3
  (`services/trips/TripTodayProjection.ts:239#opportunities = okLayer`), and as the map's
  `liveOpportunities` layer, `no_source` since §40.4
  (`routes/tripMapProjection.ts:372#§14.1 live opportunities`).
- **2786 `RECORD_OPPORTUNITY_CHANGE` → `trip.opportunities_changed`** —
  `src/migrations/2786_trip_kernel_opportunity_events.sql:63#WHEN 'RECORD_OPPORTUNITY_CHANGE' THEN`: an
  engine-capability command whose payload is the §13.3 contract, refused as
  malformed without a window, a trigger or a known significance, or with a
  non-array list. The projection issues it with actor_role `system` and an
  idempotency key made of the window and the diff
  (`services/trips/TripOpportunityProjection.ts:176#function diffKey`), so the same change
  found twice is one event (§22.4). Executed on the replica: the event row,
  the receipt, the malformed refusals, the stranger refused
  (`src/test/db/tripOpportunityEvents.db.test.ts:32#the engine (actor_role system`). A
  rollback that reverses the named edits and refuses an overrun
  (`db/rollback/2026-09-12-2786-trip-kernel-opportunity-events-rollback.sql`),
  rehearsed apply → rollback → apply.
- **Accepted and completed** — `POST /trips/:id/opportunities/:experienceId/accept`
  (`routes/tripProjections.ts:339#/trips/:tripId/opportunities/:experienceId/accept`) writes
  the plan the only way a plan is written: ADD_PLAN through the kernel with
  `source_type 'opportunity'`, keyed by the experience so a double tap is
  one plan; a non-executable experience is refused with its verdict and
  reasons. §21.1's three counters: `opportunity_created_total` where the
  projection first sees an executable experience,
  `opportunity_accepted_total` at that route,
  `opportunity_completed_total` where COMPLETE_ACTIVITY succeeds on an
  opportunity-sourced plan (`lib/tripOpportunityMetrics.ts:18#export function recordOpportunityCompletion`)
  — on the plan PATCH cutover (`routes/trips.ts:1966#recordOpportunityCompletion(planCommandTypeForPatch(patch)`)
  and the Compass autopilot, the two places that issue it.
- **2787 — the fold names every event** — `src/migrations/2787_trip_snapshot_fold_vocabulary.sql:53#WHEN t IN ('trip.stage_started','trip.stage_completed') THEN`:
  2773's `trip_snapshot_fold` met the eighteen event types 2779–2786 added
  with `unfolded`, so a snapshot taken after a started plan or a completed
  stage was wrong about the two §22.1 fields those events change. 2787
  transforms the fold: `plan_started` / `plan_skipped` join the plan-status
  branch, `stage_started` / `stage_completed` fold `state`, and the twelve
  types the snapshot does not carry are a NULL branch, named — because
  `trip_snapshot_seed` reads none of them, folding them would make a
  seed-replay and a snapshot-replay disagree. Its postcondition folds a
  started stage and a skipped plan and checks the answer. The contract test
  now reads the fold as installed, 2773 plus 2787
  (`src/test/tripSnapshotReplayContract.test.ts:143#The fold is 2773 plus every later transform`).
- **2788 — the ledger's vocabulary** — `src/migrations/2788_trip_decisions_ledger_vocabulary.sql:23#ADD CONSTRAINT trip_decisions_type_known`:
  2781's CHECK named three decision types; `pulse_projection` (§42),
  `opportunity_portfolio` and `opportunity_projection` (§43) were not among
  them, so every one of those rows would have been refused by the table —
  silently, because the ledger is best-effort. `check:enum-literals` caught
  the read side (`decision_type = 'opportunity_portfolio'` on a column that
  could not hold it); 2788 replaces the constraint under its own name, and
  the database test inserts each new type and one unknown one
  (`src/test/db/tripOpportunityEvents.db.test.ts:60#2788: the ledger accepts`).
- **Two older families, brought to the family contract** — 2779's event
  emissions were CASE expressions the contract test could not attribute; they
  are explicit branches now, each with its family set before it, with a base
  assertion, and 2779 has the rollback it lacked
  (`db/rollback/2026-09-12-2779-trip-kernel-plan-lifecycle-and-temporal-guard-rollback.sql`),
  rehearsed on a copy of the replica with 2780–2786 present. `TRIP_EVENT_TYPES`
  now names every event `trip_kernel_execute` assigns — fourteen from
  2779–2786 were missing (`lib/tripKernel.ts:484#plan lifecycle, subgroup, transport, disruption, derived and opportunity`).

**Seen red.** The compiler suite (12) failed on a 90-minute window that
left 33 minutes for a far candidate — the compiler was right and the test
was wrong, and the case now runs on 75; the projection suite (16) failed
three ways before it passed: a client that copies its tables, a fake kernel
that had to become a receipt table because the freedom projection issues
its own derived events through the same rpc, and the real clock on the
route; the family contract (92) failed on 2779 for three rules and on 2786
for three others until both were met. Then: `typecheck`, `typecheck:tests`
(864 across 116, unchanged), the fresh replica (baseline + 2093–2786, 39
database tests, 0 skipped).

### 43.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR224 An experience compiler producing `ExecutableTripExperience` | N | **C** | `compileExperiences` over the eight inputs; three verdicts; deterministic; §22.4 as a property. |
| TR226 …+ freedom window | N | **C** | The window bounds arrival and leave-by; travel both ways and `reservedMinutes` come off it; an uncertified window is a reason on every experience. |
| TR227 …+ participants | N | **C** | The window's participants ride on every experience; a participant's accessibility need against a candidate's constraint is `EXPERIENCE_ACCESSIBILITY_UNMET`. |
| TR228 …+ live conditions | N | **C** | The pulse's kept signals invalidate or favour candidates; intel closure / queue / crowd claims per saved place. |
| TR229 …+ transport | W | **W** | **Holds.** Travel to and back, by mode, from a `TravelEstimator` (straight-line, the provider's constants); 2782's segments exist (§41) and are not yet consulted for the leg. |
| TR230 …+ opening/queue constraints | W | **C** | `openingWindows` decide EXECUTABLE / `EXPERIENCE_CLOSED_BEFORE_ARRIVAL` / `_CLOSES_DURING_STAY`; unknown hours are UNCERTAIN, never promoted; a queue's p90 is subtracted and `EXPERIENCE_QUEUE_EXCEEDS_WINDOW` refuses. |
| TR231 …+ goals/preferences | W | **C** | `GOAL_PRIMITIVES` maps the spec's and 2762's goal types to primitives; an open goal served is named and scored; preferences (styles, energy) adjust the score. |
| TR232 …+ next commitment | N | **C** | `leaveBy` is the commitment's arrival less travel back and prep. |
| TR233 Activity primitives EAT … TRANSIT | W | **C** | The thirteen, verbatim, and a place-type → primitive mapping. |
| TR234–TR243 Per-candidate properties | N ×10 | **C ×10** | All ten on `CandidateProperties`, defaulted per primitive and overridable; six decide, four are carried (see §43.1). |
| TR244 The `OpportunityEvent` contract | N | **C** | `OpportunityEvent` with the eight fields, plus `best` and `detail`. |
| TR245–TR251 `trigger` … `expiresAt` | N ×7 | **C ×7** | Each set by `diffOpportunities`; `expiresAt` is the window's end. |
| TR252 `reasonCodes[]` on an opportunity event | N | **C** | `OPPORTUNITY_*` plus the hard-removal `EXPERIENCE_*` codes that caused a removal. |
| TR253 Notify only when the action universe changes enough to matter | N | **C** | `shouldNotify` is significance ≥ high; the rooftop case is HIGH and notifies as `plan_invalidated`; "weather changed" with no viable change is none. |
| TR263 Layer: live opportunities | N | **C** | The map's `liveOpportunities` is every open window's executable experiences that have a point, once per saved idea. |
| TR397 `opportunity_created_total` / accepted / completed | N | **C** | Three counters, at the projection, the accept route and the two COMPLETE_ACTIVITY issuers; read back in the tests. |
| TR413 §22.4 A closed-before-arrival activity cannot remain executable | N | **C** | `EXPERIENCE_CLOSED_BEFORE_ARRIVAL`, and a 300-case generated property: no EXECUTABLE arrives outside its hours or before its window. |

**Held, with the reason.** TR225 stays C (the content input predates this
section). TR195 and TR196 (§11.3 "Where next?" as a UX action, "Replan
today") are Cluster 14's and Batch C's: `get_opportunities` answers the
first for Compass, not for a screen.

### 43.3 The ceiling, unchanged

Every reader here sits behind `trip_operational_projections_enabled` and
every recorded event behind `trip_kernel_enabled`; 2786 joins 2779–2785
on §41.3's cap. The projection serves without a database that has 2786 —
the kernel refuses `RECORD_OPPORTUNITY_CHANGE` as unknown and
`recorded.failed` says so — which is the honest degraded state, not a
silent one.

## 44. Urgency, triggers, impact — and the four things a traveller asks when the day breaks

**Read against the branch `claude/sweet-fermat-fmx7up`.** This section is
the spec's operational judgement: §8's decision urgency and risk triggers,
§9.4's impact preview with §15.3's booking side effects, §11.3's replan
and §12.1's simulate / propose, §12.3's value of information, §14.3's
meeting point, §17.3's rescue, and two of §23's scenarios run end to end
as tests. Every engine here is a pure function over typed inputs
(`services/trips/Trip{DecisionUrgency,RiskTriggers,ImpactPreview,Replan,MeetingPoint,Rescue,ValueOfInformation}.ts`
— no I/O, no clock of their own); one loader and one service feed them
from the trip under the operational gate; five routes and five Compass
tools serve them. No migration, no new table, no new flag: everything a
route writes goes through the kernel as a command that already exists
(`CREATE_PROPOSAL`, `DECLARE_DISRUPTION`), and only when
`trip_kernel_enabled` is on.

### 44.1 What was built, and where

- **§8.2 decision urgency, not a due date** — `services/trips/TripDecisionUrgency.ts:85#decisionUrgency`:
  the four terms with the weights that sum to one
  (`services/trips/TripDecisionUrgency.ts:64#URGENCY_WEIGHTS`), four bands
  (`services/trips/TripDecisionUrgency.ts:65#URGENCY_THRESHOLDS`), a
  seven-day horizon; an undated decision with a severe consequence and
  everything downstream outranks a dated triviality, and the test says so
  (`src/test/tripDecisionRiskImpact.test.ts:38#chronological:`).
  Served on `GET /trips/:tripId/decisions`, where every task carries its
  `urgency` and the list is sorted by it
  (`routes/tripDecisions.ts:72#byUrgency`): downstream impact is derived —
  the commitments and plans that start within a day after the deadline —
  because `trip_decision_tasks` records no dependency, and availability
  decay has no producer on that route, so it is passed as unknown,
  contributes 0, and the term says so. The reads that feed it are soft:
  a failed one is named in `urgencyInputsUnread`, the decisions are still
  served.
- **§8.3 readiness by day and by stage** — `lib/tripReadiness.ts:264#groupReadinessByTime`
  groups the items under their `dueAt` day and under 2760's stages; the
  route reads `trip_stages` under the gate that owns them and passes them
  in (`routes/tripReadiness.ts:242#trip_stages`); `byStage` is `null`, not
  `[]`, when the stages were not read.
- **§8.4 the four register triggers** — `services/trips/TripRiskTriggers.ts:98#evaluateRiskTriggers`
  evaluates all four every time, fired or not, each with the spec's
  mitigation verbatim (`services/trips/TripRiskTriggers.ts:22#RISK_MITIGATIONS`):
  tight arrival past `services/trips/TripRiskTriggers.ts:90#TIGHT_ARRIVAL_THRESHOLD_MIN`
  names the downstream plans and their participants; weather-sensitive is
  forecast confidence × dependency — a kept pulse signal whose effect is
  `plan_invalidated` at confidence ≥ `services/trips/TripRiskTriggers.ts:92#WEATHER_CONFIDENCE_THRESHOLD`
  on a weather-bound plan; late check-in is an arrival estimate past the
  desk's deadline; crew transport mismatch is the party over the vehicle's
  seats (`services/trips/TripRiskTriggers.ts:94#DEFAULT_VEHICLE_CAPACITY`).
  On Today as `riskTriggers` (`services/trips/TripTodayProjection.ts:389#riskTriggers,`),
  reading 2782's segments under the same gate for the party-size row.
- **§9.4 the impact preview, §15.3 the booking side effects** —
  `services/trips/TripImpactPreview.ts:119#previewImpact` over a typed
  `ProposedChange` (five kinds, `services/trips/TripImpactPreview.ts:22#CHANGE_KINDS`):
  affected reservations, transport and participants; commitment conflicts
  through the freedom engine's overlap detection and the approach window;
  cancellation costs; safety / return implications; and the five §15.3
  fields on `bookingSideEffects` — booking at risk, cancellation deadline,
  potential cost, affected participants, required user confirmation — with
  `potentialCostMinor` **null** when the reservation carries no price,
  never zero. `governance` suggests the decision rule from who the change
  touches. The state is one read under the gate
  (`services/trips/TripImpactState.ts:16#loadImpactState`); the route is
  `POST /trips/:tripId/proposals/preview`
  (`routes/tripProjections.ts:410#/trips/:tripId/proposals/preview`).
- **§12.1 simulate** — `services/trips/TripReplan.ts:195#simulateChange`
  returns FEASIBLE / INFEASIBLE / UNKNOWN with the conflicts named and the
  freedom window as it would be after; judged, never written
  (`POST /trips/:tripId/simulate`,
  `routes/tripProjections.ts:421#/trips/:tripId/simulate`; Compass
  `simulate_plan`, `compass/CompassTools.ts:1133#toolSimulatePlan`).
- **§11.3 replan today, §12.1 createProposal** — `services/trips/TripReplan.ts:107#replanDay`
  produces the candidate diff: keep / move / cancel / add
  (`services/trips/TripReplan.ts:32#REPLAN_OPS`), each entry with its reason
  (`services/trips/TripReplan.ts:35#REPLAN_REASONS`) and, for a confirmed
  plan, its impact; a plan invalidated by a signal is cancelled and the best
  executable fallback from §13's compiler is added; a plan in conflict moves
  to the first free slot that clears it; plans downstream of a tight arrival
  move by its magnitude; locked and dropped plans obey the constraints.
  Shared mutations are the diff's `proposals`; nothing is written.
  `services/trips/TripReplanService.ts:23#computeReplan` feeds it from the
  trip (pulse, freedom, compiler). `POST /trips/:tripId/replan`
  (`routes/tripProjections.ts:436#/trips/:tripId/replan`) turns each proposal
  into `CREATE_PROPOSAL` only when the caller asks and the kernel is on —
  `proposal_type: replan_<op>`, the suggested decision rule, an idempotency
  key from the day, the op, the plan and the target time, `source: "replan"`
  on the payload — and says `trip_kernel_enabled is false` by name when it
  is not. Compass `replan_day` (`compass/CompassTools.ts:1190#toolReplanDay`)
  carries the same diff and names `create_proposal`
  (`compass/CompassTools.ts:1156#toolCreateProposal`) for the shared
  mutations; that tool goes through `CREATE_PROPOSAL` with
  `source: "compass"` and is refused by name without the kernel — TR210's
  unpersisted proposal object is gone.
- **§12.3 value of information** — `services/trips/TripValueOfInformation.ts:46#valueOfInformation`:
  value = probability the answer changes the decision × the stakes; above
  `services/trips/TripValueOfInformation.ts:42#VOI_ASK_THRESHOLD` it is a
  question, capped at `services/trips/TripValueOfInformation.ts:44#VOI_MAX_QUESTIONS`;
  below it stays represented as uncertainty. The unknowns come from §13's
  UNCERTAIN experiences (`services/trips/TripValueOfInformation.ts:67#unknownsFromExperiences`):
  one that could beat the best executable is worth a question, one that
  could not is not. `get_opportunities` carries the answer as
  `questionsWorthAsking` (`compass/CompassTools.ts:1126#questionsWorthAsking:`).
- **§14.3 the meeting point** — `services/trips/TripMeetingPoint.ts:94#findMeetingPoint`:
  least group burden, each journey weighted by the mode's reliability; the
  six constraints applied by name — next commitments, accessibility, party
  size, venue suitability (`services/trips/TripMeetingPoint.ts:91#MEETING_PRIMITIVES`),
  privacy policy, transport reliability — every refusal typed
  (`services/trips/TripMeetingPoint.ts:60#MEETING_REFUSALS`); the result is
  a recommendation **with** its alternatives by burden, its refusals with
  their reasons, the participants it could not place and why, and an
  explanation — never a coordinate. Positions come only through the crew
  map, so every §10 rule runs first and a participant not sharing is
  unplaced by name; candidates are the crew's saved ideas and the day's
  plans with a public point (`services/trips/TripReplanService.ts:49#computeMeetingPoint`).
  `POST /trips/:tripId/meeting-point`
  (`routes/tripProjections.ts:474#/trips/:tripId/meeting-point`); Compass
  `find_meeting_point` (`compass/CompassTools.ts:1207#toolFindMeetingPoint`).
- **§17.3 rescue** — `services/trips/TripRescue.ts:66#planRescue` over the
  seven typed problems (`services/trips/TripRescue.ts:18#RESCUE_PROBLEMS`):
  each plan declares a disruption at a severity, orders its steps by who
  acts, escalates to an institution — airline, airport, operator, property,
  embassy / consulate, local emergency, human support
  (`services/trips/TripRescue.ts:21#ESCALATION_TARGETS`) — or to the crew,
  with why and when, and says what Compass may and must not do; a safe
  return is proposed where the problem is a person. `POST /trips/:tripId/rescue`
  (`routes/tripProjections.ts:486#/trips/:tripId/rescue`) returns the plan
  (201) and declares the disruption through `DECLARE_DISRUPTION` — §17.2's
  switch — when the kernel is on, skipped by name when not; an unknown
  problem is 400. Compass `get_rescue_plan` (`compass/CompassTools.ts:1176#toolGetRescuePlan`)
  is read-only.
- **§23, two scenarios as tests** — `src/test/tripScenarios.test.ts:26#TR420`:
  a 75-minute ETA shift fires `tight_arrival`, names the downstream dinner
  and museum, and the replan moves both by the same 75 minutes and turns
  the shared one into a proposal. `src/test/tripScenarios.test.ts:56#TR423`:
  rain on a booked walking tour fires `weather_sensitive`, the tour leaves
  the portfolio and the museum enters it (HIGH, notify), the replan cancels
  the tour with its booking side effects — deadline, confirmation required
  — and adds the museum.

**Seen red.** The impact suite failed on `potentialCostMinor` (12 000 vs
13 500) until the engine separated the bookings' cost from the
cancellation cost; the meeting suite recommended a gym because an unknown
place type defaults to EXPLORE, which is suitable — the test now uses a
shopping mall, which is SHOP, which is not; the route suite for
`GET /decisions` went red twice, first as fulltest10's twenty-three
failures when an urgency read was fatal (it is soft now, and named), then
under `check:flag-polarity` for a flag name behind a constant; and the
Compass `replan_day` case was mutation-tested — `lockedPlanIds` dropped on
the way to the engine — and failed on "a locked plan is kept" before the
tool was restored. Then `typecheck`, the four suites (10 + 12 + 2 + 18 with
the Compass tools) and the census guards.

### 44.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR140 Unresolved decisions are first-class work items | W | **C** | Each task on `GET /decisions` carries a computed `urgency` with its terms and explanation, and the list is ordered by it; `trip_decision_tasks` is the work item. |
| TR141 `decisionUrgency = f(timeRemaining, availabilityDecay, downstreamImpact, consequence)` | W | **C** | `decisionUrgency` with the four terms and weights; served with derived downstream and an unknown availability term that says so. |
| TR143 Readiness … by upcoming day/stage | W | **C** | `groupReadinessByTime`: `byDay` always, `byStage` from 2760's stages read under the gate, `null` when not read. |
| TR145 §8.4 Weather-sensitive → indoor fallback | N | **C** | `weather_sensitive` fires on a kept pulse signal at confidence ≥ 0.5 against a weather-bound plan; the replan cancels it and adds the best executable fallback; `preferIndoor` weights the add. |
| TR146 §8.4 Late check-in → contact property | N | **W** | `late_check_in` fires on an arrival estimate past the desk's deadline, mitigation verbatim; Today passes no estimate and no deadline because no table carries either — the trigger is built, its inputs have no producer. |
| TR147 §8.4 Crew transport mismatch → split or larger vehicle | N | **C** | `crew_transport_mismatch` over 2782's segments: `party_size` or the accepted crew against the mode's seats; Today reads the segments under the gate. |
| TR156 §9.4 Impact preview before accepting a proposal | N | **C** | `previewImpact` over a typed change: affected reservations, transport, participants, commitment conflicts, cancellation costs, safety implications; `POST /proposals/preview`. |
| TR196 §11.3 "Replan today" → candidate diff; shared mutations become proposals | N | **C** | `replanDay`'s diff with `proposals`; `POST /replan` and `replan_day`; `CREATE_PROPOSAL` per shared mutation only when asked and only under the kernel. |
| TR209 `simulatePlan(tripId, proposal)` | N | **C** | `simulateChange`, `POST /simulate`, `simulate_plan`: FEASIBLE / INFEASIBLE / UNKNOWN with the window after; never written. |
| TR210 `createProposal(tripId, change)` | W | **C** | `create_proposal` issues `CREATE_PROPOSAL` through the kernel with a decision rule, expiry and the change; refused by name without the kernel; the old unpersisted object is gone. |
| TR211 `replanDay(tripId, constraints)` | N | **C** | `replanDay` with locked, dropped, `maxMoves`, `preferIndoor`; `computeReplan` from the trip; route and tool. |
| TR212 `findMeetingPoint(tripId, participants)` | N | **C** | `findMeetingPoint`; `computeMeetingPoint` with positions through the crew map; route and tool. |
| TR220 §12.3 Value of information before asking | N | **C** | `valueOfInformation`: probability × stakes against a threshold, capped; below it is uncertainty; on `get_opportunities`. |
| TR272 §14.3 A smart meeting-point service | N | **C** | `findMeetingPoint` — least group burden with the constraints applied by name. |
| TR273–TR278 §14.3 constraints: next commitments · accessibility · party size · venue suitability · privacy · transport reliability | N ×6 | **C ×6** | Each is a typed refusal or a weight, listed in `constraintsApplied`, and each has a test that turns it on. |
| TR279 §14.3 Explanation and alternatives, not a magic coordinate | N | **C** | `recommended` with `alternatives`, `refused`, `unplaced` and `explanation`. |
| TR291–TR295 §15.3 Explicit side effects on invalidating a booked activity | N ×5 | **C ×5** | `bookingSideEffects`: booking at risk · cancellation deadline · potential cost (null when unpriced) · affected participants · required confirmation; on the preview, the simulation and every replan cancel. |
| TR320 A rescue entry point | N | **C** | `POST /trips/:tripId/rescue` and `get_rescue_plan`; a typed problem in, a plan out. |
| TR321–TR327 Typed problems: missed transport … emergency assistance | N ×7 | **C ×7** | `RESCUE_PROBLEMS`, the seven verbatim; each with its own steps and escalation. |
| TR328 Compass organises context, escalates to the institution | W | **C** | `escalation[]` names the airline, airport, operator, property, embassy / consulate, local emergency or human support, with when; `compass.mustNot` is explicit. |
| TR420 §23 Flight delay on arrival | N | **C** | The scenario runs: trigger → downstream named → replan moves by the magnitude → shared mutation is a proposal. |
| TR423 §23 Rain invalidates tour | N | **C** | The scenario runs: trigger → portfolio changes (HIGH) → replan cancels with side effects and adds the fallback. |

**Held, with the reason.** TR142 stays W: the readiness score and its
explanation still both exist (§40 named the fight, this section did not
settle it). TR144 stays W: `tight_arrival` is built and tested, and Today
passes no ETA because no trip table carries one — the same shape as
TR146. TR195 stays W: "Where next?" as a screen action is Cluster 13's.

### 44.3 The ceiling, unchanged

Every route here sits behind `trip_operational_projections_enabled`, and
every write behind `trip_kernel_enabled`; both are seeded FALSE and §41.3's
cap holds. On a database without 2779–2788 the routes still serve their
judgement — a preview, a diff, a meeting point, a rescue plan — and the
kernel refuses the command they would issue; `proposals.skipped` and
`declared.skipped` say so by name rather than pretending.

## 45. The decision-diff harness, the Phase 0 inventory, and five rows the tree had already earned

**Read against the branch `claude/sweet-fermat-fmx7up`.** §24 asks for two
things no earlier section built: a corpus of Trip scenarios that the
planner's decisions are diffed against in CI, and a Phase 0 inventory of the
tables, routes and services against the kernel that freezes semantic drift
by documenting every write path. Both exist now, both are checks in
`check:all`, and both were seen red before they were seen green. Around
them: the last seven trip writes without a schema (TR51) parse one; the
map's tenth layer has a producer; the closeout's two deferred steps act;
§23's concurrent-edit scenario runs on the real kernel; and five rows —
TR189, TR375, TR393, TR379, TR75 — were N or W for something the tree
already contained when their verdicts were last read, which this section
re-derives and cites rather than argues.

### 45.1 What was built, and where

- **§24 the scenario corpus** — `scenarios/trips/corpus.ts:433#tripScenarioCorpus`:
  eight synthetic scenarios as typed inputs to the pure engines, six of them
  §23's own (solo city day, flight delay on arrival, rain on the booked tour,
  the six-person nightlife regroup, the booked dinner's cancellation, a venue
  closed before arrival) and two that put a temporal conflict and a safety
  event in front of every engine with a rule for one. Fixed instants, fixed
  points, a straight-line estimator: two runs of the same tree are the same
  bytes, and the test proves it. Nothing historical — no production row
  leaves production — and the file says so.
- **§24 the runner and the record** — `scenarios/trips/run.ts:119#runTripScenario`
  runs freedom, health and the priority switch, the pulse, the four
  triggers, urgency, impact preview + simulate, the compiler before and
  after the signals, the opportunity diff, replan, the meeting point, rescue,
  attention and §12.3's questions, into one canonical record that keeps
  verdicts and ids and drops free text, so a reworded explanation is not a
  changed decision. `scenarios/trips/run.ts:259#conservatismScore` is §24's
  "increased / decreased conservatism" made countable: every "no" the
  planner said counts one.
- **§24 the diff and its four classes** — `scenarios/trips/diff.ts:114#diffDecisions`:
  changed decisions by leaf path; conservatism before → after, per scenario,
  as a direction and never a verdict; new conflicts, keyed by kind and the
  commitments and plans they name, and resolved ones; and a LARGE diff when
  more than `scenarios/trips/diff.ts:25#LARGE_DIFF_RATIO` of a scenario's
  leaves moved. Every diff is unexplained until someone regenerates the
  golden **with a note** — `scenarios/trips/golden.ts:35#writeGolden` refuses
  an empty one — which is how "unexplained large diffs" becomes a thing the
  file can say.
- **§24 the CI gate** — `src/scripts/checkTripDecisionDiff.ts:39#--update`
  is `check:trip-decision-diff`, in `check:all`
  (`artifacts/api-server/scripts/run-all-checks.sh:231#check:trip-decision-diff`):
  exit 1 with the classified report when a decision moved, exit 2 when it
  cannot run. `golden.json` is the tree's record with the note that explains
  its last change. The test (`src/test/tripDecisionDiff.test.ts:102#mutation`)
  produces each class by the mutation that should produce it — a trigger
  flipped in the golden is one changed leaf and conservatism *increased* in
  the tree; a conflict deleted from the golden is a NEW CONFLICT; a scenario
  emptied is LARGE; a scenario added or removed is named — and holds the
  same contract CI does: the golden equals a fresh run.
- **§24 Phase 0, the inventory** — `src/scripts/tripWritePathInventory.ts:79#buildTripInventory`
  generates, from the tree, every `trips | trip_*` table with the migration
  that created it and the kernel migrations that write it, the kernel's
  command vocabulary (69), the server files that issue commands, the 76
  direct write paths around the kernel, the 150 `/trips` routes each
  classified by what its handler does (kernel / direct / both / neither),
  and the trip modules; renders it into
  `docs/architecture/trips-phase0-inventory.md:52#trip-write-path-inventory:begin`
  between markers under a hand-written reading of what "do not big-bang
  rewrite" means; and `check:trip-write-path-inventory` (`check:all`) fails
  when the document's block is not the tree's, line by line
  (`src/scripts/tripWritePathInventory.ts:203#blockDrift`). The freeze is on
  *undocumented* drift: a new table, route or direct write path is red until
  it is in the document in the same commit
  (`src/test/tripWritePathInventory.test.ts:60#drift`).
- **§4.1 TR51, the last seven** — `/invite` and `/members`
  (`routes/trips.ts:1151#InviteMemberSchema`, `routes/trips.ts:1152#AddMemberSchema`),
  `/join-request`, `/invite-link` and the three checklist writes
  (`routes/trips-expansion.ts:920#InviteLinkSchema`,
  `routes/trips-expansion.ts:922#ChecklistItemPatchSchema`) parse a zod schema
  first, accepting what the hand-rolled checks accepted and refusing only a
  wrong type; `check:trip-write-validation` counts 54 of 54 and its
  shrink-only list is empty (`src/scripts/checkTripWriteValidation.ts:47#KNOWN_UNVALIDATED`).
- **§14.1 the tenth layer** — `safetyPoints` was `no_source`; it is the
  viewer's own pending / active Safe Return sessions and a crew member's
  when they opted to notify the crew, placed at the plan each guards (a
  private anchor's plan yields no point, §14.4), plus 2782's transport
  segment endpoints through `public.places` under the gate that owns that
  table (`routes/tripMapProjection.ts:396#safe_return_sessions`,
  `routes/tripMapProjection.ts:442#transport_endpoint`); a layer is one status,
  so `safetyLogisticsReading` on the response says which half was assembled
  (`routes/tripMapProjection.ts:393#safetyLogisticsReading`;
  `src/test/tripMapProjection.test.ts:460#guards,`). One layer has no producer
  now: crew presence summaries.
- **§20.2 the two deferred steps** — `close_operational_decision_tasks` is
  actionable when pending tasks exist and the service issues
  `UPDATE_DECISION_TASK { status: expired }` per task through the kernel,
  keyed by the closeout, deferred by the flag's name when the kernel is off
  (`services/trips/TripCloseout.ts:113#expire`,
  `services/trips/TripCloseoutService.ts:143#UPDATE_DECISION_TASK`);
  `archive_rebuildable_projections` reads the §21.2 ledger's rows still
  within retention and ends their retention at completion
  (`services/trips/TripCloseout.ts:116#retention`,
  `services/trips/TripCloseoutService.ts:81#retain_until`); both tested with
  the kernel off and on (`src/test/tripCloseout.test.ts:108#closeout:task:t1`).
- **§23 concurrent host edits, on the database** — `src/test/db/tripConcurrentEdits.db.test.ts:54#TRIP_VERSION_CONFLICT`:
  device B moves the dinner at version *v*; device A's move at the same *v*
  is `TRIP_VERSION_CONFLICT`, appends nothing, and B's move stands; A's
  impact preview over the re-read row is B's dinner; A retries at *v+1* and
  lands; the same stale command replayed by its key is the same refusal.
- **Five rows the tree had already earned.** TR189: Today has carried
  `pulseSignals` since §42 (`services/trips/TripTodayProjection.ts:120#pulseSignals:`).
  TR375: `POST /trips/:tripId/simulate` was registered in §44
  (`routes/tripProjections.ts:421#/trips/:tripId/simulate`). TR393:
  `trip_command_rejected_total` by reason has existed in the kernel client
  and been asserted three times (`lib/tripKernel.ts:496#readTripCommandRejectedTotal`,
  `src/test/tripKernel.test.ts:110#counter`). TR379 and TR75: 2520's map
  projection worker consumes the outbox, idempotent by event id through
  `trip_map_projection_applied` and retried by `attempts`
  (`src/migrations/2520_trip_map_projection_worker.sql:53#trip_map_projection_applied`),
  is scheduled at boot (`lib/mapTripProjectionWorker.ts:124#startTripMapProjectionScheduler`,
  `src/index.ts:163#startTripMapProjectionScheduler()`), and §41's pipeline
  test drains it twice on a real database and the second drain applies
  nothing (`src/test/db/tripKernelPipeline.db.test.ts:127#§19.4`).

**Seen red.** The decision-diff harness reported its own first real
change — one leaf, `best`, when the runner's record of the opportunity
event was corrected — before its golden was regenerated; the corpus test
asserted the nightlife meeting point would be the café and the engine chose
the station, because bo's train back at the far end pulls the least-burden
point toward him (the test now accepts either and pins the refusals). The
inventory test failed three ways: `trips` is created by the baseline, not
by any file in `src/migrations` (the inventory now says "baseline"); the
command-union scan stopped at a semicolon inside a comment and found 35 of
69 commands; the plan PATCH path was mis-remembered. The write-validation
guard read the word `req.body` in a comment I placed inside the DELETE
handler's range and counted a 55th endpoint until the comment changed. The
map suite's two `no_source` assertions went red when the tenth layer gained
a producer. Then `typecheck`, the affected suites (114), the two database
tests on the local replica, and every static check this tree runs without
live credentials.

### 45.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR51 Command service validates schema | W | **C** | 54 of 54 trip writes parse a zod schema; the shrink-only list is empty and a new unvalidated write is red. |
| TR75 Workers publish / retry idempotently | W | **C** | 2520's outbox consumer: idempotent by event id (`trip_map_projection_applied`), retried by `attempts`, scheduled at boot; the second drain applies nothing on a real database. |
| TR150 Attendance as an explicit relation used downstream | N | **W** | The impact preview's affected participants are the plan's GOING / MAYBE attendance, not the crew; transport, budget and the meeting point still take a stated party. |
| TR189 `pulseSignals[]` | N | **C** | On Today since §42, as a layer with its source stated. |
| TR264 Layer: safety / logistics points | N | **C** | Safe Return sessions at the plan they guard (own, and crew-notified), transport endpoints under the gate; `safetyLogisticsReading` names the half not read. |
| TR375 `POST /trips/:id/simulate` | N | **C** | Registered in §44; judged, never written. |
| TR379 Projection workers consume outbox entries, idempotent by event id + version | N | **C** | `mapTripProjectionWorker` over 2520's drain, applied-set by event id, source_trip_version = the aggregate's, tested on the replica. |
| TR386 …close operational decision tasks | N | **C** | `UPDATE_DECISION_TASK { status: expired }` per pending task at closeout, keyed, behind the kernel flag and deferred by its name. |
| TR389 …archive rebuildable operational projections | N | **C** | The §21.2 ledger's rows within retention have their retention ended at completion; every other projection is per request, and the step says so. |
| TR393 `trip_command_rejected_total` by reason | N | **C** | In the kernel client since the counter's section; asserted for three reasons. |
| TR409 Decision-diff CI over historical / synthetic scenarios | N | **C** | Eight synthetic scenarios, a deterministic record, a golden with a note, `check:trip-decision-diff` in `check:all`. |
| TR410 …changed decisions, conservatism, new conflicts, unexplained large diffs | N | **C** | The four classes, each produced by the mutation that should produce it. |
| TR422 §23 Concurrent host edits | N | **C** | On the real kernel: stale version refused, nothing written, preview over the new state, retry lands. |
| TR433 §23.1 Scenario / replay tests across engines | W | **C** | The corpus runs thirteen engines per scenario and §41's pipeline test replays; the harness diffs them. |
| TR434 §24 Phase 0 inventory; freeze semantic drift | N | **C** | Generated inventory of 49 tables, 69 commands, 76 direct write paths, 150 routes; the document's block must be the tree's or CI is red. |

**Held, with the reason.** TR380 stays W: 2520's `trip_map_projection_rebuild`
exists and nothing executes it in a test. TR97 stays W: decision tasks now
expire and the ledger's retention ends at closeout, risks still have no
expiry. TR387 stays W: `trip_activity_log` still has no policy. TR221 stays
W: §12.3's uncertainty is represented on `get_opportunities`, not yet on the
brief.

### 45.3 What CI said on 005b71f02, and what changed for it

The head that carried §42–§44 came back with three reds this section owns,
none of them a verdict moving. **The throwaway-database job** failed on
one run and passed on the other for the same commit: §41's pipeline test
asserted that a second outbox drain applies *nothing*, and the drain is
global while the database suites run in parallel — a sibling suite's event
landed between the two drains. The assertion is now this trip's: its
applied set does not grow and its outbox is empty
(`src/test/db/tripKernelPipeline.db.test.ts:138#appliedAfterFirst`).
**`check:trip-push-policy`** listed ten bypass sites that §42 had routed
through `sendTripPush`; the list is empty and the guard proves the zero by
counting exactly one direct dispatch in the router itself
(`src/scripts/checkTripPushPolicy.ts:75#routerCalls`). **`check:write-path-columns`**
named 2782 and 2785's tables and 2783's `trip_goals.scope` / `weight` as
absent from the CI schema — true until merge, ledgered where 2780/2781/2784
already were (`src/scripts/checkWritePathColumns.ts:203#trip_transport_segments`) —
and one read it could not see: the pulse's seven context reads took a table
*name*, and now take a built query
(`services/trips/TripPulseProjection.ts:151#PromiseLike`). Making them
visible showed `check:flag-schema-prerequisites` the class it exists for —
a file naming `trip_crew_map_enabled` (ON in production) and reading
kernel-era tables — so the crew half of the pulse is its own module, as
§43 did for the opportunity projection
(`services/trips/TripPulseCrewPresence.ts:37#readCrewPresenceForPulse`).
Two guards were unregistered (`src/scripts/guardRegistry.ts:624#checkTripDecisionDiff`),
and this census watched 77 % of the files it cites against an 86 % floor:
the kernel-era migrations, their rollbacks, the database suites, the trip
guards and the trip test files are in scope now — 90 % — and every one of
them is on the freshness ledger with the section that graded rows on it.

### 45.3 The ceiling, unchanged

The closeout's two new actions run behind `trip_operational_projections_enabled`
and `trip_kernel_enabled`, both seeded FALSE; the map's transport endpoints
behind the first; the harness and the inventory are build-time and run
everywhere. §41.3's cap holds: merge, then the live-DB apply, then the
owner's Batch C, then the flags.

## 46. Evidence per policy, reasons on the wire, and the rows a real database had already settled

**Read against the branch `claude/sweet-fermat-fmx7up`.** Thirteen W rows
whose remaining gap was one of three kinds: a policy that existed for one
class and not another (§5.3, §20.2), a reason code decided inside and
never carried out (Appendix B), or a proof the tree could give and no test
had asked for (§4.2, §19.4). One migration — 2789, on a production table —
applied and rolled back on the replica and applied on a fresh baseline
with every database suite green; no new flag, no new table.

### 46.1 What was built, and where

- **§5.3 / §20.2 the activity log's policy** — `src/migrations/2789_trip_activity_log_retention.sql:36#retain_until`:
  `trip_activity_log` kept eleven event types indefinitely with a free-form
  `metadata` nobody minimised. It now has what 2781 gave the decision
  ledger: `retain_until`, a year from the row's own `created_at` and never
  before it, `trip_activity_log_prune()` for service_role that reports the
  count, and a CHECK that refuses a coordinate key in `metadata` — added
  `NOT VALID` on purpose, so it binds every new row while the legacy rows
  are counted in the postcondition (0 on the replica) rather than promised
  clean; `VALIDATE CONSTRAINT` is the owner's, once that count is known on
  production. Rollback rehearsed apply → rollback → apply
  (`db/rollback/2026-09-12-2789-trip-activity-log-retention-rollback.sql:11#retain_until`);
  the suite inserts a coordinate and is refused, ages a row out and prunes
  it, keeps the live one, and is refused the prune as a client role
  (`src/test/db/tripActivityLogRetention.db.test.ts:54#trip_activity_log_prune`).
- **§5.3 the operational class, the last third** — decision tasks expire
  at closeout since §45; open risks close with them now:
  `services/trips/TripCloseoutService.ts:148#UPDATE_RISK` issues
  `UPDATE_RISK { status: closed }` per open risk, keyed by the closeout,
  behind the kernel flag and deferred by its name, and the planner names
  both counts (`services/trips/TripCloseout.ts:50#riskIds`;
  `src/test/tripCloseout.test.ts:109#closeout:risk:r1`). Readiness has had a
  staleness rule since 0170; the class is policy-controlled end to end.
- **§4.2 the two events the census graded on the wrong path** —
  `trip.participant_joined` and `trip.trip_completed` were W because
  `trip_activity_log` records a join and a completion best-effort, outside
  the transaction, with none of the five fields. The kernel path has all
  five, and `src/test/db/tripLifecycleEvents.db.test.ts:45#trip.participant_joined`
  proves it on the database: the invitee's ACCEPT_INVITE and the owner's
  COMPLETE_TRIP each append their event at the next aggregate version,
  caused by the command, correlated by the envelope, `schema_version` 1,
  with a receipt naming the event, the membership and the lifecycle moved
  in the same transaction — and nothing written to the activity log.
- **§19.4 / §5.3 the rebuild, proved** — `src/test/db/tripMapProjectionRebuild.db.test.ts:59#trip_map_projection_rebuild`:
  2520's `trip_map_projection_rebuild` regenerates the map projection
  byte-equal to the drain's, at the aggregate version, with a fresh
  `generated_at`, every applied row naming a real event — and the trip's
  version, events and plans are what they were. With that, §5.3's derived
  class reads as it should: Today and Compass are generated per request
  under §19.1's envelope, the map is materialised with a rebuild and
  freshness metadata, the ledger has `retain_until`.
- **Appendix B, three families carried out.** `TRIP_TEMPORAL_INFEASIBLE`
  and `_UNKNOWN` were declared and never emitted: §12.1's simulation
  verdict now carries `reasonCode` beside `feasibility`
  (`services/trips/TripReplan.ts:186#reasonCode:`;
  `src/test/tripSimulateReasonCodes.test.ts:33#TRIP_TEMPORAL_UNKNOWN`), and
  the decision-diff harness reported the new leaf on all six scenarios that
  simulate before its golden was regenerated with the note. `TRIP_PRESENCE_GHOST`
  / `_HIDDEN` were decided by `canSeePresence` and rendered as a label: the
  crew card carries `presenceReason` now, null when presence is shown
  (`lib/tripCrewLocation.ts:125#presenceReason:`;
  `src/test/tripCrewPresenceReason.test.ts:37#TRIP_PRESENCE_HIDDEN`).
  `TRIP_COMMAND_SENSITIVE_DOMAIN` is new: §4.1's "validates sensitive-domain
  boundaries" held by construction — documents, health and payments had
  their own routes — and is a check now: a payload key that names a travel
  document number, a health fact or a payment instrument, at any depth, is
  refused by name before the kernel is called and counted
  (`lib/tripKernel.ts:624#sensitiveDomainKey`,
  `src/test/tripKernelSensitiveDomain.test.ts:47#TRIP_COMMAND_SENSITIVE_DOMAIN`).
- **§14.1 "active" means in progress now** — 2779 gave plans
  `in_progress`; the map's active-plans layer says which points are
  (`routes/tripMapProjection.ts:223#inProgress`) and `activePlanReading`
  says the reading changed. The write-path inventory moved one line for
  this section — the closeout is an `UPDATE_RISK` issuer — and CI held the
  document to it.
- **Two rows the tree had already earned.** TR186: Today's
  `opportunities` has been a layer with a producer since §43
  (`services/trips/TripTodayProjection.ts:114#opportunities:`;
  `src/test/tripTodayProjection.test.ts:64#opportunities.status`). TR221:
  uncertainty is a value in four places now — a signal's confidence, a
  window's `certified`, an experience's UNCERTAIN verdict, and §12.3's
  `representedAsUncertainty` on `get_opportunities`, which is the row's
  own sentence (`services/trips/TripValueOfInformation.ts:38#representedAs:`;
  `src/test/tripReplanMeetingRescue.test.ts:165#capped;`).

**Seen red.** The decision-diff harness reported eight new leaves across
six scenarios (`$.impact[i].reasonCode: ∅ → null`) and refused until the
golden was regenerated with the note — the class it exists for, on its own
author. The Phase 0 inventory refused the tree until `UPDATE_RISK` was in
the closeout's row. The closeout test's kernel-on case asserted one call
and got two. Then `typecheck`, the thirteen affected suites (200), the
three database suites on the replica and on a fresh baseline through 2789
(48), and every guard this tree runs without live credentials.

### 46.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR56 …validates sensitive-domain boundaries | W | **C** | `sensitiveDomainKey` refuses a document, health or payment key at any depth before the kernel; `TRIP_COMMAND_SENSITIVE_DOMAIN`, counted. |
| TR63 §4.2 `trip.participant_joined` | W | **C** | Appended by ACCEPT_INVITE at the next version, caused, correlated, schema-versioned, receipted — proved on the database. |
| TR67 §4.2 `trip.trip_completed` | W | **C** | Appended by COMPLETE_TRIP with the same five fields; the lifecycle moved in the same transaction. |
| TR97 §5.3 Operational class expires / archives after usefulness | W | **C** | Tasks expire and risks close at closeout through the kernel; the ledger's retention ends; readiness has its staleness rule. |
| TR99 §5.3 Derived class rebuildable with TTL / freshness metadata | W | **C** | The map rebuild proved from events with `generated_at` and the aggregate version; Today / Compass per request under the envelope; the ledger's `retain_until`. |
| TR100 §5.3 Historical evidence class policy-controlled, minimised | W | **C** | 2789: `retain_until` and a prune for the activity log, a CHECK against coordinate keys; the decision ledger had both. |
| TR186 `opportunities[]` on Today | W | **C** | A layer from §13's compiler since §43, `ok` with its source stated. |
| TR221 §12.3 Uncertainty represented, not questionnaire friction | W | **C** | Confidence on signals, `certified` on windows, UNCERTAIN verdicts, `representedAsUncertainty` on the tool. |
| TR257 Layer: active plans | W | **C** | `in_progress` (2779) is active; each point carries `meta.inProgress` and the reading says so. |
| TR380 §19.4 Rebuild jobs regenerate projections without changing business state | W | **C** | `trip_map_projection_rebuild` executed: same body as the drain, version and freshness stamped, version / events / plans untouched. |
| TR387 §20.2 …preserve decision / audit evidence per policy | W | **C** | The activity log's policy is a column and a prune; the ledger's was already. |
| TR443 `TRIP_TEMPORAL_*` | W | **C** | All four emitted: `_RANGE_INVERTED` and `_CONFLICT` by the kernel and the engine, `_INFEASIBLE` / `_UNKNOWN` by the simulation verdict. |
| TR446 `TRIP_PRESENCE_*` | W | **C** | `_NOT_SELF` / `_NOT_FOUND` by 2768; `_GHOST` / `_HIDDEN` on the crew card as `presenceReason`. |

**Held, with the reason.** TR119 stays N: the guard against announcing a
future absence needs a policy on the public preview and a flag to carry it,
which is the next section's. TR137 stays N: a transport-mode policy needs
a column on `trips`. TR412 stays W: no routed provider certifies a window.
TR89, TR382, TR403, TR405, TR407, TR408, TR424, TR425 and TR427 stay W
for the reasons their rows give; none of them moved here.

### 46.3 The ceiling, unchanged

2789 joins 2779–2788 on §41.3's cap: applied on the replica and a fresh
baseline, absent from portava-ci until this branch is merged, absent from
production until the owner's Batch C. The closeout's risk closing runs
behind both flags; the reason codes and the rebuild proof run everywhere.

## 47. The absence guard, the retention sweep, stage local time, and the transport-mode policy

**Read against the branch `claude/sweet-fermat-fmx7up`.** Two N rows and
two W rows whose gap was not a proof or a reason code but a whole thing:
a guard on the §6.3 preview (TR119), a policy for §7.4 to check against
(TR137), a bound on the one raw text the tree kept forever and a sweep
that makes both retention policies run rather than exist (TR403), and the
wall clock a multi-city day is lived in (TR424). Four migrations — 2790
and 2792 seed flags FALSE, 2791 bounds a column on a production table,
2793 adds a table — each applied and rolled back on the replica, then
applied on a fresh baseline with every database suite green (52 / 52).
Every rule below went red under a mutation before its commit; the
mutations are named with the rows.

### 47.1 What was built, and where

- **§6.3 the absence guard (TR119)** — `lib/privacy/absenceDisclosure.ts:40#absenceDisclosure(trip:`
  is pure and decides one thing: while `trip_absence_guard_enabled` is on,
  a trip whose `start_date` is after today (UTC) withholds both dates from
  the non-member preview whatever `show_exact_dates` says — the toggle
  defaults TRUE (0077) and the client sends it as true when unset, so it
  cannot tell "opted in" from "never asked". A trip that starts today, has
  started, or has no start date is not a future absence. The reason is
  Appendix B's new `TRIP_PRIVACY_FUTURE_ABSENCE`
  (`lib/tripReasonCodes.ts:85#TRIP_PRIVACY_FUTURE_ABSENCE`). The route reads
  the flag and passes the decision (`routes/trips-expansion.ts:3251#absenceDisclosure(t,`);
  the serializer renders it — both dates null and
  `datesWithheld: "future_absence"`, the key absent otherwise so a preview
  that carries no dates because of the toggle is byte-for-byte what it was
  (`lib/privacy/tripSerializers.ts:78#preview.datesWithheld`;
  `lib/privacy/dtos.ts:242#datesWithheld?:`). 2790 seeds the flag FALSE
  (`migrations/2790_trip_absence_guard_flag.sql:36#trip_absence_guard_enabled`).
  `test/tripAbsenceGuard.test.ts:73#future_absence` exercises the decision on
  both sides of today, the serializer both ways, and the route through the
  app with the flag on, off and absent; `tripPrivacy.test.ts` passes
  unmodified. Mutations: the route not passing the decision (1 red), the
  serializer not stamping the key (2 red).
- **§21.3 / §5.3 the raw text bounded, and the sweep that enforces both policies (TR403)** —
  `trip_reservations.raw_text` kept the pasted booking email verbatim,
  indefinitely, "for re-extraction". 2791 gives it `raw_text_retain_until`
  — thirty days from the row's own creation, existing rows from theirs —
  and `migrations/2791_trip_reservation_raw_text_retention.sql:56#trip_reservations_forget_raw_text()`
  for service_role, which nulls the text past its deadline and reports the
  count; 2784's history trigger records the forget as an `updated` event
  naming `raw_text`, so the history says the text was forgotten and when
  without keeping it. Rollback rehearsed apply → rollback → apply
  (`db/rollback/2026-09-12-2791-trip-reservation-raw-text-retention-rollback.sql:20#trip_reservations_forget_raw_text();`);
  the suite ages a paste past its deadline, forgets it, reads the version
  bump and the event, keeps the live one, and is refused as a client role
  (`test/db/tripReservationRawTextRetention.db.test.ts:44#forgotten`). Then
  the part 2789 lacked too: nothing in the database called either
  function. `lib/tripRetentionScheduler.ts:55#runTripRetentionSweep(opts:`
  calls `trip_activity_log_prune()` and `trip_reservations_forget_raw_text()`
  every six hours while `trip_retention_sweep_enabled` reads TRUE, each on
  its own so one failure does not stop the other, DISABLED / NO_CLIENT /
  ERROR told apart; 2792 seeds the flag FALSE with both functions as its
  precondition (`migrations/2792_trip_retention_sweep_flag.sql:36#trip_retention_sweep_enabled`);
  `index.ts` starts it (`src/index.ts:167#startTripRetentionScheduler();`).
  `test/tripRetentionScheduler.test.ts:53#BOTH` pins the flag gate, both rpc
  names, the string-count coercion and the partial failure. Mutation: the
  flag check removed (2 red).
- **§7 stage local time and instant order (TR424)** — 2760's stages carry
  a `timezone` each; the timeline never used it. `services/trips/TripTimelineProjection.ts:203#stageLocalTime(`
  gives each plan item the wall clock of the stage whose interval contains
  its start instant (`services/trips/TripTimelineProjection.ts:176#stageContaining(ms:`,
  `[startsAt, endsAt)`, lowest sequence when several), the trip's own zone
  outside every stage, and nothing — stated — when there is no zone or the
  zone is one the runtime does not know; the instant itself is never
  changed. `services/trips/TripTimelineProjection.ts:243#orderByInstant<T`
  orders a day's items by the instant, whatever zone each was typed in.
  The route reads the stages under the operational gate as /readiness does,
  refuses when they are unreadable, applies both, and says which zone rule
  it used (`routes/tripProjections.ts:193#withStageLocalTimes(rows.map`;
  `routes/tripProjections.ts:142#stageZoneReading`). `test/tripTimelineStageLocalTime.test.ts:25#Asia/Tokyo`:
  a Lisbon item at 08:00Z reads 09:00, a Tokyo item at 23:30Z reads 08:30
  the next day, the boundary instant belongs to the later stage, and two
  items typed in two zones sort by when they happen. `tripProjections.test.ts`
  passes unmodified. Mutation: the stage zone ignored (3 red).
- **§7.4 the transport-mode policy and the route-availability check (TR137)** —
  2793 creates `trip_transport_policies`: one row per trip naming the modes
  it does not use, a CHECK holding the vocabulary to the provider's
  (`migrations/2793_trip_transport_policies.sql:50#trip_transport_policies_modes_known`),
  crew-readable through RLS, written by nobody but the server. Rollback
  rehearsed (`db/rollback/2026-09-12-2793-trip-transport-policies-rollback.sql:16#public.trip_transport_policies;`);
  the suite has "taxi" refused, the owner reading the row and an outsider
  not, and the owner refused a direct UPDATE
  (`test/db/tripTransportPolicies.db.test.ts:36#trip_transport_policies_modes_known`).
  `services/trips/TripTransportPolicy.ts:96#checkRouteAvailability(` asks the
  provider once per mode against the temporal engine's own deadline and
  answers AVAILABLE, POLICY_BLOCKED (`TRIP_SPATIAL_ROUTE_UNAVAILABLE` — the
  spec's sentence, the mode named), NO_MODE_FITS (`TRIP_TEMPORAL_INFEASIBLE`,
  agreeing with the engine rather than contradicting it) or UNCHECKABLE,
  never AVAILABLE on an unknown (`services/trips/TripTransportPolicy.ts:55#POLICY_BLOCKED`).
  The feasibility route reads the policy under the gate, checks every hop,
  and feeds the §7.4 report: a blocked hop is INCONSISTENT with
  `ROUTE_ONLY_BY_DISALLOWED_MODE` (`services/trips/TripSpatialConsistency.ts:79#ROUTE_ONLY_BY_DISALLOWED_MODE`;
  `services/trips/TripSpatialConsistency.ts:338#routeAvailabilityFindings(`),
  and with the policy read the report can fold to CONSISTENT for the first
  time; with the gate off the permanent UNCHECKABLE stands, its reason
  re-worded to what is now true (`routes/tripFeasibility.ts:317#trip_transport_policies`).
  The owner sets the policy through `PUT /trips/:tripId/transport-policy`
  — zod on the body, §6.1 `canEditTrip` deciding who, the gate deciding
  whether there is a table to write (`routes/tripFeasibility.ts:468#transport-policy",`;
  `routes/tripFeasibility.ts:480#canEditTrip(sc,`). `test/tripTransportPolicy.test.ts:44#fitsOnlyByDisallowed,`
  derives the hop that fits by road and not on foot from the provider's
  constants; `test/tripTransportPolicyRoute.test.ts:129#TRIP_AUTH_NOT_OWNER`
  drives the app: owner 200, member 403 with the reason, "taxi" 400, gate
  off refused by name, and the three feasibility outcomes (blocked,
  available, gate off). The two existing feasibility suites pass unmodified;
  `tripSpatialConsistency.test.ts` gained the new reason's producing path.
  Mutations: the policy ignored (2 red), the owner gate removed (1 red).

### 47.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR119 §6.3 …must not leak future absence from home | N | **C** | `absenceDisclosure` withholds a not-yet-begun trip's dates from the non-member preview while 2790's flag is on, whatever the toggle says, and the preview says why (`datesWithheld`, `TRIP_PRIVACY_FUTURE_ABSENCE`); proved through the route with the flag on, off and absent. |
| TR137 §7.4 Route-availability check (feasible by taxi but transport-mode policy says no taxi) | N | **C** | 2793's policy, the per-mode check, `TRIP_SPATIAL_ROUTE_UNAVAILABLE` on the hop and `ROUTE_ONLY_BY_DISALLOWED_MODE` in the §7.4 report, the owner's PUT; proved on the database and through the route. |
| TR403 …without retaining unnecessary sensitive raw data | W | **C** | `raw_text` has a thirty-day deadline and a forget function that leaves the history saying so; the retention sweep calls it and 2789's prune on a timer behind 2792's flag. |
| TR424 Cross-timezone multi-city — correct instant ordering and stage local-time display | W | **C** | Each item carries its stage's wall clock from 2760's `timezone`, the trip's outside every stage, nothing when there is none; days order by the instant; the route says which rule applied. |

**Held, with the reason.** TR13 stays W: 2760's stages now give the
timeline its zones and readiness its groups, and plans still key to
`day_date` rather than to a stage; this section does not re-derive it.
TR134 stays W: the route-availability check does not make the feasibility
verdict routed — a straight-line FEASIBLE is still FEASIBLE_UNVERIFIED
(TR412). TR100 and TR387 hold C with stronger evidence: the policy they
rest on is now enforced by a sweep, not only declared by a column. TR89,
TR382, TR405, TR407, TR408, TR425 and TR427 stay W for the reasons their
rows give; none of them moved here.

### 47.3 The ceiling, unchanged

2790–2793 join 2779–2789 on §41.3's cap: applied on the replica and a
fresh baseline, absent from portava-ci until this branch is merged, absent
from production until the owner's Batch C. The two new flags are seeded
FALSE and are the owner's to turn on — the absence guard changes a public
surface, the sweep deletes evidence past its policy — and the transport
policy's read and write run behind `trip_operational_projections_enabled`
with 2793 in that capability's schema. Stage local time renders with the
trip's own zone alone until that gate is on. Nothing here is deployed,
enabled or production-realised.

## 48. Offline: the bundle, the queue, and what a reconnecting member is allowed to do

**Read against the branch `claude/sweet-fermat-fmx7up`.** §18 had nothing:
no bundle, no queue, no reconnect path, three `TRIP_OFFLINE_*` codes
declared and never emitted, and the §23 "offline member for 6h" scenario
untestable because there was nothing to test. This section builds the
SERVER'S half of §18 — the bundle a client would store, the contract a
client's queue would carry, and the replay a reconnecting client would
get — and says plainly that no client stores or queues anything yet
(Cluster 13). No migration: the kernel's receipts (2420) and versions are
the mechanism; the offline path is what asks them the §18.3 questions.

### 48.1 What was built, and where

- **§18.1 the signed, versioned bundle (TR334)** — `services/trips/TripOfflineBundle.ts:159#buildOfflineBundle(`
  assembles next commitments (in deadline order, past ones dropped), the
  active plan (in progress, else the next confirmed), the plans, the
  critical addresses (reservations, commitments, upcoming plans) and the
  certified context, stamped `sourceTripVersion` (§18.4) and `expiresAt`;
  what it does not carry — the selected route, meeting points, map tiles —
  is a named empty field, not an omission. `services/trips/TripOfflineBundle.ts:103#signOfflineBundle(`
  signs the canonical bytes with HMAC-SHA256 under
  `TRIP_OFFLINE_BUNDLE_SECRET` (SESSION_SECRET as the tree's usual
  fallback, no default); `services/trips/TripOfflineBundle.ts:109#verifyOfflineBundle(`
  is constant-time and false for anything edited. `GET /trips/:tripId/offline-bundle`
  (`routes/tripOffline.ts:60#offline-bundle",`) reads the trip's version, its
  plan and reservations (no `raw_text`), and its commitments under the
  operational gate, and refuses (503) rather than issue an unsigned bundle
  when no secret is configured. `test/tripOfflineBundle.test.ts:85#version_behind`
  and `test/tripOfflineRoute.test.ts:134#unsigned` pin the contents, the
  round trip, the tamper case and the refusal. Mutation: any signature
  verifies (2 red).
- **§18.1 stale is visible (TR342)** — `services/trips/TripOfflineBundle.ts:123#bundleStaleness(`:
  past `expiresAt`, or read at a version the trip has moved past,
  `TRIP_OFFLINE_BUNDLE_STALE` says which, and a stale bundle is still the
  last certified context, not the current one. The replay endpoint dates
  the bundle a client carries back. On the wire; no screen renders it.
- **§18.2 the contract and the rule (TR343, TR349, TR451)** —
  `services/trips/TripOfflineQueue.ts:45#QueuedTripOperationSchema` is the
  spec's seven fields, strict; `services/trips/TripOfflineQueue.ts:112#classifyQueuedOperation(`
  decides one of three things for each operation, in the order the
  traveller acted (`services/trips/TripOfflineQueue.ts:138#orderQueuedOperations<T`):
  *replay* for the offline-safe list (`services/trips/TripOfflineQueue.ts:64#OFFLINE_SAFE_TYPES`
  — join/leave plan, attendance, presence, start/skip a plan, a vote, each
  in the kernel's vocabulary and each issuable), with its own idempotency
  key and expected version; *revalidate* for a sensitive or high-conflict
  type the client has not checked against the current version —
  `TRIP_OFFLINE_REVALIDATION_REQUIRED`, with the version to use — and
  replay once it has; *reject* for a type the kernel does not have or a
  cutover-gated plan write with its own route, or a `clientOccurredAt` in
  the future or past the seven-day horizon — `TRIP_OFFLINE_QUEUE_REJECTED`,
  with why. `POST /trips/:tripId/operations` (`routes/tripOffline.ts:136#operations",`)
  reads the canonical version first and refuses the whole queue when it
  cannot, replays through `executeTripCommand` with the operation id as the
  correlation, holds everything with `TRIP_KERNEL_UNAVAILABLE` per operation
  when the kernel flag is off, and answers the whole queue — counts of
  replayed, duplicates, conflicts, revalidate, rejected, refused — so one
  refusal hides nothing. `test/tripOfflineQueue.test.ts:67#horizon` pins the
  rule; `test/tripOfflineRoute.test.ts:157#TRIP_OFFLINE_REVALIDATION_REQUIRED`
  drives the app: the order, the duplicate's receipt, the held sensitive
  operation that never reaches the kernel, the conflict that overwrites
  nothing, the rejected types, the flag off, the bundle current / behind /
  edited. Mutations: a sensitive operation replaying unrevalidated (2 red),
  the order dropped (2 red), the flag ignored (1 red).
- **§22.4 the duplicate, and §23's offline member, on the real kernel (TR417, TR421)** —
  `test/db/tripOfflineReplay.db.test.ts:47#TR417`: a member's queued
  JOIN_PLAN replayed twice with its key is one transition — the version
  moves once, one event exists, one attendance row, `duplicate: true` with
  the first receipt's version the second time. Then the owner moves the
  trip on while the member is away: the member's SET_PLAN_ATTENDANCE queued
  against the old version is `TRIP_VERSION_CONFLICT`, the attendance row is
  what it was and the version did not move; revalidated against the
  current version, the same edit lands. That is §18.3's "never simple
  last-write-wins" and §18.4's "server aggregate version is canonical",
  executed rather than described.

### 48.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR334 A signed/versioned offline bundle | N | **W** | The server issues one — signed, versioned at the trip's version, dated, verifiable, refused unsigned; the mobile client stores nothing yet (Cluster 13). |
| TR343 The `QueuedTripOperation` contract | N | **C** | §18.2's seven fields as a strict schema on the wire, enforced by the replay endpoint; a client naming the actor is refused. |
| TR349 Sensitive or high-conflict mutations may require revalidation after reconnect | N | **C** | A sensitive operation not checked against the current version is held with `TRIP_OFFLINE_REVALIDATION_REQUIRED` and the version to use, and never reaches the kernel; checked, it replays. |
| TR417 §22.4 A duplicate command with the same idempotency key cannot produce a duplicate state transition | C | **C** | **Holds**, on a second proof: §39 moved it on `tripKernelLive.test.ts`; now a queued JOIN_PLAN replayed twice with its key is one version, one event, one row, `duplicate: true` on the database, and the same through the replay route. |
| TR421 Offline member for 6h — queue/reconnect, stale presence, no destructive last-write-wins | N | **W** | Queue/reconnect and no-LWW executed on the real kernel and through the route; stale presence is §10's freshness on the wire (TR342 W) and no client renders it or queues anything. |
| TR451 `TRIP_OFFLINE_*` | N | **C** | All three emitted: `_REVALIDATION_REQUIRED` and `_QUEUE_REJECTED` by the queue rule, `_BUNDLE_STALE` by the staleness rule, each through the replay endpoint. |

**Held, with the reason.** TR335–TR341 and TR344–TR348 stay N as the
groups they are recorded as: four of the seven bundle contents (next
commitments, active plan, critical addresses, certified context) and three
of the five offline-safe operations (join/leave plan, presence, the
low-risk edits) are now on the wire, but the rows say what the CLIENT
caches and queues, and it caches and queues nothing; the group verdicts
are not split here. TR342 stays W for the same reason. TR350 stays W: a
saved idea is not a kernel command and the replay says so. TR354 stays W:
the version is canonical and enforced, and the kernel path is off
everywhere (§41.3).

### 48.3 The ceiling, unchanged

No migration. The bundle route reads baseline tables and, under the
operational gate, 2761's commitments; the replay route issues through the
kernel, which is off in every database but the local replica until the
owner's Batch C and the flag. The signing secret is an environment value
the owner sets; without it no bundle is issued. Nothing here is deployed,
enabled or production-realised.

## 49. Newest observation, set operations on reconnect, a producer for late check-in, and a check that had been running all along

**Read against the branch `claude/sweet-fermat-fmx7up`.** Four W rows whose
gap was small and specific: a presence write that let a stale device
overwrite a fresher fix (§18.3), a saved-ideas merge that had set storage
and no set operations (§18.3), a risk trigger with no producer for its two
inputs (§8.4), and a §7.4 check graded before it existed. No migration:
every change is server code on baseline tables, and each rule went red
under a mutation before its commit.

### 49.1 What was built, and where

- **§18.3 presence: the newest valid observation (TR351)** — `POST /me/location-state`
  stamped every fix with the server's receipt time, so a phone that had
  been offline and replayed its last fix on reconnect moved the traveller
  back in time — last-write-wins across stale devices, the thing the row
  names. A client may now say WHEN it observed the fix
  (`coords.observedAt`; `routes/location.ts:39#observedAtOf(v:` refuses the
  far future); that instant becomes `last_known_at`, and a fix observed
  before the one already stored is not written over it
  (`routes/location.ts:159#staleObservation`): the rest of the request
  (permission, place, manual city) still applies, and the client is told —
  200, `observation: "stale_ignored"`, `TRIP_PRESENCE_STALE`, both instants
  named. A client that sends no `observedAt` is the legacy shape and gets
  the receipt time exactly as before. Expiry and confidence were already
  §10's (TR160, TR162). `test/tripPresenceNewestObservation.test.ts:69#stale_ignored`
  drives the app both ways and pins the skew rule. Mutation: the guard
  never firing (1 red).
- **§18.3 saved ideas as set operations, idempotent (TR350)** —
  `trip_saved_places` is a set keyed (trip, member, place) and the
  interactive route refuses a duplicate; what §18.3 asks for is the MERGE
  on reconnect. §48's queue now carries `SAVE_IDEA` / `UNSAVE_IDEA` as set
  operations (`services/trips/TripOfflineQueue.ts:79#SET_OPERATION_TYPES`;
  their payloads are strict, `services/trips/TripOfflineQueue.ts:80#SaveIdeaPayloadSchema`),
  and the replay route applies them by identity — union then no-op,
  difference then no-op — answering `added` / `already_present` /
  `removed` / `already_absent` and moving no aggregate version, because a
  bookmark is not trip state (`routes/tripOffline.ts:192#applySetOperation(`).
  A concurrent add of the same element is the same element: the unique key
  refuses it and the answer is `already_present`. `test/tripOfflineRoute.test.ts:192#already_present`
  replays save, save, unsave, unsave and reads the set empty with the
  kernel untouched; `test/tripOfflineQueue.test.ts:82#UNSAVE_IDEA` pins the
  classification and the malformed case. Mutation: an add that never
  notices the element is present (1 red).
- **§8.4 late check-in has a producer (TR146)** — the trigger was built in
  §44 and Today fed it two columns no table carries. The freedom projection
  now reports, per placed commitment, when the traveller is estimated to
  arrive — the previous commitment's departure plus the hop's travel term
  and this commitment's prep, a lower bound like every travel term here,
  null when the hop could not be estimated (`services/trips/TripFreedomProjection.ts:179#arrivalEstimates.push(`);
  Today takes that as `estimatedArrivalAt` and a lodging's required arrival
  as its desk deadline (`services/trips/TripTodayProjection.ts:328#checkInDeadlineAt:`).
  `test/tripTodayProjection.test.ts:84#late_check_in`: a hotel whose desk
  closes ten minutes after the traveller leaves the previous commitment,
  ten kilometres away, fires with the minutes over the desk; the same
  commitment as an event does not. Mutation: the desk deadline dropped
  (1 red).
- **§7.4 the place-identity check, re-derived (TR135)** — the row's reason
  predates §40.3: "there is no check that runs, reports or blocks". There
  is. `services/trips/TripSpatialConsistency.ts:276#checkPlaceIdentity(`
  finds two plan items that share a location NAME and disagree on the
  canonical place id (`SAME_NAME_DIFFERENT_PLACE`, `TRIP_SPATIAL_PLACE_IDENTITY`
  on the wire), the feasibility route runs it on `trip_plan_items` — a
  baseline table — and folds it into the §7.4 report
  (`routes/tripFeasibility.ts:410#checkSpatialConsistency(planRows`), and
  `test/tripSpatialConsistency.test.ts:201#SAME_NAME_DIFFERENT_PLACE` pins
  the finding, the non-finding and the fold. No code changed for this row;
  the census did.

### 49.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR135 §7.4 Place-identity check (external booking and hidden gem sharing a name but not identity) | W | **C** | `checkPlaceIdentity` runs in the feasibility route over `trip_plan_items`, reports `SAME_NAME_DIFFERENT_PLACE` with its Appendix B code and folds to INCONSISTENT; the row's "no check that runs" was §29's reading. |
| TR146 §8.4 Risk: late check-in → contact property / alternate entry plan | W | **C** | The trigger's two inputs have producers: the freedom projection's per-hop arrival estimate and a lodging's required arrival as its desk deadline; fires on Today with the minutes over. |
| TR350 §18.3 Saved ideas / reactions merge as set operations with idempotency | W | **C** | `SAVE_IDEA` / `UNSAVE_IDEA` replay from the reconnect queue as union / difference by identity, idempotent by construction, answering what changed; the interactive route's set storage and duplicate refusal stand. |
| TR351 §18.3 Presence: newest valid observation with expiry/confidence; never simple last-write-wins across stale devices | W | **C** | A fix observed before the stored one is not written over it (`TRIP_PRESENCE_STALE`, both instants named); expiry and confidence were §10's already; the legacy shape is unchanged. |

**Held, with the reason.** TR136 stays W: the stage-locality check runs on
`trip_stages`, which no database but the local replica has (2760). TR342
stays W: the bundle and the pulse say stale on the wire; no screen says it.
TR352 and TR354 stay W: the version and the If-Match conflict are real and
the kernel path is off everywhere (§41.3). TR344–TR348 stay N as the group
they are recorded as: four of the five offline-safe operations now replay
— join/leave plan and presence through the kernel, save idea as a set
operation, low-risk edits through the kernel — and no client queues any.

### 49.3 The ceiling, unchanged

No migration. The presence guard and the set operations run on baseline
tables in every deployment the moment this merges and deploys; the
arrival estimates ride the freedom projection, which reads 2761's
commitments under the operational gate. Nothing here is deployed, enabled
or production-realised.

## 50. The thirty-eight inline checks, converted

**Read against the branch `claude/sweet-fermat-fmx7up`.** One W row whose
gap was a number: §6.1 says application code calls policy functions
rather than scattering host checks, and `check:trip-policy-callsites`
counted thirty-eight inline copies of "is this the owner / a host / a
member / the row's own creator" across three route files — a ratchet that
refused growth and had no floor. This section gives the policy module the
five decisions those copies were spelling, converts every site, lowers the
ratchet to zero, and proves the routes behave as they did: every existing
route suite passes unmodified, and each refusal now carries its Appendix B
reason beside the message it always had.

### 50.1 What was built, and where

- **The vocabulary** — `lib/tripPolicy.ts:238#canAccessTripContent(` (the
  owner or any accepted crew role; `TRIP_AUTH_NOT_CREW`),
  `lib/tripPolicy.ts:254#canHostTrip(` (owner or co-host; `TRIP_AUTH_NOT_HOST`),
  `lib/tripPolicy.ts:271#canContributeToTrip(` (owner, co-host or member — a
  viewer reads and does not contribute; `TRIP_AUTH_ROLE_NOT_PERMITTED`),
  `lib/tripPolicy.ts:288#canEditOwnOrAsOwner(` (the owner or the row's own
  creator — a document, a note, a saved place, a checklist;
  `TRIP_AUTH_NOT_CREATOR`), `lib/tripPolicy.ts:304#canSeePrivateContributions(`
  (the owner alone), `lib/tripPolicy.ts:318#tripRoleOf(` (the role reader the
  budget routes needed), and two PURE helpers for the branch picks that are
  not refusals — `lib/tripPolicy.ts:332#isTripOwner(` and
  `lib/tripPolicy.ts:341#planEditPermits(`, §6.2's plan-edit rule that
  `GET /trips/me` was spelling inline. Every function takes `given`, so a
  route that has already read the trip and the membership pays no second
  read. `test/tripPolicy.test.ts:374#TR102` pins each decision on every role.
- **The sites** — thirty-three in `routes/trips-expansion.ts`, four in
  `routes/trips.ts`, one in `routes/tripBudgetIntel.ts`. Owner-only
  refusals (update, cancel, complete, archive, delete, the three invite-link
  routes, remove member, reorder) ask `canEditTrip`
  (`routes/trips-expansion.ts:596#cancelAuth`); host gates (destinations,
  budget, activity log) ask `canHostTrip` (`routes/trips-expansion.ts:1976#addDestAuth`);
  contributing gates (destination dates, checklist items) ask
  `canContributeToTrip` (`routes/trips-expansion.ts:2155#datesAuth`); the
  document / note / saved-place / checklist edits ask `canEditOwnOrAsOwner`
  (`routes/trips-expansion.ts:2417#docEdit`); the document and note lists ask
  `canAccessTripContent` and then `canSeePrivateContributions` for the
  private rows (`routes/trips-expansion.ts:2289#canSeePrivateContributions(sc,`);
  the budget gate asks `tripRoleOf` (`routes/tripBudgetIntel.ts:76#tripRoleOf(sc,`);
  the plan-editability filter and the owner-skip on an invite notification
  use the pure helpers (`routes/trips.ts:1528#planEditPermits(trip,`). Every
  refusal keeps the message it had and adds `reason`.
- **The ratchet, at zero** — `scripts/checkTripPolicyCallsites.ts:75#"src/routes/trips-expansion.ts": 0,`:
  the baseline is zero for all three files and the check counts callers of
  the eight new names; a new inline check in any trip route fails the build.

### 50.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR102 Application code calls policy functions rather than scattering host checks | W | **C** | Zero inline host/owner checks remain in the trip routes (`check:trip-policy-callsites`, floor 0); the thirty-eight became five policy decisions with Appendix B reasons, and every route suite passes unmodified. |

**Held, with the reason.** TR47 and TR48 stay W: authorization is a
policy call now, and the plan-status write is still the cutover-gated
legacy path (§41.3). TR378 stays W: ninety-seven direct endpoints are
ninety-seven direct endpoints, better guarded.

### 50.3 The ceiling, unchanged

No migration, no flag. The policy module runs in every deployment the
moment this merges and deploys; the routes answer exactly what they did,
with a reason beside it. Nothing here is deployed.

## 51. Sensing that rises only when it must, the crew in Compass, and four rows the tree had already earned

**Read against the branch `claude/sweet-fermat-fmx7up`.** Two builds and
four re-derivations. The builds: a §10.3 sensing policy (TR172) and the
§12.1 `getCrewState` Compass tool (TR204). The re-derivations: rows graded
before §40.3, §43 and §44 built what they name — §11.3's "Where next?"
(TR195), §12.4's determinism (TR223), and the two §23 scenarios the census
called half-proved (TR418, TR419). No migration.

### 51.1 What was built, and where

- **§10.3 sensing frequency (TR172)** — there was no sampling-rate concept
  and no rule that raised one. `lib/tripSensingPolicy.ts:68#decideSensing(`
  is the rule: idle (fifteen minutes) when nothing is executing and nobody
  is at risk; execution (two minutes) when §3.2's phase is `ACTIVE_PLAN`,
  `TRANSIT` or `DISRUPTED`, the next leave-by is within the hour, or §17.2
  has the trip `AT_RISK`; safety (thirty seconds) when a Safe Return is
  active for a crew member or the trip is in §17.2's `SAFETY_EVENT` mode —
  the highest level that applies, with every reason that did, and `idle`
  for a trip not in progress today. Today publishes it as `sensing`
  (`services/trips/TripTodayProjection.ts:124#sensing:`) from the phase, the
  attention mode, the next leave-by and the crew's Safe Return count it
  already derives. `test/tripSensingPolicy.test.ts:30#outranks` pins the
  ladder; the Today suite reads `idle` on the base fixture. Nothing here
  turns sensing on: a client with location off has nothing to sample.
- **§12.1 `getCrewState(tripId)` (TR204)** — Compass had `who_is_around`, a
  Circle-scoped presence tool, and nothing trip-scoped. `compass/CompassTools.ts:1261#toolGetCrewState(`
  reads the crew map (`getCrewMap`, which decides §6.1's presence rules per
  member) for the current or a named trip the user is an accepted member
  of, and hands the conversation each member's status label, area,
  freshness class, observed-at, confidence, Safe Return / live-share flags
  and presence reason — never a coordinate (`exactCoords` is dropped, and
  TR216's tool-result guard refuses one besides). Off when
  `trip_crew_map_enabled` is off, and it says so. `test/tripCompassCrewState.test.ts:148#exactCoords`
  drives it against the crew-map fixtures: a live-sharing member with an
  area and no coordinates, a ghost with `TRIP_PRESENCE_GHOST`, a non-member
  refused, the flag off.

### 51.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR172 §10.3 Increase sensing frequency only when execution/safety requires it | W | **C** | A sampling-rate policy with three levels and the reasons that raise it, published on Today from the phase, the attention mode, the next leave-by and the crew's Safe Return count; safety outranks execution outranks idle, and four mutations (Safe Return ignored, the flag skipped, the card leaked, a safety mode invented) went red. |
| TR195 §11.3 "Where next?" → queries feasible opportunity portfolio using current crew/time/world state | W | **C** | §43's opportunity projection is that query — the open freedom window, the crew's participants, the live signals and a travel term, compiled into executable experiences — served on `GET /trips/:tripId/opportunities`, on Today's `opportunities` layer and through Compass's `get_opportunities`; the row's reason predates it. |
| TR204 `getCrewState(tripId)` | W | **C** | A trip-scoped Compass tool over the crew map, coordinate-free, §6.1-decided per member, flag-gated and saying so. |
| TR223 §12.4 Today, commitments, route chains, confirmed plans, crew state, safety state and notifications are deterministic services/projections; AI is not a safety dependency | W | **C** | Today, commitments, plans, crew state, safety state and the attention router are deterministic builders (§40–§44) with no model in the path; the two LLM extractions the row names land `pending_confirm` and reach no projection until a person confirms them — that is AI kept out of the safety path, not a dependency on it. |
| TR418 Solo 3-day city trip — lifecycle, Today, free windows, saved-to-plan conversion | W | **C** | Lifecycle, Today, free windows and the conversion each have a producer and a test now: the corpus's `solo_city_day` runs the freedom, health, pulse and compile engines end to end and is decision-diffed in CI; the row's "Today and free windows have nothing to prove" predates §40.3–§40.5. |
| TR419 6-person nightlife trip — attendance, subgroup split/rejoin, presence privacy, route chain | W | **C** | Attendance (2772, executed on the database), subgroup split and rejoin (2780, `LEAVE_SUBGROUP` keeps the history and `JOIN_SUBGROUP` re-activates it, executed), presence privacy (three suites) and the route chain are four of four; the corpus's `nightlife_crew_meetup` runs the meeting point and the pulse over them. |

**Held, with the reason.** TR116 stays W: `privacy_scope` is 2770's and no
database but the replica has it, so the legacy write path cannot set it.
TR407 and TR408 stay W: every event carries `schema_version = 1` and no
consumer in this tree reads a payload in TypeScript, so an adapter would
have nothing to adapt. TR153 stays W: the proposal's `rationale`,
`impactSummary` and `decisionRule` are payload, not columns (2763). TR435
stays W for its two reasons, the second of which is §41.3's flag.

### 51.3 The ceiling, unchanged

No migration, no flag. The sensing policy rides the Today projection,
behind the operational gate like the rest of Today; the Compass crew tool
runs behind `trip_crew_map_enabled`, seeded FALSE in production. Nothing
here is deployed, enabled or production-realised.

## 52. Meeting checkpoints, the regroup that switches priority, and Safe Return on a subgroup

**Read against the branch `claude/sweet-fermat-fmx7up`.** Four W rows,
one migration. §10.4's meeting checkpoint existed as two labels (TR177);
§11.3's "Return / regroup" was a Safe Return that switched nothing (TR198);
the map's meetup layer was a label on an ordinary plan item (TR262); and
Safe Return attached to a trip and a plan but never to a subgroup (TR329).
2794 builds the table the four share, the kernel family that writes it,
and the column §17.4 needed.

### 52.1 What was built, and where

- **2794 — `trip_meeting_checkpoints`, `trip_meeting_checkpoint_participants`,
  `safe_return_sessions.subgroup_id`, and the kernel's `meeting` family**
  (`migrations/2794_trip_meeting_checkpoints.sql:76#CREATE TABLE public.trip_meeting_checkpoints`).
  A checkpoint is a place the crew or a subgroup agreed to meet — coordinates,
  a label, an optional meet-by, why (`regroup | planned | safety`), the
  §14.3 explanation it was chosen with, and a status (`open | met |
  cancelled`); each expected participant carries an arrival state
  (`pending | en_route | arrived | late | no_show`) and the instant they
  arrived, with a CHECK that `arrived` and `arrived_at` agree. The kernel
  gains `CREATE_MEETING_CHECKPOINT` (every participant must be accepted
  crew — `TRIP_MEETING_PARTICIPANT_NOT_CREW`; a subgroup checkpoint names an
  active subgroup the actor is in; the whole crew or the subgroup's current
  members by default), `SET_MEETING_ARRIVAL` (a participant's own state
  only — `TRIP_MEETING_NOT_PARTICIPANT`) and `CLOSE_MEETING_CHECKPOINT`
  (creator or host; only from `open` — `TRIP_MEETING_INVALID_TRANSITION`),
  spliced by 2764's method with the same anchor counts 2780 used, three
  events (`trip.meeting_checkpoint_created` / `_arrival_set` /
  `_checkpoint_closed`), RLS crew SELECT only, no client writer. Applied,
  rolled back (`../../db/rollback/2026-09-12-2794-trip-meeting-checkpoints-rollback.sql:51#regexp_replace`)
  and re-applied on the local replica; `test/db/tripMeetingCheckpoints.db.test.ts:67#TRIP_MEETING_NOT_PARTICIPANT`
  executes all three commands, their refusals, the subgroup default and the
  Safe Return column's CHECK on the real kernel — and went red when the
  participant check was cut out of the branch.
- **§11.3 "Return / regroup" (TR198)** — `services/trips/TripMeetingCheckpoints.ts:134#export async function regroup(`
  computes §14.3's meeting point (`computeMeetingPoint`, which now also
  returns the candidates it considered), takes the recommended option, or
  the alternative the caller picked, or a point the crew already agreed on,
  and issues `CREATE_MEETING_CHECKPOINT` with the whole computation —
  chosen-by, alternatives, refusals, the unplaced and why — as the
  checkpoint's `explanation`; nothing recommendable and no point given is
  `TRIP_MEETING_NO_CANDIDATE` with the alternatives and the unplaced, and
  nothing reaches the kernel. `POST /trips/:tripId/regroup`
  (`routes/tripMeetingCheckpoints.ts:88#router.post("/trips/:tripId/regroup"`)
  serves it behind the operational gate and the kernel flag, with `GET
  /trips/:tripId/meeting-checkpoints` and the arrival and close commands
  beside it. **The switch.** An open regroup or safety checkpoint with
  someone still expected is a `REGROUP_OPEN` health reason
  (`services/trips/TripHealth.ts:47#"REGROUP_OPEN"`), which §17.2's switch
  reads as `SAFETY_EVENT` — location coordination — so Today's `attention`
  suppresses discovery, its `unresolvedActions` carries a `regroup` action
  naming who has not arrived, and §51's sensing goes to the safety rate;
  when everyone has arrived or the checkpoint is closed the reason is not
  derived and the switch is `NORMAL` again. The route says so in words
  (`prioritySwitch`) rather than writing a priority anywhere.
  `test/tripHealthProjection.test.ts:138#REGROUP_OPEN → SAFETY_EVENT` and
  `test/tripTodayProjection.test.ts:219#kind === "regroup"` pin the flip and
  the flip back; `test/tripMeetingCheckpointsRoute.test.ts:82#chosenBy` pins
  the route.
- **The map's meetup layer (TR262)** — `routes/tripMapProjection.ts:246#kind: "meeting_checkpoint"`:
  an open checkpoint is a `meeting_checkpoint` point in the `meetupPoints`
  layer in its own right, read under the operational gate (whose probe now
  names 2794's tables), beside the plan-item label the layer already had.
  The offline bundle carries the open checkpoints with the viewer's own
  arrival state (`services/trips/TripOfflineBundle.ts:70#BundleMeetingPoint`),
  so §18.1's "meeting points" is no longer an empty array with an excuse.
- **§17.4 Safe Return on a subgroup (TR329)** — `safe_return_sessions.subgroup_id`
  (CHECK: needs a trip); `POST /me/safe-return/sessions` accepts
  `subgroupId` and verifies, under the operational gate, that it names an
  active subgroup of that trip the caller is currently in
  (`routes/safeReturn.ts:312#parsed.data.subgroupId`); the crew alert goes to
  that subgroup's current members rather than the whole crew
  (`services/safeReturn/SafeReturnNotificationService.ts:396#trip_subgroup_members`).
  The column is written only when named, so a database without 2794 still
  starts a solo or full-crew session; `check:flag-schema-prerequisites`
  ledgers the two Safe Return flags' new reads with the runtime guard that
  keeps production out of them.

### 52.2 Row moves

| id | was | now | why |
| --- | --- | --- | --- |
| TR177 §10.4 Meeting checkpoints | W | **C** | A crew meeting checkpoint with participants and arrival state — a table, a kernel family, three routes and a bundle slot — executed on the real kernel; the two labels the row named are what a checkpoint no longer is. |
| TR198 §11.3 "Return / regroup" → creates a route/meeting operation and switches context priority | W | **C** | `POST /trips/:tripId/regroup` creates the meeting operation through the kernel with §14.3's computation attached, and the open checkpoint derives `REGROUP_OPEN` → `SAFETY_EVENT` on health, Today and sensing until it is met or closed. |
| TR262 meetup points | W | **C** | The layer carries agreed checkpoints as `meeting_checkpoint` points, not only the `category = 'meeting_point'` label. |
| TR329 §17.4 Safe Return attaches to solo, subgroup or full-crew execution contexts | W | **C** | Three of three: `subgroup_id` on the session, verified membership at create, and the crew alert scoped to the subgroup's current members. |

**Held, with the reason.** TR318 stays W: the server half is now whole — a
Safe Return in NEEDS_HELP, an active disruption or an open regroup all
put Today under `SAFETY_EVENT` with discovery suppressed — but the row's
complaint is the screen (`app/safety-history.tsx` is a separate
destination and no trip screen re-prioritises), which is Cluster 13's.
TR116, TR153, TR407 and TR408 stay W for §51's reasons; TR435 for §41.3's
flag.

### 52.3 The ceiling, moved by one migration

2794 joins 2779–2793 in §41.3's ceiling: no database but the local replica
has it until this branch merges, CI applies it, and the owner's Batch C
carries it to production; every reader is behind
`trip_operational_projections_enabled` (FALSE everywhere) and every writer
behind `trip_kernel_enabled`. Nothing here is deployed, enabled or
production-realised.
