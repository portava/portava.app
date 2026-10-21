# Claude handoff — Layover 165 remediation

Prepared October 20, 2026, America/New_York, at the owner's request to hand this work back to Claude. New implementation has stopped. All three Codex agents reached their usage limits before producing final handbacks for their last batches. This document records the files and logs inspected after that interruption, including failures.

## Start here

- **Working tree:** `/Users/areyouok/portava-sandbox/wt-claude-wave4-20261017`
- **Branch:** `claude/wave4-build-20261017`
- **HEAD:** `2a99ebc365ba8445c3b929380e021afde6a3ac53`
- **PR:** https://github.com/portava/portava.app/pull/764, stacked on #763 and #762.
- **API directory:** `artifacts/api-server`; client: `travel-buddy-standalone`.
- **At handoff, before this document:** 418 changed paths: 199 tracked modifications and 219 untracked files. **Nothing staged.** The large unstaged tree includes Claude's earlier work and the Codex continuation. Do not reset it, replace it with the clean flight tree, or stage it wholesale without reviewing the paths.
- **Status snapshot:** `/private/tmp/codex-layover-resume-20261019/handoff-git-status.txt`.
- Original owner directive: `/Users/areyouok/.codex/attachments/46544c6f-7f50-4760-85da-a2bfb6e2687d/Pasted text.txt`.
- Original Claude transcript: `/Users/areyouok/.claude/projects/-Users-areyouok/e549004b-da6f-4ba8-b5b4-1f48a2f1f7e9.jsonl`.

The owner authorized agents and completion of the original **165 built-but-wrong requirements**, without weakened criteria, fabricated sources, or artificial green results. The original baseline remains `docs/ops/layover-built-but-wrong-20261018.md`. The current tracker is `docs/ops/layover-165-remediation-progress.md`; the evidence ledger is `docs/ops/layover-165-final-verification.md`.

The tracker currently has exactly **165 unique rows: 140 BUILT, 7 IN PROGRESS, 18 BLOCKED-EXTERNAL, 0 VERIFIED PASS**. BUILT means implementation/local evidence, not production acceptance. Latest fanout/current-position/geometry work has not been fully reconciled into these statuses.

Read `docs/ops/layover-owner-decisions-20261018.md` and the original directive before changing scope. Production deployment, migrations and flags remain the owner's press. No paid provider calls, new accounts, purchase, production changes, or fabricated native-speaker/device verification occurred. Existing decisions and authorizations persist.

## Immediate unfinished work

### 1. Current-position preview: one type error and one failing client test

Agent: `resume_curation`. Main new files:

- API `src/services/airport/LayoverCurrentPosition.ts`
- API `src/routes/layoverCurrentPosition.ts`, mounted in `src/routes/airport.ts`
- API `src/test/layoverCurrentPosition.test.ts` — registered in `package.json`
- Additional actual API/database proof in `src/test/db/layoverTimingEvidence.db.test.ts`
- Client `src/components/layover/LayoverCurrentPositionCard.tsx`
- Client `src/components/layover/__tests__/LayoverCurrentPositionCard.component.test.tsx`
- Related client service/screen and provider `cachePolicy: 'no_store'` changes.

Behavior: one explicit foreground location request; two-minute freshness and 1,000-metre accuracy bound; owner/session/current canonical snapshot/request binding via a request-local WeakMap; actual current-origin outbound/current-return/future-return routing and Temporal Freedom Engine evaluation. It never persists raw GPS, geometry, a coordinate-derived identity, or a saved plan. Provider memoization is bypassed. Endpoint is no-store. It preserves or tightens canonical constraints, candidate risk, reasons and activity commitments. **This remains explicitly a temporary preview; saved experience execution still starts at the airport.**

Latest evidence directory:
`/private/tmp/claude-501/-Users-areyouok/e549004b-da6f-4ba8-b5b4-1f48a2f1f7e9/scratchpad/l165-current-position`

