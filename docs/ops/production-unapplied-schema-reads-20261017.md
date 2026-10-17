# Production reads of unapplied schema: which live failures the 2026-10-17 press clears

*Written 2026-10-17 (wave 5 follow-up), for the owner pressing `prod-apply-packet-20261017`. Read-only work: no
database was contacted to write this. Branch `claude/wave4-build-20261017`.*

**What this is.** `artifacts/api-server/src/test/schemaColumnProductionScan.test.ts` grades every table, column,
filter column, write key and `.rpc()` name under `artifacts/api-server/src/` against production (the 2026-09-22
capture, plus names a read-only catalog check observed later). A **class-B UNGATED** site names something only an
unapplied migration declares, runs in production, and fails with an effect a user or operator sees. Its ledger is
`artifacts/api-server/src/test/fixtures/unappliedSchemaReads.json` (verdict `UNGATED`, with the full trace).

**The packet.** `main` = `packet-full/real-run/` (296 migrations, step number shown); `addendum` =
`addendum-3996-3999/real-run/` (runs after the main packet); `held` = `packet-full/held/` (3601, 3602: owner hold
D-OWNER1004-14); `excluded` = 2481. Every "main"/"addendum" row below was checked against the packet's own copy of
the file: that file declares the missing name.

**Result.** 64 ungated sites remain. **61 are cleared by the press** (58 by the main packet, 3 more only once the
addendum runs). **3 are not**: two read 3601's column (held) and now answer a stated 503 instead of a 500; one
names a column no pending migration declares (listed, needs a product decision).

**Correction to the scan's first report.** Six sites the scan first reported (2026-10-17, commit 9894cfa75) are
**not** defects: `stories.deleted_at`, `story_purge_queue` and `job_health.last_success_at` are in production.
`2998_story_retention` was applied by hand after the 2026-09-22 capture: production's ledger has a `manual` row
whose checksum is the file's sha256, and the lead's catalog check found all three names. So the owner's own-media
reads (`lib/mediaAccess.ts`), the story archive routes (`routes/storyArchive.ts`) and the hourly story retention
job (`services/stories/storyRetention.ts`) work in production. The scan now records this as a dated observation
(`artifacts/api-server/src/test/fixtures/productionCatalogObservations.json`).

