# LANE_REPORT — LO-API (`lane/lo-api`, worktree `/home/user/wt-lo-api`, base `561a0a7b0`)

Scope: `artifacts/api-server/src/routes/airport.ts`, `src/test/airport*.test.ts`,
`src/test/layoverRoute*.test.ts`, new `layoverApi*` suites, migration prefix `2978`.

**Every verdict below was derived from the tool, not from reading the document.**
`CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity | grep '^layover|'` was taken
BEFORE any edit and the sixty rows this lane owns were read out of it; it was taken again
after. Both give the same values, and they must: **this lane never edited
`docs/architecture/census-layover.md`** (`git status docs/` is empty), and the parser
reads only that document. 296 rows, `C=79 W=131 N=86` — §39's headline.

**So this lane moved no census row, and could not have.** The "my verdict" column is what
the evidence supports at this HEAD for whoever owns the document. Where it differs from
the tool's value, the reason is stated; where it does not, the row is re-measured and
held — most of this pass is held rows with corrected reasons, and two rows the evidence
now supports moving `N → W`.

## Verdicts

| row | current verdict (tool) | my verdict | one-line evidence |
| --- | --- | --- | --- |
| L1 | W | W | Seven certification sites, one function, no persisted snapshot — `artifacts/api-server/src/routes/airport.ts:1072,1370,1533,1648,2220,2370,2940`; 2700 unapplied. |
| L3 | W | W | Prose IS checked against the certified verdict and a contradicting answer is replaced, `artifacts/api-server/src/services/airport/LayoverCompassService.ts:583` → `:236-239`; W because the check is a sentence regex. |
| L4 | W | W | Confidence computed and published (`LayoverFeasibility.ts:102,182`); baggage still two-valued. Unchanged. |
| L6 | W | W | `computeBuffer` has exactly ONE call site tree-wide — `artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts:681`; no snapshot to share. |
| L11 | W | W | No flight-segment model; raw wall times at `artifacts/api-server/src/routes/airport.ts:406`; mirror row at `:274`. |
| L12 | W | W | Five states and `completed` is reachable (`artifacts/api-server/src/routes/airport.ts:3782`); no constraints, no snapshots. |
| L13 | W | W | The layover-owned adapter exists and is live — `artifacts/api-server/src/services/airport/LayoverTemporalFreedom.ts:1`, imported at `LayoverSafetyEngine.ts:41`. |
| L17 | W | W | BUILT the missing per-pin half (`artifacts/api-server/src/routes/airport.ts:4244`); no route layer exists, and the map is another lane's file. |
| L18 | W | W | Ladder and notification priority exist and reach the wire — `artifacts/api-server/src/services/airport/LayoverSafeReturnService.ts:136`; `shouldSuggestSafeReturn` at `routes/airport.ts:718`. |
| L101 | W | W | Entry-assertion and risk-band enforcement at `artifacts/api-server/src/services/airport/LayoverCompassService.ts:571,583`. |
| L110 | W | W | The tool is reachable and answers a refusal that is FALSE — `artifacts/api-server/src/services/airport/LayoverCompassService.ts:976-977` returns `no("no_crew_storage")` while 2984 is applied. |
| L112 | W | W | Same shape — `artifacts/api-server/src/services/airport/LayoverCompassService.ts:995-996` returns `no("no_event_driven_replanner")` while the replanner runs on PATCH (`routes/airport.ts:879`). |
| L115 | W | W | Envelope geometry IS consumed — `travel-buddy-standalone/app/layover/[id].tsx:792`; the snapshot half is what is missing. |
| L120 | W | W | No route and `terminal_info` null on every production airport. Unchanged. |
| L192 | W | W | Zero layover enum types in the production capture (`src/lib/capability/snapshots/20260922-production-schema.json`); RLS present. |
| L199 | W | W | 2510 is applied and asserts postconditions for `layover_recommendations` only; 0127's other four tables carry none. |
| L200 | W | W | The route surface cannot write `status`/`return_reminder_at`/`share_city_status` (`artifacts/api-server/src/routes/airport.ts:422`); the policy is still column-blind. |
| L205 | W | W | BUILT the one unscoped service-role write (`artifacts/api-server/src/routes/airport.ts:2598`); narrowing proper needs a user-scoped client, which `src/lib/supabase.ts:17` does not have. |
| L236 | W | W | BUILT the first layover suite that checks columns against a real schema capture (`artifacts/api-server/src/test/layoverApiProductionSchema.test.ts:396`); RLS and postconditions still uncovered. |
| L238 | W | W | Snapshot stage still has no storage (2700 unapplied). Unchanged. |
| L254 | W | W | `applyBuddyTrustRequirement` at `artifacts/api-server/src/routes/airport.ts:3520`. Unchanged. |
| L256 | N | N (now guarded) | BUILT the guard the row says does not exist — `artifacts/api-server/src/test/layoverRouteSafetyInputs.test.ts:158`; still no sponsored path, so still N. |
| L259 | W | W | No airport/route/flight subject index and no fanout to serve. Re-tested TRUE. |
| L294 | W | W | Unchanged; no new swallow site added by this pass. |
| L295 | W | W | BUILT the fixture half — `artifacts/api-server/src/test/airport.test.ts:75` seeded `feature_flags.key`, a column production does not have. Still no CI database. |
| L267 | W | W | Nothing detects a connection; no flight segment exists to pass. Re-tested TRUE. |
| L268 | W | W | Tools ARE passed to the model now — `artifacts/api-server/src/services/airport/LayoverCompassService.ts:322`; proactive OpportunityEvents still need a detector. |
| L269 | W | W | Not re-derived by this lane; §35's blocker (flag FALSE on production) re-measured TRUE. |
| L270 | W | W | BUILT the server half of the map contract; plan route and digital-twin layers do not exist. |
| L272 | W | W | The product's Safe Return escalation UX is still not reused; the abort's `crewNotifyUnavailableReason` is a false refusal. |
| L273 | W | W | `rent_buddy_profiles.categories` still has no `layover` member. Re-tested TRUE. |
| L274 | N | N | No visa/entry assistance path from the layover surface. Re-tested TRUE. |
| L275 | W | W | Completion + election closed; no postcard and no memory path. Unchanged. |
| L276 | W | W | Publish limb live (`artifacts/api-server/src/routes/airport.ts:2768`); consume limb behind a flag with no production row. Re-tested TRUE. |
| L219 | W | W | Unchanged. |
| L220 | W | W | Unchanged. |
| L221 | N | **W** | BUILT: the 6h case over the real router plus the return CONTRACT it says does not exist — `artifacts/api-server/src/services/airport/LayoverSafeReturnService.ts:144`, driven at `src/test/layoverApiLifecycle.test.ts:261`. |
| L222 | N | N | Self-transfer/re-check unrepresentable. Re-tested TRUE. |
| L223 | W | W | Unchanged. |
| L224 | N | N | `airport_change_required` has no column, field or type. Re-tested TRUE. |
| L229 | N | N | `checked_bags` is two-valued; nothing to fail closed on. Re-tested TRUE. |
| L230 | N | N | Nothing reads a passport or a corridor. Re-tested TRUE. |
| L239 | N | **W** | BUILT: all six stages walked over the real router on one session — `artifacts/api-server/src/test/layoverApiLifecycle.test.ts:136`. W because detection has no producer. |
| L241 | N | N | No decision-diff job anywhere. Re-tested TRUE. |
| L242 | N | N | No shadow mode; all five layover flags were seeded directly. Re-tested TRUE. |
| L20 | W | W | Snapshot half absent; the "five typed tables" count is now nine. |
| L21 | W | W | The seven named columns are absent from the production capture. Re-tested TRUE. |
| L22 | N | N | No `layover_constraints` on production. Re-tested TRUE. |
| L23 | N | N | 2700 unapplied. Re-tested TRUE. |
| L24 | N | N | 2700 unapplied. Re-tested TRUE. |
| L25 | N | N | No `CREATE TABLE layover_snapshots` anywhere. Re-tested TRUE. |
| L26 | W | W | `rec_key` exists (2410 applied); the six named columns do not. |
| L30 | N | N | 2992 unapplied. Re-tested TRUE. |
| L32 | N | N | `layover_outcomes` absent from the production capture. Re-tested TRUE. |
| L34 | N | N | No `EntryPermissionState` of any kind. Re-tested TRUE. |
| L193 | N | N | None of the four tables exists. Re-tested TRUE. |
| L194 | W | W | Last statement already correct (`docs/architecture/census-layover.md:1900`): 2860's dedup index is on a NEW table; `layover_events` has none. |
| L195 | W | W | Recommendations yes, outcomes no. Re-tested TRUE. |
| L196 | W | W | Crew tables applied and the sweep is scheduled (`artifacts/api-server/src/index.ts:159`); `layover_presence` absent. Re-tested TRUE. |
| L198 | W | W | The fanout index is on `occurred_at WHERE processed_at IS NULL` — a pending index, not a subject index. Re-tested TRUE. |


