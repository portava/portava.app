# Test-suite exclusion audit — artifacts/api-server

**Date:** 2026-08-09 · **Scope:** `artifacts/api-server` only · **Status:** report only, nothing re-enabled.

> **UPDATE 2026-08-09 — the `broken` suite is fixed and registered.**
> `reports.test.ts` now mounts `routes/admin.js`, and its four
> `GET /admin/reports` assertions execute for the first time. **All four
> pass** — admin authorisation on that route was never broken; the 404 was
> purely the harness. Verified by mutation (disabling the shared guard fails
> 5a and 5b), so they are not passing vacuously.
>
> It is registered in the `test` script and removed from the allowlist, so it
> did not become a 40th redundant entry. Curated run **6138 → 6165 tests**,
> **1551 → 1557 suites**. Remaining excluded: **90 → 89**; allowlist
> **129 → 128** (still 39 redundant). The guard's summary line is also fixed
> (§1). Every other number below reflects the pre-fix state.

## Summary

| | |
|---|---|
| `*.test.ts` files on disk under `src/` | **392** |
| Registered in the `test` script (execute under `npm test`) | **302** |
| **Never execute under `npm test`** | **90** |
| Tests inside those 90 suites | **1527** |
| …that pass when run individually | **1485** (88 suites) |
| …that fail | **4** (1 suite) |
| …that cannot run without live credentials | **15** (1 suite, 0 pass) |

**The prior finding's "~129 excluded" is wrong. The real number is 90.**

The 129 is the length of `UNREGISTERED_TESTS_ALLOWLIST.json`, which is not the
exclusion set. **39 of its 129 entries are also registered in the `test`
script, so they run.** Allowlisting does not prevent execution — it only
suppresses the registration guard. The two sets partition exactly:

```
allowlist (129) = 90 genuinely excluded + 39 redundant entries that already run
```

Verified as an identity, not an estimate: every one of the 90 excluded files is
in the allowlist (0 outside it), and 129 − 39 = 90 exactly.

The single most important number is not the count. It is that **one excluded
suite has been failing the whole time** — `reports.test.ts`, 4 failures. The
other 89 are lost coverage; that one is a hidden failure.

---

## 1. What mechanism excludes suites

**There is no glob, no skip flag, and no runner config.** The `test` script in
`artifacts/api-server/package.json` is a hand-curated, space-separated list of
file paths passed straight to `node --test`. A file runs if and only if its
path is typed into that string. Its own tech-debt note says why:

> The `test` script in this package.json is a manually curated,
> space-separated list of test file paths (see TEST_RUNNER_TECH_DEBT.md for
> why: no glob-based runner is wired up). That means a brand-new
> `*.test.ts` file can be added to the repo, pass code review, and then
> silently NEVER run in CI or the api-test workflow — nobody remembered to
> add its path to the curated list.
>
> — `scripts/check-test-registration.mjs`

`TEST_RUNNER_TECH_DEBT.md` records the root cause: the Replit package firewall
403-blocks the vitest tarball, so the package runs `node --import tsx/esm
--test` against explicit paths plus a hand-rolled vitest shim in
`node_modules/`.

A second mechanism, `scripts/UNREGISTERED_TESTS_ALLOWLIST.json`, does **not**
exclude anything. It is consumed only by the registration guard:

```js
const unregisteredAndNotAllowed = found.filter(
  (f) => !registered.has(f) && !allowlistSet.has(f),
);
```

Being allowlisted suppresses the guard's complaint; it has no effect on what
runs. This is the distinction the "129" conflated.

### The guard's summary line is misleading

```js
console.log(
  `✅ check-test-registration: all ${found.length} test files are either registered ` +
    `(${registered.size} in package.json) or explicitly allowlisted (${allowlist.length}).`,
);
```

It prints `392 / 302 / 129`. Those do not reconcile — 302 + 129 = 431 — because
the buckets overlap by 39 and the wording ("either … or") implies they don't.
Anyone reading it for an exclusion count gets 129 and is off by 39.

---

## 2. Suites that exist vs suites that execute

