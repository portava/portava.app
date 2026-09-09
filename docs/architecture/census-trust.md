# Census — Trust (the trust/safety scoring engine)

*Built against branch `claude/portava-continuation-uqta94`, working tree at `507f8427` plus
uncommitted sibling-agent work, on 2026-09-07. Production (`ajrurzioarfkagpuxfnb`) was read
with aggregate queries only; portava-ci (`hwokxgbmezheskbzskfr`) received migrations 2370 and
2371 during this pass. No flag was flipped anywhere.*

| | |
|---|---|
| **Surface** | `services/trust/` (8 services), `lib/trustScore.ts`, `lib/trustMaintenanceScheduler.ts`, `routes/trust-admin.ts`, 9 test files |
| **Spec** | **None.** Trust is one of the eleven surfaces `cross-cutting-obligations.md` names as having neither a spec nor a census. |
| **Denominator** | **52** requirements from three sources (§1): 20 inbound obligations from other specs, 32 contracts Trust's own code asserts. 0 CANNOT-VERIFY. |
| **Measured (before this pass)** | BUILT-AND-CORRECT **38** · BUILT-BUT-WRONG **13** · NOT-BUILT **1** · CANNOT-VERIFY **0** → CONSTRUCTED **98.1 %** · CORRECT **73.1 %** |
| **After this pass** | BUILT-AND-CORRECT **44** · BUILT-BUT-WRONG **8** · NOT-BUILT **0** → CONSTRUCTED **100 %** · CORRECT **84.6 %** |
| **The one finding that outranks the table** | The brief's premise — `trust_engine_enabled` is FALSE in production — is **wrong**. It has been TRUE since 2026-07-17, with `trust_gaming_detection_enabled`. The engine runs; the scheduler fires; the reason 56 of 58 users have no `trust_profiles` row is that the **emitters are nearly silent** (§3). |

---

## 0. Read this first — what was measured, and what the brief got wrong

The task brief stated: *"`trust_engine_enabled` is FALSE in production, so `trust_profiles` is
empty, so the domain-trust builder substitutes a constant 50, so every user is labelled
'Established'."* `census-passport.md:39-41` and `:488-493` say the same, and PR #467's
description repeats it. The first two links of that chain are false in production; the last two
are true for a different reason.

Measured 2026-09-07, production, aggregate reads only:

| Fact | Production | portava-ci |
|---|---|---|
| `feature_flags.trust_engine_enabled` | **TRUE**, `updated_at 2026-07-17 10:13` | no row (→ false) |
| `feature_flags.trust_gaming_detection_enabled` | **TRUE**, same timestamp | no row |
| `feature_flags.events_trust_gates_enabled` | **TRUE** since 2026-06-30 | no row |
| `trust_events` rows | **5** — `pulse_post_created` ×4 (July), `first_event_joined` ×1 (2026-08-16); all `applied`, 0 `pending_review` | 0 |
| `trust_profiles` rows | **2** of 58 profiles, both `reliable_traveler`, created 2026-08-27, `last_recalculated_at` 2026-09-04 06:56 | 0 |
| `trust_caps` / `trust_restrictions` / `trust_reviews` / `trust_admin_actions` | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| `trust_settings` | 1 row, all defaults, `updated_at 2026-07-17` | **0 rows** (defaults in code) |
| `plan_attendance_events` (gaming-scan input) | 0 | 0 |
| `intel_scoped_trust` (migration 2278) | **absent** | present, 0 rows |
| Activity since the flag went on | 32 stamp awards, 7 posts, 18 event RSVPs, 0 bookings, 0 reviews, 0 safe-return sessions, 0 check-ins, 0 accepted message requests | — |

So the causal chain that actually holds is: **the engine is on → the surfaces that generate
evidence emit almost nothing into it → `trust_profiles` stays near-empty → Passport's
`buildDomainTrust` substitutes 50 → "Established" everywhere.** PR #467 fixes the last hop
(§4). Nothing fixes the second hop, and it is not Trust's code — it is the emitters' (§3).

