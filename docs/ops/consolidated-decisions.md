# Consolidated decisions — ANSWERED 2026-09-22

**All six were decided by the owner on 2026-09-22.** The rulings are recorded
verbatim in substance below; the analysis that produced each question follows
unchanged beneath, so the reasoning a decision was taken against stays readable.

**These decisions authorize the work. They do NOT move a verdict.** No census
row changes on the strength of a ruling — each still needs its own acceptance
evidence, measured after the change lands. Anyone tempted to mark a row `C`
because a decision exists should read this sentence again.

| | ruling |
|---|---|
| **Q1** | **APPROVED — nullable trust scores.** The nine category columns and `overall_score` become nullable, NULL = not scored. Remove fabricated neutral defaults; update calculations and consumers. An unmeasured category must not contribute an invented 50. **Preserve legitimate measured values — do NOT mass-convert existing 50s without evidence of their origin.** Rehearse the migration and verify partially measured, entirely unmeasured, and negative-evidence cases before enabling the engine. |
| **Q2** | **APPROVED — structured restriction-sweep result.** Port `{expired, truncated, failed}` and bounded processing onto current main *while preserving main's scheduler wiring*. The caller must distinguish failure, partial completion, and an idle successful sweep. Verify repeated batches eventually process all eligible restrictions **without starvation**. |
| **Q3** | **APPROVED — "Not yet rated" for substituted standing.** Preserve `basis`, `basisNote` and `applicable` semantics. A substituted score must not produce "Established". Keep genuinely measured and partial states faithful to their evidence, and keep `unavailable` distinct from `not_applicable`. |
| **Q4** | **APPROVED — replace the contradictory `TierGuide`.** Use the existing basis explanation instead of the conflicting band table. Preserve useful explanatory access, and preserve the confidence fix distinguishing absent evidence from unreadable evidence. Do not redesign the hero. **Close #454 and #467 only AFTER their remaining useful changes are integrated and verified; link their replacements.** |
| **Q5** | **APPROVED — complete the safety-review writer.** Land the useful remainder of #456 against current main. **A service with no production caller is not completion**: connect the authorized review workflow, enforce reviewer eligibility, and verify an actual review produces the intended audit record. Preserve migration 2311 and existing data. Then rebase and re-measure #465 in the established dependency order. |
| **Q6** | **APPROVED — own-message rejoin exception.** A currently authorized, rejoined member may read their own earlier messages; other senders' messages remain subject to the new membership window. Implement consistently in the shared predicate **AND** the database queries that currently filter those rows out. Thread identity, active membership, tenant boundaries, deletion rules and every other authorization requirement stay **outside and mandatory for both branches** of the condition. Do not widen `visible_from_at`. An accessible own message must not reveal inaccessible quoted messages, previews, or another sender's protected attachments. Test pagination, search, direct retrieval, media access, coordination, Memory and Compass consumers, including requests made while membership is inactive. Finish the rehearsed deployment sequence and enable the history flag only after the intended application version and all prerequisites are verified. |

## Standing constraints attached to these rulings

* **Q1 does not authorize a backfill.** "Preserve legitimate measured values;
  do not mass-convert existing 50s without evidence of their origin" means a
  real 50 and a substituted 50 are indistinguishable in the current schema, so
  a blanket `UPDATE ... SET x = NULL WHERE x = 50` would destroy measurements.
  Any conversion needs per-row evidence, or none happens.
* **Q5 restates the test for done**: a caller, not a service. The same standard
  applies to Q6 — a carve-out in the predicate that fourteen SQL pre-filters
  discard before it runs is not implemented, it is merely written.
* **Q4's close condition is a sequence**, not a permission: #454 and #467 stay
  open until their remaining useful changes are integrated *and verified*, and
  the replacements are linked from them.

## Where the work is happening

The integration head is frozen while its checks complete. Implementation runs
in isolated worktrees and is batched back by the integration lead. Q1 and Q3
share `PassportProjectionService.ts`, so they are held by the lead rather than
split across agents.

---

# The analysis these decisions were taken against


Six decisions, one list. Five come from the Trust/Safety/Passport PRs still
open; the sixth is Telegraph's §14.3 rejoin question, folded in here rather
than tracked separately so there is one list to answer rather than two.

**Every "current main" line below was re-measured against `44438d77e` on
2026-09-22, not carried from the PR body that first reported it.** That matters
more than usual here: three of the five PRs have been substantially superseded
since they were written on 2026-09-06, and merging them as written would now
REGRESS main. Where that is so, the recommendation says close, not merge.

Nothing in this document is blocked on itself. Implementation and integration
continued while it was written; Q4's fourth item was found to need no decision
at all and is already built and pushed.

---

## Q1 · #449 · `trust_profiles` cannot represent "not scored"

**The decision.** Approve a migration making the nine category columns and
`overall_score` nullable, or accept permanent inflation of bad actors.

**Specification context.** Absence of a `trust_profiles` row already means "no
earned trust" everywhere else in the codebase: `getDisplayTrustScore` returns
null and documents that contract, `lib/trustScore` types the score
`number | null` explicitly *"rather than a fabricated number"*,
`TrustPrivacyGuard` falls back to `new_traveler`, and the client branches on
`hasScore`. Writing a fabricated row is what destroys that representation.