```bash
# on disk (392)
cd artifacts/api-server && find src -name '*.test.ts' -type f | wc -l

# registered in the test script (302 unique, 0 duplicates, 0 ghosts)
node -e 'const s=require("./package.json").scripts.test;
  const m=s.match(/src\/[^\s"'"'"']+\.test\.ts/g)||[];
  console.log(m.length, new Set(m).size)'

# excluded (90) — on disk but not named in the script
node -e 'const {execSync}=require("child_process");
  const r=new Set(require("./package.json").scripts.test.match(/src\/[^\s"'"'"']+\.test\.ts/g));
  const f=execSync("find src -name \"*.test.ts\" -type f").toString().trim().split("\n");
  console.log(f.filter(x=>!r.has(x)).length)'
```

**392 exist · 302 execute · 90 never execute.**

Supporting checks, so "registered" can be equated with "executes":

- **0 duplicate** path tokens (302 matches, 302 unique).
- **0 ghost** paths — every registered path exists on disk, so none is a typo
  that `node --test` would skip.
- The full run reports `fail 0`, `cancelled 0`, `skipped 0`. A file that failed
  to load would surface as a failure, so all 302 loaded and ran.
- Every token in the script is a `src/**.test.ts` path — no directory, glob, or
  non-`src` entry that the regex could miss.
- **0** test files exist outside `src/`, and **0** files under `src/` import
  `node:test` without being named `*.test.ts` — so nothing is hiding from the
  `find` used above.

---

## 3. Categorising all 90

| Category | Count | Tests |
|---|---|---|
| accidental | **88** | 1485 (all pass) |
| broken | **1** | 27 (23 pass, **4 fail**) |
| deliberate | **1** | 15 (0 pass — needs live Supabase) |
| obsolete | **0** | — |

**No suite is obsolete.** Obsolete code would fail to import; all 88 accidental
suites pass in full, so every one still tests code that exists.

**"Deliberate" is the weakest category here, and it is an inference, not a
record.** `UNREGISTERED_TESTS_ALLOWLIST.json` is a bare JSON array of 129
strings with **no per-entry reasons, no dates, and no comments**. Nothing in
the repo states why any individual file was excluded. `rlsHardening.test.ts` is
classified deliberate only because its dedicated script is the sole one passing
`--env-file-if-exists=.env` and it fails on a real network call — evidence of
intent, not a stated reason.

A hypothesis worth killing: having a dedicated `test:*` script is **not** a
signal of deliberate exclusion. **52 of the 302 registered** suites also have
one, so the pattern is a convenience shortcut, not a separation decision. 18 of
the 90 excluded suites have one; that fact alone means nothing.

### broken — 1 suite

| Suite | Tests | Failing | Why |
|---|---|---|---|
| `src/test/reports.test.ts` | 27 | **4** | Asserts on `GET /admin/reports`, but its harness mounts only `reports.js` (`app.use("/", reportsRouter)`). That route now lives in `routes/admin.ts`, so all four requests 404. Assertions expect 403/403/200/401; each gets `404 !== 403` etc. |

The route was once defined in `reports.ts` (`git log -S '"/admin/reports"'`
finds it) and moved to `admin.ts`; the test's mount was never updated. The
assertions describe real, currently-implemented behaviour — this is a harness
gap, not a stale expectation, so the fix is to mount the admin router, not to
delete the tests.

**Confirmed pre-existing.** Re-run at `5b7c7fa87` (before the admin-guard
sweep): identical 27 tests / 23 pass / 4 fail, same `404 !== 403`. Not caused
by the guard consolidation.

Note what this suite covers: *"non-admin user gets 403"*, *"user with no
profile record gets 403"*, *"unauthenticated returns 401"*. Four admin
**authorisation** assertions that have never run in the curated suite.

### deliberate — 1 suite

| Suite | Tests | Why |
|---|---|---|
| `src/test/rlsHardening.test.ts` | 15 | Integration test against a real Supabase. Fails at setup with `TypeError: fetch failed` in `GoTrueAdminApi.createUser` — it calls the live auth admin API. Its script is the only one using `--env-file-if-exists=.env`. Exit 1 with `fail 0`: the setup hook throws, so no test body runs. |

Not a defect. It should stay out of the offline curated run — but the reason
should be written down, which it currently is not.

### accidental — 88 suites

All 88 **pass when run individually.** This is lost coverage, not hidden
failures. The July 2026 triage already predicted exactly this and left it as a
backlog rather than a decision:

> The remaining ~50 out-of-list files pass but were intentionally **not**
> mass-added (out of scope for this triage — only files touched here join the
> list). They remain candidates for a follow-up registration pass.
>
> — `docs/test-triage-2026-07.md`