Two consequences for the reader of `census-passport.md`: its P45/P50/P154 verdicts stand (the
constant *is* presented as a measurement), but its stated cause ("nothing writes
`trust_events`", "the engine is dark") is a migration-file reading, not a database reading —
the same misdirection migration 2336's header documents for `media_canonical_enabled`.

---

## 1. The denominator, and how it was built

There is no Trust spec, so no single document states what Trust must do. Three sources were
read, in this order, and each requirement was admitted once, under the source that states it
most directly:

**(a) Inbound obligations** — every clause in another spec that binds Trust's behaviour.
`cross-cutting-obligations.md` §2 and §8 were read first as an index; the demanding spec was
then read at the cited line, and the spec is the authority where the two differ. The Passport
spec is the heaviest consumer (§9:95-111, §10:112-117, §11:118-120, §21:207-221, §30:286,
§34:328, §35:334). Sensing §16:177-183 (SX-47, SX-48) binds Trust; SX-46 is a Safety-surface
obligation (its pipeline ends in `safetyNoticeProducer`, not the trust engine) and is excluded.
Media §25:232-236 and Map §20:216-217 name Trust as the owner of "contributor/evidence
reliability". Layover §23:720 ("verified/trusted requirements for high-risk Buddy interactions")
is Layover consuming A11 and is not counted twice. Rows A1–A20.

**(b) `census-passport.md`** measured Trust through Passport's eyes: P43, P45, P46, P47, P49,
P50, P51, P52, P60, P117, P164, P165 and the §3 "deployment facts". Those rows are **not
re-counted here** — they are Passport's rows. What this census does with them is §2.B: verify
the two it marked wrong (P45, P50) and correct the cause they state.

**(c) Trust's own code contracts** — invariants its module headers, guards, scheduler and tests
already assert. A header sentence such as *"Serious/severe events are queued for admin
review"* (`TrustEventService.ts:11`) is a requirement the surface placed on itself and is
measured as one. Rows C1–C32.

**What was deliberately left out.** Exports with no caller that no header promises
(`getTrustMaintenanceStatus`, `getOpenReviews`, `adminRemoveOverride`, `liftRestrictionsByType`)
are listed in §6 as built-never-invoked, not counted as requirements. Deployment facts (flag
values, seed rows, CI's empty `trust_settings`) bound the rows but are not rows. Per the
sibling-census warning, nothing was parked in CANNOT-VERIFY: every row here was answerable from
code or from an aggregate query, and the two things that genuinely could not be established are
in §7, not in a bucket.

**Verdict grammar.** `C` BUILT-AND-CORRECT · `W` BUILT-BUT-WRONG · `NB` NOT-BUILT ·
`CV` CANNOT-VERIFY. Every `C`/`W` cites a `file:line` opened during this pass. Line numbers are
post-repair for files this pass edited.

---

## 2. The rows

### 2.A — Inbound obligations (20)

| # | Obligation (spec line) | Verdict | Evidence |
|---|---|---|---|
| A1 | Retain the 0–100 Trust Score internally and, where appropriate, visibly (Passport §9:96) | C | `trust_profiles.overall_score` is written by `TrustScoreService.recalculateTrustScore:261-352` and read for display only through `getDisplayTrustScore:365-373`; numeric only to self (`PassportProjectionService.buildTrust:1008-1017`; census-passport P43). |
| A2 | Not a single universal authorization number — domain-specific (§9:96) | C | Nine categories scored and persisted per category (`TrustScoreService.ts:26-30`, `:305-317`); consumers fold them into TABLE 12 domains. Passport's fold substitutes 50 when the row is absent — that is Passport's P45, fixed by #467 (§4). |
| A3 | **Confidence-aware**: the "Trust Confidence" pipeline stage (§9:97); "an 82 with high evidence is not equivalent to an 82 with little evidence" (§10:115) | **NB → C** | Measured: the scorer computes decayed evidence weight for its ramp (`computeCategoryScore:189-215`, `EARN_CONFIDENCE_WEIGHT:160`) and discards it; `trust_profiles` carried no evidence measure, so no consumer *could* be confidence-aware from trust evidence — which is why Passport's confidence band is computed from stamps and trips (P50). Built this pass: `measureEvidence:254-258`, persisted as `evidence_weight`/`evidence_count` (migration 2371; `recalculateTrustScore:299,326-341`), exposed by `getTrustProfile:395-401`. NULL = not measured, 0 = measured empty. Banding into words is left to the presenting surface. |
| A4 | Explainable (§9:96) | C | Append-only ledger with category/delta/severity/source per event (`TrustEventService.recordTrustEvent:235-304`); category labels and top strengths (`TrustPrivacyGuard.ts:68-78, :94-100`); ordered recovery steps (`TrustRecoveryService.ts:36-86`). Passport's *presentation* defect is P45. |
| A5 | The pipeline Evidence → Events → Domain Trust → Confidence → Policy/Eligibility → Projection (§9:97) | C | Structurally end-to-end: events (`recordTrustEvent`), scores (`recalculateTrustScore`), ceilings (`TrustCapService.applyEventCaps:159`), restriction state as policy input (`TrustRestrictionService.getRestrictionState:180`), projection (`TrustPrivacyGuard`). census-passport P46 agrees. Liveness of the first hop is A6. |
| A6 | Live evidence actually reaches the ledger from the surfaces that generate it (the first hop of A5, measured in production) | **W** | Since the flag went on: **32 stamp awards → 0 stamp trust events.** `StampAwardEngine` (`services/passport/StampAwardEngine.ts:644` `awardStamp`, source of all 32 rows: trips 28, posts 2, events 1, postcards 1) emits nothing on award; `STAMP_VERIFIED` (+3 passport_authenticity, `TrustEventService.ts:490`) is declared and emitted by nobody; the only positive passport_authenticity emitter is the v1 `PassportStampService.createStamp:180`, whose triggers (safe-return, geofence, airport) have 0 rows. `passport_authenticity` can therefore only go DOWN on the live pipeline (`stamp_disputed`, `StampAwardEngine.ts:724`). Also: July's 4 posts → 4 `pulse_post_created`; August's 3 non-official posts → **0** (§7). **Owner: Passport (StampAwardEngine) and Posts; not a Trust file.** |
| A7 | Do not expose private report counts, moderation evidence or sensitive safety history to other users — at the API (§10:114) | C | `getSafeTrustSummary:81-121` returns level, labelled strengths, human-readable restrictions, an `onProbation` boolean; `getPublicTrustBadge:131-147` carries no number; `isEventLlmSafe:150-156` drops `reporter_id`/`reviewed_by`. census-passport P49/P164 agree. |
| A8 | The same rule at the **table**: what a user can read of trust data directly through PostgREST (§10:114; `TrustPrivacyGuard.ts:1-10`) | **W → C** | Measured in both databases: all seven trust tables granted **ALL, including TRUNCATE**, to `anon` and `authenticated` (Supabase default privileges; 0043 enabled RLS and revoked nothing). RLS does not police TRUNCATE. `ts_select_all USING (true)` let `anon` read the gaming thresholds. `te_select_own` let the subject read `delta`, `reviewed_by` (the admin) and `metadata.counterparty_user_id`; `tr_select_own` exposed the admin's free-text `reason`. No client reads these tables (zero references outside `artifacts/api-server`) and every server seam runs on the service role (`lib/http.ts:177`, `lib/requireAdmin.ts:125`, `SUPABASE_SERVICE_ROLE_KEY` required by `lib/envValidation.ts:9-12`), so the grants were reachability nobody used. **Migration 2370** revokes ALL from PUBLIC/anon/authenticated/service_role and grants service_role SELECT/INSERT/UPDATE/DELETE, with a postcondition that RAISEs on any residue; applied to CI (verified: only `service_role:DELETE/INSERT/SELECT/UPDATE` remains; 5 policies retained as the safe direction). Production: not applied — owner decision. |
| A9 | Non-stigmatizing copy for low-evidence accounts (§10:116) | C | `LEVEL_LABELS` "New Traveler" (`TrustPrivacyGuard.ts:43-50`), `publicTrustLabel:57-59`; `presentationWord` avoids "low/poor/weak" (Passport's, P51). |
| A10 | Trust changes internally replayable from evidence/events (§10:117) | C | Recalculation reads only applied/confirmed events (`loadEvents:112-125`) and active caps (`loadCaps:128-149`); admin mutations are audited (`TrustAdminService.logAdminAction:23-42`, called at `:87,184,200,214,247,282,311`); `adminOverrideScore` also writes the row directly (`:238-244`) but pins it with a cap that recalculation honours. census-passport P52. |
| A11 | Capabilities derive from Trust Evidence + Domain Policy: `canJoinPublicTrip … canBecomeBuddy` (§11:119) | C | Trust supplies the two inputs: `public_level` (rank) and live restriction state. Passport's `buildOwnerCapabilities:566-577` consumes exactly those (`LEVEL_RANK:553-560`, `ownerRestrictionsFromState:543-550`, `getRestrictionState` at `:1525`). `canProvideVisaBuddyService` is Passport's NB (census-passport). |
| A12 | Authorization is server-side: restrictions are enforced at the action seam, not inferred by the client (§11:120, §30:286) — hosting and messaging | C | `routes/trips.ts:216-230` (canHost, with the degraded-read distinction), `routes/messaging.ts:483`, `lib/calls/callGatewayAdapter.ts:265`, `services/interactionPermissions.ts:325-337` (throws `DegradedPermissionCheckError` rather than mis-labelling a failed check as a restriction). |
| A13 | The same for the other two restriction types the service declares — `private_plan_access`, `location_plan_join` (`TrustRestrictionService.ts:1-9`) | **W** | No route calls `canJoinPrivatePlans` / `canJoinLocationPlans` as a gate (grep: the only consumers of `getRestrictionState` are the four in A12 plus Passport). They reach the client only as `buildOwnerCapabilities` chips (`canJoinPublicTrip`, `canUseCrewLocation`), which §30 says the client must not treat as authorization. An admin applying either restriction changes a chip and blocks nothing. **Owner: Trips / Events / geofence join seams.** |
| A14 | TABLE 22 projections: permitted trust summary (Discovery, Compass), trust eligibility (Trips), completion/reputation (Buddy), restricted purpose-specific context (Safety) (§21:207-221) | C | Trust provides exactly the privacy-safe shapes: badge without number, summary without counts, restriction state as four booleans. All seven consumer variants derive from the one `PassportProjection.buildTrust` (`PassportConsumerProjections.ts:607-613` discovery_card, `:666-672` buddy, `:770-773` trips; telegraph/safety carry no trust at all). census-passport P117. |
| A15 | No numeric score to non-owners; the client must not infer authorization from a displayed score (§30:286) | C | `PublicTrustBadge` has no score field (`TrustPrivacyGuard.ts:124-130`); the number is self-only (`buildTrust:1013-1017`); `DiscoveryCardTrust` omits it by design (`PassportConsumerProjections.ts:191-196, :612`). census-passport P60. |
| A16 | Not a Trust leaderboard (§34:328) | C | No ranking or comparison endpoint in `routes/trust-admin.ts` or `services/trust/`. `rentABuddyMarketplace.ts:452-467` uses the score as one ranking *input*, not a displayed order. census-passport P165. |
| A17 | Other surfaces consume Trust through its canonical read instead of rebuilding it (§35:334; `TrustScoreService.ts:353-364` names `getDisplayTrustScore` as "the single source every Passport surface must read") | **W** | Eleven direct `trust_profiles`/`trust_caps` reads outside `services/trust` (`routes/events.ts:412,802,885,2840`; `routes/rentABuddyMarketplace.ts:452,2191`; `routes/pulse.ts:539`; `compass/CompassProfileService.ts:86`; `compass/CompassTools.ts:828`; `compass/CompassNotificationEngine.ts:450`; `services/ranking/CreatorActivityScoreService.ts:1267`; `compass/CompassActiveUserRewardEngine.ts:192`). **Four substitute 50 for a missing row** (`events.ts:413,806,2841`; `rentABuddyMarketplace.ts:458,463`) — and `events_trust_gates_enabled` is TRUE in production with **22 events carrying `trust_score_min`**, so 56 of 58 users pass or fail those gates on a constant. `CompassNotificationEngine.ts:454` tests `public_level === "suspended"`, a value the CHECK constraint forbids (0043; live constraint verified) — a dead check. Only `CreatorActivityScoreService._readSafetyMultiplier:1264-1285` distinguishes ok/absent/unavailable. **Owners: Events, Rent-a-Buddy, Compass, ranking.** Cross-listed with census-passport P169. |
| A18 | Source/signal reliability is not the same as person Trust Score (Sensing §16:182, SX-47) | C | `lib/intelScopedTrust.ts` keeps a separate scoped store; `lib/intelScopedTrustApply.ts:124-131` bridges only a named subset into person trust with its own deltas. census-sensing S104. Liveness caveat stands: `intel_scoped_trust` is absent in production. |
| A19 | Do not score a user as trustworthy because passive movement looks "normal" (Sensing §16:183, SX-48) | C | The only movement-derived person-trust events are negative (`recordLocationTrustEvent:375-396`: −1/−4/−8); the positive location events (`checkin_verified`, `plan_attended`) require an explicit geofenced action (`routes/geofence.ts:609-614`, `HiddenGemVerificationService.ts:111-116`). census-sensing S105. |
| A20 | Trust owns "contributor / evidence reliability" as a fact distinct from popularity; Media and Map project it, they do not compute it (Media §25:232-236, §35:441; Map §20:216-217) | C | `content_quality`, `community_value`, `guide_accuracy` are engine categories with their own emitters (`HiddenGemContributionService.ts:111`, `HiddenGemVerificationService.ts:227`, `LocalGuideService.ts:126`); ranking reads `overall_score` as a safety multiplier separate from its popularity terms (`CreatorActivityScoreService.ts:1264-1285`); Map reads through the Passport owner (census-map M140–M152). |

### 2.B — What `census-passport.md` measured of Trust: verified, one cause corrected

Not counted here. Checked because the brief asked what it marked wrong.

| Row | Its verdict | Stands? | Correction |
|---|---|---|---|
| P45 — domain-specific/confidence-aware/explainable; the 50-substitution | W | **Yes.** `buildDomainTrust:951-973` still reads a literal 50 in this tree. | Its cause — "`trust_engine_enabled` is seeded false, so nothing writes `trust_events`, `trust_profiles` is empty" — is wrong for production: the flag is TRUE, 5 events exist, 2 profiles exist. The constant reaches 56 of 58 users because the emitters are silent (A6), not because the engine is off. |
| P50 — an 82 with high evidence ≠ 82 with little | W | **Yes.** `buildTrust:985-986` derives confidence from `stats.stamps + stats.trips * 2 + verified`. | Its §5 table says #467 "would flip P45, P50 and P154 from W to C". **#467 does not touch the confidence derivation** (its `buildTrust` hunk replaces only the profile read); P50 stays W after #467. The trust-side prerequisite for fixing it — an evidence measure — did not exist until A3 this pass. |
| P154 — Phase 4 Trust | W | Yes, via P45. | As P45. |
| §3 deployment fact 1 — "the trust engine is dark" | fact | **No.** | See §0. The scheduler is not merely registered; it demonstrably ran on 2026-08-27 (both profile rows created with 0 admin actions) and again on 2026-09-04 (stale refresh at `STALE_DAYS` = 7). |

### 2.C — Trust's own code contracts (32)

| # | Contract (where the code asserts it) | Verdict | Evidence |
|---|---|---|---|
| C1 | Source deduplication within a window (`TrustEventService.ts:4`) | C | `isDuplicate:208-232`; `trust.test.ts:249`. Fails **open** on a read error (returns false) — bounded by C2's fail-closed cap, so a transient error can admit at most one duplicate inside the cap. |
| C2 | Daily/weekly earning caps per event type, from `trust_settings`, per bucket; fail-CLOSED (`:5`, `:99-175`) | C | `countInWindow:99-118` returns `Infinity` on error; `eventTypesForCap:123-131` counts the whole bucket; `DEFAULT_EARNING_CAP:175` closes the previously uncapped types. `trust.test.ts:267-334`. |
| C3 | Severity classification; serious/severe → `pending_review`, excluded from scoring (`:6-7`) | C | `recordTrustEvent:274-276`; `loadEvents:118` reads only applied/confirmed; `trust.test.ts:236`. |
| C4 | Gated by `trust_engine_enabled`; events and scoring share one gate (`:80-86`) | C | `isTrustEnabled:83-94` (fail-closed); imported by the scheduler (`trustMaintenanceScheduler.ts:294`); `trust.test.ts:336`, `trust-integration.test.ts:975`. |
| C5 | "Serious/severe events are queued for admin review" (`:11`) | **W → C** | Measured: only the status was set. The queue an admin reads is `trust_reviews` (`trust-admin.ts:98-127`); no row was written for a pending event; `confirmEvent:82-85` and `dismissEvent:178-181` closed a review "for this event" that never existed; `getPendingEvents:317-332` had no route. `recordAdjudicatedTrustEvent`'s own comment records the gap (`:409-412`). Built: `queueEventForReview:330-362` writes an open `event_review` row keyed by `source_event_id`, non-fatal and logged; `GET /admin/trust/events/pending` (`trust-admin.ts:138-147`). Pinned by `trustCensusRepairs.test.ts` §1–§2. Production impact today: none (0 pending events); the next one will be visible. |
| C6 | Never auto-bans (`:11`) | C | `applyRestriction` has exactly one non-test caller, `adminApplyRestriction` (`TrustAdminService.ts:197`), reached only from the admin route. |
| C7 | The counterpart of an event is recorded explicitly in `metadata[counterparty_user_id]`, never inferred from `source_id` (`:32-45`) | C | `recordTrustEvent:249-252`; `TrustGamingDetectionService.readCounterparty:26-34`; `trustMutualRings.test.ts`. |
| C8 | Nine category scores + weighted overall; exponential decay; cap ceilings; public level; persist to `trust_profiles` (`TrustScoreService.ts:1-10`) | C | `recalculateTrustScore:261-352`; `scoreToLevel:217-224`; `trust.test.ts:350-398`. |
| C9 | Slow to earn, immediate to lose — the ramp applies only to positive movement (`:162-188`) | C | `computeCategoryScore:189-215`; `trustAsymmetryAndMaintenance.test.ts` pins the asymmetry and the worked example (56, not 80). |
| C10 | `getDisplayTrustScore` is THE display number; no second engine (`:353-364`; `lib/trustScore.ts:1-25`) | C | `lib/trustScore.ts:124-149` delegates; `PassportProjectionService.ts:1015` and `routes/rentABuddy.ts:1237` read through it; `passportTrustConsistency.test.ts`. |
| C11 | `getTrustProfile` "loads the current profile" (`:375`) — and a failed read is not a missing profile | **W** | `:376-410` never destructures `error`; `null` means both. Five readers collapse an unreachable engine into "New Traveler"/`score: null`: `getDisplayTrustScore:365`, `getSafeTrustSummary:91`, `getPublicTrustBadge:136`, `getRecoveryStatus:89`, `computeTrustScore:131`. **PR #467 adds `getTrustProfileResult()` (ok/absent/unavailable) and switches ONE reader — Passport's domain builder.** Not fixed here: a second error-aware read in the same file would duplicate #467's hunk. Recommended as a #467 follow-up (§4). |
| C12 | Caps: create, enforce as ceilings, expire on schedule (`TrustCapService.ts:1-6`) | C | `TrustCapService.ts:35#createCap`, the ceiling applied at `TrustScoreService.ts:318#caps`, `TrustCapService.ts:81#expireOldCaps` driven by the scheduler (`lib/trustMaintenanceScheduler.ts:597#expireOldCaps`); `trust.test.ts:400-475`. |
| C13 | `applyEventCaps` keys on the event vocabulary the emitters actually write (`:166-180`) | **W → C** | `coordinate_jump` named a type nobody emits; `recordLocationTrustEvent:375-396` writes `gps_coordinate_jump`. Corrected (`:186`). Residual, **owner decision**: `plan_no_show` and `fake_gps_confirmed` have ceilings and no emitter; `content_removed` and `message_report_confirmed` were wired by the emitter pass. **Correction (2026-09-07, second pass):** this row cited `event_host_no_show (serious, −15, routes/events.ts:3473)` as an emitter. Nothing emits it — `:3473` is the attendance route (`event_attendance_confirmed`), and the no-show emitter at `:3575` writes `event_no_show` (−5 moderate). Which serious findings deserve a ceiling is policy, listed in §5; the per-type evidence is in [trust-unproduced-vocabulary.md](trust-unproduced-vocabulary.md). |
| C14 | Every cap a moderation finding created is lifted when the finding is reversed (`:93-108`) | C | `liftCapsBySourceEvents:110-128`; wired through `revokeModerationTrustConsequences:112-155` from `routes/admin.ts:1589`. |
| C15 | `getRestrictionState()` is the enforcement seam — "never query trust_restrictions directly in route code" (`TrustRestrictionService.ts:175-179`) | **W** | `routes/admin.ts:1319-1322` selects `trust_restrictions` directly for the admin user view (read-only, includes `reason`). Low impact; **owner: admin route.** |
| C16 | Degraded reads are labelled: fail-open (table missing) vs fail-closed (query error), and callers must never show a restriction message for a failed check (`:50-80`) | C | `getRestrictionState:180-250`; consumers honour it (`routes/trips.ts:218-227`, `interactionPermissions.ts:326-337`); `trust.test.ts:906-1043`. |
| C17 | `expireOldRestrictions` — "call from cleanup job" (`:264`) | **W → C** | Had no caller. Enforcement already ignored expired rows, so nothing was over-enforced, but the row stayed `lifted_at IS NULL` and every admin view listed a lapsed restriction as active. Now step 1b of the pass (`trustMaintenanceScheduler.ts:308-318`) and the function reads its `error` (`:264-287`). `trustCensusRepairs.test.ts` §4. |
| C18 | Recovery status: probation, lowest category, ordered steps, `overallProgress` "0–100 % toward 50" (`TrustRecoveryService.ts:1-8`, `:33`) | **W** | Steps and probation are correct (`trust.test.ts:726-770`). But a user with **no profile** is returned `overallProgress: 50` (`:107`) — a constant where a measurement belongs, the same shape as P45 in miniature. Unconsumed today (`getSafeTrustSummary` reads only `onProbation` and `suggestedSteps`), and PR #455 is about to surface recovery to the owner. Left as W: the honest value is `null`, which changes the field's type, and #455 is the PR editing the consumer. |
| C19 | Probation ends when `probation_ends_at` passes (`trustMaintenanceScheduler.ts:26-27`) | C | `clearExpiredProbation:138-155`; `trust-integration.test.ts:819`. |
| C20 | Reporter identity never exposed; raw deltas/internal scores not returned; restrictions human-readable; pending_review invisible to the subject — at the API (`TrustPrivacyGuard.ts:1-10`) | C | `getSafeTrustSummary:81-121`, `RESTRICTION_MESSAGES:61-66`, `isEventLlmSafe:150-156`; `trust.test.ts:660-725`. The table-level contradiction was A8. |
| C21 | Every admin write creates a `trust_admin_actions` row (`TrustAdminService.ts:1-6`) | C | `logAdminAction` at `:87,184,200,214,247,282,311`; route-level inserts at `trust-admin.ts:323-330` and `:426-435`; `trustAdminAuditInsertSchemaDrift.test.ts` pins the columns. |
| C22 | `adminOverrideScore` overrides a category score (`:218`) | **W** | It creates a *ceiling* (`:230-235`) and writes the row once (`:239-243`), then `recalculateTrustScore:246` recomputes from events — so an override ABOVE the event-derived score does not hold; only downward overrides stick. `trust_caps` has no floor. Unwired to any route, so no live effect. Whether "override" means pin or cap is an **owner decision** (§5). |
| C23 | Gaming detection never auto-penalises; it only opens `gaming_suspected` reviews (`TrustGamingDetectionService.ts:5`) | C | `createGamingReview:68-94` is the only write; dedup on an open review; `trust-integration.test.ts:763`. |
| C24 | Three detectors, gated by `trust_gaming_detection_enabled`, thresholds from `trust_settings` (`:7-10`) | C | `runGamingDetectionScan:299-316`; `isGamingDetectionEnabled:55-66` fail-closed; check-in vocabulary matches the writer (`CHECKIN_CLUSTER_EVENT_TYPES:114`, `routes/geofence.ts:610`). `trust.test.ts:771-826`, `trustAttendanceVocabulary.test.ts`, `trustMutualRings.test.ts`. **Liveness (§3):** flag ON in production; runs every pass; every input is empty. |
| C25 | The maintenance scheduler is registered and fires: decay refresh, cap expiry, probation, gaming scan; fail-closed on the flag (`trustMaintenanceScheduler.ts:1-44`) | C | Registered unconditionally at `index.ts:264`; `startTrustMaintenanceScheduler:414-432` (startup delay 120 s, then every 6 h). **Fires in production**: both `trust_profiles` rows were created 2026-08-27 with `trust_admin_actions` = 0 (only the scheduler creates a row for a user with events and no profile, `findDirtyUsers:168-233`), and both were refreshed 2026-09-04 06:56 — one `STALE_DAYS` after — the `findStaleUsers:240-259` path observed working. Tested at `trustAsymmetryAndMaintenance.test.ts:280-400`, `trust-integration.test.ts:974-1070`. |
| C26 | Every `/admin/trust/*` route is admin-guarded (`routes/trust-admin.ts:2`) | C | `requireAdmin` first in every handler (`:99,139,152,200,221,248,281,309,342,364,385,402`); `trust-integration.test.ts:285-308`; `check:route-auth-gate` exit 0. |
| C27 | `PUT /admin/trust/settings/:key` accepts only known keys (`:83`) and values the engine can compute with | **W → C** | Keys were allow-listed; the value was `z.number()` — any finite number. `decay_half_life_days = 0` makes every decay weight 2^-∞ = 0 and every score 50; a negative half-life weights older events more; a weight of 5 lets one category exceed the scale; a fraction in an INTEGER column is a 500. Built: `SETTING_BOUNDS:69-81` (structural ranges only — the numbers inside them are the operator's), `trustSettingRejection:86-94`, applied at `:414-415`. `trustCensusRepairs.test.ts` §5. |
| C28 | A settings change recalculates every scored user (`:437-450`) | C | `setImmediate` chain over `trust_profiles` (`:437-450`), bounded at `limit(1000)`; correct at the measured scale (2 rows). Note the bound. |
| C29 | Audit inserts match the live `trust_admin_actions` columns (`trustAdminAuditInsertSchemaDrift.test.ts`) | C | Suite passes; `check:write-path-columns` could not run here (live-DB guard; §7). |
| C30 | The 19 unguarded `void recordTrustEvent(...)` sites cannot crash the process (`index.ts:60-80`) | C | `process.on("unhandledRejection")` backstop logs and continues (`index.ts:77-83`). |
| C31 | `lib/trustScore.ts` is an adapter, never a second computation (`:1-25`) | C | `computeTrustScore:124-149` reads only `getTrustProfile` + `getDisplayTrustScore` + `publicTrustLabel`; `passportTrustConsistency.test.ts`. |
| C32 | `TRUST_EVENT_TYPES` is "all event types by source system" (`TrustEventService.ts:458`) — the declared vocabulary is what emitters emit | **W** | One emitter spreads a constant (`routes/verification.ts:76`); five read a constant's fields (`routes/admin.ts:1495`, `StampAwardEngine.ts:723`, `HiddenGemModerationService.ts:133`, `HiddenGemVerificationService.ts:254`); **every other emitter hand-writes its own type, delta and severity** (24 sites across `routes/events.ts`, `routes/rentABuddy.ts`, `routes/messaging.ts`, `routes/posts.ts`, `routes/geofence.ts`, `services/hiddenGems/*`, `services/safeReturn/*`). Declared and emitted by nothing: `STAMP_VERIFIED`, `FAKE_GPS_CONFIRMED`, `CONTENT_REMOVED`, `MESSAGE_REPORT_CONFIRMED`, `PLAN_NO_SHOW`, `PLAN_LATE_CANCEL`, `HOST_POSITIVE_REVIEW`, `HOST_NEGATIVE_REVIEW`, `RESPONDED_PROMPTLY`, `MUTUAL_REPORT`, `TRAVEL_CIRCLE_JOIN`, `EVENT_HOST_CANCELLED`, `EVENT_HOST_NO_SHOW` (the emitter writes `event_no_show` at moderate instead), `EVENT_POSITIVE_REVIEW`, `EVENT_NEGATIVE_REVIEW`. The constant is a wish-list, not a contract. Consolidating it is emitter-side work (not Trust files) and which types survive is an **owner decision**. **Since measured:** five of these were wired (`EVENT_HOST_CANCELLED`, `EVENT_POSITIVE_REVIEW`, `EVENT_NEGATIVE_REVIEW`, `CONTENT_REMOVED`, `MESSAGE_REPORT_CONFIRMED`; `trustEventCoverage.test.ts` pins the set). The remaining **13** are classified one by one, with the triggering action opened rather than grepped, in [trust-unproduced-vocabulary.md](trust-unproduced-vocabulary.md): 4 `missing_real_emitter` (`stamp_verified`, `plan_no_show`, `host_positive_review`, `host_negative_review`), 6 `owner_decision`, 2 `reserved_future_event`, 1 `unsafe_to_emit`. The earlier claim that nine had "no triggering action anywhere" is wrong for three and partly wrong for four. |

---

## 3. For each Trust service: does it run, and do its inputs have rows in production?

| Service | Runs? | Invoked by | Inputs in production (2026-09-07) | Verdict |
|---|---|---|---|---|
| **TrustEventService** | Yes — flag ON | 30 emitter sites (§2 C32) + `intelScopedTrustApply` | Writes `trust_events`: **5 rows in 52 days** against 32 stamp awards, 7 posts, 18 RSVPs. `trust_settings` 1 row. | Runs; **starved**. The emitters are the defect, not the service (A6). |
| **TrustScoreService** | Yes | Scheduler every 6 h; admin routes | `trust_events` 5, `trust_caps` 0, `trust_settings` 1 | Runs and persists (2 profiles, refreshed 2026-09-04). Evidence columns (2371) not in production → the second-statement write logs and skips, score persist unaffected. |
| **TrustMaintenanceScheduler** | **Yes — observed** | `index.ts:264`, unconditional | as above | Created both profiles 2026-08-27, refreshed them 2026-09-04 (`STALE_DAYS` 7). Now also expires restrictions. |
| **TrustCapService** | Built, wired, **never invoked in production** | `confirmEvent` (needs a pending event + an admin confirm: 0 admin actions ever), `adminOverrideScore` (no route), scheduler `expireOldCaps` (runs; 0 rows to expire) | `trust_caps` **0** | The ceiling mechanism — "what makes a severe finding survive a glowing record" — has never fired. It cannot until a serious event exists AND an admin confirms it; C5 makes the queue visible so that can happen. |
| **TrustRestrictionService** | Read side: **yes, on every trip create, message, call** (A12). Write side: **never** | Reads: 5 seams. Writes: admin route only | `trust_restrictions` **0** | Enforcement runs on an empty table — correct and vacuous. No restriction has ever been applied. |
| **TrustRecoveryService** | Yes | `getSafeTrustSummary` (every non-public Passport view), `getPublicTrustBadge` path | `trust_profiles` 2, `trust_caps` 0 | Runs; returns empty steps for 56 users and `overallProgress: 50` for them (C18). |
| **TrustGamingDetectionService** | **Yes, every pass** — flag ON | Scheduler step 4 | `plan_attendance_events` **0** (no geofence check-in has ever happened: `plan_checkins` 0), counterparty-bearing `trust_events` **0** (0 bookings, 0 reviews, 0 accepted requests), `trust_events` 5 | Runs; all three detectors examine nothing. Not writerless — each input has a live writer that has never been exercised. `trust_reviews` 0. |
| **TrustPrivacyGuard** | Yes | Every Passport trust projection; `lib/trustScore.ts` | `trust_profiles` 2 | Runs; 56 of 58 users read "New Traveler" (honest) with `confidence` from travel volume (P50, Passport's). |
| **TrustAdminService** | Built; **never invoked in production** | `routes/trust-admin.ts`; `routes/admin.ts:1589` | `trust_admin_actions` **0** | No admin has ever used a trust admin route. `adminOverrideScore`/`adminRemoveOverride`/`getOpenReviews` have no route at all. |

**The writerless-read check, done properly.** Per `checkWriterlessReads.ts:39-41` a `from("x")`
grep is not attribution. Every trust table was checked for writers by reading the writer code and
by the production row counts above: each table HAS a live writer; four of them (`trust_caps`,
`trust_restrictions`, `trust_reviews`, `trust_admin_actions`) have writers that no production
event has ever reached. That is different from the intel spine (writer silently failing) and
different from a decoy (no writer): it is machinery whose trigger conditions have not occurred.
`plan_attendance_events` is the one input whose writer (`routes/geofence.ts:205`) depends on a
feature nobody has used (0 check-ins).

---

## 4. PR #467 — verdict: **correct as far as it goes; incomplete; recommend merge, with three follow-ups**

Read in full: 4 files, +332/−21, base `main@1eb3be1d`, head `9565cd6d`, `mergeable_state: clean`.

**What it does.** `PassportProjectionService.buildDomainTrust` gains an `absence` argument;
when the profile is absent or unreadable every domain is `applicable: false` with
"Not yet rated" / "Unavailable"; `mean()` returns `null` for an empty set; a partial profile rates
only the domains whose categories exist. `TrustScoreService` gains an additive
`getTrustProfileResult()` returning `ok | absent | unavailable`; `buildTrust` calls it. A new
suite covers the three states, the partial case, and asserts a real profile still projects words.

**Correctness.** The diff is sound. Checked: `wordOrUnrated`, the early-return for
`absence !== "none" || overallScore === null`, `dom()` setting `applicable: score !== null`, the
Buddy branch. Both hunks apply to this branch's files as they stand (`buildTrust:991-993` and
`TrustScoreService.ts` end-of-file are byte-identical to #467's pre-image). One cosmetic gap: for
an ABSENT profile a non-buddy's Buddy row reads "Not yet rated" rather than "Not applicable"
(the early return does not consult `isBuddy`); the PR's own Buddy test asserts only
`applicable === false`, so it passes.

**Coverage — does it reach every consumer?** **Yes, by construction, for the defect it targets.**
There is one `buildTrust`; every consumer variant is projected from the one `PassportProjection`
(`PassportConsumerProjections.buildConsumerProjection`). So the seven call sites —
`routes/trips.ts:467`, `routes/rentABuddy.ts:1248`, `services/passport/EventPassportService.ts:423`,
`routes/discoverySearch.ts:2087`, `routes/compass.ts:4225`, `routes/telegraph.ts:370`,
`routes/safeReturn.ts:852` — all inherit the fix. But note what each actually ships:

| Consumer | Variant | Carries `domains`? | Reached by the constant-50 "Established" defect? | Changed by #467? |
|---|---|---|---|---|
| Trips (`trips.ts:467`) | `trips` → `trustDomains` (`:770-773`) | **Yes** | **Yes** | **Yes** |
| Full Passport / TrustScreen | aggregate | Yes | Yes | Yes |
| Discovery search, Compass person card | `discovery_card` (`:607-613`) | No — label/publicLevel/confidence/strengths only | No (label is the honest "New Traveler") | Only `confidence` (P50) is wrong here, and #467 leaves it |
| Rent-a-Buddy card | `buddy` (`:666-672`) + `computeTrustScore` (`rentABuddy.ts:1237`) | No | No (`score: null`, "New Traveler") | As discovery_card |
| Telegraph header, Safety | `telegraph`, `safety` | **No trust field at all** | No | No |

So the lead "four new endpoints ship trust through `discovery_card`" is **false on measurement**:
two do (Discovery search, Compass), two ship no trust, and `discovery_card` never carried the
domains the defect lives in.

**Incomplete — three things #467 does not fix, none of which are reasons to hold it:**

1. **The confidence band (P50).** `buildTrust:985-986` still derives `confidence` from stamps and
   trips. `census-passport.md:597` claims #467 flips P50; it does not. This pass built the
   trust-side prerequisite (A3, migration 2371, `evidenceWeight`/`evidenceCount` on
   `TrustScoreResult`); the Passport-side switch is a one-line consumer change that should
   follow #467, in `services/passport/` (not edited here).
2. **The label path (C11).** `getSafeTrustSummary:91` and `getPublicTrustBadge:136` still
   collapse an unreadable engine into `new_traveler`, so a highly-trusted user whose read fails
   is told "New Traveler". #467's `getTrustProfileResult` is the right primitive; the four other
   `getTrustProfile` readers should adopt it once #467 lands (they were not touched here to avoid
   a second implementation in the same file).
3. **Non-Passport consumers (A17).** The four `?? 50` substitutions in `routes/events.ts` and
   `routes/rentABuddyMarketplace.ts` are outside #467's scope and are live today behind
   `events_trust_gates_enabled = TRUE` with 22 gated events.

**Merge burden.** #467 edits the `"test"` line of `artifacts/api-server/package.json` (adds
`passportTrustNotFabricated.test.ts`). That line has moved on this branch (this pass alone added
`trustCensusRepairs.test.ts`), so the package.json hunk will conflict; the two source hunks and
the new test file will not. The helper it imports (`test/helpers/fakePassportDb.ts`) exists here.

**Recommendation to the owner:** merge #467; then, in this order, (i) switch `buildTrust`'s
confidence to `profile.evidenceWeight` once 2371 is applied where it runs, (ii) move the four
remaining `getTrustProfile` readers to `getTrustProfileResult`, (iii) decide A17.

---

## 5. Owner decisions — listed as decisions, not made

1. **Apply 2370 to production?** It closes TRUNCATE-for-anon on the safety ledger and the anon
   read of gaming thresholds; it changes nothing the API does. Recommended; not done.
2. **Apply 2371 to production?** Adds two nullable columns nobody reads yet. Until applied, every
   recalculation logs one WARN and skips the evidence write. Recommended with (i) in §4.
3. **Which serious/severe event types earn a ceiling** (C13 residual): `event_host_no_show`
   (serious, declared, emitted by nothing) would get none if it were ever confirmed; `plan_no_show`
   and `fake_gps_confirmed` have ceilings for events nobody emits.
4. **Whether "score override" means pin or cap** (C22) — `trust_caps` has no floor.
5. **The event vocabulary** (C32): prune `TRUST_EVENT_TYPES` to what is emitted, or make the
   emitters use it. Either is a deltas-and-severities decision.
6. **Whether `trust_settings` should be readable by authenticated users at all** — 2370 removes
   the grant; the `USING (true)` policy is retained as inert. If the mobile app ever needs the
   weights, that is a new read path, not a re-grant.
7. **Enforcement of `private_plan_access` / `location_plan_join`** (A13): which join seams gate
   on them is a Trips/Events product decision.
8. **The four `?? 50` consumers** (A17): whether a user with no profile passes a
   `trust_score_min` gate is the Events owner's call; today they do, on a constant.
9. **Whether stamp awards should emit trust evidence** (A6): `STAMP_VERIFIED` exists at +3; the
   live award engine emits nothing. Passport-owned; the exact call is written out in
   [trust-unproduced-vocabulary.md](trust-unproduced-vocabulary.md) §3.2.
10. **The six unproduced types that are product questions, not missing code** (from the
    per-type classification, same doc §2): which string wins for the appeal counter-event
    (`appeal_approved` vs the declared `appeal_approved_reversal`; recommended: declared) and
    for the attendee no-show (`event_no_show` moderate vs declared `event_attendee_no_show`
    minor — severity has **no** routing consequence today; the 48 h dedup does); whether an
    upheld-but-not-removed post report charges `pulse_post_reported` and how it defers to
    `content_removed`; which response, on which surface, at which threshold is "prompt"; whether
    the Locate-Friends circle is the "travel circle" and who its join credits; whether an
    admin-confirmed impossible-speed finding **is** `fake_gps_confirmed` (and if so, that
    `confirmEvent` must not also apply the `gps_*` cap).
11. **Two events surfaces cannot reach `started`.** No code path sets `events.state='started'`
    (every writer enumerated in the same doc, row 2), so host no-show marking, attendance
    confirmation and completion are unreachable through the API for any event created through
    it; 96 of 97 open events in production are past their start. Events-owned; it is the reason
    the *existing* `event_no_show` emitter has never fired, not merely a vocabulary mismatch.

---

## 6. What this pass built, and the proof

All in Trust-owned files. Nothing a user sees changes; no flag was flipped or added.

| Repair | Files (`file:line`) | Test | Hand-revert result |
|---|---|---|---|
| C5 — pending events reach the review queue; `GET /admin/trust/events/pending` | `services/trust/TrustEventService.ts:295-298, 330-362`; `routes/trust-admin.ts:129-147` | `trustCensusRepairs.test.ts` §1, §2 | R1 (skip queue insert): **16/18, fail 2**. R2 (route removed): **16/18, fail 2**. |
| C13 — cap map keys on `gps_coordinate_jump` | `services/trust/TrustCapService.ts:170-186` | §3 | R3: **17/18, fail 1** |
| C17 — scheduler expires restrictions; `expireOldRestrictions` reads `error` | `lib/trustMaintenanceScheduler.ts:53, 95, 268, 308-318, 367, 387, 394`; `services/trust/TrustRestrictionService.ts:250-287` | §4 | R4a (step skipped): **17/18, fail 1**. R4b (error ignored): **17/18, fail 1**. |
| C27 — settings bounds | `routes/trust-admin.ts:43-94, 414-415` | §5 | R5 (bounds bypassed): **16/18, fail 2** |
| A3 — evidence behind the score (migration 2371) | `services/trust/TrustScoreService.ts:233-258, 299, 326-341, 348-349, 390-401`; `migrations/2371_trust_profiles_evidence.sql`; `db/rollback/2026-09-07-2371-trust-profiles-evidence-rollback.sql` | §6 | R6a (evidence not persisted): **16/18, fail 2**. R6b (not exposed): **17/18, fail 1**. |
| A8 — trust tables service-role-only (migration 2370) | `migrations/2370_trust_tables_privileges.sql`; `db/rollback/2026-09-07-2370-trust-tables-privileges-rollback.sql` | §7 | R7 (TRUNCATE re-granted): **17/18, fail 1** |
| Cross-emitter double-charge (second pass, classification lane) — one report reaching both `hide-content` and `resolve {upheld}`, either order; two reports on one post; a message report hidden then upheld | `src/test/trustEmitterWiring.test.ts` §6 (4 tests; suite 24 → 28) | `trustEmitterWiring.test.ts` §6 | R1 (resolve emits for post targets too — the shape of a naive `pulse_post_reported` wiring, one-line edit to `routes/admin.ts:2124`, restored): **25/28, fail 3**. R3 (`isDuplicate` always `"new"`, Trust-owned): **23/28, fail 5**. Baseline and final 28/28, exit 0. |

Every revert was made against a pristine copy, the suite run under `timeout 300`, the file
restored and the restore verified with `diff -q` (all seven files: "restored"). Baseline and
final: 18/18, exit 0.

**Applied to portava-ci** (`supabase_migrations.schema_migrations`: `20260907103227
2370_trust_tables_privileges`, `20260907103233 2371_trust_profiles_evidence`). Verified after
apply: grants on all seven tables are exactly `service_role: DELETE/INSERT/SELECT/UPDATE`;
5 policies retained; `evidence_weight numeric NULL`, `evidence_count integer NULL`. **Not applied
to production.**

**Gates.** `pnpm typecheck` exit 0. `pnpm typecheck:tests` 880 diagnostics / 118 files,
baseline unchanged. `check:test-registration` exit 0 (752 registered). `check:migration-prefixes`,
`silent-supabase-writes`, `not-null-writes`, `route-auth-gate`, `async-handlers`,
`schema-references`, `enum-literals`, `writerless-reads`, `flag-polarity`, `test-runner-flags`:
all exit 0. `check:write-path-columns` and `check:migration-ledger` refuse to run here (live-DB
guard, no `KNOWN_PROD_PROJECT_REF`) — environmental, not a finding. `check:guard-coverage` exit 1
on `src/test/tripCrewRlsMembershipConvergence.test.ts`, a sibling's Trips file, not touched here.

**Full suite:** **pending.** Four sibling agents were writing to this tree while this pass ran, one of them mid-hand-revert, so a full-suite result taken here could not be attributed; the coordinator runs the one authoritative suite once the tree is quiescent and records it. Every suite that covers the edited files was run directly and judged by exit code: `trustCensusRepairs.test.ts` exit 0; `trust.test.ts`, `trust-integration.test.ts`, `trustAsymmetryAndMaintenance.test.ts`, `trustAttendanceVocabulary.test.ts`, `trustMutualRings.test.ts`, `trustAdminAuditInsertSchemaDrift.test.ts`, `passportTrustConsistency.test.ts`, `intelScopedTrustApply.test.ts`, `passportProjection.test.ts`, `passportConsumerAdoption.test.ts` together exit 0.

**Built, wired to nothing (not counted, listed so nobody rediscovers them):**
`TrustAdminService.adminOverrideScore` / `adminRemoveOverride` / `getOpenReviews`,
`TrustRestrictionService.liftRestrictionsByType`, `trustMaintenanceScheduler.getTrustMaintenanceStatus`.

---

## 7. What could not be established

1. **Why August's three non-official posts produced no `pulse_post_created` event when July's
   four did.** `routes/posts.ts:1010-1019` is reached for every post created through that route
   (no early return between the insert at `:611` and the emit; the response is sent at `:940`);
   the only other `posts` inserters are `routes/hiddenGems.ts:1026` (gem posts; all six gems are
   from June) and `routes/adminPortavaPosts.ts:148` (official; correctly silent). Production's
   `trust_events` has no NOT NULL trap and no trigger (checked). Either a create path this grep
   did not find, or a write rejected and logged by the `unhandledRejection` backstop. **The API
   logs for August 2026 settle it; the database cannot.** Recorded under A6 as part of the
   emitter finding, not as a separate CANNOT-VERIFY row, because A6 is already `W` on the
   stamp evidence alone.
2. **Which commit production is running.** The scheduler's behaviour proves the deployed build
   includes `lib/trustMaintenanceScheduler.ts`; it does not prove it includes anything later.
   Nothing here depends on that.

---

## 8. Every lead in the brief, measured

| Lead | Result |
|---|---|
| `trust_engine_enabled` is FALSE in production | **FALSE.** TRUE since 2026-07-17 (§0). |
| `trust_profiles` is empty | **FALSE.** 2 rows; 56 of 58 users have none. |
| Four new Passport endpoints (`cd3bd326`) ship trust through `discovery_card` | **FALSE.** `cd3bd326` is a one-line test edit. Two of the four (Discovery search, Compass) use `discovery_card`; Telegraph and Safety variants carry no trust. `discovery_card` never carried domains, so the "Established" defect never reached it (§4). |
| `trips.ts` / `rentABuddy.ts` inherit the constant-50 defect | Trips: **TRUE** (`trustDomains`). Rent-a-Buddy: **FALSE** — the buddy variant has no domains and `computeTrustScore` yields `score: null` / "New Traveler". |
| Writerless-read pattern in a Trust service | **Not found.** Every table has a live writer; four have writers no production event has reached (§3). |
| Gaming / Cap / Restriction / Recovery built but never invoked | Gaming: **runs every 6 h on empty inputs.** Cap: **never invoked** (needs an admin confirm; 0 ever). Restriction: **read every request, never written.** Recovery: runs. (§3) |
| `trustMaintenanceScheduler` registered and fires | **TRUE, with production evidence** (§2 C25). |
| (second pass) Nine of the 13 unproduced types have "no triggering action anywhere" | **FALSE for three** (`plan_no_show` — owner override `routes/geofence.ts:872`; `host_positive_review` / `host_negative_review` — `routes/reviews.ts:199`), **partly for four** (raw signal, no adjudication), **TRUE for two** (`event_host_no_show`, `plan_late_cancel`). [trust-unproduced-vocabulary.md](trust-unproduced-vocabulary.md) §0. |
| (second pass) `plan_attendance_events` is read/written by four files | `routes/geofence.ts:154` writes; `routes/admin.ts:607` and `TrustGamingDetectionService.ts:130` read; `lib/crowdFlowProducer.ts` names it in comments only (`:152`, `:361`). 0 rows in production. |

---

*The full-suite verdict for this branch is recorded by the coordinator, not here.*


---

## 10. Re-census — 2026-09-08, HEAD `7bca4b0d`

Paths relative to `artifacts/api-server/src/`. Same denominator (52), same rule,
same buckets. **Every row below was re-derived by opening the file at this
commit.** Rows not restated keep the verdict the body left them with.

| Field | Value |
| --- | --- |
| `head_commit` | `42aeac38` — RE-DECLARED 2026-09-09 from `7bca4b0d0e19d29ea0a96982f74b35d26402fa52`, the working-tree commit this addendum was measured at. The move is a measurement, not a judgement: `git diff --name-only 7bca4b0d 42aeac38` over this census's 15 scoped paths returns **0 files**, so all 52 verdicts are exactly as true at one as at the other. It was necessary because `7bca4b0d` is PRE-SQUASH — this repository squash-merges, so it is an ancestor of nothing, is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). `42aeac38` is #476's squash, where this document's content reached `main`. |
| `generated_at` | 2026-09-08 |
| **Denominator (testable requirements)** | **52** |
| Scanned | `services/trust/` (8 services), `lib/trustScore.ts`, `lib/trustMaintenanceScheduler.ts`, `routes/trust-admin.ts`, plus every file the eight open rows named: `routes/events.ts`, `routes/pulse.ts`, `routes/rentABuddyMarketplace.ts`, `routes/admin.ts`, `routes/trips.ts`, `routes/tripCrewLocation.ts`, `compass/*`, `services/ranking/CreatorActivityScoreService.ts`, `services/passport/*`, `services/hiddenGems/*` |

### Verdict changes

| id | Was | Now | Evidence at this commit |
| --- | --- | --- | --- |
| A13 | W | **C** | Both unenforced restriction types are gated at the point that means JOINING. `private_plan_access` on `POST /trips/:tripId/accept-invite` (`routes/trips.ts`), and **only when the trip's visibility is `private` or `invite`** — a public trip is not a private plan. `location_plan_join` on `POST /trips/:tripId/crew/live-share/start` (`routes/tripCrewLocation.ts`), on START and deliberately not on STOP: a restricted user must always be able to stop broadcasting. Neither carries a `fail_closed` branch, which is correct rather than missing — `getRestrictionState` fails OPEN for both types by design, so both booleans are `true` on an unreadable read and neither gate can fire on one. Pinned by `test/trustRestrictionEnforcement.test.ts`, mutation-proven on both gates. |
| A17 | W | **C** | Zero direct reads of `trust_profiles` / `trust_caps` / `trust_restrictions` outside `services/trust`, enforced by `check:trust-table-ownership` (724 files scanned, 21 reads inside the service, 3 files owned elsewhere with a written reason, 0 violations). Three of the eleven could not have complied with the API the service offered, so the seam was widened rather than the rule waived: `getDisplayTrustScores` (batch), `listRestrictionsForAudit` (rows, not booleans), `getActiveCapsResult` (fail-closed caps). All three replaced reads that FAILED OPEN, and two of those substituted the neutral 50 for every user in a feed. |
| C11 | W | **C** | `getTrustProfileResult` (three-state) is the read at every consumer. The admin dossier REFUSES with `degraded_unavailable` rather than showing a moderator a user with no trust profile; `getSafeTrustSummary` and `getPublicTrustBadge` already carried `profileUnavailable`; `computeTrustScore` and `buildTrustSummary` set `degraded` from their own three-state read. `getDisplayTrustScore` keeps `number \| null` — both callers establish the state separately — and now LOGS the unreadable case, which previously passed through silently. Its docblock promised "never a fabricated number" while an unreadable table produced the "New Traveler" label; it now names which of the two states `null` means. |
| C15 | W | **C** | `routes/admin.ts` names no Trust table in executable code. The read goes through `listRestrictionsForAudit`, which was added because the enforcement seam answers in booleans and an admin dossier needs the row — id, reason, created_at. It refuses rather than returning an empty list, because an unreadable EXCLUSION table rendered as a clean record invites lifting a sanction that is still in force. |
| C18 | W | **C** | `getRecoveryStatus` returns `overallProgress: null` for a user with no profile, not the constant 50 — 50 is exactly a value a real measurement can hold, which made the fabrication indistinguishable from a reading. The `profileUnavailable` flag matches the shape `SafeTrustSummary` and `PublicTrustBadge` already use. The probation read beside it had an unbound error and asserted "not on probation" about a table nobody could read; it is bound. |
| C32 | W | **C** | `TRUST_EVENT_TYPES` is a contract, held by `check:trust-event-vocabulary`: 50 declared types, 36 emitted, 27 emitter sites compared against their declaration, **0 divergent, 0 undeclared**. Nineteen types were emitted and undeclared and are now declared with the values their emitters actually pass. One was actively FALSE — `gem_verified_by_guide` awarded 5 against a declared 4, so a guide's trust moved by a number the vocabulary denied — and that emitter now reads the constant. Fourteen declared-but-unemitted types each carry a written reason. |

### Rows that did NOT move, and why

| id | Stays | Why |
| --- | --- | --- |
| A6 | W | **The code gap is closed; the row is not.** Both emitters the body named now exist and are tested — `StampAwardEngine` calls `recordStampVerifiedTrustEvent` on every fresh award (pinned by `test/trustStampVerified.test.ts`, `test/trustEmissionChain.test.ts`, `test/trustChainEndToEnd.test.ts`), and `routes/posts.ts` emits `pulse_post_created`. But A6's requirement is *"Live evidence actually reaches the ledger from the surfaces that generate it (the first hop of A5, **measured in production**)"*, and **the branch carrying those emitters MERGED to main on 2026-09-09** (`StampAwardEngine.ts:21,767` on `origin/main` calls `recordStampVerifiedTrustEvent`), which moves the remainder by exactly one step and no further: MERGED IS NOT DEPLOYED. The row is defined as a production measurement, so no amount of code closes it: it needs a deploy and then a stamp. It is the one row in this census that is genuinely deployment-gated **by its own wording**. **Measured 2026-09-08, read-only against production — and A6 is now PARTLY measured rather than wholly unmeasurable.** `trust_engine_enabled` is TRUE (since 2026-07-17) and the ledger is not empty: 5 rows, `pulse_post_created` ×4 and `first_event_joined` ×1, last on 2026-08-16, against 2 `trust_profiles` and 58 profile rows. So **two surfaces demonstrably reach the ledger in production and the first hop of A5 is real for them**; the STAMP hop is not, because `recordStampVerifiedTrustEvent`, though now on main, has not reached the production runtime — the production `trust_events` ledger measured 2026-09-08 still carries no `stamp_verified` row, and merging does not write one. Two caveats that stop this from closing the row: the traffic is TEST ACCOUNTS (Portava has not launched — see the standing note in `truth-percentage-without-deployment.md`), so it measures that the wiring carries an event, not that live evidence flows; and 2 of 50 declared event types have ever been emitted. Stays **W**, with a smaller and better-specified remainder. |
| C22 | W | **OWNER DECISION, not work.** `adminOverrideScore` creates a CEILING, then `recalculateTrustScore` recomputes from events — so an override ABOVE the event-derived score does not hold and only downward overrides stick. `trust_caps` has no floor. The question is whether "override" means **pin** (the admin's number wins until lifted) or **cap** (the admin sets a maximum and events move it below). Both are defensible and they are different products: a pin lets an admin grant standing, a cap only lets them withhold it. Building either without the decision would be taking it. Unwired to any route, so nothing live turns on it today. |

### Recomputed headline — HEAD `7bca4b0d`

Same 52 denominator, same counting rule. Six rows move `W → C`; nothing moves
into or out of `N`.

| Measure | Body (`507f8427`) | Now (`7bca4b0d`) |
| --- | --- | --- |
| BUILT-AND-CORRECT | 44 | **50** |
| BUILT-BUT-WRONG | 8 | **2** |
| NOT-BUILT | 0 | **0** |
| CANNOT-VERIFY | 0 | **0** |
| Sum | 52 | **52** |
| CONSTRUCTED% | 100 % | **100 %** |
| CORRECT% | 84.6 % | **96.2 %** (50/52) |

**Two rows remain, and neither is buildable here.** A6 is defined as a production
measurement; C22 is an owner decision about what the word "override" means. Trust
is at **96.2 %**, which is the ceiling available without a deploy and without an
owner.

**Re-checked 2026-09-09, after the merge.** The branch that carried A6's emitters
is on `main`, so the one thing that changed is which sentence blocks the row: it
is no longer "unmerged", it is "not deployed". Nothing else about this headline
moved — no trust-scoped file has changed since `7bca4b0d`
(`check:census-freshness`: 0 stale), and the addendum's own re-reads confirm
`recordStampVerifiedTrustEvent` at `StampAwardEngine.ts:21,767` on `origin/main`
and both guards registered in `package.json:55-56` there. **96.2 % is still the
engineering ceiling, and merging did not raise it** — which is the point of
keeping BUILT, MERGED and DEPLOYED as three separate words.

Three new guards hold what closed: `check:trust-table-ownership`,
`check:trust-event-vocabulary`, and `test/trustRestrictionEnforcement.test.ts`.
All three were mutation-proven, and two of them caught a defect in themselves on
the first run — the ownership guard rejected an allowlist entry I had just
written for a file that did not need one, and the enforcement test passed a
mutation because it was matching a COMMENT rather than the gate.
