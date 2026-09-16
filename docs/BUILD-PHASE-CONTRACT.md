# Build phase — lane contract

**Mode: implementation-first.** The deliverable is working user-facing behaviour,
not bookkeeping. Read this once, then build.

## What counts as built

A requirement is **implemented** when a real user can complete the flow end to
end: interface → backend → persistence → integration. **None of these count:**
a placeholder, a component wired to nothing, a screen that renders fake data, a
service whose production path is mocked, a route with no caller, or a migration
that was written but never applied anywhere.

Track **implemented** separately from **verified correct**. Do not claim
unverified work is correct, and do not spend time promoting census verdicts
during construction — a verification phase follows this one.

## Explicitly paused during the build phase

Do **not** do these unless one directly blocks your implementation or a required
merge check:

- comprehensive re-censuses and percentage reconciliation
- broad mutation testing
- citation and documentation cleanup unrelated to what you changed

If a guard you did not break is already red, record it in the backlog and move on.

## Verification expected while building (keep it light)

- `pnpm run typecheck` and `typecheck:tests` at exit 0.
- Focused tests for the behaviour you changed — red first where practical.
- A smoke check of the affected flow.
- **Never weaken** privacy, authorization, or data-integrity checks, and never
  lower a floor, skip a test, or widen an allowlist to get green.
- Run the full `pnpm run test` before your final push, on your own tree, **alone**
  — see the load trap below.

## File ownership — do not edit outside your lane

| lane | owns |
|---|---|
| **hm** (Highlights & Memories) | `artifacts/api-server/src/services/highlights/**`, `services/memory/**`, `routes/highlights.ts`, `routes/memories.ts`; standalone `src/features/highlights/**`, `src/features/memories/**` and their screens |
| **layover** | `artifacts/api-server/src/services/layover/**`, `LayoverSafetyEngine*`, `routes/airport.ts`; standalone layover screens |
| **telegraph** | `artifacts/api-server/src/services/telegraph/**`, `routes/telegraph*.ts`, `routes/messaging.ts`; standalone messaging screens |
| **discovery** | `artifacts/api-server/src/routes/discovery*.ts`, `lib/discovery*`; standalone discovery screens |
| **lead (coordinator)** | everything shared: `package.json`, `src/index.ts`, `src/lib/supabase.ts`, `.github/workflows/**`, `docs/architecture/census-*.md`, `CENSUS_STALENESS_ACKNOWLEDGED.json`, and applying any migration |

**If another architecture blocks you, fix the necessary dependency in its owning
system and then return to your own feature.** Tell the lead what you touched
outside your lane so the integration is not a surprise. That is expected and
allowed; silently editing another lane's files is not.

## Never let a citation change how you write the code

Documentation follows code, not the other way round.

The census documents cite production files by `file:line#anchor`, so any edit that
inserts a line moves some of those pointers. **That is expected, and repairing it
is the lead's job, not yours.** Write the code the way it should be written, then
tell the lead what moved — a per-file list of shifted regions, or just the net
shift per file. Repointing is mechanical and scripted; one lane's shift table made
174 repoints a few minutes' work.

What you must NOT do is shape production code to keep a pointer still. A real
example, rejected: a lane put two imports on one line, and two `router.use` calls
on one line, so that four citations in a census it did not own would not move. It
worked — and it left a file every future reader has to decode, permanently, to
save a repoint that takes seconds. Keeping new code *below* a file's last cited
line is fine when that is where the code naturally belongs; contorting layout,
cramming statements, or leaving something in a worse place solely to protect a
line number is not.

If you find yourself choosing between a well-written file and a stable citation,
choose the file and send the shift table.

## Migrations

You may WRITE migration SQL in your reserved band. You may **not** apply one —
the lead owns every database mutation. A migration only becomes real when it is
applied and certified, so tell the lead as soon as one is ready.

| lane | reserved band |
|---|---|
| hm | `2975`–`2981` |
| layover | `2982`–`2988` |
| telegraph | `2989`–`2994` |
| discovery | `2995`–`2999` |

Follow the shape of `2972`/`2973`: a header that says what and why, idempotent
statements, and postconditions that fail loudly rather than no-op. A postcondition
block is re-run standalone by `certify:migrations`, so it must be absolute and
re-runnable — no temp tables, no before/after state.

## The one backlog

Append non-blocking bugs you find to `docs/BUILD-BACKLOG.md` and keep building.

**Fix immediately, do not defer:** anything that blocks further implementation,
breaks integration, risks data loss, or exposes data to someone not entitled to
it.

## Local traps that have already cost this project real time

1. **Do not run both workspace suites at once.** Running `api-server` and
   `travel-buddy-standalone` suites (or the suite and `check:all`) concurrently
   manufactures failures that pass in isolation — confirmed three times, each
   time blaming a different file. One reported `status: null` at exactly
   180,135 ms, a subprocess killed by a timeout, which reads exactly like an
   assertion failure. See `docs/handoff-background-work-determinism.md`.
2. **`travel-buddy-standalone` is NOT in `pnpm-workspace.yaml`** and has its own
   lockfile. A root `pnpm install` reports success and leaves it with no
   `node_modules`; its suite then fails 274/274 with `ERR_MODULE_NOT_FOUND: tsx`
   and looks exactly like a broken branch. Install *inside* that directory.
3. **Never pipe a test run through `tail`/`head`.** It discards the failing
   subtest's detail and reports the pager's exit code instead of the run's.
   Write to a file and grep the file.
4. **`artifacts/api-server`'s `test` script is an explicit file list**, not a
   glob, enforced by `scripts/check-test-registration.mjs`. Register every new
   test file in `package.json` — that file is lead-owned, so send the lead the
   exact line to add, or add just your line and say so.
5. **Two suites fail under load with messages you must not believe.**
   - `guardReachability.test.ts` — `duration_ms: 180254`, `actual: null` vs
     `expected: 0`. A subprocess killed at a 180-second timeout, wearing an
     assertion failure's clothes. Alone: 25/25. Confirmed four times, three lanes.
   - `wallPerformance.test.ts` — **its message is actively misleading.** It reads
     *"the first page now waits on ~140 serialized database round trips, over the
     recorded ratchet of 110. Something new is awaited in a loop."* It names a
     cause and points at a loop, so it reads like a structural regression somebody
     just introduced, and a lane that trusts it goes hunting for an `await` that
     does not exist. The counter observes actual await ORDERING, so under load work
     that normally overlaps is serialized and the count inflates by about half.
     Alone it passes 6/6, comfortably inside its ratchets (345 calls against 375;
     7.3 per item against 9).

   **The honest check for both: re-run the file alone and read the NUMBER, not the
   sentence.** A failure message that explains itself is still only a hypothesis,
   and a confident one costs more time than a blank one.

6. Single api-server file:
   `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/<f>.ts`
7. Five checks exit **2** without Supabase credentials (`write-path-columns`,
   `missing-live-columns`, `authorization-contract`, `media-objects`,
   `rank-events-surfaces`). Exit 2 is **unverified**, not a pass and not a
   failure. Never report one as green.

## Commits

Stage by explicit name — never `git add -A`. End every commit with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PTAUxxvaq1EohcEvb18W7d
```

Push your own branch. **Do not open a pull request.**
