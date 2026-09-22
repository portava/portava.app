# LANE REPORT — LO-CLIENT

Branch `lane/lo-client`, worktree `/home/user/wt-lo-client`, based on `561a0a7b0`.
Commits: `7356159f2`, `302ceb4a5`, `c3dd7b7cb`, `50e8b7bb6`.

**Every "current verdict" below is the tool's, not the document's** —
`CENSUS_INTEGRITY_DUMP=ALL npm run check:census-integrity | grep '^layover|'`
run in `artifacts/api-server` before any edit (296 rows parsed). Reading the
census body would have given me the FIRST statement for eight of my rows and
the wrong starting point for L157 (body `N`, tool `W`).

API base is `https://portava.replit.app` (`travel-buddy-standalone/eas.json:10`).
Every server field this lane consumes (`safeEnvelope`, `offlineBundle`,
`advice.reasonCodes`, per-recommendation `feasibility`) exists on `origin/main`
as well as on this branch, but **no deployed or device verification was
performed by this lane**: everything below is implementation verification.

---

## Row table

| row | current verdict (tool) | my verdict | one-line evidence |
|---|---|---|---|
| **Map / envelope / route presentation** ||||
| L17 | W | W | The map is no longer "pins only": envelope diagram, blocked list, return-leg strip and CTA anchor all arrive as props (`src/components/layover/LayoverMapCard.tsx:336,426,463`). No plan route and no digital-twin layer, so still W. |
| L115 | W | W | The stated reason ("no envelope geometry to consume") is FALSE — the screen passes `overview.safeEnvelope` in (`app/layover/[id].tsx:884`). Still W: there is no active SNAPSHOT to consume. |
| L116 | N | **W** | Geography is drawn from the certified envelope (`LayoverMapCard.tsx:336-381`); only `BLOCKED`/`UNCERTIFIED` have producers — `SAFE`/`TIGHT` have none (`src/services/layover.ts:501`). |
| L117 | N | **W** | Blocked pins are kept off the map and listed with the server's reason (`LayoverMapCard.tsx:426-440`), but the band is joined on `rec.id` (`app/layover/[id].tsx:397-401`) and ids exist only when `layover_stable_recommendation_ids_enabled` is ON — FALSE in production. Built, cannot render live. |
| L118 | N | N | No time-budget chips, and no server route to replan against a budget: `grep -n "maxTravel\|timeBudget\|simulate" artifacts/api-server/src/routes/airport.ts` finds only two comments. |
| L119 | N | **W** | The return leg and its deadline always render, plan or no plan (`LayoverMapCard.tsx:463-471`). No line is drawn because there is no routed provider. |
| L120 | W | W | Not touched by this lane. |
| L121 | N | **W** | Both radii drawn at a printed fixed metres-per-pixel scale, so a shrinking window is a visibly smaller ring (`LayoverMapCard.tsx:336-381`). A diagram beside the map, not a basemap isochrone. |
| L122 | N | **W** | Same code as L117 and the same flag ceiling. |
| L124 | N | N | No location-grant store for crew; not client-fixable. |
| L125 | N | **W** | Blocked areas carry the server's own reason and no band renders as safe (`LayoverMapCard.tsx:426-440`, caveat at `:387`). Reachable only once a pin is banded — same flag ceiling. |
| L126 | N | **W** | Online: certified-at plus a stale badge on the map card (`LayoverMapCard.tsx:392,399`). Offline: last-certified, its age and the envelope radii on the failure screen (`src/components/layover/LayoverOfflinePlanCard.tsx:101,136`). No map is drawn offline. |
| L270 | W | W | Same as L17: envelope and return state are there, plan route and twin layers are not. |
| **Return / disruption / safe-return UX** ||||
| L18 | W | W | Not touched. |
| L41 | W | W | Not touched — the notification half needs an owner decision (below). |
| L142 | N | N | `ReturnContract.route` is `null` with `routeUnavailableReason: 'no_routing_provider'` (`src/services/layover.ts:305-306`). |
| L143 | W | W | Not touched. |
| L144 | N | N | Server sends `crewNotifyUnavailableReason`; nothing to render differently. |
| L145 | N | N | No rebooking/airline/help content exists anywhere. |
| L147 | W | W | Not touched. |
| L148 | W | W | Not touched. |
| L156 | W | W | The CLIENT half is now reachable and tested: `localReplan` had no caller anywhere and is now asked on the failure screen (`app/layover/[id].tsx:633`), rendering a conservative figure or the server's refusal (`LayoverOfflinePlanCard.tsx:146-160`). Not C — the schedule-change refusal cannot fire on this tree, and no device verification. |
| L272 | W | W | Not touched. |
| **Offline and caching** ||||
| L151 | N | **W** | The airport and the certified area are cached and rendered offline (`src/lib/layoverPlanCache.ts:174`, `LayoverOfflinePlanCard.tsx:100,136`). No route half: there is no routed provider to cache from. |
| L152 | N | N | `route: unavailable('no_routing_provider')` — nothing to cache. |
| L153 | N | N | `flightStatus: unavailable('no_flight_feed')`; the traveller's own typed schedule is cached for the replan rule and is deliberately NOT presented as a flight status. |
| L154 | N | N | The bundle still answers `no_crew_storage`; the client type is already `OfflineCapability<string>` and ready. |
| L155 | N | N | `translationPhrases: unavailable('no_phrase_catalogue')` — no catalogue to cache. |
| L233 | N | **W** | The cached plan is on the failure screen with its age and a stale indicator (`LayoverOfflinePlanCard.tsx:101,169`; dashboard cases 2, 3, 6). Not C: the row is filed under the snapshot family blocked on an unapplied migration, and nothing here clears that. |
| **Presence / crew / consent controls** ||||
| L127 | W | W | Client ladder already built; aggregate-first is server-gated. |
| L128 | W | W | `presence.level === 'L0_AGGREGATE'` is rendered (`src/components/layover/LayoverPeopleSection.tsx:83`); `layover_presence_ladder_enabled` is FALSE and 2740 unapplied. |
| L129 | N | N | No intent model on the wire. |
| L130 | W | W | Reciprocity is still one global toggle, server-side. |
| L131 | N | N | No chat (census §26.2, deliberate). |
| L132 | N | N | No precision ladder / grant store. |
| L158 | N | N | Same. |
| L164 | N (`∅`) | N — **now guarded** | The absence was unguarded; it is now pinned by a source scan over the whole layover surface (`src/lib/__tests__/layoverSensingCadence.test.ts:107`). Verdict unchanged; the `∅` marker should go. |
| L166 | N | N | No precise sharing exists to control. |
| L168 | N (`∅`) | N — **now guarded** | Same scan, second case: no `expo-image-picker` / `expo-contacts` / `expo-camera` / `expo-media-library` import and no picker or contacts call anywhere on the surface (`src/lib/__tests__/layoverSensingCadence.test.ts:167`). Verdict unchanged; the `∅` should go. |
| L187 | W | W | The presence record's fields do not exist server-side. |
| **Sensing cadence and permission prompts** ||||
| L157 | W | W | The adaptive half now exists on the only loop this surface has: the overview re-read follows the certified rung (`src/lib/layoverSensingCadence.ts:74`, wired `app/layover/[id].tsx:201`). Still W — no location sensing exists, so the server's `sensingPolicy` governs nothing and is published on no route. |
| **Recommendation and plan surface** ||||
| L74 | W | W | Server contract row; untouched. |
| L76 | W | W | Server contract row; untouched. |
| L182 | W | W | Server contract row; untouched. |
| L183 | W | W | Server contract row; untouched. |
| L219 | W | W | Lives in `artifacts/api-server/src/test/airport.test.ts` — outside this lane's ownership. |
| L220 | W | W | Same. |
| L223 | W | W | Same; "expanded options" needs a server candidate set. |
| **Reason-code rendering** ||||
| L279 | N | N | `BAGGAGE_STATUS_CRITICAL_UNKNOWN` has a renderer now (`src/lib/layoverReasonCodes.ts:118`) and still no emitter — `checked_bags` is a boolean and unknown is unrepresentable. |
| L281 | W | W | Renderer added; emitter needs an airport-truth fact nobody produces. |
| L282 | W | W | Renderer added; the corridor provider is disabled on production. |
| L283 | N | N | Renderer added; declared, never emitted. |
| L284 | N | N | Renderer added; declared, never emitted. |
| L285 | W | W | Renderer added; same fact ceiling. |
| L286 | W | W | Renderer added; same fact ceiling. |
| L287 | W | W | Renderer added; same fact ceiling. |

