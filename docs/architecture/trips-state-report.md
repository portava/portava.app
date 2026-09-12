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
| **IMPLEMENTED** | 421 of 451 requirements are BUILT (**268 C + 153 W**) — **93.3 % constructed** — ON THE BRANCH `claude/sweet-fermat-fmx7up`, not on `main` | §36 recount, 451/451 rows parsed; §38 and §39 re-derived 78 of them; §40.1–§40.7 BUILT 57 rows into C and 31 N→W, each with file, line, test and a mutation that went red; §41 executed the kernel on a throwaway database built from production's structure dump (3 rows to C) and seven new kernel families on it, 2779–2785 (25 N→W), every migration seen refused before it was applied; §42 built §16's SignalEstimate + Trip Pulse, §11.4's attention model routed through every trip push, §17.2's priority switch on 2785's register, two §21.1 metrics and three §12.1 tools — 22 rows to C, one N→W, no migration; §43 built §13's compiler, primitives, opportunity events and the 2786 kernel event, 31 rows to C; §44 built §8's urgency and triggers, §9.4/§15.3's impact preview and booking side effects, §11.3/§12's replan, simulate, proposals and value of information, §14.3's meeting point, §17.3's rescue and two §23 scenarios as tests, 36 rows to C, one N→W, no migration; §45 built §24's decision-diff CI and Phase 0 write-path inventory (both in check:all), closed TR51's last seven writes, gave the map its tenth layer, made the closeout's two deferred steps act, ran §23's concurrent-edit scenario on the real kernel, 14 rows to C, one N→W, no migration; §46 gave the activity log §5.3's retention policy (2789), closed risks at closeout, proved the kernel's lifecycle events and the map rebuild on a real database, carried three Appendix B families to the wire, 13 W→C |
| **TESTED** | **17,737 / 17,738** api-server tests pass, **0 fail, 0 skipped, 1 CANCELLED** — see below. Trips-specific: the kernel live suite **12/12** against portava-ci | full `npm test`; `tripKernelLive.test.ts` in `live-db.yml` |
| **MERGED** | `014a25d5` on `main` (PR #481). **PR #482 is open and DRAFT** — none of this session's work is merged | `git merge-base --is-ancestor 014a25d5 origin/main` |
| **DEPLOYED** | **portava-ci only.** Production has received **nothing** from Batch C | `apply-migrations`: 109 proven applied on `hwokxgbmezheskbzskfr` |
| **CERTIFIED** | **NO.** `certify:migrations` fails at stage 1 on `main` | run `34430889373`, `check:migration-ledger` |

### The one cancelled suite, named rather than rounded away

`compass-sense-scheduler.test.ts` (7 tests) ends the full run as
`failureType: 'cancelledByParent'` — *"Promise resolution is still pending but
the event loop has already resolved"*. **0 fail is not 7/7**, and this workflow's
own job names say so: *"skipped or cancelled is not a pass"*. So it is recorded
here rather than absorbed into a round number.

What is established about it:

- It passes **7/7 run alone**.
- **This session's changes cannot have caused it.** The only edit that could
  affect scheduling is one test file added to `package.json`'s `test` list, at
  index **772**; this suite sits at index **112**, so its position and both its
  neighbours are byte-for-byte what they were.
- It is a runner-teardown artifact in a suite that installs timers, not an
  assertion failure. No assertion in it failed.

**CI runs the same suite and it is GREEN.** `api-server · node:test suite`
succeeded on head `0aac3fdef` (runs `34660584007` and `34660581124`, both
green), so the cancellation does not reproduce on the CI runner. That makes
it a local-environment artifact, and the figure above is stated as what a
full local `npm test` reports rather than as the state of this branch.

It is **not** claimed to be fixed, and it is not claimed to be someone else's
problem. It is claimed to be reproducible-as-passing in isolation, green on
CI, and unrelated to this work, with the evidence for each stated above.

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

The 93.3 % is a **document measuring itself**. `check:census-integrity` states
its own limit: it verifies a census agrees with itself, not that it agrees with
the code. Until 2026-09-11 nothing had ever read census-trips against the
implementation.

Two passes have now started closing that:

| pass | what it established | what it explicitly did not |
| --- | --- | --- |
| **§37** | 338 citations resolved; **37 had rotted**, all of them still *in range*, so `check:doc-citations` had been green on them the whole time | did not re-derive a single verdict |
| **§38** | **44 of 89 C rows re-derived. 42 held; TR51 and TR200 did not** | 45 C rows, and **all 129 W and 234 N rows**, stood on earlier passes |
| **§39** | **34 of 234 N rows falsified by code on merged `main`** — all thirty-four by the same squash merge (`42aeac38e`, #476) this census declares as its `head_commit` | 200 N rows, and **all 162 W rows**, stand on earlier passes |

**§39 moves CONSTRUCTED UP 7.5 points and CORRECT up 0.2.** §29.4 re-graded fifteen rows at that merge and stopped; the §3.1 domain types, the §7.1 contracts, the §4 command and event rows and the §19 projection envelope were never revisited. Thirty-three of the thirty-four are built and not shown to work — `trip_kernel_enabled` is seeded FALSE — so they land in WRONG. **One, TR417 (§22.4 idempotency), is proven live by `tripKernelLive.test.ts:325-342` and moves into CORRECT — the first row any pass has moved into that bucket**, on the document's own TR49/TR57 precedent, and proven in portava-ci rather than production. §38's two verdicts moved DOWN and these thirty-four move UP: **until §39 every pass this document had run could only travel downward, because only C rows had ever been re-read.** The structural finding is §39.3 — §29.4's labelled ids ran one ahead of the objects from TR89 on, so TR91 `trip_outcomes` was never moved and kept "Does not exist." while its `CREATE TABLE` sat on `main`. `check:census-row-move-labels` now fails on that shape.

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
| 45 C rows + 162 W + 200 N not re-derived | Trips | the honest ceiling on any claim that Trips is verified |
| 7 trip write endpoints still read `req.body` with no schema | Trips | TR51 returns to C when `check:trip-write-validation`'s list reaches zero |
| `z.url()` accepts `javascript:` on `coverUrl` | Trips | needs fixing on `PatchTripSchema` and `CreateTripSchema` together; pinned as current behaviour |
| **10 trip pushes skip per-user preferences, categories and quiet hours** | notifications owner | a user inside quiet hours still receives them. Re-plumbing risks the double-delivery the code names |
| 7 censuses declared no `head_commit` at session start; **passport still does not** | each lane | its own header argues declaring would report FRESH about 165 rows nobody re-read |

---

## The one number, stated with its caveats attached

**Trips: 93.3 % constructed, 59.4 % correct, of 451 requirements — on the branch.**

> RESTATED 2026-09-12 after census-trips §40.1–§40.7 (from 55.4 % / 19.5 % at
> §39). §40 is the first section that BUILDS rather than re-reads: §6.1 policy
> functions and Appendix B reason codes on the wire; the §19.1 envelope on every
> projection and §19.2's `/timeline` `/map` `/crew` `/context` (+ `/safety`);
> the §7.3 Temporal Freedom Engine with §7.2 conflicts; the §3.2 phase, §17.1
> health and derived AT_RISK; the §11.1 Today projection checking §22.4 live;
> §10.1/§10.2 presence source/confidence/freshness with the stale-render guard
> counted; §20.2's presence stop on completion with §20.3's questions; and an
> in-process §21.2 decision ledger. Every kernel-era read projection sits behind
> `trip_operational_projections_enabled`, seeded FALSE, because
> `check:flag-schema-prerequisites` caught Compass reaching a table production
> lacks. Two defects in graded code were found by the new tests and fixed:
> the straight-line travel adapter was not a lower bound under 2 km (TR128's
> soundness claim was false there), and Safe Return sessions could be attached
> to any trip. Not built, and said so: START_PLAN/IN_PROGRESS, subgroups and a
> `trip_decisions` table — each a migration this environment cannot execute.

- Both are **floors** derived from a document that has only just begun to be read
  against the code — and, since §40, from code that exists on ONE BRANCH, unmerged,
  behind flags seeded FALSE: BUILT is not MERGED, MERGED is not DEPLOYED, DEPLOYED
  is not ENABLED.
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
