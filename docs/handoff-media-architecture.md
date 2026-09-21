# Hand-off: finish the Media architecture

**Repo:** `portava/portava.app` · **Branch to cut from:** `claude/portava-continuation-uqta94`
**Work on your own branch** (suggest `agent/build-media`). **Do not open a pull request.**

This is deliberately scoped so it cannot collide with work in flight. Four other
lanes are building Highlights/Memories, Layover, Telegraph and Discovery right
now. Media was chosen because it is the largest remaining gap that touches none
of them.

## Why this is safe to hand over

Verified, not assumed — `grep` in both directions returned nothing:

- No file under `services/media/` or `routes/media*.ts` imports from
  `services/telegraph`, `services/highlights`, `services/layover`, or
  `discoverySearch`.
- No file in those four lanes imports `services/media` or `routes/media`.

So you can build without coordinating with anyone, as long as you stay inside the
ownership list below.

## The work

`docs/architecture/census-media.md` is the backlog: **450 requirements — 301
correct, 81 withheld, 66 not built.** 147 rows are unfinished, the largest pool
outside the active lanes.

Read the census and build, in this order:

1. **N ("not built") rows a user would notice.** Pure implementation, biggest win.
2. **W ("withheld") rows whose blocker is a missing piece you can build** — most W
   rows state exactly what is missing.
3. Skip anything blocked on an owner product decision or on access you do not
   have. Record it and move on.

One row is already known and is a good first target: **MD43 —
`visibility_override` is read by no serving path.** The column exists in a
migration that is **not applied to production**, so a previous pass filed it as
unimplementable. That reasoning does not apply to you: build the serving path, and
say plainly that it is unverified against production until the migration lands.

## What counts as built

A real user completes the flow: reaches the screen, performs the action, it
persists, and it is still there after a reload. **None of these count:** a
placeholder, a component wired to nothing, a screen rendering fixtures, a service
whose production path is mocked, a route with no caller.

Track **implemented** separately from **verified correct**. Do not claim
unverified work is correct.

## You own

- `artifacts/api-server/src/services/media/**`
- `artifacts/api-server/src/routes/mediaActions.ts`, `mediaAnalyticsBatch.ts`,
  `mediaFeed.ts`, `mediaFile.ts`, `mediaViewRequest.ts`, `mediaWorld.ts`
- the media screens and components in `travel-buddy-standalone/`

## You must NOT touch

`package.json` · `src/index.ts` · `src/lib/supabase.ts` · `.github/workflows/**` ·
`docs/architecture/census-*.md` · `CENSUS_STALENESS_ACKNOWLEDGED.json` · anything
under `src/migrations/` **except** writing a new file in your reserved band.

**Reserved migration band: `3000`–`3010`.** Write migrations there; **do not apply
one** — the coordinating session owns every database mutation. Follow the shape of
`2973_security_definer_execute_boundary.sql`: a header saying what and why,
idempotent statements, and postconditions that fail loudly. A postcondition block
is re-run standalone by `certify:migrations`, so it must be absolute and
re-runnable — no temp tables, no before/after comparison.

## Rules that are not negotiable

- Never weaken a privacy, authorization or data-integrity check. Media carries
  per-object visibility and moderation state; a refusal must stay a refusal.
- Never lower a floor or ceiling, skip or disable a test, or widen an allowlist to
  get green.
- Stage files by explicit name. Never `git add -A`.

## Verification expected

- `pnpm run typecheck` and `pnpm run typecheck:tests` at exit 0.
- Focused tests for the behaviour you changed, red first where practical.
- Full `pnpm run test` in `artifacts/api-server` before your final push.
- **`check:media-objects` exits 2 without Supabase credentials.** Exit 2 means
  *environment error* — it is **not a pass and not a failure**. Report it as
  unverified; never as green. The same is true of `check:write-path-columns`,
  `check:missing-live-columns`, `check:authorization-contract` and
  `check:rank-events-surfaces`.

## Local traps that have already cost this project real time

1. **Do not run both workspace suites at once**, or the suite alongside
   `check:all`. Doing so manufactures failures that pass in isolation — confirmed
   three times, each blaming a different file. One reported `status: null` at
   exactly 180,135 ms, which is a subprocess killed by a timeout but reads exactly
   like an assertion failure.
2. **`travel-buddy-standalone` is NOT in `pnpm-workspace.yaml`** and has its own
   lockfile. A root `pnpm install` reports success and leaves it with no
   `node_modules`; its suite then fails 274/274 with `ERR_MODULE_NOT_FOUND: tsx`
   and looks exactly like a broken branch. Run `pnpm install` *inside* it.
3. **Never pipe a test run through `tail`/`head`** — it discards the failing
   subtest's detail and reports the pager's exit code instead of the run's. Write
   to a file and grep the file.
4. **`artifacts/api-server`'s `test` script is an explicit file list**, not a
   glob, enforced by `scripts/check-test-registration.mjs`. Every new test file
   must be registered in `package.json` — which you do not own, so add only your
   own line and say so in your report.
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
3. Any migration you wrote and left unapplied.
4. Your final full-suite result, quoted.
5. Which parts are **implemented but unverified**, stated plainly.