## BUILT

### 1. Per-pin feasibility on the traveller's own plan — bears on L17, L115, L270

`artifacts/api-server/src/routes/airport.ts` — `bandPlanStops` (`:4244`), called
line-for-line from `respondWithStops` (`:2375`, so every `/stops` response) and from
`GET /:id/overview` (`:2260`).

Every plan stop now carries an `envelope` verdict: the layover domain's own
`CandidateFeasibility` (`band`, `certified`, `lowerBoundOneWayMin`,
`withinPlannedEdge`, `reason`, `plannedEdgeReason`, `impliesFit`) plus
`distanceMetres`, `roundTripLowerBoundMin` and `returnDepartsAt`. It is computed by
`bandCandidates` against `safeEnvelopeFor(airport, record)` — the SAME envelope the
same response publishes as `safeEnvelope`, from the SAME certified record — so a pin
that is blocked provably lies outside the radius drawn beside it. Airside stops and
landside stops with no coordinate come back `certified: false` with the domain's own
two reason constants and a NULL distance; a zero would be census L47 one surface
further along.

No new `certifySessionFeasibility` call site: `src/test/layoverFeasibilityRecord.test.ts`
pins the certification sites to a named list of handlers and it stays green.

**Why the new code is at the foot of the file.** `docs/architecture/census-layover.md`
and `docs/architecture/census-highlights-memories.md` hold ANCHORED citations
(`path:line#literal`) into `routes/airport.ts` as far down as line 3806, and
`check:doc-citations` re-reads each against the line it names. This lane may edit
neither document, so every call site is a line-for-line substitution and everything
added — including the three imports — lives past the last citation. Measured: all 17
anchored lines still carry the literal their citation names (2229, 2234, 3242, 3342,
3346, 3357, 3388, 3407, 3446, 3519, 3520, 3538, 3556, 3685, 3722, 3748, 3806), and
`check:doc-citations`, `check:citation-targets` and `check:citation-symbols` all pass.