| # | site (line as of 9894cfa75) | route / job | what users or operators see today | declaring migration → packet | fixed by press? |
|---|---|---|---|---|---|
| U01 | compass/CompassSearchDecayService.ts:87 | POST /api/compass/signals/search (detached task) | No search nudge is logged, so every +1 category weight from a search is permanent (no decay). A warn on every search | 3561_compass_search_signal_log → main 192 | **yes** |
| U02 | compass/CompassSearchDecayService.ts:212 | every Compass profile build (cache miss) | The decay log read fails, so feeds rank on undecayed weights. A warn on every build | 3561 → main 192 | **yes** |
| U03 | compass/PassportRemembersService.ts:248 | GET /api/media/me (My World); GET /api/compass/me/passport/remembers | My World silently drops every derived memory. Passport marks the group unavailable, which is honest | 2213_memory_passport_controls → main 015 | **yes** |
| U04 | lib/deviceRevocation.ts:177,228 | DELETE /api/me/crypto-devices/:id | **Security.** Answers 200 `complete:false`. Revoking another device leaves its refresh token valid and its push tokens live | 3743_telegraph_device_registry_revocation_links → main 238 | **yes** |
| U05 | lib/deviceRevocation.ts:330,359 | device heartbeat; POST /api/me/devices | The device→session and push-token→device links are never recorded (debug log only) | 3743 → main 238 | **yes** |
| U06 | lib/discoveryServeLog.ts:707 | every Discovery serve | Per-request and anonymous serve rows are lost (one warn per process) | 3376_discovery_recommendations_per_request → main 129 | **yes** |
| U07 | lib/inputAssistance/inputConsent.ts:99 | PUT /api/input-assistance/memory-context-consent `{enabled:false}` | Withdrawing consent always fails with 503 | 3782_input_memory_context_consent → main 251 | **yes** |
| U08 | lib/inputAssistance/inputConsent.ts:99 | PUT /api/input-assistance/outcome-consent `{enabled:false}` | Withdrawing consent always fails with 503 | 3780_input_outcome_learning → main 249 | **yes** |
| U09 | lib/intelProjectionAggregator.ts:239 | intelProjectionScheduler (flag TRUE) | Every claim with fresh evidence is withheld, so crowd live labels never publish | 2255_media_evidence_seam → main 022 | **yes** |
| U10 | lib/layoverAuditRetentionScheduler.ts:63 | hourly layover audit retention | The probe errors and the scheduler reports FAILING. GET /api/healthz/schedulers answers 503 | 3621_layover_erasure_audit_pseudonym → main 195 | **yes** |
| U11 | lib/media/dubbing/store.ts:93 *(branch)* | GET /media/:assetId/dubbing | 503 storage_unavailable | 3986_media_synthetic_dubbing → main 287 | **yes** |
| U12 | lib/media/dubbing/store.ts:146 *(branch)* | DELETE /media/:assetId/dubbing | 503 storage_unavailable | 3986 → main 287 | **yes** |
| U14 | lib/rentBuddyFeeSchedule.ts:309 | GET /api/rent-a-buddy/me/earnings/summary | Was 500 for every active buddy. **Now 503, with the reason stated (this change)** | 3601_rent_buddy_commission_basis_points → **held** H1 | **no** (held) |
| U15 | lib/sensingConsentGrants.ts:107 | GET /api/v1/sensing/consent | 503 on every call | 3703_sensing_consent_grants → main 227 | **yes** |
| U16 | lib/sensingConsentGrants.ts:188 | PUT /api/v1/sensing/consent/:scope `{granted:false}` | Withdrawal always fails with 503 | 3703 → main 227 | **yes** |
| U17 | routes/compass.ts:2979 | POST /api/compass/me/passport/remembers/correct | 500 that exposes the PostgREST message. The correction is lost | 2213 → main 015 | **yes** |
| U18 | routes/discovery.ts:3322 | POST /api/discovery/community | Every hidden-gem submission fails: 500 `insert_failed` | 2121_source_registry → main 001 | **yes** |
| U19 | routes/intelObservability.ts:100 | GET /api/v1/internal/intel/observability (admin) | 500, and the whole dashboard is lost | 2277_intel_outcomes_attribution → main 024 | **yes** |
| U20 | routes/intelReadModels.ts:240 | GET /api/v1/experiences/:id/typical-patterns | 500 | 2279_intel_historical_patterns → main 026 | **yes** |
| U21 | routes/mediaImageUnderstanding.ts:62 *(branch)* | DELETE /media/image-understanding/:postMediaId/consent | 503 | 3981_media_image_understanding_artifacts → main 284 | **yes** |
| U22 | routes/mediaVisualIndex.ts:71 *(branch)* | DELETE /media/visual-index/:assetId/consent | 503 | 3982_media_visual_index → main 285 (installs pgvector; the one file not executed offline) | **yes** |
| U23 | routes/messaging.ts:3896 | GET /api/threads/:t/messages/:m/edits | 503. Edits still save, without history | 2811_telegraph_message_side_tables → main 065 | **yes** |
| U24 | routes/profile.ts:260 | GET /api/me/profile/analytics | `postImpressions7d` is always 0 | only `docs/migrations/0070` (not a migration in the chain) → **not pending** | **no** (listed) |
| U25 | routes/rentABuddyMarketplace.ts:2821 | PATCH /api/rent-a-buddy/admin/fee-rules (admin) | Was 500. **Now 503, naming 3601. Nothing is written (this change)** | 3601 → **held** H1 | **no** (held) |
| U26 | routes/reviews.ts:958,987 *(branch)* | admin reported-review removal (context + remove) | 503 | 3994_reported_review_audited_removal → main 295 | **yes** |
| U27 | routes/routePlan.ts:423 | POST /api/route-plans/:id/accept | 404 "Route plan not found" for every plan | 2224_route_hop_signal → main 020 | **yes** |
| U28 | routes/routePlan.ts:515 | POST /api/route-plans/:id/complete | 404 for every plan | 2224 → main 020 | **yes** |
| U33 | routes/verification.ts:251 | POST /api/verification/session (keyed provider only) | 500 after a provider session was created (orphaned) | 3930_identity_verifications_provider_mode → main 270 | **yes** |
| U34 | routes/wishlist.ts:49 | POST /api/wishlist (OSM place); Telegraph discovery_save_place | The save succeeds, but no `discovery_places` row or `saved_count` bump is ever written | 2121 → main 001 | **yes** |
| U35 | server/trips/planItemAudience.ts:122 | PATCH /api/trips/:tripId/plan/items/:itemId (narrow case) | 503. The write may be half-applied | 3727_trip_plan_item_audience → main 234 | **yes** |
| U36 | services/accountDeletion/AccountDeletionService.ts:946 | POST /api/admin/deletion-requests/:id/execute | Posts with third-party interest are left untouched (not tombstoned) | 2141_post_tombstones → main 009 | **yes** |
| U37 | services/accountDeletion/AccountDeletionService.ts:1138 | same | `event_passport_shares` rows remain | 2294_event_passport_shares → main 033 | **yes** |
| U38 | services/accountDeletion/AccountDeletionService.ts:1541 | same | 500 after the profile is anonymised and the auth user deleted. The request stays pending forever | 2140_deletion_receipt → main 010 | **yes** |
| U39 | services/accountDeletion/sensingErasureRecompute.ts:165,187 | same (recompute step) | No affected intel snapshot is retracted | 3311_intel_snapshot_input_provenance → main 101 | **yes** |
| U40 | services/airport/LayoverPlaceDwell.ts:161 | PUT /api/admin/airport/place-dwell/:placeId | 503 | 3466_layover_place_dwell → main 159 | **yes** |
| U41 | services/airport/LayoverPlaceDwell.ts:180 | DELETE /api/admin/airport/place-dwell/:placeId | 503 | 3466 → main 159 | **yes** |
| U42 | services/identityVerification/currentVerification.ts:131 | GET /api/verification/status | 500 for **every** signed-in user | 3930 → main 270 | **yes** |
| U43 | services/intel/CoverageService.ts:157,183 | POST /api/v1/internal/intel/missions/:id/complete\|decline | 500 | 2280_intel_mission_lifecycle → main 027 | **yes** |
| U44 | services/intel/SafetyReviewService.ts:238 | POST /api/admin/intel/safety-review | 200 `reviewId:null`. The status change is unattributed | 2311_intel_claim_reviews → main 042 | **yes** |
| U45 | services/layover/LayoverCrewLocationStore.ts:160 *(branch)* | DELETE /api/airport/sessions/:id/crew/location | Un-sharing a location fails with 503 | 3996_layover_crew_location_grants → **addendum** 297 | **yes, with the addendum** |
| U46 | services/media/AuthoredCaptionsService.ts:63 *(branch)* | GET /media/captions/source?…&manageDubbing=1; GET /media/:assetId/dubbing/options | 503 | 3983_media_caption_manifest → main 286 | **yes** |
| U47 | services/media/AuthoredCaptionsService.ts:215 *(branch)* | DELETE /media/captions/:assetId | 503 | 3983 → main 286 | **yes** |
| U48 | services/media/CaptionAsrService.ts:71 *(branch)* | GET /media/captions/:assetId/asr | 503 | 3983 → main 286 | **yes** |
| U49 | services/media/CaptionAsrService.ts:148 *(branch)* | DELETE /media/captions/:assetId/asr | 503 | 3983 → main 286 | **yes** |
| U50 | services/media/CaptionTranslationService.ts:26 *(branch)* | GET /media/caption-translations/:assetId | 503 | 3987_media_caption_translation → main 288 | **yes** |
| U51 | services/media/CaptionTranslationService.ts:180 *(branch)* | DELETE /media/caption-translations/:assetId | 503 | 3987 → main 288 | **yes** |
| U52 | services/media/MediaViewRequestService.ts:303 | PUT /v1/media/view-requests/opt-in | 500 | 2257_media_view_requests → main 023 | **yes** |
| U53 | services/memory/memoryDeletionDeadLetters.ts:64 *(branch)* | DELETE /api/memories/:id | 204, but every deletion is falsely dead-lettered, with an ERROR log | 3670_memory_deletion_dead_letters → main 213 | **yes** |
| U54 | services/memory/memoryDeletionLifecycle.ts:89 *(branch)* | same | same | 3670 → main 213 | **yes** |
| U55 | services/memory/memoryImportBatches.ts:59 *(branch)* | GET /api/memory-import-batches/:id; POST …/abort | 503 | 3992_memory_import_batches → main 293 | **yes** |
| U56 | services/memory/memoryNarrativeService.ts:198 | PUT/DELETE /api/me/memory-narrative-ai-consent (withdrawal) | Withdrawal always fails with 503 | 3802_memory_narrative_ai_consent → main 259 | **yes** |
| U57 | services/memory/memorySharedExperiences.ts:56 *(branch)* | decline invitation; leave; remove a shared experience | 503 on every way out | 3997_memory_visibility_policies_and_shared_experiences → **addendum** 298 | **yes, with the addendum** |
| U58 | services/memory/memorySharedExperiences.ts:113 *(branch)* | DELETE /api/memories/:id/shared-experience/invitations/:userId | 503 | 3997 → **addendum** 298 | **yes, with the addendum** |
| U59 | services/payments/bookingPayments/supabaseStore.ts:420 | POST /api/admin/rent-a-buddy/payouts/plan | 503 | 3931_rent_buddy_payments → main 271 | **yes** |
| U60 | services/payments/bookingPayments/supabaseStore.ts:431 | POST …/payouts/execute; …/:payoutId/hold\|release | execute answers 200 with every payout `unreadable`; hold/release answer 503 | 3931 → main 271 | **yes** |
| U62 | services/telegraph/sharedRideWrites.ts:151 | POST /api/threads/:threadId/coordination (ride proposal) | Replay dedupe is lost: a retry makes a second ride | 2810_telegraph_message_kernel → main 064 | **yes** |
| U63 | services/telegraph/unsend.ts:357 | POST /api/threads/:t/messages/:m/unsend | 500 on every attempt | 2325 → main 044; 3000 → main 094; 3650 → main 202 | **yes** |
| U64 | services/trails/TrailService.ts:199,205,246 | the whole Trails surface (GET /api/v1/discovery/trails and about 15 routes) | 503 "trails are not available in this deployment" | 3977_trail_review_before_visible → main 280; 3441_trail_letter_fold_decompose_first → main 149 | **yes** |
| U65 | services/trails/TrailService.ts:2477 | GET /api/v1/discovery/trail-suggestions/pending | 503 | 3488_trail_content_suggestions → main 175 | **yes** |
| U66 | services/trails/TrailService.ts:2500 | POST …/trail-suggestions/:id/accept\|decline | 503 | 3488 → main 175 | **yes** |
| U67 | services/trails/trailAdmin.ts:43,153 | admin Trail moderation routes and their audit | 503 "(3486 not applied)" | 3486_trail_moderation_audit → main 173 | **yes** |
| U68 | services/trails/trailReview.ts:53 | GET /api/v1/discovery/me/trails | 503 | 3977 → main 280 | **yes** |
| U69 | services/trails/trailReview.ts:65 | GET /api/admin/discovery/trail-reviews/pending | 503 | 3977 → main 280 | **yes** |
| U70 | services/trails/trailReview.ts:86 | POST /api/admin/discovery/trails/:id/review | 503 | 3977 → main 280 | **yes** |

