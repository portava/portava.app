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
| D — Integrations | seeded-CI fixtures, cross-lane capture | **IN FLIGHT** |
| Integration owner | shared files, migrations, census, citations | this session |

Lane A's shared-file patches are landed (`8d82a324d`): M43's
`DiscoveryMapView.tsx` fix and M221's `app/map/index.tsx` refactor. Its M221
screen-level wiring gap is closed (`d8af7dd8d`) with both surviving mutations
proven red. Its third finding — a guard matching prose in comments — is fixed
(`486b633a5`): one name off the debt list, and the guard tightened rather than
loosened.

Client suite at the integration head: `check:all` exit 0, node:test 6384/6384
(0 fail, 0 skipped, 0 todo), jest 567 suites / 3646 tests, 3 webrender / 8. All
ten client guards, all three citation checks and all three census checks pass.

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

## Blockers that are not decisions

- **Production migration chain 2217 → 2201 → 2218 → 2224 → 2295 is BLOCKED by
  a platform control.** Preconditions are verified unapplied. The 2298 ledger
  row is still owed. Do not work around the control.
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
- `map_telemetry_drops.viewer_id` is NOT NULL, so the disabled-flag drop count
  is viewer-linked. The choice is between a viewer-linked count and an
  invisible loss; a count without an identity needs a schema change.