- `unit-final.log`: **38/38 pass**.
- `db-final.log`: **3/3 pass**, no skips.
- `mutants-results.json`: **7 killed mutants**, shared source unchanged.
- `client-final.log`: **3 pass, 1 fail**. Failure is test `"a late fix from the previous session is discarded without sending location"`: `getByTestId('check-from-location').props.onPress` is not a function. Use the actual mounted press interaction and preserve the late-fix/session-change assertion; don't remove the assertion to pass.
- Earlier two test-only diagnostics were repaired, but the later crew-wide checks found a **new production error**:
  `src/services/airport/LayoverCurrentPosition.ts(80,160): TS2345: string is not assignable to "INSUFFICIENT" | "LOW" | "MEDIUM" | "HIGH"`.
  See `scratchpad/l165-b2-buddy/logs/fanout-final-typecheck.log` and `fanout-final-typecheck-tests.log`. The test gate was **861 diagnostics/114 files against the unchanged 860/113 baseline**, solely this production file at that run.

Fix the actual type and mounted-client test, rerun the relevant tests and both production/test type checks. No final clean typecheck is claimed. Current-position/geometry cross-review was requested but did not occur before usage exhaustion.

### 2. Between-stop geometry: database integration fails for normal selected plans

Agent: `resume_snapshot`. Main new files:

- API `src/services/airport/LayoverExperienceGeometry.ts`
- API `src/test/db/layoverExperienceGeometry.db.test.ts` — registered
- Endpoint added to existing `src/routes/layoverExperiencePlans.ts`
- Client `src/components/layover/LayoverExperienceGeometry.tsx`
- Client `src/components/layover/__tests__/LayoverExperienceGeometry.component.test.tsx`
- Mount in `LayoverExperiencePlanCard.tsx`, client service additions and narrow Google-map support.

Intended behavior: an ephemeral, owner-only, no-store map bound to the selected plan ID/version, canonical snapshot, exact stop order and current source terms. Fetch every ordered hop and final return with the guarded provider; do not put geometry in immutable plan rows, offline cache, replay or logs. Clear geometry on expiry, plan change and unmount. Retain Google attribution and provider restrictions.

Latest evidence:
`scratchpad/l165-b2-recsa/experience-geometry-db.log`: **1 pass, 4 fail**.
`scratchpad/l165-b2-recsa/experience-geometry-client.log`: **12/12 pass across two suites**.

**Root cause identified immediately before stopping:** normal selected recommendation stops persist `lat/lng = NULL`. The new geometry service compares those stored stop coordinates against current candidate points and returns `plan_stops_changed` for ordinary plans, before several intended assertions can run. Simply removing this check would let changed place coordinates acquire geometry under an old reviewed timetable.

**Agent proposal, NOT implemented or approved as final design:** add an optional SHA-256 `routeInputHash` to the compiled contract, over ordered candidate keys, authoritative points and activity commitment; compiler writes it and geometry verifies it at entry and after routing. Require it for geometry, with old plans asked to review again. No migration and no provider geometry retained. At handoff `routeInputHash` was absent from the inspected server/client files. Evaluate this proposal and coordinate changes to the server/client contract schema and compiler. Preserve endpoint ownership, order, snapshot, expiry and final source rechecks.

Provider requests for a past nominal first-hop start must not masquerade as historical forecasts: the current code requests at least the current instant plus one second, exposes the actual forecast instant, and refuses when conservative arrival no longer fits the recorded hop end. Later hops keep their future contract times.

### 3. Durable route fanout: implementation/tests advanced; final integration and handback remain

Agent: `resume_crew`. Main files:

- `src/migrations/3908_layover_route_fanout.sql`
- `db/rollback/2026-10-19-3908-layover-route-fanout-rollback.sql`
- `src/services/airport/LayoverRouteFanout.ts`
- `LayoverExternalReplanPort.ts`, `LayoverReplanService.ts`, `LayoverRouteSubjects.ts`
- `src/services/layover/layoverExternalEventConsumer.ts`
- `src/lib/layoverExternalEventScheduler.ts`
- Expanded, already registered `src/test/db/layoverRouteSubjects.db.test.ts`.

Contract: at most 200 preparations per tick, keyset paging, leased work, retry/backoff, expired-lease recovery, owner/session/watch revision checks, explicit obsolete reasons. Canonical computation, children, supersession history, deterministic event ledger and work checkpoint commit atomically. Source events are processed only after complete scans and settled work. Mixed route/non-route envelopes remain explicitly refused and unclaimed. Scheduler continues backlog after 30 seconds.