That follow-up pass never happened, and the set has since grown from ~50 to 88.

| Suite | Tests | Category | Runs clean individually? |
|---|---|---|---|
| `src/services/ranking/__tests__/feedSlotAllocator.test.ts` | 13 | accidental | passes |
| `src/services/ranking/__tests__/placeAffinities.test.ts` | 11 | accidental | passes |
| `src/test/accountStatus.test.ts` | 7 | accidental | passes |
| `src/test/adminFeaturedApprove.test.ts` | 3 | accidental | passes |
| `src/test/adminInviteSlotReconcile.test.ts` | 8 | accidental | passes |
| `src/test/adminPlaceImagesCacheInvalidation.test.ts` | 12 | accidental | passes |
| `src/test/adminPlaceImagesL1Eviction.test.ts` | 5 | accidental | passes |
| `src/test/adminProfileActions.test.ts` | 19 | accidental | passes |
| `src/test/adminRankingConfig.test.ts` | 52 | accidental | passes |
| `src/test/adminSchemaDrift.test.ts` | 5 | accidental | passes |
| `src/test/adminVisualsVerify.test.ts` | 2 | accidental | passes |
| `src/test/blocksLib.test.ts` | 4 | accidental | passes |
| `src/test/bucketClassifier.test.ts` | 41 | accidental | passes |
| `src/test/bucketUpsert.test.ts` | 11 | accidental | passes |
| `src/test/checkFrozenDir.test.ts` | 4 | accidental | passes |
| `src/test/circle.test.ts` | 67 | accidental | passes |
| `src/test/communityPlacePhotos.test.ts` | 5 | accidental | passes |
| `src/test/compass-hardening.test.ts` | 25 | accidental | passes |
| `src/test/compassSafetyFilter.test.ts` | 12 | accidental | passes |
| `src/test/compass-settings-feedback.test.ts` | 19 | accidental | passes |
| `src/test/compassSurfaces.test.ts` | 81 | accidental | passes |
| `src/test/compassTelegraph.test.ts` | 8 | accidental | passes |
| `src/test/crossSystemPrivacy.test.ts` | 18 | accidental | passes |
| `src/test/deleteMemberSideEffects.test.ts` | 6 | accidental | passes |
| `src/test/discoveryCommunityPopularSort.test.ts` | 33 | accidental | passes |
| `src/test/discoveryCommunityRatingBounds.test.ts` | 9 | accidental | passes |
| `src/test/discoveryCommunityRequiredFields.test.ts` | 17 | accidental | passes |
| `src/test/discoveryCommunityStatusFilter.test.ts` | 11 | accidental | passes |
| `src/test/discoveryFeed.test.ts` | 11 | accidental | passes |
| `src/test/discoveryPopularVsRating.test.ts` | 8 | accidental | passes |
| `src/test/discoverySuggest.test.ts` | 8 | accidental | passes |
| `src/test/eventPrivacy.test.ts` | 24 | accidental | passes |
| `src/test/featureFlagAudit.test.ts` | 12 | accidental | passes |
| `src/test/featureFlagList.test.ts` | 7 | accidental | passes |
| `src/test/globeTrotterCriteria.test.ts` | 11 | accidental | passes |
| `src/test/globeTrotterLegacyRetirement.test.ts` | 6 | accidental | passes |
| `src/test/inviteLinkAcceptIdempotent.test.ts` | 16 | accidental | passes |
| `src/test/inviteLinkCrashRecovery.test.ts` | 8 | accidental | passes |
| `src/test/inviteLinkMaxMembersRace.test.ts` | 6 | accidental | passes |
| `src/test/inviteLinkRemovedFlag.test.ts` | 4 | accidental | passes |
| `src/test/inviteSlotStrandedRace.test.ts` | 9 | accidental | passes |
| `src/test/inviteSlotSweeper.test.ts` | 7 | accidental | passes |
| `src/test/livePulse.test.ts` | 44 | accidental | passes |
| `src/test/mapCommands.test.ts` | 12 | accidental | passes |
| `src/test/mapSearchLib.test.ts` | 9 | accidental | passes |
| `src/test/mapSearchRoutes.test.ts` | 9 | accidental | passes |
| `src/test/mapTravelers.test.ts` | 14 | accidental | passes |
| `src/test/mediaAccess.test.ts` | 26 | accidental | passes |
| `src/test/mediaDedupPhash.test.ts` | 27 | accidental | passes |
| `src/test/mediaGridNearby.test.ts` | 5 | accidental | passes |
| `src/test/mediaLib.test.ts` | 15 | accidental | passes |
| `src/test/mediaNoveltyRanking.test.ts` | 20 | accidental | passes |
| `src/test/mediaUploadHardening.test.ts` | 8 | accidental | passes |
| `src/test/messagingOffApp.test.ts` | 8 | accidental | passes |
| `src/test/messaging.test.ts` | 14 | accidental | passes |
| `src/test/moderationReportImageUrl.test.ts` | 4 | accidental | passes |
| `src/test/ogMetaTags.test.ts` | 41 | accidental | passes |
| `src/test/placeCategories.test.ts` | 33 | accidental | passes |
| `src/test/placeDays.test.ts` | 39 | accidental | passes |
| `src/test/placeLiving.test.ts` | 13 | accidental | passes |
| `src/test/placeResolve.test.ts` | 102 | accidental | passes |
| `src/test/placeReviews.test.ts` | 10 | accidental | passes |
| `src/test/portavaFeed.test.ts` | 4 | accidental | passes |
| `src/test/portavaRank.test.ts` | 18 | accidental | passes |
| `src/test/postHide.test.ts` | 4 | accidental | passes |
| `src/test/postSaves.test.ts` | 17 | accidental | passes |
| `src/test/postSave.test.ts` | 9 | accidental | passes |
| `src/test/privacyFeedFilter.test.ts` | 9 | accidental | passes |
| `src/test/privateFollowVisibility.test.ts` | 5 | accidental | passes |
| `src/test/profileBuildPass.test.ts` | 17 | accidental | passes |
| `src/test/profileMediaCleanup.test.ts` | 10 | accidental | passes |
| `src/test/profilePersona.test.ts` | 9 | accidental | passes |
| `src/test/profilePhase3Targeted.test.ts` | 10 | accidental | passes |
| `src/test/profilePrivacy.test.ts` | 20 | accidental | passes |
| `src/test/profileRoundTrip.test.ts` | 44 | accidental | passes |
| `src/test/pulseFeaturedField.test.ts` | 2 | accidental | passes |
| `src/test/rentaBuddyScanner.test.ts` | 25 | accidental | passes |
| `src/test/reportsHistory.test.ts` | 5 | accidental | passes |
| `src/test/rlsPrivacyBaseline.test.ts` | 10 | accidental | passes |
| `src/test/rlsPrivacy.test.ts` | 15 | accidental | passes |
| `src/test/stampAutoApproveGeneration.test.ts` | 7 | accidental | passes |
| `src/test/stampAwardEngine.test.ts` | 14 | accidental | passes |
| `src/test/stamps-revoke-restore.test.ts` | 41 | accidental | passes |
| `src/test/stamps.test.ts` | 37 | accidental | passes |
| `src/test/stampTriggerAudit.test.ts` | 17 | accidental | passes |
| `src/test/tripCrewMap.test.ts` | 12 | accidental | passes |
| `src/test/tripNotFound.test.ts` | 4 | accidental | passes |
| `src/test/tripPrivacy.test.ts` | 22 | accidental | passes |

