# Trips — implemented, tested, merged, deployed, certified

**Measured 2026-09-11** at branch `claude/portava-continuation-uqta94`, base
`main` = `014a25d5`. Every figure below was produced by running something; where
a claim could not be established by running something, it says so.

**Trips is NOT finished, and this document exists to keep the five states from
being collapsed into one number.** The standing rule this repository works under:

> BUILT ON BRANCH IS NOT MERGED. MERGED IS NOT DEPLOYED. DEPLOYED IS NOT FLAG
> ENABLED. FLAG ENABLED IS NOT PRODUCTION REALIZED.

---

## The five states, separately

| state | Trips | evidence |
| --- | --- | --- |
| **IMPLEMENTED** | 216 of 451 requirements are BUILT (**87 C + 129 W**) — **47.9 % constructed** | §36 recount, 451/451 rows parsed, no verdict edited |
| **TESTED** | **17,707 / 17,707** api-server tests pass, 0 fail, 0 skipped, 0 cancelled. Trips-specific: the kernel live suite **12/12** against portava-ci | full `npm test`; `tripKernelLive.test.ts` in `live-db.yml` |
| **MERGED** | `014a25d5` on `main` (PR #481). **PR #482 is open and DRAFT** — none of this session's work is merged | `git merge-base --is-ancestor 014a25d5 origin/main` |
| **DEPLOYED** | **portava-ci only.** Production has received **nothing** from Batch C | `apply-migrations`: 109 proven applied on `hwokxgbmezheskbzskfr` |
| **CERTIFIED** | **NO.** `certify:migrations` fails at stage 1 on `main` | run `34430889373`, `check:migration-ledger` |

### Why CERTIFIED is red, and why it is not this work's doing

`check:migration-ledger` fails on three ledger rows naming migration files absent
from `src/migrations/` — `2311`, `2320`, `2325`, all `applied_by=manual`, from
PRs #456/#457/#470/#472, all still open with **#470 marked DO NOT MERGE**. This
is `CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES`, opened before the merge.
Measured: `git diff --name-status 0edcb3eb 014a25d5 -- src/migrations/` is EMPTY.

**Deleting those three rows would turn `main` green in one commit. That is why
nobody has.** It would erase the only evidence that portava-ci ran schema no
merged branch can show.

### A limit on every "green PR" claim in this repository

`db:apply-migrations` and `certify:migrations` are gated on
`github.ref == 'refs/heads/main'` (`live-db.yml:746`, `:757`). A pull request
runs the **dry run** and skips both. So a PR reporting 27 of 27 green has **not**
run the certification gate — that first executes on the push build *after* a
merge. Merging is part of the test here.

---

## What "IMPLEMENTED" does and does not mean

The 47.9 % is a **document measuring itself**. `check:census-integrity` states
its own limit: it verifies a census agrees with itself, not that it agrees with
the code. Until 2026-09-11 nothing had ever read census-trips against the
implementation.

Two passes have now started closing that:

| pass | what it established | what it explicitly did not |
| --- | --- | --- |
| **§37** | 338 citations resolved; **37 had rotted**, all of them still *in range*, so `check:doc-citations` had been green on them the whole time | did not re-derive a single verdict |
| **§38** | **44 of 89 C rows re-derived. 42 held; TR51 and TR200 did not** | 45 C rows, and **all 129 W and 234 N rows**, stand on earlier passes |

**Two verdicts moved, both DOWN, both for the same reason** — a universal claim nobody had counted. **TR51**: *every* trip write parses a zod schema first — 8 of 53 do not. **TR200**: trip events pass an attention policy — 10 trip push sites never reach the router that applies one. CONSTRUCTED is unchanged at 47.9 % (both are still built, now graded wrong); CORRECT falls 19.7 % → **19.3 %**. Nothing in either pass raises a number.

**The method finding is worth more than either row.** 35 of the 89 C rows make a universal claim — *every*, *only*, *never*, *nothing*, *cannot*, *always*. Both failures came from that set. "X is handled" is hard to disprove; "EVERY X is handled" is a count, and none had been counted.

### What §38 found

| finding | class | status |
| --- | --- | --- |
| The crew privacy guard never checked the expiry of the live-share grant it was guarding | **defect**, latent — the sole caller filters expired rows in SQL | **fixed**; 5 of 7 new tests failed first |
| TR32/TR94 claimed a "standing ratchet" enforcing the single place id-space crossing. **No such ratchet existed** | **false enforcement claim**; crossing was single by convention | **ratchet built** (`check:place-id-bridge`), claim now true as written |
| **TR51** claimed *every* trip write parses a zod schema first. **8 of 53 do not** | **verdict wrong** | **C → W.** `POST /trips` closed with a schema; 7 held shrink-only by `check:trip-write-validation` |
| **TR200** claimed trip events pass an attention policy. **10 trip pushes never reach the router** | **verdict wrong** | **C → W.** Held shrink-only by `check:trip-push-policy`. Bypass is deliberate — one site documents it |
| TR381 claimed *nothing* reads `trip_activity_log` but one endpoint. There are two | evidence wrong, verdict survives | corrected in place |
| TR107 names two of `canEditPlanItem`'s four call sites | evidence incomplete | recorded |
| TR37 cites a basename carried by two files, neither canonical | ambiguous citation | asserted against both; they agree |
| `safe_return_live_shares.expires_at` is nullable and its guard skips the check when NULL | latent, **another lane's file** | recorded, not crossed into |

The first two are the ones that matter: in both, the census stated an enforcement
that did not exist, and in both the underlying requirement was nonetheless true.
**A row that is true by convention while claiming to be true by enforcement is the
more dangerous of the two**, because the sentence invites the reader to stop
checking.

---

## The guard coverage problem, now measured everywhere

§37 found census-trips cited 49 files with 10 in `CENSUS_SCOPE` — so the staleness
guard watched the W rows and left the C rows unguarded. That was recorded as a
Trips finding. It is not one:

| census | watched/cited | | census | watched/cited |
| --- | ---: | --- | --- | ---: |
| sensing | 15/92 — **16 %** | | map | 75/108 — 69 % |
| telegraph | 27/131 — 21 % | | media | 89/126 — 71 % |
| discovery | 11/49 — 22 % | | wall | 47/74 — 64 % |
| input-intelligence | 28/99 — 28 % | | compass | 34/60 — 57 % |
| highlights-memories | 19/65 — 29 % | | layover | 26/77 — 34 % |
| trust | 22/72 — 31 % | | trips | 38/117 — 32 % |

**Not one census watches even three quarters of what it cites; the median is under
a third.** `check:census-scope-coverage` now measures this on every run with
per-census floors that ratchet.

---

## Remaining blockers

| blocker | owner | blocks |
| --- | --- | --- |
| `CI_DB_HAND_APPLIED_FROM_UNMERGED_BRANCHES` | owners of #456/#457/#470/#472 | CERTIFIED. Not fixable from this repository |
| Batch C production deploy | **OWNER — manual by design** | DEPLOYED. `manual-production-migration-runbook.md` line 313 |
| PR #482 is draft | owner | MERGED. Deliberately left draft |
| `TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT` | Trips | a malformed command reports a transient outage. **Pinned in the live suite as current behaviour** — fixing it turns that test red on purpose |
| 45 C rows + 129 W + 234 N not re-derived | Trips | the honest ceiling on any claim that Trips is verified |
| 7 trip write endpoints still read `req.body` with no schema | Trips | TR51 returns to C when `check:trip-write-validation`'s list reaches zero |
| `z.url()` accepts `javascript:` on `coverUrl` | Trips | needs fixing on `PatchTripSchema` and `CreateTripSchema` together; pinned as current behaviour |
| **10 trip pushes skip per-user preferences, categories and quiet hours** | notifications owner | a user inside quiet hours still receives them. Re-plumbing risks the double-delivery the code names |
| 7 censuses declared no `head_commit` at session start; **passport still does not** | each lane | its own header argues declaring would report FRESH about 165 rows nobody re-read |

---

## The one number, stated with its caveats attached

**Trips: 47.9 % constructed, 19.3 % correct, of 451 requirements.**

- Both are **floors** derived from a document that has only just begun to be read
  against the code.
- **44 of 89** C rows have been independently re-derived, and **two of them failed**
  (TR51, TR200). The other 407 requirements have not been re-derived at all.
- Nothing is production-deployed. Nothing is certified.
- `100 %` is not sayable, and will not be until BUILT, WIRED, REACHABLE, TESTED,
  MERGED, CI-MIGRATED, CI-CERTIFIED, PRODUCTION-MIGRATED, PRODUCTION-CERTIFIED,
  ENABLED, GITHUB CLEAN and DATABASE LEDGERS TRUE are all true. Four of those are
  currently false.

**P24 — what would turn this red:** re-deriving the remaining 45 C rows and
finding one that does not hold; any of the 127 W rows having been silently fixed
or silently worsened; `certify:migrations` staying red; a Batch C deploy that
fails its post-deployment certification.