**Current main.** The gap is live. Every category column and the overall score
are `NOT NULL DEFAULT 50.00`
(`artifacts/api-server/baseline/20260819_baseline_structure.sql:10940#overall_score numeric(5,2)`),
and the scorer still substitutes the same constant for a category with no
events (`artifacts/api-server/src/services/trust/TrustScoreService.ts:229#function computeCategoryScore`).
#449's don't-persist guard is NOT on main. So a user with one negative event is
dragged back toward 50 by eight fabricated neutrals.

**Options.**

| | option | cost |
|---|---|---|
| a | make the ten columns `NULL`; NULL = not scored | one migration; readers already handle null elsewhere |
| b | add a parallel `*_measured boolean` per column | ten new columns, two sources of truth that can disagree |
| c | ship #449's guard alone | protects never-scored users only; per-category inflation untouched |

**Recommendation: (a).** NULL is the representation the rest of the codebase
already uses for exactly this meaning, so it invents nothing. (b) doubles the
column count and creates a second truth. (c) is not sufficient.

**Consequence of no answer.** `trust_engine_enabled` cannot be safely flipped.

---

## Q2 · #450 · may "lifted 0 restrictions" mean "could not tell"?

**The decision.** Must a failed restriction sweep be distinguishable from an
idle one at the call site?

**Current main — this is what changes the answer.** #450's two headline defects
are already fixed on main by a DIFFERENT implementation than the PR's. The
function has the caller it lacked
(`artifacts/api-server/src/lib/trustMaintenanceScheduler.ts:653#restrictionsExpired = await expireOldRestrictions(db);`)
and it does now bind its error
(`artifacts/api-server/src/services/trust/TrustRestrictionService.ts:333#export async function expireOldRestrictions(`).
But it returns `0` on that error into a bare `Promise<number>`, and the
scheduler assigns that to `restrictionsExpired`. **A failed sweep still reports
as a clean sweep that found nothing.** Main's version is also unbounded — no
batch limit on a growing table.

**Options.** (a) take #450's `{ expired, truncated, failed }` plus its 500-row
bound; (b) minimal — return `number | null`, null = could not tell; (c) accept
that 0 means either.

**Recommendation: (a), rebased rather than merged.** #450's branch predates
main's fix and would revert the caller wiring main now has. What is still worth
taking from it is the tri-state and the bound. (c) is the fail-open-as-
measurement pattern this whole workstream exists to remove.

---

## Q3 · #467 · the D-WORD — and a concrete replacement for "neither option"

**The decision.** May a substituted neutral 50 keep the word "Established"?

**Current main.** #467's central addition already landed: `getTrustProfileResult`
is imported by the projection service. Main ALSO shipped a vocabulary #467 never
proposed — `measured | partial | substituted | unavailable | not_applicable`
(`artifacts/api-server/src/services/passport/PassportProjectionService.ts:273#export type DomainTrustBasis`)
— and renders it as a note beside the word. But main still substitutes 50, still
calls it "Established"
(`artifacts/api-server/src/services/passport/PassportProjectionService.ts:1109#function presentationWord`),
and still hardcodes `applicable: true` on five of the six domains.

**Why neither option as written.**

* **#467 as written** sets `applicable: false` when no category exists. That
  deletes main's `basis`/`basisNote` explainability, which census-passport
  grades **C**. Merging it regresses a shipped, graded behaviour. It also
  conflates "we did not measure you" with "this domain does not apply to you" —
  the distinction main's `not_applicable` basis exists to preserve.
* **Main as-is** keeps "Established" and puts a note next to it. The word still
  asserts a standing nobody measured; an adjacent note does not retract it.

**Concrete replacement — take neither; do this.** Keep `basis` (shipped, tested,
graded) and change the word, not the range: when `basis === "substituted"`, the
domain's `presentation` becomes **"Not yet rated"** — the string the client
already renders for an inapplicable domain, so no new client vocabulary — while
`applicable` stays `true` and `basis` stays `substituted`. Measured and partial
domains are untouched.

One server function changes. The client needs no change. The census row keeps
its C. **Then close #467**, carrying only that change forward.

---

## Q4 · #454 · two trust vocabularies on one screen

**The decision.** Which word-set is canonical for a trust score?

**Current main.** #454's central change already landed —
`domainsFromServer` is on main and the server's per-domain word is rendered
verbatim. Two things #454 reported and deliberately did NOT fix are live:

**1. The explainer contradicts the word it explains.** Five server bands, five
client bands, different labels AND different boundaries, on the same screen:

| score | server word | the explainer sheet says |
|---|---|---|
| 62 | Established (≥50) | Community Member (60–79) |
| 45 | Building (≥35) | Growing Traveler (40–59) |
| 25 | New (<35) | New Explorer (20–39) |

**2. `?? 'low'` on an unmeasured confidence.** **This one is now FIXED** — see
the note at the foot of this file. It is recorded here because the fix
corrected #454's own reasoning about it, not just its code.