### 2. The one service-role write in the plan-stop family that named no session — bears on L205, L200

`artifacts/api-server/src/routes/airport.ts:2598`. The stop-order compaction pass after
`DELETE /stops/:stopId` filtered on `id` alone. Every other write in the family carries
`.eq("session_id", session.id)`; this one now does too. RLS is bypassed on every layover
route (`getServiceClient`), so that filter is the entire boundary.

Not exploitable today — the ids come from `loadStops(sc, session.id)` — which is exactly
why it needed a test rather than a comment.

### 3. The fixture half of C3 — bears on L295, L236

`artifacts/api-server/src/test/airport.test.ts`. The file census L295 names by name
seeded `feature_flags` rows with a `key` column. Production has no such column
(`flag`, `enabled`, `description`, `metadata`, `updated_at`) and `lib/featureFlags.ts:19`
filters on `.eq("flag", …)`, so those rows could never have matched a real query. Fixed
to `flag`, and a new suite (`:998`) checks every column of every row this file seeds
against the committed production capture, with a stated control.

`artifacts/api-server/src/test/layoverApiProductionSchema.test.ts` does the same for the
ROUTES, where the queries are: the real Express router driven over a supabase-shaped
double whose column oracle is
`src/lib/capability/snapshots/20260922-production-schema.json`, the file
`snapshots/current.ts` names. An unknown column resolves the whole statement with
PostgREST's 42703, resolved and not thrown. It does NOT reuse
`src/test/helpers/schemaStrictSupabase.ts`, whose oracle
(`src/test/generated/liveColumns.json`, generated 2026-08-31) predates 2410, 2860, 2982,
2983 and 2984 and would report `layover_recommendations.rec_key` as dead.

Measured before writing it: `grep -rln 'schemaStrictSupabase\|enumAwareSupabase\|failClosedSupabase' src/test/ | grep -iE 'layover|airport'` returned NOTHING — not one of the
fifty-odd layover suites used a schema-aware double.

### 4. The six-stage lifecycle over the real router — bears on L239, L221

`artifacts/api-server/src/test/layoverApiLifecycle.test.ts`. One session walks
detection → evaluation → plan → execution → return → completion over the real Express
router, with each stage's output asserted to be what the next stage reads (the certified
deadline from `/safety` is the deadline in the return contract; the stop planned at
stage 3 is the stop the abort cancels; completion is read from
`layover_sessions[0].status`, not from `ok: true`). The L221 block drives the spec's 6h
international case and pins both halves of the return contract, including the two that
are still missing (`route: null`, `routeUnavailableReason: "no_routing_provider"`) and
the unrepresentable "visa-free" term.

### 5. The guard L256 says does not exist — bears on L256, L205

`artifacts/api-server/src/test/layoverRouteSafetyInputs.test.ts`. `GET /:id/buddies` is
the one layover route that reads a marketplace table; the suite pins that
`layoverBuddyDecision` takes `(airport, session)` and nothing else, that it runs BEFORE
`.from("rent_buddy_profiles")` (§9.1 is an order, not only a rule), and that a session
the engine says cannot leave is served no buddies however full the marketplace is. It
also pins the L205 substitute for RLS: a stranger gets 404 on seven session-scoped
routes and nothing they sent reached the row, with the owner's own request on the same
fixture as the control.

### Files changed

