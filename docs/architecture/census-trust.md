# Census — Trust (the trust/safety scoring engine)

*Built against branch `claude/portava-continuation-uqta94`, working tree at `507f8427` plus
uncommitted sibling-agent work, on 2026-09-07. Production (`ajrurzioarfkagpuxfnb`) was read
with aggregate queries only; portava-ci (`hwokxgbmezheskbzskfr`) received migrations 2370 and
2371 during this pass. No flag was flipped anywhere.*

| | |
|---|---|
| **Surface** | `services/trust/` (8 services), `lib/trustScore.ts`, `lib/trustMaintenanceScheduler.ts`, `routes/trust-admin.ts`, 9 test files |
| **Spec** | **STALE SENTENCE CORRECTED 2026-09-14 — THIS CENSUS HAS A SPEC AND HAS BEEN GRADED AGAINST IT.** The owner supplied `docs/specs/upgrades-v2/03-TRUST-v2.md` (TRV2-01..12) and `docs/trust/verified-foundation-plan.md` (five privacy invariants, phases V-0..V-7); both are in the tree at `7d1f2d498` with sha256 recorded in `docs/specs/upgrades-v2/SOURCE-MANIFEST.json`. **The denominator already reflects them: 52 -> 93.** The sentence this replaces read *"None. Trust is one of the eleven surfaces `cross-cutting-obligations.md` names as having neither a spec nor a census"* — true when written, and false from the moment the specs landed. It was quoted back as current fact after that, which is the whole cost of leaving a header behind its own rows. |
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
| A12 | Authorization is server-side: restrictions are enforced at the action seam, not inferred by the client (§11:120, §30:286) — hosting and messaging | C | `routes/trips.ts:216-230` (canHost, with the degraded-read distinction), `routes/messaging.ts:510-523#msgPerms` (the open-thread seam's primary, fail-closed `resolveInteractionPermissions` gate, plus the catch that refuses rather than allowing on a failed check), `lib/calls/callGatewayAdapter.ts:265`, `services/interactionPermissions.ts:325-337` (throws `DegradedPermissionCheckError` rather than mis-labelling a failed check as a restriction). *(The messaging evidence was cited as `routes/messaging.ts` line 483 until 2026-09-13. That line is the tenth line of a comment paragraph about a `left_at` rejoin write — prose describing a 403, not a seam enforcing one. It was ALREADY wrong at this census's own head_commit 3ca68cb06: that file is unchanged above line 762 between 3ca68cb06 and HEAD, so the messaging diff acknowledged on 2026-09-13 did not move it. Repointed by reading the handler, not by offset, and anchored so the next move is loud. Verdict unmoved — the gate it should have named all along is real, primary and fail-closed.)* |
| A13 | The same for the other two restriction types the service declares — `private_plan_access`, `location_plan_join` (`TrustRestrictionService.ts:1-9`) | **W** | No route calls `canJoinPrivatePlans` / `canJoinLocationPlans` as a gate (grep: the only consumers of `getRestrictionState` are the four in A12 plus Passport). They reach the client only as `buildOwnerCapabilities` chips (`canJoinPublicTrip`, `canUseCrewLocation`), which §30 says the client must not treat as authorization. An admin applying either restriction changes a chip and blocks nothing. **Owner: Trips / Events / geofence join seams.** |
| A14 | TABLE 22 projections: permitted trust summary (Discovery, Compass), trust eligibility (Trips), completion/reputation (Buddy), restricted purpose-specific context (Safety) (§21:207-221) | C | Trust provides exactly the privacy-safe shapes: badge without number, summary without counts, restriction state as four booleans. All seven consumer variants derive from the one `PassportProjection.buildTrust` (`PassportConsumerProjections.ts:614-620` discovery_card, `:666-672` buddy, `:770-773` trips; telegraph/safety carry no trust at all). census-passport P117. |
| A15 | No numeric score to non-owners; the client must not infer authorization from a displayed score (§30:286) | C | `PublicTrustBadge` has no score field (`TrustPrivacyGuard.ts:124-130`); the number is self-only (`buildTrust:1013-1017`); `DiscoveryCardTrust` omits it by design (`PassportConsumerProjections.ts:192-197, :612`). census-passport P60. |
| A16 | Not a Trust leaderboard (§34:328) | C | No ranking or comparison endpoint in `routes/trust-admin.ts` or `services/trust/`. `rentABuddyMarketplace.ts:452-467` uses the score as one ranking *input*, not a displayed order. census-passport P165. |
| A17 | Other surfaces consume Trust through its canonical read instead of rebuilding it (§35:334; `TrustScoreService.ts:353-364` names `getDisplayTrustScore` as "the single source every Passport surface must read") | **W** | Eleven direct `trust_profiles`/`trust_caps` reads outside `services/trust` (`routes/events.ts:412,802,885,2840`; `routes/rentABuddyMarketplace.ts:452,2191`; `routes/pulse.ts:539`; `compass/CompassProfileService.ts:86`; `compass/CompassTools.ts:908`; `compass/CompassNotificationEngine.ts:450`; `services/ranking/CreatorActivityScoreService.ts:1267`; `compass/CompassActiveUserRewardEngine.ts:192`). **Four substitute 50 for a missing row** (`events.ts:413,806,2841`; `rentABuddyMarketplace.ts:458,463`) — and `events_trust_gates_enabled` is TRUE in production with **22 events carrying `trust_score_min`**, so 56 of 58 users pass or fail those gates on a constant. `CompassNotificationEngine.ts:454` tests `public_level === "suspended"`, a value the CHECK constraint forbids (0043; live constraint verified) — a dead check. Only `CreatorActivityScoreService._readSafetyMultiplier:1264-1285` distinguishes ok/absent/unavailable. **Owners: Events, Rent-a-Buddy, Compass, ranking.** Cross-listed with census-passport P169. |
| A18 | Source/signal reliability is not the same as person Trust Score (Sensing §16:182, SX-47) | C | `lib/intelScopedTrust.ts` keeps a separate scoped store; `lib/intelScopedTrustApply.ts:124-131` bridges only a named subset into person trust with its own deltas. census-sensing S104. Liveness caveat stands: `intel_scoped_trust` is absent in production. |
| A19 | Do not score a user as trustworthy because passive movement looks "normal" (Sensing §16:183, SX-48) | C | The only movement-derived person-trust events are negative (`recordLocationTrustEvent:375-396`: −1/−4/−8); the positive location events (`checkin_verified`, `plan_attended`) require an explicit geofenced action (`routes/geofence.ts:808#plan_attended` and `routes/geofence.ts:786#checked_in_successfully`, both reached only after the in-radius, in-window, accepted-member check-in at `routes/geofence.ts:773` has PERSISTED — `routes/geofence.ts:799`; `HiddenGemVerificationService.ts:111-116`). census-sensing S105. |
| A20 | Trust owns "contributor / evidence reliability" as a fact distinct from popularity; Media and Map project it, they do not compute it (Media §25:232-236, §35:441; Map §20:216-217) | C | `content_quality`, `community_value`, `guide_accuracy` are engine categories with their own emitters (`HiddenGemContributionService.ts:111`, `HiddenGemVerificationService.ts:227`, `LocalGuideService.ts:137#void recordTrustEvent(db, {`); ranking reads `overall_score` as a safety multiplier separate from its popularity terms (`CreatorActivityScoreService.ts:1264-1285`); Map reads through the Passport owner (census-map M140–M152). |

### 2.B — What `census-passport.md` measured of Trust: verified, one cause corrected

Not counted here. Checked because the brief asked what it marked wrong.

> **The `Row` column now spells out the owning census, and that is an ARITHMETIC fix, not a
> cosmetic one.** `check:census-integrity` parses any leading `P45` as a verdict row of the
> document it is reading, so these three Passport rows were being counted in THIS census's
> totals — three extra BUILT-BUT-WRONG rows in census-trust, on top of the same three already
> counted in census-passport, in a table whose first line says *"Not counted here"*. The tool
> read 49 rows and `C=44 W=5` while this document's own recount claimed 52 and `50 / 2`, and the
> three-row difference was exactly this. Naming the census makes the cell unparseable as a
> trust id, which is the truthful shape: they are census-passport's rows and census-passport
> counts them. Verified after the edit: 52 rows parsed, `C=50 W=2 N=0 X=0`, which is what §4's
> recomputed headline says.

| Row | Its verdict | Stands? | Correction |
|---|---|---|---|
| census-passport P45 — domain-specific/confidence-aware/explainable; the 50-substitution | W | **Yes.** `buildDomainTrust:951-973` still reads a literal 50 in this tree. | Its cause — "`trust_engine_enabled` is seeded false, so nothing writes `trust_events`, `trust_profiles` is empty" — is wrong for production: the flag is TRUE, 5 events exist, 2 profiles exist. The constant reaches 56 of 58 users because the emitters are silent (A6), not because the engine is off. |
| census-passport P50 — an 82 with high evidence ≠ 82 with little | W | **Yes.** `buildTrust:985-986` derives confidence from `stats.stamps + stats.trips * 2 + verified`. | Its §5 table says #467 "would flip P45, P50 and P154 from W to C". **#467 does not touch the confidence derivation** (its `buildTrust` hunk replaces only the profile read); P50 stays W after #467. The trust-side prerequisite for fixing it — an evidence measure — did not exist until A3 this pass. |
| census-passport P154 — Phase 4 Trust | W | Yes, via P45. | As P45. |
| §3 deployment fact 1 — "the trust engine is dark" | fact | **No.** | See §0. The scheduler is not merely registered; it demonstrably ran on 2026-08-27 (both profile rows created with 0 admin actions) and again on 2026-09-04 (stale refresh at `STALE_DAYS` = 7). |

### 2.C — Trust's own code contracts (32)

