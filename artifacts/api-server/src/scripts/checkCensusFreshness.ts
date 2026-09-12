/**
 * checkCensusFreshness — a stale census must not be quotable as current truth.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * This is a repeated failure in this repository, not a hypothetical. Two
 * censuses sat at numbers measured hundreds of commits earlier and were read
 * as present-tense fact:
 *
 *   census-layover.md              31.4% constructed / 3.4% correct
 *   census-highlights-memories.md  28.6% constructed / 6.4% correct
 *
 * Both were quoted while the architecture they measured had moved substantially.
 * When they were finally re-measured against HEAD, layover went to 50.0% / 8.4%
 * and highlights to 52.3% / 6.0% — one of them DOWN on correctness, because a
 * miscitation was corrected. The direction is not the point. The point is that
 * nothing in the repository could tell the difference between a census that had
 * been checked yesterday and one that had not been checked since June.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * A census declares `head_commit`. This check asks git whether any file that
 * census COUNTS has changed since that commit. If so the census is stale, and
 * the remedy is either a re-measure or a written acknowledgement saying why the
 * change cannot have moved a verdict.
 *
 * PATH-SCOPED ON PURPOSE. A README edit, a doc change, or work on an unrelated
 * surface must not age a census — a guard that cries stale on every commit gets
 * switched off, and then the real staleness comes back. Each census declares
 * the paths it is a measurement OF.
 *
 * ── THE ACKNOWLEDGEMENT LEDGER IS NOT A MUTE BUTTON ──────────────────────────
 *
 * It was one, for four commits, and the hole is worth stating because the header
 * had claimed otherwise the whole time. An acknowledgement was keyed on
 * (census, since) alone, so it silenced EVERY later change to that census's
 * counted files rather than the one whose harmlessness had been argued. An entry
 * written to cover a single comment-only change was, four commits later, quietly
 * covering four changed files, three of which nobody had looked at — while its
 * `reason` still read as though it described the whole silence. An entry now
 * covers exactly the paths it NAMES, an entry that names none covers none, and a
 * counted file that changed without being named makes the census stale again.
 * An entry names a commit range and says why the verdicts cannot have moved.
 * "Not relevant" is not a reason. The entry is validated: it must name a census
 * that exists, its `since` must be the census's CURRENT head_commit (so an
 * acknowledgement cannot outlive the measurement it was written against), and
 * it must carry a reason long enough to be a reason.
 *
 * ── WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED ───────────────────────
 * (1) Whether the census's VERDICTS are right. It checks age, not accuracy.
 *     check:census-integrity checks that a census agrees with itself; neither
 *     checks it against the code.
 * (2) A census with no `head_commit` cannot be checked at all — those are
 *     REPORTED by name rather than passed silently, because an unmeasurable
 *     census is the weakest state of the three, not the safest.
 * (3) Renames. `git diff --name-only` reports the new path; a file moved out of
 *     a counted directory stops ageing its census.
 *
 * Run: node --import tsx/esm src/scripts/checkCensusFreshness.ts
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { readHeadCommit, HEAD_COMMIT_ROW_SHAPE } from "./lib/censusHeadCommit.js";

const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const CENSUS_DIR = join(REPO, "docs/architecture");
const LEDGER = new URL("./CENSUS_STALENESS_ACKNOWLEDGED.json", import.meta.url).pathname;

/** A run that found no censuses is a run that found nothing. */
const MIN_CENSUS_FILES = 10;

/**
 * What each census is a measurement OF. A census not listed here is reported as
 * unscoped rather than silently treated as fresh — the scope is the thing that
 * makes the check meaningful, and a missing one is a gap, not a pass.
 */