* `artifacts/api-server/src/routes/airport.ts` — 3 line-for-line substitutions, 107 appended lines (`git diff 561a0a7b0 --numstat` = 110 added / 3 removed).
* `artifacts/api-server/src/test/airport.test.ts` — fixture column fixed, new L295 suite.
* `artifacts/api-server/src/test/layoverRoutePlanStops.test.ts` — NEW.
* `artifacts/api-server/src/test/layoverRouteSafetyInputs.test.ts` — NEW.
* `artifacts/api-server/src/test/layoverApiLifecycle.test.ts` — NEW.
* `artifacts/api-server/src/test/layoverApiProductionSchema.test.ts` — NEW.
* `artifacts/api-server/package.json` — the four new suites registered in the curated
  `test` list, which `check:test-registration` requires. This file is outside the lane's
  exclusive list and is touched for that one reason; the edit adds four paths after
  `src/test/layoverScenarioMatrix.test.ts` and changes nothing else.

### Deliberately NOT written: migration `2978_*`

The prefix was free and nothing needed it. The two candidates were a dedup index
(already served for the canonical event table by `2860`, which is applied) and a
verify-only postcondition file for 0127's other four tables. Both would have been
storage-or-assertions that exist only as an unapplied file, which this census scores `N`,
and an unapplied migration is a liability against `audit:schema`. Recorded rather than
written.

## TEST EVIDENCE

Environment note, because it changes how one result reads: **five concurrent `npm test`
root runners were measured on this box**, in four sibling worktrees plus this one —
`/proc/<pid>/cwd` gave `wt-lo-api` (mine), `wt-hm-api`, `wt-hm-server` (×2) and
`wt-lo-server`. One guard in this repository fails under that load and says so in its own
assertion text: `guardReachability.test.ts` reports *"THE CHECKER WAS KILLED, NOT FAILED:
spawnSync returned status=null signal=SIGTERM after the 180s timeout … RE-RUN THIS FILE
ALONE before believing it"*. Any appearance of that failure below is a clock result.

### RED first, then GREEN — the route behaviour

```
$ cd /home/user/wt-lo-api/artifacts/api-server
$ cp /tmp/.../airport.ts.bak src/routes/airport.ts        # pristine route, final test file
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test src/test/layoverRoutePlanStops.test.ts
# tests 9
# pass 3
# fail 6
```
RED, with the messages the suite was written to produce:
```
not ok 1 - a stop near the airport is inside the envelope and carries its measured distance
  error: 'every stop must carry an envelope verdict'
not ok 1 - the stop-order compaction after a delete is scoped to the owned session
  error: 'a layover_plan_stops UPDATE filtered on ["id"] — the service role bypasses RLS,
          so a write that does not name the session is bounded by nothing'
```
The two L205 controls (reorder, targeted stop edit) PASSED in RED, which is what makes
the compaction failure specific rather than a suite that refuses everything.

```
$ # route change restored
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test src/test/layoverRoutePlanStops.test.ts
# tests 9
# suites 2
# pass 9
# fail 0
```

### The affected set — every suite that imports or reads `routes/airport.ts`

54 files (`grep -rl 'routes/airport.js'` ∪ files that read `airport.ts` as text ∪
`src/test/airport.test.ts`).

BEFORE the route change, with the four new suites present:
```
$ SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test $(cat affected.txt)
# tests 900
# pass 893
# fail 7
not ok 158 - census L17 / L115 — the plan a traveller built is banded against the certified envelope
not ok 159 - census L205 — every layover_plan_stops write names the session it belongs to
```
**That first RED is not the proof, and it is recorded rather than quietly replaced.**
Its seven subtest failures were partly my own fixture's fault: `stopRow(over)` built its
row and never spread `over`, so every stop was id `stop-a` and a two-stop delete hit
PGRST116. A suite that fails for the wrong reason proves nothing. The fixture was fixed,
and the RED above — 6 of 9, on the pristine route, with the two L205 controls PASSING —
is the run that is the proof.

AFTER:
```
# tests 903
# suites 222
# pass 903
# fail 0
EXIT=0
```

### Full suite

Two full runs were made in this worktree, and neither is a clean number, for a reason
outside this lane: the box carried up to five concurrent `npm test` roots (above), and
one guard times out under that load.

**BEFORE any edit** (pristine tree, started before the first change): the run was stopped
by me after **2,517 top-level suites** with **3** failures —

* `flagSchemaPrerequisites.test.ts / the script` — **PRE-EXISTING** and unrelated: it
  reports `intel_reward_ledger.reverses_entry_id`, `media_assets.captured_at`,
  `trips.version` and five `compass_*` columns missing in production. No layover row is
  named. This is the same class as the `audit:schema` redness the lane brief describes.
* `guardReachability.test.ts / CONTROL` — the SIGTERM-after-180s clock result quoted
  above, on the pristine tree.
* `suggestionSeenCache` — a timing test, on the pristine tree.

