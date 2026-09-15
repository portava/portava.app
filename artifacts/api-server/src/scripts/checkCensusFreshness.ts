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
    "artifacts/api-server/src/domain/trips/commands/tripKernel.ts",
    // §45: the decision-diff harness, its golden, and the Phase 0 inventory (generated and hand-written halves).
    "artifacts/api-server/src/domain/trips/replay/corpus.ts",
    "artifacts/api-server/src/domain/trips/replay/run.ts",
    "artifacts/api-server/src/domain/trips/replay/diff.ts",
    "artifacts/api-server/src/domain/trips/replay/golden.ts",
    "artifacts/api-server/src/domain/trips/replay/golden.json",
    "artifacts/api-server/src/scripts/checkTripDecisionDiff.ts",
    "artifacts/api-server/src/scripts/tripWritePathInventory.ts",
    "docs/architecture/trips-phase0-inventory.md",
    // §41–§45: the kernel-era migrations 2779–2788 and their rollbacks, the
    // database suites that execute them, the trip guards, and the trip test
    // files those sections grade rows on. Cited by the census; watched here so
    // a change to any of them is either acknowledged or the census is stale.
    "artifacts/api-server/src/migrations/2779_trip_kernel_plan_lifecycle_and_temporal_guard.sql",
    "artifacts/api-server/src/migrations/2780_trip_subgroups.sql",
    "artifacts/api-server/src/migrations/2781_trip_decisions_ledger.sql",
    "artifacts/api-server/src/migrations/2782_trip_transport_segments.sql",
    "artifacts/api-server/src/migrations/2783_trip_goal_scope_and_member_permissions_version.sql",
    "artifacts/api-server/src/migrations/2784_trip_reservation_history.sql",
    "artifacts/api-server/src/migrations/2785_trip_disruptions_and_derived_events.sql",
    "artifacts/api-server/src/migrations/2786_trip_kernel_opportunity_events.sql",
    "artifacts/api-server/src/migrations/2787_trip_snapshot_fold_vocabulary.sql",
    "artifacts/api-server/src/migrations/2788_trip_decisions_ledger_vocabulary.sql",
    "artifacts/api-server/src/migrations/2789_trip_activity_log_retention.sql",
    "db/rollback/2026-09-12-2779-trip-kernel-plan-lifecycle-and-temporal-guard-rollback.sql",
    "db/rollback/2026-09-12-2786-trip-kernel-opportunity-events-rollback.sql",
    "db/rollback/2026-09-12-2789-trip-activity-log-retention-rollback.sql",
    "artifacts/api-server/src/test/db/",
    "artifacts/api-server/src/domain/trips/events/tripDerivedEvents.ts",
    "artifacts/api-server/src/domain/trips/events/tripReservationHistory.ts",
    "artifacts/api-server/src/scripts/checkTripKernelWriters.ts",
    "artifacts/api-server/src/scripts/checkTripPushPolicy.ts",
    "artifacts/api-server/src/scripts/checkTripWriteValidation.ts",
    "artifacts/api-server/src/test/tripKernel.test.ts",
    "artifacts/api-server/src/test/tripKernelFamiliesWiring.test.ts",
    "artifacts/api-server/src/test/tripScenarios.test.ts",
    "artifacts/api-server/src/test/tripSignals.test.ts",
    "artifacts/api-server/src/test/tripReservations.test.ts",
    "artifacts/api-server/src/test/tripFeasibilityEngine.test.ts",
    "artifacts/api-server/src/test/tripDecisionDiff.test.ts",
    "artifacts/api-server/src/test/tripWritePathInventory.test.ts",
    "artifacts/api-server/src/test/tripMapProjection.test.ts",
    "artifacts/api-server/src/test/tripKernelSensitiveDomain.test.ts",
    "artifacts/api-server/src/test/tripCrewPresenceReason.test.ts",
    "artifacts/api-server/src/test/tripSimulateReasonCodes.test.ts",
    // §47: the absence guard, the retention sweep, stage local time, the transport-mode policy, their migrations, rollbacks and suites.
    "artifacts/api-server/src/lib/privacy/absenceDisclosure.ts",
    "artifacts/api-server/src/lib/privacy/dtos.ts",
    "artifacts/api-server/src/lib/privacy/tripSerializers.ts",
    "artifacts/api-server/src/server/trips/projectionWorkers/tripRetentionScheduler.ts",
    "artifacts/api-server/src/index.ts",
    "artifacts/api-server/src/domain/trips/projections/TripTimelineProjection.ts",
    "artifacts/api-server/src/domain/trips/invariants/TripSpatialConsistency.ts",
    "artifacts/api-server/src/domain/trips/policies/TripTransportPolicy.ts",
    "artifacts/api-server/src/migrations/2790_trip_absence_guard_flag.sql",
    "artifacts/api-server/src/migrations/2791_trip_reservation_raw_text_retention.sql",
    "artifacts/api-server/src/migrations/2792_trip_retention_sweep_flag.sql",
    "artifacts/api-server/src/migrations/2793_trip_transport_policies.sql",
    "db/rollback/2026-09-12-2791-trip-reservation-raw-text-retention-rollback.sql",
    "db/rollback/2026-09-12-2793-trip-transport-policies-rollback.sql",
    "artifacts/api-server/src/test/tripAbsenceGuard.test.ts",
    "artifacts/api-server/src/test/tripRetentionScheduler.test.ts",
    "artifacts/api-server/src/test/tripTimelineStageLocalTime.test.ts",
    "artifacts/api-server/src/test/tripTransportPolicy.test.ts",
    "artifacts/api-server/src/test/tripTransportPolicyRoute.test.ts",
    "artifacts/api-server/src/test/tripSpatialConsistency.test.ts",
    "artifacts/api-server/src/test/db/tripReservationRawTextRetention.db.test.ts",
    "artifacts/api-server/src/test/db/tripTransportPolicies.db.test.ts",
    // §48: the §18 offline bundle, the operation queue, their route and suites.
    "artifacts/api-server/src/domain/trips/services/TripOfflineQueue.ts",
    "artifacts/api-server/src/domain/trips/services/TripOfflineBundle.ts",
    "artifacts/api-server/src/routes/tripOffline.ts",
    "artifacts/api-server/src/test/tripOfflineQueue.test.ts",
    "artifacts/api-server/src/test/tripOfflineBundle.test.ts",
    "artifacts/api-server/src/test/tripOfflineRoute.test.ts",
    "artifacts/api-server/src/test/db/tripOfflineReplay.db.test.ts",
    // §49: the presence write (newest observation) and its suite.
    "artifacts/api-server/src/domain/trips/projections/TripFreedomProjection.ts",
    "artifacts/api-server/src/domain/trips/projections/TripTodayProjection.ts",
    "artifacts/api-server/src/test/tripPresenceNewestObservation.test.ts",
    "artifacts/api-server/src/test/tripCloseout.test.ts",
    "artifacts/api-server/src/domain/trips/services/tripCrewLocation.ts",
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
    "artifacts/api-server/src/server/trips/commandRoute.ts",
    "artifacts/api-server/src/routes/tripDecisions.ts",
    "artifacts/api-server/src/routes/tripFeasibility.ts",
    // §14.1's route was missing from this list until 2026-09-09, so a change to
    // the TripMapProjection surface aged nothing — the same shape of hole as a
    // census that declares no head_commit, one entry down.
    "artifacts/api-server/src/server/trips/readRoutes/tripMapProjection.ts",
    "artifacts/api-server/src/routes/tripPresence.ts",
    "artifacts/api-server/src/routes/tripStructure.ts",
    "artifacts/api-server/src/routes/tripReadiness.ts",
    "artifacts/api-server/src/domain/trips/",
    "artifacts/api-server/src/server/trips/",
    "artifacts/api-server/src/domain/trips/services/tripReadiness.ts",
    // The client half — a route with no screen is 29.2's other gap.
    "travel-buddy-standalone/src/services/tripCommands.ts",
    "travel-buddy-standalone/src/features/trips/planning/tripDecisions.ts",
    "travel-buddy-standalone/src/features/trips/planning/tripFeasibility.ts",
    "travel-buddy-standalone/src/features/trips/crew/tripPresence.ts",
    "travel-buddy-standalone/src/components/trip/",
    "travel-buddy-standalone/app/trip/",
    // ── ADDED 2026-09-11, and the reason is a defect this scope had ──────────
    // Everything above is the Trip KERNEL programme. Everything below is the
    // DEPLOYED coordination product — and that is where this census's
    // BUILT-AND-CORRECT rows live. The split mattered: measured on 2026-09-11,
    // the scope covered 10 of the 49 files the census cites, and the 39 it
    // missed were led by domain/trips/services/tripCrewLocation.ts (34 citations),
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
    "artifacts/api-server/src/domain/trips/services/tripCrewLocation.ts",
    "artifacts/api-server/src/routes/tripCrewLocation.ts",
    "artifacts/api-server/src/routes/trips-expansion.ts",
    "artifacts/api-server/src/routes/tripReservations.ts",
    "artifacts/api-server/src/routes/tripBudgetIntel.ts",
    "artifacts/api-server/src/routes/tripDraft.ts",
    "artifacts/api-server/src/routes/locateFriends.ts",
    "artifacts/api-server/src/domain/trips/invariants/tripStatus.ts",
    "artifacts/api-server/src/domain/trips/invariants/tripMembership.ts",
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
    "travel-buddy-standalone/src/features/trips/crew/",
    // WIDENED 2026-09-11: cited 117 files, watched 38. Same exclusions as
    // the other censuses — package.json and check* machinery are named as tools,
    // not graded. See check:census-scope-coverage for why the ratio matters.
    "artifacts/api-server/src/test/tripPrivacy.test.ts",
    "src/components/TripPage.tsx",
    "artifacts/api-server/src/lib/placeIdBridge.ts",
    "artifacts/api-server/src/server/trips/projectionWorkers/tripCrewLiveShareScheduler.ts",
    "artifacts/api-server/src/server/trips/projectionWorkers/tripReminderScheduler.ts",
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
    "travel-buddy-standalone/src/features/trips/planning/tripPlan.ts",
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
    "artifacts/api-server/src/domain/trips/contracts/tripDiscoveryProjection.ts",
    "artifacts/api-server/src/lib/discoveryTripProjectionConsumer.ts",
    "artifacts/api-server/src/services/memoryProjections/projectionRegistry.ts",
    "artifacts/api-server/src/scripts/tripKernelWriterBaseline.ts",
    "artifacts/api-server/src/test/tripFeasibilityRoute.test.ts",
    // WIDENED 2026-09-12 (§40.1): the §6.1 policy module, the Appendix B
    // vocabulary, the presence predicate and the callsite ratchet. Each one
    // decides a verdict in §40.1 (TR101-TR111, TR115, TR441-TR451).
    "artifacts/api-server/src/domain/trips/policies/tripPolicy.ts",
    "artifacts/api-server/src/domain/trips/policies/tripPresencePolicy.ts",
    "artifacts/api-server/src/domain/trips/contracts/tripReasonCodes.ts",
    "artifacts/api-server/src/scripts/checkTripPolicyCallsites.ts",
    "artifacts/api-server/src/test/tripPolicy.test.ts",
    "artifacts/api-server/src/test/tripReasonCodes.test.ts",
    "artifacts/api-server/src/routes/safeReturn.ts",
    // ── ADDED 2026-09-12 (§40.2): the §19.1 envelope, §19.2's read routes and
    // their consumers. services/trips/ is already scoped as a directory.
    "artifacts/api-server/src/server/trips/readRoutes/tripProjections.ts",
    "artifacts/api-server/src/domain/trips/services/tripMetrics.ts",
    "artifacts/api-server/src/lib/discoveryTripProjectionConsumer.ts",
    "artifacts/api-server/src/test/tripProjectionEnvelope.test.ts",
    "artifacts/api-server/src/test/tripProjections.test.ts",
    "travel-buddy-standalone/src/services/tripProjectionEnvelope.ts",
    "travel-buddy-standalone/src/features/trips/map/tripMapProjection.ts",
    "travel-buddy-standalone/src/services/__tests__/tripProjectionEnvelope.test.ts",
    // §40.3: the Temporal Freedom Engine's suites (the engine itself is under services/trips/).
    "artifacts/api-server/src/test/tripFreedomEngine.test.ts",
    "artifacts/api-server/src/test/tripFreedomWindows.test.ts",
    // §40.4-§40.5: phase, health, today (under services/trips/), their gate, its
    // flag seed, and their suites.
    "artifacts/api-server/src/domain/trips/policies/tripOperationalProjections.ts",
    "artifacts/api-server/src/migrations/2778_trip_operational_projections_flag.sql",
    "artifacts/api-server/src/test/tripOperationalPhase.test.ts",
    "artifacts/api-server/src/test/tripHealthProjection.test.ts",
    "artifacts/api-server/src/test/tripTodayProjection.test.ts",
    // §40.6-§40.7: presence freshness, the closeout, the decision ledger, the
    // crew-map service that forwards the presence columns, and their suites.
    "artifacts/api-server/src/domain/trips/policies/tripPresenceFreshness.ts",
    "artifacts/api-server/src/domain/trips/services/TripCrewLocationService.ts",
    "artifacts/api-server/src/test/tripPresenceFreshnessClass.test.ts",
    "artifacts/api-server/src/test/tripCloseout.test.ts",
  ],
  "census-layover.md": [
    // WIDENED 2026-09-14. The Layover lane's §21 work: the safe-return live-share
    // service whose `expireShare` swallow it closed, its expiry-honesty suite, the
    // notification service beside it, and the SCHEDULER — which is the caller that
    // was discarding the result, so a census row about whether an expiry failure
    // is visible is graded on that file as much as on the service.
    "artifacts/api-server/src/services/safeReturn/SafeReturnLiveShareService.ts",
    "artifacts/api-server/src/services/safeReturn/SafeReturnNotificationService.ts",
    "artifacts/api-server/src/services/safeReturn/__tests__/safeReturnLiveShareExpiryHonesty.test.ts",
    "artifacts/api-server/src/lib/safeReturnScheduler.ts",
    "artifacts/api-server/src/test/layoverBuddiesMasterFlag.test.ts",
    // WIDENED 2026-09-13 at integration of the Layover lane's §11. Every path
    // below is an artifact §11 GRADES, not machinery: migration 2860 and its
    // rollback are the two tables L14/L86/L194/L263 are scored against, and the
    // three test files are the evidence the fourteen new C verdicts cite. They
    // were measured at 94% against a 90% floor — passing, and still wrong to
    // leave, because an uncovered citation is a row that can rot without the
    // guard noticing. The floor is raised to 96% below, which is the ratchet the
    // widening earns.
    "artifacts/api-server/src/migrations/2860_layover_airport_truth_and_events.sql",
    "db/rollback/2026-09-13-2860-layover-airport-truth-and-events-rollback.sql",
    "artifacts/api-server/src/test/layoverAirportTruth.test.ts",
    "artifacts/api-server/src/test/layoverEventReplanner.test.ts",
    "artifacts/api-server/src/test/layoverLiveConditions.test.ts",
    // WIDENED 2026-09-13 by §12, which cites this file as the evidence that
    // §11.1 is reachable from PATCH /airport/sessions/:id. It grades the route,
    // not the harness: every one of §12's row moves rests on an assertion in it.
    "artifacts/api-server/src/test/layoverSessionEditReplan.test.ts",
    // WIDENED 2026-09-13 by §13, which cites this file as the evidence that the
    // §9.1 hard gate reads usable time and that the safety-first comparator has
    // a caller. It grades the recommendation path a traveller walks, not a
    // harness: two of §13's three row moves rest on assertions in it. The floor
    // is NOT raised with it — this widening only keeps the existing 96 % from
    // falling when the new citations land.
    "artifacts/api-server/src/test/layoverRecommendationGate.test.ts",
    // WIDENED 2026-09-13 (§15): the plan-fit file, for the same reason as the
    // line above it. L47's move rests entirely on its assertions, and a census
    // that cites a test three times while not watching it cannot notice the
    // test changing under the verdict. The floor is NOT raised with it.
    "artifacts/api-server/src/test/layoverPlanFitUnknownLegs.test.ts",
    // WIDENED 2026-09-13 (§16), same argument a third time: L293's move rests
    // entirely on this file's assertions, and §16 cites it as the evidence that
    // the three fabricated numbers are gone and that `assess` fails closed
    // without them. The floor is NOT raised with it.
    "artifacts/api-server/src/test/layoverUnmeasuredJourney.test.ts",
    // WIDENED 2026-09-13 (§17), the same argument a fourth time. All four of
    // §17.5's row moves rest entirely on assertions in these three files — the
    // airport-maturity disclosure (L9, L250), the elected completion stamp
    // (L19, L162) — and the third is the evidence that §16.8's item 4 is
    // closed. A census that cites a test as evidence while not watching it
    // cannot notice the test changing under the verdict. The two CLIENT suites
    // this pass added need no entry: `travel-buddy-standalone/app/layover/` and
    // `travel-buddy-standalone/src/components/layover/` are already scoped as
    // directories below. The floor is NOT raised with any of them — the
    // widening only keeps the existing 96 % from falling when the new citations
    // land.
    "artifacts/api-server/src/test/layoverAirportIntelligence.test.ts",
    "artifacts/api-server/src/test/layoverCompletionStamp.test.ts",
    "artifacts/api-server/src/test/layoverReplanCandidateLegs.test.ts",
    // ALSO WIDENED 2026-09-13 (§17), and it is an old gap rather than this
    // pass's: §16 added `lib/layoverLiveIntersection.ts` to this scope because
    // this census GRADES it, and left its test outside — so the module could be
    // watched while the assertions that say what it does could change unseen.
    // The census cites the test by name. Same argument, same floor, not raised.
    "artifacts/api-server/src/test/layoverLiveIntersection.test.ts",
    // WIDENED 2026-09-13 (§16). Two files this census now GRADES and did not
    // watch. `layoverLiveIntersection.ts` carries §11's friction into the cards
    // L293 changed — a live queue may lengthen a stated duration and may not
    // conjure one out of an absence — and census-sensing watching it does not
    // make THIS census notice it moving under L293's row. `TravelTimeProvider.ts`
    // is the port whose only answer, NO_ROUTED_PROVIDER, is the reason every
    // landside leg is `unmeasured`: if a routed provider is ever wired there,
    // L293's verdict and L9's remaining half both change and this census must
    // find out. The floor is NOT raised with either.
    "artifacts/api-server/src/lib/layoverLiveIntersection.ts",
    "artifacts/api-server/src/domain/trips/contracts/TravelTimeProvider.ts",
    // And the reader those cards' live pass goes through. L81 and L276 are both
    // scored on `grep -rn liveClaimRead services/airport/`, and §11's note at
    // census-layover.md:1990 rests on ITS gates being the thing that closes the
    // read. A census whose two `N` verdicts are a grep against a file it does
    // not watch cannot notice the grep starting to return something.
    "artifacts/api-server/src/lib/liveClaimRead.ts",
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
    // ── ADDED 2026-09-14 by the scope-coverage finding ──────────────────────
    // §K.4 and §L.1 grade the been-there claim across this whole chain, and
    // every link was cited while none was watched. The client card is listed
    // BECAUSE §L.1's correction turns on whether anything imports it.
    "travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx",
    "travel-buddy-standalone/src/features/passport/MyWorldScreen.tsx",
    "artifacts/api-server/src/services/passport/PassportMapService.ts",
    "artifacts/api-server/src/services/passport/PassportProjectionService.ts",
    "artifacts/api-server/src/routes/passportStamps.ts",
    // WIDENED 2026-09-14. Five files this census cites as CONSUMERS of Memory
    // and Highlight data — the Compass grounding envelope and conversation
    // tools, the Trip Kernel command surface, Discovery's ranking modifiers and
    // the Layover envelope suite. Each is another lane's file; watching it does
    // not claim ownership, it says that if the consumer changes, a row here that
    // describes what the consumer does may have stopped being true.
    "artifacts/api-server/src/compass/CompassGroundingEnvelope.ts",
    "artifacts/api-server/src/compass/TelegraphConversationTools.ts",
    "artifacts/api-server/src/domain/trips/commands/tripKernel.ts",
    "artifacts/api-server/src/lib/discoveryModifiers.ts",
    "artifacts/api-server/src/services/airport/__tests__/layoverEnvelopeConfidence.test.ts",
    // WIDENED 2026-09-14 for section J, which built the Memory audience-revocation
    // resolver, the five-state deletion lifecycle and the §13/§18 read surfaces.
    // These three are cited as that work's evidence and were watched by nothing:
    // CompassCacheEngine is the destination PUBLIC_REVOKED writes to, mediaAccess
    // is the module H181 measured before calling the attribution hole a leak, and
    // memoryProjectionGraph is this census's own suite.
    "artifacts/api-server/src/compass/CompassCacheEngine.ts",
    "artifacts/api-server/src/lib/mediaAccess.ts",
    "artifacts/api-server/src/test/memoryProjectionGraph.test.ts",
    // WIDENED 2026-09-13 by section B, which built §25's certification runner and
    // gave the 154 prose-counted requirements real rows. A row is only as fresh
    // as the files its evidence names, so the three surfaces those rows now cite
    // are watched. src/scripts/check*.ts, guardRegistry.ts, package.json and the
    // neighbouring censuses stay out, on the same machinery exclusion every other
    // scope here applies.
    // WIDENED 2026-09-13 at integration, after check:census-scope-coverage put the
    // document at 89% against its 96% floor and named the nine files below. Every
    // one is a SUBJECT of this census, not machinery: seven are the memory-kernel
    // and highlight migrations §24-§27 grade, one is the public-feed privacy test
    // a §19 row cites as its evidence, and outboxWorker.ts is where section B
    // repointed the two `projection_lag_seconds` citations after finding them
    // pointing at a file that no longer emits the metric. Adding them is the only
    // honest way through: the alternative the guard offers — declaring them not
    // graded — would be false for all nine, and lowering the floor is the response
    // the guard says is never right.
    "artifacts/api-server/src/migrations/2710_memory_command_kernel_tables.sql",
    "artifacts/api-server/src/migrations/2711_memory_kernel_execute.sql",
    "artifacts/api-server/src/migrations/2720_highlight_resurfacing_preferences.sql",
    "artifacts/api-server/src/migrations/2721_highlight_projection_policies.sql",
    "artifacts/api-server/src/migrations/2722_highlight_sources.sql",
    "artifacts/api-server/src/migrations/2723_highlight_class_lifecycle_and_pin.sql",
    "artifacts/api-server/src/migrations/2730_memory_derivative_registry.sql",
    "artifacts/api-server/src/test/memoriesPublicFeedPrivacy.test.ts",
    "artifacts/api-server/src/server/trips/outboxWorker.ts",
    // WIDENED 2026-09-13 by section C, which built §16's eight Compass Memory
    // accessors and §14's fusion boundary. Each of the three is a SUBJECT of
    // rows this census scores (H115-H128, H5/H70/H109, H207), so a change to any
    // of them must age the document.
    //
    // Two more, added when check:census-scope-coverage put this document at
    // 95.6% against its 96% floor and named four files. Two of the four are
    // genuinely NOT graded here and are left out: `domain/trips/commands/tripKernel.ts`
    // and `compass/TelegraphConversationTools.ts` are each cited exactly once, in
    // a sentence saying the thing in them belongs to another lane. The other two
    // are subjects:
    //   lib/openai.ts — section C.2 rests its whole §16 reachability argument on
    //     what that module does when the API key is absent. If it changes to hard
    //     fail, or to a client that works without one, fourteen C rows change
    //     their ceiling and possibly their verdict.
    //   test/storyHighlightVisibility.test.ts — H2's evidence that the Story-to-
    //     Highlight audience escalation is closed AND covered. Deleting it would
    //     not change the code, and would change what this census can claim.
    "artifacts/api-server/src/lib/openai.ts",
    "artifacts/api-server/src/test/storyHighlightVisibility.test.ts",
    "artifacts/api-server/src/compass/MemoryCompassTools.ts",
    "artifacts/api-server/src/test/memoryCompassTools.test.ts",
    "artifacts/api-server/src/test/memoryPublishPolicy.test.ts",
    "artifacts/api-server/src/services/memoryCertification/",
    "artifacts/api-server/src/test/memoryCertificationFixtures.test.ts",
    "artifacts/api-server/src/test/memoryCertificationInvariants.test.ts",
    "artifacts/api-server/src/test/memoryCertificationChaos.test.ts",
    "artifacts/api-server/src/routes/contentStamps.ts",
    "artifacts/api-server/src/routes/wellKnownShare.ts",
    "artifacts/api-server/src/routes/memories.ts",
    "artifacts/api-server/src/routes/highlights.ts",
    "artifacts/api-server/src/routes/stories.ts",
    "artifacts/api-server/src/services/memory/",
    "artifacts/api-server/src/services/memoryProjections/",
    "artifacts/api-server/src/services/memoryRetrieval/",
    "artifacts/api-server/src/services/highlights/",
    // WIDENED 2026-09-13 by section E, which built §10's person visibility ladder
    // and §23's canSeeParticipant on the Memory participant surface. The service
    // itself is already covered by `src/services/memory/`; its test file is the
    // EVIDENCE H77 and H209 now cite, and deleting it would not change the code
    // while changing what this census can claim — the same argument that put
    // test/storyHighlightVisibility.test.ts in this list above.
    "artifacts/api-server/src/test/memoryParticipantLadder.test.ts",
    // WIDENED 2026-09-13 by section F, which worked §25's H239 from the SURFACE
    // end — "planned activity without occurrence cannot earn a visit
    // Memory/Stamp" — and found that one of the five Passport-stamp seams in the
    // tree minted a `verification_level: 'checkin'` city stamp for a layover the
    // route itself validates as being in the FUTURE. Five files, and each is a
    // SUBJECT of a row rather than machinery:
    //   routes/airport.ts — the seam that was wrong, and where §1's occurrence
    //     gate now sits. H4 and H239 both rest on it. It is graded by
    //     census-layover as well (L19, L162); being in two scopes is the correct
    //     answer for a file two specs have a rule about, and §F.7 names it.
    //   routes/geofence.ts — the second live surface the new suite drives, and
    //     the one H4's own body evidence has cited since the first pass.
    //   test/memoryPlannedNotExperienced.test.ts — the EVIDENCE H239 now cites.
    //     Deleting it would not change the code and would change what this
    //     census can claim; the same argument that put storyHighlightVisibility
    //     and memoryParticipantLadder in this list.
    //   services/telegraph/shareables.ts — a FOURTH reader of the Memory
    //     visibility rule, which H205's ceiling had counted as two and which
    //     disagreed with §23's predicate on blocks until §F.3. H84 and H205 both
    //     now cite it.
    //   test/telegraphShare.test.ts — that fix's red-first evidence.
    //   routes/location.ts, routes/hiddenGems.ts, routes/safeReturn.ts and
    //     services/passport/PassportStampService.ts — the other four seams §F.2
    //     enumerates. §F grades H239 on the whole set, not on the two it drives
    //     through a router, so a fifth seam appearing or one of these four
    //     losing its occurrence gate has to age the document. None of the four
    //     has changed in this census's window, which is why they need no
    //     acknowledgement.
    //   test/generated/liveColumns.json — the live information_schema. This
    //     census's largest single class of verdict is "the table §3.6 names is
    //     not in production", and §F's schema-strict assertions are only worth
    //     anything because that file is the live column set rather than a
    //     fixture. A refresh of it is EXACTLY when those verdicts should be
    //     re-read, so ageing the document on it is the behaviour wanted, not a
    //     cost of it.
    "artifacts/api-server/src/test/generated/liveColumns.json",
    //   services/passport/StampAwardEngine.ts and routes/trips.ts — §F.2's SECOND
    //     stamp family, the one it did not read, and the call site that shows the
    //     question is live. H4 and H239 are both held by this module at the end
    //     of §F: it is the definitive surface rule 7 says must be read before
    //     either can be BUILT-AND-CORRECT again. A census whose two reddest
    //     cheap rows hang on a file has to age when that file changes.
    //   lib/mapProducers/personalCityProducer.ts — the counter-example §F.2
    //     checked so a reader does not assume the map is implicated: it reads
    //     `passport_stamps`, the AUDITED family, not `user_stamps`. If it ever
    //     switches tables, that sentence becomes false and H4's blocker widens.
    "artifacts/api-server/src/services/passport/StampAwardEngine.ts",
    "artifacts/api-server/src/routes/trips.ts",
    "artifacts/api-server/src/lib/mapProducers/personalCityProducer.ts",
    "artifacts/api-server/src/routes/airport.ts",
    "artifacts/api-server/src/routes/geofence.ts",
    "artifacts/api-server/src/routes/location.ts",
    "artifacts/api-server/src/routes/hiddenGems.ts",
    "artifacts/api-server/src/routes/safeReturn.ts",
    "artifacts/api-server/src/services/passport/PassportStampService.ts",
    "artifacts/api-server/src/test/memoryPlannedNotExperienced.test.ts",
    "artifacts/api-server/src/services/telegraph/shareables.ts",
    "artifacts/api-server/src/test/telegraphShare.test.ts",
    // And compassCensusCorrectness.test.ts, which is a COMPASS-lane file and is
    // watched here anyway. D.11 rests H237's and H263's survival on its B2 case —
    // the fixture that seeds one experience node per visibility rung and decides
    // which of two competing §28.8 sweeps the merge should have kept. A census
    // that names a test as the thing deciding two of its verdicts has to age when
    // that test changes; the alternative is exactly the seam D.2 named, where a
    // fact moves in one lane and the document resting on it does not notice.
    "artifacts/api-server/src/test/compassCensusCorrectness.test.ts",
    "artifacts/api-server/src/lib/memoryCommandBus.ts",
    "artifacts/api-server/src/lib/memoryOutbox.ts",
    "artifacts/api-server/src/lib/highlightPermissions.ts",
    // WIDENED 2026-09-13 by section D, which grouped the 134 BUILT-BUT-WRONG
    // rows and, doing so, found the reader of `public.memories` no section of
    // this census had ever named: CompassGraphEngine's experience builder. Two
    // rows are now graded on it (H263 §28.10, H237 §28.8) and two more cite it
    // (H189, H190), so a change to any of these four must age this document.
    //
    // CompassGraphEngine.ts and its suite are ALSO cited by census-compass and
    // watched by no scope at all until now. Adding them here does not take them
    // from that lane; it means this census stops being able to claim a verdict
    // about a file it does not watch. §D.9 names the cross-lane change loudly.
    //
    // intelligenceGraphScheduler.ts and index.ts are the two files that make
    // "this runs daily in production" a fact rather than an assumption — if the
    // scheduler stops being started, or its interval changes, H237's ceiling
    // ("bounded by the rebuild's daily cadence") changes with it.
    "artifacts/api-server/src/compass/CompassGraphEngine.ts",
    "artifacts/api-server/src/test/compass-intelligence-graph.test.ts",
    "artifacts/api-server/src/lib/intelligenceGraphScheduler.ts",
    "artifacts/api-server/src/index.ts",
    "artifacts/api-server/src/test/memories.test.ts",
    "artifacts/api-server/src/test/memoryCommandBus.test.ts",
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
    "artifacts/api-server/src/server/trips/projectionWorkers/tripReminderScheduler.ts",
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
      // ADDED 2026-09-13 by the integration owner, at the lane's request: §H rests
    // on what these three suites assert, so an edit to one must age the census.
    "artifacts/api-server/src/test/memoryProfileLocationProtection.test.ts",
    "artifacts/api-server/src/test/memoryPatchConcurrency.test.ts",
    "artifacts/api-server/src/test/highlightProfilePrecisionClamp.test.ts",
],
  // Trust has NO SPEC — its 52 requirements are 20 inbound obligations from
  // other surfaces' specs plus 32 contracts its own code asserts. That makes the
  // scope wider than one directory: the rows about whether OTHER surfaces
  // consume Trust correctly (A13, A17) are aged by the files that consume it,
  // not by services/trust. Listing only the service would have made this census
  // look fresh while the reads it grades moved underneath it.
  "census-trust.md": [
    // ── ADDED 2026-09-14 round 4, by the INTEGRATION OWNER after §19 ───────
    // `lib/gateAge.ts` is the one that matters, and the Sensing/Trust lane
    // flagged its absence as a scope gap before I found it here: it is the
    // SINGLE seam every 18+ gate now crosses, it is the file TV-P2 and TV-5b
    // both turn on, and until this line a change to it aged no census at all.
    // A census whose two open age rows rest on a file it does not watch cannot
    // notice the day one of them stops being true.
    "artifacts/api-server/src/lib/gateAge.ts",
    "artifacts/api-server/src/test/verificationProviderRefPersisted.test.ts",
    "artifacts/api-server/src/compass/CompassSocialEngine.ts",
    "artifacts/api-server/src/domain/telegraph/policies/conversationCapabilityPolicy.ts",
    // ── ADDED 2026-09-14, rounds 2-3 of the scope-coverage repair ───────────
    // This census's floor is 100 %, so it took three rounds to reach fixpoint.
    // `routes/index.ts` is here because two trust rows are graded on whether a
    // router is MOUNTED, which is a claim about that file and nothing else.
    "artifacts/api-server/src/routes/discovery.ts",
    "artifacts/api-server/src/services/rentBuddy/CompatibilityScoreService.ts",
    "artifacts/api-server/src/test/verificationSessionCreatedStatus.test.ts",
    "artifacts/api-server/src/routes/index.ts",
    "artifacts/api-server/src/test/appealReversalAffectedRows.test.ts",
    "artifacts/api-server/src/test/verificationAttemptMetrics.test.ts",
    // ── ADDED 2026-09-14 by the scope-coverage finding ─────────────────────
    // This census's floor is 100 % and it was watching 91 %. The sensing pair
    // carries three and two citations respectively; the two suites are the
    // evidence for retention and the age gate; and SOURCE-MANIFEST.json is
    // listed deliberately — it is the spec side, and a requirement changing is
    // a reason to re-read a verdict just as much as its code changing is.
    "artifacts/api-server/src/lib/sensingCoverageAggregate.ts",
    "artifacts/api-server/src/lib/sensingAnonStore.ts",
    "artifacts/api-server/src/test/verificationRetention.test.ts",
    "artifacts/api-server/src/test/ageGate.test.ts",
    "docs/specs/upgrades-v2/SOURCE-MANIFEST.json",
    "artifacts/api-server/src/services/trust/",
    // WIDENED 2026-09-14. The Trust lane built TV-P5 — webhook signature
    // verification for both identity vendors — and this census now grades that
    // code and the suites that pin it. A verdict whose evidence names a file
    // nothing watches is a verdict with an unmonitored floor under it.
    "artifacts/api-server/src/services/identityVerification/",
    "artifacts/api-server/src/test/verificationWebhookSignature.test.ts",
    "artifacts/api-server/src/test/verificationProviderNormalization.test.ts",
    "artifacts/api-server/src/test/rentBuddyKycGate.test.ts",
    // Cited twice by the moderation-report rows; it is schema this census grades.
    "artifacts/api-server/src/migrations/0176_moderation_reports.sql",
    // TV-2c's evidence: the surface that renders a verified indicator today,
    // sourced from the legacy `profiles.verified` boolean rather than the ID check.
    "travel-buddy-standalone/src/components/compass/CompassBuddyRow.tsx",
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
    // WIDENED 2026-09-13 by the integration owner, and this is the largest widening in
    // the file for a reason worth stating. Section 12 regraded this census against
    // docs/trust/verified-foundation-plan.md, which it had never counted, so it now
    // cites the verification, moderation, appeals and client surfaces a 52-row scope
    // had no reason to watch. Coverage was 53% against a 94% floor — the worst in the
    // corpus, and exactly what a denominator that excluded its own spec looks like
    // from the scope side.
    "artifacts/api-server/src/lib/travelerVerification.ts",
    "artifacts/api-server/src/services/identityVerification/providers.ts",
    "artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts",
    "artifacts/api-server/src/test/verification.test.ts",
    "travel-buddy-standalone/app/profile/verification.tsx",
    "artifacts/api-server/src/test/verificationLevelVocabulary.test.ts",
    "db/migrations/0161_identity_verification.sql",
    "artifacts/api-server/src/services/identityVerification/readiness.ts",
    "artifacts/api-server/src/test/verificationWebhookProviderUnavailable.test.ts",
    "artifacts/api-server/src/services/identityVerification/mockProvider.ts",
    "artifacts/api-server/src/routes/rentABuddyRollout.ts",
    "artifacts/api-server/src/migrations/2870_profiles_verification_level_identity_vocabulary.sql",
    "artifacts/api-server/src/routes/moderation.ts",
    "artifacts/api-server/src/services/identityVerification/types.ts",
    "artifacts/api-server/src/routes/profile.ts",
    "travel-buddy-standalone/src/components/AgeGate.tsx",
    "db/rollback/2026-09-13-2870-profiles-verification-level-identity-vocabulary-rollback.sql",
    "artifacts/api-server/src/test/verificationStatusUnreadableProfile.test.ts",
    "artifacts/api-server/src/test/verificationTrustIdempotency.test.ts",
    "travel-buddy-standalone/src/components/ReportSheet.tsx",
    "artifacts/api-server/src/test/adminUnverifyRevokesIdLevel.test.ts",
    "travel-buddy-standalone/app/profile/edit/safety.tsx",
    "artifacts/api-server/src/migrations/2135_deletion_blocking_fks.sql",
    "artifacts/api-server/src/migrations/2138_profiles_fk_convergence_prep.sql",
    "artifacts/api-server/baseline/20260819_baseline_structure.sql",
    "artifacts/api-server/src/lib/moderationAudit.ts",
    "artifacts/api-server/src/services/identityVerification/index.ts",
    "travel-buddy-standalone/src/components/FeaturedBadge.tsx",
    "travel-buddy-standalone/src/components/OfficialBadge.tsx",
    "travel-buddy-standalone/src/components/PassportVerificationStamp.tsx",
    "travel-buddy-standalone/src/components/StampOverlayBadge.tsx",
    "travel-buddy-standalone/src/components/VerificationLevelsRail.tsx",
    "artifacts/api-server/src/app.ts",
    "artifacts/api-server/src/test/verificationWritesIssued.test.ts",
    "travel-buddy-standalone/src/components/passport/PassportOwnerMenuSheet.tsx",
    "travel-buddy-standalone/app/explore-portava.tsx",
    "travel-buddy-standalone/src/navigation/portavaRoutes.ts",
    "travel-buddy-standalone/src/components/interaction/UserIdentityLink.tsx",
    "travel-buddy-standalone/src/components/CommentsSheet.tsx",
    "travel-buddy-standalone/src/components/ThreadSafetySheet.tsx",
    "travel-buddy-standalone/src/components/ReviewsSection.tsx",
    "artifacts/api-server/src/lib/contentOwner.ts",
    "travel-buddy-standalone/src/services/moderation.ts",
    "travel-buddy-standalone/src/services/blocks.ts",
    "travel-buddy-standalone/app/admin/content-reports.tsx",
    "artifacts/api-server/src/routes/appeals.ts",
    "travel-buddy-standalone/app/appeals.tsx",
    "travel-buddy-standalone/src/components/AccountStatusGate.tsx",
    "artifacts/api-server/src/routes/meetups.ts",
    "artifacts/api-server/src/routes/requests.ts",
    "artifacts/api-server/src/services/media/MediaProjectionService.ts",
    "artifacts/api-server/src/routes/mediaFeed.ts",
    "travel-buddy-standalone/app/settings/index.tsx",
    "artifacts/api-server/src/routes/adminSafetyCandidates.ts",
    "artifacts/api-server/src/lib/safetyCandidateStore.ts",
    "artifacts/api-server/src/lib/stateMachines/registry.ts",
    "artifacts/api-server/src/test/helpers/failClosedSupabase.ts",
    "artifacts/api-server/src/test/profileVerificationSelfWriteBoundary.test.ts",
    "artifacts/api-server/src/services/identityVerification/providerErasure.ts",
    "artifacts/api-server/src/test/verificationProviderErasure.test.ts",
    "artifacts/api-server/src/services/identityVerification/retention.ts",
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
    // WIDENED 2026-09-14 for the palette ruling's evidence. `mapChrome.ts` is
    // cited to record that it is OUT of scope — its near-black navy is the Map
    // spec's dark-mode GROUND, not a brand accent — and a citation that says
    // "not this file" still ages this census if that file changes, because the
    // sentence would stop being true. The two deletion files carry W66's
    // cascade evidence.
    "travel-buddy-standalone/src/theme/mapChrome.ts",
    "artifacts/api-server/src/lib/deletionDispositions.ts",
    "artifacts/api-server/src/test/accountDeletionCascade.test.ts",
    "artifacts/api-server/src/services/wall/",
    "artifacts/api-server/src/routes/wall.ts",
    // ADDED 2026-09-14, and it is a scope gain rather than a scope grant. The
    // Wall lane QUALIFIED W66's writer pointer — it had been a bare basename
    // that resolved ambiguously, so the coverage check skipped it entirely.
    // Making it resolvable made it COUNT, which pushed census-wall from 96% to
    // 95% and sat it on its own floor. The precise citation is the improvement;
    // this line is what keeps it from reading as a regression. The Wall grades
    // what posts.ts writes (three citations), so an edit to it must age this
    // census.
    "artifacts/api-server/src/routes/posts.ts",
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
  //     domain/trips/contracts/tripDiscoveryProjection.ts appeared and nothing aged the census;
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
    // WIDENED 2026-09-15 by the Media lane. §15 cites three more media proof
    // suites by path, which pushed check:census-scope-coverage below its 96%
    // floor. The five below are this census's own mutation-proof artifacts —
    // §11, §14 and §15 all rest verdicts on what they assert — so a silent edit
    // to one is exactly the kind of change that should age this document. They
    // are named one by one rather than by scoping `src/test/`, which would age
    // the census on every unrelated surface's test work and get the check
    // switched off.
    "artifacts/api-server/src/test/mediaIndependentSources.test.ts",
    "artifacts/api-server/src/test/mediaActionsCompass.test.ts",
    "artifacts/api-server/src/test/mediaPeopleLensPopulations.test.ts",
    "artifacts/api-server/src/test/mediaGemStateLens.test.ts",
    "artifacts/api-server/src/test/mediaExperienceConfidence.test.ts",
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
    // WIDENED 2026-09-13 by census-media §9. The section executed MD105
    // (§15 "Report / Not Relevant") and found the reachable Media options sheet
    // filing moderation reports for two VIEWER-PREFERENCE taps, so that row is
    // now graded against the report contract itself and against the store the
    // preference half writes. Those four files decide MD105 and MD273 and were
    // watched by nothing: routes/reports.ts is where the reason vocabulary and
    // the severity rule live (§9.1), lib/reportReasons.ts is the classifier the
    // media endpoint now dispatches on, 0116_post_hides.sql is the table the
    // hide lands in, and the two test files are the only things that would go
    // red if either verdict rotted. A C row that rots becomes a false
    // assurance, which is the argument check:census-scope-coverage is built on.
    "artifacts/api-server/src/routes/reports.ts",
    "artifacts/api-server/src/lib/reportReasons.ts",
    "artifacts/api-server/src/migrations/0116_post_hides.sql",
    "artifacts/api-server/src/test/mediaReportIntent.test.ts",
    "artifacts/api-server/src/test/mediaFeed.test.ts",
    // WIDENED 2026-09-13 by census-media §11. The section executed 120 of the
    // census's own 288 C rows and moved seven; three of the repairs live in
    // services/media/MediaProjectionService.ts (already scoped as a directory)
    // and routes/mediaFeed.ts (already named), and this suite is the only thing
    // in the tree that goes red if MD47's neighborhood producer, MD227's Tagged
    // bucket or the MD386/MD389 §44 emitters are removed again. All three
    // defects survived for as long as they did precisely because a MISSING
    // producer leaves every existing assertion green, so the census's evidence
    // for those four rows is this file and nothing else.
    "artifacts/api-server/src/test/mediaProjectionGaps.test.ts",
    // §13's evidence base: what the LIVE schema actually is. MD227 was C for a
    // whole interval while the Tagged bucket returned nothing, because the read
    // named `tags.tagged_at` — a column the canonical migration declares and the
    // database has never had. These three files are the only artifacts in the
    // tree that can settle that question, and until §13 two of them were cited
    // by this census while nothing aged it when they moved. If the live schema
    // snapshot gains or loses a column, or the baseline structure dump is
    // regenerated, or 0043 is rewritten, §13's central claim can become false —
    // so this census must go stale on all three rather than keep quoting them.
    "artifacts/api-server/src/test/generated/liveColumns.json",
    "artifacts/api-server/baseline/20260819_baseline_structure.sql",
    "migrations/0043_tags_hashtags.sql",
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
    // ADDED 2026-09-15 with the file itself. 2325 was restored to this tree to
    // close a schema_migration_ledger row that named no file on disk; the census
    // cites it three times as "in open PR #472 — not on this branch", which the
    // restore made false about the FILE (see §26). The path is counted here so
    // any further change to it ages this census, and it is listed in the
    // telegraph acknowledgement for the restore itself, which moved no verdict
    // because no reader came with the file.
    "artifacts/api-server/src/migrations/2325_telegraph_unsend_before_seen.sql",
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
    // WIDENED 2026-09-12: the certification lane (census-telegraph §12) built a
    // Telegraph domain package, its five guards, their baselines and their
    // executable invariants, and cited all of them. Watching the package by
    // prefix means a later edit to any lattice, policy, contract or projection
    // registry ages this census, which is the point.
    "artifacts/api-server/src/domain/telegraph/",
    "artifacts/api-server/src/middlewares/telegraphObservability.ts",
    "artifacts/api-server/src/routes/telegraphDiagnostics.ts",
    "artifacts/api-server/src/routes/telegraphLiveReferences.ts",
    "artifacts/api-server/src/routes/highlights.ts",
    "artifacts/api-server/src/app.ts",
    "artifacts/api-server/src/migrations/2400_telegraph_history_bound.sql",
    "artifacts/api-server/src/migrations/2402_telegraph_membership_rls_recursion.sql",
    "artifacts/api-server/src/services/groupChatHistoryBound.ts",
    "artifacts/api-server/src/services/safeReturn/SafeReturnPrivacyGuard.ts",
    "artifacts/api-server/src/services/passport/OpenToPlansService.ts",
    "artifacts/api-server/src/domain/trips/services/tripCrewLocation.ts",
    "artifacts/api-server/src/test/telegraphAdversarialFixtures.test.ts",
    "artifacts/api-server/src/test/telegraphRlsAuthorizationMatrix.test.ts",
    "artifacts/api-server/src/test/telegraphPropertyInvariants.test.ts",
    "artifacts/api-server/src/test/telegraphCertificationHarness.ts",
    "artifacts/api-server/src/test/telegraphReplaySimulator.test.ts",
    // The two monotone ledgers. These are data, not machinery: the count of
    // entries this tree does NOT satisfy lives in them, so an edit to either is
    // exactly the kind of change that should age the verdicts that cite them.
    "artifacts/api-server/src/scripts/TELEGRAPH_CERTIFICATION_BASELINE.json",
    "artifacts/api-server/src/scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json",
    "docs/architecture/telegraph-phase0-inventory.md",
    // WIDENED AGAIN 2026-09-12: the §12–§22 lane (census-telegraph §11) added a
    // Compass tool module, four server/telegraph routes, the message kernel and
    // report-evidence services, four migrations with their rollbacks, and a
    // client feature tree. Watched by prefix where a tree exists, so a later
    // edit anywhere in it ages this census.
    "artifacts/api-server/src/compass/TelegraphConversationTools.ts",
    "artifacts/api-server/src/server/telegraph/",
    "artifacts/api-server/src/services/telegraphMessageKernel.ts",
    "artifacts/api-server/src/services/telegraphReportEvidence.ts",
    "artifacts/api-server/src/services/notifications/NotificationDigestService.ts",
    "artifacts/api-server/src/lib/chatSync.ts",
    "artifacts/api-server/src/lib/circleAccessGuard.ts",
    "artifacts/api-server/src/routes/friends.ts",
    "artifacts/api-server/src/compass/CompassNotificationEngine.ts",
    "artifacts/api-server/src/compass/CompassProfileService.ts",
    "artifacts/api-server/src/compass/CompassFallbackFeedBuilder.ts",
    "artifacts/api-server/src/services/wall/WallProjectionService.ts",
    "artifacts/api-server/src/services/ranking/CreatorActivityScoreService.ts",
    "artifacts/api-server/src/migrations/2810_telegraph_message_kernel.sql",
    "artifacts/api-server/src/migrations/2811_telegraph_message_side_tables.sql",
    "artifacts/api-server/src/migrations/2812_telegraph_report_evidence.sql",
    "artifacts/api-server/src/migrations/2813_telegraph_request_origin.sql",
    "db/rollback/2026-09-12-2810-telegraph-message-kernel-rollback.sql",
    "artifacts/api-server/src/test/telegraphConversationCapabilities.test.ts",
    "artifacts/api-server/src/test/telegraphNeedsAction.test.ts",
    "travel-buddy-standalone/src/features/telegraph/",
    // WIDENED A THIRD TIME 2026-09-12: the §1–§11 lane (census-telegraph §10)
    // added the Shared Context Rail, the share contract, the typed kinds, the
    // coordination surface, unsend, memory notes and the lifecycle routes.
    "artifacts/api-server/src/services/telegraph/",
    "artifacts/api-server/src/routes/telegraphShare.ts",
    "artifacts/api-server/src/routes/telegraphKinds.ts",
    "artifacts/api-server/src/routes/telegraphCoordination.ts",
    "artifacts/api-server/src/routes/telegraphLifecycle.ts",
    "artifacts/api-server/src/routes/telegraphMemory.ts",
    "artifacts/api-server/src/routes/memories.ts",
    "artifacts/api-server/src/routes/index.ts",
    "artifacts/api-server/src/test/telegraphSharedContext.test.ts",
    "artifacts/api-server/src/test/telegraphShare.test.ts",
    // WIDENED A FOURTH TIME 2026-09-13 by the §17 lane. `publicIdentity.ts` now
    // holds `actorHandleFrom`, the interpreter a mention notification's identity
    // claim goes through (§17.2), and the three suites below are the proof for
    // §17's roster-eviction, context-honesty and T349 work — including the row
    // move. A census that cites a proof and does not watch it cannot notice the
    // proof being deleted.
    "artifacts/api-server/src/lib/publicIdentity.ts",
    "artifacts/api-server/src/test/telegraphRosterReadEviction.test.ts",
    "artifacts/api-server/src/test/telegraphContextReadHonesty.test.ts",
    "artifacts/api-server/src/test/telegraphExpiredLocationMeasured.test.ts",
    "artifacts/api-server/src/test/telegraphKinds.test.ts",
    "artifacts/api-server/src/test/telegraphCoordination.test.ts",
    "artifacts/api-server/src/test/telegraphMemory.test.ts",
    "artifacts/api-server/src/test/telegraphLifecycle.test.ts",
    // WIDENED 2026-09-15 by the swallowed-reads lane (census-telegraph §27): the
    // suite that pins the four `routes/messaging.ts` reads §19.6 priced and declined.
    // It is cited as evidence by §19.6 item 2, so it is graded here rather than only
    // quoted — a test a census rests a closure on is a file that census counts.
    "artifacts/api-server/src/test/messagingSwallowedReadHonesty.test.ts",
    "travel-buddy-standalone/app/messages/",
    // STILL NOT WATCHED, deliberately: src/scripts/check*.ts, guardRegistry.ts,
    // generateTelegraphInventory.ts, rlsDispositions.ts, the two workflow YAMLs,
    // and the other censuses this one cross-references. Those are machinery and
    // neighbours this census NAMES; none of them is a Telegraph behaviour it
    // GRADES, and the same exclusion is already in force for Sensing and Media.
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
    // ── ADDED 2026-09-14 by the scope-coverage finding ──────────────────────
    "artifacts/api-server/src/routes/discoverySearch.ts",
    // ADDED 2026-09-14 on the Map lane's request. `geoZoneSeed.test.ts` now
    // carries M256's evidence — the first assertions in this repository that a
    // cache HIT avoids the read, where eleven map suites had only ever used the
    // `_clear*Cache()` hooks to DEFEAT the cache. It was unwatched, and adding
    // its citation pushed census-map to exactly its coverage floor.
    "artifacts/api-server/src/test/geoZoneSeed.test.ts",
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
    "artifacts/api-server/src/domain/trips/services/tripCrewLocation.ts",
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
    // ADDED 2026-09-14 on the Sensing lane's standing request. The scope covered
    // `services/intel/` and `routes/intel.ts` but not `routes/intelReadModels.ts`,
    // which now carries S49's evidence — the seven truth classes read against the
    // spec's list rather than against a list the code declares about itself. A
    // change to that file aged no census, which is precisely the gap that lets a
    // verdict go on standing after the code under it has moved.
    "artifacts/api-server/src/routes/intelReadModels.ts",
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
    // WIDENED 2026-09-12 by the Sensing lane (census-sensing §1): the files the
    // re-derivation cites and grades rows on and the scope had not been
    // watching — the anonymous store's family, the shared truth vocabulary,
    // the Map's 2350 modules, the Discovery candidate, the sensing migrations
    // and rollbacks, and the suites the C verdicts rest on. Everything here
    // existed unchanged at 42aeac38 except src/test/sensingAnonStore.test.ts,
    // which is acknowledged in the ledger.
    "artifacts/api-server/src/lib/sensingAnonService.ts",
    "artifacts/api-server/src/lib/sensingAuthPosture.ts",
    "artifacts/api-server/src/lib/sensingContributionPolicy.ts",
    "artifacts/api-server/src/lib/sensingContributionSession.ts",
    "artifacts/api-server/src/lib/sensingCoverageAggregate.ts",
    "artifacts/api-server/src/lib/sensingDifferencingGate.ts",
    "artifacts/api-server/src/lib/sensingPresenceState.ts",
    "artifacts/api-server/src/lib/sensingRetentionScheduler.ts",
    "artifacts/api-server/src/lib/sensingRevocationLineage.ts",
    "artifacts/api-server/src/lib/sensingSubjectReconciliation.ts",
    "artifacts/api-server/src/lib/vibeInference.ts",
    "artifacts/api-server/src/lib/experienceTruth.ts",
    "artifacts/api-server/src/lib/truthClass.ts",
    "artifacts/api-server/src/lib/mapExperienceState.ts",
    "artifacts/api-server/src/lib/mapDisplayResolver.ts",
    "artifacts/api-server/src/lib/mapProducers/worldMomentProducer.ts",
    "artifacts/api-server/src/lib/mapProducers/cityModelProducer.ts",
    "artifacts/api-server/src/lib/wallProjection.ts",
    "artifacts/api-server/src/lib/discoveryCandidate.ts",
    "artifacts/api-server/src/routes/mapProjectionTemporal.ts",
    "artifacts/api-server/src/routes/discovery.ts",
    "artifacts/api-server/src/compass/CompassLiveConstraints.ts",
    "artifacts/api-server/src/migrations/2315_sensing_anon_contributions.sql",
    "artifacts/api-server/src/migrations/2340_sensing_anon_replay_and_time_bounds.sql",
    "artifacts/api-server/src/migrations/2350_map_sensing_projection_flags.sql",
    "artifacts/api-server/src/migrations/2361_discovery_candidate_projection_flag.sql",
    "artifacts/api-server/src/migrations/2480_sensing_contribution_sessions.sql",
    "artifacts/api-server/src/migrations/2481_sensing_sessions_option_a_issuer.sql",
    "db/rollback/2026-09-07-2340-sensing-anon-replay-and-time-bounds-rollback.sql",
    "db/rollback/2026-09-07-2480-sensing-contribution-sessions-rollback.sql",
    "db/rollback/2026-09-07-2481-sensing-sessions-option-a-issuer-rollback.sql",
    "artifacts/api-server/src/test/sensingAnonStore.test.ts",
    "artifacts/api-server/src/test/sensingAnonService.test.ts",
    "artifacts/api-server/src/test/sensingAuthPosture.test.ts",
    "artifacts/api-server/src/test/sensingContributionPolicy.test.ts",
    "artifacts/api-server/src/test/sensingContributionSession.test.ts",
    "artifacts/api-server/src/test/sensingDifferencingGate.test.ts",
    "artifacts/api-server/src/test/sensingPresenceState.test.ts",
    "artifacts/api-server/src/test/sensingReplayAndTimeBounds.test.ts",
    "artifacts/api-server/src/test/sensingRevocationLineage.test.ts",
    "artifacts/api-server/src/test/sensingSubjectReconciliation.test.ts",
    "artifacts/api-server/src/test/vibeInference.test.ts",
    "artifacts/api-server/src/test/experienceTruth.test.ts",
    "artifacts/api-server/src/test/truthClass.test.ts",
    "artifacts/api-server/src/test/mapExperienceState.test.ts",
    "artifacts/api-server/src/test/mapWorldMoments.test.ts",
    "artifacts/api-server/src/test/mapDisplayResolver.test.ts",
    "artifacts/api-server/src/test/mapSensingProjectionGates.test.ts",
    "artifacts/api-server/src/test/discoveryCandidate.test.ts",
    "artifacts/api-server/src/test/wallTruthClass.test.ts",
    "artifacts/api-server/src/test/compassCensusGates.test.ts",
    "artifacts/api-server/src/test/sensingCensusRederivation.test.ts",
    "artifacts/api-server/src/test/db/sensingAnonStore.db.test.ts",
    "docs/architecture/sensing-s0-reuse-map.md",
    // WIDENED 2026-09-12 (census-sensing §2): the §10 decision surface.
    "artifacts/api-server/src/lib/compassDecision.ts",
    "artifacts/api-server/src/routes/compassDecision.ts",
    "artifacts/api-server/src/migrations/2800_compass_decision_flag.sql",
    "db/rollback/2026-09-12-2800-compass-decision-flag-rollback.sql",
    "artifacts/api-server/src/test/compassDecision.test.ts",
    "artifacts/api-server/src/test/compassDecisionRoute.test.ts",
    // WIDENED 2026-09-12 (census-sensing §3): the §9 moments and the §15 engine.
    "artifacts/api-server/src/lib/liveEnvelopeTruth.ts",
    "artifacts/api-server/src/lib/wallMoments.ts",
    "artifacts/api-server/src/lib/attentionEngine.ts",
    "artifacts/api-server/src/lib/wallMomentRead.ts",
    "artifacts/api-server/src/routes/wallMoments.ts",
    "artifacts/api-server/src/migrations/2801_wall_moments_flag.sql",
    "db/rollback/2026-09-12-2801-wall-moments-flag-rollback.sql",
    "artifacts/api-server/src/test/wallMoments.test.ts",
    "artifacts/api-server/src/test/attentionEngine.test.ts",
    "artifacts/api-server/src/test/wallMomentsRoute.test.ts",
    "artifacts/api-server/src/services/notifications/NotificationPreferenceService.ts",
    // WIDENED 2026-09-12 (census-sensing §4): §12's canonical live references.
    "artifacts/api-server/src/lib/liveReference.ts",
    "artifacts/api-server/src/lib/liveReferenceMessages.ts",
    "artifacts/api-server/src/routes/telegraphLiveReferences.ts",
    "artifacts/api-server/src/migrations/2802_telegraph_live_references_flag.sql",
    "db/rollback/2026-09-12-2802-telegraph-live-references-flag-rollback.sql",
    "artifacts/api-server/src/test/liveReference.test.ts",
    "artifacts/api-server/src/test/telegraphLiveReferencesRoute.test.ts",
    "artifacts/api-server/src/test/db/telegraphLiveReferences.db.test.ts",
    // WIDENED 2026-09-12 (census-sensing §5): §16's safety candidate stage.
    "artifacts/api-server/src/lib/safetyCandidate.ts",
    "artifacts/api-server/src/lib/safetyCandidateStore.ts",
    "artifacts/api-server/src/routes/adminSafetyCandidates.ts",
    "artifacts/api-server/src/migrations/2803_intel_safety_candidates_flag.sql",
    "db/rollback/2026-09-12-2803-intel-safety-candidates-flag-rollback.sql",
    "artifacts/api-server/src/test/safetyCandidate.test.ts",
    "artifacts/api-server/src/test/adminSafetyCandidatesRoute.test.ts",
    "artifacts/api-server/src/test/db/safetyCandidate.db.test.ts",
    // WIDENED 2026-09-12 (census-sensing §7): §8's live ranking layer, §11's
    // layover intersection, and routes/mapObservations.ts — which §7.2 cites
    // five times as the object that moves S97 back to W. A census that grades a
    // file for doing the forbidden thing must age when that file changes.
    "artifacts/api-server/src/lib/discoveryLiveRank.ts",
    "artifacts/api-server/src/lib/discoveryLiveRankRead.ts",
    "artifacts/api-server/src/lib/layoverLiveIntersection.ts",
    "artifacts/api-server/src/routes/mapObservations.ts",
    "artifacts/api-server/src/services/airport/LayoverRecommendationService.ts",
    "artifacts/api-server/src/migrations/2850_discovery_live_rank_flag.sql",
    "artifacts/api-server/src/migrations/2851_layover_live_intersection_flag.sql",
    "db/rollback/2026-09-12-2850-discovery-live-rank-flag-rollback.sql",
    "db/rollback/2026-09-12-2851-layover-live-intersection-flag-rollback.sql",
    "artifacts/api-server/src/test/discoveryLiveRank.test.ts",
    "artifacts/api-server/src/test/discoveryLiveRankRoute.test.ts",
    "artifacts/api-server/src/test/layoverLiveIntersection.test.ts",
    // WIDENED 2026-09-12 (census-sensing §6): §5's Crowd and Forecast objects,
    // §18.1's context kernel and §6's opportunity stage — the files §6 grades
    // S40, S45, S46, S55, S56 and S110 on.
    "artifacts/api-server/src/lib/crowdState.ts",
    "artifacts/api-server/src/lib/forecastState.ts",
    "artifacts/api-server/src/lib/contextKernel.ts",
    "artifacts/api-server/src/lib/contextKernelRead.ts",
    "artifacts/api-server/src/lib/opportunityEngine.ts",
    "artifacts/api-server/src/routes/opportunities.ts",
    "artifacts/api-server/src/migrations/2840_opportunity_engine_flag.sql",
    "db/rollback/2026-09-12-2840-opportunity-engine-flag-rollback.sql",
    "artifacts/api-server/src/test/crowdForecastState.test.ts",
    "artifacts/api-server/src/test/opportunityEngine.test.ts",
    "artifacts/api-server/src/test/opportunitiesRoute.test.ts",
    // WIDENED 2026-09-12 (census-sensing §6.5): §5.4's ExperienceSession
    // bridge — the files §6.6 grades S54 on, plus the canonical spine whose
    // one new allow-listed payload key the bridge rides.
    "artifacts/api-server/src/lib/experienceSession.ts",
    "artifacts/api-server/src/lib/experienceSessionStore.ts",
    "artifacts/api-server/src/lib/canonicalEvents.ts",
    "artifacts/api-server/src/routes/experienceSessions.ts",
    "artifacts/api-server/src/migrations/2841_experience_session_flag.sql",
    "db/rollback/2026-09-12-2841-experience-session-flag-rollback.sql",
    "artifacts/api-server/src/test/experienceSession.test.ts",
    "artifacts/api-server/src/test/experienceSessionsRoute.test.ts",
  ],
  "census-compass.md": [
    // B8, 2026-09-14: three modules census-compass grades and did not watch.
    // `src/compass/` below covers the engines that live under that directory;
    // these three do not live there, so the trailing-slash entry never reached
    // them and a change to any of the three aged nothing.
    "artifacts/api-server/src/lib/contextKernel.ts",
    "artifacts/api-server/src/lib/opportunityEngine.ts",
    "artifacts/api-server/src/routes/opportunities.ts",
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
    // ADDED 2026-09-13 (§11): CX-04 and CH-03 are C because of what this file
    // asserts, so an edit to it must age the census that rests on it.
    "artifacts/api-server/src/test/compassCensusCorrectness.test.ts",
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
    // WIDENED 2026-09-13 by census-compass §10. Nine of that section's eleven
    // row moves rest on files this census did not watch, which is exactly how
    // it came to state CX-03/CX-05/CT-02/CT-08/CT-10/CT-11/CL-02/CL-06/CL-07/
    // CTG-05 against a tree that had already built them. A row is only as fresh
    // as the files its evidence cites.
    "artifacts/api-server/src/routes/compassDecision.ts",
    "artifacts/api-server/src/lib/compassDecision.ts",
    "artifacts/api-server/src/domain/trips/projections/TripCompassProjection.ts",
    "artifacts/api-server/src/domain/trips/policies/TripAttentionFilter.ts",
    "artifacts/api-server/src/domain/trips/policies/tripOperationalProjections.ts",
    "artifacts/api-server/src/domain/trips/services/TripValueOfInformation.ts",
    "artifacts/api-server/src/domain/trips/services/TripRescue.ts",
    "artifacts/api-server/src/services/airport/LayoverFeasibility.ts",
    "artifacts/api-server/src/test/layoverPrivacyCompassContract.test.ts",
    "artifacts/api-server/src/test/compassToolCountContract.test.ts",
    // WIDENED 2026-09-13 by the integration owner. Section 13 regraded this census
    // against docs/compass/master-roadmap.md and compass-phase1-spec.md, and the new
    // rows cite the programme's own files — the classifier, the conversation service,
    // the prompt module, the eval script, the conversation migrations. Coverage was
    // 73% against a 96% floor. A census must watch what it cites, or it reports FRESH
    // about the wrong half.
    "artifacts/api-server/src/test/compass-ask.test.ts",
    "artifacts/api-server/src/lib/prompts/compass-v1.ts",
    "artifacts/api-server/src/test/compass-ui-blocks.test.ts",
    "scripts/src/compass-answer-quality-eval.mjs",
    // Added 2026-09-13 with §14: the eval's acceptance criteria and their
    // tests. CPH-EVAL is graded on whether a run can produce a verdict, so a
    // change to what decides that verdict must age this census.
    "scripts/src/compass-eval-criteria.mjs",
    "scripts/src/compass-eval-criteria.test.mjs",
    "artifacts/api-server/src/services/compass/CompassIntentClassifier.ts",
    "artifacts/api-server/src/services/compass/CompassConversationService.ts",
    "artifacts/api-server/src/test/compass-autopilot.test.ts",
    "artifacts/api-server/src/migrations/20260723_compass_conversations.sql",
    "artifacts/api-server/src/migrations/20260729_compass_outcome_learning.sql",
    "artifacts/api-server/src/migrations/2800_compass_decision_flag.sql",
    "artifacts/api-server/src/test/compassRevocationAndAvailability.test.ts",
    "artifacts/api-server/src/routes/experienceSessions.ts",
    "artifacts/api-server/src/domain/trips/services/TripSignals.ts",
    "artifacts/api-server/src/lib/experienceSession.ts",
    "artifacts/api-server/src/lib/liveClaimRead.ts",
    "artifacts/api-server/src/test/circle.test.ts",
    "artifacts/api-server/src/test/compassTelegraph.test.ts",
    "artifacts/api-server/src/test/memoryPassportRemembers.test.ts",
    "artifacts/api-server/src/test/discoveryCandidate.test.ts",
    "artifacts/api-server/src/test/compassSafetyFilter.test.ts",
    "artifacts/api-server/src/services/media/MyWorldMemoryService.ts",
    "artifacts/api-server/src/lib/intelCoverageScheduler.ts",
    "artifacts/api-server/src/lib/experienceTruth.ts",
    "artifacts/api-server/src/test/compassMemoryClientBoundary.test.ts",
    "artifacts/api-server/src/test/compass-tools.test.ts",
  ],
  // Input Intelligence is the thinnest-citing of the six (36 of 81 backticked
  // paths resolve) and the most client-weighted: its subject is the typing
  // surface, so the hooks ARE the measurement, not evidence about it.
  "census-input-intelligence.md": [
    // ── ADDED 2026-09-14 by the scope-coverage finding ──────────────────────
    // `app/_layout.tsx` is the one line §12.6 says four rows wait on, so a
    // change to it is exactly the change that must age this census.
    "travel-buddy-standalone/app/_layout.tsx",
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    "artifacts/api-server/src/services/media/MediaProjectionService.ts",
    // ADDED 2026-09-14 on the lane's request: the telemetry-funnel component test
    // now carries the §51 funnel rows' evidence. Its own measurement was that
    // coverage lands at 98.2% once its three new files are tracked — clearing a
    // 98% floor with almost nothing to spare — and this line takes it to 99%.
    "travel-buddy-standalone/src/platform/input-assistance/components/__tests__/inputTelemetryFunnel.component.test.tsx",
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
    // WIDENED 2026-09-13 by §8 (Phase 9). A census must watch what it CITES, and
    // §8.3/§8.4 cite these four as the evidence for seven moved rows. The first is
    // already covered by the lib/inputAssistance/ directory entry above and is named
    // here only so a reader of this list can see the whole Phase-9 surface in one
    // place; the other three are genuinely new paths.
    "artifacts/api-server/src/lib/inputAssistance/rankingSignals.ts",
    "travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/suggestionBadges.ts",
    "artifacts/api-server/src/test/inputAssistanceRankingSignals.test.ts",
    "artifacts/api-server/src/test/inputAssistanceFieldInventory.test.ts",
    // WIDENED 2026-09-13 by §9 (Phase 10). Same rule as §8's widening: a census
    // must watch what it CITES, and §9 cites these three as the evidence for six
    // moved rows. `lib/inputAssistance/semanticParser.ts` is not repeated here —
    // the directory entry at the top of this list already covers it — but its
    // test file was unwatched, which meant the §18 sequence-operator proof could
    // have been deleted without ageing this census.
    "artifacts/api-server/src/test/inputAssistanceSemanticIntent.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionAccessibility.component.test.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx",
    // §9.4 cites this migration as the evidence that the §35 selection-memory
    // table is written and unapplied. It is THIS lane's migration, so it is
    // watched by name — the same treatment 2220 already gets, and for the same
    // reason. The Map / Passport / Wall telemetry migrations §9.4 also names are
    // deliberately NOT here: they are other lanes' files, and watching them would
    // age this census every time those lanes touch their own telemetry.
    "artifacts/api-server/src/migrations/2258_input_selection_history.sql",
  ],
  "census-discovery.md": [
    // ── ADDED 2026-09-15 by §43: the registry B05 now rests on ──────────────
    //
    // §43 moves B05 W -> C, and the whole of its argument is that the canonical
    // country registry Discovery needs already exists as pure data in this
    // package. `lib/countryCodes.ts` is therefore a file this census GRADES —
    // its ISO table, its alias index and `searchCountryRegistry`'s rung order
    // are B05's evidence — and a census that grades a file it does not watch has
    // a verdict that rots silently. It is watched here rather than left to the
    // stamps lane that happens to have consumed it first.
    //
    // The suite is watched on `censusDigitPrefixIds.test.ts`'s precedent: B05's
    // `C` rests on what those 20 cases assert, including the two ordering rules
    // (§43.3) that no other test in the tree covers, so an edit to it must age
    // this census.
    //
    // WHAT WOULD TURN THIS RED: a commit touching either while census-discovery
    // still declares an older head_commit. Before this widening such a commit
    // was silent — and `lib/countryCodes.ts` is the kind of shared, unowned data
    // module that gets edited by whichever lane needs a country name next.
    "artifacts/api-server/src/lib/countryCodes.ts",
    "artifacts/api-server/src/test/discoveryCountryRegistry.test.ts",
    //
    // ── AND THE FIVE CONSUMERS §43.3's BLAST-RADIUS CLAIM NAMES ─────────────
    //
    // The coverage floor caught this section at 93 % against 96 %, correctly:
    // §43.3 widened `toCountryCode`, which is SHARED, and then made a claim
    // ABOUT the code that consumes it — "four call sites outside Discovery, and
    // the four country suites were run, 76 tests, 0 failures". A sentence of
    // this census is therefore a statement about these files, on the same rule
    // that already watches `SOURCE-MANIFEST.json` and `compliance-ledger.json`
    // here: a claim about a file is aged by that file changing.
    //
    // `xxCatalogRepair.ts` is the fifth and it is not a call site. It is the
    // machinery §43.3's SAFETY argument leans on — the widening is safe partly
    // because an `XX` catalog key that becomes resolvable is carried to its real
    // code by that sweeper. If it stops doing so, the argument is stale.
    //
    // THE COST, STATED RATHER THAN BURIED (§36.5's rule). census-discovery now
    // ages whenever the stamps lane edits its own country handling, and that is
    // a lane whose work has nothing to do with Discovery. The alternative was to
    // stop naming the files, which would have made the blast-radius claim
    // unfalsifiable while keeping the percentage green — the one trade this
    // floor exists to refuse.
    "artifacts/api-server/src/lib/entryRequirements.ts",
    "artifacts/api-server/src/lib/stampHelper.ts",
    "artifacts/api-server/src/lib/stamps/countryLookup.ts",
    "artifacts/api-server/src/lib/stamps/StampCatalogService.ts",
    "artifacts/api-server/src/lib/stamps/xxCatalogRepair.ts",
    //
    // Pre-existing gap, closed in the same pass because the floor exposed it:
    // §42.1 and §42.2 rest on what `discoveryDiversityAxes.test.ts` asserts —
    // "E2 asserts an unsupplied `geoPenalty` leaves the order untouched", the
    // N1–N10 / P1–P5 pins on `neighborhoodMatch` — and nothing aged this census
    // when that suite changed. Same rule as `censusDigitPrefixIds.test.ts` and
    // the two client refusal suites below.
    "artifacts/api-server/src/test/discoveryDiversityAxes.test.ts",
    // ── ADDED 2026-09-15 by §33: the Layover door A13 is graded on ──────────
    //
    // §33 moves A13 N -> W on `services/airport/LayoverSnapshot.ts`, and §32
    // moves DV-01 W -> C on `lib/rankLog.ts`. A census that grades a file and
    // does not watch it has a verdict that rots silently — the whole point of
    // the coverage floor, which caught this at 95.5 % against a 96 % floor.
    //
    // `routes/airport.ts` is here because §33.5 records a near-twin created
    // rather than removed: its private `resolveAirportForSession` and the new
    // module's `resolveAirport` apply identical rules for the airport-row
    // lookup. If either is collapsed into the other, A13's evidence changes and
    // this census should age for it.
    //
    // `lib/featureFlags.ts` is cited for the property A13's flag rests on:
    // a missing row and an unreadable `feature_flags` BOTH read false, which is
    // how `layover_discovery_mode_enabled` is FALSE-seeded by absence rather
    // than by a migration.
    "artifacts/api-server/src/services/airport/LayoverSnapshot.ts",
    "artifacts/api-server/src/routes/airport.ts",
    "artifacts/api-server/src/lib/rankLog.ts",
    "artifacts/api-server/src/test/rankLogInsertErrors.test.ts",
    "artifacts/api-server/src/lib/featureFlags.ts",
    // ── ADDED 2026-09-15 by §28: DV-83's subject, and the migrations that
    //    falsified thirteen rows ────────────────────────────────────────────
    //
    // §28 did two things that each cite files this census was not watching, and
    // the coverage floor caught both — correctly, dropping this census to 88 %.
    //
    // (a) DV-83 is INVENTED in §28 and its subject is the CONSUMERS of the
    //     refusal envelope. A census that grades a file and does not watch it
    //     has a verdict that rots silently, which is the whole point of the
    //     floor. The envelope itself, its suite, and the two client components
    //     the row grades as NON-COMPLIANT are therefore watched here.
    //
    //     MapSearchSheet.tsx is a MAP component, and it is here deliberately.
    //     §25/§26's lesson was that citing eight other lanes' files makes this
    //     census claim code it does not grade — but DV-83 genuinely grades this
    //     one: it is the single consumer in the tree that surfaces `partial`
    //     unconditionally, and it is the exemplar the row's "what would turn it
    //     C" is written against. If its refusal handling changes, DV-83's
    //     verdict IS stale, and this census should be aged for it. That is the
    //     mechanism working, not a scope inversion.
    //
    // (b) §28.3 records thirteen rows whose stated blocker is FALSE at this
    //     tree, seven of them because migrations 2890-2893 were written with
    //     headers citing census rows BY LINE NUMBER and the rows were never
    //     re-derived back. Those migrations, 2910 and 2921 are now the evidence
    //     for what those rows actually say, so they are watched: the next edit
    //     to any of them should age this census rather than silently re-open
    //     the same gap. routes/trails.ts and services/trails/TrailService.ts
    //     are here for the same reason — they are what falsifies DV-18's
    //     "absent from the repository", and they carry the Trails rows.
    "artifacts/api-server/src/lib/discoveryRefusal.ts",
    "artifacts/api-server/src/test/discoveryRefusalD11.test.ts",
    "travel-buddy-standalone/src/components/discovery/DiscoveryEventPostsRail.tsx",
    "travel-buddy-standalone/src/components/discovery/ForYouTab.tsx",
    "travel-buddy-standalone/src/components/map/MapSearchSheet.tsx",
    "artifacts/api-server/src/migrations/2890_rank_events_behavior_engine_columns.sql",
    "artifacts/api-server/src/migrations/2891_rank_events_recommendation_id.sql",
    "artifacts/api-server/src/migrations/2892_place_momentum.sql",
    "artifacts/api-server/src/migrations/2893_rank_events_retire_writerless_surfaces.sql",
    "artifacts/api-server/src/migrations/2910_discovery_trails.sql",
    "artifacts/api-server/src/migrations/2921_creator_earning_entries.sql",
    "artifacts/api-server/src/routes/trails.ts",
    "artifacts/api-server/src/services/trails/TrailService.ts",
    // ── ADDED 2026-09-14, round 2 of the scope-coverage repair ──────────────
    // Found only because closing the first five raised the percentage and
    // exposed the next five. A coverage floor is a ratchet, not a checklist:
    // every batch you close makes the remainder a larger share of a smaller
    // gap, so it has to be run to fixpoint rather than once.
    "artifacts/api-server/src/services/telegraph/actionRegistry.ts",
    "artifacts/api-server/src/test/discoveryFeatureFamilyReach.test.ts",
    "artifacts/api-server/src/migrations/2850_discovery_live_rank_flag.sql",
    "artifacts/api-server/src/migrations/2289_discovery_ranking_modifiers_flag.sql",
    "artifacts/api-server/src/lib/discoveryTrailAffinity.ts",
    // ── ADDED 2026-09-14 by the scope-coverage finding ──────────────────────
    // Cited by this census and unwatched: the admin surface that carries the
    // engine-mode gate (3 citations), the two suites that prove its reach, and
    // the two migrations whose tables the creator-economy rows are graded on.
    "artifacts/api-server/src/routes/admin.ts",
    "artifacts/api-server/src/test/discoveryRouteRecommendationPropagation.test.ts",
    "artifacts/api-server/src/test/discoveryEngineModeAdminReach.test.ts",
    "artifacts/api-server/src/migrations/2290_intelligence_graph_node_kinds.sql",
    "artifacts/api-server/src/migrations/2170_intel_reward_ledger.sql",
    // ── B8, 2026-09-14: THE ELEVEN FILES THE DC ROWS ARE EVIDENCED BY ────────
    //
    // census-discovery §14.7 raised this against itself as cross-lane request
    // X2, and `docs/discovery/compliance-v1.md` §8 names the files. The lane
    // could not add them — checkCensus*.ts is a forbidden file for it — so it
    // did the only other honest thing available: it routed its DC-row anchors
    // into compliance-v1.md so that `check:census-scope-coverage` would keep
    // reporting 100 % rather than go red on citations the lane could not watch.
    // That is a census being careful, and it is also a blind spot: ten product
    // files carry DC verdicts and nothing ages the census when they change.
    //
    // TEN, NOT ELEVEN, AND THE MISSING ONE IS NAMED. X2's list ends with
    // `src/scripts/checkMigrationLedger.ts`. That is a guard script, which this
    // file's own convention and `checkCensusScopeCoverage.ts`'s NOT_GRADED list
    // both hold OUT of every census's scope: a census names its guard as the
    // thing that MEASURED it, never as a thing it grades, and watching it would
    // age census-discovery on every unrelated lane's guard work. It is also
    // already excluded from the coverage denominator, so leaving it out costs
    // this census no coverage. Excluding it is the convention, not a shortcut.
    //
    // WHAT WOULD TURN THIS RED: a commit touching any of the ten while
    // census-discovery still declares an older head_commit. That is the point —
    // before this widening such a commit was silent.
    "artifacts/api-server/src/services/ranking/rankingConfig.ts",
    "artifacts/api-server/src/services/ranking/DiscoveryRankingService.ts",
    "artifacts/api-server/src/services/ranking/FeedSlotAllocator.ts",
    "artifacts/api-server/src/compass/CompassFeedBuilder.ts",
    "artifacts/api-server/src/lib/discoveryLiveRank.ts",
    "artifacts/api-server/src/services/tagging/tagPolicy.ts",
    "artifacts/api-server/src/routes/wishlist.ts",
    "artifacts/api-server/src/migrations/0089_decrement_discovery_place_saved_count.sql",
    "artifacts/api-server/src/migrations/0168_discovery_cache_ddl.sql",
    "artifacts/api-server/src/migrations/2092_discovery_shadow_serves.sql",
    // B10, 2026-09-14 (§15). Two more this census now rests on.
    //
    // The test file pins the parse of §15.2's three rows; §15's whole arithmetic
    // rests on what it asserts, so an edit to it must age this census.
    "artifacts/api-server/src/test/censusDigitPrefixIds.test.ts",
    // The provenance note is the ONE file of the duplicate Discovery install
    // (§15.7, backlog B5) that has no byte-identical counterpart in the
    // directory that survives. It is watched here so that retiring
    // `docs/specs/discovery-v1/` without first moving this file fails loudly in
    // the scope-existence check above, instead of losing the only copy of a
    // note the owner's package carried. It is deliberately the doomed path and
    // not a copy: an entry that cannot survive the deletion is the interlock.
    "docs/specs/discovery-v1/00-PROVENANCE.md",
    // §15.7's "17 / 17 manifest entries resolve by content hash" is a claim
    // ABOUT this file. If an entry or a hash changes, that sentence ages.
    "docs/specs/upgrades-v2/SOURCE-MANIFEST.json",
    // ADDED 2026-09-14, second widening this session as the Discovery lane works.
    // Three consumers its rows are now evidenced by: Compass's feedback and
    // outcome engines — which is where a served candidate's fate is recorded, so
    // a change there can falsify a row about what Discovery learns — and the
    // media-independent-sources suite.
    "artifacts/api-server/src/compass/CompassFeedbackEngine.ts",
    "artifacts/api-server/src/compass/CompassOutcomeEngine.ts",
    "artifacts/api-server/src/test/mediaIndependentSources.test.ts",
    // WIDENED 2026-09-14. The Discovery lane's four new modules and the suites
    // its rows are evidenced by. A verdict whose evidence names a file nothing
    // watches has an unmonitored floor under it — and these four are NEW code
    // this census now grades, not incidental references.
    "artifacts/api-server/src/lib/discoveryRankProvenance.ts",
    "artifacts/api-server/src/lib/discoveryReasonCodes.ts",
    "artifacts/api-server/src/lib/discoveryStopConditions.ts",
    "artifacts/api-server/src/lib/discoveryTrendState.ts",
    "artifacts/api-server/src/test/discoveryShadow.test.ts",
    "artifacts/api-server/src/test/discoveryNegativeSignalWriter.test.ts",
    "artifacts/api-server/src/test/discoveryLocalMomentum.test.ts",
    // Cited once by a cross-surface row; the Layover lane owns the file, this
    // census only grades what it reads from it.
    "artifacts/api-server/src/services/airport/__tests__/layoverPresenceDegraded.test.ts",
    // ── ADDED by the scope-coverage floor, after §18's consumer audit ─────────
    //
    // §18 graded the REFUSAL ENVELOPE'S CONSUMERS for the first time and found
    // four that render a refusal as an empty answer. Citing them dropped this
    // census to 95 % against a floor of 96 %, which is the floor working: the
    // census started grading a file nothing aged it on.
    //
    // `travel-buddy-standalone/src/services/discovery.ts` carries
    // `getDiscoveryCategoryCounts`, which writes a fabricated `0` badge when the
    // count read refuses. C14's verdict now rests on what that file does, so a
    // change to it must age this census.
    "travel-buddy-standalone/src/services/discovery.ts",
    // ── ADDED by the scope-coverage floor after §19 ──────────────────────────
    //
    // §19 closed two of §18's four consumer defects and NAMED THE OTHER TWO so
    // they are not reported as closed. Naming them is citing them, and citing a
    // file this census does not watch is what dropped coverage below the floor —
    // the floor working, again, in the same section that fixed the last one.
    //
    // `app/map/index.tsx` carries the unfixed defect §19.6 names: a refusal takes
    // the `ok` branch with `places: []`, clears the pins, and the screen renders
    // "no places here" for an outage. A row that says a defect is OPEN is aged by
    // the file being fixed, which is exactly when this census should wake up.
    "travel-buddy-standalone/app/map/index.tsx",
    //
    // The executable half of §19.1. C14's `C` rests on what this suite asserts,
    // so an edit to it must age the census — the rule this list already applies
    // to `censusDigitPrefixIds.test.ts` for §15's arithmetic.
    "travel-buddy-standalone/src/hooks/__tests__/useSearchSuggestions.refusal.component.test.tsx",
    // And the executable half of §19.2, by the same rule.
    "travel-buddy-standalone/src/services/__tests__/discovery.refusal.component.test.tsx",
    //
    // §17.6's defect is IN this generator, and §17.6's sentences are claims about
    // what it now produces ("187 requirements, identical on three consecutive
    // runs"). `censusDumpCompleteness.test.ts` is the pin for the upstream half
    // of the same defect — the dump this generator reads — and §25 of
    // census-telegraph showed that pin was itself blind to the shell-pipeline
    // case. Both are watched so the next change to either ages the claims.
    "artifacts/api-server/src/scripts/buildDiscoveryLedger.ts",
    "artifacts/api-server/src/test/censusDumpCompleteness.test.ts",
    //
    // The ledger is watched on the SOURCE-MANIFEST.json precedent above: §17.6's
    // sentences are claims ABOUT this file ("rebuilds to 187 requirements,
    // C=76 W=85 N=23 X=3"), so an entry or a count changing falsifies them. It
    // is a generated artifact, and that is exactly why — a generated record that
    // nothing ages is how §17.6's defect stayed invisible in the first place.
    "docs/discovery/compliance-ledger.json",
    // WIDENED 2026-09-13 with A20's new evidence. That row was re-measured N → W
    // because the Telegraph §1–§11 lane published the content capability
    // contract A20 said did not exist, and a row is only as fresh as the files
    // its evidence names — so the two it now names are watched.
    "artifacts/api-server/src/services/telegraph/shareables.ts",
    "travel-buddy-standalone/src/features/telegraph/sharing/useShareRevocation.ts",
    "artifacts/api-server/src/routes/discovery.ts",
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/lib/discoveryCandidate.ts",
    "artifacts/api-server/src/lib/discoveryPde.ts",
    "artifacts/api-server/src/lib/discoveryShadow.ts",
    "artifacts/api-server/src/lib/discoveryServeLog.ts",
    "artifacts/api-server/src/lib/discoveryModifiers.ts",
    "artifacts/api-server/src/lib/discoveryTripProjectionConsumer.ts",
    // The contracts the A-rows wait on, so publishing one ages this census.
    "artifacts/api-server/src/domain/trips/contracts/tripDiscoveryProjection.ts",
    "artifacts/api-server/src/lib/inputAssistance/",
    // WIDENED 2026-09-11: cited 49 files, watched 11 (22%). Same exclusions.
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    // ADDED 2026-09-13 (§10): A15 is C because of what this file asserts about
    // the shared list-identity projection, so an edit to it must age this census.
    "artifacts/api-server/src/test/passportListIdentityProjection.test.ts",
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
    // ADDED 2026-09-15 by §38. All three are this census's own SUBJECT --
    // Discovery libraries built by Discovery rows (A14, DC-09) and cited by them --
    // so the checker's other response, "say they are not what this census grades",
    // would be false. Watching them is the honest one.
    // ADDED 2026-09-15 by §39. Discovery's OWN tests, plus the capability
    // reader A14 now reads its flag through -- all three are this census's
    // subject. The two other-lane files §39 still names (the Layover travel-time
    // port, the Trips add-to-plan route) are deliberately NOT added: §26 ruled
    // that watching another census's code ages this one every time that lane
    // touches a file it has no opinion about, and the fix there was to name
    // OWNERS rather than paths -- which §39 now does for the rest.
    "artifacts/api-server/src/test/discoveryCuratedSourceRefusal.test.ts",
    "artifacts/api-server/src/test/discoveryLiveRankRoute.test.ts",
    "artifacts/api-server/src/lib/capability/schemaCapability.ts",
    "artifacts/api-server/src/lib/discoveryLayoverMode.ts",
    "artifacts/api-server/src/lib/discoveryLayoverTiming.ts",
    "artifacts/api-server/src/lib/discoverySequenceFeatures.ts",
    "travel-buddy-standalone/src/hooks/useCommunityDiscovery.ts",
    "artifacts/api-server/src/migrations/2360_discovery_buddy_launch_gate_flag.sql",
    "artifacts/api-server/src/test/discoverySearch.test.ts",
    "artifacts/api-server/src/migrations/2361_discovery_candidate_projection_flag.sql",
    "db/rollback/2026-09-07-2361-discovery-candidate-projection-rollback.sql",
    // WIDENED 2026-09-13 by census-discovery §9. A20 moved W → C on the sixth
    // capability being registered through the share contract, and that
    // registration lives in the two files below; A01 and A11 moved N → W on
    // readers this census did not watch either. The search route is named
    // because A20's C rests on the sixth capability being REACHED, not merely
    // declared — if that route is retired the verdict is wrong again.
    "artifacts/api-server/src/domain/telegraph/contracts/conversationSearch.ts",
    "artifacts/api-server/src/test/telegraphSearchCapability.test.ts",
    "artifacts/api-server/src/server/telegraph/searchRoute.ts",
    "artifacts/api-server/src/lib/discoveryLiveRankRead.ts",
    "artifacts/api-server/src/domain/trips/services/TripFreedomConsumers.ts",
    "artifacts/api-server/src/domain/trips/policies/tripOperationalProjections.ts",
    // WIDENED 2026-09-13 by the integration owner, for section 11's regrade against
    // the restored Discovery Architecture v1 package. Coverage was 85% against a 96%
    // floor.
    "artifacts/api-server/src/routes/rankEvents.ts",
    "artifacts/api-server/src/migrations/2298_dead_check_vocabularies.sql",
    "artifacts/api-server/src/lib/discoveryDivergenceReport.ts",
    "artifacts/api-server/src/test/discoveryServeLog.test.ts",
    "artifacts/api-server/src/migrations/20260730_compass_intelligence_graph.sql",
    "artifacts/api-server/src/migrations/2254_schema_migration_ledger.sql",
    "travel-buddy-standalone/src/features/map/intent/intentModel.ts",
    "artifacts/api-server/src/lib/discoveryCacheEligibility.ts",
    "artifacts/api-server/src/test/discoveryCacheBEligibility.test.ts",
  ],
  // ── ADDED 2026-09-15: census-passport joins the CHECKABLE set ──────────────
  //
  // For as long as this table has existed, census-passport.md had NO entry
  // here, and the omission was deliberate and self-documenting: §13.7 of that
  // document names this very file, and says a head_commit declared without a
  // scope would move the census from "no head_commit declared — CANNOT BE
  // CHECKED" to "declares one but has no scope — CANNOT BE CHECKED". Both are
  // reported by name and neither is a pass. So the two halves had to land
  // together, and they do: the declaration is in census-passport.md §18 and the
  // scope is here.
  //
  // HOW THIS LIST WAS DERIVED, because a hand-picked scope is the defect
  // checkCensusScopeCoverage.ts exists to catch. It is the set of repo files
  // census-passport.md CITES, extracted with that checker's own CITE_RE and
  // resolved with its own resolution rule, minus the machinery
  // NOT_GRADED excludes (its guard scripts and package.json). Nothing was added
  // because it felt in scope and nothing was dropped because it was
  // inconvenient. Two deliberate additions on top of the mechanical set, both
  // stated so they can be argued with:
  //
  //   (1) SIX AMBIGUOUS BASENAMES, resolved by hand. `routes/passport.ts`,
  //       `UnifiedStampService.ts`, `StampAwardEngine.ts`, `routes/follows.ts`
  //       and `PassportHero.tsx` each match TWO files, because this repository
  //       carries stray staging copies under `files/`, `follows-backend/` and
  //       `portava-stamp-wave3-files/`. checkCensusScopeCoverage refuses to
  //       guess and counts them as neither covered nor uncovered, so they cost
  //       no coverage either way — but leaving the LIVE `routes/passport.ts`
  //       unwatched would be a Passport census that does not watch the Passport
  //       route, which is the §12.5 hole in miniature. The live path is the one
  //       under artifacts/api-server/ or travel-buddy-standalone/; the staging
  //       copies are not listed.
  //   (2) `travel-buddy-standalone/src/components/PassportStamps.tsx` and
  //       `PassportStampCard.tsx`, the copies §16 re-cites for P66 after line
  //       302 cited the repo-root pair. Both pairs are watched — see the note
  //       on the root pair at the foot of this entry.
  //
  // NEVER THE ACKNOWLEDGEMENT LEDGER, and never a guard script: the regress at
  // the head of this table, and the NOT_GRADED convention in
  // checkCensusScopeCoverage.ts. census-passport.md cites
  // checkCensusFreshness.ts and checkWriterlessReads.ts as the things that
  // MEASURED it; scoping either would age this census on every unrelated lane's
  // guard work, and this very commit edits one of them.
  //
  // WHAT THIS DOES NOT DO: it does not re-grade anything, and it does not make
  // any verdict more likely to be right. It makes a change to a graded file
  // AUDIBLE. §18.4 of the census records what is still not certified.
  "census-passport.md": [
    // The Passport services themselves — the supply side every C verdict cites.
    "artifacts/api-server/src/services/passport/EventPassportService.ts",
    "artifacts/api-server/src/services/passport/OpenToPlansService.ts",
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    "artifacts/api-server/src/services/passport/PassportJourneyService.ts",
    "artifacts/api-server/src/services/passport/PassportMapService.ts",
    "artifacts/api-server/src/services/passport/PassportMemoryService.ts",
    "artifacts/api-server/src/services/passport/PassportPrivacyGuard.ts",
    "artifacts/api-server/src/services/passport/PassportProjectionService.ts",
    "artifacts/api-server/src/services/passport/PassportReputationService.ts",
    "artifacts/api-server/src/services/passport/PassportStampService.ts",
    "artifacts/api-server/src/services/passport/PassportTravelIdentityService.ts",
    "artifacts/api-server/src/services/passport/PassportYearbookService.ts",
    "artifacts/api-server/src/services/passport/SharedContextService.ts",
    "artifacts/api-server/src/services/passport/StampAwardEngine.ts",
    "artifacts/api-server/src/services/passport/UnifiedStampService.ts",
    // Trust: §9/§10 are graded here, and the neutral-50 defect P-rows rest on lives in these three.
    "artifacts/api-server/src/services/trust/TrustAdminService.ts",
    "artifacts/api-server/src/services/trust/TrustEventService.ts",
    "artifacts/api-server/src/services/trust/TrustPrivacyGuard.ts",
    "artifacts/api-server/src/services/trust/TrustScoreService.ts",
    // Server routes and libs the rows cite as consumers, producers or counter-examples.
    "artifacts/api-server/src/compass/CompassTools.ts",
    "artifacts/api-server/src/lib/discoveryModifiers.ts",
    "artifacts/api-server/src/lib/discoveryPde.ts",
    "artifacts/api-server/src/lib/mapTravelers.ts",
    "artifacts/api-server/src/lib/passportTelemetry.ts",
    "artifacts/api-server/src/routes/adminStamps.ts",
    "artifacts/api-server/src/routes/airport.ts",
    "artifacts/api-server/src/routes/availability.ts",
    "artifacts/api-server/src/routes/compass.ts",
    "artifacts/api-server/src/routes/discovery.ts",
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/routes/follows.ts",
    "artifacts/api-server/src/routes/geofence.ts",
    "artifacts/api-server/src/routes/hiddenGems.ts",
    "artifacts/api-server/src/routes/location.ts",
    "artifacts/api-server/src/routes/mapProjection.ts",
    "artifacts/api-server/src/routes/mapTravelers.ts",
    "artifacts/api-server/src/routes/passport.ts",
    "artifacts/api-server/src/routes/rentABuddy.ts",
    "artifacts/api-server/src/routes/safeReturn.ts",
    "artifacts/api-server/src/routes/sharedMoments.ts",
    "artifacts/api-server/src/routes/telegraph.ts",
    "artifacts/api-server/src/routes/trips.ts",
    // Other server surfaces a row grades: memory participant visibility (P77's blocker), telegraph and appeals shared context, interaction permissions, the airport engine P-rows cite for contrast.
    "artifacts/api-server/src/services/airport/LayoverSafetyEngine.ts",
    "artifacts/api-server/src/services/appeals/resolveAppeal.ts",
    "artifacts/api-server/src/services/interactionPermissions.ts",
    "artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts",
    "artifacts/api-server/src/services/telegraph/sharedContext.ts",
    // Migrations a row cites as the storage its verdict turns on.
    "artifacts/api-server/src/migrations/0166_feature_flags_reconcile.sql",
    "artifacts/api-server/src/migrations/0198_place_contributor_stamps.sql",
    "artifacts/api-server/src/migrations/20260730_compass_intelligence_graph.sql",
    "artifacts/api-server/src/migrations/2290_intelligence_graph_node_kinds.sql",
    "artifacts/api-server/src/migrations/2309_passport_stamp_type_vocabulary.sql",
    // The server suites that PIN the C verdicts.
    "artifacts/api-server/src/test/compass-social.test.ts",
    "artifacts/api-server/src/test/mapTravelers.test.ts",
    "artifacts/api-server/src/test/passportMapPresence.test.ts",
    "artifacts/api-server/src/test/passportProjection.test.ts",
    "artifacts/api-server/src/test/passportTrustConfidenceBasis.test.ts",
    "artifacts/api-server/src/test/trustEventCoverage.test.ts",
    "artifacts/api-server/src/test/trustStampVerified.test.ts",
    // The client half. A route with no screen is not a built requirement, and more than half of this census's rows are graded on a component.
    "travel-buddy-standalone/app/passport/journeys.tsx",
    "travel-buddy-standalone/app/passport/my-world.tsx",
    "travel-buddy-standalone/app/passport/plans.tsx",
    "travel-buddy-standalone/app/passport/shared-context.tsx",
    "travel-buddy-standalone/app/passport/travel-identity.tsx",
    "travel-buddy-standalone/app/passport/yearbook.tsx",
    "travel-buddy-standalone/scripts/check-test-mocks.mjs",
    "travel-buddy-standalone/src/components/MemoriesTab.tsx",
    "travel-buddy-standalone/src/components/PassportHero.tsx",
    "travel-buddy-standalone/src/components/PassportStampCard.tsx",
    "travel-buddy-standalone/src/components/PassportStamps.tsx",
    "travel-buddy-standalone/src/components/PassportVerificationStamp.tsx",
    "travel-buddy-standalone/src/components/StampCard.tsx",
    "travel-buddy-standalone/src/components/StampDetailArtwork.tsx",
    "travel-buddy-standalone/src/components/passport/AvailabilityChip.tsx",
    "travel-buddy-standalone/src/components/passport/PassportHomePreviews.tsx",
    "travel-buddy-standalone/src/components/passport/PassportIdentityCard.tsx",
    "travel-buddy-standalone/src/components/passport/PassportQuickLinks.tsx",
    "travel-buddy-standalone/src/components/passport/PassportStampCollection.tsx",
    "travel-buddy-standalone/src/components/passport/TravelerStateChip.tsx",
    "travel-buddy-standalone/src/components/passport/__tests__/PassportRatifiedIdentity.decision.component.test.ts",
    "travel-buddy-standalone/src/components/stamps/StampDetailModal.tsx",
    "travel-buddy-standalone/src/components/ui/VerifiedStamp.tsx",
    "travel-buddy-standalone/src/features/passport/AvailabilityScreen.tsx",
    "travel-buddy-standalone/src/features/passport/ContributionCard.tsx",
    "travel-buddy-standalone/src/features/passport/EventPassportScreen.tsx",
    "travel-buddy-standalone/src/features/passport/JourneysScreen.tsx",
    "travel-buddy-standalone/src/features/passport/MyWorldScreen.tsx",
    "travel-buddy-standalone/src/features/passport/PassportQrSheet.tsx",
    "travel-buddy-standalone/src/features/passport/PlansScreen.tsx",
    "travel-buddy-standalone/src/features/passport/SharedContextScreen.tsx",
    "travel-buddy-standalone/src/features/passport/TravelIdentityScreen.tsx",
    "travel-buddy-standalone/src/features/passport/TripInvitePickerSheet.tsx",
    "travel-buddy-standalone/src/features/passport/TrustScreen.tsx",
    "travel-buddy-standalone/src/features/passport/YearbookScreen.tsx",
    "travel-buddy-standalone/src/features/passport/__tests__/JourneysScreen.component.test.tsx",
    "travel-buddy-standalone/src/features/passport/__tests__/MyWorldScreen.component.test.tsx",
    "travel-buddy-standalone/src/features/passport/__tests__/TrustDomainsFromServer.component.test.tsx",
    "travel-buddy-standalone/src/features/passport/installPassportTelemetry.ts",
    "travel-buddy-standalone/src/features/passport/passportNav.ts",
    "travel-buddy-standalone/src/features/passport/passportQrProjection.ts",
    "travel-buddy-standalone/src/features/passport/passportTelemetry.ts",
    "travel-buddy-standalone/src/features/passport/stampVerificationPresentation.ts",
    "travel-buddy-standalone/src/features/passport/useAvailabilityEditor.ts",
    "travel-buddy-standalone/src/features/passport/useContributions.ts",
    "travel-buddy-standalone/src/features/passport/usePassportPlans.ts",
    "travel-buddy-standalone/src/features/passport/usePassportWorld.ts",
    "travel-buddy-standalone/src/features/passport/useTravelIdentity.ts",
    "travel-buddy-standalone/src/features/passport/useTrustProjection.ts",
    "travel-buddy-standalone/src/features/passport/viewerActions.ts",
    "travel-buddy-standalone/src/hooks/usePassportProjection.ts",
    "travel-buddy-standalone/src/navigation/portavaRoutes.ts",
    "travel-buddy-standalone/src/services/passportProjection.ts",
    "travel-buddy-standalone/src/services/passportSharedContext.ts",
    "travel-buddy-standalone/src/services/passportStampMappers.ts",
    "travel-buddy-standalone/src/services/passportStamps.ts",
    "travel-buddy-standalone/src/theme/passportTokens.ts",
    "travel-buddy-standalone/src/utils/destinationGrouping.ts",
    // Repo-root staging copies of two stamp components. P66 cites these paths BY NAME (census-passport.md line 302) and they resolve, so they are what check:census-scope-coverage counts; §16 later re-cites the standalone copies, which are listed above. Both are watched rather than one chosen, because choosing would be this entry deciding which citation §16 superseded.
    "src/components/PassportStampCard.tsx",
    "src/components/PassportStamps.tsx",
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

// ── A SCOPE ENTRY NAMING NOTHING IS A BLIND SPOT THAT REPORTS AS FRESH ───────
//
// Everything below rests on `git diff -- <scope>`. A pathspec that matches no
// file is not an error to git: the diff simply comes back empty. So a scope
// entry with a typo, or one pointing at a file a later pass deleted or renamed,
// reports the census as FRESH about a file nothing is watching — the exact
// shape of vacuous green this whole script exists to refuse. Nothing checked
// the declaration itself until now.
//
// MEASURED BEFORE ADDING IT, 2026-09-14: all 1,315 entries then in CENSUS_SCOPE
// resolved, so this adds no pre-existing failure. It is a floor for what comes
// next, not a burn-down of what is here.
//
// A trailing-slash entry is a directory prefix and is checked as a directory.
// WHAT WOULD TURN THIS RED: adding a path with a typo, or deleting/renaming a
// watched file without editing this table. Both used to be silent.
{
  const dead: string[] = [];
  for (const [census, scope] of Object.entries(CENSUS_SCOPE)) {
    for (const p of scope) {
      if (!existsSync(join(REPO, p))) dead.push(`${census} -> ${p}`);
    }
  }
  if (dead.length > 0) {
    problems.push(
      `::error::CENSUS_SCOPE names ${dead.length} path(s) that do not exist in this tree:\n    ` +
        dead.join("\n    ") +
        `\n  git treats a pathspec matching nothing as an empty diff, so each of these reports its census ` +
        `FRESH while watching nothing at all. Fix the path, or delete the entry and say in the census what ` +
        `stopped being watched — a scope that names a missing file is worse than one that never named it, ` +
        `because it reads as coverage.`,
    );
  }
}

let checked = 0;
let stale = 0;
let unscoped = 0;
let undeclared = 0;
/**
 * Print every uncovered file instead of the first eight.
 *
 * The truncation is right for a normal run — eight names say "this census is
 * stale" without burying the verdict. It is wrong the moment somebody sits down
 * to CLOSE the finding, because the job is precisely to argue about each file by
 * name, and "…and 41 more" is the half that cannot be argued with. Measured
 * 2026-09-14: 235 uncovered file-census pairs across 12 censuses, of which the
 * default output names 96.
 */
const LIST_ALL = process.env.CENSUS_FRESHNESS_LIST === "1";

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
    // MEASURE THE TREE A COMMIT WOULD PRODUCE, NOT JUST HEAD.
    // `commit..head` cannot see staged or unstaged work, and that is not a
    // theoretical gap: on 2026-09-12 a three-lane Telegraph merge passed this
    // check as part of a 38-green local battery and failed the SAME check in CI
    // the moment it became a commit, on 26 files. The guard was right about the
    // commit; the gate had been run at the wrong moment, and nothing in the
    // output said so. Unioning the two working-tree diffs closes that: a
    // pre-commit run now measures what the commit will contain, and a clean
    // tree gives exactly the old answer, so CI is unaffected.
    const committed = git(["diff", "--name-only", `${commit}..${head}`, "--", ...scope]);
    const staged = git(["diff", "--name-only", "--cached", "--", ...scope]);
    const unstaged = git(["diff", "--name-only", "--", ...scope]);
    changed = [...new Set(
      [committed, staged, unstaged].flatMap((out) => out.split("\n")).filter(Boolean),
    )].sort();
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
        `${uncovered.length} counted file(s) changed that it does NOT name:\n    ${(LIST_ALL ? uncovered : uncovered.slice(0, 8)).join("\n    ")}` +
        (!LIST_ALL && uncovered.length > 8 ? `\n    …and ${uncovered.length - 8} more (CENSUS_FRESHNESS_LIST=1 prints them)` : "") +
        `\n  An acknowledgement silences the changes whose harmlessness it ARGUES, not every change that ` +
        `happens to follow it. Either name these files and say why they cannot have moved a verdict, or ` +
        `re-measure the census.`,
    );
    continue;
  }
  stale++;
  problems.push(
    `::error::${f} is STALE. It declares head_commit ${commit.slice(0, 8)}, and ${changed.length} file(s) it counts have ` +
      `changed since:\n    ${(LIST_ALL ? changed : changed.slice(0, 8)).join("\n    ")}` +
      (!LIST_ALL && changed.length > 8 ? `\n    …and ${changed.length - 8} more (CENSUS_FRESHNESS_LIST=1 prints them)` : "") +
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
