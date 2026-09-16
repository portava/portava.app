# Hand-off: finish the Map architecture

**Repo:** `portava/portava.app` · **Branch to cut from:** `claude/portava-continuation-uqta94`
**Work on your own branch** (suggest `agent/build-map`). **Do not open a pull request.**

Scoped so it cannot collide with work in flight. Four lanes are building
Highlights/Memories, Layover, Telegraph and Discovery; a fifth hand-off covers
Media. Map is the cleanest remaining architecture.

## Why this is safe to hand over

Measured, not assumed — `grep` in **both** directions returned nothing:

- No file in the four active lanes imports `lib/mapObjects.ts` or
  `lib/mapProducers/`.
- No file under `lib/mapProducers/` imports `services/highlights`,
  `services/memory`, `services/telegraph`, `services/layover`, `discoverySearch`
  or `routes/messaging`.

Map and Sensing were the only two architectures with zero coupling in both
directions.

## The work

`docs/architecture/census-map.md` is the backlog: **293 requirements — 237
correct, 46 withheld, 5 not built.** 51 rows unfinished, and the census is one of
the better-anchored ones, so its evidence cells are usually trustworthy.

Build in this order:

1. **The 5 N ("not built") rows** — pure implementation.
2. **W ("withheld") rows whose blocker is a missing piece you can build.** Most W
   rows state exactly what is missing.
3. Skip anything blocked on an owner product decision or access you do not have.
   Record it and move on.

**M282 (Phase 7 — World Intelligence) is the row to read first.** It is `W` and
its evidence is unusually complete: four object kinds on both mirrors
(`lib/mapObjects.ts:105#"world_pulse",` … `:108#"personal_city",`), four producers
(`worldPulseProducer.ts`, `travelerFlowProducer.ts`, `cityModelProducer.ts`,
`personalCityProducer.ts`), two client layers
(`src/features/map/layers/layerModel.ts:104#'relevant_places',` … `:106#'my_cities',`),
all behind the flag `map_world_intelligence_enabled`, **seeded OFF**. Work out what
is actually missing before building — a feature that is fully built but flag-gated
off needs the flag flipped and proven, not rebuilt. If that is the case, say so
and move to the next row; do not manufacture work.

## What counts as built

A real user completes the flow: opens the map, sees real objects derived from real
storage, and can act on one. **None of these count:** a placeholder, a layer wired
to nothing, a producer whose output no layer renders, a screen rendering fixtures,
or a route with no caller.

Track **implemented** separately from **verified correct**. Do not claim
unverified work is correct.

## You own

- `artifacts/api-server/src/lib/mapObjects.ts`
- `artifacts/api-server/src/lib/mapProducers/**`
- the map screens, layers and components in `travel-buddy-standalone/`
  (`src/features/map/**`, `app/map/**`)

## You must NOT touch

`package.json` · `src/index.ts` · `src/lib/supabase.ts` · `.github/workflows/**` ·
`docs/architecture/census-*.md` · `CENSUS_STALENESS_ACKNOWLEDGED.json` ·
`routes/discoverySearch.ts` (another lane is actively editing it) · anything under
`src/migrations/` **except** a new file in your reserved band.

**Reserved migration band: `3011`–`3020`.** Write migrations there; **do not apply
one** — the coordinating session owns every database mutation. Follow the shape of
`2973_security_definer_execute_boundary.sql`: a header saying what and why,
idempotent statements, and postconditions that fail loudly. A postcondition block
is re-run standalone by `certify:migrations`, so it must be absolute and
re-runnable — no temp tables, no before/after comparison.

## Rules that are not negotiable

- Never weaken a privacy, authorization or data-integrity check. The map carries
  **approximate** location deliberately: hidden gems expose
  `approx_latitude`/`approx_longitude` and the exact pair is absent on purpose.
  Do not "fix" that by serving precise coordinates.
- Never lower a floor or ceiling, skip or disable a test, or widen an allowlist to
  get green.
- Stage files by explicit name. Never `git add -A`.

## Verification expected

- `pnpm run typecheck` and `pnpm run typecheck:tests` at exit 0.
- Focused tests for the behaviour you changed, red first where practical.
- Full `pnpm run test` in `artifacts/api-server` before your final push.
- Five checks exit **2** without Supabase credentials
  (`write-path-columns`, `missing-live-columns`, `authorization-contract`,
  `media-objects`, `rank-events-surfaces`). Exit 2 is an **environment error** —
  not a pass and not a failure. Report them as unverified; never as green.

## Local traps that have already cost this project real time

1. **Do not run both workspace suites at once**, or the suite alongside
   `check:all`. It manufactures failures that pass in isolation — confirmed three
   times, each blaming a different file. One reported `status: null` at exactly
   180,135 ms, which is a subprocess killed by a timeout but reads exactly like an
   assertion failure.
2. **`travel-buddy-standalone` is NOT in `pnpm-workspace.yaml`** and has its own
   lockfile. A root `pnpm install` reports success and leaves it with no
   `node_modules`; its suite then fails 274/274 with `ERR_MODULE_NOT_FOUND: tsx`
   and looks exactly like a broken branch. Run `pnpm install` *inside* it. **You
   will need this** — most of your work is client-side.
3. **Never pipe a test run through `tail`/`head`** — it discards the failing
   subtest's detail and reports the pager's exit code instead of the run's.
4. **`artifacts/api-server`'s `test` script is an explicit file list**, not a
   glob, enforced by `scripts/check-test-registration.mjs`. Register new test
   files in `package.json` — which you do not own, so add only your own line and
   say so in your report.
5. Run one api-server test file with:
   `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/<file>.ts`

## Commits

End every commit message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PTAUxxvaq1EohcEvb18W7d
```

## Report back

1. Capabilities a user can now complete end to end — the flow and the evidence.
2. What you attempted and could not finish, with the exact blocker.
3. Whether M282 was genuinely unbuilt or merely flag-gated off, with evidence.
4. Any migration you wrote and left unapplied.
5. Your final full-suite result, quoted.
6. Which parts are **implemented but unverified**, stated plainly.