New FALSE flag: `layover_route_fanout_enabled`, requiring seven existing route/canonical flags. New private RLS tables: `layover_route_dispatches` and `layover_route_work`; service SELECT only, guarded definer RPC writes. `after_session_id` now has session FK `ON DELETE SET NULL`; owned work cascades away with the session. Optional existing Safe Return linkage is tightened in the same settlement transaction when that product flag is ON.

Independent root review caught and agent fixed: missing comfort/vibe inputs, malformed opaque refs causing an unclaimable perpetual backlog, and retained personal pagination cursor. Real PG also exposed timestamp precision and concurrent SKIP LOCKED assumptions; these were corrected and retested. Existing sessions are compared to envelope receipt at millisecond precision; regenerated watches do not lose eligibility solely because they were recreated after event receipt.

Latest evidence directory: `scratchpad/l165-b2-buddy/logs`

- `route-fanout-final-pg.log`: **24/24 pass**, zero skips (combined route/rollback proof).
- `route-fanout-rollback-pg.log`: **2/2 pass**, both installation orders.
- `fanout-mutant-restored.log`: **25/25 pass**.
- `route-fanout-mutants-run.log` and parent `route-fanout-mutants.txt`: **10 mutants killed**, restored green, source bytes identical.
- Earlier neighboring suite: **177/177**, as reported by agent; consult its log before citing exact final coverage.
- `route-fanout-final-types.log`: type checks failed because of the current-position error above. Two attempted script names (`check:layover-supabase-chains`, `check:layover-read-result`) **do not exist**; exit254 is not a product test failure or a pass. Use the actual package scripts.

`completed.notifications` counts **notification decisions**, consistent with the existing port; it does not mean push/in-app delivery. No new delivery is implemented here. Root confirmed L99 is outside the original165 baseline, so no new delivery lane was started.

3908 rollback/full-catalog scripts are still in the scratchpad. Review whether to promote those independent proofs into registered CI tests, as root did for3898/3899. Final agent handback was interrupted.

## Completed continuation work worth preserving

Detailed prior handbacks are under:
`/private/tmp/claude-501/-Users-areyouok/e549004b-da6f-4ba8-b5b4-1f48a2f1f7e9/scratchpad`

- `l165-timing-evidence-handback.txt`: L46/L54/L55 sourced eleven-stage timing, real nearest-rank quantiles, paired whole-journey observations, conservative minima, missing/stale/refused evidence; L70 sourced activity commitment/exit delay. Migrations3881 and3907, both refusing rollbacks. API75, terminal/replay10, DB neighbors21 + rollback2, client4,10 mutants. Real airport/place/mode sample population remains external.
- `l165-flight-terminal-handback.txt`: owned linked Trips terminals reach all session loaders and canonical identity. Exact trim+uppercase matching, no guessed T prefix. Terminal-only updates recertify and close inapplicable scoped timing. PGlite2 and PG17 terminal+harness5 passed. No licensed flight feed invented.
- `l165-harness-boundary-handback.txt`: disposable PostgreSQL clones; transaction context, IPv6, cluster-role serialization, explicit causal missing-migration closure. No catch-all ignoring SQL errors.
- `l165-l205-independent-handback.txt`: fixed reused service builder retaining stale actor headers;36 audit/retention proofs,23 forged foreign HTTP probes, account erasure and atomic activation.
- `l165-b2-buddy-abort-handback.txt`: per-abort unticked Buddy notice choice, current owned accepted booking, privacy/blocks/flags, generic atomic-deduplicated notice.12 migrated,37 client,111 neighbors,7 mutants.
- `l165-b2-route-handback.txt`:3895 atomic route watches, stop dependencies surviving snapshot compaction,10 targeted/92 neighbors/7 mutants.
- `l165-l15-handback.txt`, `l165-l78-handback.txt`: immutable executable plans3898 and sourced objective facts/private intent3899.
- `l165-canonical-verification-handback.txt`, `l165-map-geometry-handback.txt`, earlier batch handbacks and the tracker cover the remaining continuation work.

Final timing identities: engine `2026.10.19-2`, feasibility shape `2026.10.19-3`, curation policy `2026.10.19-2`. Both reviewed31-scenario golden updates changed identity/version fields only, not numerical results, verdicts or rules. Historical versions explicitly refuse incompatible replay.

## Root rollback repairs and verified results

