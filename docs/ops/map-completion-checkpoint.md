# Map completion effort — running checkpoint

**Purpose.** This file is the resume point. It is written so that a session
which has lost its conversation context can pick the effort up from the
repository alone: what has landed, what each lane owes, which decisions are
taken and which are still the owner's.

It records STATUS, not verdicts. No census row is graded here. The separation
the whole effort runs on is kept throughout:

> implemented ≠ integrated ≠ database-applied ≠ deployed ≠ enabled ≠
> runtime-verified ≠ **correct**

A requirement is correct only when its full acceptance criteria have passing
evidence. A harness that can produce a number is not the number.

## The backlog

`docs/architecture/census-map.md` — 293 requirements, **56 not correct**
(46 withheld + 5 not built + 5 cannot-verify). `check:census-integrity`
confirms the 56. Two counting traps are recorded in
`docs/handoff-map-architecture.md`: five rows carry a qualified-C verdict cell
and are NOT among the 56, and one row is double-listed across two blocker
groups.

**Every "absent from production" verdict in that census rests on a committed
baseline snapshot, not a live read.** §43 re-measured and found three of the
four blocking objects had since reached production. Re-measure before trusting
an absence.

## Lanes

| Lane | Scope | State |
|---|---|---|
| A — Map interface | `src/features/map/**`, map components | **LANDED** (merge of `worktree-agent-a8607f93b9412b6a6`) |
| B — Map backend | `routes/map*`, `lib/mapProducers/**` | **LANDED** (`c36aac77d`) |
| C — Sensing | §35 telemetry, `routes/mapTelemetry.ts` | **LANDED** (`bca43861b`) |
| D — Integrations | seeded-CI fixtures, cross-lane capture | **LANDED** (`2337c2b80`) — reported at 00:40 after a 2h silence |
| Integration owner | shared files, migrations, census, citations | this session |

Lane A's shared-file patches are landed (`8d82a324d`): M43's
`DiscoveryMapView.tsx` fix and M221's `app/map/index.tsx` refactor. Its M221
screen-level wiring gap is closed (`d8af7dd8d`) with both surviving mutations
proven red. Its third finding — a guard matching prose in comments — is fixed
(`486b633a5`): one name off the debt list, and the guard tightened rather than
loosened.

## CI state at `955190f69`

**The whole `ci.yml` workflow is GREEN** — `CI · verdict` success, which is the
first time on this branch. `api-server · node:test`, `standalone · check:all`,
`api-server · typecheck + static`, `api-server · kernel SQL` and both `unwired`
jobs all pass.

**The only red is `live-db.yml`, and all of it is `main`'s 2481.**
`api-server · check:all + live_pulse gate` is down to ONE failing check out of
43 (`check:missing-live-columns`), and `schema drift` fails on the same cause.
Both trace to `2481_sensing_sessions_option_a_issuer.sql`, which is deliberately
unapplied under the Option B posture merged in #510 and has since been reverted
on portava-ci. The auditors are name-keyed to files on disk and cannot know a
file must never run.

THE FIX IS TWO ENTRIES, NOT ONE — the same root cause reached through two
scripts, each with its own mechanism:

  artifacts/api-server/src/scripts/auditMigrationsVsLive.ts   SKIP_FILES
  artifacts/api-server/src/scripts/checkMissingLiveColumns.ts ALLOWLIST

Both patches are written out on PR 511 and NEITHER is applied. It is main's
four-day-old breakage, not this PR's, and it sits on a security-posture
auditor: whoever owns the Sensing posture should confirm that recording the
skip is the intended reading rather than re-applying 2481 — which would also
turn it green and is the WRONG fix, reintroducing exactly the Option A
constraint #510 removed.

Client suite at the integration head: `check:all` exit 0, node:test 6384/6384
(0 fail, 0 skipped, 0 todo), jest 567 suites / 3646 tests, 3 webrender / 8. All
ten client guards, all three citation checks and all three census checks pass.
api-server suite: 23811 tests, 23809 pass, 2 fail → both fixed, now 23811/23811
in CI.