**AFTER the change**: **STILL IN FLIGHT** when this report was written, and reported as the partial it is
rather than as a pass. At that point **1316 top-level suites had reported and 0 had
failed**, among them the new `census L295 — the fixtures in this file name only
production columns` suite in `airport.test.ts`. The four NEW files are registered near
the end of the curated list and had not been reached; they are covered completely by the
affected-set run below, which is green.
The run is `npm test` in this worktree; whoever picks the branch up should re-run it on an
idle box, where `guardReachability` passes 25/25 by its own account.

The regression evidence this pass actually rests on is the **affected set**, which is
complete and green: 54 suites — every file that imports or reads `routes/airport.ts`,
plus `airport.test.ts` — 903 tests, 903 pass, 0 fail, exit 0.

### Typecheck and the named checks

```
$ npm run typecheck                    PASS
$ npm run check:route-auth-gate        PASS
$ npm run check:guard-coverage         PASS
$ npm run check:async-handlers         PASS
$ npm run check:route-shadowing        PASS
$ npm run check:api-prefix             PASS
$ npm run check:test-registration      PASS
$ npm run check:authorization-contract FAIL (exit 2)
```
`check:authorization-contract` fails **before constructing any client**:
`KNOWN_PROD_PROJECT_REF is empty or not configured … [ciProdReadOnlyAuditGuard] REFUSED`.
Re-tested on the PRISTINE tree in this worktree (`git stash` → run → `git stash pop`):
**exit 2 there too.** It is an environment limitation of this box, not a consequence of
this change.

Also run, because this pass edits a heavily-cited file and a schema-adjacent fixture:
```
$ npm run check:doc-citations          PASS
$ npm run check:citation-targets       PASS
$ npm run check:citation-symbols       PASS
$ npm run check:census-integrity       PASS   (C=79 W=131 N=86, total 296)
$ npm run check:flag-polarity          PASS
$ npm run check:enum-literals          PASS
$ npm run check:schema-references      PASS
$ npm run check:not-null-writes        PASS
$ npm run check:write-path-columns     FAIL (exit 2 — the same KNOWN_PROD_PROJECT_REF refusal)
$ npm run check:census-scope-coverage  FAIL (exit 1 — PRE-EXISTING)
$ npm run check:census-freshness       FAIL (exit 1 — CAUSED BY THIS PASS, see (a) 8)
```
`check:census-scope-coverage` reports census-layover at 92% against a floor of 97% and
names the two unwatched files: `services/airport/LayoverTravelTime.ts` and
`lib/layoverCrewExpiryScheduler.ts`. This lane touched neither and added no citation to
any census, so it cannot be a consequence of this pass; it is recorded because a reader
running the checks will see it.

### Census dump

`CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity | grep '^layover|'` was taken
before any edit and again after. **`docs/architecture/census-layover.md` is untouched by
this lane** (`git status docs/` is empty), so the dump cannot have moved and did not:
296 rows, C=79 W=131 N=86, matching §39's headline. Every "current verdict" in the table
above is that dump's value, not a value read out of the document body.

### A note for the integrator: §40 is not in this worktree

The coordinator reports a census-layover **§40** that re-derives seven rows — L31, L92,
L194, L198, L236, L238, L263 — with nothing moving. Four of those (**L194**, **L198**,
**L236**, **L238**) are rows this lane owns. **§40 is not in this tree**: this worktree is
at `561a0a7b0` and the census here ends at §39, so my statements about those four were
derived independently against this HEAD and may duplicate or diverge from §40's. Reconcile
against §40, not against this report, where the two disagree — §40 is the later
measurement. My §40-overlapping claims are: L194 and L198 re-tested TRUE (I withdrew two
draft stale-evidence finds after taking the tool dump), L238 held on 2700, and L236 held
with the fixture half now built and the CI-database half untouched.

## NOT DONE AND WHY

### (a) Needs a file another lane owns

1. **`artifacts/api-server/src/services/airport/LayoverCompassService.ts:977`** — change
   `case "getCrewCandidates": return no("no_crew_storage");` to read the crew from
   `services/layover/LayoverCrewStore.ts` (`activeCrewForUser` / `crewMembers`, already
   imported by `routes/airport.ts`). Crew storage EXISTS: `2984_layover_crews` is applied
   to production (version `20260916115643`) and `layover_crews` / `layover_crew_members`
   are both in the 2026-09-22 capture. Bears on **L110**, **L268**. The route would also
   have to pass a crew into `LayoverToolContext`, which is a change to the same file's
   interface; I did not add a field to a type I do not own.
2. **`artifacts/api-server/src/services/airport/LayoverCompassService.ts:996`** — change
   `case "replan": return no("no_event_driven_replanner");`. The replanner exists and is
   live: `replanForWindowChange` runs on every `PATCH /airport/sessions/:id`
   (`routes/airport.ts:879`). Bears on **L112**, **L268**.