Actual PostgreSQL17 exposed rollback fingerprints that had only passed on PGlite's PostgreSQL18. PG18 catalogs NOT NULL as `pg_constraint.contype='n'`;17 does not. The table fingerprints in3871/3897/3898/3899 now exclude that duplicate representation **while still fingerprinting `attnotnull`**. Added falsifying nullability controls. Exact fingerprints were measured with the rollback's `search_path=pg_catalog,pg_temp` on both engines and match.

3871/3873 now explicitly refuse installed3908 dependencies (PL/pgSQL body references lack ordinary dependency edges); crew added the matching3895 guard. Pristine predecessor tests omit3908 explicitly and separate tests prove installed-dependent refusal.3899 predecessor tests omit3907, which extends its CHECK.

Logs under `/private/tmp/codex-layover-resume-20261019`:

- `postgres-portable-proof-final.log`: **38/38**, no skips.
- `pglite-portable-proof-final.log`: **42/42**, no skips; picked up the four subsequently promoted full-catalog tests.
- `postgres-complete-roundtrip.log`: **18/18**, no skips, rerunning3898/3899 including those four new tests.
- Full-catalog/every-public-and-auth-row proofs for3898/3899, previously scratch-only, are now appended to their registered migration test files. Both sorted-gap/after3999 orders, repeat/reapply,13 and14 refusal controls.
- Earlier `postgres-portable-proof.log` is a **failed intermediate run**. Its standalone flight17 and independent dashboard5 passed after terminal edits stabilized; rollback failures were subsequently repaired. Do not call that aggregate green.

## Integration bookkeeping already changed

- Registered new timing, terminal, current-position, geometry, harness and rollback tests in API `package.json`.
- Added activity/fanout readers and3881 readiness explanation in `src/test/fixtures/unappliedSchemaReads.json`.
- Added3908 RLS dispositions and account-deletion fates; regenerated `src/lib/deletion/deletionGraph.snapshot.json` (**450 tables**). Coverage check passed.
- Updated tracker/evidence ledger to140 BUILT/7 IN PROGRESS/18 external. Original165 requirements and census grades are unchanged.
- Refreshed Telegraph and Layover query inventories, but **regenerate them again after the last geometry/current-position edits**. Last query generation had2133 references,212 selects,95 literal sites,0 unresolved before later edits.
- Census acknowledgement adds named files and bounded explanations, never promotes a grade. `src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json` has huge inherited reason strings: do not print or reformat the whole file. Preserve array order and use JSONDecoder.raw_decode for narrow edits.
- Last all33 gate run: **30 pass,3 fail** in `gates-timing-route-summary.log`: freshness, citations, test types. Root subsequently added missing named paths and repaired24 citation anchors, then the final two by inspected source lines. **Fresh clean reruns were not completed.** Later production typing regressed as noted above.
- Final production plan is `docs/ops/layover-165-activation-packet.md`; it is **not execution-ready** until final source hashes, combined tests/CI and outstanding external evidence are supplied.

## Validation environment and commands

A task-local Homebrew PostgreSQL17.11/PostGIS3.6.4 server remains available, not a global brew service:

- URL: `postgresql://postgres@127.0.0.1:54339/portava_local`
- Binaries: `/opt/homebrew/opt/postgresql@17/bin`
- Data: `/private/tmp/codex-layover-resume-20261019/local-pgdata`
- Log: `/private/tmp/codex-layover-resume-20261019/postgres-server.log`
- The pressed helper uses server credentials and generated disposable databases; it does not mutate the named database. Ordinary `scripts/local-db/up.sh` does recreate its named target: use only this task's throwaway server.
- Local TCP/shared-memory calls required escalation in Codex; they were approved for this isolated test server.
- Stop only this server when no longer needed:
  `/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /private/tmp/codex-layover-resume-20261019/local-pgdata stop`

PGlite:
`LAYOVER_PGLITE_ROOT=/Users/areyouok/portava-sandbox/prod-apply-packet-20261017/verify/node_modules/@electric-sql`

Cache:
`PRESSED_LAYOVER_CACHE=/private/tmp/codex-layover-resume-20261019/pressed-cache`

Heavy runner:
`/Users/areyouok/portava-sandbox/lead-20261014/tools/heavy.sh LABEL COMMAND...`

