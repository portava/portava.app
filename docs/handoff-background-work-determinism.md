# Hand-off: background work has no completion signal, so 65 test files sleep instead of waiting

**Repo:** `portava/portava.app` · **Workspace:** `artifacts/api-server`
**Nothing here needs database credentials, production access, or a secret.** It
reproduces on a clean checkout with `pnpm install`.

---

## The symptom

The api-server test suite fails intermittently, and only under CPU load. Observed
three times today by two independent sessions:

- Run A (suite + checks concurrently): 3 failures, all in
  `src/test/stamps-integration.test.ts`.
- Run B (still with other load): 1 different failure,
  `src/test/trustEmitterWiring.test.ts`.
- Run C (machine quiet): **22,848 / 22,848 pass.**

Every failing test passes in isolation. A fourth case, `guardReachability.test.ts`,
failed with `status: null` at exactly 180,135 ms — a spawned subprocess killed by
a timeout, which looks identical to an assertion failure in the report.

## The cause, which is not "flaky tests"

Route handlers do real work **after** they respond. `routes/trips.ts:1058`:

```ts
// Passport stamp awards — fire-and-forget, fully idempotent
void awardTripCompletionStamps(sc, tripId, user.id, updated, req.log).catch(() => {});
```

There are **22 such fire-and-forget sites** across `src/routes/` and
`src/services/`. None of them exposes any way to know when the work finished.

So the tests guess. `src/test/stamps-integration.test.ts:287`:

```ts
// Fire-and-forget stamp awards settle asynchronously — allow enough time.
const SETTLE_MS = 250;
...
await new Promise((r) => setTimeout(r, SETTLE_MS));   // :314, :398, :443, :459
```

250 wall-clock milliseconds is enough on an idle machine and not enough at load
average 24 on 4 cores. **65 test files** in this workspace contain a
`setTimeout`-based wait of this kind.

This is a production-code design gap surfacing as test flake. The tests are
guessing because the code gives them nothing to wait on.

## What I want built

A deterministic completion signal for background work, and the removal of the
sleeps that exist because there isn't one.

1. **A small tracker** — e.g. `src/lib/backgroundWork.ts` exporting something
   like `track(promise)` and `await settled()`. Every one of the 22
   fire-and-forget sites registers its promise; `settled()` resolves when all
   in-flight work has completed. It must stay a no-op fast path in production
   (this is not a job queue, and it must not change request latency or
   behaviour).
2. **Tests await it** instead of sleeping. Replace the `SETTLE_MS` sleeps in
   `stamps-integration.test.ts` first, then work outward through the other files
   that sleep for this reason.
3. **Errors stop vanishing.** Today `.catch(() => {})` discards the failure of
   work the user's data depends on. The tracker should record it so a test can
   assert it and a log can carry it. Do not change what the HTTP response does —
   the fire-and-forget shape is deliberate.

## Rules (these are not negotiable, and they are why this is still open)

- **Do not raise `SETTLE_MS`.** A bigger number is a slower suite that still
  fails on a slower machine. I left it at 250 on purpose.
- **Do not skip, disable, `.only`, or quarantine any test**, and do not mark
  anything flaky-retry.
- **Do not weaken an assertion** to make a race disappear.
- Keep changes inside `artifacts/api-server`. Do **not** touch
  `.github/workflows/*`, any file under `src/migrations/`, any
  `docs/architecture/census-*.md`, or `CENSUS_STALENESS_ACKNOWLEDGED.json`.
- `artifacts/api-server`'s `test` script is an **explicit file list**, not a
  glob, and `scripts/check-test-registration.mjs` enforces it — register any new
  test file in `package.json`.

## Definition of done

- `pnpm run test` in `artifacts/api-server` passes **while the machine is under
  heavy load** (e.g. run it concurrently with `pnpm run check:all`). That is the
  actual acceptance test; a green run on an idle box proves nothing here.
- `pnpm run typecheck` and `pnpm run typecheck:tests` stay at exit 0.
- `node scripts/check-test-registration.mjs` exits 0.
- The count of `setTimeout`-based waits in `src/test/` goes **down**, and every
  one removed is replaced by awaiting a real signal.

## Useful context

- Run a single file with:
  `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/<file>.ts`
- Never pipe a test run through `tail`/`head`: it discards the failing subtest's
  detail and reports the pager's exit code instead of the run's. Write to a file
  and grep the file.
- `travel-buddy-standalone` is **not** in `pnpm-workspace.yaml` and has its own
  lockfile. A root `pnpm install` reports success and leaves that package with no
  `node_modules`, after which its suite fails 274/274 with
  `ERR_MODULE_NOT_FOUND: tsx` — which looks exactly like a broken branch. You
  shouldn't need that workspace for this task, but if you touch it, install
  inside it.
