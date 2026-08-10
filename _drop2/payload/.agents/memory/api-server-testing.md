---
name: API server test suite
description: How to run api-server tests and read the result correctly; fake-client pitfalls
---

# Running the suite

- api-server tests use **node:test + node:assert** (NOT vitest/jest). New test files must follow that style AND be added to the explicit file list in the api-server package.json `test` script — unlisted files never run.
- **Run it directly and judge by the EXIT CODE.** This is the reliable signal and should be the default:
  ```
  pnpm --filter @workspace/api-server test        # == the api-test workflow, exactly
  ```
  Redirect to a file and run it as a background task.
  **Do not carry a test/suite count forward as an expected result.** The figure this
  entry used to quote as one — 6186 tests / 1562 suites / 0 fail / exit 0 in ~119s,
  measured 2026-08-09 — was measured against a `test` script naming **304** files.
  Commit `968cf38` (2026-08-09) then added **87** suites in a single pass, so the
  current list is **392** files and the run is materially larger and slower.
  Exit 0 is the verdict; the counts exist only to confirm a run was complete, and
  must be re-measured, never remembered. The green-under-full-7-way-parallel
  `Project` load result was also observed at the old 304-file size.
- The `api-test` workflow runs `pnpm --filter @workspace/api-server test` and nothing else, so a direct run and the workflow are the *same command*. The exit code of the direct run is strictly better evidence than any log snapshot.
- **Exit 0 says nothing about database behaviour.** The `test` script pins `SUPABASE_URL=http://127.0.0.1:9` and omits the three live-DB suites entirely — see [api-server-live-db-suites.md](api-server-live-db-suites.md) before reporting a green run as coverage.

## Do NOT re-add `--test-force-exit` (removed 2026-08-07, bb6369c45)

Earlier guidance here said the flag was required or the suite would stall. **That was wrong and the flag was removed.** It terminated runs while child processes were still executing: 54–133 tests (12–30 suites) silently did not run on any given green run, and *which* ones varied randomly. `fail 0` only ever meant "zero failures among the tests that reported."

  with the flag:    6037 / 6009 / 5986 / 6002 / 6016 / 6065 / 5998
  without:          6119 / 6119 / 6119  (byte-identical suite sets)

Without it the process exits cleanly on its own — no test leaks a timer, socket or pool. There was never anything to force. Re-adding it reintroduces a silent false green.

**This is now enforced, not just documented:** `check:test-runner-flags` runs in `run-all-checks.sh` and fails the aggregate if this or any other truncating flag appears in a test script. It also bans `--test-only`, `--test-name-pattern`, `--test-skip-pattern`, `--test-shard`, `--test-rerun-failures` and `--test-isolation=none` — all measured to leave a run **green with a smaller count** (201 tests → 5, 5, 5 and 93 respectively on a fixed file set). If you need one of these locally, pass it on the command line; never commit it into a script.

# Reading workflow logs — the false-verdict trap

`/tmp/logs/<workflow>_<timestamp>_<ms>_<hash>.log` files are **drained snapshots**, not live tails. They only gain content when logs are refreshed.

**A stale or partial snapshot can show a FALSE PASS *or* a FALSE FAILURE.** Both directions, equally. Reading one from a previous run, or a mid-run buffer, tells you nothing about the run you care about.

This is not hypothetical. **Three independent agents each concluded `adminRemainingDashboardsSchemaDrift.test.ts` was "failing, pre-existing" in `api-test`** by following the old procedure here. Investigated 2026-08-09: the suite passes 21/21 alone, and the full command passed 6186/6186 exit 0 both in isolation and under full parallel load, with **zero `✖` and zero `not ok`** in the log. Nothing was failing. (6186 was the total at the then-current 304-file `test` script; it is a record of that investigation, not a count to expect today — see the run-it-directly bullet above.) Three agents wrote off a green gate, twice with no evidence — and an ignored gate is how the real ones get ignored too.

## The procedure

1. **Refresh the workflow logs first.** Then read **the file the refresh names.**
2. **Never `ls -t` the newest file.** One run emits several snapshots: run `VaB9YdTKBcFtTdS15XEbv` produced both a `status: RUNNING` file (932 lines) and a `status: FINISHED` file (1051 lines). `ls -t` mid-run hands you the partial one, or the previous run's.
3. **Check the header before the body.** Every snapshot starts with:
   ```
   workflow: standalone-checks
   status:   FINISHED
   run_id:   VaB9YdTKBcFtTdS15XEbv
   timestamp: 2026-08-09T07:26:49.616Z
   ```
   Require `status: FINISHED` **and** a `run_id` matching the run you started. `status: RUNNING` is a partial buffer — not a result.