3. **`artifacts/api-server/src/services/airport/LayoverSafeReturnService.ts:372,383`** — the
   abort pushes `crew_notify_unavailable` and publishes
   `crewNotifyUnavailableReason: "no_crew_storage"`. False since 2984. §15.1 asks the
   abort to "notify relevant crew/buddy flows"; it cannot while the service refuses on a
   fact that is no longer true. Bears on **L18**, **L272**. Note a real prerequisite: the
   `layover_events.event_type` CHECK has no `crew_notified` member, so an audit row for
   the notification needs a migration (2985 added only `crew_created/joined/left`).
4. **Stale "2860 is written and NOT applied" claims** — 2860 was applied to production on
   `20260916121130` and `src/scripts/checkProductionDrift.ts:539` already records it as
   "STRUCK OFF, APPLIED". Four files, five sites, still say otherwise:
   `src/services/airport/LayoverAirportTruth.ts:21`,
   `src/services/airport/LayoverEventReplanner.ts:17` and `:875`,
   `src/services/layover/LayoverObservationService.ts:96`, and
   `src/test/layoverEventReplanner.test.ts:10`. **Re-measured in `routes/airport.ts`:
   there is no such claim in this lane's file.** Its three mentions of 2860 (`:2649`,
   `:2698`, `:2846`) quote that migration's rules and do not assert it is unapplied, so
   there was nothing here to correct — reported rather than claimed as work done.
5. **The client half of the per-pin build** — `travel-buddy-standalone/src/services/layover.ts:147`
   (`PlanStop` gains `envelope`, structurally the `CandidateFeasibility` already declared
   at `:512` plus `distanceMetres`, `roundTripLowerBoundMin`, `returnDepartsAt`) and
   `travel-buddy-standalone/src/components/layover/LayoverMapCard.tsx:183` (`pinFeasibility`
   should prefer `stop.envelope` and keep the recommendation join as the fallback — today
   it returns `null` for any stop with no `recommendationId`, i.e. for every stop a
   traveller typed in themselves). Bears on **L17**, **L115**, **L270**. Under the grading
   rule a user-facing feature needs its client flow connected, so those rows stay `W` and
   this lane does not close them.