| # | Contract (where the code asserts it) | Verdict | Evidence |
|---|---|---|---|
| C1 | Source deduplication within a window (`TrustEventService.ts:4`) | C | `isDuplicate:208-232`; `trust.test.ts:250#it("deduplication prevents farming same source within window"` *(cited at line 249 until 2026-09-22. Q1's nullable-scores lane added a `measured()` import and three reversed assertions to that suite, which moved the line; the citation is repointed by SEARCHING FOR THE TEST THIS CLAIM DESCRIBES, never by adding the diff's offset, and anchored on a string that occurs exactly once in the file. The verdict is unmoved.)*. Fails **open** on a read error (returns false) — bounded by C2's fail-closed cap, so a transient error can admit at most one duplicate inside the cap. |
| C2 | Daily/weekly earning caps per event type, from `trust_settings`, per bucket; fail-CLOSED (`:5`, `:99-175`) | C | `countInWindow:99-118` returns `Infinity` on error; `eventTypesForCap:123-131` counts the whole bucket; `DEFAULT_EARNING_CAP:175` closes the previously uncapped types. `trust.test.ts:267-334`. |
| C3 | Severity classification; serious/severe → `pending_review`, excluded from scoring (`:6-7`) | C | `recordTrustEvent:274-276`; `loadEvents:118` reads only applied/confirmed; `trust.test.ts:237#it("routes serious event to pending_review"` *(cited at line 236 until 2026-09-22. Q1's nullable-scores lane added a `measured()` import and three reversed assertions to that suite, which moved the line; the citation is repointed by SEARCHING FOR THE TEST THIS CLAIM DESCRIBES, never by adding the diff's offset, and anchored on a string that occurs exactly once in the file. The verdict is unmoved.)*. |
| C4 | Gated by `trust_engine_enabled`; events and scoring share one gate (`:80-86`) | C | `isTrustEnabled:83-94` (fail-closed); imported by the scheduler (`trustMaintenanceScheduler.ts:294`); `trust.test.ts:337#it("flag_off: skips when trust_engine_enabled = false"`, `trust-integration.test.ts:975` *(cited at line 336 until 2026-09-22. Q1's nullable-scores lane added a `measured()` import and three reversed assertions to that suite, which moved the line; the citation is repointed by SEARCHING FOR THE TEST THIS CLAIM DESCRIBES, never by adding the diff's offset, and anchored on a string that occurs exactly once in the file. The verdict is unmoved, and the flag remains seeded FALSE.)*. |
| C5 | "Serious/severe events are queued for admin review" (`:11`) | **W → C** | Measured: only the status was set. The queue an admin reads is `trust_reviews` (`trust-admin.ts:98-127`); no row was written for a pending event; `confirmEvent:82-85` and `dismissEvent:178-181` closed a review "for this event" that never existed; `getPendingEvents:317-332` had no route. `recordAdjudicatedTrustEvent`'s own comment records the gap (`:409-412`). Built: `queueEventForReview:330-362` writes an open `event_review` row keyed by `source_event_id`, non-fatal and logged; `GET /admin/trust/events/pending` (`trust-admin.ts:138-147`). Pinned by `trustCensusRepairs.test.ts` §1–§2. Production impact today: none (0 pending events); the next one will be visible. |
| C6 | Never auto-bans (`:11`) | C | `applyRestriction` has exactly one non-test caller, `adminApplyRestriction` (`TrustAdminService.ts:261#const restriction = await applyRestriction(db, {`), reached only from the admin route. |
| C7 | The counterpart of an event is recorded explicitly in `metadata[counterparty_user_id]`, never inferred from `source_id` (`:32-45`) | C | `recordTrustEvent:249-252`; `TrustGamingDetectionService.readCounterparty:26-34`; `trustMutualRings.test.ts`. |
| C8 | Nine category scores + weighted overall; exponential decay; cap ceilings; public level; persist to `trust_profiles` (`TrustScoreService.ts:1-10`) | C | `recalculateTrustScore:261-352`; `scoreToLevel:217-224`; `trust.test.ts:350-398`. |
| C9 | Slow to earn, immediate to lose — the ramp applies only to positive movement (`:162-188`) | C | `computeCategoryScore:189-215`; `trustAsymmetryAndMaintenance.test.ts` pins the asymmetry and the worked example (56, not 80). |
| C10 | `getDisplayTrustScore` is THE display number; no second engine (`:353-364`; `lib/trustScore.ts:1-25`) | C | `lib/trustScore.ts:124-149` delegates; `PassportProjectionService.ts:1428#getDisplayTrustScore` and `routes/rentABuddy.ts:1237` read through it; `passportTrustConsistency.test.ts`. |
| C11 | `getTrustProfile` "loads the current profile" (`:375`) — and a failed read is not a missing profile | **W** | `:376-410` never destructures `error`; `null` means both. Five readers collapse an unreachable engine into "New Traveler"/`score: null`: `getDisplayTrustScore:365`, `getSafeTrustSummary:91`, `getPublicTrustBadge:136`, `getRecoveryStatus:89`, `computeTrustScore:131`. **PR #467 adds `getTrustProfileResult()` (ok/absent/unavailable) and switches ONE reader — Passport's domain builder.** Not fixed here: a second error-aware read in the same file would duplicate #467's hunk. Recommended as a #467 follow-up (§4). |
| C12 | Caps: create, enforce as ceilings, expire on schedule (`TrustCapService.ts:1-6`) | C | `TrustCapService.ts:35#createCap`, the ceiling applied at `TrustScoreService.ts:454#caps`, `TrustCapService.ts:149#expireOldCaps` driven by the scheduler (`lib/trustMaintenanceScheduler.ts:657#capsExpired = await expireOldCaps(db);`); `trust.test.ts:400-475`. |
| C13 | `applyEventCaps` keys on the event vocabulary the emitters actually write (`:166-180`) | **W → C** | `coordinate_jump` named a type nobody emits; `recordLocationTrustEvent:375-396` writes `gps_coordinate_jump`. Corrected (`:186`). Residual, **owner decision**: `plan_no_show` and `fake_gps_confirmed` have ceilings and no emitter; `content_removed` and `message_report_confirmed` were wired by the emitter pass. **Correction (2026-09-07, second pass):** this row cited `event_host_no_show (serious, −15, routes/events.ts:3473)` as an emitter. Nothing emits it — `:3473` is the attendance route (`event_attendance_confirmed`), and the no-show emitter at `:3575` writes `event_no_show` (−5 moderate). Which serious findings deserve a ceiling is policy, listed in §5; the per-type evidence is in [trust-unproduced-vocabulary.md](trust-unproduced-vocabulary.md). |
| C14 | Every cap a moderation finding created is lifted when the finding is reversed (`:93-108`) | C | `liftCapsBySourceEvents:110-128`; wired through `revokeModerationTrustConsequences:112-155` from `routes/admin.ts:1835#void revokeModerationTrustConsequences(sc, adminUserId, userId, reason ?? "Account restore`. |
| C15 | `getRestrictionState()` is the enforcement seam — "never query trust_restrictions directly in route code" (`TrustRestrictionService.ts:175-179`) | **W** | `routes/admin.ts:1319-1322` selects `trust_restrictions` directly for the admin user view (read-only, includes `reason`). Low impact; **owner: admin route.** |
| C16 | Degraded reads are labelled: fail-open (table missing) vs fail-closed (query error), and callers must never show a restriction message for a failed check (`:50-80`) | C | `getRestrictionState:180-250`; consumers honour it (`routes/trips.ts:218-227`, `interactionPermissions.ts:326-337`); `trust.test.ts:906-1043`. |
| C17 | `expireOldRestrictions` — "call from cleanup job" (`:264`) | **W → C** | Had no caller. Enforcement already ignored expired rows, so nothing was over-enforced, but the row stayed `lifted_at IS NULL` and every admin view listed a lapsed restriction as active. Now step 1b of the pass (`trustMaintenanceScheduler.ts:308-318`) and the function reads its `error` (`:264-287`). `trustCensusRepairs.test.ts` §4. |
| C18 | Recovery status: probation, lowest category, ordered steps, `overallProgress` "0–100 % toward 50" (`TrustRecoveryService.ts:1-8`, `TrustRecoveryService.ts:34#0–100 % toward 50 (neutral), or NULL when there is no profile to measure.`) | **W** | Steps and probation are correct (`trust.test.ts:726-770`). But a user with **no profile** is returned `overallProgress: 50` (`TrustRecoveryService.ts:155#overallProgress: null,`) *(this was a BARE line-107 pointer until 2026-09-22, which inherits the previously-named file and therefore resolved against `trust.test.ts` — whose line 107 was `update(patch: any) {`, a fake-client builder method, at head_commit and throughout. The citation named the wrong FILE all along and stayed green only because that line was non-blank; Q1's edits shifted it onto `},` and surfaced it. It is repointed to the service and the branch the sentence is about, with the file named explicitly so it can never inherit again.*  **THIS ROW IS OWED A RE-READ AND IS NOT RE-GRADED HERE.** Its argument — "a user with no profile is returned `overallProgress: 50`" — no longer describes the code: that branch now returns `overallProgress: null` with a comment explaining why 50 was a fabrication, and Q1 extends the same treatment to a profile that EXISTS but holds no measurement. Whether the **W** verdict still stands is a measurement this lane did not make and does not claim.)* — a constant where a measurement belongs, the same shape as P45 in miniature. Unconsumed today (`getSafeTrustSummary` reads only `onProbation` and `suggestedSteps`), and PR #455 is about to surface recovery to the owner. Left as W: the honest value is `null`, which changes the field's type, and #455 is the PR editing the consumer. |
| C19 | Probation ends when `probation_ends_at` passes (`trustMaintenanceScheduler.ts:26-27`) | C | `clearExpiredProbation:138-155`; `trust-integration.test.ts:1436#it("ends probation whose term has run"` *(cited at line 842 until 2026-09-22. That line was ALREADY WRONG before this lane touched the file — at head_commit it was `assert.ok(Array.isArray(body.flags), "flags should be an array")`, an admin gaming-flags assertion that has nothing to do with probation expiry; it stayed green only because the line was non-blank. Q1's edits shifted it onto a blank line, which is what surfaced it. Repointed by SEARCHING for the test this claim describes, not by offset. The verdict is unmoved.)*. |
| C20 | Reporter identity never exposed; raw deltas/internal scores not returned; restrictions human-readable; pending_review invisible to the subject — at the API (`TrustPrivacyGuard.ts:1-10`) | C | `getSafeTrustSummary:81-121`, `RESTRICTION_MESSAGES:61-66`, `isEventLlmSafe:150-156`; `trust.test.ts:660-725`. The table-level contradiction was A8. |
| C21 | Every admin write creates a `trust_admin_actions` row (`TrustAdminService.ts:1-6`) | C | `logAdminAction` at `:87,184,200,214,247,282,311`; route-level inserts at `trust-admin.ts:323-330` and `:426-435`; `trustAdminAuditInsertSchemaDrift.test.ts` pins the columns. |
| C22 | `adminOverrideScore` overrides a category score (`:218`) | **W** | It creates a *ceiling* (`:230-235`) and writes the row once (`:239-243`), then `recalculateTrustScore:246` recomputes from events — so an override ABOVE the event-derived score does not hold; only downward overrides stick. `trust_caps` has no floor. Unwired to any route, so no live effect. Whether "override" means pin or cap is an **owner decision** (§5). |
| C23 | Gaming detection never auto-penalises; it only opens `gaming_suspected` reviews (`TrustGamingDetectionService.ts:5`) | C | `createGamingReview:68-94` is the only write; dedup on an open review; `trust-integration.test.ts:1160#it("rapid jump pattern creates gaming_suspected review"` and `trust-integration.test.ts:1172#it("dedup: second scan does not create a second open review"` *(cited at line 786 until 2026-09-22. That line was ALREADY WRONG before this lane touched the file — at head_commit it was a `PLAN_NO_SHOW` event seed inside an unrelated test, not evidence for either clause of this row; it stayed green only because the line was non-blank. Q1's edits shifted it onto a blank line, which is what surfaced it. Repointed to the two tests the sentence actually names — the review is OPENED rather than a penalty applied, and a second scan does not open a second review — by reading the claim, not by offset. The verdict is unmoved.)*. |
| C24 | Three detectors, gated by `trust_gaming_detection_enabled`, thresholds from `trust_settings` (`:7-10`) | C | `runGamingDetectionScan:299-316`; `isGamingDetectionEnabled:55-66` fail-closed; check-in vocabulary matches the writer (`CHECKIN_CLUSTER_EVENT_TYPES:114`, `routes/geofence.ts:786#checked_in_successfully`). `trust.test.ts:771-826`, `trustAttendanceVocabulary.test.ts`, `trustMutualRings.test.ts`. **Liveness (§3):** flag ON in production; runs every pass; every input is empty. |
| C25 | The maintenance scheduler is registered and fires: decay refresh, cap expiry, probation, gaming scan; fail-closed on the flag (`trustMaintenanceScheduler.ts:1-44`) | C | Registered unconditionally at `index.ts:264`; `startTrustMaintenanceScheduler:414-432` (startup delay 120 s, then every 6 h). **Fires in production**: both `trust_profiles` rows were created 2026-08-27 with `trust_admin_actions` = 0 (only the scheduler creates a row for a user with events and no profile, `findDirtyUsers:168-233`), and both were refreshed 2026-09-04 06:56 — one `STALE_DAYS` after — the `findStaleUsers:240-259` path observed working. Tested at `trustAsymmetryAndMaintenance.test.ts:280-400`, `trust-integration.test.ts:974-1070`. |
| C26 | Every `/admin/trust/*` route is admin-guarded (`routes/trust-admin.ts:2`) | C | `requireAdmin` first in every handler (`:99,139,152,200,221,248,281,309,342,364,385,402`); `trust-integration.test.ts:285-308`; `check:route-auth-gate` exit 0. |
| C27 | `PUT /admin/trust/settings/:key` accepts only known keys (`:83`) and values the engine can compute with | **W → C** | Keys were allow-listed; the value was `z.number()` — any finite number. `decay_half_life_days = 0` makes every decay weight 2^-∞ = 0 and every score 50; a negative half-life weights older events more; a weight of 5 lets one category exceed the scale; a fraction in an INTEGER column is a 500. Built: `SETTING_BOUNDS:69-81` (structural ranges only — the numbers inside them are the operator's), `trustSettingRejection:86-94`, applied at `:414-415`. `trustCensusRepairs.test.ts` §5. |
| C28 | A settings change recalculates every scored user (`:437-450`) | C | `setImmediate` chain over `trust_profiles` (`:437-450`), bounded at `limit(1000)`; correct at the measured scale (2 rows). Note the bound. |
| C29 | Audit inserts match the live `trust_admin_actions` columns (`trustAdminAuditInsertSchemaDrift.test.ts`) | C | Suite passes; `check:write-path-columns` could not run here (live-DB guard; §7). |
| C30 | The 19 unguarded `void recordTrustEvent(...)` sites cannot crash the process (`index.ts:60-80`) | C | `process.on("unhandledRejection")` backstop logs and continues (`index.ts:77-83`). |
| C31 | `lib/trustScore.ts` is an adapter, never a second computation (`:1-25`) | C | `computeTrustScore:124-149` reads only `getTrustProfile` + `getDisplayTrustScore` + `publicTrustLabel`; `passportTrustConsistency.test.ts`. |
| C32 | `TRUST_EVENT_TYPES` is "all event types by source system" (`TrustEventService.ts:779#/** All event types by source system */`) — the declared vocabulary is what emitters emit | **W** | One emitter spreads a constant (`routes/verification.ts:108#...TRUST_EVENT_TYPES.IDENTITY_VERIFIED,`); five read a constant's fields (`routes/admin.ts:1495`, `StampAwardEngine.ts:723`, `HiddenGemModerationService.ts:133`, `HiddenGemVerificationService.ts:259#eventType: "gem_verified_by_guide",`); **every other emitter hand-writes its own type, delta and severity** (24 sites across `routes/events.ts`, `routes/rentABuddy.ts`, `routes/messaging.ts`, `routes/posts.ts`, `routes/geofence.ts`, `services/hiddenGems/*`, `services/safeReturn/*`). Declared and emitted by nothing: `STAMP_VERIFIED`, `FAKE_GPS_CONFIRMED`, `CONTENT_REMOVED`, `MESSAGE_REPORT_CONFIRMED`, `PLAN_NO_SHOW`, `PLAN_LATE_CANCEL`, `HOST_POSITIVE_REVIEW`, `HOST_NEGATIVE_REVIEW`, `RESPONDED_PROMPTLY`, `MUTUAL_REPORT`, `TRAVEL_CIRCLE_JOIN`, `EVENT_HOST_CANCELLED`, `EVENT_HOST_NO_SHOW` (the emitter writes `event_no_show` at moderate instead), `EVENT_POSITIVE_REVIEW`, `EVENT_NEGATIVE_REVIEW`. The constant is a wish-list, not a contract. Consolidating it is emitter-side work (not Trust files) and which types survive is an **owner decision**. **Since measured:** five of these were wired (`EVENT_HOST_CANCELLED`, `EVENT_POSITIVE_REVIEW`, `EVENT_NEGATIVE_REVIEW`, `CONTENT_REMOVED`, `MESSAGE_REPORT_CONFIRMED`; `trustEventCoverage.test.ts` pins the set). The remaining **13** are classified one by one, with the triggering action opened rather than grepped, in [trust-unproduced-vocabulary.md](trust-unproduced-vocabulary.md): 4 `missing_real_emitter` (`stamp_verified`, `plan_no_show`, `host_positive_review`, `host_negative_review`), 6 `owner_decision`, 2 `reserved_future_event`, 1 `unsafe_to_emit`. The earlier claim that nine had "no triggering action anywhere" is wrong for three and partly wrong for four. |

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
| **TrustAdminService** | Built; **never invoked in production** | `routes/trust-admin.ts`; `routes/admin.ts:1835#void revokeModerationTrustConsequences(sc, adminUserId, userId, reason ?? "Account restore` | `trust_admin_actions` **0** | No admin has ever used a trust admin route. `adminOverrideScore`/`adminRemoveOverride`/`getOpenReviews` have no route at all. |

**The writerless-read check, done properly.** Per `checkWriterlessReads.ts:39-41` a `from("x")`
grep is not attribution. Every trust table was checked for writers by reading the writer code and
by the production row counts above: each table HAS a live writer; four of them (`trust_caps`,
`trust_restrictions`, `trust_reviews`, `trust_admin_actions`) have writers that no production
event has ever reached. That is different from the intel spine (writer silently failing) and
different from a decoy (no writer): it is machinery whose trigger conditions have not occurred.
`plan_attendance_events` is the one input whose writer (`routes/geofence.ts:263#const { error } = await db!.from("plan_attendance_events").insert({`) depends on a
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
`routes/discoverySearch.ts:3094#buildConsumerProjection(sc,`, `routes/compass.ts:4754#buildConsumerProjection(sc,`, `routes/telegraph.ts:386#buildConsumerProjection(sc,`,
`routes/safeReturn.ts:1215#buildConsumerProjection` — all inherit the fix. *(Cited as line 852 of that file until 2026-09-12; that line was never the call, which is at the `buildConsumerProjection(db, "safety", …)` site — a range-only citation that stayed green while wrong, the §37 class. Anchored now. The old number is spelled out rather than written as a citation because it went dead on 2026-09-22, when the suggest handler above it grew by 30 lines and line 852 became a closing brace.)* *(Three more repointed 2026-09-13 while acknowledging this census's staleness on `routes/discoverySearch.ts` and `routes/messaging.ts`, each re-derived by SEARCHING FOR THE CALL rather than by adding the diff's offset. Discovery search was cited at line 2087, then at line 2350 after a merge re-derived it by offset; the call is at line 2578 and has been the file's only `buildConsumerProjection(sc, "discovery_card", …)` throughout. Compass was cited at line 4225, then at line 4276 by the same offset re-derivation — and `routes/compass.ts` was BYTE-IDENTICAL between 3ca68cb06 and 75cc31d9e, the tree this sentence was measured in, so no offset was owed at all; line 4276 is a bare closing brace, a line that occurs 38 times in that file, which is not a citation. The call was at line 4393 there. **UPDATED 2026-09-13, because this sentence stopped being true four commits later and a census must not keep asserting it:** the Compass lane's `fa5d7c25d` added 184 lines to this file (census-compass §12's CP-01/CT-13 pass), so the byte-identical claim no longer reaches HEAD and is narrowed here to the window it was actually measured over. The call was re-resolved by SEARCHING FOR IT again rather than by adding that diff's offset, and is at line 4559 — still the file's only `buildConsumerProjection(sc, "discovery_card", …)`, which the anchored citation in the list above names and which resolves line-exact at HEAD. No verdict moves; the `fa5d7c25d` diff is argued hunk by hunk in this census's entry in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`. Both were already wrong at 3ca68cb06, so neither was broken by the diff being acknowledged; both, and Telegraph's, now carry a whitespace-free anchor that appears on exactly ONE line of the file it names. NOT repaired here, and still wrong, in files this census's scope shows UNCHANGED since 3ca68cb06 — so outside this acknowledgement's reach and owed a repointing pass of their own: Trips is cited at line 467, a route comment banner, for a call at line 590; Rent-a-Buddy at line 1248, a `.select()` chain, for a call at line 1386; and the variant ranges in the table below (PassportConsumerProjections 607-613, 666-672 and 770-773, plus computeTrustScore at rentABuddy line 1237) name unrelated code. No verdict rests on the numbers — every one of the seven is the same call it always was.)* But note what each actually ships:

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
| Cross-emitter double-charge (second pass, classification lane) — one report reaching both `hide-content` and `resolve {upheld}`, either order; two reports on one post; a message report hidden then upheld | `src/test/trustEmitterWiring.test.ts` §6 (4 tests; suite 24 → 28) | `trustEmitterWiring.test.ts` §6 | R1 (resolve emits for post targets too — the shape of a naive `pulse_post_reported` wiring, one-line edit to `routes/admin.ts:2271#if (parsed.data.upheld === true && targetType === "message" && auditR.audit === "recorded"`, restored): **25/28, fail 3**. R3 (`isDuplicate` always `"new"`, Trust-owned): **23/28, fail 5**. Baseline and final 28/28, exit 0. |

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
   four did.** `routes/posts.ts:1018-1027` is reached for every post created through that route
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
| (second pass) Nine of the 13 unproduced types have "no triggering action anywhere" | **FALSE for three** (`plan_no_show` — owner override `routes/geofence.ts:1150#no_show`, on the owner-gated `POST /trips/:tripId/geofence/attendance/:userId/override` (`routes/geofence.ts:1044`, gate `routes/geofence.ts:1077`); `host_positive_review` / `host_negative_review` — `routes/reviews.ts:199`), **partly for four** (raw signal, no adjudication), **TRUE for two** (`event_host_no_show`, `plan_late_cancel`). [trust-unproduced-vocabulary.md](trust-unproduced-vocabulary.md) §0. |
| (second pass) `plan_attendance_events` is read/written by four files | `routes/geofence.ts:154` writes; `routes/admin.ts:621#.from("plan_attendance_events")` and `TrustGamingDetectionService.ts:130` read; `lib/crowdFlowProducer.ts` names it in comments only (`:152`, `:361`). 0 rows in production. |

---

*The full-suite verdict for this branch is recorded by the coordinator, not here.*


---

## 10. Re-census — 2026-09-08, HEAD `7bca4b0d`

Paths relative to `artifacts/api-server/src/`. Same denominator (52), same rule,
same buckets. **Every row below was re-derived by opening the file at this
commit.** Rows not restated keep the verdict the body left them with.

| Field | Value |
| --- | --- |
| `head_commit` | `a97bfdac0` — RE-DECLARED 2026-09-16 by **§20**, replacing `1fe72289b`. A MEASUREMENT by an independent reviewer, not a field edit. §20 re-derived every Trust claim resting on the counted files that changed in the acknowledged range: four of the five (`routes/messaging.ts`, `routes/discovery.ts`, `routes/tripCrewLocation.ts`, `routes/profile.ts`) had each falsifiable claim re-checked at BOTH commits and all held, and the fifth (`routes/discoverySearch.ts`) is covered by the same five-hunk enumeration §13 of census-input-intelligence gives. **NO Trust verdict moves** — A12, TV-P2, TV-5b, TV-0e/TV-2c and TRV2-08 were all re-derived and all stand. §20 also records two ACCOUNTING CORRECTIONS that move nothing: §12/§14.6 score `routes/discovery.ts` at "4 `date_of_birth` reads" when the true count is **zero**, at this commit and at `1fe72289b` alike (TV-5b is unaffected — its load-bearing column, `loadTravelerIdentity: 0`, is confirmed 0 at both); and census-telegraph §27.5's two false statements about `routes/profile.ts` are corrected here, in §20.2, because this is the census that watches that file. The acknowledgement written against `1fe72289b` is SPENT and has been moved to the `retired` array; zero counted files have changed between `a97bfdac0` and HEAD, so no replacement entry is written. It does **not** re-certify the other rows. The previous declaration read: `1fe72289b` — RE-DECLARED 2026-09-15 at the squash merge of PR #482. The previous value was `f9d0b9a07`, a commit on the pre-merge branch. **The squash made it an orphan**: it still exists in a clone that fetched the branch, but it is on no line of history leading to `main`, and `check:census-freshness` refuses an orphan because the check would pass locally and fail in a fresh clone. Nothing about this census was re-measured and NO verdict moves — `1fe72289b` is the commit its previous declaration's tree became, so zero counted files have changed since it. The prior declaration and its reasoning follow. — RE-DECLARED 2026-09-13 by **§13**, which built phase V-7 (TV-7a, TV-7b) and moved both rows to `C`; §12's citations into `routes/verification.ts` and `routes/admin.ts` are unaffected. The previous declaration read: `983cfaf75` — RE-DECLARED 2026-09-13 by **§12**, replacing `3ca68cb06`. §12 re-measured the whole census against the verified-foundation plan and the v2 upgrade, corrected the denominator from 52 to 93, re-executed nine of the fifty `C` rows and both `W` rows, and repaired four rows in `routes/verification.ts` and `routes/admin.ts` — so the declaration moves to the commit those repairs landed in, and every §12 citation into those two files is post-repair. The 52 original verdicts are unchanged; see §12.8 for what was re-executed and §12.2 for the arithmetic. The previous declaration read: `3ca68cb06` — RE-DECLARED 2026-09-13 by §5, replacing `42aeac38`. §5 re-executed **all six** of the rows this census could not previously be parsed on (A3, A8, C5, C13, C17, C27) and both remaining BUILT-BUT-WRONG rows at this commit, and edited no Trust source file. It does **not** certify the other 44 `C` rows. The previous declaration read: `42aeac38` — RE-DECLARED 2026-09-09 from `7bca4b0d0e19d29ea0a96982f74b35d26402fa52`, the working-tree commit that addendum was measured at. The move is a measurement, not a judgement: `git diff --name-only 7bca4b0d 42aeac38` over this census's 15 scoped paths returns **0 files**, so all 52 verdicts are exactly as true at one as at the other. It was necessary because `7bca4b0d` is PRE-SQUASH — this repository squash-merges, so it is an ancestor of nothing, is on no remote branch, and `check:census-freshness` could resolve it only on the clone that wrote it (`CENSUS_HEAD_COMMITS_UNREACHABLE_IN_CI`). `42aeac38` is #476's squash, where this document's content reached `main`. |
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

---

## 5. The correctness pass, 2026-09-13 — six rows this document had already earned, and could not be read

*Re-measured at `3ca68cb06`, declared as `head_commit` at the top of this file. No Trust source file
was edited by this pass; every row below was RE-EXECUTED, not rewritten.*

### 5.0 The gap was arithmetic, and it had two causes

This document's §4 recount claims **50 / 2 over 52**. `check:census-integrity` read
**44 C / 5 W over 49** — a 6-point correctness difference between what the census says about itself
and what the only machine that reads it could see. Neither number was a lie; the document could not
be parsed.

| cause | rows | effect on the parsed figure |
|---|---|---|
| Six verdict cells written as `**W → C**` or `**NB → C**` — an as-found/now pair in one cell, which `verdictOf` refuses because the WHOLE cell must be one token | A3 · A8 · C5 · C13 · C17 · C27 | six `C` rows in **no** bucket and **no** denominator |
| Three cells in §2.B whose first token is a PASSPORT id (`P45`, `P50`, `P154`), in a table whose own first line reads *"Not counted here"* | P45 · P50 · P154 | three `W` rows added to **this** census's totals, and double-counted with census-passport |

The first is the exact defect `census-compass.md` §10.1 found in itself and fixed by restating the
cells; this is the same fix on the same parser. The second is worse than unreadable — it was
**wrong in the direction that flatters nobody**: it inflated Trust's BUILT-BUT-WRONG count by three
rows that belong to another document, so both censuses were charged for the same three
requirements. Fixed in §2.B by spelling out the owning census, which makes the cell unparseable as a
Trust id — the truthful shape, since census-passport counts them and this table explicitly does not.

**Nothing about the tree changed. The document now says to a machine what it already said to a
reader.**

### 5.1 The six rows, restated in a cell the tallier can read — each RE-EXECUTED first

No verdict changes. The `was` column reproduces the cell this document carried; the `now` column is
the same verdict in a parseable shape; the reason names the line that was opened to confirm it is
still true at `3ca68cb06`, because a restatement that is not re-executed is just a reformat.

| id | was | now | re-executed at this commit |
|---|---|---|---|
| A3 | `NB → C` | C | `artifacts/api-server/src/services/trust/TrustScoreService.ts:420#export function measureEvidence` still computes the decayed evidence weight and count, and `artifacts/api-server/src/services/trust/TrustScoreService.ts:508#.update({ evidence_weight: evidence.weight, evidence_count: evidence.count })` still persists both. The migration that holds the columns is present at `artifacts/api-server/src/migrations/2371_trust_profiles_evidence.sql:1#-- 2371_trust_profiles_evidence.sql`. NULL still means not measured, 0 still means measured empty. |
| A8 | `W → C` | C | `artifacts/api-server/src/migrations/2370_trust_tables_privileges.sql:1#-- 2370_trust_tables_privileges.sql` is in the tree and still carries the REVOKE-then-grant-service_role shape with the RAISE-on-residue postcondition. **The row's caveat is unchanged and matters more than the verdict: applied to CI, NOT to production** — this pass made no production read and no production change, so A8's `C` is a statement about the migration, not about the live grants. |
| C5 | `W → C` | C | `artifacts/api-server/src/services/trust/TrustEventService.ts:374#async function queueEventForReview` still writes the open `event_review` row, called on the pending-review path, and the admin queue that reads it is still routed at `artifacts/api-server/src/routes/trust-admin.ts:155#router.get("/admin/trust/events/pending", async (req, res) => {`. |
| C13 | `W → C` | C | The cap table still keys on the type the emitter actually writes: `artifacts/api-server/src/services/trust/TrustCapService.ts:316#gps_coordinate_jump:       [{ category: "location_honesty", ceiling: 55, reasonCode: "coordinate_jump",      expiresInDays: 7  }],`. The residual owner decision on unproduced ceilings is unchanged and stays in §5's list. |
| C17 | `W → C` | C | `artifacts/api-server/src/services/trust/TrustRestrictionService.ts:378#export async function expireOldRestrictions(` still binds its own error, and it still has the caller it lacked: `lib/trustMaintenanceScheduler.ts:674#const sweep = await expireOldRestrictions(db);`. |
| C27 | `W → C` | C | `artifacts/api-server/src/routes/trust-admin.ts:86#const SETTING_BOUNDS: Record<string, SettingBound> = {` still bounds each key structurally and `artifacts/api-server/src/routes/trust-admin.ts:103#export function trustSettingRejection(key: string, value: unknown): string` still rejects a value outside it before the write. |

Executed alongside them, because two rows in this census rest on guards rather than on lines:
`pnpm -s check:trust-table-ownership` → *"891 source file(s) scanned; 21 read(s) inside services/trust;
3 file(s) owned elsewhere with a written reason; **0 violation(s)**"*, which is A17's whole claim and
is also why `census-compass.md` CTR-01 moved W→C in the same pass — that census was still grading
Compass on three direct trust reads the seam had already absorbed.

### 5.2 The two BUILT-BUT-WRONG rows, grouped

| group | rows | which |
|---|---|---|
| **(a) logic wrong in code this pass owns** | **0** | — |
| **(b) logic right, nothing reaches it** | **0** | — |
| **(c) capped by a deployment** | **1** | A6 |
| **(d) needs a decision nobody has made** | **1** | C22 |

**Neither is engineering, and §4 already said so.** A6 is *defined* as a production measurement —
the emitters are on `main`, the production `trust_events` ledger measured 2026-09-08 still carries no
`stamp_verified` row, and merging does not write one. C22 asks whether `adminOverrideScore` means
**pin** or **cap**; both are defensible, they are different products, and building either would be
taking the decision. This pass made **no production read**, so A6's remainder is unchanged in every
particular, including its date.

**Trust's ceiling without a deploy and without an owner is 50 / 52, and it is now the number the
tooling reports as well as the number the document claims.** That is the entire content of this
section: no code, no verdict, one arithmetic reconciliation.

### 5.3 Restated headline

> **Trust, at `3ca68cb06`: 52 requirements · 50 BUILT-AND-CORRECT · 2 BUILT-BUT-WRONG · 0 NOT-BUILT ·
> 0 CANNOT-VERIFY → CONSTRUCTED 52 / 52 = 100 % · CORRECT 50 / 52 = 96.2 %.** Unchanged from §4's
> recount, which was right all along; what changed is that `check:census-integrity` can now read it,
> and that three census-passport rows stopped being counted twice across the corpus. The gap between
> CONSTRUCTED and CORRECT is **3.8 points**: one deployment and one word.

| BUILT-AND-CORRECT | **50** |
|---|---|
| BUILT-BUT-WRONG | **2** |
| NOT-BUILT | **0** |
| CANNOT-VERIFY | **0** |

## 11. D-OVERRIDE pinned — the decision now costs an assertion, and the comment was lying

| | |
|---|---|
| **Measured at** | `6d4fd1a06`. `head_commit` is **not** moved: this section re-reads one function and its tests, not 52 rows. |

### 11.1 C22 stays W, and it is still an owner decision

Nothing here answers whether an admin override should mean **pin** (the admin's
number wins until lifted) or **cap** (the admin sets a maximum and events move
the score beneath it). That is D-OVERRIDE and it is not a lane's to take. What
this section does is stop the current answer from being an accident.

C22's existing verdict and reasoning are confirmed, including the part that caps
it: `adminOverrideScore` is **not reachable from any route**. `grep` across
`src/routes/` and `src/server/` returns no importer.

**A naming trap, found while checking that and worth one sentence so the next
reader does not repeat it:** `routes/trust-admin.ts` DOES expose
`POST /admin/trust/users/:userId/cap/override` — and it does the OPPOSITE of what
its path says. It calls `liftCap`, audits the action as `lift_cap`, and sets no
score. A reader grepping for "override" finds a live admin endpoint and could
reasonably conclude C22 is wired. It is not.

### 11.2 The finding is sharper than "an upward override does not persist"

The previous statement was that `recalculateTrustScore` recomputes from events,
"so an override ABOVE the event-derived score does not hold". Measured, it is
worse than that: **the upward override never lands at all.**

`adminOverrideScore` creates the cap, upserts `trust_profiles` directly under a
comment saying "for immediate effect", and then, **on its own last line before
the audit write**, awaits `recalculateTrustScore`. That recomputation overwrites
the upsert before the function returns. There is no window — not even a
transient one — in which the admin's number is the stored value. The admin gets
`{ ok: true }`, an audit row saying `score_override`, and no change.

The ceiling itself is
`artifacts/api-server/src/services/trust/TrustScoreService.ts:454#if (caps[cat] !== undefined && capped > caps[cat]) {`
— a strict one-directional clamp — and `trust_caps` carries only
`ceiling_score`, with no floor column anywhere.

### 11.3 What now holds the answer in place

Three tests in `src/test/trust-integration.test.ts`, under
`D-OVERRIDE: adminOverrideScore caps, and a cap only binds downward`: a downward
override binds; an upward override is absent from `trust_profiles` immediately
after the call AND after any later recalculation; and the cap row stores the
override as `ceiling_score` with no floor-shaped key. Whichever way D-OVERRIDE is
decided, **changing the behaviour must change these assertions** — which is the
point.

Mutations, each reverted and verified byte-identical:

| # | mutation | result |
|---|---|---|
| M2 | drop the trailing `recalculateTrustScore` from `adminOverrideScore` | **RED** 60/1 |
| M3 | the cap stores `100` instead of the override value | **RED** 58/3 |
| M4 | `score > caps[cat]` → `score !== caps[cat]` (a PIN — the D-OVERRIDE alternative) | **RED** 60/1 |
| M1 | `loadCaps` folds with `Math.max` instead of `Math.min` | **GREEN — reported, not buried** |

**M1 stayed green and that is stated rather than hidden.** It is an EQUIVALENT
mutation under these fixtures, not a hole in the pin: that fold only runs when a
category carries TWO active caps (`cur !== undefined`), and every fixture here
creates one. The predicate that actually decides ceiling-versus-pin is
`:318`, and M4 mutates exactly it and goes red. A second-cap fixture would make
M1 bite too, and is not written here because no row grades multi-cap folding.

### 11.4 The comment was false and is now accurate

`TrustAdminService.ts` said *"Set the cap at the override value to lock it in
place"*. A ceiling does not lock anything in place; it only stops a score going
above it. The existing test carried the same word in its title — *"cap override
locks score"* — so the tree asserted the misreading in two places and contradicted
it in none. Both now say what the code does, and point at D-OVERRIDE.

**No verdict moves.** C22 was W and stays W, for the reason it already gave.

---

## 12. The denominator excluded the Trust spec — 2026-09-13, `b7f137a4d`

*Measured in the worktree `claude/trust-arch-lane`, branched from `b7f137a4d` on
`claude/sweet-fermat-fmx7up`. Production (`ajrurzioarfkagpuxfnb`) was read with read-only
queries only: no migration applied anywhere, no flag flipped, no provider enabled, no backfill
run. Code work committed at `8d6ccdf05` and `983cfaf75`; every verdict below was derived by
opening the file at this commit, and the two `C` rows this pass BUILT cite the red-before and
green-after measurement.*

### 12.1 §1's opening sentence is false, and it is why this census read 96.2 %

§1 opens: *"There is no Trust spec, so no single document states what Trust must do."*
The Summary table says the same in one word: **Spec — None.**

`docs/trust/verified-foundation-plan.md` has been in this repository throughout. It is titled
*Portava Verified Foundation — Phased Plan*; it states five privacy invariants as
*"non-negotiable, encoded in schema + adapter types"*; and it specifies eight phases, `V-0`
through `V-7`, covering identity-verification routes, the client flow, report/block completion,
the moderation queue, Safety Center, age gating, provider go-live and GDPR retention. Its
companion `docs/trust/verified-foundation-README.md` maps every drop-in file to its destination.
This census mentions neither document **zero times** across 619 lines.

It is not a complete Trust *scoring* specification, and
`docs/specs/Portava_Trust_Architecture_Upgrade_v2.md` says so in its first paragraph: *"That
baseline covers verification and moderation; it is not a complete specification of the Trust
scoring model."* That is the correct, narrow reading. The incorrect reading — the one this
census made — is that Trust therefore has no spec at all, and that its denominator could be
built entirely from other surfaces' inbound clauses plus Trust's own code comments.

**The consequence is arithmetic, not rhetorical.** 96.2 % was computed over 52 requirements
that contained **no** verification obligation, **no** moderation-queue obligation, **no**
reporting obligation, **no** age-gating obligation and **no** retention obligation — and the
two rows it could not close were both outside engineering's reach (a deployment and a word).
A denominator that excludes a surface's own specification cannot be wrong about that surface;
it can only be silent. The corrected sentence is:

> **Trust has a spec for verification, moderation, reporting and safety surfaces —
> `docs/trust/verified-foundation-plan.md` — and does NOT have one for scoring. The scoring gap
> is real and is itemised in §12.7. The verification/moderation gap was never a gap in the
> subject; it was a gap in the reading.**

`cross-cutting-obligations.md`'s claim that Trust has "neither a spec nor a census" is
half-wrong in the same way and should be corrected where it is stated, not only here.

### 12.2 Corrected denominator

| | Before | After |
|---|---|---|
| Denominator | 52 | **93** |
| BUILT-AND-CORRECT | 50 | **69** |
| BUILT-BUT-WRONG | 2 | **15** |
| NOT-BUILT | 0 | **8** |
| CANNOT-VERIFY | 0 | **1** |
| CONSTRUCTED % `(C+W)/n` | 100.0 % | **90.3 %** (84/93) |
| CORRECT % `C/n` | 96.2 % | **74.2 %** (69/93) |

**The 52 are preserved, not replaced.** Every one keeps its id and its verdict; §12.8 records
the nine that were re-executed at this commit and the two caveats that measurement corrected.
41 rows are added: 35 from the verified-foundation plan (5 privacy invariants + 30 rows over
its 29 phase bullets, one bullet split) and 6 from `Portava_Trust_Architecture_Upgrade_v2.md`.
The other six TRV2 requirements are duplicates of ground already counted and add nothing —
§12.6 states the decision and the reason for all twelve, one line each.

Verdict grammar is this document's own: `C` BUILT-AND-CORRECT · `W` BUILT-BUT-WRONG ·
`NB` NOT-BUILT · `CV` CANNOT-VERIFY. **A parent requirement with several mandatory criteria
cannot be `C` unless every criterion passes**; the failing criterion is named in the cell.
Paths are relative to `artifacts/api-server/src/` unless they begin `travel-buddy-standalone/`,
`db/` or `docs/`.

### 12.3 The five privacy invariants — `TV-P1`…`TV-P5`

The plan calls these *"non-negotiable, encoded in schema + adapter types"*. Two of the five are
held by the schema; three are not.

| # | Invariant | Verdict | Evidence at `b7f137a4d` |
|---|---|---|---|
| TV-P1 | Portava never stores raw government-ID images, document numbers, or selfies — opaque provider references only | **C** | `identity_verifications` carries exactly `id, user_id, provider, provider_session_id, provider_verification_ref, status, failure_reason, is_over_18, selfie_match, document_country, verified_at, expires_at, created_at, updated_at` — read from production 2026-09-13 and identical to `db/migrations/0161_identity_verification.sql:15-46#create table if not exists identity_verifications (`. No image, document-number or selfie column exists. `VerificationResult` declares no such field (`services/identityVerification/types.ts:58-69#export interface VerificationResult {`) and `persistResult` writes only that patch (`routes/verification.ts:147-182#const patch: Record<string, unknown> = {`). **Caveat, recorded rather than waived: nothing ENFORCES this.** No guard rejects a future adapter that adds a column; the invariant is held by the current shape, not by a mechanism. |
| TV-P2 | Portava never stores date of birth — age gating stores a derived `is_over_18` boolean only | **W** | Inverted in practice. `profiles.date_of_birth` and `rent_buddy_profiles.date_of_birth` both exist in production, and **7 of 58 profiles hold a DOB** (read-only count, 2026-09-13). `lib/travelerVerification.ts:17-22#profiles.date_of_birth` states the age signal IS `profiles.date_of_birth` "with NO `dob_verified` gate", reads it at `lib/travelerVerification.ts:66#const dateOfBirth = (row["date_of_birth"] as string`, and names five other gates that read it alone (`profile.ts`, `events.ts`, `meetups.ts`, `requests.ts`, `discovery.ts`). `routes/profile.ts:608#row.date_of_birth = p.dateOfBirth;` writes it. `travel-buddy-standalone/src/components/AgeGate.tsx:39-47#function computeAge(dob: string` computes age from the DOB string client-side. Meanwhile `is_over_18` is written once (`routes/verification.ts:150#is_over_18:     result.isOver18   ?? null,`) and read by **no gate anywhere** — the only other references are the status route's SELECT list and tests. The stored value is the DOB and the dead column is the derived boolean, which is the exact reverse of the invariant. Owner decision **D-DOB** (§12.7). |
| TV-P3 | Verification rows deletable per-user for GDPR erasure without destroying moderation audit history (reports/actions use SET NULL) | **W** | Three of four criteria hold. Verification rows delete per user: `services/accountDeletion/AccountDeletionService.ts:1016-1021#const verOk = await step(steps, "delete_identity_verifications", async () => {`. **Reports** use SET NULL on all three user columns — `moderation_reports_reporter_id_fkey`, `_resolver_id_fkey`, `_subject_user_id_fkey`, each `ON DELETE SET NULL` (production, 2026-09-13; staged by `migrations/2135_deletion_blocking_fks.sql:129-140#-- ── 2. moderation_reports.reporter_id — nullable so its SET NULL can fire ──`). **ACTIONS do not.** `moderation_actions_target_user_id_fkey` is `ON DELETE CASCADE`, so erasing the subject destroys every enforcement record about them — the opposite of "without destroying moderation audit history" — and `moderation_actions_performed_by_fkey` is plain NO ACTION, which BLOCKS erasing a moderator rather than nulling them. `migrations/2138_profiles_fk_convergence_prep.sql:103#('moderation_actions','performed_by','SETNULL'),` lists `('moderation_actions','performed_by','SETNULL')` as intended; production has not converged. Owner decision **D-MODACTION-FK**. |
| TV-P4 | The mock provider is refused in production by the factory | **C** | `services/identityVerification/providers.ts:151#if (name === 'mock') {` throws `IDENTITY_PROVIDER=mock is not allowed in production` when `NODE_ENV === 'production'`, before returning the adapter. `services/identityVerification/readiness.ts:96#if (provider === "mock") {` reports the same fact without throwing, for callers that need to ask rather than act. Re-executed as an assertion at this commit: `test/verificationWebhookProviderUnavailable.test.ts` test 1 is a premise test that the factory really does throw, so the three tests below it cannot pass vacuously. |
| TV-P5 | Webhooks are signature-verified in every real adapter; an unverified webhook throws, never silently accepts | **W** | Two criteria; one now passes, one is not written. **Signature verification: absent.** There is no real adapter — `providers.ts:87#const stripeProvider: IdentityVerificationProvider = {` (Stripe) and `providers.ts:119#const personaProvider: IdentityVerificationProvider = {` (Persona) throw "not configured" from every method including `handleWebhook`, so no signature is ever checked. The contract is declared (`services/identityVerification/types.ts:88-92#* Verify + normalize an incoming webhook. Returns null for events we`, "MUST throw on signature failure") and the route honours a throw with 400 (`routes/verification.ts:372#res.status(400).json({ error: "invalid_signature", message: "Webhook signature verificatio`), but the verifying code does not exist. Grading this vacuously true because "every real adapter" quantifies over an empty set would be weakening the requirement; V-6 lists "webhook signature verification" as outstanding agent work and TV-6b carries it. **"Never silently accepts": BUILT THIS PASS.** `webhookHandler` answered **200** when the factory threw, under the comment "provider not configured; treat as irrelevant" — and that throw is the NORMAL production behaviour of the default `IDENTITY_PROVIDER=mock`, i.e. TV-P4's own mechanism. So the rule keeping the mock out of production was also making the public webhook endpoint accept every real event, write nothing, log nothing and tell the provider it was handled. Now 503 with the error bound and logged (`routes/verification.ts:357#res.sendStatus(503);`), matching the persist branch below it; 400 deliberately not reused, because that means "your signature failed" and would send an operator to the wrong system. RED 2 pass/3 fail → GREEN 5/5 (`test/verificationWebhookProviderUnavailable.test.ts`), with a control proving an event the adapter deliberately ignores is still answered 200. |

### 12.4 Phases V-0 … V-7 — `TV-0a`…`TV-7c`

**V-0 is marked `[x]` DONE with five checked boxes. The framing document is explicit that "a
historical 'done' label is a claim to verify, not evidence of current completion", so each box
was opened.** Three of the five are true, one is partly true, and one names a file that does
not exist anywhere in this repository.

| # | Obligation | Verdict | Evidence at `b7f137a4d` |
|---|---|---|---|
| TV-0a | `[x]` Schema: `identity_verifications`, `moderation_reports`, `moderation_actions`, profile `verification_level` + `verified_at` (`0161_identity_verification.sql`) | **W** | All four objects exist in production — but not from that file, and one of them has the wrong shape. `db/migrations/0161_identity_verification.sql` is a drop-in that was **never added to the applied migration set**: `migrations/` holds 528 files and not one mentions `identity_verifications`. The table reached production through `baseline/20260819_baseline_structure.sql:6788#CREATE TABLE public.identity_verifications (`; `moderation_reports` through `artifacts/api-server/src/migrations/0176_moderation_reports.sql:15-28`, whose own header records that the UI wave shipped the route with no migration; `moderation_actions` from a pre-baseline root. **And `moderation_actions` is not the table 0161 describes.** Production columns are `id, target_user_id, action_type, reason, performed_by, created_at, metadata` — **no `report_id`** and **no `expires_at`** (read 2026-09-13). 0161 declares both. So V-4's "suspend with expiry" and the report→action link are not expressible in the live columns; `lib/moderationAudit.ts:35-37#// metadata jsonb (0164) — the only place the content item and the` records the workaround in its own comment ("the only place the content item and the originating report can be recorded; there are no columns for either"). Owner decision **D-MODACTION-SHAPE**. The profile field also landed with a CHECK constraint that rejects the values the service writes — TV-1c. |
| TV-0b | `[x]` Provider adapter interface + normalized status model (`types.ts`) | **C** | `services/identityVerification/types.ts:17-102#export type VerificationProviderName = 'mock'`: `VerificationProviderName`, `NormalizedVerificationStatus` (7 values, matching the live CHECK on `identity_verifications.status`), `NormalizedFailureReason` (6), `IdentityVerificationProvider` with all four methods, `toVerificationLevel` at `services/identityVerification/types.ts:105-110#export function toVerificationLevel(`. Re-exported for in-package use at `services/identityVerification/index.ts:6-17#export { getIdentityProvider } from './providers.js';`. |
| TV-0c | `[x]` Working mock provider with forced-failure test hints (`mockProvider.ts`) | **C** | `services/identityVerification/mockProvider.ts:90-142#export const mockProvider: IdentityVerificationProvider = {` implements all four methods; the four hints (`approve`, `fail_document`, `fail_selfie`, `fail_underage`) resolve to the correct normalized failure reasons at `services/identityVerification/mockProvider.ts:52-87#switch (s.hint) {`. Exercised end to end, not merely present: `test/verification.test.ts` drives create → webhook → status against it. |
| TV-0d | `[x]` Stripe/Persona stubs + env-driven factory (the prod-guard criterion is counted once, at TV-P4) | **C** | `providers.ts:87#const stripeProvider: IdentityVerificationProvider = {` and `providers.ts:119#const personaProvider: IdentityVerificationProvider = {` are stubs with the full integration mapped in comments (`services/identityVerification/stripeIdentity.ts:28# *   createSession            -> POST /v1/identity/verification_sessions`, `services/identityVerification/persona.ts:14# *   createSession            -> POST /api/v1/inquiries   (+ one-time link)`); `getIdentityProvider:102-117` selects on `IDENTITY_PROVIDER` and rejects an unknown name. "Stub" here means every method throws, which is what TV-P5 and TV-6b grade; as a *stub + factory* the box is true. |
| TV-0e | `[x]` `VerifiedBadge` component (teal = ID verified, gold = ID + selfie) | **NB** | **No such file exists anywhere in the repository.** A case-insensitive search for `VerifiedBadge` returns four hits, all of them inside the two plan documents themselves (`docs/trust/verified-foundation-README.md:15#travel-buddy-standalone/src/components/VerifiedBadge.tsx`, `docs/trust/verified-foundation-README.md:27#VerifiedBadge`, `docs/trust/verified-foundation-plan.md:31#component (teal = ID verified, gold = ID + selfie)` and `docs/trust/verified-foundation-plan.md:58#beside names in: profile header, traveler cards,`). `travel-buddy-standalone/src/components/` holds `FeaturedBadge.tsx`, `OfficialBadge.tsx`, `PassportVerificationStamp.tsx`, `StampOverlayBadge.tsx` and `VerificationLevelsRail.tsx`; none of them reads `profiles.verification_level`. A `[x]` DONE box that was never true in this tree. |
| TV-1a | `POST /api/verification/session` — auth required; creates the provider session for the caller; upserts the row in `created` status; returns `redirectUrl` | **W** | Four criteria, three pass. Auth required ✓ `routes/verification.ts:193-196#router.post("/verification/session", asyncHandler(async (req, res) => {` (`requireUser` first). Creates the caller's session ✓ `routes/verification.ts:238-243#session = await provider.createSession({` (`userId: user.id`). Returns `redirectUrl` ✓ `routes/verification.ts:303-307#res.status(201).json({`, and the 23505 branch returns the existing active session rather than a raw DB error `routes/verification.ts:265-286#if ((insertError as any).code === "23505") {`. **Status ✗:** the insert writes `status: "pending"` (`routes/verification.ts:257#status:`), not `created`. Both are legal values of the live CHECK and no consumer behaves differently (`travel-buddy-standalone/app/profile/verification.tsx:44#const POLL_INTERVAL_MS = 4_000;` treats `created`/`pending`/`processing` alike), so the effect is nil — but the stated criterion is `created` and it is not met, and a parent row cannot be `C` on three of four. |
| TV-1b | `POST /api/verification/webhook` — raw-body route; passes to `provider.handleWebhook`; on a normalized result, updates the row | **C** | Raw body ✓ — mounted in `app.ts:129#app.post("/api/verification/webhook", verificationWebhookRawParser, verificationWebhookHan` with `express.raw` BEFORE the global JSON parser (`routes/verification.ts:314#export const webhookRawParser = express.raw({ type: () => true, limit: "512kb" });`), and deliberately not re-registered on the router (`routes/verification.ts:396-398#// NOTE: /verification/webhook is mounted in app.ts BEFORE the global JSON parser`). Passes the headers and raw body to the adapter ✓ `routes/verification.ts:363-366#result = await provider.handleWebhook({`. Updates the row on a normalized result ✓ `persistResult:128-132`, with the lookup-by-session error bound and rethrown at `routes/verification.ts:105#eventType: "identity_verified",` so an unreadable table cannot masquerade as an unknown session. Irrelevant events are acknowledged, not persisted ✓ `routes/verification.ts:376-379#if (!result) {`. |
| TV-1c | …and, when `verified`, sets `profiles.verification_level` via `toVerificationLevel()` and `verified_at` *(SPLIT out of V-1's webhook bullet: separately testable, separately load-bearing, and separately broken)* | **W** | The code is right and **the database rejects it.** Measured read-only on production 2026-09-13: `profiles_verification_level_check` is `CHECK ((verification_level = ANY (ARRAY['none','basic_verified','trusted_traveler','host_verified','buddy_verified'])))`. `toVerificationLevel` returns `'id_verified'` or `'id_selfie_verified'` (`services/identityVerification/types.ts:105-109#export function toVerificationLevel(`), and `applyVerifiedProfile` writes exactly that (`routes/verification.ts:68-75#const { error } = await client`). Every successful verification is a 23514. The handler binds the error and throws, `webhookHandler` returns 5xx so the provider retries — **and the retry writes the same rejected value**. No user can reach a non-`none` level, which is the column `lib/travelerVerification.ts:85-88#(typeof row["verification_level"] === "string" && row["verification_level"] !== "none")` reads as the ID signal and `routes/rentABuddyRollout.ts` gates bookings on. Open as audit **H5** since 2026-08-30 (`docs/handoff/2026-08-30-session-handoff.md:117#**H5 — verification vocabulary mismatch.**`, proved on CI there), invisible to every existing test because they all use an injected fake with no schema knowledge (`test/verification.test.ts:280#it("returns verificationLevel from profiles when set to id_verified", async () => {` asserts `id_verified` round-trips through a double that would accept any string). **Staged this pass, not applied:** `migrations/2870_profiles_verification_level_identity_vocabulary.sql` widens the CHECK additively, with `db/rollback/2026-09-13-2870-profiles-verification-level-identity-vocabulary-rollback.sql` that REFUSES to run while any identity level exists. Stays `W` because the migration is applied to no database — grading it `C` on a staged file would be the "merged is not deployed" error this census made its name on. |
| TV-1d | `GET /api/verification/status` — the caller's current verification row (poll fallback) | **C** | `routes/verification.ts:401-452#router.get("/verification/status", asyncHandler(async (req, res) => {`. Both reads bind `error`: the row read refuses at `routes/verification.ts:418-420#if (rowErr) {`, and the profile read refuses at `routes/verification.ts:441-443#if (profileErr) {` rather than letting `?? "none"` convert an unreadable `profiles` into "you are not verified" — a false statement the caller cannot act on, in a signal that gates bookings. Pinned by `test/verificationStatusUnreadableProfile.test.ts`. |
| TV-1e | Rate limits: max 3 session creations per user per 24 h | **C** | `routes/verification.ts:32-33#const VERIFICATION_SESSION_LIMIT = 3;` (`VERIFICATION_SESSION_LIMIT = 3`, 24 h window), enforced first in the handler at `routes/verification.ts:199-205#const rl = checkRateLimit("verification_session", user.id, VERIFICATION_SESSION_LIMIT, VER` with a `Retry-After` header and an explicit retry timestamp. Covered by `test/verification.test.ts`. |
| TV-1f | Trust Score hook: on transition to `verified`, emit the existing trust event the platform uses | **C** | **Built correct this pass.** The event is the declared one (`services/trust/TrustEventService.ts:815#IDENTITY_VERIFIED:        { category: "respect_safety" as TrustCategory,  delta: 10, sever`, `IDENTITY_VERIFIED` → respect_safety +10) and is emitted at `routes/verification.ts:103-109#await recordTrustEvent(client, {`. It was emitted **without a `sourceId`**, and `TrustEventService.isDuplicate:242` opens `if (!sourceId) return "new"` — so the emitter had no idempotency key and every call was a first call. Provider webhooks are at-least-once by construction and this handler returns 5xx on a persist failure *on purpose* so they retry, so the one path built to be re-entered was the one path with no key: each redelivery charged another +10 until the daily cap absorbed it. V-1 defines the hook per TRANSITION, not per delivery. Now keyed on the provider session id with `sourceType` carried alongside (the dedup read filters on both). RED 1 pass/2 fail → GREEN 3/3 (`test/verificationTrustIdempotency.test.ts`); reverting the two added lines returns it to 1/2. Whether +10 is the right magnitude is scoring policy and is already parked at §5 item 5 — this row does not claim it. |
| TV-1g | Tests: mock-provider end-to-end, forced failures map to correct reasons, rate limit | **C** | `test/verification.test.ts` (create → webhook approve → profile level set; the four forced-failure hints; the rate limit), `test/verificationWritesIssued.test.ts` (writes are ISSUED, not merely constructed), `test/verificationStatusUnreadableProfile.test.ts`. 48/48 at this commit before this pass; 59/59 after, with the three files added. **Caveat recorded, because it is the reason TV-1c survived a year of green suites: every one of these runs against an injected fake client with no schema knowledge, so none of them can see a CHECK constraint.** `test/verificationLevelVocabulary.test.ts` is the answer to that class and is new this pass. |
| TV-2a | Entry points: Passport profile ("Get verified"), Rent-a-Buddy gate | **W** | Passport ✓ — `travel-buddy-standalone/src/components/passport/PassportOwnerMenuSheet.tsx:219#action: (p) => { closeThenNavigate(p.onClose, '/profile/verification'); },` and `app/explore-portava.tsx:139#{ key: 'pp-verification',label: 'Verification',      Icon: ShieldCheck,  iconColor: '#2563` both route to `/profile/verification`, registered at `src/navigation/portavaRoutes.ts:352#path: 'profile/verification',`. **Rent-a-Buddy gate ✗** — no screen under `app/(rent-a-buddy)/` routes to verification. The server-side gate exists (`routes/rentABuddyRollout.ts` refuses an MVP-mode booking without ID verification) but a user it refuses is given no route to satisfy it; `app/(rent-a-buddy)/index.tsx:37` only describes verification in FAQ copy. |
| TV-2b | Screens: intro (what/why/**what we never store**) → provider hand-off → pending → success / failure with retry | **W** | Hand-off ✓ `travel-buddy-standalone/app/profile/verification.tsx:109-114#const canOpen = await Linking.canOpenURL(redirectUrl).catch(() => false);` (`Linking.openURL(redirectUrl)` with a fallback alert). Pending ✓ `travel-buddy-standalone/app/profile/verification.tsx:91-93#const rowStatus = status?.verificationRow?.status;` (4 s poll while the row is in an active status). Success/failure with retry ✓ `travel-buddy-standalone/app/profile/verification.tsx:242-246#{!isActive && (!isVerified`. **"What we never store" ✗** — the intro section is `WHAT YOU GET` (`travel-buddy-standalone/app/profile/verification.tsx:221-238#{/* What verification unlocks */}`): a verified badge, a higher trust score, access to verified-only features. There is no privacy disclosure on the screen at all. That clause is the user-facing half of TV-P1/TV-P2 and it is the one the plan wrote in bold-by-parenthesis; a verification flow that never says what is not kept is asking for a government ID on an unstated basis. |
| TV-2c | Render `VerifiedBadge` beside names in profile header, traveler cards, Rent-a-Buddy listings, reviews, event attendee lists — inside `UserIdentityLink` | **NB** | Six criteria, zero met, and they cannot be met: the component does not exist (TV-0e). `travel-buddy-standalone/src/components/interaction/UserIdentityLink.tsx` contains no occurrence of `verification` or `verified` — the wrapper the plan names as the placement is unaware of the concept. No traveler card, listing, review or attendee list renders a verification badge. |
| TV-2d | Failure UX: clear reason ("document couldn't be read", "selfie didn't match") + retry path; `underage` routes to an age-policy screen and does NOT allow retry spam | **W** | A reason is shown, so something is built — but it is the raw enum with underscores replaced (`app/profile/verification.tsx:202-206#{row.failureReason ? (`: `row.failureReason.replace(/_/g,' ')` renders "document invalid", "selfie mismatch", "underage"), not the human copy the plan specifies. **`underage` is not special-cased at all**: `isFailed` at `app/profile/verification.tsx:126#const isFailed = row?.status === 'failed'` is true for every failure regardless of reason, so the `GET VERIFIED` CTA re-renders at `travel-buddy-standalone/app/profile/verification.tsx:242#{!isActive && (!isVerified` and an underage user is invited to retry immediately — the retry spam the clause exists to prevent. No age-policy screen exists. |
| TV-3a | Report entry points: profile overflow, post/comment overflow, Telegraph thread menu, event page, buddy listing, review | **C** | All six, each opening the unified `ReportSheet`: profile `app/u/[username].tsx`; post `app/post/[id].tsx`; comment `src/components/CommentsSheet.tsx`; Telegraph thread `src/components/ThreadSafetySheet.tsx:38#import { ReportSheet } from './ReportSheet.tsx';` and `src/components/ThreadSafetySheet.tsx:258#{canUseReportSheet && (` (DM threads, via `canUseReportSheet` at `src/components/ThreadSafetySheet.tsx:145#const canUseReportSheet = threadType === 'direct' && !!otherUserId;`); event `app/event/[id].tsx`; buddy listing `app/(rent-a-buddy)/buddy/[id].tsx`; review `src/components/ReviewsSection.tsx:313-321#{reportTarget && (`, which passes `subjectType="review"` and the author id. Server-side, `review` resolves to an owner at `lib/contentOwner.ts:112#review:      ["reviews",         "reviewer_id"],`. |
| TV-3b | Report sheet: category picker matching `moderation_reports.category`, optional details, confirmation; writes via a server route so the server can attach `subject_user_id` | **C** | `src/components/ReportSheet.tsx:2-10#* ReportSheet — unified 3-step report+block bottom sheet.` is a 3-step report+block sheet; the category union at `src/services/moderation.ts:30-38#export type ModerationCategory =` is exactly the eight values of the live CHECK (`artifacts/api-server/src/migrations/0176_moderation_reports.sql:22-24`); details are optional (`routes/moderation.ts:50#details:     z.string().max(500).optional().nullable(),`); step 3 is the confirmation. The write goes through `POST /api/moderation/report`, and `subject_user_id` is derived server-side at `routes/moderation.ts:161-162#const subjectOwner = await resolveSubjectOwner(sc, subjectType, subjectId);` via the shared resolver — never client-supplied (the schema at `routes/moderation.ts:46-55#const ReportSchema = z.object({` has no field for it). |
| TV-3c | Block flow already exists platform-wide — each report entry point also offers Block, reusing the existing block service | **C** | The block is inside the same sheet every entry point mounts, so the coverage is structural rather than six separate wirings: `src/components/ReportSheet.tsx:6#* Step 3: Confirmation + optional "Also block" CTA` ("Step 3: Confirmation + optional 'Also block' CTA"), `src/components/ReportSheet.tsx:26#import { blockUser, unblockUser } from '../services/blocks.ts';` imports `blockUser`/`unblockUser` from the existing `services/blocks.ts`, `travel-buddy-standalone/src/components/ReportSheet.tsx:78-79#const { blockedIds, addBlock, removeBlock } = useBlockedIds();` reads `BlockedIdsContext` so an already-blocked subject shows "Unblock", `travel-buddy-standalone/src/components/ReportSheet.tsx:138-157#async function handleBlock() {` performs it. Gated on `subjectUserId` being known (`travel-buddy-standalone/src/components/ReportSheet.tsx:9#* "Block" is only available when subjectUserId is provided.`), which is correct: a place report has no user to block. |
| TV-3d | Reporter sees "we received it"; no visibility into outcomes beyond a generic notification if actioned *(SPLIT: the reporter-facing direction; A7/C20 keep the do-not-expose-to-others direction)* | **C** | Both directions of the acknowledgement return the same string and nothing else: `routes/moderation.ts:139-141#reportId: (existing as any).id,` (duplicate collapse) and `routes/moderation.ts:247-250#reportId: (report as any).id as string,` (new report) answer `{ reportId, message: "Thanks — our team will review this." }`. `GET /moderation/reports/mine:265-272` selects `id, subject_type, category, status, created_at` — no `resolver_id`, no `resolver_note`, no `subject_user_id`, so the reporter learns that a report exists and its coarse state and nothing about the adjudication or the subject. |
| TV-4a | Admin-only queue: list open reports, filter by category/status, view subject content snapshot, act (warn / remove content / suspend with expiry / ban / dismiss), every action writing `moderation_actions` | **W** | Five criteria, one and a half pass. **List ✓** `routes/admin.ts:2103#router.get("/admin/moderation/reports", async (req, res) => {`, `requireAdmin` first at `routes/admin.ts:2104#requireAdmin(req, res, { withDisplayName: true })`, with a client at `travel-buddy-standalone/app/admin/content-reports.tsx`. **Filter ✗ (half)** — the route filters `subject_type` and `status` (`routes/admin.ts:2123#query = query.eq("subject_type", subjectType);`); there is **no category filter**, which is the axis the plan names and the axis a moderator triages on. **Subject content snapshot ✗** — only `place` reports are enriched, with name and address (`routes/admin.ts:2135#const placeIds = [`); a reported post, comment, message, event, review or buddy listing arrives as a bare UUID. **Act ✗** — no route acts on a `moderation_reports` row at all: `POST /admin/reports/:id/resolve` and `/dismiss` operate on the separate legacy `reports` table, and nothing updates `moderation_reports.status`, so the queue can only grow. **Every action writing `moderation_actions` ✓ at user level, ✗ as specified** — `/admin/users/:userId/{warn,restrict,suspend,ban,restore}` each call `logModerationAction` (`routes/admin.ts:1683#const auditR = await logModerationAction(sc, userId, adminUserId, "warn", reason, {` (warn), `routes/admin.ts:1712#const auditR = await logModerationAction(sc, userId, adminUserId, "message_limit", reason);` (restrict), `routes/admin.ts:1733#const auditR = await logModerationAction(sc, userId, adminUserId, "temporary_suspension", reason);` (suspend), `routes/admin.ts:1779#const auditR = await logModerationAction(sc, userId, adminUserId, "permanent_ban", reason);` (ban), `routes/admin.ts:1825#const auditR = await logModerationAction(sc, userId, adminUserId, "account_restored", reason);` (restore)`), but they are reached from a user, not from a report, and the row cannot name the report because the column does not exist (TV-0a). "Suspend with expiry" is likewise unrecordable: `routes/admin.ts:1729#null = (req.body as any)?.expires_at ?? null;` accepts `expires_at` and stores it in `user_account_states`, while `moderation_actions` has no `expires_at` at all. |
| TV-4b | Suspension enforcement middleware on auth: suspended users get a read-only state with an appeal contact; banned users are signed out | **W** | Three criteria, one passes. **Middleware on auth ✓** — `artifacts/api-server/src/lib/http.ts:370-375#if (accountStatus === "banned") {`, inside `requireUser`, so it covers every authenticated route, and `artifacts/api-server/src/lib/http.ts:352-364#if (statusRead.state === "unavailable") {` refuses outright when `account_status` is unreadable rather than serving an unchecked request. **Read-only state with an appeal contact ✗** — a suspended user gets a blanket 403 `"Your account is temporarily suspended"` on every authenticated request: not read-only, and naming no appeal contact, although `routes/appeals.ts` and `travel-buddy-standalone/app/appeals.tsx` both exist and nothing points at them from here. **Banned users signed out ✗** — also a 403 (`artifacts/api-server/src/lib/http.ts:371#sendError(res, "forbidden", "Your account has been banned");`); `src/components/AccountStatusGate.tsx` has branches for `deactivated` and pending deletion and none for suspended or banned, so the client has no state to render either. Owner decision **D-SUSPENSION-UX**. |
| TV-4c | `verification_revoked` action clears `profiles.verification_level` | **C** | **Built this pass.** `POST /admin/users/:userId/unverify` is the platform's revoke action and cleared `verified`, `verification_status` and `verified_at` — the exact inverse of what `/verify` sets, which is why it looked complete. A fourth column carries the same claim and is written by a different path: `profiles.verification_level` has exactly ONE writer in the server (`routes/verification.ts:71#verification_level: level,`), and `lib/travelerVerification.ts:85-88#(typeof row["verification_level"] === "string" && row["verification_level"] !== "none")` reads it as a **sufficient** id-verified signal, ORed with the other two rather than ANDed. Clearing two of three disjuncts revoked nothing: an admin unverifying a user after a disputed document left them passing every gate that calls `loadTravelerIdentity`, including the Rent-a-Buddy MVP booking gate. And nothing else could clear it — the single writer only ever sets a verified level — so no code path in the product could take ID-verified standing away. Now cleared at `routes/admin.ts:1655#verification_level: "none",`. RED 5 tests/3 pass/2 fail → GREEN 5/5 (`test/adminUnverifyRevokesIdLevel.test.ts`); reverting the single added field returns it to 3/2. The test asserts the OUTCOME — it applies the patch the route actually sent and asks `travelerIdentityFromProfile` — plus a premise test, an audit assertion and a control. Reversing derived TRUST effects is deliberately not done here: that is **D-REVERSAL** and is `TRV2-10`'s CANNOT-VERIFY. |
| TV-5a | Safety Center screen: links to Safe Return, SOS, verification status, blocked-users list, community guidelines, report history | **W** | Four of six. The hub exists at `travel-buddy-standalone/app/profile/edit/safety.tsx` ("Safety & Verification"): verification status ✓ `travel-buddy-standalone/app/profile/edit/safety.tsx:72-80#<SettingsSection title="Identity Verification">` (read-only cards from `getMyProfile`), blocked-users ✓ `travel-buddy-standalone/app/profile/edit/safety.tsx:102-104#title="Blocked Users"`, report history ✓ `travel-buddy-standalone/app/profile/edit/safety.tsx:126-128#title="Your Reports"` → `/profile/edit/reports`, Safe Return ✓ `travel-buddy-standalone/app/profile/edit/safety.tsx:143-145#title="Safe Return"` (linked to Location & Availability rather than duplicated). **SOS ✗** and **community guidelines ✗** — neither appears on the screen, and a repository-wide search for a community-guidelines surface returns none. |
| TV-5b | Age gating: 18+ features (nightlife-tagged events, Rent a Buddy) check `is_over_18` from the latest verified row; unverified users see a "verify to access" gate, not silent hiding | **NB** | `is_over_18` is written at `routes/verification.ts:150#is_over_18:     result.isOver18   ?? null,` and read by **no gate**. Every age gate in the product reads `profiles.date_of_birth` instead — `lib/travelerVerification.ts:66#const dateOfBirth = (row["date_of_birth"] as string`, `routes/meetups.ts:668#resolveGateAges(sc,` and `routes/meetups.ts:746#resolveGateAge(sc,`, `routes/requests.ts:454#.select("date_of_birth")` and `routes/requests.ts:485#const dob = (profileRes.data as any)?.date_of_birth ?? null;`, `routes/profile.ts:453#gateAgeFrom(`, `services/media/MediaProjectionService.ts:110#.select("location_country")`, `routes/mediaFeed.ts:1328#.select("location_country")` — which is TV-P2's violation seen from the consumer side. No nightlife-tagged-event gate exists at all, and there is no "verify to access" surface: `AgeGate.tsx` asks for a birthdate, which is the opposite mechanism. |
| TV-6a | **OWNER:** choose Stripe Identity or Persona; create the account; obtain API keys; configure the webhook endpoint + signing secret; set Replit Secrets (`IDENTITY_PROVIDER`, provider keys, `IDENTITY_WEBHOOK_SECRET`) | **NB** (OWNER-BLOCKED) | Not started and not startable by a lane. `services/identityVerification/readiness.ts:53#const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);` declares `IMPLEMENTED_PROVIDERS = new Set(["mock"])`; `services/identityVerification/readiness.ts:56#const REQUIRED_ENV: Record<string, string> = {` names the env vars that would have to exist (`STRIPE_IDENTITY_SECRET_KEY`, `PERSONA_API_KEY`). **Exactly what is needed, so the owner can act without reading code:** (1) a decision between Stripe Identity and Persona; (2) an account with that vendor; (3) the API key(s) — `STRIPE_IDENTITY_SECRET_KEY`, or `PERSONA_API_KEY` + `PERSONA_TEMPLATE_ID`; (4) a webhook endpoint registered at `POST https://<api-host>/api/verification/webhook`; (5) the signing secret from that registration, as `IDENTITY_WEBHOOK_SECRET`; (6) all of it in Replit Secrets, plus `IDENTITY_PROVIDER` set to the chosen name **in staging first**. Costs ~$1.50–3.00 per attempt at both vendors (plan, "Cost checkpoints"). Owner decision **D-PROVIDER**. |
| TV-6b | **AGENT:** implement the chosen adapter per the mapped TODOs; sandbox-mode end-to-end test; then flip `IDENTITY_PROVIDER` staging → production *(the signature-verification criterion is counted once, at TV-P5)* | **NB** | Nothing implemented: both adapters throw from every method (`providers.ts:87#const stripeProvider: IdentityVerificationProvider = {`, `providers.ts:119#const personaProvider: IdentityVerificationProvider = {`). Genuinely blocked on TV-6a for the account-dependent half, and **that is not a reason this row is untouched** — the integration is mapped line by line in the file (`services/identityVerification/stripeIdentity.ts:28# *   createSession            -> POST /v1/identity/verification_sessions` Stripe, `services/identityVerification/persona.ts:14# *   createSession            -> POST /api/v1/inquiries   (+ one-time link)` Persona) and the normalization notes are written, so the remaining agent work is real and specified. It was not done here because implementing an adapter that cannot be sandbox-tested would produce exactly the mock-counted-as-complete this census forbids: `services/identityVerification/readiness.ts:41#* ── ADD YOUR PROVIDER HERE WHEN A SANDBOX RUN HAS CERTIFIED IT ──────────────` states the rule in the file itself — a provider joins `IMPLEMENTED_PROVIDERS` when its adapter stops throwing, and *"leaving a stub out of this set is what keeps the Rent-a-Buddy booking gate closed."* |
| TV-7a | Account-deletion flow calls `provider.requestProviderDeletion()` **then** deletes the user's `identity_verifications` rows | **W** | Two criteria; the second passes and the first does not. Deletion ✓ `services/accountDeletion/AccountDeletionService.ts:1016-1021#const verOk = await step(steps, "delete_identity_verifications", async () => {` (`delete().eq("user_id", userId)`, as a named, checked step). **`requestProviderDeletion` ✗** — declared at `services/identityVerification/types.ts:101#requestProviderDeletion(providerVerificationRef: string): Promise<void>;`, implemented as a no-op by the mock (`mockProvider.ts:139-141#async requestProviderDeletion(): Promise<void> {`), mapped for both real vendors in comments (`services/identityVerification/stripeIdentity.ts:33# *   requestProviderDeletion  -> POST /v1/identity/verification_sessions/:id/redact` `verificationSessions.redact`, `services/identityVerification/persona.ts:19# *   requestProviderDeletion  -> POST /api/v1/inquiries/:id/redact` `POST /inquiries/:id/redact`), and **called from nowhere**: a repository-wide search returns only the declaration, the two stubs, the mock and the comments. So erasure deletes Portava's opaque reference and leaves the provider's copy of the government ID in place — the one direction of GDPR erasure that is not Portava's to keep. The ordering the plan specifies ("then") is also lost: once the row is deleted, `provider_verification_ref` is gone and the deletion can no longer be requested. |
| TV-7b | Retention job: purge failed/expired verification rows older than 90 days | **NB** | No such job exists. `lib/trustMaintenanceScheduler.ts` runs four steps (decay refresh, cap expiry, probation, gaming scan) and names no verification table; no scheduler, cron or script anywhere reads `identity_verifications` with a date bound. `expires_at` is written (`routes/verification.ts:250#// Persist to DB — catch the unique-index conflict (one active session per user).`) and never acted on. Nothing is over-retained today only because the table holds 0 rows in production. |
| TV-7c | Document the data flow in the privacy policy surface | **NB** | There is no privacy policy surface in the client to document it in: a search of `travel-buddy-standalone/app` and `src` for a privacy-policy screen, route or link returns nothing, and `app/settings/index.tsx` mentions neither identity verification nor a government-ID check. The disclosure is absent from the verification screen too (TV-2b). |

### 12.5 Sensing §16 — checked before counting, as instructed

`census-sensing`'s SX-47 and SX-48 are already counted here as **A18** and **A19**, and §1
excluded SX-46 as a Safety-surface obligation "whose pipeline ends in `safetyNoticeProducer`,
not the trust engine". Both A18 and A19 were re-executed at this commit (§12.8) and neither
moves. TRV2-01 and TRV2-02 are therefore duplicates and add nothing; TRV2-03 re-states SX-46
with a Trust-side evidence bar ("no suspension or reputation penalty") and is admitted as the
one addition from that ground, cross-listed so the corpus does not count it twice.

### 12.6 TRV2-01 … TRV2-12 — every mapping decision, with its reason

Checked against **all 52 existing rows for semantic overlap**, not merely for a missing
citation. Six are duplicates that add nothing to the denominator; four are splits that add only
their genuinely new clause; two are additions.

| ID | Decision | Existing row(s) it maps onto | Reason |
|---|---|---|---|
| TRV2-01 | **DUPLICATE** | **A19** (Sensing §16:183, SX-48) | Same obligation, stricter wording. A19 already states "do not score a user as trustworthy because passive movement looks normal"; TRV2-01 adds "and anonymous contribution", which A18's scoped-trust separation and `lib/intelScopedTrustApply.ts:141-151#if (error) throw error;` already cover. Re-graded against TRV2's bar ("sensor/aggregate fixtures generate zero person Trust effects"): A19 holds — the only movement-derived person-trust events are negative (`TrustEventService.ts:440-446#const delta = confidence === "high" ? -8 : confidence === "medium" ? -4 : -1;`, −8/−4/−1) and the positive location events require an explicit geofenced action. **Adds nothing.** |
| TRV2-02 | **DUPLICATE** | **A18** (SX-47) | Verbatim the same requirement. Re-executed: `lib/intelScopedTrust.ts` keeps a separate store and `lib/intelScopedTrustApply.ts:147-151#outcomes: num(d.outcomes) ?? 0, successes: num(d.successes) ?? 0, contradictions: num(d.co` bridges only a named signal subset with its own deltas, so no shared-intelligence API can substitute a person score for evidence confidence. **Adds nothing.** |
| TRV2-03 | **ADDITION** | — (SX-46 was explicitly EXCLUDED by §1) | §1 excluded SX-46 as a Safety-surface obligation; TRV2 restates it with a Trust-side bar that §1's reason does not answer ("crowd spike alone causes no **suspension or reputation penalty**"). C6 and C23 forbid auto-penalty for their own inputs, not for world anomalies. **New row, graded below.** |
| TRV2-04 | **DUPLICATE** | **TV-0b, TV-0d, TV-1a, TV-1b, TV-1c, TV-1f, TV-P5, TV-0e, TV-2c** | Every clause of its chain — "session→signed webhook→authorized transition→profile→badge works; duplicates and invalid signatures cannot create additional effects" — lands on a row added in §12.4. Re-graded against its stricter bar rather than added: the chain does NOT work end to end (TV-1c: the profile transition is rejected by the live constraint; TV-0e/TV-2c: there is no badge), duplicates are now inert (TV-1f, fixed this pass), invalid signatures are unverifiable (TV-P5). **Adds nothing.** |
| TRV2-05 | **SPLIT** → +1 | duplicates **TV-P1** (no raw IDs/document numbers/selfies), **TV-P2** (no DOB), **TV-P4** (mock refused in production) | Three of its four clauses are the invariants verbatim. The fourth — "no raw IDs, document numbers, selfies or dates of birth enter Portava storage **or logs**" — is about a different medium, is separately checkable, and no existing row grades it. **New row for the logs clause only.** |
| TRV2-06 | **DUPLICATE** | **C1** (dedup), **C3** (severity → pending_review), **C5** (review queue), **C7** (counterparty explicit), **C21** (admin audit), **TV-1f** (duplicate delivery), **TV-4a** (action attribution) | "Disputed/unconfirmed reports cannot be treated as upheld" is C3+C5; "duplicate deliveries or crashes do not double-charge" is C1 and TV-1f; "admin action is not misattributed" is C21 and TV-4a's audit criterion. Each re-graded; the only movement is TV-1f, which this pass fixed. **Adds nothing.** |
| TRV2-07 | **DUPLICATE** | **A10** (replayable), **C11** (failed read ≠ missing profile), **C16** (degraded reads labelled), **C17** (expiry scheduled), **C25** (scheduler wiring demonstrated) | "Crash/retry/replay produces the approved result; failed reads do not become clean reputation or fabricated denial; scheduler wiring is demonstrated" is a restatement of those five, which §10 already moved to `C` with production evidence for C25. **Adds nothing.** |
| TRV2-08 | **SPLIT** → +1 | duplicates **A12** (hosting, messaging), **A13** (private_plan_access, location_plan_join), **A7** and **C20** (privacy-safe summaries) | A12/A13 name the four seams that enforce; A7/C20 hold the privacy half. The clause "**Compass, Discovery, social and booking paths** enforce applicable existing policy" names four consuming surfaces no existing row grades, and A17 covers only the READ seam, not enforcement. **New row for those consuming actions only.** |
| TRV2-09 | **SPLIT** → +1 | duplicates **C26** (unauthorized caller cannot act), **C21** (actor, reason and subject recorded) | Both halves are already `C` and were re-executed (§12.8). "**Concurrency does not lose active restrictions**" is a third clause no row grades. **New row for concurrency only.** |
| TRV2-10 | **SPLIT** → +1 | duplicates **TV-4c** (revocation reaches eligibility), **TV-7a** (provider deletion requested), **C14** (cap lifted when the finding is reversed), **TV-P3** (deletion lineage) | Four clauses are rows above. The fifth — "derived effects follow **the defined reversal/retention policy**" — depends on a policy the v2 document states does not exist. **New row, and it is this census's one CANNOT-VERIFY.** |
| TRV2-11 | **ADDITION** | — (A6 measures emission, not fabrication) | "No historical stamp, inferred visit or passive contribution becomes a new award absent an explicitly approved backfill policy; test fixtures stay isolated" is a constraint on how requirements may be closed. A6 measures whether evidence reaches the ledger; nothing grades whether it was manufactured. **New row.** |
| TRV2-12 | **DUPLICATE** | **A18** (source reliability is not a person's badge), **TV-0e** and **TV-2c** (the badge), **A9** (non-stigmatizing copy); "unknown reputation is not silently 'established'" is **census-passport P45**, which §2.B counts there and not here | Re-graded rather than added. One finding it surfaces belongs to TV-2c and is recorded there: `travel-buddy-standalone/app/profile/edit/safety.tsx:34-39#const LEVEL_LABEL: Record<NonNullable<OwnProfile['verificationLevel']>, string> = {` maps `verificationLevel` over `none / basic_verified / trusted_traveler / host_verified / buddy_verified`, while `app/profile/verification.tsx:22-26#const LEVEL_LABELS: Record<VerificationLevel, string> = {` maps the same field over `none / id_verified / id_selfie_verified`. The two client screens disagree about the vocabulary of one column, so whichever the server writes, one of them renders a blank label. **Adds nothing.** |

**The four split rows and two additions:**

| # | Requirement | Verdict | Evidence at `b7f137a4d` |
|---|---|---|---|
| TRV2-03 | Anomalies create only policy-eligible safety candidates, not automatic canonical danger; no suspension or reputation penalty from a crowd spike | **C** | The pipeline ends in a review queue, not an assertion. `routes/adminSafetyCandidates.ts:2-25#Safety candidates — Sensing §16`: each candidate "is FILED as a `moderation_reports` row — subject_type `place`, category `safety_concern`, no reporter", and the header states what it does not do — *"It asserts nothing: no snapshot is written, no notice is projected."* `lib/safetyCandidateStore.ts:7-14#— the platform's existing review — and` records that the queue is the platform's existing review and that the service client writes it. Gated fail-closed on `intel_safety_candidates_enabled` (migration 2803, seeded FALSE) and by `requireAdmin`. No person-trust write exists on that path: `recordTrustEvent` is not imported by either file. Cross-listed with census-sensing, whose lane owns the producer. |
| TRV2-05 | No raw IDs, document numbers, selfies or dates of birth enter Portava **logs** | **C** | Every log statement on the verification path binds only the error object and, at most, a user id: `routes/verification.ts:229#req.log.error({ err }, "verification: provider unavailable");`, `routes/verification.ts:245#req.log.error({ err }, "verification: createSession failed");`, `routes/verification.ts:283#req.log.error({ err: activeErr }, "verification: active-session lookup failed after 23505` , `routes/verification.ts:298#req.log.error({ err: insertError }, "verification: insert failed");`, `routes/verification.ts:419#req.log.error({ err: rowErr }, "verification status: fetch failed");` and `routes/verification.ts:442#req.log.error({ err: profileErr, userId: user.id }, "verification status: profile level fetch failed");`, plus the 503 refusal added this pass at `routes/verification.ts:357#res.sendStatus(503);`. The raw webhook body is never logged — `webhookHandler` passes it to the adapter and discards it (`routes/verification.ts:317#const rawBody = Buffer.isBuffer(req.body)`). No `result`, `patch` or document field is ever a log argument. **One caveat recorded:** `routes/verification.ts:299#sendError(res, "db_error", insertError.message);` returns `insertError.message` to the caller, and a Postgres error can echo a rejected VALUE; for this table that is a status or a level string, never document data — but it is the one place a future column could leak through. |
| TRV2-08 | Restrictions are applied at the actual consuming actions — Compass, Discovery, social and booking paths | **NB** | `getRestrictionState` has exactly five non-Trust callers, and none of them is any of the four: `services/interactionPermissions.ts:365#const restrictionState = await getRestrictionState(sc, viewerId);` (messaging), `lib/calls/callGatewayAdapter.ts:265#const state = await getRestrictionState(sc, userId);` (calls), `routes/trips.ts` (hosting), `routes/tripCrewLocation.ts` (crew live-share), and `services/passport/PassportProjectionService.ts:2159#getRestrictionState(sc, userId),`, which is a PROJECTION for display, not a gate. `src/compass/` and `routes/discovery*.ts` contain no call at all. The booking path enforces a different mechanism entirely — `rent_buddy_city_restrictions` and `rent_buddy_user_limits` (`routes/rentABuddy.ts:1574#let query = sc.from("rent_buddy_city_restrictions").select("*").eq("city", city);` and `routes/rentABuddy.ts:612-618#export async function getUserLimits(client: any, userId: string): Promise<any`) — which is city/category and rate policy, not trust restriction. A user restricted by an admin can still be recommended, discovered and booked. Owner decision **D-RESTRICTION-REACH**. |
| TRV2-09 | Concurrency does not lose active restrictions | **C** | There is no read-modify-write anywhere on the restriction tables, which is the shape that loses updates. `TrustRestrictionService` applies with a bare `insert` (`artifacts/api-server/src/services/trust/TrustRestrictionService.ts:109-119#const { data, error } = await db`) and lifts with a single statement scoped to unlifted rows — `.update({lifted_at, lifted_by}).eq("user_id").eq("restriction_type").is("lifted_at", null)` (`artifacts/api-server/src/services/trust/TrustRestrictionService.ts:154-159#const { error } = await db`) — so two concurrent lifts are idempotent and a lift cannot clear a row it did not match. Enforcement reads the timestamps directly rather than a cached flag (`lib/stateMachines/registry.ts:931-934#"lifted_by => expired. Enforcement reads the timestamps directly (getRestrictionState, " +`), so no stale copy can outlive a write. **Named rather than hidden:** a lift issued concurrently with an apply of the same type can clear the row the apply just inserted. That is last-writer-wins between two admins acting on the same subject at the same instant, which is the intended admin semantics, not a lost update — and `trust_restrictions` has held 0 rows for the life of production (read 2026-09-13). |
| TRV2-10 | Derived effects of revocation, appeal and account deletion follow **the defined** reversal/retention policy | **CV** | **Correctness is not determinable, because the policy does not exist.** `Portava_Trust_Architecture_Upgrade_v2.md` says so itself: *"Also request unresolved public labels/brand decisions, provider choice and credentials, and retention/reversal policy. The verified-foundation plan's retention values apply to the stated verification records, not automatically to all Trust evidence."* The mechanisms exist and disagree about what should happen: `TrustCapService.liftCapsBySourceEvents:110-128` reverses caps when a moderation finding is reversed (C14), `routes/admin.ts:1655#verification_level: "none",` now clears the verification level (TV-4c), `services/accountDeletion/AccountDeletionService.ts:1016-1021#const verOk = await step(steps, "delete_identity_verifications", async () => {` deletes verification rows — and **nothing defines whether a revoked verification should also reverse the `identity_verified` trust award**, whether an upheld appeal reverses the charge it answers, or how long derived evidence survives a subject's erasure. Grading this `C` would promote whatever the code does today into approved specification, which the v2 document forbids by name. **Exact decision needed: D-REVERSAL (§12.7).** |
| TRV2-11 | No historical stamp, inferred visit or passive contribution becomes a new award absent an explicitly approved backfill policy; test fixtures stay isolated | **C** | No backfill writes trust: the six `src/scripts/backfill*.ts` files contain no reference to `trust_events` or `recordTrustEvent`. No award was manufactured by this pass — the only trust-affecting change is TV-1f, which **removes** awards (it adds a dedup key), and it was measured by counting inserts, not by writing rows. Fixtures are isolated: every test above runs against an injected double (`test/helpers/failClosedSupabase.ts`, `_setTestServiceClient`) against `SUPABASE_URL=http://127.0.0.1:9`, and production carries 5 trust events with the newest dated 2026-08-16 — unchanged by this pass (read-only, 2026-09-13). Migration 2870 was staged and applied to nothing. |

### 12.7 CANNOT-VERIFY, and the owner decisions — stated as decisions, not made

**The CANNOT-VERIFY list is exactly one row.** The missing scoring policy does not reach the
privacy, authorization, idempotency, wiring and Sensing-separation requirements, and those were
all graded normally above.

| Row | Why it cannot be verified | The exact decision needed |
|---|---|---|
| **TRV2-10** | Its correctness is defined by "the **defined** reversal/retention policy", and no approved document defines one. Three mechanisms exist and none of them agrees with the others about scope. | **D-REVERSAL.** For each of (a) admin revocation of a verification, (b) an upheld appeal, (c) account deletion: does the derived trust effect reverse, decay, or persist? If it reverses, by a counter-event or by deletion of the original? And for how long does derived evidence about an erased subject survive — the plan's 90-day verification-record value, or something else? The v2 document states the plan's retention values "apply to the stated verification records, not automatically to all Trust evidence", so answering for verification rows does not answer for `trust_events`. |

**New owner decisions from this pass.** Each blocks a specific row and none was taken here.

| id | Decision | Blocks |
|---|---|---|
| **D-2870-APPLY** | Apply `2870_profiles_verification_level_identity_vocabulary.sql` to production? It widens one CHECK additively, moves no row, and changes nothing a user sees. Until it is applied, **no user can ever become ID-verified**: the write is a 23514 and the provider retries forever. Recommended; applied nowhere by this lane. | TV-1c |
| **D-LEVEL-VOCAB** | Two vocabularies share `profiles.verification_level`: platform standing (`basic_verified` / `trusted_traveler` / `host_verified` / `buddy_verified`, granted by `routes/admin.ts`) and ID-check outcome (`id_verified` / `id_selfie_verified`, written by `routes/verification.ts`). Merge, rank, or split into separate columns? Two client screens already disagree about which set exists. Mapping one onto the other would have closed TV-1c without a migration, and was deliberately not done. | TV-1c, TV-2c, TRV2-12 |
| **D-DOB** | Privacy invariant 2 says Portava never stores a date of birth; production stores one for 7 of 58 profiles and **every** age gate reads it while `is_over_18` is read by none. Honour the invariant (migrate the gates onto the derived boolean, then drop the column) or amend it? This is a privacy commitment, so the amendment is not a lane's to write. | TV-P2, TV-5b |
| **D-MODACTION-SHAPE** | Production `moderation_actions` has no `report_id` and no `expires_at`, so a report cannot be linked to the action that answered it and a time-boxed suspension cannot be recorded there. Add the columns, or ratify the `metadata` jsonb convention as the contract? | TV-0a, TV-4a |
| **D-MODACTION-FK** | `moderation_actions.target_user_id` is `ON DELETE CASCADE` — erasing a subject destroys the enforcement record about them — and `performed_by` is NO ACTION, which blocks erasing a moderator. Invariant 3 says SET NULL and `2138:103` planned it. Converge, or amend the invariant? | TV-P3 |
| **D-SUSPENSION-UX** | The plan specifies a read-only state with an appeal contact for suspended users and sign-out for banned ones; the server returns a blanket 403 for both and the client has no screen for either. Build as specified, or ratify the 403? | TV-4b |
| **D-RESTRICTION-REACH** | Which Compass, Discovery, social and booking actions must enforce trust restrictions? Today **none** do; a restricted user is still recommended, discovered and bookable. This is a product scope decision, not a wiring task. | TRV2-08 |
| **D-BADGE** | The verified badge does not exist in any form. The plan specifies teal = ID verified, gold = ID + selfie, on six surfaces. The v2 document lists "public labels/brand decisions" as unresolved, so the wording and colours are owner-owned. | TV-0e, TV-2c |
| **D-PROVIDER** | Stripe Identity or Persona, with the account, keys, webhook endpoint, signing secret and Replit Secrets. The six concrete steps are written out in TV-6a so no code reading is needed. | TV-6a, TV-6b |

**Two of §5's decisions are RESOLVED, and this census did not know it.** §5 items 1 and 2 ask
whether to apply migrations 2370 and 2371 to production and record "not done". Both were
applied on **2026-09-08** (`supabase_migrations.schema_migrations`: `20260908005407
2370_trust_tables_privileges`, `20260908005514 2371_trust_profiles_evidence`). Measured
read-only 2026-09-13: **zero** privileges to `anon` or `authenticated` on any of the seven
trust tables, and `trust_profiles.evidence_weight` / `evidence_count` both present. A8's
standing caveat — *"Production: not applied — owner decision"*, restated in §5.1 as *"applied
to CI, NOT to production"* — is stale and is corrected here. **D-OVERRIDE is untouched:** §11
pinned it, C22 stays `W`, and nothing in this pass re-opens it.

### 12.8 The existing 52 — re-audited, and what moved

Nine of the fifty `C` rows were re-executed at this commit by opening the object, not the
sentence about it. **No verdict moves.** Two carry corrections to their evidence.

| id | Re-executed | Result |
|---|---|---|
| A6 | production read-only, 2026-09-13 | **Stays `W`, and the remainder is unchanged in every particular.** `trust_events` still holds **5** rows, newest **2026-08-16**; `stamp_verified` count **0**; `identity_verified` count **0**. The emitters are on `main` and have still not reached the production runtime. New this pass: `identity_verified` joins the list of declared-and-unfired types, for a reason that is now named — no identity verification can complete in production at all (TV-1c). |
| A8 | production grants, 2026-09-13 | **Stays `C`, caveat CORRECTED.** Its cell says production was not migrated; migration 2370 was applied 2026-09-08 and the seven trust tables now grant nothing to `anon` or `authenticated`. The `C` is no longer a statement about a migration file — it is a statement about production. |
| A3 | `TrustScoreService`, production columns | **Stays `C`, caveat ADDED.** `measureEvidence` and the two-column persist are present, and 2371 put `evidence_weight`/`evidence_count` in production on 2026-09-08 — but **0 of 2 profiles carry a value**, because no recalculation has run since the columns landed. The measure exists in code and in schema and has never been written in production. Not a code gap; recorded so it is not mistaken for one. |
| A17 | `pnpm check:trust-table-ownership` | **Stays `C`.** *"900 source file(s) scanned; 21 read(s) inside services/trust; 3 file(s) owned elsewhere with a written reason; 0 violation(s)"*, exit 0. |
| A18 | `lib/intelScopedTrustApply.ts:141-151#if (error) throw error;` | **Stays `C`.** `bridgeEventFor` still bridges only a named signal subset into person trust, with its own deltas; scoped trust remains a separate store. |
| A19 | `TrustEventService.ts:440-446#const delta = confidence === "high" ? -8 : confidence === "medium" ? -4 : -1;` | **Stays `C`.** The movement-derived deltas are still −8 / −4 / −1 and there is still no positive one; the positive location events require an explicit geofenced action. |
| C26 | every handler in `routes/trust-admin.ts` | **Stays `C`.** 13 routes at `:107, 147, 168, 257, 278, 305, 338, 366, 399, 421, 442, 459, 556`; `requireAdmin` is the first statement in all 13, checked line by line rather than by counting occurrences. `check:route-auth-gate` exit 0. |
| C30 | `grep` + `artifacts/api-server/src/index.ts:84#process.on("unhandledRejection", (reason) => {` | **Stays `C`, COUNT CORRECTED.** The cell says "the 19 unguarded `void recordTrustEvent(...)` sites"; there are now **22**. The `unhandledRejection` backstop still covers all of them, so the requirement holds and the number in the cell does not. |
| C32 | `pnpm check:trust-event-vocabulary` | **Stays `C`.** *"50 declared type(s); 36 emitted; 26 emitter site(s) with literal fields compared, 14 computed; 0 divergent, 0 undeclared, 14 unemitted with a written reason"*, exit 0. |
| C1 | `TrustEventService.ts:234-262#async function isDuplicate(` | **Stays `C`, CAVEAT SHARPENED.** The dedup mechanism is correct and fails closed on a read error. What it cannot do is defend itself against a caller that passes no `sourceId`: `TrustEventService.ts:242#if (!sourceId) return "new";` returns `"new"` immediately, so an emitter without a key bypasses the window by omission and still receives `{ ok: true }`. That is what TV-1f was. C1 is not downgraded — the contract is about the mechanism, and the mechanism is right — but **no guard covers dedup keys**: `check:trust-event-vocabulary`'s own NOTE says it does not cover non-literal arguments, and it compares types and deltas, never sources. |
| C22 | — | **Stays `W`.** D-OVERRIDE, pinned by §11. Not re-opened. |

### 12.9 What this pass built, and the proof

All in Trust-, verification- and moderation-owned files. No flag added or flipped, no provider
enabled, no migration applied to any database, no backfill run.

| Row | Repair | Files (`file:line`) | Test | RED → GREEN |
|---|---|---|---|---|
| TV-1f | `identity_verified` had no idempotency key, so every provider redelivery charged another +10 | `routes/verification.ts:42#const TRUST_SOURCE_TYPE = "identity_verification";`, `routes/verification.ts:103-108#await recordTrustEvent(client, {` | `test/verificationTrustIdempotency.test.ts` | **RED 3 tests / 1 pass / 2 fail** → **GREEN 3/3**. M3 (revert the two added lines, file restored and diffed): back to **1/2**. |
| TV-1c | the level the service writes is rejected by the live CHECK — migration STAGED, guard added | `migrations/2870_profiles_verification_level_identity_vocabulary.sql`; `db/rollback/2026-09-13-2870-profiles-verification-level-identity-vocabulary-rollback.sql` | `test/verificationLevelVocabulary.test.ts` | **RED 3 / 2 / 1** with the 23514 diagnosis → **GREEN 3/3**. M2 (drop `id_selfie_verified` from the real ADD CONSTRAINT): **2/1**. Row stays `W` — staged is not applied. |
| TV-P5 | the webhook answered 200 when the provider factory refused, discarding every delivery | `routes/verification.ts:357#res.sendStatus(503);` | `test/verificationWebhookProviderUnavailable.test.ts` | **RED 5 / 2 / 3** → **GREEN 5/5**, premise and control green throughout. |
| TV-4c | `unverify` left the one column the booking gate reads | `routes/admin.ts:1655#verification_level: "none",` | `test/adminUnverifyRevokesIdLevel.test.ts` | **RED 5 / 3 / 2** → **GREEN 5/5**. M4 (revert the single added field): back to **3/2**. |

**One mutation stayed GREEN and it found a hole in my own guard, which is reported rather than
buried.** M1 deleted `'buddy_verified'` from 2870's real `ADD CONSTRAINT` and
`verificationLevelVocabulary.test.ts` passed 3/3. The parser matched the constraint NAME and
then the next `ARRAY[...]`, and that name recurs four more times after the definition — twice
inside a `-- REVERSIBLE BY` comment that quotes the *narrowed* five-value array verbatim, and
once in the postcondition's own `c.conname = '…'` lookup, which is followed by a `FOREACH v IN
ARRAY ARRAY[…]` listing all seven. "Last match" was therefore reading the file's assertion
*about itself* instead of the DDL — a guard that agreed with the thing it was checking. Fixed
by anchoring on `CONSTRAINT <name> … CHECK` with `--` comments stripped first (the reasoning is
written into the test at `verificationLevelVocabulary.test.ts`, so the next reader does not
repeat it). **M1 re-run after the fix: RED 2/1.** M2 was then run against the corrected parser
and also goes red, so both directions of drift are covered.

Every mutation was applied to a copy-backed file, the suite run under `timeout`, the file
restored, and the restore verified with `diff -q` (all reported "restored").

**Gates.** `tsc -p tsconfig.json --noEmit` exit 0. `check:migration-prefixes`,
`check:trust-table-ownership`, `check:trust-event-vocabulary`, `check:route-auth-gate`,
`check:enum-literals` all exit 0. Verification and moderation suites **59/59** (48/48 across
four files before this pass; 59/59 across seven after). Trust suites — `trust.test.ts`,
`trust-integration.test.ts`, `trustCensusRepairs`, `trustEmitterWiring`, `trustEventCoverage`,
`trustRestrictionEnforcement`, `trustStampVerified`, `trustChainEndToEnd` — **188/188**. Admin
moderation suites 45/45 runnable; `profileVerificationSelfWriteBoundary.test.ts` refuses to run
here because it is a live-DB test and `KNOWN_PROD_PROJECT_REF` is unset — environmental, and
unchanged by this pass.

**`check:test-registration` is RED by construction and that is not a finding.** `package.json`
is reserved to the integration owner. Four files must be appended to the END of its `test`
script:

```
src/test/verificationTrustIdempotency.test.ts src/test/verificationLevelVocabulary.test.ts src/test/verificationWebhookProviderUnavailable.test.ts src/test/adminUnverifyRevokesIdLevel.test.ts
```

### 12.10 Headline

> **Trust, at `b7f137a4d`: 93 requirements · 69 BUILT-AND-CORRECT · 15 BUILT-BUT-WRONG ·
> 8 NOT-BUILT · 1 CANNOT-VERIFY → CONSTRUCTED 84 / 93 = 90.3 % · CORRECT 69 / 93 = 74.2 %.**
>
> Before this pass, over a denominator that excluded the surface's own specification:
> 52 requirements · 50 / 2 / 0 / 0 → CONSTRUCTED 100.0 % · CORRECT 96.2 %.
>
> **CONSTRUCTED −9.7 points. CORRECT −22.0 points.** Not one of the original 52 verdicts
> changed. The entire movement is 41 rows that were always in scope and had never been read.

| BUILT-AND-CORRECT | **69** |
|---|---|
| BUILT-BUT-WRONG | **15** |
| NOT-BUILT | **8** |
| CANNOT-VERIFY | **1** |

*This is the current headline of this document. The 52-row headline in the Summary table at
the top and in §5.3 is superseded by it under LAST-STATEMENT-WINS, and is left in place
because this file is append-only — it is the BEFORE column of §12.2, not a competing claim.*

The gap is no longer "one deployment and one word". It is a verification flow whose success
path the database rejects, a badge that does not exist, an age gate that reads the column the
privacy invariant forbids and ignores the one it mandates, a moderation queue that can only
grow, a provider that has never been chosen, and a retention job that was never written — plus
one genuine CANNOT-VERIFY where a policy has to be decided before correctness even has a
meaning.

---

## 13. V-7 built — two rows move, 2026-09-13, `f9d0b9a07`

*Same 93-row denominator, same counting rule. Two rows move; nothing else is restated. No
production read, no migration applied, no flag flipped.*

### 13.1 Verdict changes

| id | Was | Now | Evidence at `f9d0b9a07` |
|---|---|---|---|
| TV-7a | W | **C** | Both criteria now hold, in the order the plan states. `services/identityVerification/providerErasure.ts:58-107#export async function requestProviderDeletionForUser(` reads the user's `provider_verification_ref`s and asks the configured provider to redact each; `services/accountDeletion/AccountDeletionService.ts:1002-1022#const provErasureOk = await step(steps, "request_provider_verification_deletion", async ()` runs it as the named step `request_provider_verification_deletion` **before** `delete_identity_verifications`. The ordering is the requirement, not a nicety — after the delete, `provider_verification_ref` is gone and the vendor's copy of the document is unredactable by anyone, permanently — so it is asserted as an ordering (`test/verificationProviderErasure.test.ts`, the `idxRead < idxDelete` assertion) rather than as two independent calls. A provider that cannot be reached does **not** block the erasure: the step records a failure with the refs in its message, which may be the only surviving record of what still needs redacting, and a warning carries them out. An unreadable `identity_verifications` is a different failure in kind and throws, because supabase-js resolves on a read error and an unbound one makes a table that could not be read look exactly like a user who never verified. **RED 6 tests / 5 pass / 1 fail → GREEN 6/6**; M5 (step removed) **5/1**, M6 (step moved after the delete) **5/1**. |
| TV-7b | NB | **C** | `services/identityVerification/retention.ts:52-74#export async function purgeExpiredVerificationRecords(` deletes `failed` / `expired` rows whose `updated_at` predates a 90-day cutoff, counting what it removed via a chained `.select("id")` rather than assuming; `lib/trustMaintenanceScheduler.ts:635-640#const r = await purgeExpiredVerificationRecords(db);` runs it every pass. Two choices carry the row and each has a dangerous opposite. **The status filter is positive** — exactly the two statuses the plan names. Not `canceled`, which the plan does not mention and which this does not decide for it; and not `verified`, which is not stale data but the standing evidence `lib/travelerVerification.ts` and `routes/rentABuddyRollout.ts` gate in-person introductions on. A negative filter would also sweep in any status added later, so the test asserts the SET (M8 adds `verified` and two tests go red). **It runs above the `trust_engine_enabled` gate** — that flag governs scoring, and below the gate a data-protection promise would be switchable by a scoring feature flag; turning the trust engine off must stop scores moving, not quietly start retaining failed government-ID checks forever (M7 moves it below and the flag-off test goes red). Reuses the existing 6-hourly scheduler rather than adding a second one. Non-fatal but never silent: the purge throws on a database error so the WARN exists, and `verificationRecordsPurged` is `number | null` because "did not run" is not zero. **RED 7 / 5 / 2 → GREEN 7/7.** |

### 13.2 Rows that did NOT move, and why

The remaining eight `NB` and `CV` rows are each blocked on a decision, not on effort, and §12.7
names the decision for every one. **TV-5b** (age gating on `is_over_18`) was not built although
it is small, because building it decides **D-DOB**: the gate would have to stop reading
`profiles.date_of_birth`, which seven live profiles carry and six routes read. **TV-0e / TV-2c**
(the badge) need **D-BADGE**, whose wording and colours the v2 document lists as unresolved.
**TRV2-08** needs **D-RESTRICTION-REACH**, a product scope decision about which Compass,
Discovery and booking actions enforce restrictions. **TV-6b** needs **D-PROVIDER**. **TV-1c**
stays `W` until **D-2870-APPLY**: the migration exists and is applied to no database, and a `C`
on a staged file is the "merged is not deployed" error this census is named for.

### 13.3 Restated headline

> **Trust, at `f9d0b9a07`: 93 requirements · 71 BUILT-AND-CORRECT · 14 BUILT-BUT-WRONG ·
> 7 NOT-BUILT · 1 CANNOT-VERIFY → CONSTRUCTED 85 / 93 = 91.4 % · CORRECT 71 / 93 = 76.3 %.**
>
> Against the pre-pass figure of 52 requirements · 50 / 2 / 0 / 0 → CONSTRUCTED 100.0 % ·
> CORRECT 96.2 %: **CONSTRUCTED −8.6 points, CORRECT −19.9 points.** Six rows were built this
> pass, each red-before and green-after with its mutations logged; not one of the original 52
> verdicts moved in either direction.

| BUILT-AND-CORRECT | **71** |
|---|---|
| BUILT-BUT-WRONG | **14** |
| NOT-BUILT | **7** |
| CANNOT-VERIFY | **1** |

*This supersedes §12.10 under LAST-STATEMENT-WINS. §12.10 is the state before V-7 was built and
is left in place because this file is append-only.*

---

## 14. The webhook signature, the two adapters, and the two decisions — 2026-09-14

*Same **93-row** denominator, same counting rule, same verdict grammar. Measured in the
worktree `/home/user/wt-483` (detached at `7d1f2d498`, PR #483 head plus the v2 spec install),
with six sibling lanes editing other surfaces in the same tree. **No production read this pass**
— every claim below is against files at this tree. No migration applied to any database, no flag
added or flipped, no provider enabled, no backfill run, no entry added to
`IMPLEMENTED_PROVIDERS`.*

### 14.0 Which population every number on this page is against

This census has had two denominators and it is worth being blunt about which one is live,
because the retired one flatters the surface by twenty points.

* **52** — the population before §12. It excluded `docs/trust/verified-foundation-plan.md`,
  which is Trust's own specification, and `Portava_Trust_Architecture_Upgrade_v2.md`. Its final
  headline read **CORRECT 96.2 %**. That number is **retired**. It is preserved in the Summary
  table, in §4, §5.3 and as the BEFORE column of §12.2 only because this file is append-only.
  It is not a current measurement of anything and must not be quoted as one.
* **93** — the population since §12: the original 52, plus 35 rows from the verified-foundation
  plan (5 privacy invariants and 30 over its 29 phase bullets) and 6 from the v2 upgrade
  document. §12.6 records, one line each, why the other six TRV2 requirements add nothing.

**Every figure in §14 is against the 93.** Where a percentage appears it is written with its
denominator beside it.

### 14.1 Verdict changes

Two rows move. Both are in `services/identityVerification/`, which this pass owns end to end.

| id | Was | Now | Evidence at this tree |
|---|---|---|---|
| TV-P5 | W | **C** | Both criteria now hold, and the one that did not is the whole of this row. **Signature verification exists, in every real adapter.** `services/identityVerification/webhookSignature.ts:168#export function verifyTimestampedHmacSignature(input: VerifyWebhookSignatureInput): {` implements the construction both vendors use — header `t=<unix>,v1=<hex>`, signed payload `` `${t}.${rawBody}` ``, HMAC-SHA256, hex — and is bound to each adapter by header name at `services/identityVerification/providers.ts:97#headerName: 'stripe-signature',` and `services/identityVerification/providers.ts:127#headerName: 'persona-signature',`. It **throws** on every failure path and has no boolean return, `services/identityVerification/webhookSignature.ts:75#export class WebhookSignatureError extends Error {`, because a caller that forgets to test a boolean silently accepts and forgetting must fail closed. Five distinct refusals are distinguished so an operator is not sent to the wrong system: `secret_not_configured`, `signature_header_missing`, `signature_header_malformed`, `signature_mismatch`, `signature_timestamp_out_of_tolerance`. **Four things this gets right that are usually got wrong**, each pinned by a test: the raw delivered bytes are signed, never a re-serialized body (verification happens BEFORE `JSON.parse`, so no attacker-chosen field is read first); an unset `IDENTITY_WEBHOOK_SECRET` is a refusal, not a bypass; the digest comparison is `services/identityVerification/webhookSignature.ts:157#return crypto.timingSafeEqual(a, b);` with an explicit byte-length recheck after hex decoding, because `Buffer.from(hex)` truncates silently at the first non-hex character; and a 300 s replay window stops a captured delivery being replayable forever. The invariant is quantified over `services/identityVerification/webhookSignature.ts:60#export const REAL_PROVIDER_NAMES = ["stripe", "persona"] as const;` rather than over a hand-written list, so a third adapter added without signature verification turns the suite red without anyone remembering to extend it. The second criterion, "never silently accepts", was built in §12 (`routes/verification.ts:357#res.sendStatus(503);`) and is unchanged. Proof, mutations and the route-level wiring are §14.2. |
| TV-6b | NB | **W** | Off NOT-BUILT, and **not to C** — the row has three criteria and only the first is now met. **Implemented ✓** — both adapters stopped being stubs. Stripe: `services/identityVerification/stripeIdentity.ts:146#export function normalizeStripeSession(` plus the four REST calls the previously-written TODOs mapped, session create, status poll and `redact`. Persona: `services/identityVerification/persona.ts:174#export function normalizePersonaWebhook(` plus inquiry create, status poll and `redact`. Both were implemented rather than one, which removes this row's dependency on D-PROVIDER for the code half — whichever vendor the owner picks, the adapter is there. **Sandbox-mode end-to-end test ✗** — nothing here has exchanged a byte with either vendor. The signature half needs no account and is proven; the PAYLOAD half (which JSON field carries the session id, the status, the failure code, the country) is written off each vendor's documented shapes and is **unverified against reality**. **Flip staging → production ✗** — and deliberately more than unfinished: `services/identityVerification/readiness.ts:53#const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);` is **unchanged**. That set is the single switch that re-opens the Rent-a-Buddy booking gate, and moving it on an adapter that has never spoken to its vendor is precisely the "mocked provider counted as complete" this census exists to catch. What IS closed is that the remaining work is no longer code. See §14.6 for what would turn this row `C`. |

### 14.2 What was built, and the proof

All in `services/identityVerification/` and `src/test/`. Every mutation below was applied to a
copy-backed file, the suite run under `timeout`, the file restored, and the restore verified
with `diff -q`; all reported restored.

| Row | Repair | Files | Test | RED → GREEN |
|---|---|---|---|---|
| TV-P5 | Webhook signature verification, shared by both vendors, bound per-adapter by header name | `services/identityVerification/webhookSignature.ts` (new), `services/identityVerification/providers.ts` | `test/verificationWebhookSignature.test.ts` | **RED 3 pass / 16 fail** → **GREEN 28/28** (23 adapter + 3 route + 2 anti-drift). |
| TV-6b | Stripe and Persona adapters implemented: normalization, REST calls, privacy-preserving age derivation | `services/identityVerification/stripeIdentity.ts` (new), `services/identityVerification/persona.ts` (new), `services/identityVerification/providers.ts` | `test/verificationProviderNormalization.test.ts` | **GREEN 23/23**, with eleven mutations logged below. New module, so there is no meaningful pre-implementation red for the normalization itself; the mutations are the evidence, and they are reported as such rather than dressed as a red-before. |
| C22 · TRV2-10 | Characterization only — no behaviour changed. Nine assertions pinning the D-OVERRIDE precedence/expiry/removal answers (§14.4) and the D-REVERSAL scope (§14.6), so neither owner decision can be taken by accident | `test/trust-integration.test.ts` (appended) | `test/trust-integration.test.ts` | **GREEN 65/65 → 67/67.** Six mutations, all RED: O1–O4 (§14.4) and V1–V2 (§14.6). Both rows stay where they were; a characterization test is not a verdict. |
| TV-6b | The readiness probe described the adapters falsely, and a test pinned the false description | `services/identityVerification/readiness.ts` | `test/rentBuddyKycGate.test.ts` | **RED 11/1** → **GREEN 12/12**. Mutations: R1 (add `stripe` to `IMPLEMENTED_PROVIDERS` — the gate-opening change) **11/1 RED**; R2 (restore any wording containing "stub") **11/1 RED**. |

**Why the red was for the right reason, and why the obvious test would have been worthless.**
The naive TV-P5 test — "send a bad signature, assert it throws" — **passes against the stub**,
because the stub threw `Error('Stripe Identity adapter not configured.')` from every method.
That is §4's trap in its purest form. Every negative case therefore asserts the *reason*
(`WebhookSignatureError` plus a specific `code`), and the observed red was
`expected WebhookSignatureError, got Error: Stripe Identity adapter not configured.` on each —
not a bare failure count.

**The readiness probe was telling operators to do work that was already done.**
`identityProviderStatus()` is the non-throwing probe an operator reads when they ask why KYC is
off, and its answer for stripe/persona was *"that adapter in providers.ts is still a stub (every
method throws). Implement it and add it to IMPLEMENTED_PROVIDERS."* The moment the adapters were
written that sentence became false in the direction that wastes a person's day — and
`test/rentBuddyKycGate.test.ts` asserted `/stub/i` against it, so the stale description was
*pinned by a test*, which is this census's own §4 failure mode committed against a diagnostic
rather than against a behaviour. The message now names the evidence that is actually missing (a
sandbox end-to-end run) and the switch that would then open the gate. **`IMPLEMENTED_PROVIDERS`
is unchanged at `["mock"]`** and the header comment above it no longer says a provider joins the
set "when its adapter stops throwing" — which, after this pass, would have been an invitation to
open the Rent-a-Buddy booking gate on unverified code. The test now asserts both halves:
still not operational, AND the reason names the sandbox requirement.

**Mutations, TV-P5** (`test/verificationWebhookSignature.test.ts`, GREEN 23/23 before the route
block was added, 26/26 after):

| # | Mutation | Result |
|---|---|---|
| M1 | unset secret becomes an early `return` instead of a throw | **21/2 RED** |
| M2 | HMAC taken over the timestamp alone, so the signature no longer covers the body | **14/5 RED** |
| M3 | replay-window check disabled | **17/2 RED** |
| M4 | header lookup made case-SENSITIVE | **18/1 RED** |
| M5 | the verify call removed from the Stripe adapter only | **12/7 RED** |
| M6 | digest comparison accepts a PREFIX of the correct digest | **GREEN 19/19 — SURVIVED** |
| M7 | post-decode byte-length recheck removed | **21/2 RED** (after the M6 fix) |

**M6 survived and it was a real hole, reported rather than buried.** Replacing the length check
with `expected.startsWith(offered)` passed all nineteen assertions, because every negative case
offered a *wrong* digest and none offered a *short but correct* one. A prefix-accepting
comparator is forgeable in about sixteen guesses per byte, so the mutation that survived was the
actual bug: the test, not the code, was wrong. Two cases were added — a prefix of the correct
digest at lengths 2, 8, 32 and n−1, and a 64-character non-hex digest — and **M6 re-run against
the strengthened test: 21/2 RED**, M7 likewise. Both directions of the comparison are covered
now.

**A hole in this pass's own guard, found and closed before it shipped.** The "every real
adapter" suite iterates `REAL_PROVIDER_NAMES`, a hand-maintained list. A third adapter added to
the factory and not to that list would leave the suite passing while claiming to quantify over a
set it no longer matched — the same shape as the migration parser §12.9 reports agreeing with the
thing it was checking. Two cases now check the list against both of its sources of truth: the
declared `VerificationProviderName` union in `types.ts`, and the factory's own dispatch branches
read out of `providers.ts`. Mutations: **D1** add an `onfido` branch to the factory only —
**27/1 RED**; **D2** declare `'onfido'` in the type union only — **27/1 RED**; **D3** shrink
`REAL_PROVIDER_NAMES` to `["stripe"]` — **26/2 RED**.

**Mutations, TV-6b** (`test/verificationProviderNormalization.test.ts`, GREEN 23/23; every one
turned it red):

| # | Mutation | Result |
|---|---|---|
| N1 | `deriveIsOver18` uses the naive elapsed-ms ÷ 365.25 days instead of the exact 18th birthday | 21/2 |
| N2 | an unknown date of birth collapses to `false` instead of `undefined` | 22/1 |
| N3 | the Stripe date of birth is copied into the normalized result | 22/1 |
| N4 | Stripe `requires_input` with no `last_error` read as `failed` | 22/1 |
| N5 | the redaction handle becomes the verification-REPORT id instead of the session id | 21/2 |
| N6 | `document_` tested before `selfie_` in the failure-code map | 22/1 |
| N7 | an unknown Persona status defaults to `verified` | 22/1 |
| N8 | Persona `needs_review` read as `verified` | 22/1 |
| N9 | the Persona `birthdate` is copied into the normalized result | 21/2 |
| N10 | `inquiry.failed` no longer overrides an ambiguous inquiry status | 22/1 |
| N11 | Persona lifecycle events (`inquiry.created` / `.started`) no longer ignored | 22/1 |

**Three of those deserve naming, because they are the ones that would hand out a badge.**
N3 and N9 are the privacy invariants: both vendors return a date of birth on the success path,
the adapters are the only place it is ever in scope, and the test scans the whole serialized
result for the DOB rather than checking named fields — a named-field assertion is exactly the one
§4 records passing while a serializer leaked. N7 and N8 are the dangerous default: a status
mapping has one direction that costs a poll and one that grants a stranger a government-ID badge,
and `services/identityVerification/persona.ts:64#export function mapPersonaStatus(status: unknown): NormalizedVerificationStatus {`
falls to `pending` for anything it does not recognise, including statuses Persona has not
invented yet. N5 is erasure: `requestProviderDeletionForUser` redacts by
`provider_verification_ref`, and both vendors' redact endpoints take the SESSION/inquiry id — a
report id there would have been an unredactable pointer at the document images themselves.

**The refusal is wired to a reachable caller, not merely exported.** Three route-level cases in
the same file drive `webhookHandler` — what `app.ts` mounts at `POST /api/verification/webhook`
behind `express.raw()` — and assert 400 `invalid_signature` for a forged Stripe delivery and for
an unset endpoint secret, with a **control** proving a correctly signed delivery gets *past*
signature verification. Without that control the two refusals would be satisfied by an adapter
that rejects everything.

**Gates.** `tsc -p tsconfig.json --noEmit` exit 0. `typecheck:tests` **864 diagnostics across
116 files, exactly at baseline (864/116)** — this pass adds none. Trust, verification and
moderation suites **204/204** across twelve files. `check:census-integrity`,
`check:census-policy-citations`, `check:census-scope-coverage`, `check:census-row-move-labels`
all exit 0. `check:doc-citations` is red repo-wide for other surfaces' citations and
**census-trust contributes zero failures to it** — see §14.5.

**`check:test-registration` is RED by construction and that is not a finding.** `package.json`
is reserved to the integration owner. Two files must be appended to the END of its `test`
script:

```
src/test/verificationWebhookSignature.test.ts src/test/verificationProviderNormalization.test.ts
```

(The other seven files it names belong to the Layover and Memory lanes, not to this one.)

### 14.3 D-SCORING — the missing scoring policy, as one answerable question

The v2 document says the scoring policy is missing and forbids inventing it. It does not say
what, precisely, is undecided. **It is decidable, and until it is decided none of the following
is approved specification — every one is an implementation detail that has been running in
production since `trust_engine_enabled` went TRUE on 2026-07-17.** Nothing here was changed this
pass; this is an inventory, and the reason the inventory is the deliverable is that a policy
cannot be requested against "the scoring model is missing".

| What is undecided | What the code does today, and where |
|---|---|
| **Category weights** — nine categories summing to 1.00 | `services/trust/TrustScoreService.ts:76#const DEFAULT_SETTINGS: Settings = {`: plan_attendance .180, respect_safety .150, location_honesty .130, host_quality .120, communication .100, and .080 each for content_quality, community_value, guide_accuracy, passport_authenticity. Overridable per-deployment from `trust_settings`; production holds one row at **all defaults**. |
| **Level thresholds** — six public levels | Same constant: building_trust 35, reliable 50, trusted 65, highly_trusted 78, city_trusted 90, below which `new_traveler`. `services/trust/TrustScoreService.ts:279#function scoreToLevel(score: number, s: Settings): PublicTrustLevel {`. These are the numbers a user sees a word for. |
| **Decay** | Exponential, half-life **90 days**, same constant. |
| **Scoring window** | **365 days**, hard-coded, not a setting: `services/trust/TrustScoreService.ts:144#const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();`. Evidence older than a year is invisible to the score — including a confirmed serious finding, whose survival then depends entirely on its cap. |
| **The earn/lose asymmetry** | `services/trust/TrustScoreService.ts:200#const EARN_CONFIDENCE_WEIGHT = 5;`: positive movement is scaled by a confidence ramp so a single good event cannot max a category; negative movement applies at full strength immediately, with no ramp. Slow to earn, instant to lose. That is a **product posture**, not a tuning constant, and no document states it. |
| **Per-event deltas — 50 declared event types** | `services/trust/TrustEventService.ts` `TRUST_EVENT_TYPES`, e.g. `services/trust/TrustEventService.ts:815#IDENTITY_VERIFIED:        { category: "respect_safety" as TrustCategory,  delta: 10, severity: "minor" as TrustSeverity },`. Range +10 (identity_verified, first_event_joined, first_event_hosted) to −20 (behavior_report_confirmed, fake_gps_confirmed). One delta point ≈ 5 score points. |
| **Severity routing** | minor/moderate apply immediately; serious/severe route to `pending_review` and are excluded from the score until an admin adjudicates. Severity does **not** change the delta — it selects the route and the ceiling. |
| **Caps (ceilings) per finding** | `TrustCapService.applyEventCaps`: no_show → 60 for 30 d, behavior_confirmed → 40 **permanent**, fake_gps → 35 permanent, impossible_speed → 55 for 14 d, coordinate_jump → 55 for 7 d, content_removed → 50 for 30 d, message_report → 45 for 60 d. The expiries are where "how long does a finding bite" actually lives, and they were chosen, not ratified. |
| **Earning caps (anti-farming)** | `services/trust/TrustEventService.ts:190#const DEFAULT_EARNING_CAP: EarningCaps = { daily: 10, weekly: 40 };` for every positive type with no explicit bucket; three named buckets at 3/10, 5/20 and 10/40. |
| **Idempotency window** | 24 h for most emitters; `services/trust/TrustEventService.ts:590#dedupWindowHours: 24 * 365,` — a 365-day "pay once, ever" window for the one-shot awards. |
| **Recovery** | `TrustRecoveryService` generates ordered steps toward the neutral 50 from the lowest categories and active caps. What "recovered" means, and whether reaching it should lift anything, is unstated. |
| **Reversals and appeals** | Three mechanisms, no policy — this is D-REVERSAL, kept separate below because it is TRV2-10's blocker and not the scoring model's. |

> **D-SCORING, as one question the owner can answer in one sitting:**
> *Of the twelve parameter families above — weights, thresholds, decay, window, the earn/lose
> asymmetry, the 50 per-event deltas, severity routing, per-finding ceilings and their expiries,
> earning caps, dedup windows, recovery and reversal — **which are hereby RATIFIED as they
> stand, and which require a different value?*** A blanket "ratify current behaviour as v1" is a
> complete and legitimate answer and costs nothing to implement; what is not available is
> leaving it unasked, because today every one of these numbers is a decision that was taken by
> whoever typed it and is being applied to real users.

**Why this is stated and not taken.** The v2 document is explicit: *"Inventory existing
behavior as implementation evidence; do not promote it to approved specification
automatically."* The table above is the inventory. Promoting it would close nothing honestly and
would make the next reader believe a policy exists.

### 14.4 D-OVERRIDE — what the code does, the two candidate semantics, and what differs observably

> **SUPERSEDED IN PART BY §15 (LAST-STATEMENT-WINS).** The owner has since RULED — **CAP now,
> PIN later behind a flag** — and the defect this section describes in its third bullet
> ("never lands at all — there is no window in which it was true") is CORRECTED there: it is
> true only while `recalculateTrustScore` succeeds. The five observable differences, the two
> candidate semantics and the four characterization mutations below all still stand and none
> of their assertions moved. Read §15 for the ruling, the corrected defect and what is
> deliberately left as later work.

C22 stays **W**. This section does not choose; it makes the choice cheap to make by stating the
before-state precisely and pinning it in tests, so that converting one semantics into the other
cannot happen by accident.

**What the code does today.** `services/trust/TrustAdminService.ts:368#const cap = await createCap(db, {` writes a
`trust_caps` row with `ceiling_score = newScore` and `reason_code = 'admin_override'`. It then
upserts `trust_profiles` directly "for immediate effect" — and on its own next line awaits
`recalculateTrustScore`, which recomputes from events and overwrites that upsert before the
function returns. `TrustScoreService.loadCaps` folds caps with `Math.min` and `trust_caps` has
**no floor column at all**. Consequences, measured:

* An override **below** the natural score binds and survives every recalculation.
* An override **above** the natural score never lands at all — not "does not persist": there is
  no window in which it was true.
* It is therefore a **ceiling**, structurally, not because one branch is buggy.
* It is **unwired to any route**: `adminOverrideScore` and `adminRemoveOverride` have no caller
  outside `services/trust/` and the test suite (re-checked this pass by grep over the whole
  package). Nothing live turns on the answer today, which is exactly why it is cheap to decide
  now and expensive later.

**The two candidate semantics.**

* **CAP** — the admin sets a *maximum*. Events may move the score below it; nothing can lift it
  above. An admin can **withhold** standing and cannot **grant** it. This is what is built.
* **PIN** — the admin's number *is* the score until an admin lifts it. Events stop moving that
  category. An admin can both grant and withhold standing.

Both are defensible and they are different products. A pin is a tool for saying "this person is
trustworthy, I vouch"; a cap is a tool for saying "this person may not rise above this while we
watch them". Building either without the decision would be taking it.

**What differs observably — five things, four of them newly pinned this pass** in
`test/trust-integration.test.ts`, under `D-OVERRIDE precedence, expiry and removal —
characterization, not a verdict`. Each assertion records today's answer; each would have to be
rewritten *by name* for the semantics to change, which is the point.

| Observable | Under CAP (today) | Under PIN | Pinned by |
|---|---|---|---|
| Upward override | Discarded; the admin's number appears nowhere | Becomes the score | §11's existing block, re-run this pass |
| Override vs a moderation ceiling in the same category | `Math.min` wins, so an override of 90 against a `behavior_confirmed` ceiling of 40 yields ≤ 40 — **an admin cannot grant relief from another cap** | The pin would override the moderation ceiling, which is a different and much larger authority | new — mutation O2 (fold with `Math.max`) turns it RED |
| Expiry | Never. `adminOverrideScore` passes no `expiresAt`, so the row is permanent until lifted, and `expireOldCaps` cannot sweep a null expiry | A pin plausibly wants a review date | new — mutation O1 (give it an expiry) turns it RED |
| Precedence with restrictions | None. Overriding a user's `respect_safety` to **0** creates no `trust_restrictions` row and changes no eligibility — "override to 0" is **not** a way to withhold access | Same question, and it needs an explicit answer either way | new — mutation O3 (also write a restriction) turns it RED |
| Removal | `adminRemoveOverride` lifts **every** active `admin_override` cap for that user+category, so one admin's removal clears another admin's override; the moderation cap in the same category is correctly untouched | Under a pin, "whose pin was lifted" is a real question | new — mutation O4 (stop filtering on `reason_code`) turns it RED |

> **D-OVERRIDE, as one question:** *Does an admin score override PIN the score (the admin's
> number wins until lifted) or CAP it (the admin sets a maximum and events move it below)? And
> for the chosen answer: does it take precedence over a moderation ceiling in the same category;
> does it expire; and does removal by one admin clear another admin's override?* The first
> clause is the product decision; the other three follow from it and are each a line of code.

### 14.5 Rows found MIS-GRADED, and evidence corrected

Every one of the twenty-two open rows was re-executed against this tree before anything was
built. **No verdict was found wrong in either direction.** Four cells carry evidence that has
drifted, corrected here rather than left to rot.

| Row | Correction |
|---|---|
| TV-0e / TV-2c | The cell says a case-insensitive search for `VerifiedBadge` "returns four hits, all of them inside the two plan documents themselves". At this tree it also matches **four client style keys** — `travel-buddy-standalone/src/components/BuddyCard.tsx:256#verifiedBadge: {`, `travel-buddy-standalone/src/components/compass/CompassTravelerRow.tsx:389#verifiedBadge: {`, `travel-buddy-standalone/src/components/compass/CompassBuddyRow.tsx`, `travel-buddy-standalone/app/(rent-a-buddy)/offers.tsx:245#verifiedBadge: { backgroundColor:`. The component still does not exist and neither verdict moves — **but TV-2c's "zero criteria met" understates the problem in the direction that matters.** Buddy cards and Compass traveler rows DO render a verified indicator today, and it is driven by `profiles.verified`, a legacy boolean, not by `verification_level` — `artifacts/api-server/src/compass/CompassTools.ts:1848#verified:     row.verified === true,` and `artifacts/api-server/src/routes/profile.ts:117#verified: r.verified ?? false,`. So the placement surfaces are not merely unaware of verification (which is what the cell says); **they already show a badge sourced from something that is not the ID check.** That is TRV2-12's clause "verified badge reflects actual verification state" failing on a surface that looks finished, which is worse than one that looks empty. Recorded here; the fix is client- and Compass-lane work (§14.7). |
| TV-0a | The cell says `migrations/` "holds 528 files and not one mentions `identity_verifications`". It now holds **529**, and one mentions the identity vocabulary — `migrations/2870_profiles_verification_level_identity_vocabulary.sql`, added by §12 and applied nowhere. The substantive claim is unchanged: no migration in the applied set creates `identity_verifications`; the table still reached production through the baseline. |
| TV-7a / TV-P3 | New, and not previously recorded on either row: `routes/verification.ts`, which then read `patch.provider_verification_ref = result.providerVerificationRef ?? null;`, sits inside `if (result.status === "verified") {`, so `provider_verification_ref` is written **only on success**. A FAILED or EXPIRED attempt left a government ID with the vendor and no handle stored, so `requestProviderDeletionForUser` — which reads exactly that column — can never offer it for redaction. Both new adapters therefore set the redaction handle for **every** state (mutation N5 pins it), which is the half this lane owns; the persist-side condition is in `routes/verification.ts`, which it does not own. Cross-lane request in §14.7. Neither row's verdict moves: TV-7a's two criteria are about the ordered call, which holds. |
| TRV2-10 | The cell's third mechanism is sharpened by a schema read at this tree. `trust_events.user_id` and `trust_profiles.user_id` are **`ON DELETE CASCADE` on `profiles`** (`artifacts/api-server/baseline/20260819_baseline_structure.sql:25389#ADD CONSTRAINT trust_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;`), so an erased subject's derived trust evidence *is* destroyed — by cascade, not by any step `AccountDeletionService` takes (it names no trust table at all). And the same file shows the mirror of D-MODACTION-FK inside Trust's own tables: `trust_events.reviewed_by` and `trust_caps.lifted_by` are plain NO ACTION references to `profiles`, so **erasing a moderator is blocked by the trust rows they adjudicated**. Still `CV`; the retention policy is what is missing, and now the three mechanisms it must reconcile are each measured rather than described. |

**Anchored citations repointed.** Rewriting `providers.ts` invalidated eleven anchored
citations in §12.3, §12.4 and §12.6 that named line ranges inside the old stubs. Each was
re-derived by **searching for the anchor**, never by adding this diff's offset — the failure mode
§2's note records twice. They now resolve line-exact, and `check:doc-citations` reports **zero**
census-trust failures (repo-wide it is red for `census-compass`, `census-passport`,
`census-highlights-memories` and `docs/discovery/ROADMAP.md`, none of which this lane touched).
Two anchors had no successor in `providers.ts` at all — the vendor mapping comments moved into
the new adapter files — and are repointed to
`services/identityVerification/stripeIdentity.ts:28# *   createSession            -> POST /v1/identity/verification_sessions`
and `services/identityVerification/persona.ts:14# *   createSession            -> POST /api/v1/inquiries   (+ one-time link)`.

### 14.6 The twenty rows that did not move, and WHAT WOULD TURN EACH ONE RED

A row left `W`, `NB` or `CV` without saying what evidence would settle it is an excuse. Each
line below names the evidence and **who can supply it** — one of: OWNER (a decision or an
account), DEPLOY (a release or a migration application), or a NAMED LANE (a file this lane does
not own; see §14.7).

| id | V | What would settle it, and who supplies it |
|---|---|---|
| A6 | W | **DEPLOY.** The row is defined as a production measurement, so no code closes it. Settled by: deploying the emitters that merged to `main` on 2026-09-09, then one real stamp award, then a read showing `trust_events` carrying a `stamp_verified` row. Turns red the moment a post-deploy read still shows the count at zero. Second, weaker blocker: production traffic is test accounts, so even a non-zero count measures wiring, not live evidence. |
| C22 | W | **OWNER — D-OVERRIDE**, stated as one question in §14.4. Settled by picking PIN or CAP plus the three follow-ons (precedence over a moderation ceiling, expiry, removal). Implementation after that is a day. Turns red if any of the four characterization assertions in `test/trust-integration.test.ts` starts failing — which is what a silent conversion would do. |
| TV-P2 | W | **OWNER — D-DOB.** A privacy commitment is not a lane's to amend. Settled by: either (a) honour the invariant — migrate the six gates off `profiles.date_of_birth` onto `is_over_18` and drop the column, or (b) amend invariant 2 in writing. Evidence that would turn it red today: production still holds a DOB for 7 of 58 profiles and `is_over_18` is read by **no** gate. Implementation lane: the gates are in `lib/travelerVerification.ts`, `routes/{profile,events,meetups,requests,discovery}.ts` — none owned here. |
| TV-P3 | W | **OWNER — D-MODACTION-FK**, then a MIGRATION the integration owner must number. Settled by converging `moderation_actions.target_user_id` from CASCADE to SET NULL and `performed_by` from NO ACTION to SET NULL, as `migrations/2138_profiles_fk_convergence_prep.sql:103#('moderation_actions','performed_by','SETNULL'),` already intends — or by amending invariant 3. §14.5 adds `trust_events.reviewed_by` and `trust_caps.lifted_by` to the same list. Red today: erasing a subject destroys every enforcement record about them, and erasing a moderator is blocked outright. |
| TV-0a | W | **OWNER — D-MODACTION-SHAPE**, then a MIGRATION. Settled by either adding `report_id` and `expires_at` to `moderation_actions`, or ratifying the `metadata` jsonb convention `lib/moderationAudit.ts` already documents as a workaround. Until then "suspend with expiry" and the report→action link are not expressible in the live columns, which is also half of TV-4a. |
| TV-0e | NB | **OWNER — D-BADGE** (wording and colours are listed as unresolved brand decisions), then the CLIENT LANE. Settled by a `VerifiedBadge` component existing and reading `verificationLevel`. §14.5 sharpens what "not built" means here: a badge already renders from the wrong source. |
| TV-1a | W | **VERIFICATION-ROUTE LANE.** One word. `routes/verification.ts:257#status:` writes `pending` where the plan says `created`; both are legal under the live CHECK and no consumer distinguishes them, so the effect is nil and the criterion is still unmet. Settled by changing that literal to `"created"` and asserting it in `test/verification.test.ts`. Not this lane's file (§14.7). |
| TV-1c | W | **OWNER — D-2870-APPLY**, i.e. DEPLOY. `migrations/2870_profiles_verification_level_identity_vocabulary.sql` is written, reversible, additive, and applied to **no database**. Until it is applied no user can become ID-verified at all: the write is a 23514 and the provider retries the same rejected value forever. Grading `C` on a staged file is the error this census is named for. |
| TV-2a | W | **CLIENT LANE.** Passport entry point exists; the Rent-a-Buddy gate does not route anywhere. Settled by a screen under `app/(rent-a-buddy)/` linking to `/profile/verification`, so a user the server-side gate refuses is given a way to satisfy it. |
| TV-2b | W | **CLIENT LANE** (+ the TV-7c copy). Three of four screens exist. Settled by a "what we never store" section on `app/profile/verification.tsx` — the plan's own bolded clause, and the user-facing half of TV-P1/TV-P2. The server-side facts it would state are now enumerable from `services/identityVerification/types.ts` and the two adapter headers. |
| TV-2c | NB | **OWNER — D-BADGE**, then the CLIENT LANE. Settled by rendering the badge inside `UserIdentityLink` on the six named surfaces, sourced from `verificationLevel` and **not** from `profiles.verified` (§14.5). Also needs TV-1c applied, or every badge is correctly absent. |
| TV-2d | W | **CLIENT LANE.** Settled by human failure copy replacing `failureReason.replace(/_/g,' ')`, and by `underage` taking a distinct branch that does not re-offer the retry CTA. The normalized reasons the client must switch on are fixed and now generated by both real adapters as well as the mock. |
| TV-4a | W | **ADMIN-ROUTE LANE**, gated on D-MODACTION-SHAPE for two of five criteria. Settled by: a category filter on `GET /admin/moderation/reports`; subject snapshots for post/comment/message/event/review/listing, not just `place`; and a route that ACTS on a `moderation_reports` row — today nothing updates `moderation_reports.status`, so the queue can only grow (re-confirmed at this tree by grep). |
| TV-4b | W | **OWNER — D-SUSPENSION-UX**, then the auth and client lanes. Settled by deciding whether a suspended user gets the specified read-only state with an appeal contact or whether the blanket 403 at `artifacts/api-server/src/lib/http.ts:374#if (accountStatus === "suspended") {` is ratified, and whether a banned user is signed out rather than 403'd. `routes/appeals.ts` and `app/appeals.tsx` both exist and nothing points at them from the refusal. |
| TV-5a | W | **CLIENT LANE.** Four of six links present. Settled by adding SOS and community guidelines to `app/profile/edit/safety.tsx`. A repository-wide search still returns no community-guidelines surface at all, so one has to be written before it can be linked. |
| TV-5b | NB | **OWNER — D-DOB** (same decision as TV-P2), then the gate lanes. Settled by the 18+ gates reading `is_over_18` from the latest verified row and showing a "verify to access" gate rather than hiding silently. Cannot be built first: writing the gate decides D-DOB. |
| TV-6a | NB | **OWNER — D-PROVIDER.** Six steps, no code reading needed: (1) choose Stripe Identity or Persona; (2) open the account; (3) obtain `STRIPE_IDENTITY_SECRET_KEY`, or `PERSONA_API_KEY` + `PERSONA_TEMPLATE_ID`; (4) register `POST https://<api-host>/api/verification/webhook`; (5) take the signing secret from that registration as `IDENTITY_WEBHOOK_SECRET` — **the adapters now consume exactly this variable, for both vendors**; (6) set all of it in Replit Secrets with `IDENTITY_PROVIDER` set to the chosen name **in staging first**. ~$1.50–3.00 per attempt at either vendor. |
| TV-6b | W | **OWNER (TV-6a) → then this lane, one session.** The code is written for both vendors, so the choice no longer gates the code. Settled by: a sandbox transcript showing session→hosted flow→signed webhook→`verified` row→`profiles.verification_level` set, which also proves the payload mapping this pass could not; then adding the chosen name to `services/identityVerification/readiness.ts:53#const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);`; then the staging flip. **What would turn it red:** a sandbox run in which any documented field this lane guessed — Stripe `verified_outputs.address.country` or `last_error.code`, Persona `attributes.status`, `birthdate`, `country-code`, or the `included[]` check names — is not where it was assumed. That is a likely outcome and is the honest reason this is `W`. |
| TV-7c | NB | **CLIENT LANE.** Settled by a privacy-policy surface existing at all — re-searched at this tree, `travel-buddy-standalone/app` and `src` contain no privacy-policy screen, route or link, and `app/settings/index.tsx` mentions neither identity verification nor a government-ID check. The four matches a search returns are prose inside Passport QR comments. Content is available: invariants 1–5 plus §14.3's inventory. |
| TRV2-08 | NB | **OWNER — D-RESTRICTION-REACH**, then four lanes. A product scope decision, not a wiring task: *which* Compass, Discovery, social and booking actions must refuse a restricted user? Re-confirmed at this tree — `getRestrictionState` still has exactly five non-Trust callers (messaging, calls, hosting, crew live-share, and a Passport PROJECTION that is display, not a gate); `src/compass/` and `routes/discovery*.ts` contain no call. A restricted user is still recommended, discovered and bookable. |
| TRV2-10 | CV | **OWNER — D-REVERSAL.** Not verifiable, because correctness is defined by "the **defined** policy" and none is defined. The three mechanisms, each measured at this tree: (a) admin revocation clears `verification_level` and explicitly does NOT reverse the `identity_verified` +10, with `routes/admin.ts` naming D-REVERSAL as the reason; (b) an upheld appeal emits `appeal_approved` (+2 community_value) at `services/appeals/resolveAppeal.ts:288#eventType:  "appeal_approved",` — it ADDS a small positive and reverses nothing, which is a different mechanism from `revokeModerationTrustConsequences`; (c) account deletion destroys trust evidence by FK cascade while `AccountDeletionService` names no trust table. Settled by answering, for each of revocation / upheld appeal / deletion: does the derived effect reverse, decay, or persist — and if it reverses, by a counter-event or by deleting the original? Plus: how long does derived evidence about an erased subject survive, and is the plan's 90-day verification-record value the answer for Trust evidence too, or not? **The load-bearing half of (a) is now a MEASUREMENT, not a reading**: `test/trust-integration.test.ts`, `D-REVERSAL: revocation reverses moderation consequences and nothing else`, asserts that `revokeModerationTrustConsequences` dismisses the moderation-sourced finding and leaves an `identity_verified` award at `applied`, because it selects on `source_type = 'moderation'` and the award's source type is `identity_verification`. So the two halves of "verified" — the displayed level and the trust award — come apart on revocation, by construction rather than by oversight, and the assertion goes red if that scope silently changes. Mutations: V1 (drop the `source_type` filter) **65/2 RED**; V2 (lift caps by user instead of by source event) **66/1 RED**. |

### 14.7 Cross-lane requests

Each names the file, the change, and why this lane cannot make it.

1. **`artifacts/api-server/package.json`** (integration owner) — append
   `src/test/verificationWebhookSignature.test.ts src/test/verificationProviderNormalization.test.ts`
   to the `test` script. Without it both files exist and never run.
2. **`artifacts/api-server/src/routes/verification.ts:257#status:`** (verification-route lane) — write
   `status: "created"` on insert instead of `"pending"`. Closes TV-1a's fourth criterion. No
   behavioural effect: both are legal under the live CHECK and the client treats
   `created`/`pending`/`processing` identically.
3. **`artifacts/api-server/src/routes/verification.ts`, then reading `patch.provider_verification_ref = result.providerVerificationRef ?? null;`** (verification-route lane) —
   `provider_verification_ref` is written only on `status === "verified"`. A failed or expired
   attempt still left a government ID with the vendor, and `requestProviderDeletionForUser`
   reads that column and nothing else, so those copies can never be offered for redaction.
   Persist the handle for every status. Both adapters already supply it for every status
   (§14.2, mutation N5). Affects TV-7a and TV-P3.
4. **`artifacts/api-server/src/compass/CompassTools.ts:1610`** and
   `travel-buddy-standalone/src/components/{BuddyCard,compass/CompassTravelerRow,compass/CompassBuddyRow}.tsx`
   (Compass and client lanes) — the rendered "verified" indicator is sourced from
   `profiles.verified`, a legacy boolean unrelated to the ID check. Under TRV2-12 ("verified
   badge reflects actual verification state") this is a badge asserting something Portava has
   not measured. Needs D-BADGE before it is re-sourced, so this is a flag, not a patch request.
5. **Migration numbering** (integration owner) — TV-P3 and TV-0a both need a migration this lane
   is not permitted to number. No file was written for either.

### 14.8 Restated headline

> **Trust, at this tree: 93 requirements · 72 BUILT-AND-CORRECT · 14 BUILT-BUT-WRONG ·
> 6 NOT-BUILT · 1 CANNOT-VERIFY → CONSTRUCTED 86 / 93 = 92.5 % · CORRECT 72 / 93 = 77.4 %.**
>
> Against §13.3's 93-row figure of 71 / 14 / 7 / 1 → CONSTRUCTED 91.4 %, CORRECT 76.3 %:
> **CONSTRUCTED +1.1 points, CORRECT +1.1 points.** One row built and certified, one row moved
> off NOT-BUILT and honestly left BUILT-BUT-WRONG.
>
> The retired 52-row headline of CORRECT 96.2 % is **not** comparable to any number on this page
> and is not restated here as a comparison, because comparing a 93-row measurement to a 52-row
> one describes the denominator, not the surface.

| BUILT-AND-CORRECT | **72** |
|---|---|
| BUILT-BUT-WRONG | **14** |
| NOT-BUILT | **6** |
| CANNOT-VERIFY | **1** |

*This supersedes §13.3 under LAST-STATEMENT-WINS. §13.3 is left in place because this file is
append-only.*

**What the remaining gap is, in one paragraph.** Twenty of the twenty-two open rows are blocked
on something no lane can produce: **eight owner decisions** (D-SCORING and D-OVERRIDE, stated as
single answerable questions above; D-DOB, D-MODACTION-SHAPE, D-MODACTION-FK, D-SUSPENSION-UX,
D-BADGE, D-RESTRICTION-REACH, D-PROVIDER, D-REVERSAL), **one migration application**
(D-2870-APPLY, without which no user can ever become ID-verified), **one deploy** (A6, which is
a production measurement by its own wording), and **eight rows in files owned by other lanes**.
Two were code, and both are now written. The honest reading of 77.4 % is not that the surface is
three-quarters finished; it is that the buildable part is nearly exhausted and the rest is
waiting on people, not on engineering.

---

## 15. D-OVERRIDE RULED — **CAP now, PIN later behind a flag** — and the one defect that ruling exposed

This section supersedes §14.4's third bullet under LAST-STATEMENT-WINS. Nothing else in §14.4
moves: the five observable differences, the two candidate semantics and the four characterization
mutations O1–O4 all still hold, and not one of their assertions was rewritten — which is what the
ruling ratifying today's semantics is supposed to look like.

### 15.1 The ruling

> **CAP now, PIN later behind a flag.** Fix the lost upsert so the ceiling actually persists, ship
> that, and keep the relief case as separate later work rather than widening this change.

So, settled, for D-OVERRIDE's first clause: **an admin score override is a CEILING.** The admin
sets a maximum; events move the category below it; nothing lifts it above. An admin can
**withhold** standing and cannot **grant** it. Of the three follow-on clauses, exactly one is
answered and two are explicitly deferred — see §15.5, which names each, says what it would take,
and is written so the follow-up is a read-and-build rather than a rediscovery.

### 15.2 The defect, RE-VERIFIED — and §14.4's description of it was wrong in the direction that mattered

§14.4 asserted that an upward override "never lands at all — not 'does not persist': there is no
window in which it was true." **That is true only while `recalculateTrustScore` succeeds**, and it
is the statement that hid the real defect. Re-executed at this tree, against a client whose
`trust_events` read returns a database error:

| | before the fix | after |
|---|---|---|
| `adminOverrideScore(admin, u, respect_safety, 90)` returns | `{ ok: true }` | **rejects** — `recalculateTrustScore: trust_events read failed` |
| `trust_profiles.respect_safety` (a `behavior_confirmed` ceiling of 40 stands) | **90** | **40** |
| `trust_profiles.overall_score` on the same row | 48.5 — describing the OLD score | 48.5, still agreeing with the category |
| `trust_admin_actions` rows with `action_type='score_override'` | **1**, recording an override the engine never applied | **0** |

`recalculateTrustScore` is deliberately FAIL-CLOSED (`services/trust/TrustScoreService.ts:159#recalculateTrustScore: trust_events read failed for`),
and `adminOverrideScore` swallowed that throw with `.catch(() => {})` — **after** writing the
admin's raw number straight into `trust_profiles` "for immediate effect". So:

* On the **success** path the raw write is dead. The recalculation overwrites it, which is what
  §14.4 measured and correctly described.
* On the **failure** path the raw write **stood, permanently**. An upward 90 against a
  `behavior_confirmed` ceiling of 40 therefore granted exactly the relief the ruling says an admin
  does not have — bypassing `loadCaps`' `Math.min` entirely rather than losing to it
  (`services/trust/TrustScoreService.ts:186#caps[row.category] = cur !== undefined ? Math.min(cur, row.ceiling_score) : row.ceiling_score;`).
  The row was left internally inconsistent (a category value no `overall_score` or `public_level`
  on it corresponds to), the admin was told `{ ok: true }`, and the audit log — the one record
  whose whole purpose is to be trustworthy — recorded it as applied.
* And in the case the ruling actually cares about, a **downward** ceiling on that same path never
  reached `trust_profiles.overall_score` at all — the weighted number that gates event RSVPs and
  ranks the buddy marketplace and Pulse. Nothing retries it.

**So "an override does not land" was the wrong diagnosis and would have produced the wrong fix.**
A downward ceiling always landed and always survived recalculation; that half was never broken and
`test/trust-integration.test.ts`'s "an override BELOW the natural score survives recalculation" has
been green throughout. What was broken is that whether the ceiling reached the score was never
checked, and a failure was reported and audited as a success.

### 15.3 What was changed — one function, and nothing else

`services/trust/TrustAdminService.ts:368#const cap = await createCap(db, {` still writes the
`trust_caps` ceiling exactly as before; the cap row IS the durable ceiling and it is unchanged.
What changed, in `adminOverrideScore` alone:

1. **The raw `trust_profiles` upsert is gone.** `recalculateTrustScore` is now the only writer of a
   scored column, so no number reaches a category without passing through `loadCaps`' `Math.min`.
2. **The recalculation's failure is no longer swallowed** —
   `services/trust/TrustAdminService.ts:377#const recalculated = await recalculateTrustScore(db, targetUserId);`
   — the same rule `confirmEvent`, `dismissEvent` and `adminResolveReview` already apply to their
   own transitions. No `score_override` audit row is written for an override the engine did not
   apply. The cap row is deliberately NOT rolled back: it is the ceiling, and the next successful
   recalculation applies it.
3. **The persisted value is READ BACK, not computed** —
   `services/trust/TrustAdminService.ts:380#const read = await getTrustProfileResult(db, targetUserId);`
   and `services/trust/TrustAdminService.ts:409#const persistedScore = notScored ? null : Number(rawPersisted);`
   — because `recalculateTrustScore` persists non-fatally: it logs and returns the computed result
   even when its own upsert failed. Returning the computed number would be this function asserting
   a persist it had not observed. A persisted value above the ceiling now throws.
4. **The result and the audit row say what HAPPENED.** `adminOverrideScore` returns
   `{ ok, category, persistedScore, ceilingBinding }` and logs the same, where `ceilingBinding`
   (`services/trust/TrustAdminService.ts:420#const ceilingBinding =`) is true only when the admin's
   number is what is holding the score down — false when the natural score already sits below it,
   and false when a LOWER ceiling (a moderation cap, another admin's override) is the binding one.
   **An upward override reads `false`.** That is CAP semantics reported out loud instead of applied
   silently, and it is the whole of what this change gives an admin that they did not have.

**No scoring parameter was touched.** The nine weights, six level thresholds, 90-day half-life,
365-day window, earn/lose asymmetry and fifty per-event deltas are untouched and unratified, and
`services/trust/TrustScoreService.ts` is byte-identical to its state before this pass. **No
observable score arising from them changes**: on every path where the recalculation succeeds, the
number persisted before and after this change is the same number.

### 15.4 The test, and the mutations that turn it red

`src/test/trust-integration.test.ts:1793#describe("D-OVERRIDE: the ceiling the owner ruled for must PERSIST"` —
three cases, appended to an already-registered suite. **GREEN 67/67 → 70/70**, and all three were
**RED before the fix** (the third with `Missing expected rejection`, i.e. the false success itself).

| # | case | what it asserts |
|---|---|---|
| 1 | `src/test/trust-integration.test.ts:1819#it("a downward ceiling reaches trust_profiles, and the call REPORTS that it bound"` | the ceiling is on the row, `overall_score` fell with it, and `ceilingBinding` is true |
| 2 | `src/test/trust-integration.test.ts:1847#it("an UPWARD override reports that it bound NOTHING — CAP semantics, said out loud"` | `persistedScore` is the natural score and `ceilingBinding` is **false**, in the result AND in the audit metadata |
| 3 | `src/test/trust-integration.test.ts:1869#it("a failed recalculation leaves NO raw admin number on the row, and is never audited as applied"` | **the defect.** With `trust_events` unreadable: rejects, no raw number on the row, the row stays internally consistent, zero `score_override` audit rows, and the cap row stands |

Four mutations, each run and each **RED**:

| id | mutation | goes red |
|---|---|---|
| P1 | restore the raw `trust_profiles` upsert before the recalculation | case 3 |
| P2 | swallow the recalculation failure again (`.catch(() => {})`) | case 3 |
| P3 | report `ceilingBinding` unconditionally `true` | case 2 |
| P4 | invert the ceiling comparison in `recalculateTrustScore` (`services/trust/TrustScoreService.ts:454#if (caps[cat] !== undefined && capped > caps[cat]) {` → `<`) — reverted immediately; the file is unchanged | cases 1 and 2 |

P4 exists because P1–P3 leave case 1 green whatever they do to the implementation, and a case that
cannot fail is worse than no case (§LANE-RULES 4). It also demonstrates that case 1 measures the
ceiling actually binding, not merely a field being returned.

### 15.5 DELIBERATELY NOT BUILT — later work, behind a flag that does not exist yet

Each of these was in scope for the question and is out of scope for this change by the owner's
words. **None of them is built and the flag is NOT created.** Named here with what each would take
so the follow-up is a read-and-build:

| name | what it is | what it would take |
|---|---|---|
| **PIN semantics** | the admin's number IS the score until lifted; events stop moving that category; an admin can GRANT standing, not only withhold it | a `floor_score` column on `trust_caps` (a migration the integration owner must number), a second fold in `TrustScoreService.loadCaps` beside the `Math.min` at `services/trust/TrustScoreService.ts:186#caps[row.category] = cur !== undefined ? Math.min(cur, row.ceiling_score) : row.ceiling_score;`, and a `Math.max` applied AFTER the ceiling in `recalculateTrustScore`. §14.4's five-row table is the rewrite list: each row names the assertion that must change by name |
| **Relief from a moderation ceiling** | an admin override taking precedence over a `behavior_confirmed` cap in the same category | the `Math.min` fold above becoming reason-code aware. **NOT a `Math.max` swap** — that is mutation O2 and it would let ANY cap lift a score. Needs the authority question answered first: today an admin cannot grant relief and §14.4 records that as intended, not accidental |
| **Expiry** | a review date on an override | `adminOverrideScore` passing an `expiresAt` to `createCap`. The sweeper already handles it (`expireOldCaps` filters `expires_at < now`) and cannot sweep the null this function writes. Mutation O1 pins today's permanence |
| **Two admins overriding each other** | whose override wins, and whose removal clears whose | today: ceilings fold with `Math.min` so the LOWER wins regardless of who set it or when, and `adminRemoveOverride` lifts every active `admin_override` in the category, so one admin's removal clears another's. Mutation O4 pins the removal half. Needs a rule before it needs code |

A fifth item, not a semantics question but the reason none of this is urgent: **`adminOverrideScore`
and `adminRemoveOverride` are still unwired to any route.** Re-confirmed at this tree by grep over
the whole package — their only callers are `services/trust/` and the test suite. The
`score_override` string in `routes/trust-admin.ts` belongs to the trust-settings audit write, not to
an override endpoint.

### 15.6 Rows examined, and what moved

| id | before | after | why |
|---|---|---|---|
| C22 | W | **W** | **Part closed, and it is the part the owner settled.** The semantics question is ANSWERED (CAP), the defect it hid is fixed, and three cases plus four red mutations pin it. What keeps the row `W` is unchanged by any of that: **the behaviour is not wired to a reachable caller** — no route calls `adminOverrideScore`, so no admin can perform an override at all, and §LANE-RULES 5 requires a reachable caller before a `W → C`. **What would settle it:** a `POST /admin/trust/users/:userId/score-override` on `routes/trust-admin.ts` behind `requireAdmin`, plus a route test asserting the ceiling on the row. Deliberately not built here — the ruling scoped this change to one defect. Turns red if any of cases 1–3 or the four §14.4 characterization assertions starts failing |
| TRV2-10 | CV | **CV** | Untouched. D-REVERSAL is a different decision and this change reverses nothing |
| A6, TV-*, TRV2-08 | — | unchanged | Not examined; nothing in this change reaches them |

**No headline moves.** §14.8's 93 · 72 · 14 · 6 · 1 stands exactly as written: no row changed
verdict, because a decision plus a defect fix on an unwired function is not a constructed
requirement. Improving the percentage here would mean grading a route that does not exist.

### 15.7 What would turn THIS section's claims red

* Case 3 passing against the pre-fix `adminOverrideScore` — it does not; it fails with
  `Missing expected rejection`.
* A `trust_profiles` write appearing anywhere in `adminOverrideScore` again — P1.
* `adminOverrideScore` resolving when its recalculation threw — P2.
* A route calling `adminOverrideScore` appearing without C22 being re-graded.
* Any of the nine weights, six thresholds, the half-life or the window differing from §14.3's
  inventory — they do not; `TrustScoreService.ts` carries no diff from this pass.

---

## 16. The specs' PROSE was never enumerated — 15 new rows, 2026-09-14

*Measured in `/home/user/wt-483` (detached at `7d1f2d498`), same tree as §14 and §15, with three
sibling compliance lanes editing other surfaces. **No production read this pass.** No migration
applied to any database, no flag added or flipped, no provider enabled, no backfill run, no entry
added to `IMPLEMENTED_PROVIDERS`, no test written, no git write command run. The full clause-by-
clause audit this section summarises is [compliance-v1.md](../trust/compliance-v1.md).*

### 16.1 What the audit found, in one paragraph

§12 admitted the two owner specs and moved the denominator 52 → 93. It enumerated the v2
document's **requirements table** (`TRV2-01`…`TRV2-12`, §12.6) and the plan's **bullets**
(`TV-P1`…`TV-P5`, `TV-0a`…`TV-7c`, §12.3/§12.4). It did not enumerate either document's **prose**.
`docs/specs/upgrades-v2/03-TRUST-v2.md` has four prose sections stating **sixteen** further
obligations — concept separation, no-regression, the scoring-policy request, the fixture programme,
the release deliverable — and `docs/trust/verified-foundation-plan.md` states three more outside its
bullet lists. Twelve of those sixteen and all three of these had no row. The mechanism is worth
naming because it will recur: **a structural enumeration that walks table rows and `-` bullets is
exactly blind to a requirement written as a paragraph.**

`compliance-v1.md` enumerates **66 clauses** across the two documents and names the **14** prose
passages it excluded, with the reason for each. 51 of the 66 map onto rows this census already has.
**15 had no row at all.** They are added below, as new rows — never as a re-grade, because a clause
the census never counted cannot have been mis-graded.

### 16.2 The 15 new rows

Same verdict grammar as the rest of this document: `C` BUILT-AND-CORRECT · `W` BUILT-BUT-WRONG ·
`NB` NOT-BUILT · `CV` CANNOT-VERIFY. A parent with several mandatory criteria cannot be `C` unless
every criterion passes, and the failing criterion is named. Every suite named below was **re-run at
this tree**, not quoted.

| # | Requirement (spec line) | Verdict | Evidence at this tree |
|---|---|---|---|
| (V2-P1 — NOT COUNTED) | Reuse canonical Trust events, score projection, caps, restrictions, admin actions, review queues, repair/scheduling and privacy guards — eight named subsystems (`docs/specs/upgrades-v2/03-TRUST-v2.md:7#Reuse canonical Trust events`) | **C** | *Not a new row — recorded here for completeness because §12 never stated it as a clause; it is carried by A5, A17, C10 and C31 and is NOT counted again below.* |
| TV-U1 | "Keep these concepts separate … **Never merge them into one score**" — verified identity, person Trust, eligibility restrictions, source reliability, signal reliability, world confidence, personal fit, venue quality (`docs/specs/upgrades-v2/03-TRUST-v2.md:9#Keep these concepts separate`) | **W** | Separate for six of the eight: source/signal (A18), restrictions (four booleans), verified identity (a different column); `world confidence` and `venue quality` do not exist as scores at all, so there is nothing to keep apart. **Merged for the seventh.** `personal fit` folds person Trust into one emitted 0–100 number: `artifacts/api-server/src/services/rentBuddy/CompatibilityScoreService.ts:87#  trustScore:         8,` is a weight of 8 in a 14-input weighted sum, applied at `artifacts/api-server/src/services/rentBuddy/CompatibilityScoreService.ts:193#breakdown.trustScore = clamp(buddy.trustScore);`, and it is live — `artifacts/api-server/src/routes/rentABuddyMarketplace.ts:463#toBuddyScoringData(r, trustMap.get(r.user_id) ?? 50)`, the P45 constant-substitution shape a third time. **The reading is contestable and is NOT settled here:** A16 already grades "the score as one ranking *input*" as acceptable, and a weighted term inside an emitted score is more than an input. Graded `W`, not `NB` on the strict reading nor `C` on the charitable one. **Owner files:** Rent-a-Buddy's, not this lane's — cross-lane request in §16.6. |
| TV-U2 | Preserve current approved behavior while resolving specification gaps (`docs/specs/upgrades-v2/03-TRUST-v2.md:9#Keep these concepts separate`) | **CV** | **Awaiting D-SCORING**, and unverifiable by construction until it lands: twelve families of scoring parameters run in production and are ratified nowhere (`docs/trust/scoring-parameters-for-ratification.md`), so "current *approved* behavior" names an approval that does not exist. The non-scoring half holds — every suite in §16.5 is green — but a parent cannot be `C` on one criterion. **Evidence that would settle it:** a D-SCORING ruling; "all twelve, ratify as v1" is complete. **Who supplies it:** OWNER. |
| TV-U3 | Before changing scoring behavior, **request** the authoritative policy for event eligibility, category weights, decay, caps, thresholds, serious findings, recovery, reversals and appeals (`docs/specs/upgrades-v2/03-TRUST-v2.md:34#Before changing scoring behavior`) | **C** | The request exists and is specific: `docs/trust/scoring-parameters-for-ratification.md` enumerates twelve families under §1–§12 and closes with *"What a ruling unblocks, precisely"*. No scoring behavior changed — `TrustScoreService.ts` carries no diff from the D-OVERRIDE pass (§15.7). **What would turn it red:** a diff to the nine weights, six thresholds, half-life or window landing without a ratification. |
| TV-U4 | Inventory existing behavior as implementation evidence; **do not promote it to approved specification automatically** (`docs/specs/upgrades-v2/03-TRUST-v2.md:34#do not promote it to approved specification automatically`) | **C** | The inventory marks each family *overridable* or *HARD-CODED* and states its own status: *"Nothing here is a request to change a number"*, and *"Until a ruling lands, the dependent rows in `census-trust.md` stay `W`/`N` … They will not be moved on an assumption."* **Red:** any row moving to `C` citing that document as its specification. |
| TV-U5 | The plan's retention values apply to the stated verification records, **not automatically to all Trust evidence**; do not rewrite unrelated retention rules (`docs/specs/upgrades-v2/03-TRUST-v2.md:38#Also request unresolved public labels`) | **C** | Scoped to one table and two statuses: `artifacts/api-server/src/services/identityVerification/retention.ts:31#export const PURGEABLE_STATUSES: readonly string[] = ["failed", "expired"];` and `artifacts/api-server/src/services/identityVerification/retention.ts:34#export const VERIFICATION_RETENTION_DAYS = 90;`. No trust table is named anywhere in the file. **Red, and it is a real test:** `artifacts/api-server/src/test/verificationRetention.test.ts` asserts the status set *as a set* and that the purge *"never names a verified row, by any spelling of the filter"* — 7/7 green. |
| TV-U6 | Missing scoring policy prevents claiming complete Trust specification or **100 % correctness** (`docs/specs/upgrades-v2/03-TRUST-v2.md:40#Missing scoring policy prevents claiming`) | **C** | §14.8 states CORRECT 72/93 = 77.4 %; §14.0 explicitly retires the 96.2 % figure and forbids quoting it; §16.4 restates against 108. **Red:** `check:census-integrity`, which recomputes per-census counts from the tables — exit 0 at this tree. |
| TV-U7 | Use isolated fixtures spanning caller/subject asymmetry, concurrent duplicate events, projection failure, stale evidence, invalid signatures, unauthorized admins, revoked verification and appeal outcomes — **eight named classes** (`docs/specs/upgrades-v2/03-TRUST-v2.md:44#Use isolated fixtures spanning`) | **C** | All eight present, isolated (every one injects a double) and green, one file each: `artifacts/api-server/src/test/zeroRowTrustAdjudication.test.ts:192#it("does not audit a dismissal another admin made"` · `artifacts/api-server/src/test/verificationTrustIdempotency.test.ts:26#TRV2-06` · `artifacts/api-server/src/test/trustProfileUnreadableDowngrade.test.ts:95#assert.equal(broken.state, "unavailable"` · `artifacts/api-server/src/test/trustAsymmetryAndMaintenance.test.ts:187#describe("TrustScoreService — the earn/lose asymmetry"` · `artifacts/api-server/src/test/verificationWebhookSignature.test.ts:215#REJECTS a replayed webhook whose timestamp is outside tolerance` · `artifacts/api-server/src/test/trust-integration.test.ts:336#it("GET /admin/trust/reviews returns 403 for non-admin"` · `artifacts/api-server/src/test/adminUnverifyRevokesIdLevel.test.ts:5#verified-foundation-plan.md V-4:` · `artifacts/api-server/src/test/appealReversalAffectedRows.test.ts:182#recordTrustEvent`. **Red:** deleting any one of the eight; `check:test-registration` makes that loud. |
| TV-U8 | Test actual consuming routes and **real database constraints/RLS** where applicable (`docs/specs/upgrades-v2/03-TRUST-v2.md:44#Use isolated fixtures spanning`) | **W** | Routes half holds: the signature suite drives `POST /api/verification/webhook` end to end (three route-level cases), the admin suite drives the guarded routes. Database half does not. The one live constraint that was ever measured is the one that **rejects** the write, and its fix is staged and applied nowhere — `artifacts/api-server/src/test/verificationLevelVocabulary.test.ts` is 3/3 green and documents a broken production path rather than exercising a working one. RLS is exercised by no test at all: migration 2370's revocations went to CI only; production is an owner decision (A8). |
| TV-U9 | A mocked provider test certifies only the adapter contract; provider sandbox and production operational evidence remain separate (`docs/specs/upgrades-v2/03-TRUST-v2.md:44#Use isolated fixtures spanning`) | **C** | `artifacts/api-server/src/services/identityVerification/readiness.ts:53#const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);` — unchanged with both real adapters written, which is the strongest form of this clause because the temptation was live. **Enforced by a test, not promised:** `artifacts/api-server/src/test/rentBuddyKycGate.test.ts:77#assert.match(stripe.reason, /IMPLEMENTED_PROVIDERS/` requires the refusal reason to name both the sandbox evidence and the switch — 12/12 green. This is the clause that keeps TV-6b honestly `W`. |
| TV-U10 | Preserve report/block journeys, badges, age gates, Safety Center and existing authorized consumers (`docs/specs/upgrades-v2/03-TRUST-v2.md:46#Preserve report/block journeys`) | **C** | A no-regression clause and nothing regressed: TV-3a–TV-3d unchanged; `artifacts/api-server/src/test/ageGate.test.ts` 6/6; TV-5a still incomplete at four of six links but not *broken*; the seven `buildConsumerProjection` variants untouched. **Red:** any of those suites going red beside a Trust change. |
| TV-U11 | Do not enable providers, run historical backfills, alter scoring policy or activate production flags **merely to close a requirement** (`docs/specs/upgrades-v2/03-TRUST-v2.md:46#Preserve report/block journeys`) | **C** | Four checks re-executed: `IMPLEMENTED_PROVIDERS` still `["mock"]`; no backfill writes trust (TRV2-11's grep re-run); `TrustScoreService.ts` carries no diff; no flag added or flipped in this pass or the two before it. |
| TV-U12 | Produce the concrete configuration/release steps and identify the exact remaining owner action (`docs/specs/upgrades-v2/03-TRUST-v2.md:46#Preserve report/block journeys`) | **C** | §12.7's TV-6a row lists six steps, and they were verified **against the code** rather than against the prose: `IDENTITY_WEBHOOK_SECRET` is the single signing-secret variable for both vendors (`artifacts/api-server/src/services/identityVerification/providers.ts:63#  return process.env['IDENTITY_WEBHOOK_SECRET'];`), with `STRIPE_IDENTITY_SECRET_KEY` / `PERSONA_API_KEY` + `PERSONA_TEMPLATE_ID` per vendor. The remaining owner action is named exactly: D-PROVIDER. |
| TV-G1 | Built **provider-agnostic** so the ID-check vendor is a config decision, not an architecture decision (`docs/trust/verified-foundation-plan.md:7#built provider-agnostic so the ID-check`) | **C** | Measured, not asserted: a repository-wide search for `stripeIdentity`, `from './persona'` or `personaCreateSession` returns three files, all inside `services/identityVerification/` plus one test; `routes/verification.ts` names no vendor outside a comment. Selection is one line — `artifacts/api-server/src/services/identityVerification/providers.ts:149#const name = (process.env.IDENTITY_PROVIDER ?? 'mock').toLowerCase();`. **Red, and it is a test:** `verificationWebhookSignature.test.ts` §*"REAL_PROVIDER_NAMES cannot drift from the factory it quantifies over"* asserts coverage of every non-mock branch the factory can return. |
| TV-P0 | The five invariants are *"non-negotiable, **encoded in schema + adapter types**"* (`docs/trust/verified-foundation-plan.md:11#non-negotiable, encoded in schema + adapter types`) | **W** | The *encoding* is a distinct obligation from the invariants, and TV-P1's cell records its absence as a caveat — *"nothing ENFORCES this"* — which is not a graded requirement. Encoded: invariant 1, by the absent column and the absent field (`artifacts/api-server/src/services/identityVerification/types.ts:58#export interface VerificationResult {`), so TypeScript refuses an adapter that returns one. Not encoded: invariant 2 holds on the verification path only while `profiles.date_of_birth` lives outside it; invariant 3 is **contradicted** by the schema (CASCADE, not SET NULL); invariants 4 and 5 are runtime throws, not type or schema constraints. And no guard exists — `grep` over `src/scripts/` and `scripts/` finds no check on `identity_verifications`' shape. |
| TV-6c | **Monitor attempts per verified user** — ">2.0 average means UX friction worth fixing" (`docs/trust/verified-foundation-plan.md:107#monitor attempts`) | **NB** | **The one V-phase obligation with no row**, and the reason it was missed is structural: it sits in V-6's cost paragraph rather than in a `-` bullet, and §12.4 walked bullets. No metric, counter, report or query exists: a repository-wide search returns only an unrelated phone-verification per-hour ceiling (`artifacts/api-server/src/services/phoneVerification/PhoneVerificationService.ts:58#Confirm attempts per user per hour`) and an admin-visuals "avg attempts per success" for a different subsystem. Rate limiting (TV-1e) is the *control*; the plan asks separately for the *measurement*, and without it nobody can tell whether the >2.0 threshold has been crossed. **Blocked on nothing.** |

**Counted:** 15 rows — `TV-U1`…`TV-U12`, `TV-G1`, `TV-P0`, `TV-6c`. `C` 10 · `W` 3 · `NB` 1 · `CV` 1.
The `(V2-P1 — NOT COUNTED)` row above is explanatory and is **not** counted: it is A5/A17/C10/C31
restated, and its id cell is deliberately unparseable so the tallier cannot read it as a row —
the same device §2.B uses for census-passport's P45/P50/P154.

**Ids.** These carry this census's own `TV-` grammar so `check:census-integrity` can read them;
[compliance-v1.md](../trust/compliance-v1.md) numbers the same clauses by their position in the
spec. The map is one line: `TV-U1`=V2-P2 · `TV-U2`=V2-P3 · `TV-U3`=V2-P6 · `TV-U4`=V2-P7 ·
`TV-U5`=V2-P9 · `TV-U6`=V2-P10 · `TV-U7`=V2-P11 · `TV-U8`=V2-P12 · `TV-U9`=V2-P13 ·
`TV-U10`=V2-P14 · `TV-U11`=V2-P15 · `TV-U12`=V2-P16 · `TV-G1`=VF-G1 · `TV-P0`=VF-P0 ·
`TV-6c`=VF-6c. `TV-U*` are the twelve prose clauses of the v2 **U**pgrade document; `TV-6c` joins
the phase series it belongs to, as V-6's third obligation.

### 16.3 Mapping corrections — §12.6 verified against the spec text, not against §12.6

Every one of the twelve dispositions was re-derived from the spec sentence. **No disposition was
found wrong.** Two are incomplete in evidence and one census claim has expired. **No verdict moves.**

| Row | Correction |
|---|---|
| **A19** (TRV2-01's mapping) | §12.6 calls TRV2-01 a duplicate of A19, *"same obligation, stricter wording"*, and that is right. But TRV2-01 also says *"and anonymous contribution"*, and A19's cell cites nothing for it. The substance holds on evidence A19 never named: `artifacts/api-server/src/lib/sensingAnonStore.ts` and `artifacts/api-server/src/lib/sensingCoverageAggregate.ts` contain **zero** occurrences of the string `trust` — measured with `grep -c`, both 0 — so the anonymous contribution path cannot reach person trust at all. **Separately, and this is the finding:** TRV2-01's own stated evidence bar is *"Sensor/aggregate fixtures generate zero person Trust effects"*, and **no such fixture exists**. If `recordTrustEvent` were added to `sensingCoverageAggregate.ts` tomorrow, nothing in the suite would go red. A19 stays `C` for what A19 claims; the missing fixture is §16.6's first cross-lane request. |
| **A18** (TRV2-02's mapping) | §12.6 calls TRV2-02 a duplicate of A18. Correct for the first criterion. The second — *"no reverse lookup of anonymous contributors"* — is a different obligation with different evidence that A18's cell does not carry: migration 2315's postconditions RAISE on **any** foreign key and on any identity-shaped column name, asserted at `artifacts/api-server/src/test/sensingAnonStore.test.ts:89#a stronger postcondition RAISEs on ANY foreign key` (43/43 green at this tree). Evidence added; verdict unmoved. |
| **TV-0e / TV-2c** (TRV2-12's mapping) | §14.5 began this correction and it is completed here. The two `NB`s read as "no badge exists", and the *component the plan specifies* genuinely does not. But a badge **does** render, and it reads the wrong column: `travel-buddy-standalone/src/components/layover/LayoverPeopleSection.tsx:164#{b.verified && <BadgeCheck size={13} color={color.deep} />}` is driven by the legacy `profiles.verified` boolean, not by `verification_level`. `travel-buddy-standalone/src/components/interaction/UserIdentityLink.tsx` — the component the plan names as the badge's home — contains the string `verified` **zero** times. So TRV2-12's first criterion is not unbuilt but **wrong**: today's indicator asserts a verification state the identity pipeline cannot produce. Neither `NB` moves. `OWNER — D-BADGE`, then the client lane. |
| **§14.5's citation claim** | §14.5 states *"`check:doc-citations` reports **zero** census-trust failures"*. At this tree it reported **two**, both for one citation: `census-trust.md:738#TV-5b` named a five-line range in `services/media/MediaProjectionService.ts` ending at 112, for a `.select` call whose whole anchor is on line **109**. **Repointed** to line 109 by reading the file, not by adding an offset. A citation defect, not a verdict defect — the read it names is real, at the line it now names. After the repoint, census-trust's contribution is 0 findings again; the repo-wide exit stays 1 for four documents this lane does not own. |

### 16.4 Restated headline — denominator **108**

> **Trust, at this tree: 108 requirements · 82 BUILT-AND-CORRECT · 17 BUILT-BUT-WRONG ·
> 7 NOT-BUILT · 2 CANNOT-VERIFY → CONSTRUCTED 99 / 108 = 91.7 % · CORRECT 82 / 108 = 75.9 %.**
>
> Against §14.8's 93-row figure of 72 / 14 / 6 / 1 → CONSTRUCTED 92.5 %, CORRECT 77.4 %:
> **CONSTRUCTED −0.8 points, CORRECT −1.5 points.** Ten of the fifteen new rows are `C`, and both
> percentages still fall — because the gap was found by widening the population, not by finding new
> defects. That is the correct direction for a denominator correction and the whole reason the
> figure is restated rather than left at 77.4 %.
>
> The retired 52-row headline of CORRECT 96.2 % is not comparable to any number on this page.

| BUILT-AND-CORRECT | **82** |
|---|---|
| BUILT-BUT-WRONG | **17** |
| NOT-BUILT | **7** |
| CANNOT-VERIFY | **2** |

*This supersedes §14.8 under LAST-STATEMENT-WINS. §14.8 is the state before the specs' prose was
enumerated and is left in place because this file is append-only. §15's "no headline moves" also
stands as written: §15 moved no row, and this section's movement is a denominator correction, not a
re-grade of anything §15 touched.*

**The two CANNOT-VERIFY rows, with the evidence and the supplier, so neither is a parking space:**

| Row | Evidence that would settle it | Who |
|---|---|---|
| TRV2-10 | A written **D-REVERSAL** ruling: for each of admin revocation, upheld appeal and account deletion — does the derived trust effect reverse, decay or persist; if it reverses, by a counter-event or by deleting the original; and how long does derived evidence about an erased subject survive? | OWNER |
| TV-U2 | A **D-SCORING** ruling. "All twelve, ratify as v1" is complete. | OWNER |

**What D-SCORING does and does not block, stated plainly.** Exactly **one** of the 66 enumerated
clauses is blocked on it, and it is the no-regression clause — not because the scoring gap is small
but because *neither authoritative document states a scoring requirement at all* (`03-TRUST-v2.md`
says so in its first paragraph and again at L40). What D-SCORING makes unverifiable is the **policy
correctness of six rows whose structural correctness this census certifies**: C2, C8, C9, C12, C13,
C27. Those six are `C` for doing what the code says they do. None is graded against an approved
policy, because there is not one. They are **not** re-graded here and **not** promoted.

**D-OVERRIDE.** One v2 prose clause (V2-P8 in compliance-v1.md, mapped onto C22 and therefore not counted again here) and C22
itself are graded **against the CAP ruling**, as §15 ruled: ceiling semantics ratified, the lost-
upsert defect fixed and pinned, PIN deliberately not built. Neither is graded against PIN, and none
of §15.5's four LATER-WORK items is counted as a gap — they are the owner's deferral.

### 16.5 Checks, with exit codes

| Check | Exit | Reading |
|---|---|---|
| `check:census-integrity` (`src/scripts/checkCensusIntegrity.ts`) | **0** | Before this section: trust parsed at 93 rows, `C=72 W=14 N=6 X=1`, `0 counted where this tool cannot read`. **After, re-run: 108 rows, `C=82 W=17 N=7 X=2`, denominator 108, `0 counted where this tool cannot read`** — the tallier and §16.4 agree row for row, which is the check §12's own §2.B note exists to force. The first run after this section was written read only 97 rows, because the ids were spelled `V2-P2`/`VF-G1` and `parseIdCell` recognises neither shape; they were renamed into this census's `TV-` grammar rather than the tool being changed, which is not this lane's file. |
| `scripts/check-doc-citations.mjs` | 1 repo-wide, before and after | census-trust contributed **2** findings before this pass (one citation, at `docs/architecture/census-trust.md:738#TV-5b`), **0** after the repoint; repo-wide totals moved 2/125/263 → 2/**124**/**253**. Every citation this section adds is anchored, and the repo-wide UNANCHORED count is **6405 against a ceiling of 6434** with this section and `compliance-v1.md` both in the tree — the ceiling was not raised to fit them. The repo-wide red belongs to `docs/discovery/ROADMAP.md`, `census-compass`, `census-passport` and `census-highlights-memories`, none of which this lane touched. |
| `scripts/check-citation-symbols.mjs` | 0 | 138 symbol-naming citations judged, 0 naming a symbol the cited file lacks, 44 misplaced against a ceiling of 60 — **zero of the 44 are census-trust's**. |

Suites re-executed at this tree, all green: `trust` 45/45 · `trust-integration` 70/70 ·
`trustCensusRepairs` 18/18 · `trustProfileUnreadableDowngrade` 5/5 ·
`verificationWebhookSignature` 28/28 · `verificationProviderNormalization` 25/25 ·
`verificationRetention` 7/7 · `verificationProviderErasure` 6/6 ·
`verificationLevelVocabulary` 3/3 · `verificationTrustIdempotency` 3/3 ·
`adminUnverifyRevokesIdLevel` 5/5 · `intelScopedTrustApply` 19/19 · `sensingAnonStore` 43/43 ·
`rentBuddyKycGate` 12/12 · `ageGate` 6/6.

**No test was written this pass.** That is a scope statement: this lane owns two documents. Every
green claim above rests on a suite that already existed and was re-run here rather than quoted, and
the one clause that needs a test which does not exist (TRV2-01's fixture) is graded on that basis
and handed on rather than decorated into a pass.

### 16.6 Cross-lane requests

1. **A sensor/aggregate zero-trust fixture.** TRV2-01 names it as the required evidence and it does
   not exist. A registered suite asserting that the anonymous sensing contribution and
   coverage-aggregate paths emit no `trust_events` row closes the one criterion behaviour alone
   cannot. New file under `artifacts/api-server/src/test/`; not this lane's to write.
2. **TV-6c (VF-6c), attempts-per-verified-user monitoring.** Blocked on nothing. A count of
   `identity_verifications` rows per user against the verified subset, surfaced where an operator
   reads it, closes the row. Cheapest open clause in either spec.
3. **TV-U1 (V2-P2), the compatibility-score merge.** `services/rentBuddy/CompatibilityScoreService.ts` and
   `routes/rentABuddyMarketplace.ts` are the Rent-a-Buddy lane's files. Whether weighting person
   Trust at 8 inside one emitted 0–100 number is the merge `docs/specs/upgrades-v2/03-TRUST-v2.md:9#Never merge them into one score` forbids, or the
   ranking input A16 already ratifies, is a **reading the owner has** and this lane did not take.

### 16.7 What would turn THIS section's claims red

* Any of the fifteen suites in §16.5 failing at this tree — they were run, not remembered.
* A sixteenth or seventeenth prose obligation being found in either document: the enumeration rule
  and all 14 exclusions are written out in `compliance-v1.md` §1 precisely so a reader can check
  the arithmetic rather than trust it.
* `check:census-integrity` reading anything but 108 rows / `C=82 W=17 N=7 X=2` for trust.
* `sensingAnonStore.ts` or `sensingCoverageAggregate.ts` gaining a `trust` reference — TRV2-01's and
  TRV2-02's substance falls and, which is §16.6's first request, **nothing would fail**.
* `IMPLEMENTED_PROVIDERS` gaining a non-mock entry without a sandbox transcript: `TV-U9` and `TV-U11`
  both fall in the same commit.
* Either spec file changing. The enumeration is against `7d1f2d498`; both sha256s are recorded in
  `docs/specs/upgrades-v2/SOURCE-MANIFEST.json`, which is where a drift would show.

---

## 17. B4 — two rows built, one privacy decision sharpened, 2026-09-14

*Same 108-row denominator and the same counting rule as §16. Two rows move. No migration was
written or applied, no flag flipped, no scoring parameter touched, and no production write was
made. One read-only production query was run and is quoted in §17.3.*

**§16's `TV-7a` reading is superseded and was RE-VERIFIED here, not quoted.** The backlog item
that commissioned this pass (`reconciled-baseline-v1.md` §8, B4) describes `TV-7a` as an open
GDPR erasure hole with `requestProviderDeletion` "called from nowhere". That was true of §12.4
and was closed by **§13.1**, which is the last statement on the row. Re-measured at this tree
rather than accepted: `services/identityVerification/providerErasure.ts:58#export async function requestProviderDeletionForUser(`
is called at `services/accountDeletion/AccountDeletionService.ts:1002#const provErasureOk = await step(steps, "request_provider_verification_deletion", async () => {`,
which runs **before** `services/accountDeletion/AccountDeletionService.ts:1016#const verOk = await step(steps, "delete_identity_verifications", async () => {`,
and `test/verificationProviderErasure.test.ts` is **6/6 green at this tree**. The row stays `C`.
See §17.4 for what that does and does not entitle anyone to say.

### 17.1 Verdict changes

| id | Was | Now | Evidence at this tree |
|---|---|---|---|
| TV-1a | W | **C** | The fourth criterion is met and the other three were re-executed, not quoted. The session insert now writes the status the plan names: `routes/verification.ts:257#status:`. `created` is not an arbitrary pick between two legal values — it is the column default AND the first state of the lifecycle the schema documents in a comment directly above the CHECK (`db/migrations/0161_identity_verification.sql:28#status text not null default 'created'`, `db/migrations/0161_identity_verification.sql:29#check (status in ('created','pending','processing','verified','failed','expired','canceled'))`). Writing `pending` meant no row in the table was ever in the state the schema calls the beginning, so anything later asking how many sessions were opened but never started would measure zero of them forever — including §17.1's own TV-6c metric. **Behaviour is unchanged and this row does not pretend otherwise:** all three of `created`/`pending`/`processing` are live to `uq_identity_verifications_active`, to this route's own 23505 recovery read, to `retention.ts` (which purges neither), and to the client poll. What moves the row is that the stated criterion is now met. **RED 3 tests / 2 pass / 1 fail → GREEN 3/3** (`test/verificationSessionCreatedStatus.test.ts`); reverting the one literal returns it to **2/1**. The suite asserts the value the route actually SENT, read out of the recorded insert rather than out of the source, plus a control requiring that value to be one the route's own active-session recovery looks for — so a status outside the live set fails even though it is not `pending` — plus a no-regression control on the 201 and its `redirectUrl`. |
| TV-6c | NB | **C** | Built. V-6 states two obligations in one sentence and only the control existed; this is the measurement. `services/identityVerification/attemptMetrics.ts:145#export async function computeAttemptsPerVerifiedUser(` computes attempts per verified user, with the plan's figure exported rather than re-typed (`services/identityVerification/attemptMetrics.ts:57#export const ATTEMPT_FRICTION_THRESHOLD = 2.0;`), and it has a **reachable caller** — `routes/admin.ts:3577#router.get("/admin/verification/attempt-metrics", async (req, res) => {`, behind `requireAdmin`. A module with no caller would be the exact defect TV-7a was, so the route is part of the row rather than a follow-up. **The definition is stated because it is a choice:** numerator and denominator are both scoped to users who reached `verified`. The plan calls >2.0 "UX friction worth fixing", and friction is what a user pushes through on the way to a result — including users who never verified would let abandonment (one session, then gone) pull the figure toward 1.0 and make a painful flow read as healthy, which is the wrong direction for a threshold meant to raise an alarm. **Both non-answers are distinguishable from "healthy", which is the whole of the fail-closed work here:** an unreadable table throws (`services/identityVerification/attemptMetrics.ts:124#REFUSING to report an attempts-per-verified-user figure`) and the route answers 503, because supabase-js resolves on a read error and an unbound one would render as `0 attempts, no friction` for as long as the fault lasted; and zero verified users is its own state with `average: null` and `exceedsThreshold: null` (`services/identityVerification/attemptMetrics.ts:167#state: "no_verified_users",`), **not** `0.0`/`false` — which matters on the first reading rather than in theory, because production holds 0 verification rows today (§17.3). **RED 9 tests / 6 pass / 3 fail → GREEN 9/9** (`test/verificationAttemptMetrics.test.ts`). Five mutations: M1 un-mount the route **6/3**; M2 drop the read-error throw **7/2**; M3 report `0.0`/`false` for an empty denominator **8/1**; M4 widen the denominator to all users **7/2**; M5 `>=` for `>` at the threshold **8/1**. |

### 17.2 Headline

> **Trust, at this tree: 108 requirements · 84 BUILT-AND-CORRECT · 16 BUILT-BUT-WRONG ·
> 6 NOT-BUILT · 2 CANNOT-VERIFY → CONSTRUCTED 100 / 108 = 92.6 % · CORRECT 84 / 108 = 77.8 %.**
>
> Against §16.4's 108 · 82 / 17 / 7 / 2 → CONSTRUCTED 91.7 % · CORRECT 75.9 %:
> **CONSTRUCTED +0.9 points, CORRECT +1.9 points.** Two rows, both built and both pinned by a
> failing-first suite. B4's target of "~90 %" referred to CONSTRUCTED, which was already 91.7 %
> before this pass began; the honest reading of B4 is that **22 of the 24 non-`C` rows did not
> move, and §17.5 names the blocker and the owner for every one of them.**

| BUILT-AND-CORRECT | **84** |
|---|---|
| BUILT-BUT-WRONG | **16** |
| NOT-BUILT | **6** |
| CANNOT-VERIFY | **2** |

*This supersedes §16.4 under LAST-STATEMENT-WINS, and supersedes nothing else: the denominator,
the mapping decisions and every other verdict in §16 stand exactly as written. Only `TV-1a`
(W → C) and `TV-6c` (NB → C) moved, both in §17.1.*

### 17.3 D-DOB — which column should be the single source of truth, and why the decision is not next

**Recommendation: `identity_verifications.is_over_18`. It cannot be implemented next, and the
reason is a second decision the record did not previously connect to it.**

The two columns are not redundant spellings of one fact, which is how §12.4 and §14.6 both read
them. They carry **different claims**:

| | `profiles.date_of_birth` | `identity_verifications.is_over_18` |
|---|---|---|
| Who asserts it | the user, about themselves | the ID-check provider, from a government document |
| How it is written | `PATCH /profile` (`routes/profile.ts:512#dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD").nullable().optional(),`), validated only for format, past-ness, and a claimed age ≥ 18 (`routes/profile.ts:603#if (ageYears < 18) {`) | `routes/verification.ts:150#is_over_18:     result.isOver18   ?? null,`, on **every** provider result state, not only success |
| Who reads it as a gate | every age gate in the product, e.g. `lib/travelerVerification.ts:66#const dateOfBirth = (row["date_of_birth"] as string` | **nothing** |
| Privacy weight | a full date of birth: directly identifying, and a credential-recovery answer | one derived bit |

Four reasons the verified bit is the right source of truth, in descending order of force:

1. **The self-asserted one gates nothing.** A user types any date that clears "in the past" and
   "≥ 18" and is through. Every 18+ gate in the product — including the Rent-a-Buddy booking
   gate, which pairs strangers in person — is therefore an attestation checkbox wearing a gate's
   clothes. This is the reason, and it does not depend on the invariant at all.
2. **It is what the requirement says.** TV-5b names `is_over_18` "from the latest verified row"
   verbatim.
3. **It is what privacy invariant 2 says**, and `0161_identity_verification.sql:8#We NEVER store date of birth. Age gating stores a derived boolean only.`
   writes it into the schema's own header.
4. **It is the smaller datum.** Honouring the invariant deletes a directly-identifying field and
   replaces it with one bit.

**And it cannot be built next.** A read-only query against production (`ajrurzioarfkagpuxfnb`,
2026-09-14) returns:

| `identity_verifications` rows | verified rows | rows with `is_over_18` set | profiles | profiles with a DOB | profiles at an ID `verification_level` |
|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 58 | 7 | 0 |

Nothing can produce an `is_over_18` today: `services/identityVerification/readiness.ts:53#const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);`
admits only the mock, which the factory refuses in production. So migrating the gates onto the
verified signal now would refuse every 18+ feature to all 58 users, permanently, until a vendor
exists. **D-DOB is therefore sequenced behind D-PROVIDER, and §14.6's TV-P2 and TV-5b rows are
wrong to present D-DOB as independently actionable.** The order is: D-PROVIDER → a provider in
`IMPLEMENTED_PROVIDERS` → users can hold a verified `is_over_18` → migrate the gates → drop the
column. Nothing before the first step changes anything a user can do. Neither row moves.

**A defect on the same columns that no row states, and that does NOT depend on D-DOB.** A
provider result of `is_over_18: false` — `failure_reason: "underage"`, which both real adapters
normalize (`services/identityVerification/stripeIdentity.ts:173#if (result.failureReason === "underage") result.isOver18 = false;`,
`services/identityVerification/persona.ts:134#if (result.failureReason === "underage") result.isOver18 = false;`) — has **no consequence
anywhere in the product**. A repository-wide search at this tree returns, for `is_over_18` outside
tests, only that write and the status route's SELECT list; the client surfaces it as a display
field (`travel-buddy-standalone/src/services/verification.ts:72#isOver18:          raw.is_over_18 ?? null,`)
and no gate consumes it. So a user whose government document proves they are a minor keeps the
adult date of birth they typed and passes every age gate, including the booking gate. That is
true under **either** direction of D-DOB — under (a) `is_over_18` is the gate; under (b) a
verified contradiction of a self-assertion should still win — so closing it decides nothing and
is not blocked on D-DOB. It is **not** built here because the gates live in
`routes/{meetups,requests,events,profile}.ts`, `routes/mediaFeed.ts` and
`services/media/MediaProjectionService.ts`, none of which this lane owns, and because "what
happens to a verified minor" (refuse the gate / suspend / age-restrict the account) is a product
answer, not a wiring one. Cross-lane request in §17.6.

### 17.4 What this section does NOT establish

* **Nothing here is deployed.** Both changes are unmerged commits on a detached HEAD in a
  worktree. `TV-1a` and `TV-6c` are `C` against this tree, not against production.
* **TV-7a's `C` is a statement about the branch.** The erasure ordering holds and is tested
  here; production runs whatever is deployed, and this lane measured deployment nowhere. The
  provider call is also still a no-op in every environment, because the mock is the only
  implemented provider — which is correct (the mock has no copy to redact) and is **not** the
  same as a redaction having been performed at a vendor.
* **The two new suites are not in the curated `test` run.** `check-test-registration` reports
  both as unregistered; `package.json` is outside this lane's ownership. Until the two paths are
  added (§17.6) these suites pass only when run by name, which is how every count in §17.1 was
  produced.
* **No row was closed on a production read.** The §17.3 query informs a recommendation; it grades
  nothing.

### 17.5 The 22 rows that did not move, and whose call each one is

Grouped by blocker. Every one was checked against this lane's ownership before being left.

| blocker | rows | who, and what exactly is needed |
|---|---|---|
| **D-PROVIDER** (O4) | TV-6a, TV-6b | OWNER. A vendor choice, an account, API keys, a webhook secret. Not startable: an adapter that cannot be sandbox-tested is the mock-counted-as-complete this census forbids. **Also now blocks D-DOB** (§17.3), which was not previously recorded. |
| **D-DOB**, behind D-PROVIDER | TV-P2, TV-5b | OWNER, then the gate lanes. §17.3 gives the recommendation and the reasons; the decision is a privacy commitment and is not a lane's to amend. |
| **D-SUSPENSION-UX** (O5) | TV-4b | OWNER. Read-only suspended state vs ratifying the blanket 403; and whether a banned user is signed out. |
| **D-REVERSAL** (O5) | TRV2-10 | OWNER. Correctness is defined by "the **defined** policy" and none is defined; grading it `C` would promote current behaviour to specification. |
| **D-SCORING** (O2) | TV-U2 | OWNER. "Current *approved* behavior" names an approval that does not exist. |
| **D-BADGE** | TV-0e, TV-2c | OWNER (wording, colours), then the client lane. |
| **D-MODACTION-SHAPE** + a migration | TV-0a, and 2 of TV-4a's 5 criteria | OWNER, then the integration owner numbers a migration. `moderation_actions` has no `report_id` and no `expires_at`, so "suspend with expiry" and the report→action link are not expressible. **This lane does not write migrations.** |
| **D-MODACTION-FK** + a migration | TV-P3 | Same. CASCADE→SET NULL convergence. |
| **D-RESTRICTION-REACH** | TRV2-08 | OWNER. A product scope question: which Compass/Discovery/social/booking actions refuse a restricted user. |
| **DEPLOY** | A6, TV-1c, TV-U8 | Owner-run release. TV-1c waits on migration `2870` reaching a database; A6 is defined as a production measurement; TV-U8's database half cannot be exercised until 2870 applies. |
| **CLIENT LANE** (`travel-buddy-standalone/**`) | TV-2a, TV-2b, TV-2d, TV-5a, TV-7c | Not owned here. TV-2b's "what we never store" section is the one with server-side content already enumerable, from `services/identityVerification/types.ts` and the two adapter headers. |
| **RENT-A-BUDDY LANE** | TV-U1 | `services/rentBuddy/CompatibilityScoreService.ts`. Not owned here, and the reading is contestable (§16.2). |
| **TRUST-ADMIN ROUTE LANE** — *newly unblocked* | C22 | **Its decision is already made.** §15.1 ruled D-OVERRIDE (CAP now, PIN later behind a flag) and §15.3 fixed the defect it exposed; what keeps C22 `W` is only that no route calls `adminOverrideScore`. Settled by `POST /admin/trust/users/:userId/score-override` on `routes/trust-admin.ts` behind `requireAdmin`, plus a route test asserting the ceiling. **`routes/trust-admin.ts` is not in this lane's ownership**, so it is a cross-lane request rather than owner-blocked — a correction to its §14.6 classification, which names D-OVERRIDE as the blocker. |
| **ADMIN ROUTE LANE — partially this lane, deliberately not taken** | TV-4a (3 of 5 criteria) | `routes/admin.ts` **is** owned here, and the category filter, the richer subject snapshots and a route that writes `moderation_reports.status` are all buildable without a migration. Not built: the row cannot reach `C` while two of its five criteria wait on D-MODACTION-SHAPE, so the work would be real product value with no verdict move, and this pass was scoped to rows that could honestly close. Flagged rather than silently skipped — the live defect is that **nothing updates `moderation_reports.status`, so the moderation queue can only grow** (re-confirmed by grep at this tree). Recommended as its own item. |
| **TV-P0** — partially buildable, cannot reach `C` | TV-P0 | Invariant 1's encoding holds; invariant 3 is contradicted by the schema (CASCADE) and needs a migration; invariants 4 and 5 are runtime throws, not type or schema constraints. A shape guard for `identity_verifications` could be added under `src/test/` by this lane, but it would close none of the failing criteria, so it is named rather than done. |

### 17.6 Cross-lane requests

1. **`package.json` — register two test files.** Append to the `test` script:
   `src/test/verificationSessionCreatedStatus.test.ts src/test/verificationAttemptMetrics.test.ts`.
   `check-test-registration` names both today. Without this the two suites in §17.1 never run in
   the curated pass. `package.json` is outside this lane's ownership and was not edited.
2. **`routes/trust-admin.ts` — wire C22.** See §17.5. The decision is made; the route is one
   session's work and this lane does not own the file.
3. **Gate lanes — a verified `is_over_18: false` must have a consequence.** See §17.3. Needs a
   product answer for what that consequence is, then the gate files.
4. **`moderation_reports` has no acting route.** See §17.5, TV-4a.

### 17.7 Citation repairs made by this pass, called out rather than buried

Three citations at census lines 719, 1252 and 1275 anchored `routes/verification.ts` line 239 to
the full literal that line used to hold — the `status:` key followed by the old `pending` value.
This pass changed that value, so the anchor text stopped existing. The needle was **narrowed to
`status:`** (the citation now reads `routes/verification.ts:257#status:`), which is genuinely at
line 239, rather than repointed at the new value — repointing would have made three superseded
rows assert something they never said. **The prose of all three rows is unchanged and still describes the pre-fix state, which is
what an append-only census is for.** No verdict cell was touched.

Both source edits were deliberately made **line-count-neutral over every cited region**, because
the first attempt was not: a new import line and a mid-file route insertion in `routes/admin.ts`
shifted 44 anchors in this census and 9 more in `11_API_Specification.md`, `census-sensing.md`,
`trust-unproduced-vocabulary.md` and `compliance-v1.md` — three of which this lane may not edit.
The import was folded onto an existing line and the route appended after the last cited line
(`routes/admin.ts:3577#router.get("/admin/verification/attempt-metrics", async (req, res) => {`), which is why it sits at the end of the file rather than beside the
other moderation routes.

### 17.8 Checks, with exit codes

| check | result |
|---|---|
| `check:census-integrity` | **PASS**. Recomputes per-census counts from the tables. |
| `check:census-row-move-labels` | **PASS**, 0 labels naming another row's object. |
| `scripts/check-doc-citations.mjs` | **2 / 124 / 127 before this pass and 2 / 124 / 127 after** — unresolved / broken-anchor / broken-backticked. **Zero new findings**, and census-trust's own contribution is 55 both before and after. UNANCHORED is 6405 against a ceiling of 6434; the ceiling was not raised. |
| `tsc --noEmit` | No diagnostic in any file this pass touched. |
| Regression suites, re-run at this tree | `verification.test.ts`, `trust-integration.test.ts`, `adminUnverifyRevokesIdLevel.test.ts`, `verificationProviderErasure.test.ts`, `verificationStatusUnreadableProfile.test.ts`, `verificationWritesIssued.test.ts`, `verificationRetention.test.ts`, `ageGate.test.ts` plus both new suites: **131 / 131 green**. |

### 17.9 What would turn THIS section's claims red

* `routes/verification.ts:257#status:` reading anything but `created` — `test/verificationSessionCreatedStatus.test.ts` goes 2/1.
* `computeAttemptsPerVerifiedUser` resolving instead of throwing on a read error, or returning
  `0`/`false` for an empty denominator — M2 and M3.
* The `/admin/verification/attempt-metrics` route disappearing or losing `requireAdmin` — three
  route cases go red.
* A second writer appearing for `profiles.date_of_birth` or a first reader for `is_over_18` as a
  gate — either would change §17.3's measurement and the recommendation that rests on it.
* `IMPLEMENTED_PROVIDERS` gaining a member without TV-6b being re-graded — §17.3's "nothing can
  produce an `is_over_18` today" would no longer hold, and D-DOB would become actionable.
* Either new suite being registered and then failing in the curated run.

---

## §18 — Independent verification of the identity-foundation build. ONE ROW MOVES, and two claims are REFUSED

`head_commit: 608c5aa09`. Written by the integration lead, who is the only author of verdicts
here, and **only after** an independent Verification role re-derived every claim against the code.
Implementation's own report was deliberately withheld from that role.

### 18.1 `C22` moves **W → C** — its own settlement condition, quoted and met

§15 wrote the condition into the row itself:

> *"**What would settle it:** a `POST /admin/trust/users/:userId/score-override` on
> `routes/trust-admin.ts` behind `requireAdmin`, plus a route test asserting the ceiling on the row."*

Both halves are now true, and neither is taken on the builder's word:

- The route is `artifacts/api-server/src/routes/trust-admin.ts:391#router.post(` — behind
  `requireAdmin`, mounted at `artifacts/api-server/src/routes/index.ts:232#trustAdminRouter`,
  **awaiting** `adminOverrideScore` and returning the read-back `persistedScore` and
  `ceilingBinding` rather than a bare `ok`.
- Verification re-ran all four of §15.4's named mutations. **All four go red**, including P4
  (inverting the ceiling comparison in `TrustScoreService`), which reddens 16 cases across six
  describe blocks — so the CAP semantics the owner ruled are pinned by behaviour, not by a
  comment.

**One honest discrepancy:** the built path is `/score/override`, the row wrote `/score-override`.
A slash where the row wrote a hyphen. The criterion is the capability and its test, both of which
hold; the spelling difference is recorded rather than smoothed over.

`C22` therefore satisfies §LANE-RULES 5 — a reachable caller now exists. **W → C.**

| id | was | now | evidence |
|---|---|---|---|
| C22 | W | **C** | **The row's own settlement condition, met and independently re-derived.** §15 wrote it in: *"a `POST /admin/trust/users/:userId/score-override` on `routes/trust-admin.ts` behind `requireAdmin`, plus a route test asserting the ceiling on the row."* The route is `artifacts/api-server/src/routes/trust-admin.ts:391#router.post(`, behind `requireAdmin`, mounted at `artifacts/api-server/src/routes/index.ts:232#trustAdminRouter`; it **awaits** `adminOverrideScore` and returns the read-back `persistedScore` and `ceilingBinding` instead of a bare `ok`, so a ceiling that did not persist cannot be reported as one that did. An independent Verification role — given the checklist and the code but **not** the builder's report — re-ran all four of §15.4's named mutations and **all four go red**; P4, inverting the ceiling comparison at `artifacts/api-server/src/services/trust/TrustScoreService.ts:186#Math.min`, reddens 16 cases across six describe blocks, so CAP semantics are pinned by behaviour rather than by a comment. The built path spells `/score/override` where the row wrote `/score-override`; the capability and its test are what the criterion names, and the spelling difference is recorded rather than smoothed over. **Turns red if** any of §14.4's four characterization assertions starts failing, if the route loses `requireAdmin`, if `adminOverrideScore` stops being awaited, or if `ceilingBinding` is reported unconditionally. |

> **Trust, at this tree: 108 requirements · 85 BUILT-AND-CORRECT · 15 BUILT-BUT-WRONG ·
> 6 NOT-BUILT · 2 CANNOT-VERIFY → CONSTRUCTED 100 / 108 = 92.6 % · CORRECT 85 / 108 = 78.7 %.**
>
> Against §17's 108 · 84 / 16 / 6 / 2 → CONSTRUCTED 92.6 % · CORRECT 77.8 %: **CORRECT +0.9
> points, CONSTRUCTED unchanged**, because the single move is `W → C` and both letters are
> inside CONSTRUCTED. One row, `C22`, on its own stated settlement condition, independently
> re-derived — §18.1.
>
> **This restatement is the document's last statement and the one to quote.** `check:census-integrity`
> caught its absence: §17's headline still read 84 / 16 after §18.1 had moved the row, and the
> tool refused the file with *"a headline that stopped describing the table underneath it"*.
> That is the guard doing exactly what it exists for, on the integration lead's own edit.

| BUILT-AND-CORRECT | **85** |
|---|---|
| BUILT-BUT-WRONG | **15** |
| NOT-BUILT | **6** |
| CANNOT-VERIFY | **2** |

*This supersedes §17.2 under LAST-STATEMENT-WINS and supersedes nothing else: the denominator,
every mapping decision and every other verdict in §17 stand exactly as written. Only `C22`
(W → C) moved, in §18.1.*

### 18.2 Two claims REFUSED, and `TV-5b` stays **NB** because of it

Verification declined to confirm that the verified-minor contradiction rule closes age gating, and
the integration lead re-checked both findings personally before accepting them.

**The rule reaches one route family, not the product.** Round 1 placed it in
`lib/travelerVerification.ts#loadTravelerIdentity` on the stated reasoning that the helper had six
consumers. **That premise is false.** `grep -rln loadTravelerIdentity --include=*.ts` returns four
non-test files and all four are Rent-a-Buddy. Seven further age gates read
`profiles.date_of_birth` directly and call the helper **zero** times — measured, per file:

| file | `date_of_birth` reads | `loadTravelerIdentity` calls |
|---|---:|---:|
| `routes/meetups.ts` | 4 | **0** |
| `routes/requests.ts` | 2 | **0** |
| `routes/events.ts` | 9 | **0** |
| `routes/mediaFeed.ts` | 2 | **0** |
| `routes/discovery.ts` | 4 | **0** |
| `routes/profile.ts` | 4 | **0** |
| `services/media/MediaProjectionService.ts` | — | **0** |

So a traveller whose government-ID check returned `is_over_18: false` still keeps the adult
birthday they typed and can RSVP to an 18+ meetup, accept an 18+ circle invite, join an
age-restricted event and its waitlist, be served adult media, and appear in age-restricted
discovery. **`TV-5b` stays `NB`.**

**A sibling booking route bypasses the gate that was fixed.**
`artifacts/api-server/src/routes/rentABuddySpec.ts:397#router.post(` inserts a
`rent_buddy_bookings` row and never calls `enforceBookingCreationGates`, so it never reaches the
new refusal; every age check it has sits inside its `if (launchCtrl)` branch. Verification proved
a booking is seated for a verified minor when no launch control matches. The file states the
invariant it breaks at `artifacts/api-server/src/routes/rentABuddy.ts:1728#no`.
**Exposure is latent, not live:** the bypass branch requires `rent_buddy_launch_controls` to be
empty and production holds 13 rows — and `identity_verifications` holds 0 rows with no configured
provider, so the rule has never fired against real data at all.

### 18.3 A test that did not notice its own mutation

`artifacts/api-server/src/test/trust-integration.test.ts:654#DEFECT` — *"DEFECT 4 — a failed
recalculation is NOT reported as a successful lift"* — **stayed green** when Verification restored
the fire-and-forget call, which is the mutation its own comment names. It passes because the
`trust_profiles` read-back throws on that fixture for an unrelated reason. The property is still
covered — three other cases caught the mutation — but **this case's stated red-condition is a
lie and must not be relied on as the pin.** Queued for repair.

This is the finding that most justifies the three-role split: a builder who writes both the fix
and its pin cannot discover that the pin passes for the wrong reason.

### 18.4 `IDF-53` was mis-classified as blocked by nothing

The Requirements checklist recorded `IDF-53` — the polluted audit vocabulary — as
`Blocked by: NOTHING`. It is blocked on a migration. Implementation declined to build it and was
right to: `trust_admin_actions_action_type_check` admits exactly nine values and `update_setting`
is not among them, **confirmed read-only on production**. Verification added the part that makes
the refusal clearly correct rather than merely cautious: that insert is fire-and-forget with a
swallowed `catch`, and supabase-js **resolves** on a database error rather than throwing — so the
`23514` would not even reach the `.catch`, and the rename would have silently produced *no audit
row at all*.

Nothing anywhere pins the nine-value vocabulary today, so any future edit to an `action_type`
string ships green and drops audit rows in production. A value-level assertion needs no migration
and is queued.

### 18.5 What §18 does NOT claim

Everything above is read against `608c5aa09` on `claude/sweet-fermat-fmx7up`. **BUILT ON BRANCH IS
NOT MERGED.** `main` is `014a25d56`; the 32 migrations `2778–2870` exist in no database;
`IMPLEMENTED_PROVIDERS` admits only `"mock"` and both real adapters throw. `C22`'s `C` is a
statement about this tree, not about a running system, and no user has ever been ID-verified in
production.

---

## §19 — The redaction handle, graded. ONE ROW MOVES; five sentences in this document are now stale

Written by the INTEGRATION OWNER against `fe776c998`, integrating the Sensing/Trust lane.
Old verdicts below are read from `CENSUS_INTEGRITY_DUMP=ALL`, never from the lane's prose —
§16.6's rule, and it mattered here: the lane's report and the dump agreed on both rows, which is
a fact I could only state after checking.

### §19.1 The verdict move

| **ID** | **was** | **now** | why |
|---|---|---|---|
| **TV-5b** | **N** | **W** | The row names two conjuncts: the 18+ gates *"reading `is_over_18` from the latest verified row"* **and** *"showing a 'verify to access' gate rather than hiding silently"*. The first is BUILT and I re-measured it rather than accepting it: `artifacts/api-server/src/lib/gateAge.ts:80#export type GateAge` is a three-state union — `ok` \| `verified_minor` \| `unreadable` — with no common `age` member, and NINE modules cross it (`routes/events.ts`, `meetups.ts`, `requests.ts`, `profile.ts`, `mediaFeed.ts`, `discovery.ts`, `services/media/MediaProjectionService.ts`, `compass/CompassTools.ts`, `compass/CompassSocialEngine.ts`). The second is ABSENT: `grep -rn "age_requirement\|age_verification_unavailable\|verified_minor" travel-buddy-standalone/src travel-buddy-standalone/app` returns **nothing** — not one client file names the refusal the server produces, so a refused verified minor sees whatever a generic error path shows. `travel-buddy-standalone/src/components/AgeGate.tsx:273#Age verification required` is the app's entry DOB wall, collecting a birthdate and calling `onVerified()`; it is not the gate this row asks for and links to no verification flow. Half built is not N and it is not C. |

**Not moved, and the refusal is the point.** The lane raised **TV-7a** as *"C over a half-delivered
column until `fe776c998`"*. Dump says `C`, and `C` it stays: TV-7a grades the ERASURE ORDERING, and
that ordering was correct the whole time. What was broken was the column feeding it — which is
TV-P3's object, and TV-P3 is `W` and remains `W`, because the client half of provider erasure is
still unbuilt. Regrading TV-7a would move a row on evidence belonging to a different row.

### §19.2 What was built, and what it is NOT

`fe776c998` persists `provider_verification_ref` for every session status rather than only
`verified`. `artifacts/api-server/src/services/identityVerification/providerErasure.ts` reads that
column **and nothing else**, so a failed, expired or canceled attempt — which uploaded exactly the
same government ID as a successful one — left a copy at Stripe or Persona that
`requestProviderDeletionForUser` reported as *"nothing to redact"*, permanently, for us and for the
user. Seven tests, written first: RED 7/2 pass/4 fail, GREEN 7/7, five mutations all killed.

The `?? null` was NOT restored under the new condition, and the reason is the distinction this
corpus keeps making: the persist path is webhook-driven, a later event may omit a field an earlier
one carried, and an unconditional `?? null` would let the second event **erase** the handle the
first supplied. ABSENT IS UNKNOWN, NOT "NO REF".

**And this closes nothing in production.** `IMPLEMENTED_PROVIDERS` still admits only `"mock"`;
both real adapters exist but are uncertified; no user has been ID-verified in production, so no
vendor holds a document this column could redact. What changed is that the code would now be
correct if one ever did. BUILT ON BRANCH IS NOT MERGED, and MERGED IS NOT DEPLOYED.

### §19.3 Five sentences in this document are now false, named rather than edited

This document is append-only and last-statement-wins, so the sentences stay where they are and this
section is the later statement. Each was re-measured here, not inherited from the lane.

1. **§14.6, TV-P2** — *"`is_over_18` is read by **no** gate"*. It is read by
   `artifacts/api-server/src/lib/travelerVerification.ts:188#export function verifiedAgeSignalFromRows(`, composed
   at `artifacts/api-server/src/lib/gateAge.ts:112#if (signal.verifiedMinor) return { state: "verified_minor" };`,
   and consumed as a refusal in `routes/rentABuddy.ts` and `routes/profile.ts`. TV-P2 is `W` and
   stays `W` — its client half is the same absent surface TV-5b names — but its stated
   red-condition has half fired.
2. **§14.6, TV-P2** — *"none owned here"* of `lib/travelerVerification.ts`. That file is in the
   Trust lane's owned set.
3. **§14.6, TRV2-08** — *"`getRestrictionState` still has exactly **five** non-Trust callers"*.
   I counted them: **seven** modules — `services/interactionPermissions.ts:354`,
   `services/passport/PassportProjectionService.ts:2159#getRestrictionState(sc, userId),`, `lib/calls/callGatewayAdapter.ts:265`,
   `domain/telegraph/policies/conversationCapabilityPolicy.ts:181`, `routes/tripCrewLocation.ts:484#getRestrictionState(sc, user.id)`,
   `routes/messaging.ts:700`, and `routes/trips.ts:288` and `:1335`. **TRV2-08 does not move**, and
   I checked the half that decides it rather than the half that is wrong: `grep -rn
   getRestrictionState src/compass src/routes/discovery*.ts` returns **nothing**, so *"`src/compass/`
   and `routes/discovery*.ts` contain no call"* still holds and the row is still `N`.
4. **§14.6, C22** — *"what keeps C22 `W` is only that no route calls `adminOverrideScore`"*. Dump
   says C22 is **`C`**; the route exists in `routes/trust-admin.ts` behind `requireAdmin`. The
   sentence is a superseded row's text, and §16.6 already governs it.
5. **§14.5 and §14.7 item 3** — both argue that `provider_verification_ref` *"is written **only on
   success**"*. `fe776c998` closed that. Both quote the old source line VERBATIM, and a number can
   be repointed where a quotation cannot: the quotations are kept exactly as written and only their
   parseable `file:NNN#` form was removed, so `check:doc-citations` no longer reads a record of a
   past tree as a live pointer. Same treatment as the census-trips reference that records where `SafeReturnService`'s symbol used to sit — a pointer whose whole content is a past line number, which repointing would destroy.

### §19.4 §14.7's cross-lane requests, discharged

| request | state |
|---|---|
| 1 — register the two verification suites | **done before this pass**; `check:test-registration` 1243 registered + 30 allowlisted |
| 2 — `status: "created"` on insert | **done**; `artifacts/api-server/src/routes/verification.ts:257#status:` |
| 3 — persist `provider_verification_ref` on every status | **done by `fe776c998`**, graded above |

`src/test/verificationProviderRefPersisted.test.ts` is now registered in `package.json`'s `test`
script by the integration owner; the lane correctly declined to register its own file and left the
gate red rather than papering it.

### §19.5 What would turn §19 red

TV-5b returns to `N` if `lib/gateAge.ts` stops being crossed by any route; it reaches `C` only when
a client surface renders the `verified_minor` refusal — today the grep for that vocabulary across
`travel-buddy-standalone/` returns zero, and that single number is the whole of the row's
remaining gap. §19.2's claim fails if any write to `provider_verification_ref` reappears that is
conditioned on `status === "verified"`, or if an unconditional `?? null` returns; both are pinned
by mutations M1 and M2. §19.3's item 3 fails the moment `src/compass/` or `routes/discovery*.ts`
gains a `getRestrictionState` call, at which point TRV2-08 must be re-derived rather than left N.

**Declaring an absence honestly is better than defaulting it, and it is still not the capability the
spec asked for.** TV-5b is a `W` for exactly that reason: the server now refuses a verified minor
precisely and says why, and no screen in the product says it back.

### §19.6 Headline, restated from the rows

§18's headline (`108 · 85 / 15 / 6 / 2`) described the table before §19.1. TV-5b's `N → W` moves one
requirement between two non-correct classes, so CONSTRUCTED rises and CORRECT does not move at all —
which is the honest shape of this pass: nothing became correct, one thing stopped being absent.

> **Trust, at this tree: 108 requirements · 85 BUILT-AND-CORRECT · 16 BUILT-BUT-WRONG ·
> 5 NOT-BUILT · 2 CANNOT-VERIFY → CONSTRUCTED 101 / 108 = 93.5 % · CORRECT 85 / 108 = 78.7 %.**
>
> Against §18's 108 · 85 / 15 / 6 / 2 → CONSTRUCTED 92.6 % · CORRECT 78.7 %:
> **CONSTRUCTED +0.9 points, CORRECT UNCHANGED.** A row that moves from NOT-BUILT to
> BUILT-BUT-WRONG has not been fixed; it has been found. The `+0.9` is the honest measure of
> a half-built gate and must not be read as progress toward correctness.

`head_commit` is NOT re-declared here. This section grades one row and names five stale sentences;
it is not a re-measurement of 108 requirements against HEAD, and declaring one would claim a pass
nobody made.

The headline table, restated from the rows under LAST-STATEMENT-WINS:

| BUILT-AND-CORRECT | **85** |
|---|---|
| BUILT-BUT-WRONG | **16** |
| NOT-BUILT | **5** |
| CANNOT-VERIFY | **2** |

*This supersedes §18's table and supersedes nothing else. The denominator is unchanged at 108, and
`BUILT-AND-CORRECT` is unchanged at 85 — the single move is TV-5b out of NOT-BUILT and into
BUILT-BUT-WRONG. §18's own note records the integration lead being caught by this same guard for
leaving a headline behind a row move; leaving it behind again would be worse for having been
warned.*

---

## §20 — An INDEPENDENT check of this census's ledger arguments at `a97bfdac0`. NO ROW MOVES; one sibling census's statement is corrected and one pre-existing measurement defect is brought out of the JSON

*Written 2026-09-16 by an independent reviewer with no lane in this tree, sent to
check the arguments in `artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json`
rather than to inherit them. Measured against `a97bfdac0`. **`head_commit` is NOT
re-declared here and the ledger is NOT edited.** §20.4 says what this licenses.*

### 20.1 The five counted files, and the claims checked rather than read

This census's ledger entries cover `routes/messaging.ts`, `routes/discovery.ts`,
`routes/tripCrewLocation.ts`, `routes/profile.ts` and `routes/discoverySearch.ts`,
and each argues per ROW that no Trust verdict can move. **The falsifiable claims
were re-derived at both commits.** Every one holds:

| the claim | how it was checked | result |
|---|---|---|
| `routes/messaging.ts` lines 498-514 — A12's `msgPerms` seam — are byte-identical | `diff` of that range at `1fe72289b` and `a97bfdac0` | **identical** |
| `artifacts/api-server/src/routes/messaging.ts:700#const senderRestrictions = await getRestrictionState(sc, user.id);` — §16's `getRestrictionState` caller — is byte-identical | same | **identical** |
| `routes/messaging.ts` is the same length, so ~49 citations keep their lines | `wc -l` at both commits | **4,081 = 4,081**. (The entry prints "4,082"; the PROPERTY it asserts is true, the number is off by one.) |
| `routes/discovery.ts` gains no `date_of_birth` read and no `loadTravelerIdentity` call | `grep -c` at both commits | **0 and 0 at both** |
| `routes/profile.ts`'s five cited lines are byte-identical | `sed`+compare at both commits for 117, 445, 504, 595, 600 | **all five identical** |
| `routes/profile.ts`'s `date_of_birth` count is unchanged | `grep -c` at both commits | **4 = 4** (file grew 2,176 → 2,330 lines) |

**No Trust verdict moves**, and this reviewer reached that independently rather
than by accepting it. `A12`, `TV-P2`, `TV-5b`, `TV-0e`/`TV-2c` and `TRV2-08` all
stand exactly where §16-§19 left them. The headline is unchanged.

### 20.2 The `routes/profile.ts` retranslation site, cited — and `census-telegraph.md` §27.5 corrected

`census-telegraph.md` §27.5 records, as a live open item, that the second caller
of the shared retranslation gate *"makes the same prior-language read"* as
`routes/messaging.ts` and *"is not closed"*. **Both halves are false at
`a97bfdac0`**, and the cited evidence belongs here because this census is the one
that counts the file.

- **It is not a prior-language read and never was.** The handler performs no
  change detection: the write has already run, so no prior value is in scope —
  `artifacts/api-server/src/routes/profile.ts:962#this branch has no change`
  says so in the file itself. What it reads is the PREFERENCE:
  `artifacts/api-server/src/routes/profile.ts:987#const { data: prefRow, error: prefErr } = await sc`.
- **The blast radius is the OPPOSITE of `messaging.ts`'s.** There, a swallowed
  read looked like a language CHANGE and billed a ~200-message sweep to a paid
  provider on every failing save. Here, a swallowed read looked like "preference
  unknown", which the gate correctly fails closed on — so it SUPPRESSED a sweep
  the user was entitled to, and a user with auto-translate ON silently kept
  old-language translations, permanently, because the sweep is fire-and-forget.
- **It is closed.** The error is bound and the loss reported at
  `artifacts/api-server/src/routes/profile.ts:995#auto_translate_messages unreadable`,
  and the gate call carries an explicit non-error term so the property survives a
  later permissive default. **The ANSWER deliberately does not move**: the write
  has committed, so a 503 would tell a client to retry a save that succeeded.

**This moves no verdict in either census.** It is an ACCOUNTING correction, and
it is recorded because §27.5 hands the next reader a to-do that is done and a
description that would send them hunting the wrong defect.

### 20.3 `§12`/`§14.6`'s "4 `date_of_birth` reads" in `routes/discovery.ts` is ZERO, and has been since before `1fe72289b`

The ledger entry for this census names this and it should not live only in a JSON
file, so it is restated in the document it is about. §12's per-file table scores
`routes/discovery.ts` at **four** `date_of_birth` reads. A literal `grep -c` of
that file returns **zero** — at `a97bfdac0` and at this census's own declared
`head_commit` `1fe72289b`. Discovery reaches the age signal through
`resolveGateAge`, not by naming the column.

**`TV-5b` does not move**, because the load-bearing column of that same table row
is `loadTravelerIdentity: 0`, which is confirmed **0** at both commits. This is an
ACCOUNTING correction to a measurement, owed to the next `census-trust` pass, and
it is **not** caused by anything that changed since `1fe72289b`.

### 20.4 What this licenses

Re-measured here: the six claims in §20.1, the `routes/profile.ts` retranslation
site, and §12's `date_of_birth` count. Not re-measured: the other 108 rows, and
in particular the `routes/tripCrewLocation.ts` membership change, whose Trust-side
argument (it is upstream of the restriction gate, not in it) was read but not
re-derived here.

**This census's `head_commit` CAN truthfully advance to `a97bfdac0`.** Five
counted files changed; four of the five had every Trust claim resting on them
re-derived at both commits, and the fifth — `routes/discoverySearch.ts` — is
covered by the five-hunk enumeration checked independently in
`census-discovery.md` §44. That is a statement about the files that moved, not a
certification of the 108 rows: the declaration starts a clock and certifies no
past.

**Guards at this tree:** `check:census-freshness` **0**,
`check:census-scope-coverage` **0**, `check:census-integrity` **0**,
`check:census-row-move-labels` **0**, `check:doc-citations` **0**,
`check:citation-targets` **0**. `check:write-path-columns`,
`check:missing-live-columns`, `check:authorization-contract`,
`check:media-objects` and `check:rank-events-surfaces` exit **2** without live
credentials — **UNVERIFIED, not green**; no claim above rests on them.

## §21 — The Rent-a-Buddy gate got a door. ONE ROW MOVES, and the refusal it made stops blaming the server

**2026-09-16, product lane.** `head_commit` is **NOT** re-declared here, for §19's reason
unchanged: this section grades one row. It is not a re-measurement of 108 requirements.

### §21.1 What TV-2a asked for, and what the tree answered

TV-2a wants two entry points into identity verification: the Passport profile, and the
Rent-a-Buddy gate. §13's client-lane table settled the second in one sentence — *"Settled by a
screen under `app/(rent-a-buddy)/` linking to `/profile/verification`, so a user the server-side
gate refuses is given a way to satisfy it."*

The gate itself was never in doubt.
`artifacts/api-server/src/routes/rentABuddyRollout.ts:372#verification_required` refuses an
MVP-mode booking from a traveller whose ID is not verified, with an HTTP 403 and that code.

**What the row did not record is that the refusal was worse than a dead end — it was a
misattribution.** `verification_required` appeared in NEITHER map in
`travel-buddy-standalone/src/services/rentABuddyBookingErrors.ts`: not in the feature-closed
set, not in the copy table. So `bookingErrorCopy` fell all the way through to
`GENERIC_BOOKING_ERROR`, and a traveller who had just filled in the entire checkout form — date,
duration, group size, meetup zone, safety preferences, policy acceptance — was shown an alert
reading:

> "Something went wrong on our side and we couldn't complete that. Please try again."

Every clause of which is false. Nothing went wrong. It was not on our side. And trying again
does the same thing forever, because the gate is a fact about the account rather than a transient
failure. The one sentence the person needed — *your ID is not verified, and there is a screen for
that* — was the sentence the mapping could not produce. Meanwhile
`travel-buddy-standalone/app/profile/verification.tsx` had existed the whole time, registered at
`travel-buddy-standalone/src/navigation/portavaRoutes.ts:352#path: 'profile/verification',`,
which is the route TV-2a's Passport half already reaches.

The two `become/apply.tsx` refusals were the same shape in a politer register: one told the
applicant to *"complete your verification first"* and the other to *"contact support to begin the
verification process"*. Support was never the way in. The screen was.

### §21.2 What is built

A THIRD class of refusal, beside the two `rentABuddyBookingErrors.ts` already had:

| class | meaning | treatment |
|---|---|---|
| feature-closed | `isBookingUnavailable` — nothing to do but wait | persistent banner, Book button disabled, "Not available yet" |
| **actionable** | the person can clear this themselves | **persistent banner carrying the route, Book button LEFT ENABLED** |
| genuine failure | something really broke | `Alert`, and "try again" is honest advice |

- The registry: `travel-buddy-standalone/src/services/rentABuddyBookingErrors.ts:91#route: '/profile/verification'`,
  read through `travel-buddy-standalone/src/services/rentABuddyBookingErrors.ts:102#export function bookingRefusalAction(`.
- The three-way decision, which used to be two `if`s inside a screen and is now one function:
  `travel-buddy-standalone/src/services/rentABuddyBookingErrors.ts:165#export function classifyBookingRefusal(`.
  Its ORDER is the behaviour — actionable must beat both of the others — and while it lived in a
  screen nothing could see that.
- The checkout door: `travel-buddy-standalone/app/(rent-a-buddy)/checkout.tsx:336#router.push(actionableRefusal.action.route`,
  a "Verify my ID" button inside the banner, which does **not** disable Booking, because a person
  who verifies and comes back must be able to press Confirm without rebuilding the form.
- The two application doors:
  `travel-buddy-standalone/app/(rent-a-buddy)/become/apply.tsx:32#VERIFY_ACTION.route`,
  which turns both alerts into "Not now" / "Verify my ID" and takes the path from the same registry
  rather than from a literal, so there is one place a wrong route can be.

Executed: `travel-buddy-standalone/src/services/__tests__/rentABuddy.verificationRoute.test.ts:114#V5`
is the case that checks the route against `PORTAVA_ROUTES` rather than against a string in the test —
a path no screen answers is the same dead end, spelled more confidently.

Nine cases, written before the code in two rounds, and each round watched red first: V1, V2, V3 and
V5 against the missing registry, then V6-V9 against the missing classifier. **V4 was green
throughout** and is the one that matters most — it asserts `verification_required` stays OUT of the
feature-closed class, so it was already true and is there to stop the cheap fix. Four mutations, no
survivors: deleting the registry entry kills V2/V5/V6; pointing it at an unregistered route kills
the same three; folding the code into `BOOKING_UNAVAILABLE_CODES` kills V4 **and** the pre-existing
`rentABuddy.bookingUnavailable.test.ts` case that says the set contains exactly five; dropping the
copy lookup kills V1 alone.

### §21.3 Row move

| id | was | now | why |
|---|---|---|---|
| TV-2a | W | **C** | **Entry points: Passport profile, Rent-a-Buddy gate.** The Passport half was already C in the row's own evidence. The Rent-a-Buddy half is now three doors under `app/(rent-a-buddy)/` — the checkout banner and both `become/apply.tsx` refusals — all pointing at `/profile/verification` through one registry, which is exactly what §13's client-lane table said would settle it. |

### §21.4 Headline, restated from the rows

One requirement moves from BUILT-BUT-WRONG to BUILT-AND-CORRECT. CONSTRUCTED does not move at all —
the row was already built — and CORRECT rises by one.

> **Trust, at this tree: 108 requirements · 86 BUILT-AND-CORRECT · 15 BUILT-BUT-WRONG ·
> 5 NOT-BUILT · 2 CANNOT-VERIFY → CONSTRUCTED 101 / 108 = 93.5 % · CORRECT 86 / 108 = 79.6 %.**
>
> Against §19.6's 108 · 85 / 16 / 5 / 2 → CONSTRUCTED 93.5 % · CORRECT 78.7 %:
> **CONSTRUCTED UNCHANGED, CORRECT +0.9 points.**

| BUILT-AND-CORRECT | **86** |
|---|---|
| BUILT-BUT-WRONG | **15** |
| NOT-BUILT | **5** |
| CANNOT-VERIFY | **2** |

*This supersedes §19.6's table and supersedes nothing else. The denominator is unchanged at 108.*

### §21.5 What this does NOT claim

- **TV-2b, TV-2d, TV-5a and TV-7c are untouched.** §13 files them in the same client lane and this
  pass grades none of them.
- **TV-5b is still `W`, and for the reason §19.5 gave.** The `verified_minor` refusal still has no
  client surface; a grep for that vocabulary across `travel-buddy-standalone/` still returns zero.
  Giving one gate a door does not give another one.
- **Nothing here is rendered-tested.** The classification, the copy, the route and the registry
  check are all executed under `node:test`. The BANNER itself — that pressing "Verify my ID"
  navigates — is verified by the typechecker and by reading, not by a rendering test: driving
  `checkout.tsx` to a submitted booking needs the date picker, the zone picker and the policy
  checkbox, and this lane did not build that harness. The decision the screen makes is pinned; the
  pixels it draws are not.
- **The server still answers 403 `verification_required` with no route in the payload.** The route
  lives on the client, in the registry. A second client would have to know it independently.


---

## §22 — 2026-09-22 · The restriction sweep is bounded, and its outcome is told apart at the caller. **NO ROW MOVES.**

**Read this first: no verdict in this document moves, and `head_commit` is NOT re-declared.** The
owner approved the work (decision Q2: *"port the {expired, truncated, failed} result and bounded
processing onto current main while preserving its scheduler wiring"*). The decision authorizes the
CODE. It does not authorize moving a verdict, and acceptance evidence for a row move does not exist
yet. C17 stays `C`, TRV2-09 stays `C`, and every other row is untouched by this section.

### §22.1 What was still owed after C17 went `C`

C17 was settled on two claims and both were true: `expireOldRestrictions` binds its own `error`, and
the maintenance pass calls it. Two things the row never graded were still wrong:

| | The defect | What it cost |
|---|---|---|
| 1 | The signature was `Promise<number>`, and every error path returned `0`. | A FAILED sweep and an IDLE one were the same observation at the call site. A permissions failure, a schema drift or a timeout read exactly like "nothing was due". |
| 2 | The update was UNBOUNDED — one statement against a table that only grows. | A latent outage. `trust_restrictions` has held 0 rows for the life of production, so this has never fired; that is a fact about the table's size, not about the statement. |

### §22.2 What changed

- `artifacts/api-server/src/services/trust/TrustRestrictionService.ts:378#export async function expireOldRestrictions(`
  returns `{ expired, truncated, failed }`. It reads a BOUNDED due set
  (`artifacts/api-server/src/services/trust/TrustRestrictionService.ts:328#export const RESTRICTION_EXPIRY_BATCH = 500;`)
  ordered by `expires_at` ascending, then lifts exactly those ids. `error` is bound on BOTH halves.
- The write still re-asserts `lifted_at IS NULL`
  (`artifacts/api-server/src/services/trust/TrustRestrictionService.ts:420#// moving the recorded moment a sanction ended. Do not remove this.`),
  which is what stops a concurrent pass overwriting an earlier `lifted_at` with a later instant.
  **That check was not weakened.** TRV2-09's claim is stronger than before, not weaker.
- `artifacts/api-server/src/lib/trustMaintenanceScheduler.ts:674#const sweep = await expireOldRestrictions(db);`
  — main's call site, unmoved. It now carries `restrictionSweepFailed` and
  `restrictionSweepTruncated` out on `TrustMaintenanceResult`, and a failed sweep joins
  `lastFailures` so `consecutiveFailures` stops resetting through it.
- `artifacts/api-server/src/lib/stateMachines/registry.ts` — the `active → expired` writer evidence
  is repointed to the same predicate on the same derivation column after the instant was hoisted
  into `nowIso`. `checkStateMachineWriters` passes: 0 MISSING_WRITER, unchanged.

### §22.3 The evidence, and what it does NOT establish

`artifacts/api-server/src/test/trustCensusRepairs.test.ts` §4 and §4b, 18 → 25 assertions, all green.
Five hand-reverts were run and each produced red, which is the only reason to believe the assertions
bite: collapsing `failed` back to `false` → 2 red; removing the batch bound → 3 red; replacing the
`expires_at` ordering → 1 red; dropping the `lifted_at IS NULL` re-assert on the write → 1 red;
having the caller stop surfacing the outcome → 3 red. Restored: 25/25.

**Starvation is proven, at the caller and at the service.** One pass over `RESTRICTION_EXPIRY_BATCH + 1`
due rows reports `truncated`; passes repeat until it does not, and every eligible row ends lifted with
none dropped. Separately, at a batch of 3 over 7 due rows, a NEWLY-lapsed restriction inserted
mid-drain does not overtake the older ones, and the backlog still drains completely.

**What this does NOT claim.** No live database was touched: the suite runs against the file's fake
client, which resolves `{ data, error }` the way postgrest-js does. The `>= limit` truncation test is
therefore a statement about the client contract, not about PostgREST's behaviour at 500 rows under
load. No row is re-graded here and no headline number moves. C17's two citations were repointed to
the lines `check:doc-citations` itself named — by searching for the anchor, not by adding an offset —
and the verdict column of that row is byte-identical.