const CENSUS_SCOPE: Record<string, string[]> = {
  // NEVER SCOPE THE ACKNOWLEDGEMENT LEDGER. Widening the scopes on 2026-09-11
  // pulled CENSUS_STALENESS_ACKNOWLEDGED.json into three of them, because three
  // censuses cite it. That is an infinite regress: writing an acknowledgement
  // edits the ledger, which ages every census that counts it, which requires
  // another acknowledgement. Caught on the first run after widening. The ledger
  // is machinery for this check, not an artifact any census grades.
  // Trips §29 declares a head_commit — the first Trips section to do so — and
  // this is what makes that declaration mean something. The scope is wide on
  // purpose: §29's central finding is that the WRITERS (the migrations) were
  // being counted while the READERS did not exist, so a scope listing only
  // src/migrations would age this census on exactly the half that was never
  // the problem. Both ends of every vertical slice are listed.
  "census-trips.md": [
    // The kernel and its command families.
    "artifacts/api-server/src/lib/tripKernel.ts",
    // §45: the decision-diff harness, its golden, and the Phase 0 inventory (generated and hand-written halves).
    "artifacts/api-server/src/scenarios/trips/corpus.ts",
    "artifacts/api-server/src/scenarios/trips/run.ts",
    "artifacts/api-server/src/scenarios/trips/diff.ts",
    "artifacts/api-server/src/scenarios/trips/golden.ts",
    "artifacts/api-server/src/scenarios/trips/golden.json",
    "artifacts/api-server/src/scripts/checkTripDecisionDiff.ts",
    "artifacts/api-server/src/scripts/tripWritePathInventory.ts",
    "docs/architecture/trips-phase0-inventory.md",
    "artifacts/api-server/src/migrations/2760_trip_stages.sql",
    "artifacts/api-server/src/migrations/2761_trip_legs_and_commitments.sql",
    "artifacts/api-server/src/migrations/2762_trip_goals_decisions_risks.sql",
    "artifacts/api-server/src/migrations/2763_trip_presence_proposals_snapshots_outcomes.sql",
    "artifacts/api-server/src/migrations/2764_trip_kernel_stage_family.sql",
    "artifacts/api-server/src/migrations/2765_trip_kernel_leg_and_commitment_families.sql",
    "artifacts/api-server/src/migrations/2766_trip_kernel_goal_decision_risk_families.sql",
    "artifacts/api-server/src/migrations/2767_trip_presence_spec_vocabulary.sql",
    "artifacts/api-server/src/migrations/2768_trip_kernel_presence_proposal_outcome_families.sql",
    "artifacts/api-server/src/migrations/2769_trip_kernel_participant_roles_and_terminal_lifecycle.sql",
    "artifacts/api-server/src/migrations/2770_trip_plans_spec_columns.sql",
    "artifacts/api-server/src/migrations/2771_trip_plan_participants.sql",
    "artifacts/api-server/src/migrations/2772_trip_kernel_plan_attendance_and_plan_version.sql",
    "artifacts/api-server/src/migrations/2773_trip_snapshot_fold_and_replay.sql",
    "artifacts/api-server/src/migrations/2774_trip_proposal_governance.sql",
    "artifacts/api-server/src/migrations/2775_trip_kernel_proposal_governance_and_apply.sql",
    "artifacts/api-server/src/migrations/2776_trip_presence_freshness_and_ordering.sql",
    "artifacts/api-server/src/migrations/2777_trip_kernel_presence_ordering.sql",
    // The READERS — the half §29.1 found missing.
    "artifacts/api-server/src/routes/trips.ts",
    "artifacts/api-server/src/routes/tripCommands.ts",
    "artifacts/api-server/src/routes/tripDecisions.ts",
    "artifacts/api-server/src/routes/tripFeasibility.ts",
    // §14.1's route was missing from this list until 2026-09-09, so a change to
    // the TripMapProjection surface aged nothing — the same shape of hole as a
    // census that declares no head_commit, one entry down.
    "artifacts/api-server/src/routes/tripMapProjection.ts",
    "artifacts/api-server/src/routes/tripPresence.ts",
    "artifacts/api-server/src/routes/tripStructure.ts",
    "artifacts/api-server/src/routes/tripReadiness.ts",
    "artifacts/api-server/src/services/trips/",
    "artifacts/api-server/src/lib/tripReadiness.ts",
    // The client half — a route with no screen is 29.2's other gap.
    "travel-buddy-standalone/src/services/tripCommands.ts",
    "travel-buddy-standalone/src/services/tripDecisions.ts",
    "travel-buddy-standalone/src/services/tripFeasibility.ts",
    "travel-buddy-standalone/src/services/tripPresence.ts",
    "travel-buddy-standalone/src/components/trip/",
    "travel-buddy-standalone/app/trip/",
    // ── ADDED 2026-09-11, and the reason is a defect this scope had ──────────
    // Everything above is the Trip KERNEL programme. Everything below is the
    // DEPLOYED coordination product — and that is where this census's
    // BUILT-AND-CORRECT rows live. The split mattered: measured on 2026-09-11,
    // the scope covered 10 of the 49 files the census cites, and the 39 it
    // missed were led by lib/tripCrewLocation.ts (34 citations),
    // routes/trips-expansion.ts (28) and compass/CompassTools.ts (26).
    //
    // So the census reported FRESH while the files its STRONGEST claims cite
    // drifted underneath it: canEditPlan by 10 lines, isAcceptedTripMember by
    // 22, the plan-mutation guard in routes/trips.ts by 219, the only reader of
    // trip_activity_log by 641. Every C verdict resting on those was unprotected
    // by exactly the guard that is supposed to protect it, and the W verdicts —
    // the ones that say something is NOT right — were the half being watched.
    // A freshness scope that covers the claims you are least worried about is
    // the wrong way round.
    "artifacts/api-server/src/lib/tripCrewLocation.ts",
    "artifacts/api-server/src/routes/tripCrewLocation.ts",
    "artifacts/api-server/src/routes/trips-expansion.ts",
    "artifacts/api-server/src/routes/tripReservations.ts",
    "artifacts/api-server/src/routes/tripBudgetIntel.ts",
    "artifacts/api-server/src/routes/tripDraft.ts",
    "artifacts/api-server/src/routes/locateFriends.ts",
    "artifacts/api-server/src/lib/tripStatus.ts",
    "artifacts/api-server/src/lib/tripMembership.ts",
    // lib/http.ts is a SHARED library and is scoped anyway: canEditPlan and
    // canEditPlanItem live in it and are the whole evidence for TR52, TR106 and
    // TR107. The cost — unrelated HTTP churn ages this census — is accepted,
    // because the alternative is three C verdicts nothing watches.
    "artifacts/api-server/src/lib/http.ts",
    "artifacts/api-server/src/lib/mapTripProjectionWorker.ts",
    "artifacts/api-server/src/compass/CompassTools.ts",
    "artifacts/api-server/src/services/safeReturn/",
    "artifacts/api-server/src/services/routeOptimizer.ts",
    // The schema ancestry the deployed product actually runs on. Named file by
    // file, never as src/migrations/, for the reason the Media scope gives.
    "artifacts/api-server/src/migrations/0010_trip_plan.sql",
    "artifacts/api-server/src/migrations/0058_trip_flow.sql",
    "artifacts/api-server/src/migrations/0079_trip_sub_tables.sql",
    "artifacts/api-server/src/migrations/0167_safety_ddl_reconcile.sql",
    "artifacts/api-server/src/migrations/0170_trip_readiness.sql",
    "artifacts/api-server/src/migrations/0172_trip_reservations.sql",
    "artifacts/api-server/src/migrations/0041_trip_crew_location.sql",
    "artifacts/api-server/src/migrations/2420_trip_kernel_foundation.sql",
    "artifacts/api-server/src/migrations/2590_trip_kernel_add_plan_attachment_columns.sql",
    "migrations/0001_spine.sql",
    "travel-buddy-standalone/src/components/TripPage.tsx",
    "travel-buddy-standalone/src/components/tripCrew/",
    // WIDENED 2026-09-11: cited 117 files, watched 38. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/test/tripPrivacy.test.ts",
    "src/components/TripPage.tsx",
    "artifacts/api-server/src/lib/placeIdBridge.ts",
    "artifacts/api-server/src/lib/tripCrewLiveShareScheduler.ts",
    "artifacts/api-server/src/lib/tripReminderScheduler.ts",
    "artifacts/api-server/src/test/passportStatsFromTripCompletion.test.ts",
    "artifacts/api-server/src/lib/ciSupabaseGuard.mjs",
    "artifacts/api-server/src/migrations/0077_trips_expansion.sql",
    "0183_budget_fx_conversion.sql",
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    "travel-buddy-standalone/src/hooks/useTripSavedPlaces.ts",
    "src/types/models.ts",
    "artifacts/api-server/src/migrations/0021_plan_edit_permission.sql",
    "artifacts/api-server/src/services/airport/LayoverNotificationService.ts",
    "artifacts/api-server/src/services/notifications/NotificationRouter.ts",
    "artifacts/api-server/src/test/tripsHostingDegraded.test.ts",
    "artifacts/api-server/src/routes/neighborhoods.ts",
    "artifacts/api-server/src/test/tripCompletion.test.ts",
    "travel-buddy-standalone/src/components/__tests__/TripsTab.staleActiveStatus.component.test.tsx",
    "artifacts/api-server/src/test/tripReadiness.test.ts",
    "artifacts/api-server/src/migrations/2158_post_media_write_boundary.sql",
    "artifacts/api-server/src/migrations/2147_hidden_gems_write_boundary.sql",
    "artifacts/api-server/src/test/memoryKernelTransactionLive.test.ts",
    "artifacts/api-server/src/migrations/0078_trip_members_expansion.sql",
    "artifacts/api-server/src/migrations/0065_phase7_safety.sql",
    "travel-buddy-standalone/src/components/TripAvailabilitySection.tsx",
    "travel-buddy-standalone/src/services/messaging.ts",
    "artifacts/api-server/src/migrations/2044_hidden_gems_canonical_place_id.sql",
    "artifacts/api-server/src/migrations/2750_trip_plan_item_interval_ordered.sql",
    "artifacts/api-server/src/lib/deletionDispositions.ts",
    "artifacts/api-server/src/test/tripMembers.test.ts",
    "artifacts/api-server/src/test/tripMembership.test.ts",
    "artifacts/api-server/src/test/tripNotFound.test.ts",
    "travel-buddy-standalone/src/services/geofence.ts",
    "artifacts/api-server/src/lib/delayedPostPublisher.ts",
    "travel-buddy-standalone/src/services/compass.ts",
    "artifacts/api-server/src/test/tripReminderPush.test.ts",
    "artifacts/api-server/src/routes/compass.ts",
    "artifacts/api-server/src/routes/pulse.ts",
    "artifacts/api-server/src/lib/intelContracts.ts",
    "artifacts/api-server/src/migrations/2172_intel_contribution_consent.sql",
    "travel-buddy-standalone/app/safety-history.tsx",
    "artifacts/api-server/src/test/tripsPassportProjection.test.ts",
    "artifacts/api-server/src/services/media/MyWorldMemoryService.ts",
    "artifacts/api-server/src/scripts/certifyMigrations.ts",
    "artifacts/api-server/src/scripts/auditMigrationsVsLive.ts",
    "artifacts/api-server/src/test/tripsExpansion.test.ts",
    "travel-buddy-standalone/src/services/tripPlan.ts",
    "travel-buddy-standalone/src/components/AddToPlanSheet.tsx",
    "artifacts/api-server/src/test/tripCrewLocation.test.ts",
    "artifacts/api-server/src/test/tripCrewMap.test.ts",
    "artifacts/api-server/src/test/tripRoutePlan.test.ts",
    "travel-buddy-standalone/src/components/__tests__/TripReservationsSection.importError.component.test.tsx",
    "artifacts/api-server/src/lib/mediaPipeline.ts",
    "travel-buddy-standalone/src/components/TripsTab.tsx",
    "artifacts/api-server/src/test/tripFeasibilityRouteBehaviour.test.ts",
    "travel-buddy-standalone/src/components/__tests__/TripReadinessCard.component.test.tsx",
    "artifacts/api-server/src/scripts/lib/transformedFunction.ts",
    "travel-buddy-standalone/src/services/apiToken.ts",
    "artifacts/api-server/src/scripts/lib/censusHeadCommit.ts",
    "artifacts/api-server/src/test/censusHeadCommit.test.ts",
    "artifacts/api-server/src/migrations/2334_route_plan_crew_visibility.sql",
    "artifacts/api-server/scripts/UNREGISTERED_TESTS_ALLOWLIST.json",
    "artifacts/api-server/src/test/tripKernelLive.test.ts",
    "artifacts/api-server/src/compass/CompassStructuredContext.ts",
    "artifacts/api-server/src/test/tripsCensusRederivation.test.ts",
    // WIDENED 2026-09-11 (§39): the N-row re-derivation cited five product
    // files this census had never watched. Each one CARRIES a verdict now —
    // tripDiscoveryProjection.ts is the whole of TR364-TR367, projectionRegistry
    // is TR362, and tripKernelWriterBaseline is the measurement TR1 rests on.
    // A file that decides a verdict and ages nothing is the inversion §37
    // found corpus-wide, arriving one section later in the same document.
    "artifacts/api-server/src/lib/tripDiscoveryProjection.ts",
    "artifacts/api-server/src/lib/discoveryTripProjectionConsumer.ts",
    "artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts",
    "artifacts/api-server/src/scripts/tripKernelWriterBaseline.ts",
    "artifacts/api-server/src/test/tripFeasibilityRoute.test.ts",
    // WIDENED 2026-09-12 (§40.1): the §6.1 policy module, the Appendix B
    // vocabulary, the presence predicate and the callsite ratchet. Each one
    // decides a verdict in §40.1 (TR101-TR111, TR115, TR441-TR451).
    "artifacts/api-server/src/lib/tripPolicy.ts",
    "artifacts/api-server/src/lib/tripPresencePolicy.ts",
    "artifacts/api-server/src/lib/tripReasonCodes.ts",
    "artifacts/api-server/src/scripts/checkTripPolicyCallsites.ts",
    "artifacts/api-server/src/test/tripPolicy.test.ts",
    "artifacts/api-server/src/test/tripReasonCodes.test.ts",
    "artifacts/api-server/src/routes/safeReturn.ts",
    // ── ADDED 2026-09-12 (§40.2): the §19.1 envelope, §19.2's read routes and
    // their consumers. services/trips/ is already scoped as a directory.
    "artifacts/api-server/src/routes/tripProjections.ts",
    "artifacts/api-server/src/lib/tripMetrics.ts",
    "artifacts/api-server/src/lib/discoveryTripProjectionConsumer.ts",
    "artifacts/api-server/src/test/tripProjectionEnvelope.test.ts",
    "artifacts/api-server/src/test/tripProjections.test.ts",
    "travel-buddy-standalone/src/services/tripProjectionEnvelope.ts",
    "travel-buddy-standalone/src/services/tripMapProjection.ts",
    "travel-buddy-standalone/src/services/__tests__/tripProjectionEnvelope.test.ts",
    // §40.3: the Temporal Freedom Engine's suites (the engine itself is under services/trips/).
    "artifacts/api-server/src/test/tripFreedomEngine.test.ts",
    "artifacts/api-server/src/test/tripFreedomWindows.test.ts",
    // §40.4-§40.5: phase, health, today (under services/trips/), their gate, its
    // flag seed, and their suites.
    "artifacts/api-server/src/lib/tripOperationalProjections.ts",
    "artifacts/api-server/src/migrations/2778_trip_operational_projections_flag.sql",
    "artifacts/api-server/src/test/tripOperationalPhase.test.ts",
    "artifacts/api-server/src/test/tripHealthProjection.test.ts",
    "artifacts/api-server/src/test/tripTodayProjection.test.ts",
    // §40.6-§40.7: presence freshness, the closeout, the decision ledger, the
    // crew-map service that forwards the presence columns, and their suites.
    "artifacts/api-server/src/lib/tripPresenceFreshness.ts",
    "artifacts/api-server/src/services/tripCrew/TripCrewLocationService.ts",
    "artifacts/api-server/src/test/tripPresenceFreshnessClass.test.ts",
    "artifacts/api-server/src/test/tripCloseout.test.ts",
  ],
  "census-layover.md": [
    "artifacts/api-server/src/services/airport/",
    "artifacts/api-server/src/routes/airport.ts",
    "travel-buddy-standalone/src/services/layover.ts",
    "travel-buddy-standalone/src/components/layover/",
    "travel-buddy-standalone/app/layover/",
    // WIDENED 2026-09-11: cited 77 files, watched 26. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/test/airport.test.ts",
    "artifacts/api-server/src/test/layoverSafeReturnAbort.test.ts",
    "artifacts/api-server/src/lib/deletionDispositions.ts",
    "artifacts/api-server/src/security/authorization-contract.json",
    "artifacts/api-server/src/test/layoverFeasibilityInvariants.test.ts",
    "travel-buddy-standalone/src/context/LayoverSessionContext.tsx",
    "artifacts/api-server/src/test/layoverCrewConstraints.test.ts",
    "artifacts/api-server/src/test/layoverDegradedOffline.test.ts",
    "artifacts/api-server/src/test/layoverPrivacyCompassContract.test.ts",
    "artifacts/api-server/src/lib/capability/production-applied-migrations.json",
    "artifacts/api-server/src/lib/capability/layover-cutover-measurement.json",
    "artifacts/api-server/src/migrations/2700_layover_certified_feasibility.sql",
    "artifacts/api-server/src/test/layoverFeasibilityRecord.test.ts",
    "artifacts/api-server/src/lib/capability/snapshots/20260908-production-schema.json",
    "artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts",
    "artifacts/api-server/src/lib/locationPurposes.ts",
    "travel-buddy-standalone/src/lib/safeNotifications.ts",
    "artifacts/api-server/src/lib/buddyMapRead.ts",
    "artifacts/api-server/src/test/layoverDeadlineMonotonicity.test.ts",
    "artifacts/api-server/src/migrations/2335_layover_recommendation_write_boundary.sql",
    "artifacts/api-server/src/test/layoverReturnState.test.ts",
    "artifacts/api-server/src/test/layoverTravelTimeProvenance.test.ts",
    "artifacts/api-server/src/migrations/2740_layover_presence_ladder_flag.sql",
    "artifacts/api-server/src/migrations/0127_layover_system.sql",
    "artifacts/api-server/src/compass/CompassTools.ts",
    "travel-buddy-standalone/src/components/discovery/DiscoveryMapView.tsx",
    "artifacts/api-server/src/migrations/2130_intel_storage.sql",
    "artifacts/api-server/src/lib/rentBuddyFeeSchedule.ts",
    "artifacts/api-server/src/lib/rentBuddyEarningsLedger.ts",
    "artifacts/api-server/src/routes/hiddenGems.ts",
    "travel-buddy-standalone/src/services/hiddenGems.ts",
    "artifacts/api-server/src/services/telegraphIntent.ts",
    "artifacts/api-server/src/scripts/parseBaselineSchema.ts",
    "artifacts/api-server/src/migrations/2410_layover_recommendation_identity.sql",
    "artifacts/api-server/src/routes/rentABuddy.ts",
    "artifacts/api-server/src/test/layoverRecommendationIdentity.test.ts",
    "artifacts/api-server/src/migrations/2510_layover_write_boundary_postconditions.sql",
    "artifacts/api-server/src/lib/featureFlags.ts",
    "artifacts/api-server/src/security/authorizationContract.ts",
    "artifacts/api-server/src/test/authorizationContractGuard.test.ts",
    "artifacts/api-server/src/test/mapTripProjectionWorker.test.ts",
    "artifacts/api-server/src/test/trustEmitterWiring.test.ts",
    "artifacts/api-server/src/test/migrationDeployability.test.ts",
    "artifacts/api-server/src/migrations/2462_meetup_time_votes_write_boundary.sql",
  ],
  "census-highlights-memories.md": [
    "artifacts/api-server/src/routes/memories.ts",
    "artifacts/api-server/src/routes/highlights.ts",
    "artifacts/api-server/src/routes/stories.ts",
    "artifacts/api-server/src/services/memory/",
    "artifacts/api-server/src/services/memoryProjections/",
    "artifacts/api-server/src/services/memoryRetrieval/",
    "artifacts/api-server/src/services/highlights/",
    "artifacts/api-server/src/lib/memoryCommandBus.ts",
    "artifacts/api-server/src/lib/memoryOutbox.ts",
    "artifacts/api-server/src/lib/highlightPermissions.ts",
    // WIDENED 2026-09-11: cited 65 files, watched 19. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "docs/migrations/0067_memories.sql",
    "artifacts/api-server/src/services/passport/PassportMemoryService.ts",
    "artifacts/api-server/src/lib/deletionDispositions.ts",
    "artifacts/api-server/src/lib/capability/production-applied-migrations.json",
    "artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts",
    "artifacts/api-server/src/compass/CompassTools.ts",
    "artifacts/api-server/src/migrations/2150_passport_memories_write_boundary.sql",
    "artifacts/api-server/src/lib/capability/snapshots/20260908-production-schema.json",
    "artifacts/api-server/src/lib/mediaAssets.ts",
    "artifacts/api-server/src/migrations/2213_memory_passport_controls.sql",
    "artifacts/api-server/src/migrations/2183_memory_projection_contract.sql",
    "artifacts/api-server/src/routes/geofence.ts",
    "artifacts/api-server/src/routes/location.ts",
    "artifacts/api-server/src/compass/MemoryRecapsService.ts",
    "artifacts/api-server/src/migrations/2214_memory_recaps.sql",
    "artifacts/api-server/src/lib/mediaLocationVisibility.ts",
    "artifacts/api-server/src/migrations/0148_memories_location.sql",
    "artifacts/api-server/src/lib/protectedLocations.ts",
    "artifacts/api-server/src/lib/mapProducers/memoryProducer.ts",
    "artifacts/api-server/src/migrations/2046_phash_dedup.sql",
    "artifacts/api-server/src/lib/memoryProjectionScheduler.ts",
    "artifacts/api-server/src/lib/tripReminderScheduler.ts",
    "artifacts/api-server/src/migrations/0026_highlights.sql",
    "artifacts/api-server/src/migrations/2186_memory_projector_taxonomy.sql",
    "artifacts/api-server/src/lib/publicIdentity.ts",
    "artifacts/api-server/src/migrations/2217_protected_locations.sql",
    "artifacts/api-server/src/routes/mapProjection.ts",
    "artifacts/api-server/src/lib/locateFriendsSession.ts",
    "artifacts/api-server/src/services/media/MediaProjectionService.ts",
    "artifacts/api-server/src/lib/portavaRank.ts",
    "artifacts/api-server/src/migrations/2221_compass_ai_writing_default_off.sql",
    "artifacts/api-server/src/routes/compass.ts",
    "travel-buddy-standalone/src/lib/memoryTimeline.ts",
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    "artifacts/api-server/src/compass/ProjectedMemoryPrompt.ts",
    "artifacts/api-server/src/routes/intel.ts",
    "artifacts/api-server/src/routes/mapObservations.ts",
    "artifacts/api-server/src/migrations/2158_post_media_write_boundary.sql",
    "artifacts/api-server/src/test/memories.test.ts",
    "artifacts/api-server/src/test/memoriesBlockFailClosed.test.ts",
    "artifacts/api-server/src/test/memoryPassportRemembers.test.ts",
    "artifacts/api-server/src/test/memoryLifecycle.test.ts",
    "artifacts/api-server/src/test/memoryProjectionSchedulerTiming.test.ts",
    "artifacts/api-server/src/migrations/2182_close_authz_rpc_oracle.sql",
  ],
  // Trust has NO SPEC — its 52 requirements are 20 inbound obligations from
  // other surfaces' specs plus 32 contracts its own code asserts. That makes the
  // scope wider than one directory: the rows about whether OTHER surfaces
  // consume Trust correctly (A13, A17) are aged by the files that consume it,
  // not by services/trust. Listing only the service would have made this census
  // look fresh while the reads it grades moved underneath it.
  "census-trust.md": [
    "artifacts/api-server/src/services/trust/",
    "artifacts/api-server/src/lib/trustScore.ts",
    "artifacts/api-server/src/lib/trustMaintenanceScheduler.ts",
    "artifacts/api-server/src/routes/trust-admin.ts",
    // The consumers A13 and A17 grade.
    "artifacts/api-server/src/routes/events.ts",
    "artifacts/api-server/src/routes/pulse.ts",
    "artifacts/api-server/src/routes/rentABuddyMarketplace.ts",
    "artifacts/api-server/src/routes/tripCrewLocation.ts",
    "artifacts/api-server/src/compass/CompassProfileService.ts",
    "artifacts/api-server/src/compass/CompassTools.ts",
    "artifacts/api-server/src/compass/CompassActiveUserRewardEngine.ts",
    "artifacts/api-server/src/services/ranking/CreatorActivityScoreService.ts",
    // The emitters C32 and A6 grade.
    "artifacts/api-server/src/services/hiddenGems/",
    "artifacts/api-server/src/services/passport/StampAwardEngine.ts",
    "artifacts/api-server/src/services/passport/PassportStampService.ts",
    // WIDENED 2026-09-11. This census cited 72 files and watched 22 — 31%, the
    // same inversion §37 found in Trips: the scope covered services/trust/ (what
    // was being BUILT) and left unwatched the suites and call sites its six
    // W->C rows actually rest on. `check:census-scope-coverage` measures it now.
    // NOT added, deliberately: package.json (a dependency bump must not age a
    // census) and src/scripts/checkWriterlessReads.ts (named as machinery, not
    // graded).
    "artifacts/api-server/src/test/trust.test.ts",
    "artifacts/api-server/src/test/trust-integration.test.ts",
    "artifacts/api-server/src/test/trustCensusRepairs.test.ts",
    "artifacts/api-server/src/test/trustRestrictionEnforcement.test.ts",
    "artifacts/api-server/src/test/trustStampVerified.test.ts",
    "artifacts/api-server/src/test/trustEmissionChain.test.ts",
    "artifacts/api-server/src/test/trustChainEndToEnd.test.ts",
    "artifacts/api-server/src/test/trustMutualRings.test.ts",
    "artifacts/api-server/src/test/trustAsymmetryAndMaintenance.test.ts",
    "artifacts/api-server/src/test/trustAttendanceVocabulary.test.ts",
    "artifacts/api-server/src/test/trustEmitterWiring.test.ts",
    "artifacts/api-server/src/test/trustEventCoverage.test.ts",
    "artifacts/api-server/src/test/trustAdminAuditInsertSchemaDrift.test.ts",
    "artifacts/api-server/src/test/passportTrustConsistency.test.ts",
    "artifacts/api-server/src/test/passportProjection.test.ts",
    "artifacts/api-server/src/test/passportConsumerAdoption.test.ts",
    "artifacts/api-server/src/test/intelScopedTrustApply.test.ts",
    "artifacts/api-server/src/test/tripCrewRlsMembershipConvergence.test.ts",
    "artifacts/api-server/src/test/helpers/fakePassportDb.ts",
    "artifacts/api-server/src/routes/admin.ts",
    "artifacts/api-server/src/routes/trips.ts",
    "artifacts/api-server/src/routes/tripCrewLocation.ts",
    "artifacts/api-server/src/routes/geofence.ts",
    "artifacts/api-server/src/routes/rentABuddy.ts",
    "artifacts/api-server/src/routes/messaging.ts",
    "artifacts/api-server/src/routes/verification.ts",
    "artifacts/api-server/src/routes/hiddenGems.ts",
    "artifacts/api-server/src/routes/reviews.ts",
    "artifacts/api-server/src/routes/compass.ts",
    "artifacts/api-server/src/routes/telegraph.ts",
    "artifacts/api-server/src/routes/safeReturn.ts",
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/routes/adminPortavaPosts.ts",
    "artifacts/api-server/src/services/interactionPermissions.ts",
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    "artifacts/api-server/src/services/passport/PassportProjectionService.ts",
    "artifacts/api-server/src/services/passport/EventPassportService.ts",
    "artifacts/api-server/src/compass/CompassNotificationEngine.ts",
    "artifacts/api-server/src/lib/intelScopedTrust.ts",
    "artifacts/api-server/src/lib/intelScopedTrustApply.ts",
    "artifacts/api-server/src/lib/requireAdmin.ts",
    "artifacts/api-server/src/lib/envValidation.ts",
    "artifacts/api-server/src/lib/calls/callGatewayAdapter.ts",
    "artifacts/api-server/src/lib/crowdFlowProducer.ts",
    "artifacts/api-server/src/migrations/2370_trust_tables_privileges.sql",
    "artifacts/api-server/src/migrations/2371_trust_profiles_evidence.sql",
    "db/rollback/2026-09-07-2370-trust-tables-privileges-rollback.sql",
    "db/rollback/2026-09-07-2371-trust-profiles-evidence-rollback.sql",
  ],
  // The Wall's 205 requirements are graded against a scope DELIBERATELY wider
  // than services/wall/ + features/wall/, for the reason §3 of that census
  // spells out: the Wall owns almost no state of its own by design (§30) and
  // rides on other surfaces' canonical systems. Its verdicts are therefore aged
  // by files it does not own —
  //   • lib/wallProjection.ts is the contract every verdict about a projection,
  //     truth class or promotion disclosure is graded against, and it lives in
  //     lib/, not services/wall/;
  //   • lib/liveClaimRead.ts is the whole of the Live For You strip's evidence
  //     (W122-W131) and its three fail-closed gates;
  //   • lib/intelContracts.ts owns SOURCE_CLASSES and SOURCE_CLASS_LABELS, which
  //     W178's disclosure is required to agree with;
  //   • routes/mediaFeed.ts owns post_saves, the canonical store behind W7's
  //     `save` — a Wall verdict that would go wrong if that endpoint moved.
  // Listing only the two Wall directories would have made this census look fresh
  // while the contracts it grades moved underneath it — the same trap the trust
  // scope above avoids.
  "census-wall.md": [
    "artifacts/api-server/src/services/wall/",
    "artifacts/api-server/src/routes/wall.ts",
    "artifacts/api-server/src/lib/wallProjection.ts",
    "artifacts/api-server/src/lib/liveClaimRead.ts",
    "artifacts/api-server/src/lib/intelContracts.ts",
    "artifacts/api-server/src/routes/mediaFeed.ts",
    "travel-buddy-standalone/src/features/wall/",
    // WIDENED 2026-09-11: cited 74 files, watched 47. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/test/wallRouteDegradation.test.ts",
    "artifacts/api-server/src/lib/mediaAssets.ts",
    "artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts",
    "artifacts/api-server/src/routes/wallTelemetry.ts",
    "artifacts/api-server/src/test/wallForYouCursor.test.ts",
    "artifacts/api-server/src/test/wallContextThread.test.ts",
    "artifacts/api-server/src/test/wallLiveForYouKinds.test.ts",
    "artifacts/api-server/src/test/wallCompassCluster.test.ts",
    "artifacts/api-server/src/routes/rentABuddy.ts",
    "artifacts/api-server/src/test/wallPerformance.test.ts",
    "src/theme/tokens.ts",
    "artifacts/api-server/src/test/wallRateLimits.test.ts",
    "artifacts/api-server/src/test/wallFollowingFeed.test.ts",
    "artifacts/api-server/src/test/wallProjection.test.ts",
    "artifacts/api-server/src/test/wallViewerLocationRead.test.ts",
    "artifacts/api-server/src/test/wallLiveStripDedup.test.ts",
    "artifacts/api-server/src/test/wallLiveForYou.test.ts",
    "artifacts/api-server/src/test/wallAutoplayContract.test.ts",
    "artifacts/api-server/src/test/wallCandidateLoaders.test.ts",
    "artifacts/api-server/src/migrations/2270_wall_feature_flags.sql",
    "artifacts/api-server/src/test/mediaCapturedAtWriter.test.ts",
    "artifacts/api-server/src/test/wallOpportunityLoader.test.ts",
    "artifacts/api-server/src/test/wallOpportunityRoute.test.ts",
    "artifacts/api-server/src/test/wallPromotionDisclosure.test.ts",
  ],
  // Discovery has NO SPEC. Its 67 rows are 25 inbound obligations from other
  // surfaces' specs, 9 rows shared with the Global Input Intelligence census,
  // and 33 contracts its own code asserts — so the scope is wider than
  // routes/discovery*.ts in two directions.
  //
  //   • the A-rows are aged by the CONTRACTS they wait on, not only by
  //     Discovery's own code: A10 turned out to be stale precisely because
  //     lib/tripDiscoveryProjection.ts appeared and nothing aged the census;
  //   • the B-rows grade the shared input-intelligence path, whose failing half
  //     is sometimes in lib/inputAssistance/.
  //
  // Listing only the two routes would have kept this census looking fresh while
  // the contract it grades was published underneath it — which is exactly what
  // happened between 507f8427 and 090684ab.
  // census-media.md — the first of the seven unscoped censuses to join the
  // checkable set, declared 2026-09-11 alongside the Trips §36 recount. 450
  // requirements, the largest single block that was CANNOT BE CHECKED.
  //
  // WHAT THE DECLARATION IS WORTH, stated here as well as in the document
  // because a scope entry is the half that can be read from code: the census's
  // verdicts were taken at working tree `68ed59d9`, which squash-merge orphaned,
  // so the interval between the measurement and `42aeac38` cannot be diffed by
  // anyone and is NOT claimed to be empty. The declaration starts the clock; it
  // does not certify the past. That is still strictly better than unmeasurable,
  // which is the state it replaces.
  //
  // The scope is DERIVED, not guessed: every `file.ts` / `.tsx` / `.sql` cited
  // in backticks by the census was extracted and resolved against the tree (166
  // distinct names, 94 resolving — the rest are bare filenames with no
  // directory), then collapsed to the directories that are wholly Media's plus
  // the individually-named files that are not. Migrations are deliberately NOT
  // scoped as a directory: `src/migrations/` grows on every unrelated surface's
  // work, and a guard that cries stale on every commit gets switched off.
  "census-media.md": [
    // Media's own backend modules — whole directories, all of them Media's.
    "artifacts/api-server/src/lib/media/",
    "artifacts/api-server/src/services/media/",
    "artifacts/api-server/src/services/hiddenGems/",
    "artifacts/api-server/src/services/ranking/",
    // Media libraries that live beside non-Media ones, so named one by one.
    "artifacts/api-server/src/lib/mediaAccess.ts",
    "artifacts/api-server/src/lib/mediaAssets.ts",
    "artifacts/api-server/src/lib/mediaContributorReputation.ts",
    "artifacts/api-server/src/lib/mediaLocationVisibility.ts",
    "artifacts/api-server/src/lib/mediaPipeline.ts",
    "artifacts/api-server/src/lib/mediaProcessing.ts",
    "artifacts/api-server/src/lib/videoMetadata.ts",
    "artifacts/api-server/src/lib/hiddenGemState.ts",
    "artifacts/api-server/src/lib/moderationAudit.ts",
    "artifacts/api-server/src/lib/portavaRank.ts",
    "artifacts/api-server/src/lib/protectedLocations.ts",
    "artifacts/api-server/src/lib/delayedPostPublisher.ts",
    // The routes that serve them.
    "artifacts/api-server/src/routes/adminMedia.ts",
    "artifacts/api-server/src/routes/mediaActions.ts",
    "artifacts/api-server/src/routes/mediaAnalyticsBatch.ts",
    "artifacts/api-server/src/routes/mediaWorld.ts",
    "artifacts/api-server/src/routes/posts.ts",
    "artifacts/api-server/src/routes/postcards.ts",
    "artifacts/api-server/src/routes/hiddenGems.ts",
    "artifacts/api-server/src/routes/sharedMoments.ts",
    // The client half. A census that scoped only the server would age on the
    // one end that was never the problem — the same mistake the Trips scope
    // above exists to avoid.
    "travel-buddy-standalone/src/features/media/",
    "travel-buddy-standalone/src/components/media/",
    // WIDENED 2026-09-11: cited 126 files, watched 89. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/compass/CompassMediaContext.ts",
    "artifacts/api-server/src/routes/mediaFeed.ts",
    "travel-buddy-standalone/src/stores/mediaStore.ts",
    "artifacts/api-server/src/migrations/0191_media_assets.sql",
    "artifacts/api-server/src/services/wall/WallCandidateLoaders.ts",
    "artifacts/api-server/src/routes/mediaViewRequest.ts",
    "artifacts/api-server/src/migrations/2037_media_tab_flags.sql",
    "artifacts/api-server/src/services/passport/PassportMemoryService.ts",
    "artifacts/api-server/src/routes/compass.ts",
    "artifacts/api-server/src/test/mediaWorldBoundaryScrub.test.ts",
    "travel-buddy-standalone/src/lib/gems/gemStateDisplay.ts",
    "artifacts/api-server/src/migrations/2250_media_asset_canonical_model.sql",
    "artifacts/api-server/src/migrations/2300_phantom_feature_flag_rows.sql",
    "artifacts/api-server/src/migrations/2039_media_events.sql",
    "artifacts/api-server/src/test/mediaWorldProjection.test.ts",
    "artifacts/api-server/src/migrations/2130_intel_storage.sql",
    "artifacts/api-server/src/migrations/2256_media_intent_signals.sql",
    "artifacts/api-server/src/migrations/2057_hidden_gems_add_a_gem_cols.sql",
    "artifacts/api-server/src/migrations/2044_hidden_gems_canonical_place_id.sql",
    "artifacts/api-server/src/migrations/2251_hidden_gem_place_protection_index.sql",
    "artifacts/api-server/src/migrations/2154_hidden_gem_visits_write_boundary.sql",
    "artifacts/api-server/src/migrations/2252_hidden_gem_contributions.sql",
    "artifacts/api-server/src/lib/intelIndependence.ts",
    "artifacts/api-server/src/lib/intelConflict.ts",
    "artifacts/api-server/src/lib/crowdFlowProducer.ts",
    "artifacts/api-server/src/routes/routePlan.ts",
    "artifacts/api-server/src/lib/intelContracts.ts",
    "artifacts/api-server/src/migrations/0103_post_media.sql",
    "artifacts/api-server/src/lib/mediaEligibility.ts",
    "artifacts/api-server/src/migrations/2089_media_assets_ready_requires_dimensions.sql",
    "travel-buddy-standalone/src/components/ui/SharedVideoPlayer.tsx",
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/routes/mapSearch.ts",
    "travel-buddy-standalone/src/components/CachedImage.tsx",
    "artifacts/api-server/src/migrations/2041_media_ranking_snapshots.sql",
  ],
  // census-telegraph.md — declared 2026-09-11 on the same basis as Media above:
  // 451 requirements out of CANNOT BE CHECKED, a clock started rather than a
  // past certified. Its verdicts were taken at working trees `ebe72b34` and
  // `feedfb0a`, both orphaned by squash-merge, so the interval before
  // `42aeac38` cannot be diffed and is not claimed to be empty.
  //
  // THE INTERESTING PART OF THIS SCOPE IS WHAT IS LEFT OUT. Telegraph cites 84
  // resolvable files and 40 of them are under src/scripts/ and src/test/ — it
  // leans harder on guards and suites as evidence than any sibling census.
  // Scoping those would age Telegraph every time an unrelated lane touched a
  // guard, which is the failure mode the header warns about: a check that cries
  // stale on every commit gets switched off, and then the real staleness comes
  // back. A census is a measurement of a SURFACE, not of the tools used to read
  // it, so only the surface is scoped.
  "census-telegraph.md": [
    "artifacts/api-server/src/lib/calls/",
    "artifacts/api-server/src/lib/telegraphBroadcast.ts",
    "artifacts/api-server/src/lib/telegraphEvents.ts",
    "artifacts/api-server/src/lib/messagingPermissions.ts",
    "artifacts/api-server/src/lib/blockGuard.ts",
    "artifacts/api-server/src/routes/messaging.ts",
    "artifacts/api-server/src/routes/telegraphChat.ts",
    "artifacts/api-server/src/routes/telegraphStream.ts",
    "artifacts/api-server/src/routes/groupChat.ts",
    "artifacts/api-server/src/routes/moderation.ts",
    "artifacts/api-server/src/routes/appeals.ts",
    "artifacts/api-server/src/services/telegraphIntent.ts",
    "artifacts/api-server/src/services/groupChatSync.ts",
    "artifacts/api-server/src/services/interactionPermissions.ts",
    "artifacts/api-server/src/services/notifications/NotificationRouter.ts",
    // The client half, per the Trips scope's rule that a server-only scope ages
    // a census on the end that was never the problem.
    "travel-buddy-standalone/src/components/telegraph/",
    "travel-buddy-standalone/src/services/messaging.ts",
    "travel-buddy-standalone/src/components/TelegraphInboxScreen.tsx",
    "travel-buddy-standalone/src/components/TelegraphSuggestionTray.tsx",
    "travel-buddy-standalone/src/components/CompassTelegraphTray.tsx",
    "travel-buddy-standalone/src/components/MessageMediaBubble.tsx",
    "travel-buddy-standalone/src/components/ThreadSafetySheet.tsx",
    "travel-buddy-standalone/src/components/TranslationSettingsSheet.tsx",
    "travel-buddy-standalone/src/components/RsvpBar.tsx",
    "travel-buddy-standalone/src/components/RichText.tsx",
    "travel-buddy-standalone/src/hooks/useMessageMediaPicker.ts",
    // WIDENED 2026-09-11: cited 131 files, watched 27 (21%). Same exclusions as
    // sensing: package.json and src/scripts/check*.ts are machinery this census
    // names rather than grades.
    "artifacts/api-server/src/routes/circle.ts",
    "artifacts/api-server/src/routes/telegraphCommands.ts",
    "artifacts/api-server/src/routes/safeReturn.ts",
    "artifacts/api-server/src/compass/CompassTools.ts",
    "travel-buddy-standalone/src/components/DiscoveryCardMessage.tsx",
    "travel-buddy-standalone/src/components/CircleStatusCardMessage.logic.ts",
    "artifacts/api-server/src/routes/calls.ts",
    "artifacts/api-server/src/services/messageTranslation.ts",
    "artifacts/api-server/src/lib/deletionDispositions.ts",
    "artifacts/api-server/src/scripts/frozenLegacyFiles.ts",
    "artifacts/api-server/src/migrations/2260_availability_windows.sql",
    "artifacts/api-server/src/routes/blocks.ts",
    "travel-buddy-standalone/src/components/PostCardMessage.tsx",
    "artifacts/api-server/src/lib/mediaPipeline.ts",
    "artifacts/api-server/src/test/messaging.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts",
    "artifacts/api-server/src/services/passport/SharedContextService.ts",
    "artifacts/api-server/src/test/memoriesBlockFailClosed.test.ts",
    "travel-buddy-standalone/src/theme/telegraphTokens.ts",
    "artifacts/api-server/src/routes/availability.ts",
    "artifacts/api-server/src/services/notifications/NotificationDeduplicationService.ts",
    "artifacts/api-server/src/lib/mediaProcessing.ts",
    "travel-buddy-standalone/src/components/GroupChatScreen.tsx",
    "artifacts/api-server/src/services/media/MyWorldMemoryService.ts",
    "artifacts/api-server/src/services/media/MediaProjectionService.ts",
    "artifacts/api-server/src/presence/domain/types.ts",
    "artifacts/api-server/src/test/blockExclusion.test.ts",
    "artifacts/api-server/src/test/rentABuddySearchBlocks.test.ts",
    "travel-buddy-standalone/src/components/rentabuddy/BookingMilestoneMessage.tsx",
    "travel-buddy-standalone/src/components/TelegraphSystemNotice.tsx",
    "travel-buddy-standalone/src/components/discovery/TripWishlistPicker.tsx",
    "artifacts/api-server/src/routes/tripCrewLocation.ts",
    "travel-buddy-standalone/src/components/CompassCardMessage.tsx",
    "artifacts/api-server/src/lib/locationPurposes.ts",
    "artifacts/api-server/src/lib/mediaAssets.ts",
    "artifacts/api-server/src/routes/devices.ts",
    "artifacts/api-server/src/services/telegraphChatSuggestions.ts",
    "artifacts/api-server/src/services/notifications/NotificationPreferenceService.ts",
    "artifacts/api-server/src/scripts/auditMigrationsVsLive.ts",
    "artifacts/api-server/src/test/telegraphRealtime.test.ts",
    "artifacts/api-server/src/test/rlsPrivacy.test.ts",
    "artifacts/api-server/src/test/accessControl.test.ts",
    "artifacts/api-server/src/test/presenceDomain.test.ts",
    "artifacts/api-server/src/test/callHardening.test.ts",
    "artifacts/api-server/src/test/silentSchemaErrorCatches.test.ts",
    "artifacts/api-server/baseline/20260819_baseline_structure.sql",
    "artifacts/api-server/src/test/compass-ui-blocks.test.ts",
    "artifacts/api-server/src/test/discoveryBlockedSubmitter.test.ts",
    "artifacts/api-server/src/lib/protectedLocations.ts",
    "artifacts/api-server/src/services/media/MediaActionResolver.ts",
    "artifacts/api-server/src/test/discoveryNegativeSignalWriter.test.ts",
    "artifacts/api-server/src/migrations/0080_events_extension.sql",
    "travel-buddy-standalone/src/components/MeetupCreationSheet.tsx",
    "travel-buddy-standalone/src/components/RouteBuilderSheet.tsx",
    "travel-buddy-standalone/app/circle-presence.tsx",
    "src/theme/tokens.ts",
    "travel-buddy-standalone/src/components/MessageEntrance.tsx",
    "travel-buddy-standalone/src/features/wall/hooks/useReducedMotionSetting.ts",
    "travel-buddy-standalone/src/features/wall/components/objects/VideoWallItem.tsx",
    "artifacts/api-server/src/migrations/2199_call_participants_rls_recursion.sql",
    "artifacts/api-server/src/test/discoverySearchBlockedSubmitter.test.ts",
    "artifacts/api-server/src/migrations/0098_profile_translation_prefs.sql",
    "artifacts/api-server/src/services/safeReturn/SafeReturnService.ts",
    "artifacts/api-server/src/scripts/auditLiveVsCanonical.ts",
    "artifacts/api-server/src/test/messagingOffApp.test.ts",
    "artifacts/api-server/src/test/telegraphChat.test.ts",
    "artifacts/api-server/src/test/telegraphStreamEndpoints.test.ts",
    "artifacts/api-server/src/test/callSystem.test.ts",
    "artifacts/api-server/src/migrations/2070_rls_hardening.sql",
    "artifacts/api-server/src/test/blocks.test.ts",
    "artifacts/api-server/src/test/blocksLib.test.ts",
    "artifacts/api-server/src/test/availability.test.ts",
    "artifacts/api-server/src/test/retranslateGate.test.ts",
    "artifacts/api-server/src/test/contentTranslationInvalidation.test.ts",
    "artifacts/api-server/src/test/commentTranslationInvalidation.test.ts",
    "artifacts/api-server/src/test/rentBuddyReliabilityRoutes.test.ts",
    "artifacts/api-server/src/test/rlsPolicyShapeLive.test.ts",
    "artifacts/api-server/src/scripts/certifyMigrations.ts",
    "artifacts/api-server/src/scripts/frozenMigrationRoots.ts",
    "artifacts/api-server/migrations/0030_message_reports.sql",
    "artifacts/api-server/migrations/0031_thread_reports.sql",
    "artifacts/api-server/src/sentry-preload.ts",
    "artifacts/api-server/src/migrations/2139_shared_content_tombstones.sql",
    "artifacts/api-server/src/scripts/auditStorageExif.ts",
    "travel-buddy-standalone/src/utils/localDate.test.ts",
    "artifacts/api-server/src/test/intelObservability.test.ts",
    "artifacts/api-server/src/test/passportTelemetryIngest.test.ts",
    "artifacts/api-server/src/routes/admin.ts",
    "artifacts/api-server/src/lib/mediaAccess.ts",
    "artifacts/api-server/src/test/mediaAccess.test.ts",
  ],
  // census-map.md, census-sensing.md, census-compass.md and
  // census-input-intelligence.md — declared 2026-09-11 on the same basis as
  // Media and Telegraph above, completing six of the seven that were
  // unmeasurable. Each verdict set was taken at a pre-squash working tree that
  // does not exist; VERIFIED against FULL history rather than assumed, after a
  // shallow clone made every one of them look unresolvable for the wrong
  // reason. `git fetch --unshallow` (4,300 commits) and then `git cat-file -e`:
  // 68ed59d9, ebe72b34, feedfb0a, e7769a45, 823b6d67 and 6c6995e1 exist
  // nowhere. So the orphaning is real and is not a clone artifact — but it was
  // very nearly recorded as proven while resting on a 54-commit clone.
  //
  // census-passport.md is deliberately NOT declared. It argues, in its own
  // header, that declaring would report FRESH about 165 rows nobody re-read and
  // that this is "a worse lie than CANNOT BE CHECKED". That is a lane's stated
  // decision about its own document; the six above carry no such refusal.
  "census-map.md": [
    "artifacts/api-server/src/lib/mapProducers/",
    "artifacts/api-server/src/lib/mapObjects.ts",
    "artifacts/api-server/src/lib/mapProjectionTripContract.ts",
    "artifacts/api-server/src/lib/mapProjectionTripRead.ts",
    "artifacts/api-server/src/lib/mapTripProjectionWorker.ts",
    "artifacts/api-server/src/lib/mapTravelers.ts",
    "artifacts/api-server/src/lib/temporalProjection.ts",
    "artifacts/api-server/src/lib/crowdFlowProducer.ts",
    "artifacts/api-server/src/lib/freshnessPolicy.ts",
    "artifacts/api-server/src/lib/confidenceScore.ts",
    "artifacts/api-server/src/lib/intelProjection.ts",
    "artifacts/api-server/src/lib/intelEvidenceCapture.ts",
    "artifacts/api-server/src/lib/locateFriendsSession.ts",
    "artifacts/api-server/src/lib/tripCrewLocation.ts",
    "artifacts/api-server/src/routes/mapObservations.ts",
    "artifacts/api-server/src/routes/mapProjection.ts",
    "artifacts/api-server/src/routes/mapProjectionTemporal.ts",
    "artifacts/api-server/src/services/intel/",
    "travel-buddy-standalone/src/components/map/",
    "travel-buddy-standalone/src/features/map/",
    "travel-buddy-standalone/app/map/",
    // WIDENED 2026-09-11: cited 108 files, watched 75. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/lib/mapProjection.ts",
    "artifacts/api-server/src/lib/mapAggregation.ts",
    "travel-buddy-standalone/src/constants/mapStyle.ts",
    "travel-buddy-standalone/src/stores/mapStore.tsx",
    "artifacts/api-server/src/lib/protectedLocations.ts",
    "travel-buddy-standalone/src/theme/mapChrome.ts",
    "travel-buddy-standalone/src/hooks/useMapEntities.ts",
    "travel-buddy-standalone/src/components/discovery/DiscoveryMapView.tsx",
    "artifacts/api-server/src/lib/buddyMapRead.ts",
    "artifacts/api-server/src/test/gatewayBypassGuard.test.ts",
    "artifacts/api-server/src/migrations/2219_locate_friends_sessions.sql",
    "travel-buddy-standalone/src/services/discovery.ts",
    "artifacts/api-server/src/migrations/2218_crowd_flow.sql",
    "artifacts/api-server/src/migrations/2201_map_projection_flag.sql",
    "artifacts/api-server/src/lib/intelContracts.ts",
    "travel-buddy-standalone/src/types/mapObjects.ts",
    "artifacts/api-server/src/lib/mapProjectPlace.ts",
    "artifacts/api-server/src/migrations/2202_map_telemetry.sql",
    "artifacts/api-server/src/migrations/2217_protected_locations.sql",
    "travel-buddy-standalone/src/services/locateFriends.ts",
    "artifacts/api-server/src/lib/routeHopSignal.ts",
    "artifacts/api-server/src/compass/CompassTemporaryIntent.ts",
    "artifacts/api-server/src/compass/types.ts",
    "artifacts/api-server/src/test/mapObjectsContract.test.ts",
    "artifacts/api-server/src/lib/intelConflict.ts",
    "artifacts/api-server/src/lib/eventPostsDiscovery.ts",
    "travel-buddy-standalone/src/services/mapProjection.ts",
    "artifacts/api-server/src/routes/mapTelemetry.ts",
    "artifacts/api-server/src/migrations/2295_map_world_intelligence_flag.sql",
    "artifacts/api-server/src/migrations/2520_trip_map_projection_worker.sql",
    "artifacts/api-server/src/migrations/2610_map_trip_projection_anchor.sql",
  ],
  "census-sensing.md": [
    "artifacts/api-server/src/lib/sensingAnonStore.ts",
    "artifacts/api-server/src/lib/intelThrottle.ts",
    "artifacts/api-server/src/lib/liveClaimRead.ts",
    "artifacts/api-server/src/lib/qiuShadow.ts",
    "artifacts/api-server/src/lib/discoveryPde.ts",
    "artifacts/api-server/src/lib/discoveryShadow.ts",
    "artifacts/api-server/src/lib/temporalProjection.ts",
    "artifacts/api-server/src/presence/domain/",
    "artifacts/api-server/src/services/intel/",
    "artifacts/api-server/src/routes/intel.ts",
    "artifacts/api-server/src/routes/compassSense.ts",
    "artifacts/api-server/src/compass/CompassExplanationEngine.ts",
    "artifacts/api-server/src/services/airport/LayoverRecommendationService.ts",
    "artifacts/api-server/src/services/wall/wallRabGate.ts",
    // WIDENED 2026-09-11: this census cited 92 files and watched 15 (16%), the
    // lowest coverage of any census. Excluded on purpose: package.json, and
    // src/scripts/check*.ts / rlsDispositions.ts — named as machinery, not
    // graded. Adding a scripts/ path here is also what broke CI on b94a6fae,
    // where checkCensusFreshness.ts entering the sensing scope tripped a test
    // asserting the exact set of files naming sensingAnonStore.
    "artifacts/api-server/src/lib/crowdFlowProducer.ts",
    "artifacts/api-server/src/lib/intelContracts.ts",
    "artifacts/api-server/src/lib/mapProducers/worldPulseProducer.ts",
    "artifacts/api-server/src/services/wall/LiveForYouService.ts",
    "artifacts/api-server/src/lib/mapAggregation.ts",
    "artifacts/api-server/src/lib/locationPurposes.ts",
    "artifacts/api-server/src/lib/privacyGate.ts",
    "artifacts/api-server/src/lib/inputAssistance/liveSuggestions.ts",
    "artifacts/api-server/src/app.ts",
    "artifacts/api-server/src/lib/quickSignal.ts",
    "artifacts/api-server/src/lib/intelRetentionScheduler.ts",
    "artifacts/api-server/src/lib/dataRights.ts",
    "artifacts/api-server/src/test/crowdFlowProducer.test.ts",
    "artifacts/api-server/src/routes/telegraph.ts",
    "artifacts/api-server/src/routes/compassHome.ts",
    "artifacts/api-server/src/lib/protectedLocations.ts",
    "artifacts/api-server/src/services/wall/FollowingFeedService.ts",
    "artifacts/api-server/src/migrations/2130_intel_storage.sql",
    "artifacts/api-server/src/lib/coverageAssembly.ts",
    "artifacts/api-server/src/routes/mapProjection.ts",
    "artifacts/api-server/src/lib/mapProducers/worldIntelligence.ts",
    "artifacts/api-server/src/lib/discoveryModifiers.ts",
    "artifacts/api-server/src/lib/intelProjection.ts",
    "artifacts/api-server/src/lib/intelIndependence.ts",
    "artifacts/api-server/src/lib/coverageScore.ts",
    "artifacts/api-server/src/services/wall/WallProjectionService.ts",
    "travel-buddy-standalone/src/types/mapObjects.ts",
    "artifacts/api-server/src/services/hiddenGems/HiddenGemModerationService.ts",
    "artifacts/api-server/src/lib/memoryProjectionScheduler.ts",
    "artifacts/api-server/src/lib/intelScopedTrust.ts",
    "artifacts/api-server/src/lib/intelCalibrationScheduler.ts",
    "artifacts/api-server/src/lib/mapObjects.ts",
    "artifacts/api-server/src/lib/mapProjection.ts",
    "artifacts/api-server/src/scripts/auditStorageExif.ts",
    "artifacts/api-server/src/migrations/2295_map_world_intelligence_flag.sql",
    "artifacts/api-server/src/lib/mapProducers/safetyNoticeProducer.ts",
    "artifacts/api-server/src/migrations/2172_intel_contribution_consent.sql",
    "artifacts/api-server/src/migrations/2173_intel_contribution_retention.sql",
    "artifacts/api-server/src/services/wall/ContextThreadService.ts",
    "artifacts/api-server/src/compass/CompassMediaContext.ts",
    "artifacts/api-server/src/services/media/MediaProjectionService.ts",
    "artifacts/api-server/src/lib/trailLiveIntel.ts",
    "artifacts/api-server/src/compass/CompassLiveEngine.ts",
    "artifacts/api-server/src/compass/CompassContextEngine.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/freshnessDisplay.ts",
    "travel-buddy-standalone/src/hooks/useActiveLocation.ts",
    "artifacts/api-server/src/lib/mapProducers/travelerFlowProducer.ts",
    "artifacts/api-server/src/scripts/backfill-canonical-places.ts",
    "artifacts/api-server/src/compass/CompassSafetyFilter.ts",
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/services/hiddenGems/HiddenGemContributionService.ts",
    "artifacts/api-server/src/compass/CompassIntentModeEngine.ts",
    "artifacts/api-server/src/services/wall/WallRankingService.ts",
    "artifacts/api-server/src/compass/CompassStructuredContext.ts",
    "artifacts/api-server/src/routes/compass.ts",
    "artifacts/api-server/src/compass/CompassTripContext.ts",
    "artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts",
    "artifacts/api-server/src/migrations/2260_availability_windows.sql",
    "artifacts/api-server/src/services/passport/PassportProjectionService.ts",
    "artifacts/api-server/src/lib/mapProducers/eventContextProducer.ts",
    "artifacts/api-server/src/compass/CompassNotificationEngine.ts",
    "artifacts/api-server/src/services/notifications/NotificationDeduplicationService.ts",
    "artifacts/api-server/src/lib/locateFriendsSession.ts",
    "artifacts/api-server/src/test/locateFriendsSession.test.ts",
    "artifacts/api-server/src/lib/intelOutcomes.ts",
    "artifacts/api-server/src/lib/discoveryServePointReport.ts",
    "artifacts/api-server/src/scripts/certifyMigrations.ts",
    "artifacts/api-server/src/test/mapWorldIntelligenceLayer.test.ts",
    "artifacts/api-server/src/test/crossSystemPrivacy.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/__tests__/freshnessDisplay.test.ts",
  ],
  "census-compass.md": [
    "artifacts/api-server/src/compass/",
    "artifacts/api-server/src/routes/compass.ts",
    "artifacts/api-server/src/routes/compassAutopilot.ts",
    "artifacts/api-server/src/routes/compassHome.ts",
    "artifacts/api-server/src/routes/compassSense.ts",
    "artifacts/api-server/src/routes/airport.ts",
    // WIDENED 2026-09-11: cited 60 files, watched 34. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/test/compassCensusGates.test.ts",
    "artifacts/api-server/src/services/airport/LayoverCompassService.ts",
    "artifacts/api-server/src/test/compass-live-constraints.test.ts",
    "travel-buddy-standalone/src/features/map/compass/compassMapModel.ts",
    "artifacts/api-server/src/test/compass-social.test.ts",
    "artifacts/api-server/src/test/compass-hardening.test.ts",
    "artifacts/api-server/src/routes/compassLive.ts",
    "artifacts/api-server/src/routes/compassOutcomes.ts",
    "artifacts/api-server/src/routes/compassGraph.ts",
    "artifacts/api-server/src/routes/adminCompass.ts",
    "artifacts/api-server/src/lib/intelContracts.ts",
    "artifacts/api-server/src/lib/inputAssistance/projection.ts",
    "artifacts/api-server/src/lib/inputAssistance/semanticIntent.ts",
    "artifacts/api-server/src/test/tripsHostingDegraded.test.ts",
    "artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts",
    "artifacts/api-server/src/services/passport/PassportConsumerAccess.ts",
    "travel-buddy-standalone/src/components/compass/CompassTravelerRow.tsx",
    "artifacts/api-server/src/routes/messaging.ts",
    "artifacts/api-server/src/routes/telegraphCommands.ts",
    "artifacts/api-server/src/services/telegraphChatSuggestions.ts",
    "artifacts/api-server/src/routes/telegraphChat.ts",
    "artifacts/api-server/src/lib/circleAccessGuard.ts",
    "artifacts/api-server/src/test/compass-ux.test.ts",
    "artifacts/api-server/src/test/compassRhythmGate.test.ts",
    "artifacts/api-server/src/routes/trips.ts",
  ],
  // Input Intelligence is the thinnest-citing of the six (36 of 81 backticked
  // paths resolve) and the most client-weighted: its subject is the typing
  // surface, so the hooks ARE the measurement, not evidence about it.
  "census-input-intelligence.md": [
    "artifacts/api-server/src/lib/inputAssistance/",
    "artifacts/api-server/src/lib/canonicalLocations.ts",
    "artifacts/api-server/src/lib/usernameRules.ts",
    "artifacts/api-server/src/lib/rentaBuddyScanner.ts",
    "artifacts/api-server/src/lib/openai.ts",
    "artifacts/api-server/src/compass/CompassStructuredContext.ts",
    "travel-buddy-standalone/src/hooks/useAiWritingAssist.ts",
    "travel-buddy-standalone/src/hooks/useCreationAssistance.ts",
    "travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts",
    "travel-buddy-standalone/src/hooks/useGooglePlacesAutocomplete.ts",
    "travel-buddy-standalone/src/hooks/usePlaceSearch.ts",
    "travel-buddy-standalone/src/hooks/useSearchSuggestions.ts",
    "travel-buddy-standalone/src/hooks/useTelegraphRecipients.ts",
    "travel-buddy-standalone/src/components/MentionInput.tsx",
    "travel-buddy-standalone/src/components/selectors/GlobalPlacePicker.tsx",
    "travel-buddy-standalone/src/lib/cityCentroids.ts",
    // WIDENED 2026-09-11: cited 99 files, watched 28. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/routes/inputAssistance.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/SmartInput.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts",
    "artifacts/api-server/src/test/inputAssistanceCertification.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/SuggestionOverlay.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/services/inputTelemetry.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/freshnessDisplay.ts",
    "artifacts/api-server/src/test/inputAssistanceInvariants.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/search/smartActions.ts",
    "travel-buddy-standalone/src/platform/input-assistance/social/socialFields.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/suggestionCache.ts",
    "travel-buddy-standalone/src/platform/input-assistance/contexts/fieldRegistry.ts",
    "artifacts/api-server/src/test/inputPolicyContractParity.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/queryNormalization.ts",
    "artifacts/api-server/src/routes/discoverySearchHelpers.ts",
    "travel-buddy-standalone/src/platform/input-assistance/search/searchFields.ts",
    "travel-buddy-standalone/src/platform/input-assistance/creation/creationFields.ts",
    "travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/suggestionHistory.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/DisambiguationSheet.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/selectionWriterCoverage.test.ts",
    "artifacts/api-server/src/migrations/2220_canonical_locations_search_key.sql",
    "travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts",
    "travel-buddy-standalone/src/platform/input-assistance/compass/compassFields.ts",
    "travel-buddy-standalone/src/features/wall/components/WallHeader.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/types/inputContext.ts",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/useInputValidation.ts",
    "travel-buddy-standalone/src/platform/input-assistance/types/inputSuggestion.ts",
    "artifacts/api-server/src/test/inputAssistanceGlobalSearch.test.ts",
    "app/trip/new.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/SuggestionChip.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/ActionSuggestionRow.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/CorrectionBanner.tsx",
    "artifacts/api-server/src/test/inputAssistanceLiveIntelligence.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/__tests__/freshnessDisplay.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/raceGuard.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/suggestionRanking.ts",
    "travel-buddy-standalone/src/platform/input-assistance/contexts/inputContexts.ts",
    "travel-buddy-standalone/src/platform/input-assistance/types/suggestionAction.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/inputTelemetry.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/raceAndCache.test.ts",
    "travel-buddy-standalone/app/gems/submit.tsx",
    "artifacts/api-server/src/lib/blocks.ts",
    "artifacts/api-server/src/lib/rateLimit.ts",
    "artifacts/api-server/src/lib/liveClaimRead.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/suggestionGrouping.ts",
    "travel-buddy-standalone/app/events/create/index.tsx",
    "travel-buddy-standalone/src/components/ShareSheet.tsx",
    "travel-buddy-standalone/src/components/stamps/StampDetailModal.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/entityIcon.tsx",
    "artifacts/api-server/src/test/inputAssistanceGateway.test.ts",
    "artifacts/api-server/src/lib/protectedLocations.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/SuggestionList.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/SuggestionGroup.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/useAutocomplete.ts",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/useEntitySuggestions.ts",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/useTextSuggestions.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/inputAssistance.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/entityResolution.ts",
    "travel-buddy-standalone/src/platform/input-assistance/contexts/inputPolicies.ts",
    "travel-buddy-standalone/src/features/wall/components/__tests__/WallHeader.smartInput.component.test.tsx",
    "artifacts/api-server/src/test/inputAssistanceGeoCore.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/geographic/__tests__/geoNormalization.test.ts",
    "artifacts/api-server/src/test/inputAssistanceCompassAI.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/compass/compassPrompt.ts",
    "travel-buddy-standalone/app/telegraph/new.tsx",
  ],
  "census-discovery.md": [
    "artifacts/api-server/src/routes/discovery.ts",
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/lib/discoveryCandidate.ts",
    "artifacts/api-server/src/lib/discoveryPde.ts",
    "artifacts/api-server/src/lib/discoveryShadow.ts",
    "artifacts/api-server/src/lib/discoveryServeLog.ts",
    "artifacts/api-server/src/lib/discoveryModifiers.ts",
    "artifacts/api-server/src/lib/discoveryTripProjectionConsumer.ts",
    // The contracts the A-rows wait on, so publishing one ages this census.
    "artifacts/api-server/src/lib/tripDiscoveryProjection.ts",
    "artifacts/api-server/src/lib/inputAssistance/",
    // WIDENED 2026-09-11: cited 49 files, watched 11 (22%). Same exclusions.
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    "artifacts/api-server/src/test/discoverySearchBlockedSubmitter.test.ts",
    "artifacts/api-server/src/test/discoveryBlockedSubmitter.test.ts",
    "artifacts/api-server/src/lib/discoveryEngineMode.ts",
    "artifacts/api-server/src/lib/portavaRank.ts",
    "artifacts/api-server/src/routes/mapProjection.ts",
    "db/rollback/2026-09-07-2360-discovery-buddy-launch-gate-rollback.sql",
    "artifacts/api-server/src/lib/discoveryCacheCleanup.ts",
    "artifacts/api-server/src/test/discoveryCandidate.test.ts",
    "travel-buddy-standalone/src/features/map/pulse/pulseMapBridge.ts",
    "artifacts/api-server/src/services/hiddenGems/HiddenGemContributionService.ts",
    "artifacts/api-server/src/test/discoveryEngineMode.test.ts",
    "travel-buddy-standalone/src/hooks/useSearchSuggestions.ts",
    "travel-buddy-standalone/src/hooks/useGooglePlacesAutocomplete.ts",
    "travel-buddy-standalone/src/hooks/usePlaceSearch.ts",
    "travel-buddy-standalone/src/components/MentionInput.tsx",
    "travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts",
    "travel-buddy-standalone/app/search.tsx",
    "artifacts/api-server/src/routes/hiddenGems.ts",
    "travel-buddy-standalone/src/components/DiscoveryCardMessage.tsx",
    "artifacts/api-server/src/lib/canonicalLocations.ts",
    "artifacts/api-server/src/lib/protectedLocations.ts",
    "artifacts/api-server/src/test/inputAssistanceCertification.test.ts",
    "artifacts/api-server/src/lib/blocks.ts",
    "artifacts/api-server/src/routes/compass.ts",
    "travel-buddy-standalone/src/components/DiscoveryWall.tsx",
    "artifacts/api-server/src/lib/discoveryCohort.ts",
    "artifacts/api-server/src/test/discoveryCacheCleanup.test.ts",
    "artifacts/api-server/src/lib/discoveryPlacePhotoStore.ts",
    "artifacts/api-server/src/test/discoveryPlaceWriteBoundary.test.ts",
    "artifacts/api-server/src/lib/discoveryServePointReport.ts",
    "artifacts/api-server/src/lib/discoveryLocalMomentum.ts",
    "travel-buddy-standalone/src/hooks/useCommunityDiscovery.ts",
    "artifacts/api-server/src/migrations/2360_discovery_buddy_launch_gate_flag.sql",
    "artifacts/api-server/src/test/discoverySearch.test.ts",
    "artifacts/api-server/src/migrations/2361_discovery_candidate_projection_flag.sql",
    "db/rollback/2026-09-07-2361-discovery-candidate-projection-rollback.sql",
  ],
};