Use its two machine-wide slots for full typechecking, >10 node test files, >5 Jest suites and full cold replay. **Never delete slots by hand.** No current continuation heavy/test processes appeared in the handoff process check; unrelated older orphan tests were left untouched.

Example, from the API directory:

```sh
LOCAL_DB_URL=postgresql://postgres@127.0.0.1:54339/portava_local \
PRESSED_LAYOVER_CACHE=/private/tmp/codex-layover-resume-20261019/pressed-cache \
/Users/areyouok/portava-sandbox/lead-20261014/tools/heavy.sh claude-layover-db \
node --import tsx/esm --test --test-concurrency=1 \
src/test/db/layoverExperienceGeometry.db.test.ts \
src/test/db/layoverTimingEvidence.db.test.ts \
src/test/db/layoverRouteSubjects.db.test.ts
```

All33 gates:

```sh
/Users/areyouok/portava-sandbox/lead-20261014/tools/heavy.sh claude-layover-gates \
/bin/bash /private/tmp/codex-layover-resume-20261019/gate-report.sh \
/private/tmp/codex-layover-resume-20261019/claude-final-gates \
/Users/areyouok/portava-sandbox/wt-claude-wave4-20261017
```

API test type baseline remains860 diagnostics/113 files; client173/60. Do not raise either. Packet replay explicitly excludes2481 and3601/3602 and uses a disclosed3982 pgvector stand-in. These limitations are not production proof.

Potential harness improvement identified but **not implemented**: the cache key reads migration bytes before replay, and replay reads them again. A concurrently edited SQL file could be published under an earlier key. Freeze/snapshot source for final runs, or add a verified input-stability check before publishing templates/READY. Do not silently claim a mixed-byte replay as final evidence.

## What remains after those repairs

1. Fix current-position typing/client regression and geometry binding; cross-review both features.
2. Integrate latest fanout evidence; promote scratch-only rollback controls where appropriate. Update tracker truthfully without changing the165 denominator.
3. Regenerate inventories and rerun all guards, API/client type checks, focused suites and final full aggregate on stable bytes.
4. Review/stage only authorized task files, commit and push to the existing branch, then obtain green CI. No final continuation commit has been made after `2a99ebc3`.
5. Current CI is **not green**: flight commit CI39212772750 failed on kernel count assertions, flight index fixture and absent-schema harness; local repairs are in the unstaged tree. Live DB run39212772738 also failed on unapplied schema/static authorization. Do not substitute local test results for CI.
6. Earlier broad suite recorded pretest2763 pass/2 expected skips, main41079 pass/2 fail. Those two static failures were repaired and37 targeted tests passed, but this was never rerun as an all-green final aggregate.
7. Finalize the activation packet with actual commit/hash/CI and exact blockers. Production remains owner-controlled.

Read-only beta assessment already exists in the activation packet and logs: project `emfpckykpzfturllshly` (`portava-beta`) healthy PG17.11; partial schema, missing objective facts at inspection, failed prior bootstrap/config jobs, missing3742 gate, `disable_signup=false`, expected Replit URL404 and6/7 smoke checks failed. The bootstrap failure's shell issue is already fixed in current code; config failed on157 missing flags. Prepare incremental reconciliation rather than assuming a reset. No hosted writes were made.

Remaining external constraints include licensed flight/live feeds, reviewed real airport/place/stage samples, Google runtime credentials and permitted retention/offline use, native-device/Apple entitlement evidence, qualified language review and owner production activation. Full indoor geometry and future DRIVE coverage are not fabricated. Continue from the existing evidence and precise failures above.

## Resume status (Claude, October 20)

Items 1–3 above are repaired on the staged tree: the current-position type error and client test, plan-bound between-stop geometry through a compiled `routeInputHash`, and registered 3895/3908 rollback proofs. The `routeInputHash` proposal was adopted with no migration; a plan compiled before it is asked for review. An independent read-only cross-review found no critical or high defects; its fixes and the two items it leaves for the owner (a Routes reserve for current-position checks, and a map for executing plans) are recorded in [the ledger](layover-165-final-verification.md). The tracker now reads 142 BUILT, 5 IN PROGRESS, 18 BLOCKED-EXTERNAL, 0 VERIFIED PASS. Production deployment, migrations and flags remain the owner's press.