Nine rows move, all `N → W`, all in the two groups where the client was the
blocker. **No row moves to C.** Seven of the nine were already built by an
earlier client lane and had never been re-measured (L116, L117, L119, L121,
L122, L125, L126); two are this lane's own work (L151, L233).

---

## BUILT

### Files added
* `travel-buddy-standalone/src/lib/layoverReasonCodes.ts`
* `travel-buddy-standalone/src/lib/layoverPlanCache.ts`
* `travel-buddy-standalone/src/lib/layoverSensingCadence.ts`
* `travel-buddy-standalone/src/components/layover/LayoverOfflinePlanCard.tsx`
* `travel-buddy-standalone/src/lib/__tests__/layoverReasonCodes.test.ts`
* `travel-buddy-standalone/src/lib/__tests__/layoverPlanCache.component.test.ts`
* `travel-buddy-standalone/src/lib/__tests__/layoverSensingCadence.test.ts`
* `travel-buddy-standalone/src/components/layover/__tests__/CanILeaveCard.reasonCodes.component.test.tsx`
* `travel-buddy-standalone/app/layover/__tests__/layoverDashboard.cachedPlan.component.test.tsx`
* `travel-buddy-standalone/app/layover/__tests__/layoverDashboard.refreshCadence.component.test.tsx`