**Concrete replacement for "neither option as written."** Do not choose between
the two vocabularies and do not redesign the hero.

* **Delete `TierGuide`.** It is a band table for a number the screen does not
  show — the 0–100 score is self-view only. An explainer that contradicts the
  thing it explains is worse than none. The shipped `basisNote` already carries
  the honest version.

**Then close #454** as superseded, carrying that forward.

---

## Q5 · #456 / #465 · a safety audit table on main with no writer

**The decision.** Does `intel_claim_reviews` get its writer now, or come out?

**Current main — the sharpest of the six.** Migration
`artifacts/api-server/src/migrations/2311_intel_claim_reviews.sql` is on main
and is byte-identical to #456's copy. `reviewSafetyClaim` and `canReviewSafety`
return **zero matches anywhere on main**. A restricted moderation table, RLS on,
`service_role` only, exists with nothing writing to it. `src/lib/safetyPolicy.ts`
is also already on main. So #456's remaining delta is exactly two files:
`services/intel/SafetyReviewService.ts` and its test.

**Options.** (a) land #456's service so the table has its writer; (b) revert
2311 until the service is ready; (c) leave it writerless.

**Recommendation: (a), promptly.** `check:writerless-reads` exists to catch this
shape on the read side and has no write-side equivalent — a restricted table
nobody writes invites a future pass to build a second one. (b) discards an
applied migration for no gain.

**Landing order, verified rather than asserted.** `docs/architecture/census-trust.md`
is append-only and **last-statement-wins**, and #449 and #450 *both rewrite row
`C12`* with different line citations, because each shifts the other's file.
Whichever lands second carries stale citations and turns `check:doc-citations`
red. #465 touches that census in four lines and appends to `package.json`'s test
registry, which #456 and #467 also append to. Hence: **#456, #450, #449, then
#465**, with a re-measure between each.

**#465's own state.** `mergeable_state: dirty`. Unlike the others it is
genuinely unlanded: of the eight sites it fixes, the three sampled
(`cautionUnknown`, `unavailableSections`, `DetectorOutcome`) are all absent from
main. Its body says "Do not merge — for review"; that is not a reason to wait,
but it does need a rebase and a re-measure, because its own diff moves the
`routes/geofence.ts` lines its census row cites.

---

## Q6 · Telegraph · where the §14.3 rejoin carve-out belongs

**The decision.** May a rejoining member read their own pre-departure messages?

**Specification conflict, both rules in this repository.** §14.3 and the 2400
trigger comment say the new interval is a new membership with its own window.
Migration 2966 POSTCONDITION 3 aborts the apply on any `(member, own message)`
pair predating the window, in its own words *"refusing to hide a member's own
history"*.

**Current state, read from migration source.** 2966's backfill clamps every
derived window with `LEAST(tm_created, tm_joined, cm_created, mtm_joined,
own_first)`. The rejoin branch sets `visible_from_at := now()` with **no clamp**.
Production has **0 departed members**, so the rejoin branch has never run: the
measured "0 own-messages hidden" is a property of the backfill, not a trigger
invariant. An apply-time gate cannot enforce a runtime one.

**Recommendation.** Fix it on the READ path, not in the trigger:
`created_at >= visible_from_at OR sender_id = :viewer`. A single timestamp
cannot express "your own messages and nothing else" — clamping the trigger to
the member's earliest message also returns every OTHER sender's message after
that instant, which is most of the gap §14.3 exists to deny.

**What accepting it commits to, measured.**
`artifacts/api-server/src/services/groupChatHistoryBound.ts:93#export function withinWindow`
has **31 call sites across 13 files**, but it is one predicate, so all 31
inherit the carve-out untouched. **14 of those paths also push the bound into
the query first** as `.gte("created_at", <bound>)`, so a carve-out written only
in `withinWindow` is discarded by PostgREST before any JavaScript runs — it
would pass its unit tests and change nothing on search, coordination, memory or
the Compass tools. Those 14 must be relaxed in the same commit.

**Consequence of no answer.** `telegraph_history_bound_enabled` stays off. This
is the second of two independent holds; the first is the deploy.

---

## Already answered by the code, and built

Q4's second item needed no decision, because the server had already made it and
the client was overriding it. `passportTrustConfidence` returns
`TrustConfidenceBand | null` and returns null in four distinct cases — profile
absent, profile unreadable, evidence weight missing, evidence weight
non-finite/negative — stating the rule itself: *"neither of them is evidence, so
neither may produce a band."* `deriveTrustView` collapsed all four to the `low`
band, so a person whose records could not be READ was told they were a new
account. census-passport measured 56 of 58 production accounts with no trust
profile, so that was the normal path, not an edge case.

Fixed in `travel-buddy-standalone/src/features/passport/useTrustProjection.ts`,
with the absent and unreadable cases given different copy because they are
different claims. #454 predicted this needed a fourth hero state and a screen
redesign; it did not — the screen renders the label and copy as plain strings,
so the change is confined to the hook. Red-first: 4 of 5 tests fail without it,
5 of 5 with it, hook restored byte-identical.
