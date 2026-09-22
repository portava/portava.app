# Trust — compliance against the owner's authoritative specs, v1

*Measured 2026-09-14 in the worktree `/home/user/wt-483` (detached at `7d1f2d498`, PR #483 head
plus the v2 spec install), with sibling compliance lanes editing other surfaces in the same tree.
**No production read this pass** — every claim below is against files at this tree. No migration
applied to any database, no flag added or flipped, no provider enabled, no backfill run, no entry
added to `IMPLEMENTED_PROVIDERS`, no git write command run.*

The two authoritative documents, both supplied by the owner and both in the tree:

* `docs/specs/upgrades-v2/03-TRUST-v2.md` — 46 lines, `TRV2-01`…`TRV2-12` plus four prose sections.
* `docs/trust/verified-foundation-plan.md` — 123 lines, five privacy invariants and phases
  `V-0`…`V-7`.

This document does **not** replace `docs/architecture/census-trust.md`. The census counts
requirements and grades them in its own `C / W / NB / CV` grammar. This document enumerates the
**specs**, clause by clause, maps each clause onto a census row or records that no row exists, and
grades the clause in the four buckets the owner asked for. Where the two disagree, the disagreement
is stated here and the census row is corrected in `census-trust.md` §16, not silently.

---

## 1. The enumeration rule, and what it excluded

### 1.1 The rule

A prose passage becomes a **clause** when it states an obligation whose satisfaction could be
observed in this repository, in a database, or in a produced artifact — that is, when there is
some state of the world that would make it false.

Three consequences, stated because each one decides a hard case rather than dodging it:

1. **A table row is one clause, not one criterion.** `TRV2-04` names five links of a chain
   (session → signed webhook → authorized transition → profile → badge) and two negatives
   (duplicates, invalid signatures). It is enumerated as **one** clause and graded as a parent:
   *a parent with several mandatory criteria cannot be SATISFIED unless every criterion passes*,
   and the failing criterion is named. This is `census-trust.md` §12.2's rule, adopted unchanged so
   the two documents can be compared.
2. **A prose sentence outside a table is a clause on exactly the same terms.** The v2 document's
   requirements table is not its whole content. Four prose sections state sixteen further
   obligations — concept separation, no-regression, the scoring-policy request, the fixture
   programme, the release deliverable — and **the census enumerated none of them**. They are
   `V2-P1`…`V2-P16` below. This is where most of §4's coverage gaps come from.
3. **A documentary obligation is satisfied by its artifact.** "Request the authoritative policy",
   "produce the concrete configuration/release steps" — the deliverable is a document, and the
   document existing and saying the right thing is the whole of the evidence. Each such clause
   still names what would turn it red.

### 1.2 What was excluded — **14 passages**, each named

An enumeration that silently drops the hard ones is the failure mode here, so every excluded
passage is listed with the sentence and the reason. Nothing was excluded for being inconvenient;
two of the fourteen (X5, X9) are exclusions I would defend but a reader might reverse, and they are
marked.

**From `03-TRUST-v2.md` — 7:**

| # | Passage | Why it states no testable obligation |
|---|---|---|
| X1 | L3 *"Read 00-START-HERE.md and sources/trust-verified-foundation-plan.md."* | An instruction about how to read, not about what to build. No repository state makes it false. |
| X2 | L3 *"That baseline covers verification and moderation; it is not a complete specification of the Trust scoring model."* | A description of another document's scope. It bounds the other clauses; it is not one. |
| X3 | L3 *"This document does not invent the missing scoring policy."* | The document describing itself. |
| X4 | L7 *"An older inspected checkout contains TrustScoreService, TrustPrivacyGuard, TrustAdminService, TrustCapService and TrustRecoveryService."* | A historical observation about a checkout that is not this one. |
| X5 | L7 *"Locate their current equivalents and actual consumers; their presence does not prove end-to-end functionality."* | **Contestable exclusion.** It is an auditing method, not a product obligation — so it is *adopted as this document's grading rule* (§3's SATISFIED bar requires a reachable caller and a failing test, which is exactly this sentence) rather than graded as a clause. A reader who wants it counted should count it SATISFIED against §3. |
| X6 | L17–30, the table's **Basis** column (12 cells: `SENSE 16`, `TRUST V-0–V-2`, `engineering acceptance`, …) | Provenance pointers. They say where a requirement came from, not what it requires. |
| X7 | L40 *"It does not prevent implementing independently specified privacy, authorization, idempotency, wiring and Sensing separation requirements."* | A permission, not an obligation. Violating a permission is not possible. |

**From `verified-foundation-plan.md` — 7:**

| # | Passage | Why it states no testable obligation |
|---|---|---|
| X8 | L3 *"Suggested repo location: `docs/trust/verified-foundation-plan.md`"* | A filing instruction, and self-satisfied — the file is at that path. |
| X9 | L23 *"(DONE — files delivered as drop-ins)"* and the nine `[x]` checkboxes at L25–31 | **Contestable exclusion.** These are the plan's own status claims *about itself*, written before delivery was measured. They are not obligations; they are assertions this audit contradicts (`TV-0a` is `W`, `TV-0e` is `NB`, so two of the five `[x]` marks are false). Counting them as clauses would mean grading the plan's optimism rather than the product. |
| X10 | L33 *"(Agent, after E2EE migration settles)"* | Sequencing. Names no end state. |
| X11 | L65–66 *"(Agent — WAIT until E2EE thread migration is merged, since Telegraph screens are being touched now)"* | Sequencing. |
| X12 | L106–107 *"Cost checkpoints: ~$1.50–3.00 per verification attempt at both vendors. Rate limiting from V-1 is the cost-control mechanism"* | A vendor price fact plus a back-reference to `VF-1e`. The **monitoring** half of that same paragraph is *not* excluded — it is `VF-6c`, and it is a coverage gap (§4). |
| X13 | L118–123, the whole *"Sequencing note"* | Scheduling relative to a migration that has since merged. Names no end state. |
| X14 | L5–9, the Goal's deliverable list (*"government-ID identity verification with optional selfie liveness, verified badges, trust integration, reporting/blocking, a moderation queue, and safety surfaces"*) | Excluded as a **double-count**, not as untestable: every item is an abstract of a phase and is counted once under that phase. The clause of the Goal paragraph that is *not* a double-count — *"built provider-agnostic so the ID-check vendor is a config decision, not an architecture decision"* — is counted, as `VF-G1`. |

### 1.3 The resulting population

| Source | Clauses |
|---|---|
| `03-TRUST-v2.md` — requirements table `TRV2-01`…`TRV2-12` | 12 |
| `03-TRUST-v2.md` — prose sections `V2-P1`…`V2-P16` | 16 |
| `verified-foundation-plan.md` — Goal `VF-G1` | 1 |
| `verified-foundation-plan.md` — the invariants' *encoding* requirement `VF-P0` | 1 |
| `verified-foundation-plan.md` — five privacy invariants `VF-P1`…`VF-P5` | 5 |
| `verified-foundation-plan.md` — phases `V-0`…`V-7`, per bullet | 31 |
| **Total enumerated** | **66** |
| Excluded prose passages | 14 |

**The 31 phase clauses, per phase, so that "one row per phase" is visibly not what happened:**
`V-0` 5 · `V-1` 7 (six bullets, the webhook bullet split at the `verification_level` write) ·
`V-2` 4 · `V-3` 4 · `V-4` 3 · `V-5` 2 · **`V-6` 3** · `V-7` 3.

The census counts 30 here, not 31. The difference is `VF-6c` — *"monitor attempts per verified
user (>2.0 average means UX friction worth fixing)"* — which sits in V-6's cost paragraph rather
than in a bullet and was never counted. It is the one phase obligation that had no row at all.
Every other phase bullet **does** have its own individually-graded row: `V-7`'s three obligations
are `TV-7a`, `TV-7b`, `TV-7c` and carry three different verdicts (`C`, `C`, `NB`), which is the
check the brief asked for and which the census passes.

---

## 2. Clause list — mapping and grade

Verdict letters in the "Census row" column are the census's own at this tree. Bucket names are this
document's. `—` in the census column is a **coverage gap** and is expanded in §4.

### 2.A — `03-TRUST-v2.md`, requirements table (12)