### Files changed
* `travel-buddy-standalone/src/components/layover/CanILeaveCard.tsx` — renders the reason codes.
* `travel-buddy-standalone/app/layover/[id].tsx` — plan cache write/read, offline card, cadence, replan call.

### Import chains (reachability)

The root is the same for all four and is registered with the navigator:

```
app/(tabs)/index.tsx:28,676                    home tab mounts <ActiveLayoverPill/>
  -> src/components/layover/ActiveLayoverPill.tsx:31   router.push(`/layover/${session.id}`)
     -> src/navigation/portavaRoutes.ts:1137-1144      key 'layover-detail', path 'layover/[id]'
        (npm run check:route-registry: OK, 199 screens represented)
        -> app/layover/[id].tsx                        the expo-router file route
```

`LayoverModeSheet` (5 importers) is the second entry point, via session creation.

From `app/layover/[id].tsx`:

| what | chain |
|---|---|
| reason codes | `:56` import `CanILeaveCard` -> `:792` render -> `CanILeaveCard.tsx:20` import -> `:73` `describeReasonCodes(advice.reasonCodes)` -> `:106` `testID="layover-reason-codes"` |
| offline plan card | `:76` import -> `:674` `<LayoverOfflinePlanCard plan={plan} replan={replanDecision} .../>` on the failure screen -> `LayoverOfflinePlanCard.tsx:101` |
| plan cache | `:80` import -> `:299` write on every successful load -> `:334`/`:350` read on every non-`gone` failure |
| sensing cadence | `:201` `layoverSensingCadence({sessionStatus, returnState})` -> `:216` the silent-refresh `setInterval(..., refreshIntervalMs)` |
| local replan | `:633` `localReplan(cachedDeadlineAsBundle(cached), {...})` -> passed to the card at `:674` |

The map rows I moved were built by an earlier lane; their chain is
`app/layover/[id].tsx:880 <LayoverMapCard ... envelope={overview.safeEnvelope}
candidateFeasibility={candidateFeasibility} offline={overview.offlineBundle}/>`,
which I re-verified by reading both files and running both map suites.

---

## TEST EVIDENCE

All commands run from `/home/user/wt-lo-client/travel-buddy-standalone`.
`node_modules` is symlinked from the main clone (the worktree has none); the
symlink is untracked.

| command | result |
|---|---|
| `npm run typecheck` (`tsc -p tsconfig.json --noEmit && check-import-extensions`) | clean, after every change |
| `npm run typecheck:tests` | `173 diagnostics across 60 files (baseline 173 across 60)` — OK, nothing above baseline |
| `npm test` (node:test runner, 813 suites) | `# tests 6616 # pass 6616 # fail 0` |
| `npm run check:route-registry` | OK — 199 screens, 9 layouts |
| `npx jest --forceExit 'layoverDashboard\|layover/__tests__\|CanILeave\|LayoverMap\|layoverPlanCache'` | `Test Suites: 2 failed, 25 passed, 27 total` / `Tests: 171 passed, 171 total` |
| `npm run test:component` (jest native + `jest -c jest.web.config.js`) | `Test Suites: 617 passed, 617 total` / `Tests: 3902 passed, 3902 total`, then `3 passed` / `8 passed` on the web config, `EXIT=0` |