interface Ack {
  census: string;
  since: string;
  reason: string;
  /**
   * The counted files this acknowledgement covers, repo-relative.
   *
   * WITHOUT THIS THE LEDGER WAS A MUTE BUTTON AFTER ALL. An acknowledgement was
   * keyed on (census, since) alone, so it silenced EVERY subsequent change to
   * that census's files — not just the one whose harmlessness had been argued.
   * Measured 2026-09-08: an entry written to cover ONE comment-only change to
   * lib/memoryOutbox.ts was, four commits later, quietly covering FOUR changed
   * files, three of which nobody had looked at. The reason field still read as
   * though it described the whole silence.
   *
   * Now an acknowledgement covers exactly the paths it names, and a counted file
   * that changed and is NOT named makes the census stale again.
   */
  files?: readonly string[];
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

/** Runs a git command for its EXIT CODE only, saying nothing on either path. */
function gitSucceeds(args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: REPO, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const files = readdirSync(CENSUS_DIR).filter((f) => f.startsWith("census-") && f.endsWith(".md")).sort();
const problems: string[] = [];

const acks: Ack[] = existsSync(LEDGER)
  ? (JSON.parse(readFileSync(LEDGER, "utf8")).acknowledged ?? [])
  : [];

const head = git(["rev-parse", "HEAD"]);
let checked = 0;
let stale = 0;
let unscoped = 0;
let undeclared = 0;
const rows: string[] = [];

for (const f of files) {
  const text = readFileSync(join(CENSUS_DIR, f), "utf8");
  const declared = readHeadCommit(text);
  if (declared.kind === "malformed") {
    // A census that TRIED to declare a commit and got the shape wrong used to
    // be reported as one that never declared, and the run passed. See
    // lib/censusHeadCommit.ts for the day that happened.
    problems.push(`::error::${f} mentions head_commit but no hash could be parsed from it. ${HEAD_COMMIT_ROW_SHAPE}`);
    continue;
  }
  if (declared.kind === "absent") {
    undeclared++;
    rows.push(`  ${f.padEnd(34)} no head_commit declared — CANNOT BE CHECKED`);
    continue;
  }
  const commit = declared.commit;
  const scope = CENSUS_SCOPE[f];
  if (!scope) {
    unscoped++;
    rows.push(`  ${f.padEnd(34)} declares ${commit.slice(0, 8)} but has no scope in CENSUS_SCOPE — CANNOT BE CHECKED`);
    continue;
  }
  checked++;

  // AN UNREACHABLE DECLARATION IS THE DEFECT, NOT A CLONE PROBLEM, and this
  // check said the opposite for as long as it existed.
  //
  // MEASURED 2026-09-10. Six censuses declared PRE-SQUASH working-tree commits.
  // This repository squash-merges, so a branch's own commits become ancestors of
  // nothing the moment it lands: they sit on no ref, ship in no clone, and
  // survive only in the object store of the container that wrote them. The
  // consequence is the one shape of failure a guard must not have — it passed on
  // the developer's machine, where the objects happened to still be lying
  // around, and failed in CI, where a fresh clone cannot resolve them. The error
  // it printed there, `git could not diff <commit>..HEAD`, reads like a checkout
  // problem and sent the reader to the wrong place.
  //
  // The rule is ANCESTOR-OF-HEAD, not ancestor-of-main. A census measured on a
  // branch and declared at that branch's commit is legitimate and must keep
  // working; what cannot be allowed is a declaration pointing at a commit that
  // is on no line of history leading here, because that is precisely the one
  // nobody else will ever be able to check.
  if (!gitSucceeds(["cat-file", "-e", `${commit}^{commit}`])) {
    problems.push(
      `::error::${f} declares head_commit ${commit.slice(0, 8)}, which DOES NOT EXIST in this clone. A census ` +
        `measured at a commit nobody else can resolve is unverifiable everywhere but the machine that wrote it. ` +
        `This repository squash-merges, so a pre-squash working-tree commit is an ancestor of nothing — re-declare ` +
        `at the squash where this document's content reached the default branch, and say in the row what changed ` +
        `between the two and why it cannot have moved a verdict.`,
    );
    stale++;
    continue;
  }
  if (!gitSucceeds(["merge-base", "--is-ancestor", commit, head])) {
    problems.push(
      `::error::${f} declares head_commit ${commit.slice(0, 8)}, which exists in THIS clone but is not an ancestor ` +
        `of HEAD. It is on no line of history leading here, so it is an orphan that will not survive being pushed, ` +
        `cloned or checked out anywhere else — the check would pass here and fail in CI. Re-declare it at a commit ` +
        `this branch actually descends from.`,
    );
    stale++;
    continue;
  }

  let changed: string[];
  try {
    changed = git(["diff", "--name-only", `${commit}..${head}`, "--", ...scope]).split("\n").filter(Boolean);
  } catch {
    problems.push(`::error::${f}: git could not diff ${commit}..HEAD, though ${commit.slice(0, 8)} resolves and is an ancestor of HEAD. This is not the unreachable-declaration case; read the git error above.`);
    continue;
  }

  if (changed.length === 0) {
    rows.push(`  ${f.padEnd(34)} FRESH at ${commit.slice(0, 8)} (0 counted files changed)`);
    continue;
  }

  const ack = acks.find((a) => a.census === f);
  if (ack && ack.since === commit) {
    // An acknowledgement covers the paths it NAMES and nothing else. An entry
    // with no `files` covers nothing, which is the honest reading of a ledger
    // written before the field existed -- it is not grandfathered in.
    const covered = new Set(ack.files ?? []);
    const uncovered = changed.filter((c) => !covered.has(c));
    if (uncovered.length === 0) {
      rows.push(
        `  ${f.padEnd(34)} ${changed.length} counted file(s) changed — ACKNOWLEDGED (all named)`,
      );
      continue;
    }
    stale++;
    problems.push(
      `::error::${f} is STALE. Its acknowledgement covers ${covered.size} named file(s), but ` +
        `${uncovered.length} counted file(s) changed that it does NOT name:\n    ${uncovered.slice(0, 8).join("\n    ")}` +
        (uncovered.length > 8 ? `\n    …and ${uncovered.length - 8} more` : "") +
        `\n  An acknowledgement silences the changes whose harmlessness it ARGUES, not every change that ` +
        `happens to follow it. Either name these files and say why they cannot have moved a verdict, or ` +
        `re-measure the census.`,
    );
    continue;
  }
  stale++;
  problems.push(
    `::error::${f} is STALE. It declares head_commit ${commit.slice(0, 8)}, and ${changed.length} file(s) it counts have ` +
      `changed since:\n    ${changed.slice(0, 8).join("\n    ")}` +
      (changed.length > 8 ? `\n    …and ${changed.length - 8} more` : "") +
      `\n  Its headline percentages therefore describe a tree that no longer exists, and anyone quoting them is quoting ` +
      `history. Re-measure it against HEAD and update head_commit, or add an entry to ` +
      `src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json naming this commit as \`since\` and saying why these changes ` +
      `cannot have moved a verdict. "Not relevant" is not a reason.`,
  );
}

// Ledger validation: an acknowledgement must not outlive its measurement.
for (const a of acks) {
  if (!files.includes(a.census)) {
    problems.push(`::error::CENSUS_STALENESS_ACKNOWLEDGED names "${a.census}", which is not a census file. Delete the entry.`);
    continue;
  }
  const text = readFileSync(join(CENSUS_DIR, a.census), "utf8");
  const m = /head_commit`?\s*\|\s*`?([0-9a-f]{7,40})/i.exec(text);
  if (m && m[1] !== a.since) {
    problems.push(
      `::error::CENSUS_STALENESS_ACKNOWLEDGED for ${a.census} names since=${a.since.slice(0, 8)}, but that census now ` +
        `declares head_commit ${m[1]!.slice(0, 8)}. The census was re-measured; the acknowledgement is spent. Delete it.`,
    );
  }
  if ((a.reason ?? "").length < 80) {
    problems.push(
      `::error::CENSUS_STALENESS_ACKNOWLEDGED for ${a.census} carries a ${(a.reason ?? "").length}-character reason. ` +
        `Saying why a code change cannot have moved a verdict takes more than a label.`,
    );
  }
}

if (files.length < MIN_CENSUS_FILES) {
  problems.push(`::error::found ${files.length} census file(s), expected at least ${MIN_CENSUS_FILES} — this check did not find the censuses.`);
}

for (const p of problems) console.error(p);

console.log("\nCensus freshness against HEAD " + head.slice(0, 8) + ":\n");
for (const r of rows) console.log(r);
console.log(
  `\nNOTE: ${files.length} census file(s); ${checked} checkable (declare head_commit AND have a declared scope), ` +
    `${stale} STALE, ${undeclared} declare no head_commit, ${unscoped} declare one but have no scope entry. ` +
    `The last two are NOT passes — an unmeasurable census is the weakest of the three states, and they are named above.`,
);
console.log(
  `NOTE: DOES NOT COVER — (1) whether a census's verdicts are RIGHT; this checks age, not accuracy, and ` +
    `check:census-integrity checks only that a census agrees with itself. Neither checks a census against the code. ` +
    `(2) Renames: git reports the new path, so a file moved out of a counted directory stops ageing its census.`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("\ncheck:census-freshness PASSED");