*(branch)* = the file or line is on this branch and not on `origin/main` (324ed0dd2), so it fails only once it ships.
Its migration is in the packet anyway, because the packet was built from 637c8dd01.

**Not cleared by the press, and why.**
- **U14, U25 (3601 held).** These now answer `503 degraded_unavailable` with the reason stated, not a 500. No rate is
  invented (`lib/rentBuddyFeeSchedule.ts`, `isFeeScheduleSchemaAbsent`; proven in
  `rentBuddyFeeScheduleNotDeployed.test.ts`). They clear when 3601 (then 3602) is applied. Two other readers of the
  same column are behind `rent_buddy_enabled` = FALSE and would still answer 500 if that flag were turned on before
  3601 (`routes/rentABuddy.ts` dashboard earnings summary, `lib/rentBuddyEarningsLedger.ts`).
- **U24 (`post_impressions.viewed_at`).** Only `docs/migrations/0070` declares it, and that is not a migration in the
  chain. Production's `post_impressions` has `created_at`, and the table has no writer (checkWriterlessReads: dead
  lane). An honest answer is "unavailable", but the client renders the number with `toLocaleString()` and would
  crash on null, so this is a product decision: drop the card, or define impressions and give them a writer. Not
  changed.

**What the press switches on.** Some of these paths come alive the moment the schema exists, with no flag flip.
U09 starts publishing crowd live labels (`intel_claim_projection_crowd` is TRUE), U06 starts writing per-request
serve rows, U01/U02 start decaying search nudges, and U64–U70 bring the Trails surface back.