The two "failed" suites are `layoverLocalReplan.test.ts` and
`layoverReturnFacts.test.ts`: node:test files that jest's `testMatch` picks up
and rejects with "Your test suite must contain at least one test". They pass
under `npm test` and the behaviour predates this lane.

### Failing-first, watched

| suite | RED | GREEN |
|---|---|---|
| `layoverReasonCodes.test.ts` | `# pass 0 # fail 1` — module did not resolve | `# tests 7 # pass 7 # fail 0` |
| `CanILeaveCard.reasonCodes.component.test.tsx` | `Tests: 3 failed, 1 passed` — the "no codes renders no block" negative already passed, which is what proves an always-rendering card could not pass the file | `3 suites, 15 tests passed` (all CanILeaveCard suites) |
| `layoverPlanCache.component.test.ts` | `Tests: 0 total` — `Cannot find module '../layoverPlanCache'` | `7 passed` |
| `layoverDashboard.cachedPlan.component.test.tsx` | `Tests: 3 failed, 2 passed` — the cache-absent and session-gone negatives already passed | `7 passed` |
| `layoverSensingCadence.test.ts` | `# pass 0 # fail 1` — module did not resolve | `# tests 7 # pass 7` |
| `layoverDashboard.refreshCadence.component.test.tsx` | `Tests: 1 failed, 1 passed` — RETURN_NOW failed at `Expected: > 1 / Received: 1` while the NORMAL regression case passed | `2 passed` |

The L164/L168 guards were themselves watched RED: dropping a file importing
`expo-location` into `src/components/layover/` turned case 7 into
`not ok 7 ... __probe_location.ts: imports expo-location`; the probe was then
deleted and the suite returned to `# pass 8`. A prohibition guard that cannot
fail is not a guard.

A bug the RED/GREEN cycle caught: once both caches were seeded, dashboard case 3
matched `/Last certified \d+ min ago/` twice (deadline card and plan card). The
assertion now reads the plan card's own node rather than being loosened.

### Two testing facts about this workspace, measured

1. `npx jest --testPathPatterns=X` (plural) is **silently ignored** here — it
   ran all 931 suites. The positional form `npx jest X` and the singular
   `--testPathPattern=X` (what `npm run test:component` uses) both filter
   correctly. I wrongly concluded `test:component` was broken and re-measured;
   it is not.
2. Under fake timers, a synchronous `render()` is not recorded into RNTL's
   module-level `screen` in this setup — `screen.getByTestId` answers "`render`
   function has not been called" for a tree that is on screen. `await render()`
   and the returned queries work. Reproduced with a one-component probe before
   relying on it; the probe file was deleted.

---

## NOT DONE AND WHY

**(a) needs a server route or field that does not exist**

* **L118** — map time-budget chips that trigger a simulation. Needed:
  `POST /api/airport/sessions/:id/simulate` taking
  `{ maxOneWayMinutes?: number, maxTotalMinutes?: number }` and answering a
  certified window plus re-banded candidates. Today the only recompute is
  `PATCH /sessions/:id` on a schedule edit. A client-side `Array.filter` over
  recommendations is what the requirement explicitly forbids, so nothing was
  added.
* **L117 / L122 / L125 — the live ceiling, and it is the census's own defect
  class again.** The map's per-pin band is real and tested, but it is joined on
  `rec.id`, and `LayoverRecommendationService.ts:719,726,868` populates
  `idByKey` only when `opts.stableIds` is set, which comes from
  `layover_stable_recommendation_ids_enabled` — seeded FALSE in
  `2410_layover_recommendation_identity.sql:66` and FALSE in every production
  snapshot through `20260916c`. So in production every card arrives without an
  id, `candidateFeasibility` is `{}`, and **no pin has ever carried a band**,
  exactly as no traveller ever saw "Add to plan". One flag flip fixes both.
  Not client-fixable: a stop's `recommendationId` cannot exist either.