---

## 4. Do the accidental exclusions pass when run directly?

**Yes — all 88, with zero failures between them.** This is the answer that
matters more than the count: the accidental bucket is *lost coverage*, not
*hidden failures*. Only `reports.test.ts` (categorised broken, not accidental)
hides real failures.

Method — every one of the 90 was run in its own process:

```bash
while IFS= read -r f; do
  timeout 120 env SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
    node --import tsx/esm --test "$f"
done < excluded.txt
```

Result: **88 exit 0 · 2 exit 1** (`reports.test.ts`, `rlsHardening.test.ts`).
No suite timed out, and no suite reported 0 tests, so none is silently inert.

Two suites are thin enough to be worth a look on their own merits, though both
pass: `adminVisualsVerify.test.ts` (2 tests) and `pulseFeaturedField.test.ts`
(2 tests).

> **Caveat on the 1485.** Each suite passed *in isolation*. The curated run
> executes many suites together, where shared in-process state can interact —
> the July triage found exactly this (`adminPhase12` hit an in-process rate
> limiter only when run after other signup suites). Passing individually does
> not guarantee passing when registered. Re-enable in small batches and
> re-check, rather than adding all 88 at once.

---

## 5. Can a new test file be silently excluded?

**A new `*.test.ts` under `src/`: no** — provided the guard runs. Anything
else: **yes, silently.**