## Decisions taken, and why

**M223 — wire the temporal probe (Lane A's option b), do not restate the
criterion.** The screen ANSWERED `timeMachineProducerEnabled: entitiesSource
!== 'legacy'`, a proxy for the temporal route's own answer.
Option (a) was to keep the proxy and reword M223 to match it. That is
redefining a requirement to reach 100%, which this effort does not do, so
option (b) stands: the screen probes `GET /api/map/projection/temporal` once
per session and feeds `temporalProducerReachable(probe)`.

**IMPLEMENTED** in `src/hooks/useTemporalProducerProbe.ts`, wired at
`app/map/index.tsx`. The trap Lane A identified is honoured: the probe is its
own one-shot request rather than a read of `useTemporalEntities`, which fetches
only while the mode is already active and the offset is not NOW — so wiring
that in would have closed Time Machine at NOW. It fails closed while in flight
and on a network error, and is latched by a ref so a moving camera cannot turn
one request per session into one per pan. Five cases, two of them built to
discriminate the producer's answer from the old proxy; reverting the gate to
the proxy reddens four.

**M223 is still not closed.** It additionally needs the temporal route
answering `enabled: true` against a seeded CI, and its client fixtures replaced
with a captured payload. Both are cross-lane.

**M223's criterion wording is wrong regardless, and this is a correction, not a
restatement.** Read literally — `enabled: true` **plus a non-null forecast** —
the gate would close Time Machine for every PAST offset, which answers
`forecast: null` with a `history` block. The gate is `enabled === true`; the
forecast is an example, not a condition. Lane A asserted both arms the
criterion names plus a third proving a history-only envelope still opens the
mode, and mutation C5 (adding the forecast requirement) is red.

**M43 is fixed but NOT regraded.** The fix landed; the row still reads
not-correct. Regrading needs the full criteria read against a real flow.

## portava-ci state, verified 2026-09-20 23:55 UTC

Checked directly rather than taken from any lane's report, because a flag left
ON makes another lane's assertions pass for the wrong reason and that is the
exact false green this effort is trying not to produce.

**EVERY Map flag on portava-ci is FALSE.** `map_crowd_flow_enabled`,
`map_telemetry_enabled` and `map_world_intelligence_enabled` were flipped by
Lane C and restored at 22:17:58; `map_projection_enabled`,
`locate_friends_enabled`, `map_contributions_enabled`,
`map_display_resolver_enabled`, `map_experience_state_enabled`,
`map_trip_projection_read_enabled` and `map_world_moments_enabled` are all
false. The single `true` is `map_telemetry_retention_enabled`, set 2026-09-16,
which predates this effort. Both telemetry tables are at zero rows — Lane C
cleaned up by predicate as it said it did.

**LANE D'S SEEDED ROWS ARE GONE — re-verified after its report, at 00:45.**
An earlier reading of this file said cleanup was owed; that was true at 23:55
and is now stale. Lane D cleaned up after that measurement and before
reporting. Confirmed by query rather than taken from its report: zero rows
matching `0dd0dd00%` in `auth.users`, `profiles` or `memory_projections`, zero
handles matching `laned%`, and exactly ONE `project_user_memory` overload — the
second one it created while testing PR #451 was dropped.

That temporary overload is worth recording because it is the only schema
mutation any lane made to CI in this effort. Lane D disclosed it unprompted,
and the state matches the disclosure.

## WHY THE 56 CANNOT CLOSE — measured 2026-09-21 00:15 UTC, not assumed

The 56 were classified by reading every non-C row's blocker and then checking
the two databases. The result is far more concentrated than the row count
suggests: **one absent production flag row accounts for roughly half of them.**

### The chain, stated once

```
platform control refuses the production migration chain
        (2217 -> 2201 -> 2218 -> 2224 -> 2295)
   -> 2201 never ran
   -> `map_projection_enabled` has NO ROW in production
   -> isFlagEnabled treats a missing row as false, so the gateway is OFF
   -> ~30 rows cannot be runtime-verified, whatever the code does
```

Production carries only SIX map/locate flags. Verified by query, not inferred:

| flag | production |
|---|---|
| `map_compass_commands_enabled` | true |
| `map_search_enabled` | true |
| `map_telemetry_retention_enabled` | true |
| `locate_friends_enabled` | false |
| `map_telemetry_enabled` | false |
| `map_trip_projection_read_enabled` | false |

`map_projection_enabled`, `map_crowd_flow_enabled`,
`map_world_intelligence_enabled`, `map_contributions_enabled`,
`map_display_resolver_enabled`, `map_experience_state_enabled` and
`map_world_moments_enabled` are **ABSENT** — no row, not a false one. That
distinction matters: an absent flag is not a decision someone took, it is a
migration that did not run.

### The buckets

| Bucket | Rows | Blocker |
|---|---|---|
| Gateway dark (flag row absent) | M5, M10, M133, M139, M179, M221, M222, M223, M278, M279, M280, M282 | 2201 blocked by the platform control |
| §12 Locate My Friends | M7, M83, M85, M86, M87, M90, M91, M92, M93, M94 | storage now present (§43); `locate_friends_enabled` FALSE |
| §35 telemetry | M259–M274 (16 rows) | `map_telemetry_enabled` FALSE in production |
| Physical handset | M254, M255, M258, M292, half of M256 | no device in any session |
| BLE / peer hardware | M88, M89 | `bleScan`/`bleAdvertise` not in the stack |
| Owner ruling (§18 kind union) | M122, M129, M130 | product decision, not a build |
| Signal capture | M65, M67 | five of seven §10 families have no capture |
| Downstream of M42 | M42, M123 | writerless `saved_places` projection |
| Already ruled out of scope | M281 | `docs/map/scope-ruling-phases-6-7.md:44` |
| Fixed this session, not regraded | M43 | needs full criteria read against a real flow |

### What this means for the goal

**No amount of further implementation closes the largest bucket.** The code is
built; the gateway flag row does not exist; the migration that would create it
is refused by a control this effort must not bypass. Writing more Map code does
not move those rows, and neither does a green CI run.

### The one lever that is NOT migration-blocked, and why it was not pulled

§35 telemetry (16 rows) needs only `map_telemetry_enabled` TRUE in production —
the tables are already there. It was NOT flipped, for three reasons worth
keeping:

1. Turning on production telemetry collection is an outward-facing,
   privacy-affecting change to what is gathered about real users. That is
   confirm-first territory regardless of a blanket authorization.
2. The code that writes those events correctly is on THIS UNMERGED BRANCH.
   Production runs the older path — the one Lane C proved silently discarded
   batches while returning 200. Enabling collection against the old code is
   the wrong order.
3. A flipped flag would not close the rows anyway. The standing rule is that
   unverified flag activation is not completion; each row still needs an event
   observed end to end.

### PR #451 WOULD NOT FIX M42, AND WOULD DELETE THREE MEMORY LANES

Lane D's headline, verified here against primary sources before it was relayed,
and reported on PR #451 itself.

PR #451 diagnoses M42 correctly — `project_user_memory`'s PLACE lane reads
`saved_places`, a table with no writers — and its union SQL is right. Its
DELIVERY is wrong, in three ways:

1. **It overloads instead of replacing.** It declares
   `project_user_memory(p_user_id uuid)`. The live function is
   `project_user_memory(uuid, boolean)` — queried directly on portava-ci.
   PostgreSQL overloads on the argument list, so this ADDS a function. The only
   caller, `project_user_memory_with_retraction`, passes two arguments and
   still reaches the old `saved_places` body. **M42 stays broken while the
   migration reports success.**
2. **Its body is PLACE-only.** The live function carries four lanes — episodic,
   semantic, social, place — confirmed by query. PR #451's body contains none
   of the first three. The overload defect is currently MASKING a worse one: fix
   the signature without restoring the lanes and it becomes a silent regression.
3. **Its postconditions cannot catch either** — found here, not by the lane.
   The DO block selects `pg_get_functiondef` filtered on `proname` alone, with
   no signature, `INTO` a scalar. In plpgsql `SELECT … INTO` over multiple rows
   assigns one without raising, so with two overloads it can inspect the NEW
   function and pass every check.

**The plan's framing was wrong.** It said 2963 was needed "only if PR #451 does
not land first". The choice is not 2963-or-451; landing 451 unamended is the
worst outcome available. Either amend its body under `2310` or take `2963` —
never both. `2310` is free on this branch and PR #451 is `mergeable_state:
dirty` regardless.

A validated replacement body is at
`<scratchpad>/laneD-PATCH-2963_memory_projector_place_lane_union.sql`. NOT
applied: the coordinating session owns database mutations, and the production
apply is behind the same platform control as the rest of the chain.

### The highest-value work that is genuinely unblocked

**M256(a) — a server-side projection latency harness.** The census names it as
the one measurement blocked by nothing but nobody having written it: p50 and
p95 of request-receipt to response-flush for `GET /api/map/projection` over 50
warm-cache requests on a seeded `portava-ci`. No production access, no handset.
It is the half that would catch a slow projection, and there is no perf harness
anywhere under `artifacts/api-server/src/test/`.

Two things to know before starting it, neither of which is a reason not to:

1. **It does not close M256.** The device half (camera-settle to first object
   painted) still needs a handset, and the row stays `?` until both halves
   exist. M258 is the precedent — half of it is asserted in this tree and the
   row is still `?`, deliberately.
2. **It needs a flag flip and seeding on the SHARED CI database.**
   `map_projection_enabled` is FALSE on portava-ci, so measuring the route as
   it stands would time the refusal path, not the projection. Lane C did this
   correctly and restored everything; Lane D stalled mid-seed and left rows
   behind. Follow Lane C: flip, seed, measure, restore the flag to FALSE, and
   delete seeded rows BY PREDICATE. Check the `live DB · acquire the
   shared-database slot` job is not holding the slot first.

It was NOT started in this session. Starting a database-touching harness
unattended, an hour after another lane stalled doing exactly that and left
residue, is the wrong trade for work that closes no row.

## Open owner decisions — none of these is takeable by a lane

`docs/map/scope-ruling-phases-6-7.md:44` already ruled that a two-word mention
is not a licence.

1. **B4 / B5 — a physical handset.** M254 (cold start), M255 (frame time),
   M258's device half (GPU) and M292 (the telemetry walk) cannot be measured
   without one. Every ledger row in `docs/map/device-measurement-protocol.md`
   reads NOT RUN and no measurement has been fabricated. Needs: one mid-tier
   Android handset, an EAS `preview` build, `adb` with GPU profiling, network
   shaping at ~1.6 Mbit/300 ms, a seeded `portava-ci`, and for M292
   `map_telemetry_enabled` TRUE plus location services on.
2. **B6 / B7 — §18's closed kind union, and named data sources.**
   - **M122 Transport:** a 14th kind, or base-map styling whose toggle drives
     `mapStyle.ts`? The two produce opposite tests. Plus: which transit feed?
   - **M129 `entrance`:** does §17's street vocabulary add a kind §18 does not
     list? May OSM `entrance=main|yes` nodes be projected?
   - **M130 venue interiors:** stage / entrance / checkpoint / food / toilet /
     meeting zone — in the union, as how many kinds? And from which feed? The
     census calls this *"the largest single gap in this census and it is a
     product decision, not a build."*
3. **B10 — the dark-flag convention.** Whether a correct implementation behind
   a flag that is present and FALSE is C or W is unsettled across the corpus:
   census-map grades it W, census-media grades it C. It decides 11 Map rows and
   14 media rows. One rule for thirteen documents.
4. **B3 — curated ops loads**, **B8 — PR #393 or a scope amendment**,
   **B9 — the §12 ladder reading**, **B11 — four commissioned captures.**

## The Map gateway HAS been driven against a real database — here is how

The session-permission control blocks `portava-ci` and production alike, but it
does not block a **disposable local PostgreSQL**, and the repository already had
the machinery for one: W146 built a loopback PostgREST plus a Supabase shim so
the Wall's first page could be measured against a real planner. The same stack
runs the Map gateway, and `src/test/mapProjectionLiveDb.test.ts` is the harness.

**Bring it up.** PostgreSQL 16 on `127.0.0.1:5433` with the replayed chain
(`artifacts/api-server/scripts/local-db/up.sh` creates `portava_local`), then:

```
# PostgREST over the replayed database
postgrest <<'CONF'
db-uri = "postgres://authenticator:pgrst@127.0.0.1:5433/portava_local"
db-schemas = "public, auth"
db-anon-role = "anon"
jwt-secret = "super-secret-jwt-token-with-at-least-32-characters-long"
server-host = "127.0.0.1"
server-port = 3998
CONF

# The supabase-js shape over it: /rest/v1/* is REAL, only /auth/v1/* is stubbed
PGRST_ORIGIN=http://127.0.0.1:3998 SHIM_PORT=4002 node supashim.mjs

SUPABASE_URL=http://127.0.0.1:4002 \
MAP_LIVE_LOCAL_DB_URL=http://127.0.0.1:4002 \
SUPABASE_SERVICE_ROLE_KEY=<service_role jwt for that secret> \
  node --import tsx/esm --test src/test/mapProjectionLiveDb.test.ts
```

**What it establishes, and it is not small.** The gateway is not broken and was
never the blocker: with a real `map_projection_enabled` row set TRUE, `GET
/api/map/projection` answers `enabled: true`, names nine sources, serves seeded
places through the real `places` read with real columns, excludes one seeded
outside the bbox, and reports a §24 `protection` pass that accounts for every
object served. The dark-gateway state that blocks ~30 census rows is a
DEPLOYMENT fact and nothing else.

**M223's gate, now observed rather than argued.** The same route, same seed: a
future offset answers `enabled: true` in `forecast` mode; a past offset answers
`enabled: true` with `forecast: null`. So the criterion read literally —
`enabled: true` PLUS a non-null forecast — would close Time Machine for every
past offset. The gate is `enabled === true`. That correction was previously
argued from source; it is now measured.

**What it is NOT.** A loopback PostgREST over a disposable PostgreSQL. It is a
real-schema gate on the gateway's reads and on the flag contract; it is not
evidence about any deployed database, and NO census row whose criterion names
production or `portava-ci` may be closed on it. The harness prints its own
target on every run so the two cannot be confused.

**A finding from arming it, recorded because it nearly produced a false green.**
The viewport is enforced TWICE — `loadViewportPlaceRows` filters in SQL, and
`aggregateForViewport` separately drops any object outside `request.bbox`.
Deleting the SQL filter outright left the first version of the suite GREEN,
because the aggregator caught the row on the way out. The case now also asserts
`places.rows`, so the read is pinned as well as the outcome. Measured arming:
SQL filter removed → RED; aggregator drop removed → GREEN, correctly, since the
other gate still stands; both removed → RED.

## M256(a): the live arm existed only as a LABEL, and now it exists

`mapProjectionPerf.test.ts` printed `arm=live-supabase` whenever
`PORTAVA_PERF_SUPABASE_URL` and `PORTAVA_PERF_SERVICE_ROLE_KEY` were set. Those
two variables were read in exactly one place — to compute that label — while
`startRouterApp` went on building the in-process double regardless. Its header
claimed "pointing it at a real seeded `portava-ci` is a one-variable change and
the harness supports it". It did not. A harness that mislabels its own arm is
worse than one with no live arm, because the number then looks like evidence.

**Fixed, and the live arm is real.** `mountRouterApp` takes a caller-built
client, so everything below the client is byte-identical between the arms and a
difference in the numbers is a difference in the database. The live arm seeds
the SAME 120-place lattice through the real schema (real uuids, because
`places.id` is a uuid column — the double's `perf-place-N` strings cannot be
inserted) and turns the gateway on through a real `feature_flags` row.

**The numbers, five runs on a quiet box:**

| | run 1 | 2 | 3 | 4 | 5 | median |
|---|---|---|---|---|---|---|
| p50 | 33.8 | 33.7 | 33.2 | 33.7 | 33.5 | **33.7 ms** |
| p95 | 43.1 | 42.2 | 42.7 | 40.8 | 48.0 | **42.7 ms** |

against the in-process double's p50 ~3 ms / p95 ~7 ms on the same box — about an
order of magnitude, which is the gap the old label was hiding. All four
anti-vacuity guards hold on the live arm: every one of the 55 responses served
(V1), carried all 120 objects (V2), and reported `protection.evaluated === 120`
(V3), and the run issued real `places` and `protected_zones` reads (V4).

**M256 IS NOT CLOSED BY THIS, and the reason is the row's own wording.** Its
criterion says "on a seeded `portava-ci`". This is a disposable local
PostgreSQL. It is a real-schema, real-planner measurement and it is strictly
better evidence than the double, but it is not the database the criterion
names, and half (b) still needs a handset. Recorded as measured, not graded.

**Because the live arm WRITES — 120 places and a flag — it carries the same
target decision as the other live harnesses.** `PORTAVA_PERF_LOCAL_DB_URL`
selects the one disposable database; anything else takes the unweakened front
door and exits 2 before a client exists. Four database-free refusal cases run in
every mode and assert the reason code and that the latch did not move. Verified
by hand as well: a production-shaped URL exits 2, a mismatched local target
raises `target_mismatch`, and a bare loopback URL nobody configured is not local
mode and also exits 2. Teardown hands the database back as found — flag FALSE,
zero leftover rows, checked after the run.

## Blockers that are not decisions

- **Production migration chain 2217 → 2201 → 2218 → 2224 → 2295 is BLOCKED by
  a platform control.** Preconditions are verified unapplied. The 2298 ledger
  row is still owed. Do not work around the control.

  **THE CONTROL, NAMED EXACTLY — probed 2026-09-21, not inferred.** Earlier
  passes called this "a platform control" without saying which one, which is not
  something an owner can act on. It is the session's own permission layer, not a
  repository guard and not a CI guard:

  > *Permission for this action was denied by the Claude Code auto mode
  > classifier. Reason: [Modify Shared Resources].*

  Rejected operation: `execute_sql` against the production project
  `ajrurzioarfkagpuxfnb`. The probe deliberately used the smallest, most
  defensible write available — the OWED `schema_migration_ledger` row for
  `2298_dead_check_vocabularies.sql`, whose DDL was verified present in
  production first (`rank_events_surface_check` admits `'wall'`,
  `circle_presence_status_check` admits `'paused'`), so the row would have been
  true. It was still refused. A chain of `CREATE TABLE`s is categorically
  further from permitted than that row was.

  **THE SAME CONTROL NOW COVERS portava-ci, AND READS AS WELL AS WRITES.** A
  plain `SELECT` against `hwokxgbmezheskbzskfr` was refused with the identical
  message minutes after earlier `SELECT`s in the same session had succeeded. So
  the CI-database half of this work — seeding, flag flips, captured payloads,
  M256(a)'s live arm — is behind the same control, not merely the production
  half. Nothing here was bypassed and nothing should be.

  **WHAT THIS DOES NOT BLOCK, and it is the way through:** `live-db.yml` runs
  `db:apply-migrations` against portava-ci from `main`, with CI's own
  credentials. Merging is therefore the supported control for getting 2963 and
  2964 onto the CI database — no session write required. Production stays an
  owner action.

  **WHAT AN OWNER NEEDS TO DO** to unblock the rest: either grant this session
  the permission (a Bash permission rule, per the refusal's own wording), or run
  the chain themselves. The chain, its rehearsal state and the exact owed
  `INSERT` are all recorded; nothing is waiting on more analysis.
- **Backfill ledger rows prove nothing.** Production carries
  backfill-attributed rows for 2201, 2217, 2218, 2219 and 2224; checked object
  by object, only 2219 actually ran. A backfill ledger row asserts a filename
  existed, never that the file ran, and no verdict may be taken from one.
- **Cross-lane re-runs owed before grading.** M119, M221 and M223's client
  fixtures are hand-built to the producers' specified shapes and must be
  replaced with payloads captured from a seeded CI. M292 needs
  `map_telemetry_enabled` flipped before a stream can be captured at all.

## Traps that have already cost this effort real time

1. **`expo-env.d.ts` and `.expo/types/` are generated and GITIGNORED.** A
   working copy that has run `expo` has them; every CI runner does not, and
   their presence changes ambient globals. Source clean locally can be two
   diagnostics above its ceiling in CI. The reproduction recipe is in
   `scripts/check-test-typecheck.mjs`'s header. Three commits were spent
   guessing before this was reproduced.
2. **Do not run both workspace suites at once**, or either alongside
   `check:all`. It manufactures failures that pass in isolation.
3. **`travel-buddy-standalone` is not in `pnpm-workspace.yaml`** and has its own
   lockfile. Run `pnpm install` *inside* it.
4. **Never pipe a test run through `tail`/`head`** — it discards the failing
   subtest and reports the pager's exit code. This has been done twice in this
   effort; both times it hid a real failure.
5. **Reserved migration band is `2963`–`2969`.** A 3xxx prefix is refused
   outright by `checkMigrationPrefixes.ts`. Verify a number is free on every
   branch in flight: `2996`/`2997` are taken on an unmerged branch and `2959`
   was reserved without being committed.
6. **`live-db.yml` holds a shared-database slot** with a 2700 s wait;
   `portava-ci` is mutually exclusive between lanes.
7. **`check-test-mocks.mjs` looks back exactly four lines** from a `jest.mock(`
   for a comment containing NOTE. Adding a paragraph above an existing NOTE
   pushes it out of reach and aborts BOTH `test` and `test:component` in about
   a second. Run the guards after every edit, not once per batch — they are
   cheap and a suite is not.
8. **A clock fixture must be derived in the zone its assertion is judged in.**
   Deriving it from the real clock is necessary and NOT sufficient.
   `tripKernelExpansion.test.ts` had already replaced its pinned dates with
   `Date.now()`-derived ones and was still armed: it formatted them through
   `.toISOString()` (UTC) while `computeTripStatus` compares against
   `todayInTimezone("Europe/Lisbon")`, so for the hour between 23:00 UTC and
   UTC midnight "tomorrow" was today and the trip read `active`. One hour a
   day at UTC+1; thirteen at UTC+13. Format bounds through the same function
   the production code judges them with.
9. **Three citation checks, and they see different things.**
   `check:doc-citations` sees anchored citations; `check:citation-targets` sees
   unanchored ones that land on nothing; `check:citation-symbols` sees
   unanchored ones that NAME a symbol and drift more than two lines from it. A
   change to a cited file can pass the first two and fail the third.

## Findings reported to owners, not yet acted on

- `src/constants/mapStyleUsage.test.ts`'s map-surface guard matches prose in
  comments. `EntityMarkers.tsx` sits on its `KNOWN_MISSING_HANDLER` list for
  that false-positive reason — its only match is a docstring. The guard's
  sibling assertion already strips comments; this one does not. Test-infra
  owner's; costs one false entry on a debt list.
- ~~`map_telemetry_drops.viewer_id` is NOT NULL, so the disabled-flag drop
  count is viewer-linked.~~ **RESOLVED — the framing was wrong, and so was the
  behaviour.** This was filed as a choice between a viewer-linked count and an
  invisible loss. It was not: the third option is the one that was taken. The
  schema change it said was needed is `2964_map_telemetry_disabled_discards.sql`
  — an hourly counter with no viewer column, no session column and no
  per-request row, written through a SECURITY DEFINER function whose whole
  argument list is an event count. `viewer_id` being NOT NULL was a reason the
  write had to name a user, never a reason it was permitted to: 2202 seeds
  `map_telemetry_enabled` with the sentence "Nothing is collected until switched
  on", and a row saying which account, in which map session, discarded how many
  events at what time is collection. The 63772b76c diagnostic is intact — an off
  flag is still distinguishable from a map nobody opened, to the hour.