| # | Clause (spec line) | Census row(s) | Bucket | Verified evidence at this tree |
|---|---|---|---|---|
| TRV2-01 | Passive movement, normal-looking behavior **and anonymous contribution** award or penalize no person Trust; *sensor/aggregate fixtures generate zero person Trust effects* (L19) | A19 `C`, A18 `C` | **PARTIAL** — behaviour half correct, evidence half absent | Substance holds three ways, and I re-executed each rather than trusting §12.6. (1) The only movement-derived person-trust events are negative and require an anomaly, not normality (`artifacts/api-server/src/services/trust/TrustEventService.ts:440#const delta = confidence === "high" ? -8`). (2) The anonymous contribution path cannot reach person trust at all: `artifacts/api-server/src/lib/sensingAnonStore.ts` and `artifacts/api-server/src/lib/sensingCoverageAggregate.ts` contain **zero** occurrences of the string `trust` — measured, `grep -c`, not read. (3) Migration 2315 makes re-identification unrepresentable (`artifacts/api-server/src/test/sensingAnonStore.test.ts:89#a stronger postcondition RAISEs on ANY foreign key`, 43/43 green). **What is missing is exactly what the spec names as the evidence**: there is no sensor/aggregate *fixture* asserting zero person-Trust effects. If someone added `recordTrustEvent` to `sensingCoverageAggregate.ts` tomorrow, nothing in the suite would go red. Cross-lane request, §6. |
| TRV2-02 | Source/signal reliability is distinct from person Trust; shared-intelligence APIs cannot substitute a person score for evidence confidence; **no reverse lookup of anonymous contributors** (L20) | A18 `C` | **SATISFIED** | Separation: `artifacts/api-server/src/lib/intelScopedTrust.ts` is its own store and the bridge moves only a named subset (`artifacts/api-server/src/test/intelScopedTrustApply.test.ts:262#the confidence model does not import scoped trust`, *"the confidence model does not import scoped trust"*, 19/19 green). Reverse lookup: migration 2315's postconditions RAISE on any FK **and** on an identity-shaped column name, pinned at `artifacts/api-server/src/test/sensingAnonStore.test.ts:89#a stronger postcondition RAISEs on ANY foreign key`. **The second criterion is evidence A18's cell never cited** — see §5's mapping corrections. |
| TRV2-03 | Anomalies create only policy-eligible safety candidates, not automatic canonical danger (L21) | TRV2-03 (own row) `C` | **SATISFIED** | Re-read: the candidate pipeline files a `moderation_reports` row and asserts nothing. Test: `artifacts/api-server/src/test/trust-integration.test.ts` (70/70 green at this tree). |
| TRV2-04 | Session → signed webhook → authorized transition → profile → badge works; duplicates and invalid signatures create no additional effects (L22) | TV-0b `C`, TV-0d `C`, TV-1a `W`, TV-1b `C`, TV-1c `W`, TV-1f `C`, TV-P5 `C`, TV-0e `NB`, TV-2c `NB` | **PARTIAL/INCORRECT** — the first three links correct, the last two not built | Correct half: signature verification is real and refuses (`artifacts/api-server/src/services/identityVerification/webhookSignature.ts:168#export function verifyTimestampedHmacSignature(input: VerifyWebhookSignatureInput): {`; `artifacts/api-server/src/test/verificationWebhookSignature.test.ts`, 28/28 green, including the replay-outside-tolerance case at `artifacts/api-server/src/test/verificationWebhookSignature.test.ts:215#REJECTS a replayed webhook whose timestamp is outside tolerance`); duplicates create no second award (`artifacts/api-server/src/test/verificationTrustIdempotency.test.ts`, 3/3, header names `TRV2-06` at `artifacts/api-server/src/test/verificationTrustIdempotency.test.ts:26#TRV2-06`). Failing half: **`profile` does not work** — `toVerificationLevel()` returns `id_verified`, which the live CHECK rejects with 23514, and migration 2870 is applied to no database (`artifacts/api-server/src/test/verificationLevelVocabulary.test.ts`, 3/3 green, is a test that *measures the defect*). **`badge` does not exist** — no `VerifiedBadge` component anywhere in the tree. |
| TRV2-05 | No raw IDs, document numbers, selfies or **dates of birth** enter Portava storage/logs; only permitted references and derived age eligibility; mock refused in production (L23) | TV-P1 `C`, TV-P2 `W`, TV-P4 `C`, TRV2-05 (own logs row) `C` | **PARTIAL/INCORRECT** — the verification path is clean, the platform is not | Clean: `VerificationResult` declares no such field (`artifacts/api-server/src/services/identityVerification/types.ts:58#export interface VerificationResult {`) and both real adapters are tested to never emit one (`artifacts/api-server/src/test/verificationProviderNormalization.test.ts`, *"NEVER puts the date of birth in the result"* / *"NEVER puts the birthdate in the result"*, 25/25 green). Not clean: `profiles.date_of_birth` exists and is the live age signal — `artifacts/api-server/src/lib/travelerVerification.ts:66#const dateOfBirth = (row["date_of_birth"] as string`. The clause says **storage**, not "verification storage", so the DOB criterion fails. `OWNER — D-DOB`. |
| TRV2-06 | Domain consequences require the correct actor, subject, event and adjudication (L24) | C1 `C`, C3 `C`, C5 `C`, C7 `C`, C21 `C`, TV-1f `C`, TV-4a `W` | **PARTIAL** — attribution and idempotency correct, adjudication incomplete | Correct: dedup, severity routing to `pending_review`, the review queue, explicit counterparty, every admin write audited, and *"does not audit a dismissal another admin made"* (`artifacts/api-server/src/test/zeroRowTrustAdjudication.test.ts:192#does not audit a dismissal another admin made`). Failing criterion: **adjudication of a moderation report has no acting route** — nothing updates `moderation_reports.status`, re-confirmed at this tree, so an unconfirmed report can neither be upheld nor dismissed through the product. `OWNER — D-MODACTION-SHAPE` for two of five, `ADMIN-ROUTE LANE` for the rest. |
| TRV2-07 | Crash/retry/replay produces the approved result; **failed reads do not become clean reputation**; scheduler wiring demonstrated (L25) | A10 `C`, C11 `W`, C16 `C`, C17 `C`, C25 `C` | **PARTIAL** — durability and wiring correct, one read-error path wrong | Correct: replayability, labelled degraded reads, restriction expiry now scheduled, and the scheduler *observed* firing. Failing criterion: `getTrustProfile` still collapses an unreadable `trust_profiles` into `null` for five readers; only Passport's domain builder was switched to the `ok / absent / unavailable` union (`artifacts/api-server/src/test/trustProfileUnreadableDowngrade.test.ts:95#assert.equal(broken.state, "unavailable"`, 5/5 green — the test proves the union exists, not that the five readers use it). |
| TRV2-08 | Apply restrictions **at actual consuming actions** — Compass, Discovery, social and booking; public summaries reveal no reporter identity or private evidence (L26) | A12 `C`, A13 `W`, A7 `C`, C20 `C`, TRV2-08 (own row) `NB` | **PARTIAL** — the privacy half correct, the reach half not built | Correct: privacy-safe summaries, no reporter id, human-readable restrictions. Not built: `getRestrictionState` has exactly five non-Trust callers (messaging, calls, hosting, crew live-share, and one Passport **projection**, which is display and not a gate). None of the four paths the clause names enforces anything. A restricted user is still recommended, discovered and bookable. `OWNER — D-RESTRICTION-REACH`. |
| TRV2-09 | Unauthorized caller cannot override, lift, confirm or dismiss; approved changes record actor, reason and subject; concurrency does not lose active restrictions (L27) | C26 `C`, C21 `C`, TRV2-09 (own row) `C` | **SATISFIED** | All three criteria re-executed. Guard: `artifacts/api-server/src/test/trust-integration.test.ts:335#it("GET /admin/trust/reviews returns 403 for non-admin"` (70/70 green). Audit: `logAdminAction` at seven call sites, column drift pinned. Concurrency: no read-modify-write exists on either restriction table — the lift is one statement scoped to unlifted rows. |
| TRV2-10 | Revocation, appeal and account-deletion lineage follow **the defined** reversal/retention policy (L28) | TRV2-10 (own row) `CV`, TV-4c `C`, TV-7a `C`, C14 `C`, TV-P3 `W` | **CANNOT-VERIFY** | Correctness is defined by a policy no approved document states. The three mechanisms exist and disagree: revocation clears `verification_level` and deliberately leaves the `identity_verified` +10 applied; an upheld appeal *adds* `appeal_approved` (+2) and reverses nothing (`artifacts/api-server/src/services/appeals/resolveAppeal.ts:288#eventType:  "appeal_approved",`); deletion destroys trust evidence by FK cascade while `AccountDeletionService` names no trust table. **Evidence that would settle it:** a written answer to `D-REVERSAL` — for each of revocation / upheld appeal / deletion, does the derived effect reverse, decay or persist; if it reverses, by a counter-event or by deleting the original; and how long derived evidence about an erased subject survives. **Who supplies it:** the OWNER. No lane can infer it. |
| TRV2-11 | No historical stamp, inferred visit or passive contribution becomes a new award absent an approved backfill policy; fixtures stay isolated (L29) | TRV2-11 (own row) `C` | **SATISFIED** | Re-executed: the six `src/scripts/backfill*.ts` files reference neither `trust_events` nor `recordTrustEvent`. Nothing this pass or the two before it manufactured an award; the only trust-affecting change in the series **removed** awards by adding a dedup key. Every suite above runs against an injected double. |
| TRV2-12 | Verified badge reflects actual verification state; unknown reputation is not silently "established"; source reliability never appears as a person's badge (L30) | A18 `C`, A9 `C`, TV-0e `NB`, TV-2c `NB`; the "established" clause is census-passport P45 | **PARTIAL/INCORRECT** — and the incorrect half is worse than "not built" | Correct: source reliability never surfaces as a person badge; copy is non-stigmatizing. **Incorrect**: the clause is not merely unbuilt. An indicator **does** render, and it reads the wrong column — `travel-buddy-standalone/src/components/layover/LayoverPeopleSection.tsx:99#{b.verified && <BadgeCheck size={13} color={color.deep} />}`, driven by the legacy `profiles.verified` boolean rather than by `verification_level`. `UserIdentityLink.tsx`, the component the plan names as the badge's home, contains the string `verified` zero times. So today's badge asserts a verification state that the identity pipeline cannot produce. `OWNER — D-BADGE`, then the client lane. |