### The rule, exactly

A suite **executes** if and only if its exact path appears as a token in the
`test` script in `package.json`. Nothing else has any effect — not its name,
not its directory, not its extension. There is no glob.

A suite is **protected from silent omission** only if it matches
`find src -name '*.test.ts'`, which is the guard's discovery command. That is a
stricter rule than the runner's, and the gap between the two is where files
disappear.

### Where the guard is wired

`check:test-registration` is **not** in `run-all-checks.sh` and there is no
`.github/` directory in this repo. It is wired through `.replit` — the
`Project` run-button workflow invokes it in parallel with `api-test`:

```toml
[[workflows.workflow.tasks]]
task = "workflow.run"
args = "check-test-registration"
```

So the guard is real, but it is a run-button workflow rather than a
branch-protection gate: it catches omissions for anyone who runs `Project`, and
does not block a push on its own.

### Verified behaviour

Simulated against the guard's own logic (no files added to the repo):

| New file | Outcome |
|---|---|
| `src/test/newThing.test.ts` | **guard fails — caught** |
| `src/routes/__tests__/deep.test.ts` | **guard fails — caught** |
| `src/test/newThing.spec.ts` | invisible to guard → **silently never runs** |
| `src/test/newThing.test.tsx` | invisible to guard → **silently never runs** |
| `test/outsideSrc.test.ts` (outside `src/`) | invisible to guard → **silently never runs** |

Today no file exploits those gaps: 0 `.spec.ts`, 0 `.test.tsx`, 0 test files
outside `src/`, and 0 files importing `node:test` under a non-`*.test.ts` name.
The exposure is latent, not active.

### The gap that is active

Adding a new file to `UNREGISTERED_TESTS_ALLOWLIST.json` silences the guard
permanently and no second check ever revisits it. The guard validates only that
allowlist entries still exist on disk — never that they are still justified,
and never that the allowlist is shrinking. The allowlist file was last written
on 2026-08-02 and carries no dates or reasons, so there is nothing to expire.
That is how 88 passing suites accumulated behind a green check.

---

## 6. Recommendations (not applied — report only)

Ordered by value, not by effort:

1. **Fix `reports.test.ts` first, before any re-enabling.** It is the only
   hidden failure. Mount the admin router in its harness so the four
   `GET /admin/reports` authorisation assertions actually exercise the route
   they describe. Doing this first keeps a real failure from being buried in a
   mass re-enable — the outcome this audit was asked to avoid.
2. **Register the 88 in small batches**, re-running the full suite between
   batches. Expect some to fail in company that passed alone (see the caveat in
   §4). Registering all 88 would move the curated run from 6138 to roughly 7623
   tests.
3. **Record the reason for `rlsHardening.test.ts`** — convert the allowlist to
   objects with `path` + `reason`, or move genuinely-integration suites to a
   separate `test:integration` script so their absence is a structure, not an
   omission.
4. **Fix the guard's summary line** to report the three real numbers —
   registered, allowlist-only (the true exclusion count), and redundant — so it
   stops printing buckets that overlap while claiming they don't.
5. **Drop the 39 redundant allowlist entries.** They are registered and run;
   their only effect is to inflate the exclusion count by 43%.
6. **Widen the guard's discovery glob** beyond `*.test.ts`, or add a check that
   fails on any file importing `node:test` that is not registered. This closes
   the `.spec.ts` / `.test.tsx` / outside-`src` gaps before someone lands one.

## 7. Verification note

- Every number was computed from disk and from `package.json`, not from the
  prior finding. The prior finding's 129 was checked first and found wrong.
- All 90 suites were executed individually; results are from those runs, not
  inferred from filenames.
- `reports.test.ts`'s failure was reproduced at `5b7c7fa87` to confirm it
  predates the admin-guard sweep.
- Guard behaviour for new files was established by replicating its comparison
  logic, **not** by executing it against new files — no files were added to
  `src/test/`.
- **Not verified:** that the 88 still pass when registered together. Only
  isolated runs were performed. §4 states why that distinction matters.
- Nothing was re-enabled, and no test, allowlist, or `package.json` entry was
  modified by this audit.