6. **`artifacts/api-server/src/lib/supabase.ts:17`** and **`src/lib/http.ts:272`** — the
   real L205 narrowing. There is no user-scoped client in this API at all:
   `getServiceClient` is the only export, and `requireUser` hands that same service client
   back as `auth.client`, so "use the caller's client" is not available to any route.
   Narrowing needs a per-request client built from the bearer token. Bears on **L205**,
   and on **L200**, whose "within allowed fields" half is a column grant in
   `0127_layover_system.sql` (the coordinator's).
7. **`artifacts/api-server/src/scripts/`** — L241 (decision-diff CI over a historical or
   synthetic corpus) is a checker plus a corpus; no file under `src/scripts/` or
   `scripts/` is this lane's.

8. **`artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`** — **A
   CONSEQUENCE OF THIS PASS, AND IT IS THIS LANE'S FAULT.** `npm run
   check:census-freshness` now reports *"census-layover.md is STALE. Its acknowledgement
   covers 67 named file(s), but 1 counted file(s) changed that it does NOT name:
   artifacts/api-server/src/test/airport.test.ts"*.

   Measured rather than assumed: `git diff --name-only 1fe72289b 561a0a7b0 --
   artifacts/api-server/src/test/airport.test.ts` is EMPTY — that file had not moved
   since the census's declared `head_commit` — while `routes/airport.ts` HAD moved and is
   already named in the acknowledgement. So the route change adds nothing here and the
   test-file change is the sole cause.

   This file is on this lane's FORBIDDEN list, so the fix is recorded rather than made.
   The exact change: add `"artifacts/api-server/src/test/airport.test.ts"` to the `files`
   array of the `census-layover.md` entry in `acknowledged` (the one with
   `"since": "1fe72289b"`, `"acknowledgedAt": "2026-09-20"`, currently 67 files), with the
   argument that the change cannot have moved a verdict: it fixes a fixture column that
   never matched a real query (`feature_flags.key` → `flag`) and adds a suite that checks
   the file's own fixtures against the production capture. **L295 stays `W`** — its
   blocker is a CI database and that is untouched. The alternative is a re-declaration of
   `head_commit`, which §24.10 of that census argues against on a branch commit.

### (b) Needs unapplied schema

* **2700** (`layover_certified_computations`, `layover_time_budgets`,
  `layover_return_plans`) — **L1**, **L6**, **L23**, **L24**, **L25**, **L238**, **L264**.
  `persistDecision` writes all three and is flag-gated for exactly this reason.
* **2992** (`layover_checkpoints` and the decision-record tables) — **L30**, **L194**'s
  checkpoint half.
* **2740** (`layover_presence`) — **L196**'s presence half.
* **No migration at all** for `layover_constraints` (**L22**, **L193**),
  `layover_snapshots` (**L25**, **L193**), `layover_outcomes` (**L32**), or an
  `EntryPermissionState` (**L34**, **L230**, and the "visa-free" term of **L221**).
* **2851** (`layover_live_intersection_enabled`) — the consume limb of **L276** has no
  flag row on production, so `isFlagEnabled` fails closed for every traveller.

### (c) Needs an external credential / service

* `KNOWN_PROD_PROJECT_REF` + a sanctioned non-production `CI_SUPABASE_PROJECT_REF`, for
  `check:authorization-contract` and `check:write-path-columns`. Both refuse before
  constructing a client on this box, pristine tree included.
* A **CI database carrying the layover schema** — the deployed half of **L236** and
  **L295**. §24.7 states it: "No CI database carries a layover schema. Migrations
  2893–2970 are unapplied to portava-ci." This pass supplies the fixture half against a
  captured schema and cannot supply the other.
* A **flight/airport event feed** — the detection stage of **L239** and the producer for
  **L112**, **L259**, **L267**. `layover_external_events` exists on production and is
  empty because nothing writes to it.
* A **routed travel-time provider** (Google Routes enablement, an owner purchase
  decision) — the `route: null` half of **L221**, and **L17**/**L120**/**L270**'s route
  layer.

### (d) Out of scope

* **L242** (shadow mode before rollout) — an execution mode for the engine plus flag
  plumbing, both in `src/services/airport/**`.
* **L269**, **L273**, **L274**, **L275** — re-measured and unchanged; each blocker is in
  Discovery, the Rent-a-Buddy category vocabulary, or a client surface.

## STALE EVIDENCE FOUND

Each of these is a sentence in the census that I re-tested and found FALSE at this HEAD.

**Two of them are the whole blocker and the verdict follows: L239 and L221 move `N → W`.**
On every other row the stale sentence is one half of a divergence whose other half still
holds, so the verdict is HELD with a corrected reason — which the corpus's own standard
(§13.4's L77, *"three terms of four is not four"*) requires.

Where a row has been restated since the body, the sentence quoted is named as a BODY
sentence; the tool's last-statement line is what the verdict column uses.

| row | the sentence | what is true at this HEAD |
| --- | --- | --- |
| L1 (body, `:389`) | the 2026-09-22 recount: *"`GET /:id/stops` does NOT recompute feasibility — `certifySessionFeasibility` appears zero times in that handler"*, and *"a second one inside /overview (line 2370)"* | Line 2370 IS the `/stops` handler — it is inside `respondWithStops`, which is the whole body of `GET /:id/stops`. And there are SEVEN call sites, not six: the recount missed `certifyCrewMemberRecord` (`routes/airport.ts:2940`). `src/test/layoverFeasibilityRecord.test.ts:432` pins the count at seven against a named handler list. |
| L3 (body, `:396` — this IS its last statement) | *"Nothing checks the prose against the deterministic verdict, so 'you have plenty of time' ships next to a `not_recommended` note without contradiction being detected."* | `enforceCompassEnvelope` checks the prose against the certified deadline, the certified usable minutes, the entry-permission unknown and the certified risk band, and a contradicting answer is REPLACED by the deterministic one (`LayoverCompassService.ts:583`, applied at `:236-239`). Held `W` because a sentence regex is a filter, not a proof. |
| L6 (body, `:399`) | *"there are three independent uses of it with different inputs (`LayoverSafetyEngine.ts:90` departure-based, `:247` cutoff-based, `LayoverCompassService.ts:51` departure-based)"* | `grep -rn 'computeBuffer('` over `src/services/` and `src/routes/` returns TWO lines: the declaration at `LayoverSafetyEngine.ts:606` and ONE call at `:681`. |
| L11, L18, L254, L267, L275, L205 (body rows) | their `routes/airport.ts` line ranges — `:194-222`, `:440-447`, `:1411-1427`, `:143-179`, `:449-470`, and L205's `:268, 307, 484 …` | Every one has drifted onto the import block, a zod schema or a comment. Current: wall times `:406`; `shouldSuggestSafeReturn` `:718`; buddy `verified`/`buddyLevel` `:3534-3536`; the trip mirror `:274`; the passport seam `:3806`; `getServiceClient` at `:497, 545, 766, 987, 1040, 1163, 1229, 1344, 1440, 1631, 1687, 2104, 2143, 2200, 2357, 3569, 3771`. |
| L12 (body `:410` — this IS its last statement) | *"its lifecycle is four states of which one is unreachable"* | Five (`2741` added `returning`, applied `20260908133347`) and `completed` is reachable — `DELETE /airport/sessions/:id?outcome=completed` (`routes/airport.ts:3782`). §17.6 already records the second half for L32; it was never carried to L12. |
| L13 (last `:4418`) | *"it is a file inside ANOTHER domain's package (`domain/trips/invariants/`)"* | The layover-owned ADAPTER is `services/airport/LayoverTemporalFreedom.ts` and it is on the live path (`LayoverSafetyEngine.ts:41`). The generalised engine lives in trips because the layover spec §7 and developer rule 14 say it must. Held `W`: whether that satisfies "owns" is a judgement about §3, not a measurement, and I did not make it. |
| L17 (body `:415`), L115 (last `:3099`), L270 (body `:856`) | *"takes `airport` and `stops` as props and computes nothing… visualises nothing the requirement names: no envelope, no route, no per-pin feasibility"* / *"There is still no envelope geometry to consume"* / *"Pins only"* | `LayoverMapCard.tsx` has been rebuilt: it takes `envelope` (`app/layover/[id].tsx:792` passes `overview.safeEnvelope`), draws the proved and contracted edges to scale, bands pins, lists blocked areas with the server's own reason, and renders the return leg. What was genuinely missing is the per-pin band for a stop the traveller typed in themselves — `pinFeasibility` returns `null` without a `recommendationId` — and that is what this pass built server-side. |
| L18 (body `:416`) | *"there is no escalation ladder and no notification priority, and the UI does recompute a risk judgement of its own (`LayoverReturnPanel.tsx` lines 114-115)"* | `RETURN_ESCALATION_LADDER` and `returnNotificationPosture` exist, are consumed by `safeReturnPosture` (`LayoverSafeReturnService.ts:136`) and reach five endpoints; the client carries `rung: { level, priority, label }` (`travel-buddy-standalone/src/services/layover.ts:551`). `LayoverReturnPanel.tsx` no longer exists. **This row's four terms all now have a server implementation; it is a candidate `C` for whoever measures the client, and I am not closing it myself.** |
| L101 (body `:579` — this IS its last statement) | *"the only enforcement is prompt text plus a coordinate regex"* | Entry/visa assertions are a named violation class with a negation-aware hedge test (`LayoverCompassService.ts:571`) and a risk-band widening check (`:583`); both replace the answer. |
| L110, L112 (in the grouped `L102–L113` row) | *"Twelve rows behind one flag decision this lane does not own."* | There is no flag. `tools: LAYOVER_TOOL_SCHEMAS` travels on the request (`LayoverCompassService.ts:322`) and `runLayoverTool` executes what comes back; the file's own header at `:1026` says in capitals why no flag was used. L110 and L112 are `W` for a better reason: the tools are reachable and answer refusals that are themselves false (`no_crew_storage`, `no_event_driven_replanner`). |
| L268 (body `:854` — this IS its last statement) | *"Explanation only… No tools (L102–L113), no OpportunityEvents (L98), no clarification (L114)."* | All three are false: tools are passed (above), `notifyLayoverOpportunity` is called on the replan path (`routes/airport.ts:976`), and `clarifyingQuestion` / `requestConstraintClarification` exist and ship. Held `W`: the OpportunityEvent fires on a traveller's own edit, which is not proactive detection. |
| L239 (body `:805` — this IS its last statement) | *"Four of the six stages have no implementation to test."* | FIVE have a route; only detection lacks a producer. Evaluation `GET /:id/safety`, plan `POST /:id/stops`, execution `PATCH /:id/stops/:stopId`, return `POST /:id/return-now`, completion `DELETE /:id?outcome=completed`. This is the row the new lifecycle suite moves `N → W`. |
| L221 (body `:782` — this IS its last statement) | *"No return contract (L24)."* | L24 is about a `layover_return_plans` TABLE, which really is absent. A return CONTRACT is a different artifact and it exists — `LayoverSafeReturnService.ts:144` declares it, `buildReturnContract` builds it, `POST /:id/return-now` publishes it. This is the second row that moves `N → W`. |
| L20 (body `:423` — this IS its last statement) | *"five typed tables"* | Nine layover-domain tables are in the production capture (`+ layover_crews`, `layover_crew_members`, `layover_external_events`, `airport_fact_observations`). The snapshot half the row actually scores is unchanged. |
| L1/L5/L6/L191/L197/L206/L207/L238/L240/L263 (grouped) | *"Gated on 2700 or 2860."* | 2860 is APPLIED (`20260916121130`). For the rows I own — L1, L6, L238 — the operative gate is 2700 alone, which is unapplied on every database. |

### Claims I re-tested and found TRUE — recorded so this is not read as one-sided

`L22`, `L23`, `L24`, `L25`, `L30`, `L32`, `L34`, `L192`, `L193`, `L195`, `L196`, `L198`,
`L222`, `L224`, `L229`, `L230`, `L241`, `L242`, `L256`, `L259`, `L267`, `L273`, `L274`,
`L276` — each stated reason reproduces at this HEAD by the method the row names.
**`L194` and `L198` in particular**: their LAST statement
(`docs/architecture/census-layover.md:1900`) already says 2860's dedup index is on a NEW
table and that `layover_events` still has none, and that the fanout has no subject index.
I had drafted both as stale-evidence finds off the BODY row and withdrew them after
taking the tool dump — which is the mistake the coordinator's correction describes,
caught by following it.