4. **Judge by the final `ℹ fail` count** (with `ℹ tests` / `ℹ suites` to confirm the run was complete).
5. **Never judge by scanning for failure text.** Snapshots are truncated in the middle — they literally contain `... workflow log truncated ...`. Failure lines can be dropped, so absence of `✖` proves nothing, and a `✖` you do find may belong to a different run.

If a freshly-refreshed `FINISHED` log disagrees with a direct run's exit code, trust the exit code and report the raw log text — that is a real discrepancy worth escalating, not something to write off as "pre-existing."

# Schema-drift gate: sound, but the snapshot goes stale

The `*SchemaDrift.test.ts` guards check route columns against the committed snapshot `src/test/generated/liveColumns.json`, not against live. Verified 2026-08-09 (snapshot dated 2026-07-21, 19 days stale): **every stale column was live-only** — `profiles.is_official`, `rank_events.event_type`, `trust_events.updated_at`, `stamp_definitions.template_family`, etc. No snapshot column was missing live.

That direction is the safe one: the gate is stricter than reality, so **it cannot pass while production is broken.** The dangerous direction — a column in the snapshot but dropped live — would make the gate blind. Re-check that before trusting a green drift run after any live column drop:
```
pnpm --filter @workspace/scripts run refresh:live-columns
```
See `docs/live-columns-refresh.md`.

# Fake-client pitfalls
- The geocoder's fetch-swap test hook does NOT null its DB-client override — suites must explicitly set the DB override to null (e.g. in beforeEach) or their "no DB" tests silently read the live geocode cache table and return real rows.
- Code that calls `getServiceClient()` gets a REAL Supabase client during tests (workspace env has live secrets) unless the suite stubs it via `_setTestServiceClient` (hook in the supabase lib). Unstubbed suites make live network calls.
- Test fakes that override `from(table)` with strict per-table builders break when production code adds a new query or chain step. A `TypeError: ... is not a function` inside `requireUser` usually means the fake's `profiles` builder is missing part of the account-status chain — not a product bug.

## Cross-test rate-limit bleed
`checkRateLimit` in `lib/rateLimit` keeps module-global buckets; call-start tests that POST /api/calls many times as the same fake user hit the 30/hr cap and later suites fail mysteriously. Call `_resetRateLimit()` in each suite's wiring/beforeEach.

## Supabase error-return refactors vs partial fakes
When replacing the try/catch anti-pattern (supabase-js never throws; check `{ error }` instead), any-typed clients exercised by test fakes need care: partial fake clients (e.g. intelligence.test.ts) implement only some builder methods — calling a missing one (`.upsert`) throws a real TypeError. For `client: any` params, keep a narrow try/catch AND the explicit `if (error)` check; for typed `SupabaseClient` params, drop the try/catch entirely.

## Test registration is manual (2026-07-20)
New `src/test/*.test.ts` files are NOT auto-discovered — they must be appended to the `test` script list in `artifacts/api-server/package.json` or they silently never run (compass-home.test.ts shipped unregistered in Phase 10 and was only caught in Phase 11). Always verify your new file appears in that list.

`check:test-registration` guards this, but a green check does not mean every suite runs — it means every unregistered file is *allowlisted*. Don't quote a remembered count; the check prints the split itself and needs no dependencies:

```
node artifacts/api-server/scripts/check-test-registration.mjs
```

Measured 2026-08-10: **395 on disk, 392 registered, 3 never run** — and those 3 are exactly the live-DB suites of [api-server-live-db-suites.md](api-server-live-db-suites.md). The allowlist is much larger than the gap (122 entries, 119 of them redundant), so its length is not the number of excluded suites.

`docs/testing/suite-exclusion-audit.md` is worth reading for the *mechanism* — why a hand-curated path list can silently drop a suite, and why allowlisted ≠ excluded — but **its headline numbers are superseded, and it carries a dated banner saying so.** It was not wrong: its 392 on disk / 302 registered / **90 excluded** reproduces exactly at commit `a19b00b`. The gap it identified was then closed — `ea59270` registered `reports.test.ts` (90 → 89) and `968cf38` added **87** more in a single pass, leaving only the deliberate live-DB suites. Read it for the analysis, never for a count.