### 2.B — `03-TRUST-v2.md`, prose clauses (16)

**None of these sixteen was in the census's 93.** Twelve are coverage gaps that become new census
rows in `census-trust.md` §16; four map onto rows that already exist.

| # | Clause (spec line) | Census row | Bucket | Evidence |
|---|---|---|---|---|
| V2-P1 | Reuse canonical Trust events, score projection, caps, restrictions, admin actions, review queues, repair/scheduling and privacy guards — eight named subsystems (L7) | maps to A5, A17, C10, C31 | **SATISFIED** | No second engine exists: `lib/trustScore.ts` delegates rather than computes, and the maintenance work reuses the one scheduler rather than adding a second (`artifacts/api-server/src/lib/trustMaintenanceScheduler.ts:635#const r = await purgeExpiredVerificationRecords(db);` — V-7's purge runs inside the existing 6-hour pass). Red-maker: a second `recalculate`/`getDisplayTrustScore` implementation, which `passportTrustConsistency.test.ts` would fail on. |
| V2-P2 | **"Keep these concepts separate … Never merge them into one score"** — verified identity, person Trust/reputation, eligibility restrictions, source reliability, signal reliability, world confidence, personal fit, venue quality (L9) | **— (gap → new row)** | **PARTIAL/INCORRECT** | Separate: person Trust vs source/signal reliability (A18), vs restrictions (four booleans), vs verified identity (a different column). Absent as concepts: `world confidence` and `venue quality` have no score anywhere in the tree, so there is nothing to keep separate. **Merged**: `personal fit` is not separate. `artifacts/api-server/src/services/rentBuddy/CompatibilityScoreService.ts:87#  trustScore:         8,` gives person Trust a weight of 8 inside a 14-input weighted sum that emits **one 0–100 number**; `:193#breakdown.trustScore` folds it in, and it is live — `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:463#toBuddyScoringData(r, trustMap.get(r.user_id) ?? 50)`. The `?? 50` is the P45 constant-substitution shape a third time. **The reading is contestable and I do not settle it**: A16 already grades "the score as one ranking *input*" as acceptable, and a weighted term inside an emitted score is more than an input. Stated as a finding, graded PARTIAL, not moved to SATISFIED on the charitable reading nor to MISSING on the strict one. |
| V2-P3 | Preserve current approved behavior while resolving specification gaps (L9) | **— (gap → new row)** | **CANNOT-VERIFY — awaiting D-SCORING** | Unverifiable by construction for the scoring half: twelve families of scoring parameters run in production and are **ratified nowhere** (`docs/trust/scoring-parameters-for-ratification.md`), so "current *approved* behavior" names an approval that does not exist and "preserved" cannot be checked against it. **Evidence that would settle it:** a ruling on D-SCORING — "all twelve, ratify as v1" is a complete answer. **Who supplies it:** the OWNER. For the non-scoring half the answer is yes (every suite named in this document is green at this tree), but a parent cannot be SATISFIED on one criterion. |
| V2-P4 | `Authorized domain event → ingestion and idempotency → policy/review → score/restriction projection → privacy-safe API → authorized consumer` (L11) | maps to A5 | **SATISFIED** | Structurally end-to-end and each hop cited in A5. Liveness of the first hop is A6's separate `W` and is an emitter defect, not a pipeline one. |
| V2-P5 | `World observation/anomaly → safety candidate → safety authority and review → canonical safety assertion`; Sensing writes no person Trust consequence and turns no anomaly into danger (L13) | maps to TRV2-03 | **SATISFIED** | Same evidence as TRV2-03, plus the zero-`trust`-references measurement on the two sensing modules under TRV2-01. |
| V2-P6 | Before changing scoring behavior, **request** the authoritative policy for event eligibility, category weights, decay, caps, thresholds, serious findings, recovery, reversals and appeals (L34) | **— (gap → new row)** | **SATISFIED** | The request exists and is specific: `docs/trust/scoring-parameters-for-ratification.md` enumerates twelve families under headings §1–§12 and closes with *"What a ruling unblocks, precisely"*. No scoring behavior changed: `TrustScoreService.ts` carries no diff from the D-OVERRIDE pass (§15.7). **Red-maker:** any diff to the nine weights, six thresholds, half-life or window landing without a ratification. |
| V2-P7 | Inventory existing behavior as implementation evidence; **do not promote it to approved specification automatically** (L34) | **— (gap → new row)** | **SATISFIED** | The inventory marks each family *overridable* or *HARD-CODED* and states its own status explicitly: *"Nothing here is a request to change a number"* and *"Until a ruling lands, the dependent rows in `census-trust.md` stay `W`/`N` and say why. They will not be moved on an assumption."* **Red-maker:** a census row moving to `C` citing that document as its specification. |
| V2-P8 | The admin-override ambiguity is an explicit decision; request semantics, precedence with restrictions, expiry and removal; **preserve existing behavior until resolved; do not silently convert ceiling into pin** (L36) | maps to C22 `W` | **PARTIAL** | Graded against the **CAP ruling**, as instructed, not against PIN. Satisfied: the question was posed as one answerable question, the owner ruled CAP, the lost-upsert defect that made the ceiling not persist is fixed and pinned by four red-producing mutations, and PIN was **deliberately not built** — no `floor_score` column, no `Math.max` swap, no flag. Not satisfied: precedence with restrictions, expiry and removal are explicitly LATER WORK and remain unanswered; and the fold is still `artifacts/api-server/src/services/trust/TrustScoreService.ts:186#caps[row.category] = cur !== undefined ? Math.` with no reason-code awareness. Independently, `adminOverrideScore` is **unwired to any route**, so no admin can perform an override at all — which is why C22 stays `W` and why this clause cannot be SATISFIED. |
| V2-P9 | The plan's retention values apply to the stated verification records, **not automatically to all Trust evidence**; do not rewrite unrelated retention rules (L38) | **— (gap → new row)** | **SATISFIED** | The 90-day value is scoped to exactly one table and two statuses: `artifacts/api-server/src/services/identityVerification/retention.ts:31#export const PURGEABLE_STATUSES: readonly string[] = ["failed", "expired"];` and `:34#VERIFICATION_RETENTION_DAYS`. No trust table is named. **Red-maker, and it is a real test:** `artifacts/api-server/src/test/verificationRetention.test.ts` asserts the status set *as a set* and that the purge *"never names a verified row, by any spelling of the filter"* — 7/7 green at this tree. |
| V2-P10 | Missing scoring policy prevents claiming complete Trust specification or **100 % correctness** (L40) | **— (gap → new row)** | **SATISFIED** | `census-trust.md` §14.8 states CORRECT 72/93 = 77.4 %, and §14.0 explicitly **retires** the old 96.2 % figure and forbids quoting it. **Red-maker:** `check:census-integrity`, which recomputes per-census counts from the tables and reports the stated denominators — exit 0 at this tree, trust parsed as 93 rows `C=72 W=14 N=6 X=1`. |
| V2-P11 | Use isolated fixtures spanning caller/subject asymmetry, concurrent duplicate events, projection failure, stale evidence, invalid signatures, unauthorized admins, revoked verification and appeal outcomes — **eight named classes** (L44) | **— (gap → new row)** | **SATISFIED** | All eight present and green at this tree, one file each: caller/subject asymmetry `artifacts/api-server/src/test/zeroRowTrustAdjudication.test.ts:192#does not audit a dismissal another admin made`; concurrent duplicate events `artifacts/api-server/src/test/verificationTrustIdempotency.test.ts` (3/3); projection failure `artifacts/api-server/src/test/trustProfileUnreadableDowngrade.test.ts:95#an unreadable row is its own answer` (5/5); stale evidence `artifacts/api-server/src/test/trustAsymmetryAndMaintenance.test.ts:186#describe("TrustScoreService — the earn/lose asymmetry"`; invalid signatures `artifacts/api-server/src/test/verificationWebhookSignature.test.ts:215#REJECTS a replayed webhook whose timestamp is outside tolerance` (28/28); unauthorized admins `artifacts/api-server/src/test/trust-integration.test.ts:335#GET /admin/trust/reviews returns 403 for non-admin` (70/70); revoked verification `artifacts/api-server/src/test/adminUnverifyRevokesIdLevel.test.ts:5#verified-foundation-plan.md V-4:` (5/5); appeal outcomes `artifacts/api-server/src/test/appealReversalAffectedRows.test.ts:182#recordTrustEvent inserts into trust_events`. "Isolated" holds — every one injects a double. |
| V2-P12 | Test actual consuming routes and **real database constraints/RLS** where applicable (L44) | **— (gap → new row)** | **PARTIAL** | Routes half: satisfied — the signature suite drives `POST /api/verification/webhook` end to end, the admin suite drives the guarded routes. Database half: **not** satisfied. The one live constraint that was measured is the one that *rejects* the write, and its fix is staged and applied nowhere (`artifacts/api-server/src/test/verificationLevelVocabulary.test.ts`, 3/3 green — a passing test that documents a broken production path). RLS is exercised by no test at all: migration 2370's revocations were applied to CI only, production not applied, owner decision. |
| V2-P13 | A mocked provider test certifies only the adapter contract; provider sandbox and production operational evidence remain separate (L44) | **— (gap → new row)** | **SATISFIED** | `artifacts/api-server/src/services/identityVerification/readiness.ts:53#const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);` — unchanged, with both real adapters written. The separation is **enforced by a test**, not a promise: `artifacts/api-server/src/test/rentBuddyKycGate.test.ts:77#assert.match(stripe.reason, /IMPLEMENTED_PROVIDERS/` requires the refusal reason to name the sandbox evidence and the switch (12/12 green). This is the clause that keeps `VF-6b` honestly `W`. |
| V2-P14 | Preserve report/block journeys, badges, age gates, Safety Center and existing authorized consumers (L46) | **— (gap → new row)** | **SATISFIED** | A no-regression clause, and nothing regressed. Report/block: `TV-3a`…`TV-3d` all `C`, unchanged. Age gate: `artifacts/api-server/src/test/ageGate.test.ts` 6/6 green. Safety Center: `TV-5a` still `W` at four of six links — incomplete, but not *broken* by this work. Consumers: the seven `buildConsumerProjection` variants are untouched. **Red-maker:** any of those suites going red beside a Trust change. |
| V2-P15 | Do not enable providers, run historical backfills, alter scoring policy or activate production flags **merely to close a requirement** (L46) | **— (gap → new row)** | **SATISFIED** | Four checks, all re-executed: `IMPLEMENTED_PROVIDERS` still `["mock"]` with the adapters written — the strongest possible form of this clause, since the temptation was live; no backfill writes trust (TRV2-11); `TrustScoreService.ts` carries no diff; no flag added or flipped in this or the two preceding passes. |
| V2-P16 | Produce the concrete configuration/release steps and identify the exact remaining owner action (L46) | **— (gap → new row)** | **SATISFIED** | `census-trust.md` §12.7's `TV-6a` row lists six steps naming the exact variables the code consumes. Verified against the code rather than against the prose: `IDENTITY_WEBHOOK_SECRET` is the single signing-secret variable for **both** vendors (`artifacts/api-server/src/services/identityVerification/providers.ts:63#  return process.env['IDENTITY_WEBHOOK_SECRET'];`), and `STRIPE_IDENTITY_SECRET_KEY` / `PERSONA_API_KEY` + `PERSONA_TEMPLATE_ID` are the per-vendor ones. The remaining owner action is named exactly: D-PROVIDER. |

### 2.C — `verified-foundation-plan.md`, Goal and invariants (7)

| # | Clause (spec line) | Census row | Bucket | Evidence |
|---|---|---|---|---|
| VF-G1 | Built **provider-agnostic** so the ID-check vendor is a config decision, not an architecture decision (L7–9) | **— (gap → new row)** | **SATISFIED** | Measured, not asserted: a repository-wide search for `stripeIdentity`, `from './persona'` or `personaCreateSession` returns **three** files, all inside `services/identityVerification/` plus one test. `routes/verification.ts` names no vendor outside a comment. Selection is one line: `artifacts/api-server/src/services/identityVerification/providers.ts:149#const name = (process.env.IDENTITY_PROVIDER ?? 'mock').toLowerCase();`. **Red-maker, and it is a test:** `artifacts/api-server/src/test/verificationWebhookSignature.test.ts` §*"REAL_PROVIDER_NAMES cannot drift from the factory it quantifies over"* asserts coverage of every non-mock branch the factory can return (28/28 green). |
| VF-P0 | The five invariants are *"non-negotiable, **encoded in schema + adapter types**"* (L11) | **— (gap → new row)** | **PARTIAL** | The *encoding* is a distinct obligation from the invariants themselves, and the census records its absence as a caveat inside `TV-P1` rather than grading it. Encoded: invariant 1 — no such column on `identity_verifications`, no such field on `VerificationResult` (`artifacts/api-server/src/services/identityVerification/types.ts:58#export interface VerificationResult {`), so TypeScript's excess-property check refuses an adapter that returns one. Not encoded: invariant 2 is encoded *on the verification path only* while `profiles.date_of_birth` lives outside it; invariant 3 is contradicted by the schema (CASCADE, not SET NULL); invariants 4 and 5 are **runtime throws**, not schema or type constraints. And no guard script rejects a future column — `grep` over `src/scripts/` and `scripts/` returns no check on `identity_verifications`' shape. |
| VF-P1 | Never store raw government-ID images, document numbers or selfies — opaque references only (L13–14) | TV-P1 `C` | **SATISFIED** | Schema shape confirmed against `db/migrations/0161_identity_verification.sql`; adapter shape confirmed above; both real adapters tested to emit derived fields only (`verificationProviderNormalization.test.ts`, 25/25). |
| VF-P2 | Never store date of birth; age gating stores a derived `is_over_18` boolean only (L15–16) | TV-P2 `W` | **PARTIAL/INCORRECT** | Inverted in practice. `is_over_18` is written (`routes/verification.ts:150#is_over_18:`) and read by **no** gate; every age gate reads `profiles.date_of_birth` instead (`artifacts/api-server/src/lib/travelerVerification.ts:66#const dateOfBirth = (row["date_of_birth"] as string` and five more). `OWNER — D-DOB`: either migrate the six gates onto `is_over_18` and drop the column, or amend invariant 2 in writing. A lane may not amend a privacy commitment. |
| VF-P3 | Verification rows deletable per-user for GDPR erasure **without destroying moderation audit history** (reports/actions use SET NULL) (L17–18) | TV-P3 `W` | **PARTIAL/INCORRECT** | First half correct: the rows are deletable and the cascade requests provider erasure first. Second half wrong: `moderation_actions.target_user_id` is CASCADE and `performed_by` is NO ACTION, so erasing a subject destroys every enforcement record about them and erasing a moderator is blocked outright — the exact opposite of SET NULL. `trust_events.reviewed_by` and `trust_caps.lifted_by` have the same shape. `OWNER — D-MODACTION-FK`, then a migration the integration owner must number. |
| VF-P4 | The mock provider is refused in production by the factory (L19) | TV-P4 `C` | **SATISFIED** | `providers.ts:154#IDENTITY_PROVIDER=mock is not allowed in production` throws; and the refusal is *load-bearing for another test*, which is the strongest form of reachability — `artifacts/api-server/src/test/verificationWebhookProviderUnavailable.test.ts:95#invariant 4 is the mechanism this test depends on` asserts *"invariant 4 is the mechanism this test depends on; if it stops throwing, this test proves nothing"*. |
| VF-P5 | Webhooks are signature-verified in every real adapter; an unverified webhook **throws, never silently accepts** (L20–21) | TV-P5 `C` | **SATISFIED** | `webhookSignature.ts:168#export function verifyTimestampedHmacSignature`, bound per-adapter by header name, verified **before** the body is parsed. Eleven refusal cases green, including a digest prefix, a non-hex digest of the right length, a replay outside tolerance, and an unset secret; plus three route-level cases proving the refusal reaches `POST /api/verification/webhook` as a 400. 28/28. |

### 2.D — `verified-foundation-plan.md`, phases V-0…V-7 (31)

Graded individually, per bullet, never per phase. Census verdicts at this tree in the second column.

| # | Clause | Census row | Bucket | Note |
|---|---|---|---|---|
| VF-0a | Schema: `identity_verifications`, `moderation_reports`, `moderation_actions`, profile `verification_level` + `verified_at` | TV-0a `W` | PARTIAL | Tables exist, but `moderation_actions` cannot express "suspend with expiry" or the report→action link. `OWNER — D-MODACTION-SHAPE`. |
| VF-0b | Provider adapter interface + normalized status model | TV-0b `C` | SATISFIED | `types.ts:58#export interface VerificationResult {`; normalization tested for both vendors. |
| VF-0c | Working mock provider with forced-failure test hints | TV-0c `C` | SATISFIED | |
| VF-0d | Stripe/Persona stubs + env-driven factory | TV-0d `C` | SATISFIED | Stubs superseded by real adapters; the factory is `providers.ts:149#IDENTITY_PROVIDER ?? 'mock'`. |
| VF-0e | `VerifiedBadge` component (teal = ID verified, gold = ID + selfie) | TV-0e `NB` | **MISSING** | No such component anywhere. `OWNER — D-BADGE` (wording and colours are unresolved brand decisions), then the client lane. |
| VF-1a | `POST /api/verification/session` — auth required; caller's session; upsert row in **`created`** status; return `redirectUrl` | TV-1a `W` | PARTIAL | Three of four criteria. The route writes `pending` where the plan says `created`. Effect nil, criterion unmet. Verification-route lane. |
| VF-1b | `POST /api/verification/webhook` — raw-body; `provider.handleWebhook`; update the row | TV-1b `C` | SATISFIED | |
| VF-1c | …and on `verified`, set `profiles.verification_level` via `toVerificationLevel()` and `verified_at` | TV-1c `W` | PARTIAL | The write is a 23514 against the live CHECK. Migration 2870 written, reversible, additive, **applied to no database**. `OWNER — D-2870-APPLY`. Until then no user can become ID-verified at all. |
| VF-1d | `GET /api/verification/status` — poll fallback | TV-1d `C` | SATISFIED | |
| VF-1e | Rate limits: max 3 session creations per user per 24 h | TV-1e `C` | SATISFIED | |
| VF-1f | Trust Score hook on transition to `verified` | TV-1f `C` | SATISFIED | `routes/verification.ts:42#const TRUST_SOURCE_TYPE = "identity_verification";` gives the award an idempotency key; before that every redelivery charged another +10. |
| VF-1g | Tests: mock end-to-end, forced failures map to reasons, rate limit | TV-1g `C` | SATISFIED | |
| VF-2a | Entry points: Passport profile, Rent-a-Buddy gate | TV-2a `W` | PARTIAL | Passport entry exists; the Rent-a-Buddy gate routes nowhere, so a user the server-side gate refuses is given no way to satisfy it. Client lane. |
| VF-2b | Screens: intro (**what we never store**) → hand-off → pending → success/failure | TV-2b `W` | PARTIAL | Three of four. The "what we never store" section does not exist — the user-facing half of VF-P1/VF-P2. Client lane. |
| VF-2c | Render `VerifiedBadge` beside names on six surfaces, inside `UserIdentityLink` | TV-2c `NB` | **MISSING** | And worse than missing: a badge already renders from `profiles.verified` (TRV2-12). |
| VF-2d | Failure UX: clear reason + retry; `underage` routes to an age-policy screen, no retry spam | TV-2d `W` | PARTIAL | Copy is `failureReason.replace(/_/g,' ')`; `underage` takes no distinct branch. Client lane. |
| VF-3a | Report entry points: profile, post/comment, Telegraph thread, event, buddy listing, review | TV-3a `C` | SATISFIED | |
| VF-3b | Report sheet writes via a server route so `subject_user_id` is attached server-side | TV-3b `C` | SATISFIED | |
| VF-3c | Each report entry point also offers Block, reusing the existing block service | TV-3c `C` | SATISFIED | |
| VF-3d | Reporter sees "we received it"; no visibility into outcomes | TV-3d `C` | SATISFIED | |
| VF-4a | Admin queue: list, filter, subject snapshot, act (warn / remove / suspend-with-expiry / ban / dismiss), each writing `moderation_actions` | TV-4a `W` | PARTIAL | No category filter; snapshots only for `place`; **nothing updates `moderation_reports.status`**, so the queue can only grow. Two of five criteria gated on D-MODACTION-SHAPE. |
| VF-4b | Suspension middleware: suspended → read-only with an appeal contact; banned → signed out | TV-4b `W` | PARTIAL | Today a blanket 403. `routes/appeals.ts` and `app/appeals.tsx` both exist and nothing points at them from the refusal. `OWNER — D-SUSPENSION-UX`. |
| VF-4c | `verification_revoked` clears `profiles.verification_level` | TV-4c `C` | SATISFIED | `routes/admin.ts:1655#verification_level: "none",`; pinned by `adminUnverifyRevokesIdLevel.test.ts` (5/5). |
| VF-5a | Safety Center: Safe Return, SOS, verification status, blocked-users, community guidelines, report history | TV-5a `W` | PARTIAL | Four of six. A repository-wide search returns no community-guidelines surface at all, so one must be written before it can be linked. |
| VF-5b | Age gating: 18+ features check `is_over_18` from the latest verified row; unverified see a "verify to access" gate, not silent hiding | TV-5b `NB` | **MISSING** | `is_over_18` is read by no gate; `AgeGate.tsx` asks for a birthdate, which is the opposite mechanism. Cannot be built first — writing the gate decides D-DOB. |
| VF-6a | **OWNER:** choose vendor, open the account, obtain keys, register the webhook, take the signing secret, set Replit Secrets staging-first | TV-6a `NB` | **MISSING** (owner work) | Not unverifiable — verifiably not done. The six steps are written out and name the exact variables the code reads (V2-P16). `OWNER — D-PROVIDER`. |
| VF-6b | **AGENT:** implement the chosen adapter; sandbox end-to-end test; flip `IDENTITY_PROVIDER` staging → production | TV-6b `W` | PARTIAL | One of three criteria. Both adapters are written for both vendors, so the choice no longer gates the code; the payload mapping is *guessed from vendor documentation* and unproven, and `IMPLEMENTED_PROVIDERS` is still `["mock"]` — which is the honest reason this is `W` and not `C`, and V2-P13 is the clause that keeps it so. |
| VF-6c | **Monitor attempts per verified user** (>2.0 average means UX friction worth fixing) (L107–108) | **— (gap → new row)** | **MISSING** | The one V-phase obligation with no census row. No metric, counter, report or query exists: a repository-wide search for an attempts-per-verified-user measure returns only an unrelated phone-verification per-hour ceiling and an admin-visuals "avg attempts per success" for a different subsystem. Rate limiting (VF-1e) is the *control*; the plan asks separately for the *measurement*, and without it nobody can tell whether the >2.0 threshold has been crossed. Cheap to build and blocked on nothing — see §6. |
| VF-7a | Account deletion calls `requestProviderDeletion()` **then** deletes the rows | TV-7a `C` | SATISFIED | `providerErasure.ts:58#export async function requestProviderDeletionForUser(` reads the refs, `AccountDeletionService.ts:1002#const provErasureOk = await step(steps, "request_provide` runs before the delete step; *"reads the refs BEFORE deleting the rows that hold them"* and *"an unreadable table is not 'nothing to redact' — it throws"* both green (6/6). |
| VF-7b | Retention job: purge failed/expired verification rows older than 90 days | TV-7b `C` | SATISFIED | `retention.ts:31#PURGEABLE_STATUSES` / `retention.ts:34#VERIFICATION_RETENTION_DAYS`; run from `trustMaintenanceScheduler.ts:635#purgeExpiredVerificationRecords(db)`, **above the `isTrustEnabled` gate** so a scoring flag cannot switch off a data-protection promise — and that placement is itself asserted: *"purges even when the TRUST ENGINE FLAG IS OFF"* (7/7 green). |
| VF-7c | Document the data flow in the privacy policy surface | TV-7c `NB` | **MISSING** | No privacy-policy screen, route or link exists in `travel-buddy-standalone/app` or `src`. Client lane; the content is available (invariants 1–5 plus §14.3's inventory). |

---

## 3. Bucket counts, with denominators

**Denominator: 66 enumerated clauses** (28 from `03-TRUST-v2.md`, 38 from
`verified-foundation-plan.md`). 14 prose passages excluded, each named in §1.2.

| Bucket | Count | Share of 66 |
|---|---|---|
| **SATISFIED** — built, reachable, and something fails if it breaks | **35** | 53.0 % |
| **PARTIAL / INCORRECT** — which half is named on every row | **23** | 34.8 % |
| **MISSING** — not built | **6** | 9.1 % |
| **CANNOT-VERIFY** — evidence named, supplier named | **2** | 3.0 % |
| | **66** | 100 % |

Split by source document, because the two behave very differently:

| Source | n | SATISFIED | PARTIAL | MISSING | CANNOT-VERIFY |
|---|---|---|---|---|---|
| `03-TRUST-v2.md` (TRV2-01…12 + V2-P1…P16) | 28 | 16 | 10 | 0 | 2 |
| `verified-foundation-plan.md` (VF-G1, VF-P0…P5, V-0…V-7) | 38 | 19 | 13 | 6 | 0 |

**The two CANNOT-VERIFY rows, with the evidence and the supplier:**

| Clause | Evidence that would settle it | Who supplies it |
|---|---|---|
| TRV2-10 | A written `D-REVERSAL` ruling: for each of admin revocation, upheld appeal and account deletion — does the derived trust effect reverse, decay or persist; if it reverses, by a counter-event or by deleting the original; and how long does derived evidence about an erased subject survive (the plan's 90-day verification value, or another)? | **OWNER** |
| V2-P3 | A `D-SCORING` ruling. "All twelve, ratify as v1" is a complete answer and settles this clause outright; a selective ruling settles it for the families named. | **OWNER** |

**On D-SCORING specifically, and this is worth stating plainly.** Exactly **one** of the 66 clauses
is blocked on it, and it is the no-regression clause. That is not because the scoring gap is small —
it is because *neither authoritative document states a scoring requirement at all*. `03-TRUST-v2.md`
says so in its first paragraph and again at L40. So D-SCORING does not make a single TRV2 or V-phase
clause unverifiable; what it makes unverifiable is the **policy correctness of six census rows whose
structural correctness is certified** — `C2` (earning caps), `C8` (nine category scores and the
weighted overall), `C9` (the earn/lose asymmetry), `C12` (cap ceilings and expiry), `C13` (which
findings deserve a ceiling), `C27` (the bounds an admin may set). Those six are graded `C` in the
census for doing what the code says they do. None of them is graded against an approved policy,
because there is not one. They are not re-graded here, and they are not promoted.

**On D-OVERRIDE specifically.** One clause (V2-P8) and one census row (C22) rest on it. Both are
graded **against the CAP ruling**: ceiling semantics ratified, the lost-upsert defect fixed and
pinned, PIN deliberately not built. Neither is graded against PIN, and none of the four LATER-WORK
items (PIN semantics, relief from a moderation ceiling, expiry, two-admin precedence) is counted as
a gap — they are the owner's deferral, recorded as such.

---

## 4. Coverage gaps — clauses the census never counted

**15 of the 66 clauses had no census row.** The census cannot have graded what it never counted, so
each is a finding in its own right, and each becomes a **new** census row in `census-trust.md` §16 —
a new row, never a re-grade.

| # | Clause | Why it was missed | Bucket | New census verdict |
|---|---|---|---|---|
| V2-P2 | Never merge the eight concepts into one score | §12 enumerated the v2 document's **table** and dispositioned `TRV2-01`…`TRV2-12`. It never enumerated the document's prose. This clause is in the "Ownership and existing systems" section. | PARTIAL/INCORRECT | `W` |
| V2-P3 | Preserve current approved behavior | same | CANNOT-VERIFY | `CV` |
| V2-P6 | Request the authoritative scoring policy | same — "Scoring and policy specification gaps" was read as *context* for the CANNOT-VERIFY discussion rather than as a source of clauses | SATISFIED | `C` |
| V2-P7 | Inventory as implementation evidence; do not promote | same | SATISFIED | `C` |
| V2-P9 | Retention values scoped to verification records | same | SATISFIED | `C` |
| V2-P10 | No claim of complete specification or 100 % correctness | same | SATISFIED | `C` |
| V2-P11 | Isolated fixtures spanning eight named classes | "Verification and release" was read as method, not as requirement. It is the only place either spec states a **test-coverage** obligation. | SATISFIED | `C` |
| V2-P12 | Test actual consuming routes and real DB constraints/RLS | same | PARTIAL | `W` |
| V2-P13 | A mocked provider test certifies only the adapter contract | same — and the census **honours** it (TV-6b is `W` for exactly this reason) without ever counting it | SATISFIED | `C` |
| V2-P14 | Preserve report/block, badges, age gates, Safety Center, consumers | same | SATISFIED | `C` |
| V2-P15 | Do not enable providers / backfill / alter scoring / flip flags to close a requirement | same; `TRV2-11` covers only the backfill third | SATISFIED | `C` |
| V2-P16 | Produce the configuration/release steps and the exact remaining owner action | same — §12.7 **produced** the deliverable without counting the clause that demanded it | SATISFIED | `C` |
| VF-G1 | Provider-agnostic: the vendor is a config decision | The Goal paragraph was treated wholly as an abstract of the phases. Most of it is; this sentence is not. | SATISFIED | `C` |
| VF-P0 | The five invariants are *encoded in schema + adapter types* | The five invariants were counted; the sentence that says **how** they must be held was not. `TV-P1`'s cell records the absence as *"Caveat, recorded rather than waived: nothing ENFORCES this"* — a caveat is not a graded requirement. | PARTIAL | `W` |
| VF-6c | Monitor attempts per verified user | It sits in V-6's cost paragraph rather than in a bullet, and the enumeration walked bullets. | MISSING | `NB` |

**Ids in the census.** `check:census-integrity`'s `parseIdCell` recognises neither `V2-Pn` nor
`VF-Gn`, so the fifteen new rows carry `census-trust.md`'s own `TV-` grammar there and this
document's spec-positional numbering here. The map, one line, and it is the only place the two
namings need to be reconciled: `TV-U1`=V2-P2 · `TV-U2`=V2-P3 · `TV-U3`=V2-P6 · `TV-U4`=V2-P7 ·
`TV-U5`=V2-P9 · `TV-U6`=V2-P10 · `TV-U7`=V2-P11 · `TV-U8`=V2-P12 · `TV-U9`=V2-P13 ·
`TV-U10`=V2-P14 · `TV-U11`=V2-P15 · `TV-U12`=V2-P16 · `TV-G1`=VF-G1 · `TV-P0`=VF-P0 ·
`TV-6c`=VF-6c. The tool was **not** changed — it is the integration owner's file, and a census that
renames its rows to fit the tallier is cheaper and more honest than a tallier taught a new grammar
to fit one census.

**Pattern, stated once.** Fourteen of the fifteen gaps are prose obligations sitting outside a table
or a bullet list. The §12 enumeration was structural — it walked the v2 document's table rows and
the plan's `-` bullets — and structural enumeration is exactly blind to a requirement written as a
paragraph. That is the mechanism, and it is worth naming because it will recur on the next spec.

**Effect on the census denominator:** 93 → **108**. Recomputed headline, and it moves the wrong way
for anyone hoping otherwise: CORRECT was 72/93 = 77.4 % and becomes 82/108 = **75.9 %**;
CONSTRUCTED was 86/93 = 92.5 % and becomes 99/108 = **91.7 %**. Ten of the fifteen new rows are `C`,
and the percentage still falls, because the gaps were found by widening the population rather than
by finding new defects. `census-trust.md` §16 carries the arithmetic.

---

## 5. Mapping corrections — §12.6's dispositions, verified against the spec text

§12.6 dispositions `TRV2-01`…`TRV2-12` onto existing rows. Each disposition was re-derived from the
spec sentence rather than from §12.6's summary of it. **No disposition was found wrong.** Two are
incomplete in a way that matters, and one census claim has expired.

| Disposition | Verdict on the disposition | Correction |
|---|---|---|
| TRV2-01 → **A19** "DUPLICATE, same obligation, stricter wording" | **Correct in substance, incomplete in evidence.** | A19's cell is about movement. TRV2-01 also says *"and anonymous contribution"*, and A19 cites nothing for it. The substance holds on evidence A19 never named — `sensingAnonStore.ts` and `sensingCoverageAggregate.ts` contain zero occurrences of `trust`. Separately, TRV2-01's own evidence bar — *"sensor/aggregate fixtures generate zero person Trust effects"* — **has no fixture**. No verdict moves; A19 is `C` for what A19 claims. The missing fixture is §6's first cross-lane request. |
| TRV2-02 → **A18** "DUPLICATE" | **Correct in substance, incomplete in evidence.** | A18's cell establishes that the scoped store is separate. It says nothing about *"no reverse lookup of anonymous contributors"*, which is a different obligation with different evidence: migration 2315's postconditions RAISE on any foreign key and on any identity-shaped column name, asserted at `artifacts/api-server/src/test/sensingAnonStore.test.ts:89#a stronger postcondition RAISEs on ANY foreign key` (43/43 green). Evidence added in §16; verdict unmoved. |
| TRV2-03 → ADDITION | Correct. SX-46 was excluded by §1 as a Safety-surface obligation; TRV2-03 restates it with a Trust-side bar and is admitted once. | — |
| TRV2-04 → nine rows, "DUPLICATE" | Correct. Every link of the chain has a row, and two of them are `NB`. The parent is PARTIAL here precisely because the census's own constituents say so. | — |
| TRV2-05 → SPLIT (+1 for logs) | Correct. Storage is TV-P1/TV-P2/TV-P4; the **logs** criterion had no row and was rightly added. | — |
| TRV2-06 → seven rows, "DUPLICATE" | Correct. | — |
| TRV2-07 → five rows, "DUPLICATE" | Correct. | — |
| TRV2-08 → SPLIT (+1 for reach) | Correct, and the split is the right call: A12 covers the seams that *do* enforce, and the four paths the clause names needed their own row to be `NB`. | — |
| TRV2-09 → SPLIT (+1 for concurrency) | Correct. | — |
| TRV2-10 → SPLIT (+1, `CV`) | Correct, and the `CV` is the right bucket rather than an evasion: the clause's correctness is defined by a policy, the policy is absent, and the census names the decision. | — |
| TRV2-11 → ADDITION | Correct. | — |
| TRV2-12 → "DUPLICATE" onto A18/TV-0e/TV-2c/A9 + passport P45 | **Correct, but the constituents understate it** — and §14.5 already began saying so. TV-0e/TV-2c being `NB` reads as "no badge exists". A badge **does** render, from `profiles.verified` (`LayoverPeopleSection.tsx:99#BadgeCheck`), so the clause is not unbuilt but wrong. Recorded here and in §16; neither `NB` moves, because the *component the plan specifies* genuinely does not exist. | — |

**One census claim has expired and is corrected in §16.** §14.5 states *"`check:doc-citations`
reports **zero** census-trust failures"*. At this tree it reports **two**, both for one citation:
`census-trust.md:738#TV-5b` named a FIVE-LINE RANGE ending at 112 for the `.select("location_country, date_of_birth")` call in `services/media/MediaProjectionService.ts`,
and the whole anchor is on line **109**. Repointed to line 109 in `census-trust.md`, by reading the file rather than by adding an offset. It is a citation
defect, not a verdict defect — the read it names is real, at the line it now names.

---

## 6. What no lane in this tree can close, and who closes it

Separated from the grades because a blocked row and an unbuilt row are different kinds of debt.

**OWNER decisions (8, unchanged from §12.7/§14.8):** D-SCORING, D-REVERSAL, D-DOB,
D-MODACTION-SHAPE, D-MODACTION-FK, D-SUSPENSION-UX, D-BADGE, D-RESTRICTION-REACH, D-PROVIDER.
D-OVERRIDE is **ruled** (CAP now, PIN later behind a flag) and is no longer on this list.

**OWNER deploy action (1):** D-2870-APPLY. Until migration 2870 is applied, `VF-1c` cannot pass and
no user can become ID-verified through the flow at all.

**Cross-lane requests this audit generates (3), none of them mine to write:**

1. **A sensor/aggregate zero-trust fixture** — `TRV2-01` names it as the required evidence and it
   does not exist. A test asserting that the anonymous sensing contribution and coverage-aggregate
   paths emit no `trust_events` row would close the one criterion of TRV2-01 that behaviour alone
   cannot. Owner file: `artifacts/api-server/src/test/` (a new registered suite). Not this lane's
   to write — this lane owns two documents.
2. **`VF-6c`, attempts-per-verified-user monitoring** — blocked on nothing. A count of
   `identity_verifications` rows per user against the verified subset, surfaced anywhere an
   operator reads, closes it. It is the cheapest open clause in either spec.
3. **`V2-P2`, the compatibility-score merge** — `CompatibilityScoreService.ts:87#trustScore:` weights person
   Trust at 8 inside one emitted 0–100 number. Whether that is the merge the v2 document forbids or
   the ranking input A16 already ratifies is a **reading**, and the owner has it. Owner files:
   `services/rentBuddy/CompatibilityScoreService.ts`, `routes/rentABuddyMarketplace.ts` — the
   Rent-a-Buddy lane's, not this one's.

---

## 7. Attribution — separate from compliance, and counted separately

**The rule, applied strictly.** Attribution is *not* evidence of compliance and compliance is *not*
evidence of attribution. In particular: **code that predates these specs' upload to this repository
is not thereby unattributed** — a specification can exist outside a repository, and the upload date
of a file says nothing about what its author was reading. So every clause is marked **UNKNOWN**
unless there is positive evidence, of exactly two kinds:

* **attributable-to-this-spec** — an in-file header, comment or migration note naming *these*
  documents and the section it implements (`verified-foundation-plan.md V-7`, `privacy invariant 5`,
  `TRV2-10`).
* **attributable-elsewhere** — an in-file header naming a *different* spec as its authority.

Nothing else counts. Not a matching filename, not a plausible correspondence, not "it does what the
clause says".

### 7.1 Counts

| | Clauses | Share of 66 |
|---|---|---|
| **Attributable to this spec** | **21** | 31.8 % |
| **Attributable elsewhere** | **4** | 6.1 % |
| **UNKNOWN** | **41** | 62.1 % |

### 7.2 Attributable to this spec — the naming file, per clause

| Clause | Naming evidence |
|---|---|
| VF-P1, VF-P2 (as implemented on the verification path) | `artifacts/api-server/src/services/identityVerification/stripeIdentity.ts:20#Privacy invariants 1 and 2 (` — *"Privacy invariants 1 and 2 (`docs/trust/verified-foundation-plan.md`)"*; and `artifacts/api-server/src/test/verificationProviderNormalization.test.ts:8#PRIVACY. Invariants 1 and 2 of` — *"Invariants 1 and 2 of `docs/trust/verified-foundation-plan.md`"* |
| VF-P4 | `artifacts/api-server/src/test/verificationWebhookProviderUnavailable.test.ts:95#invariant 4 is the mechanism this test depends on` — names *"invariant 4"* as the mechanism it depends on |
| VF-P5 | `artifacts/api-server/src/services/identityVerification/webhookSignature.ts:4#Privacy invariant 5 of` — *"Privacy invariant 5 of `docs/trust/verified-foundation-plan.md`"*; and `verificationWebhookProviderUnavailable.test.ts:5#privacy invariant 5:` |
| VF-1f | `artifacts/api-server/src/test/verificationTrustIdempotency.test.ts:22#The verified-foundation plan's V-1 Trust hook` — *"The verified-foundation plan's V-1 Trust hook is defined per TRANSITION"* |
| VF-1c | `artifacts/api-server/src/migrations/2870_profiles_verification_level_identity_vocabulary.sql:62#the verified-foundation plan distinguishes them by` — names the plan, and `artifacts/api-server/src/migrations/2870_profiles_verification_level_identity_vocabulary.sql:96#TRV2-12.` names the v2 document |
| VF-4c | `artifacts/api-server/src/test/adminUnverifyRevokesIdLevel.test.ts:5#verified-foundation-plan.md V-4:` — *"verified-foundation-plan.md V-4"* |
| VF-7a | `artifacts/api-server/src/services/identityVerification/providerErasure.ts:5#verified-foundation-plan.md V-7 reads:` — *"verified-foundation-plan.md V-7 reads: …"*; `artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts:982#verified-foundation-plan.md V-7:`; `artifacts/api-server/src/test/verificationProviderErasure.test.ts:5#verified-foundation-plan.md V-7:` |
| VF-7b | `artifacts/api-server/src/services/identityVerification/retention.ts:4#verified-foundation-plan.md V-7:` — *"verified-foundation-plan.md V-7"*; `artifacts/api-server/src/lib/trustMaintenanceScheduler.ts:615#verified-foundation plan V-7:`; `artifacts/api-server/src/test/verificationRetention.test.ts:4#verified-foundation-plan.md V-7:` |
| VF-6b, V2-P13 | `artifacts/api-server/src/services/identityVerification/stripeIdentity.ts:12#census-trust TV-6b stays` — *"census-trust TV-6b stays …"*; `providers.ts:22#IMPLEMENTED_PROVIDERS` — *"`readiness.IMPLEMENTED_PROVIDERS` is NOT extended here"* |
| V2-P16 | `artifacts/api-server/src/services/identityVerification/providers.ts:55#V-6 and census-trust TV-6a name it.` — *"one variable for both vendors, exactly as `verified-foundation-plan.md` V-6 and census-trust TV-6a name it"* |
| TRV2-04, TRV2-06 | `artifacts/api-server/src/test/verificationTrustIdempotency.test.ts:24#Trust architecture upgrade v2 states the same bar twice: TRV2-04` — names both by id |
| TRV2-05 | `artifacts/api-server/src/test/verificationWebhookProviderUnavailable.test.ts:7#Trust architecture upgrade v2 TRV2-05` — *"Trust architecture upgrade v2 TRV2-05"* |
| TRV2-10 | `artifacts/api-server/src/test/adminUnverifyRevokesIdLevel.test.ts:6#Trust architecture upgrade v2 TRV2-10`; `artifacts/api-server/src/test/verificationProviderErasure.test.ts:7#Trust architecture upgrade v2 TRV2-10:`; `artifacts/api-server/src/test/trust-integration.test.ts:1994#D-REVERSAL (census-trust TRV2-10)` |
| VF-G1, VF-0b, VF-0d, VF-P0 (the encoded half) | `artifacts/api-server/src/services/identityVerification/types.ts:11#PRIVACY: adapters must never return or persist raw document images,` — *"adapters must never return or persist raw document images, document numbers, or dates of birth … This is an architectural invariant, not a style preference"*, and `artifacts/api-server/src/services/identityVerification/types.ts:6#Every provider (mock, Stripe Identity, Persona, future) implements` on provider-agnosticism. Names the invariants without naming the file; admitted because the wording is the plan's, verbatim in substance. **Marked as the weakest of the 21.** |

### 7.3 Attributable elsewhere — 4

| Clause | Naming evidence | Which spec |
|---|---|---|
| V2-P1 (the canonical-read half) | `artifacts/api-server/src/lib/trustScore.ts:13#§9 requires one internally` — *"§9 requires one internally replayable 0–100 score; §30 requires the server to own it"* | The **Passport** spec, not either Trust document |
| V2-P4 | `artifacts/api-server/src/lib/trustScore.ts:2#the Passport-facing adapter over the ONE canonical trust engine` and `artifacts/api-server/src/lib/trustScore.ts:22#non-stigmatizing factor list (§9/§10)` | Passport |
| TRV2-12 (the non-stigmatizing half, A9) | `artifacts/api-server/src/lib/trustScore.ts:22#non-stigmatizing factor list (§9/§10)` | Passport |
| TRV2-02 / TRV2-01 (the anonymous-store half) | `artifacts/api-server/src/test/sensingAnonStore.test.ts:9#A short-lived anonymous sensing contribution/aggregation store IS allowed` quotes an **owner ruling** on the anonymous sensing store verbatim, and `src/lib/sensingAnonStore.ts` implements it | A **Sensing** owner ruling |

### 7.4 UNKNOWN — 41, and one observation about them

The 41 UNKNOWN clauses are dominated by one fact: **all eight `services/trust/*.ts` service headers
name no specification at all.** `TrustEventService.ts`, `TrustScoreService.ts`, `TrustCapService.ts`,
`TrustRestrictionService.ts`, `TrustPrivacyGuard.ts`, `TrustRecoveryService.ts`,
`TrustAdminService.ts` and `TrustGamingDetectionService.ts` are richly commented and cite nothing.
That is precisely the census's `2.C` ground — "Trust's own code contracts", requirements the surface
placed on itself — and it is why so many TRV2 clauses that *map* onto `C`-rows are attributionally
blank: the rows are real, the code is real, and no file says where the requirement came from.

**This is an observation, not a verdict.** Under §7's rule it produces UNKNOWN and nothing more. It
is explicitly **not** evidence that the code was built without a spec: the eight services predate
both documents' arrival in this repository, and §7's whole point is that this proves nothing either
way. The only thing it supports is a recommendation: a one-line `@spec` header on each of the eight
would convert most of the 41 in one edit, and would make the next compliance pass cheaper than this
one.

---

## 8. Checks run, with exit codes

Run at this tree, from `artifacts/api-server/`.

| Check | Exit | What it says about census-trust |
|---|---|---|
| `node --import tsx/esm src/scripts/checkCensusIntegrity.ts` | **0** before and after | Baseline, before §16: trust parsed at **93** rows, `C=72 W=14 N=6 X=1`, denominator 93, `0 counted where this tool cannot read`. After the fifteen new rows land: **108** rows, `C=82 W=17 N=7 X=2`, denominator 108, `0 counted where this tool cannot read` — tallier and headline agree row for row. |
| `node scripts/check-doc-citations.mjs` | **1** (repo-wide, unchanged) | Red before this pass and red after, for documents this lane does not own. Repo-wide totals before: 2 unresolvable, 125 broken anchors, 263 findings; after: 2, **124**, **253**. The red belongs to `docs/discovery/ROADMAP.md`, `census-compass`, `census-passport` and `census-highlights-memories`. **census-trust's contribution before this pass: 2 findings, 0 unresolvable** — both the same citation — `census-trust.md:738#TV-5b` pointing at a five-line range in `services/media/MediaProjectionService.ts` that ends at 112, for a call whose whole anchor is on line 109. **After the repoint: 0.** This document contributes **0** findings of its own: its 46 code citations are all anchored, and the repo-wide UNANCHORED count sits at **6405 against a ceiling of 6434** with both this file and `census-trust.md` §16 added — the ceiling was not raised. The repo-wide exit stays 1 for the other four documents, which this lane does not own and did not touch. |
| `node scripts/check-citation-symbols.mjs` | **0** | 138 symbol-naming citations judged, 0 naming a symbol the cited file lacks, 44 misplaced against a ceiling of 60. **Zero of the 44 are census-trust's** (`grep -c census-trust` on the output = 0). |

**Test suites re-executed at this tree**, all green, every one cited above:
`trust` 45/45 · `trust-integration` 70/70 · `trustCensusRepairs` 18/18 ·
`trustProfileUnreadableDowngrade` 5/5 · `verificationWebhookSignature` 28/28 ·
`verificationProviderNormalization` 25/25 · `verificationRetention` 7/7 ·
`verificationProviderErasure` 6/6 · `verificationLevelVocabulary` 3/3 ·
`verificationTrustIdempotency` 3/3 · `adminUnverifyRevokesIdLevel` 5/5 ·
`intelScopedTrustApply` 19/19 · `sensingAnonStore` 43/43 · `rentBuddyKycGate` 12/12 ·
`ageGate` 6/6.

**No test was written by this pass**, and that is a scope statement rather than an omission: this
lane owns two documents. Every green claim above rests on a suite that already existed and that was
re-run here rather than quoted. Where a clause needs a test that does not exist — TRV2-01's
sensor/aggregate fixture — the clause is graded PARTIAL and the request is in §6, not decorated into
a pass.

---

## 9. What would turn this document red

* Any of the fifteen suites in §8 failing at this tree — they were run, not cited from memory.
* `IMPLEMENTED_PROVIDERS` at `readiness.ts:53#IMPLEMENTED_PROVIDERS` gaining a non-mock entry: V2-P13 and V2-P15 both
  fall, and VF-6b's `W` becomes a false `C` unless a sandbox transcript lands with it.
* Migration 2870 being applied to a database: VF-1c's PARTIAL is then wrong in the *good* direction
  and must be re-graded, not left.
* A route appearing that calls `adminOverrideScore`: V2-P8 and C22 both need re-grading.
* `sensingAnonStore.ts` or `sensingCoverageAggregate.ts` gaining a `trust` reference: TRV2-01's and
  TRV2-02's substance falls, and — the point of §6's first request — **nothing would fail**.
* A ninth concept appearing in a merged score, or `CompatibilityScoreService`'s `trustScore` weight
  being removed: V2-P2 moves in one direction or the other and this document must say which.
* Either spec file changing: the enumeration is against `7d1f2d498`. The sha256 of both is recorded
  in `docs/specs/upgrades-v2/SOURCE-MANIFEST.json`, which is where a drift would show.