* **L129** intent model, **L131** crew chat, **L132 / L158 / L166** precise
  location grant store, **L187** presence record fields, **L143 / L153** gate
  and flight data, **L144 / L154** crew notification and meeting point on the
  bundle, **L155** phrase catalogue, **L152 / L142 / L119(route half)** routed
  provider.
* **`sensingPolicy` is on no route.** `LayoverDegradedService.sensingPolicy`
  is fully built and published nowhere (`grep -n sensingPolicy
  artifacts/api-server/src/routes/airport.ts` is empty). If the owner wants the
  client to obey the server's sensing table rather than its own polling
  cadence, add it to `GET /overview` beside `offlineBundle`.

**(b) needs a file another lane owns**

* **L219 / L220 / L223** — these are scenarios in
  `artifacts/api-server/src/test/airport.test.ts`. Nothing on the client can
  move them.
* The `travel-buddy-standalone/package.json` scripts: `test:component` should
  use `jest --testPathPattern` (singular) as it already does; no change needed,
  but the plural-flag trap is worth a comment. Not mine to edit.

**(c) needs an external credential / service / device**

* Device or deployed acceptance of everything in this report. The offline paths
  were exercised with a mocked failing read, never with a real radio off, and
  nothing here was run against `https://portava.replit.app`.
* `LAYOVER_ROUTED_CORRIDOR_ENABLED` / Google Routes billing — the route half of
  L119, L142 and L152 stays impossible until an owner buys it.

**(d) out of scope / needs an owner decision**

* **L41's notification half.** Firing a high-priority notification when the
  server says `RETURN_SOON` means prompting for notification permission on
  behalf of a state change rather than a tap, which reverses the L165 rationale
  work already done. Product decision; not taken unilaterally.
* **`POST /api/layover/events`** (`artifacts/api-server/src/routes/layoverEvents.ts`)
  — confirmed as a machine-producer ingest with a shared secret. No client row
  I own wants that door and nothing here calls it.
* **`src/components/layover/LayoverRecommendationScreen.tsx` (15 KB) is still
  imported by nothing** at this commit — headline defect 4, unchanged. I did
  not delete it (destructive, and someone may intend to mount it) and did not
  wire it (it duplicates `LayoverRecsSection`, which is a product call). It is
  the one remaining orphan on this surface; `layoverLocalReplan.ts` was the
  other and this lane gave it a caller.

---

## STALE EVIDENCE FOUND

Each re-tested at `561a0a7b0` before this lane changed anything.

1. **L115** (line 3099): *"There is still no envelope geometry to consume."*
   FALSE — `overview.safeEnvelope` is published by the route and consumed by the
   map card. The verdict stays W for the snapshot half.
2. **L116 / L117 / L119 / L121 / L122 / L125** (lines 604-613, 3100): all six
   say the elements do not exist. FALSE at this commit — `LayoverMapCard.tsx`
   renders every one of them and two suites cover them. The rows had never been
   re-measured after the client lane that built them.
3. **L126** (line 1420): *"There is no map offline rendering and no envelope
   geometry."* Both halves FALSE — the stale badge is at `LayoverMapCard.tsx:399`
   and the geometry at `:336`.
4. **L151** (line 1414): *"`mapGeometry: unavailable(...)`. An honest refusal is
   not a cache."* True of the bundle field, but it reads as though no geometry
   exists to cache; `overview.safeEnvelope` carries it and is now cached.
5. **Appendix A preamble** (lines 866-869): *"There is no reason-code vocabulary
   anywhere in the layover code — no enum, no constant table, no column."*
   FALSE on the server since `LayoverSafetyEngine.ts:103` and now false on the
   client too. None of the fifteen verdicts moves because of it.
6. **L157** (line 1394, tool verdict W): *"The layover surface still performs no
   location sensing at all"* — re-tested and TRUE, and now guarded rather than
   incidental. The body's older `N` for this row (line 675) is the first
   statement, not the current one; reading the document rather than the dump
   would have mis-stated the starting verdict.
7. **§28's (d) bucket** (line 6555) lists the map surface rows as *"blocked on a
   file another lane owns — `travel-buddy-standalone/`"*. That lane has since
   shipped; the blocker was already gone when the line was written.
