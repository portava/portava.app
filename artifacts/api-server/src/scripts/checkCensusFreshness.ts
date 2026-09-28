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
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the client's src/features/trips/, whole — TR439 grades the directory itself, and §56–§65 grade TR193, TR130, TR317, TR390, TR334, TR421, TR432, TR318, TR281, TR169 and TR342 on its today, timeline, closeout, offline, disruption, map, planning and shared files.
    "travel-buddy-standalone/src/features/trips/",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the §40.3 operational-projections gate's registration, and the §41.1 local database (shim, baseline, unreplayable list) that TR430 and TR431 were executed on.
    "artifacts/api-server/src/lib/capability/registry.ts",
    "artifacts/api-server/scripts/local-db/shim.sql",
    "artifacts/api-server/baseline/20260819_baseline_structure.sql",
    "artifacts/api-server/scripts/local-db/KNOWN_UNREPLAYABLE.json",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §42–§55's evidence — the migrations, routes and suites their "What was built" lists name for the row moves that follow (TR200, TR351, TR221, TR204, TR287, TR75, TR379, TR224–TR253, the §52 regroup, the §53 write guards, the §54 post-trip projections, the §55 flag-off twin), and the pulse, opportunity and replan route suites those rows are pinned by.
    "artifacts/api-server/src/lib/pushWithRetry.ts",
    "artifacts/api-server/src/routes/location.ts",
    "artifacts/api-server/src/test/tripAttentionPolicy.test.ts",
    "artifacts/api-server/src/test/tripExperienceCompiler.test.ts",
    "artifacts/api-server/src/test/tripSnapshotReplayContract.test.ts",
    "artifacts/api-server/src/test/tripDecisionRiskImpact.test.ts",
    "artifacts/api-server/src/migrations/2520_trip_map_projection_worker.sql",
    "artifacts/api-server/src/test/tripReplanMeetingRescue.test.ts",
    "artifacts/api-server/src/test/tripSensingPolicy.test.ts",
    "artifacts/api-server/src/test/tripCompassCrewState.test.ts",
    "artifacts/api-server/src/migrations/2794_trip_meeting_checkpoints.sql",
    "artifacts/api-server/src/routes/tripMeetingCheckpoints.ts",
    "artifacts/api-server/src/test/tripMeetingCheckpointsRoute.test.ts",
    "artifacts/api-server/src/migrations/2795_trip_kernel_write_guards.sql",
    "artifacts/api-server/src/test/tripBoredRoute.test.ts",
    "artifacts/api-server/src/test/tripTransportReliability.test.ts",
    "artifacts/api-server/src/test/tripPulseProjection.test.ts",
    "artifacts/api-server/src/test/tripOpportunityProjection.test.ts",
    "artifacts/api-server/src/test/tripReplanRoutes.test.ts",
    "artifacts/api-server/src/routes/tripPostTrip.ts",
    "artifacts/api-server/src/test/tripPlan.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §58–§62's consumers — the map pin (TR166), the Map cache (TR174), the §17.2 switch applied by Compass (TR319), the windows consumed by Buddy and Discovery (TR133), the departure assumption (TR267), the outbox starter (TR440), the route plan as a view over the plan (TR437) and the sanitizer carve-out (TR206), with their suites.
    "travel-buddy-standalone/src/components/map/EntityMarkers.tsx",
    "travel-buddy-standalone/src/features/map/cache/mapCache.ts",
    "artifacts/api-server/src/test/tripCompassAttention.test.ts",
    "artifacts/api-server/src/test/compassSurfaces.test.ts",
    "artifacts/api-server/src/test/tripAttentionFilter.test.ts",
    "travel-buddy-standalone/src/components/__tests__/CompassTripBrief.attention.component.test.tsx",
    "artifacts/api-server/src/test/tripFreedomConsumers.test.ts",
    "artifacts/api-server/src/routes/rentABuddy.ts",
    "artifacts/api-server/src/test/rentABuddy.test.ts",
    "artifacts/api-server/src/routes/discoverySearch.ts",
    "artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts", // census-discovery §70: routes/discoverySearch.ts's searchers moved here
    "artifacts/api-server/src/test/discoverySearch.test.ts",
    "artifacts/api-server/src/test/tripDepartureAssumptions.test.ts",
    "artifacts/api-server/src/lib/projections/registry.ts",
    "artifacts/api-server/src/test/tripCommandsEndpoint.test.ts",
    "artifacts/api-server/src/routes/routePlan.ts",
    "artifacts/api-server/src/test/tripRouteChainProjection.test.ts",
    "artifacts/api-server/src/test/compass-structured-context.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): TR5's Telegraph consumer (§66–§67) — cited on the TR5 verdict rows.
    "artifacts/api-server/src/routes/telegraphChat.ts",
    "artifacts/api-server/src/services/telegraphChatSuggestions.ts",
    "artifacts/api-server/src/test/tripTelegraphProjection.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §68–§74's production facts and W-column evidence — the production ledger and 2026-09-08 snapshot, the one ungated writer (TR1, TR435), the trip_events writer (TR89), the lifecycle suite (TR35), the layover seam (TR425) and the roster-unreadable controls TR414 rests on.
    "artifacts/api-server/src/lib/capability/production-applied-migrations.json",
    "artifacts/api-server/src/lib/capability/snapshots/20260908-production-schema.json",
    "artifacts/api-server/src/services/appeals/resolveAppeal.ts",
    "artifacts/api-server/src/services/appeals/roleAtRemoval.ts",
    "artifacts/api-server/src/test/tripLifecycle.test.ts",
    "artifacts/api-server/src/migrations/0127_layover_system.sql",
    "artifacts/api-server/src/test/tripCrewRosterUnreadable.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §75's code half of TR116, TR150, TR153 and TR290 — the plan reader and the four suites a central regrade will check.
    "artifacts/api-server/src/routes/plan.ts",
    "artifacts/api-server/src/test/tripPlanPrivacyScope.test.ts",
    "artifacts/api-server/src/test/tripPlanAttendanceDownstream.test.ts",
    "artifacts/api-server/src/test/tripProposalContract.test.ts",
    "artifacts/api-server/src/test/tripReservationReimport.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14), at integration: the router registry — TR222, TR1, TR134, TR374 and TR440 grade whether trip routes are registered in it; counted once the checker resolved `routes/index.ts:179#tripProjectionsRouter` by its anchor.
    "artifacts/api-server/src/routes/index.ts",
  ],
  "census-layover.md": [
    // ── ADDED 2026-09-22 by the INTEGRATING lane, because check:census-scope-coverage
    // ── went red and the remedy it prescribes is this one, never the floor.
    //
    // MEASURED BOTH SIDES BEFORE TOUCHING ANYTHING. At `4f89330b9` — the six-lane
    // merge, before §41-§44 were written — this census was ALREADY at 89 % against
    // its 0.97 floor. So the gap arrived with the lanes' own citations and §41-§44
    // took it 89 % -> 87 %; it is not a defect this pass introduced, and it is not
    // one this pass gets to leave either. The census-highlights-memories half of
    // the same failure IS this pass's and is fixed in that entry.
    //
    // Every path below is a subject this census GRADES, not a file it mentions:
    //   lib/providers/routeCorridorProvider.ts + returnRouteRisk.ts and their two
    //     suites — the routed corridor §12.1 wired into the certified action
    //     universe; six rows (L60, L68-L71, L282) moved N -> W on them.
    //   test/layoverApiLifecycle.test.ts — §41 moves L239 and L221 on it.
    //   lib/layoverExternalEventScheduler.ts + routes/layoverEvents.ts +
    //     test/db/layoverExternalEventsDedup.db.test.ts — §40's ingest, drain and
    //     real-database suite.
    //   lib/layoverCrewExpiryScheduler.ts — the crew half of the same chain.
    //   lib/crowdState.ts — L276's whole verdict is about what this module exports
    //     and whether the airport surface calls it (§43's "capability that exists
    //     in lib/ and is never called is NOT BUILT in this census's usage").
    //   migrations 2981, 2982, 2986, 2992 — layover migrations this census cites
    //     by name; 2986 is §42's fanout indexes.
    //   travel-buddy-standalone/src/lib/layoverPlanCache.ts and the sensing-cadence
    //     suite — L151/L233's offline cache and the L164/L168 guard §41.4 rests on.
    //
    //   test/schedulerRegistration.test.ts — added on a SECOND look, and the
    //     distinction from test/docCitations.test.ts is worth stating because the
    //     first draft of this entry got it wrong and excluded both as "a guard's
    //     own suite". They are not the same. The census rests a factual claim on
    //     the scheduler guard's STATE — "before this it was an exported function
    //     nothing called, which is the state `schedulerRegistration.test.ts`
    //     exists to refuse, and that test was red until the call was added" — so
    //     its red/green is the evidence for a row's "IS scheduled" half. The
    //     citation guard, by contrast, is a corpus-wide tool this census reports
    //     on. Evidence goes in scope; instrumentation does not.
    //
    // STILL DELIBERATELY NOT ADDED, extending the list the floor comment in
    // checkCensusScopeCoverage.ts already names: test/docCitations.test.ts is a
    // guard's own suite — machinery this census REPORTS ON rather than grades;
    // routes/messaging.ts and
    // 2795_trip_kernel_write_guards.sql belong to Telegraph and Trips; and
    // lib/capability/snapshots/current.ts is corpus-wide capability machinery that
    // every census cites when it needs to say what production carries.
    "artifacts/api-server/src/lib/providers/routeCorridorProvider.ts",
    "artifacts/api-server/src/lib/providers/returnRouteRisk.ts",
    "artifacts/api-server/src/test/providerRouteCorridor.test.ts",
    "artifacts/api-server/src/test/providerReturnRouteRisk.test.ts",
    "artifacts/api-server/src/test/layoverApiLifecycle.test.ts",
    "artifacts/api-server/src/lib/layoverCrewExpiryScheduler.ts",
    "artifacts/api-server/src/lib/layoverExternalEventScheduler.ts",
    "artifacts/api-server/src/test/schedulerRegistration.test.ts",
    "artifacts/api-server/src/lib/crowdState.ts",
    "artifacts/api-server/src/routes/layoverEvents.ts",
    "artifacts/api-server/src/test/db/layoverExternalEventsDedup.db.test.ts",
    "artifacts/api-server/src/migrations/2981_layover_event_ingest_flag.sql",
    "artifacts/api-server/src/migrations/2982_layover_traveller_observation_submissions.sql",
    "artifacts/api-server/src/migrations/2986_layover_sessions_fanout_indexes.sql",
    "artifacts/api-server/src/migrations/2992_layover_decision_record_and_operational_tables.sql",
    "travel-buddy-standalone/src/lib/layoverPlanCache.ts",
    "travel-buddy-standalone/src/lib/__tests__/layoverSensingCadence.test.ts",
    // ── ADDED 2026-09-15: §24's own two modules, which §24.9 says are covered ──
    // by an acknowledgement and which NOTHING was watching, so they could not be.
    //
    // §24.9 lists five counted files that pass changed and states that
    // `head_commit` stays `1fe72289b` because "the five files above are covered
    // by an acknowledgement instead". Only THREE of the five were in this scope,
    // so only three reached the acknowledgement ledger; the other two changed
    // under the census in silence. That is not an acknowledgement gap, it is a
    // scope gap wearing one — a file outside CENSUS_SCOPE cannot be reported
    // stale, so it cannot be acknowledged either, and check:census-freshness
    // said FRESH about the half it could see.
    //   discoveryLayoverTiming.ts — the PRODUCER of the return term. §24.2
    //     grades it on two anchors (`:419#const backLegs = await Promise.all`
    //     and `:181#no_routed_return_leg`), and §24.8's first red flag is that
    //     the symmetric fallback inside it is load-bearing and exercised only by
    //     an injected port. A row resting on a fallback has to age when the
    //     fallback's file moves.
    //   discoveryLayoverMode.ts — the GATE that carries the term into the
    //     certified action universe and publishes it on every withheld card
    //     (§24.2, `:327#returnTravelTimeMin: t ? t.returnTravelTimeMin`).
    //     §24.8's second and third red flags are both about this file: the fifth
    //     parameter is a seam into the gate, and `terms` grew a member no client
    //     has a label for.
    "artifacts/api-server/src/lib/discoveryLayoverTiming.ts",
    "artifacts/api-server/src/lib/discoveryLayoverMode.ts",
    // ── ADDED 2026-09-15: three files a §24 claim is a statement ABOUT ─────────
    //   routes/discovery.ts — §24.1's finding is not "the safety engine doubles
    //     the ride back", it is that the doubling is now reached from ANOTHER
    //     ARCHITECTURE's six serve paths, cited at `:3975#layoverGatedPlaces`.
    //     §24.8 then rests a red flag on the negative: "no call site in
    //     routes/discovery.ts passes it, so the production answer is unchanged".
    //     That sentence is a claim about the contents of this file, and a caller
    //     that started passing a lenient provider would falsify it while
    //     changing nothing this scope watched. Another lane's file, watched here
    //     for the reason census-highlights-memories gives about its five
    //     consumers: watching is not ownership, it is noticing.
    //   compass/TelegraphConversationTools.ts — L102 stays `N` on a grep that
    //     "returns 0 and 0" over CompassTools.ts and this file. Its co-grepped
    //     sibling has been in this scope since the 2026-09-11 widening; leaving
    //     this one out watched half of a two-file measurement.
    //   routes/rentABuddyRollout.ts — L273's non-move rests on there being no
    //     `layover` member in `MVP_ALLOWED_CATEGORIES` (`:41`). Same shape: a
    //     verdict held in place by an absence in a named file.
    "artifacts/api-server/src/routes/discovery.ts",
    "artifacts/api-server/src/compass/TelegraphConversationTools.ts",
    "artifacts/api-server/src/routes/rentABuddyRollout.ts",
    // ── ADDED 2026-09-22 by the ENTRY GATE lane (§45, RENUMBERED FROM §27 AT INTEGRATION 2026-09-23) ────────────────────────
    // This census measured 132 cited / 127 watched — exactly its 96% floor —
    // before §45 was written. §45 cites four more files and only one of them was
    // in scope, which took it to 94% and turned check:census-scope-coverage red.
    // That is the guard working: a census cannot grade a file it does not watch.
    //   lib/entryRequirements.ts — L48's verdict rests on it entirely. §45.1
    //     grades `readCorridor`'s three-state read, and §45.3's whole argument
    //     for W-not-C is that this file's table has no INSERT in any migration.
    //     If a migration ever seeds a corridor, or `readCorridor` collapses its
    //     three states back to two, L48 moves — and nothing here was watching.
    //   test/layoverEntryGate.test.ts — the suite that pins L34 and L48,
    //     including the monotonicity property §45.4 counts toward L235. A row
    //     held in place by a test ages when that test does.
    //   routes/entryRequirements.ts — §45.9 rests a claim on this file's
    //     CONTENTS: that it makes the identical `isFlagEnabled(sc, ENTRY_FLAG)`
    //     call, which is why the gate's own UNRESOLVABLE entry is a copy of an
    //     existing judgement rather than a new one. Same shape as
    //     routes/discovery.ts above: a claim held in place by what is in
    //     another lane's file. Watching is not ownership, it is noticing.
    "artifacts/api-server/src/lib/entryRequirements.ts",
    "artifacts/api-server/src/test/layoverEntryGate.test.ts",
    "artifacts/api-server/src/routes/entryRequirements.ts",
    // ── ADDED 2026-09-22, and PRE-EXISTING rather than caused by §27 ──────────
    // Both were already cited-but-unwatched at `origin/main`, which is part of
    // why this census sat exactly ON its floor rather than above it. §26 grades
    // them: it moved L28 from `N` to `C` on `layover_crews` existing and being
    // applied, and names 2985 as the deploy dependency without which 2984's own
    // apply fails. A row moved BY a migration has to age when that migration
    // does, and neither was being watched.
    "artifacts/api-server/src/migrations/2984_layover_crews.sql",
    "artifacts/api-server/src/migrations/2985_layover_events_crew_vocabulary.sql",
    // NOT ADDED: 2971_layover_discovery_mode_flag.sql, deliberately, and this is
    // a decision inherited rather than taken. §25 says in terms that whether it
    // belongs in CENSUS_SCOPE is "the next measuring pass"'s to decide, and that
    // it is "deliberately NOT added there ... because nothing in this document
    // grades it yet". §27 is not that measuring pass — it grades two rows and
    // names four that do not move — so overturning §25's decision is not its to
    // make, and adding the file would silence a gap §25 chose to leave visible.
    // NOT ADDED, and said rather than left silent, per the guard's own second
    // remedy. `routes/messaging.ts` is cited once, for a `message.created`
    // payload divergence §20 found and explicitly declined: "The media path is
    // census-telegraph's to answer for; copying it here would have made it two
    // places instead of one." A defect this census hands to another census is
    // not a thing this census grades. `2795_trip_kernel_write_guards.sql` is
    // cited once as the STYLE a future layover migration should follow — the
    // guard's own header names "a migration quoted for contrast" as the
    // legitimate case for an unwatched citation, and this is it.
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
    // ── ADDED 2026-09-22 by §27: the §14 crew's persistence half, and the two
    // migrations three sections now rest verdicts on. Same shape of gap as the
    // 2026-09-15 entry above, and found the same way — by the coverage floor.
    //
    //   services/layover/ — `LayoverCrewStore.ts` is where `createCrew`,
    //     `joinCrew` and `leaveCrew` live, and §27.4 moves L185/L186/L188 to `C`
    //     ON those three functions. The solver they feed has been watched for a
    //     year under `services/airport/`; the storage that finally gave it
    //     members was in a SIBLING directory nothing watched, so the three rows
    //     this census now scores `C` rested on a file it could not age. The
    //     directory also holds their two suites, which are the acceptance
    //     evidence those verdicts cite.
    //   2984_layover_crews.sql — §26.2 moves L28 and L29 to `C` on this file
    //     existing and being applied, and §27.5 rests the "no database-level
    //     scope underneath the route layer" argument on its zero-policy,
    //     zero-grant postcondition. A verdict resting on a migration's CONTENT
    //     has to age when that content moves.
    //   2971_layover_discovery_mode_flag.sql — §24.6, §25.2 and §29.3 all keep
    //     L269 at `W` on the specific ground that this file is NOT applied. If
    //     it changes, the reason three sections give for that verdict changes
    //     with it.
    //   2985_layover_events_crew_vocabulary.sql — 2984's deploy dependency, and
    //     §26.1 records that it was MISSED on the first attempt, producing "a
    //     feature that looks built and audits nothing" because every crew audit
    //     row was rejected by the `layover_events.event_type` CHECK and swallowed
    //     by `emitEvent`'s non-fatal warn. §27.4's `C` on L185 cites the
    //     `crew_joined` audit as evidence, so that verdict rests on this file's
    //     vocabulary and must age with it. §26.1 also notes `check:enum-literals`
    //     cannot see this class, which is the whole reason it needs watching.
    "artifacts/api-server/src/services/layover/",
    "artifacts/api-server/src/migrations/2984_layover_crews.sql",
    "artifacts/api-server/src/migrations/2985_layover_events_crew_vocabulary.sql",
    "artifacts/api-server/src/migrations/2971_layover_discovery_mode_flag.sql",
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
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the evidence L271 (§14.1-§14.3), L19/L162 (§17.2), L56/L57/L178 (§18.1), L196 and L269 (§35) rest on.
    "artifacts/api-server/src/test/layoverTelegraphMessage.test.ts",
    "artifacts/api-server/src/lib/threadMessage.ts",
    "artifacts/api-server/src/test/layoverStampOccurrence.test.ts",
    "artifacts/api-server/src/services/memory/occurrenceGate.ts",
    "artifacts/api-server/src/domain/trips/invariants/TripFreedomEngine.ts",
    "artifacts/api-server/src/index.ts",
    "travel-buddy-standalone/eas.json",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §18.9's three server suites, which that section asks the integrator to scope — one is cited, two are named in prose only because citing them would have failed this check.
    "artifacts/api-server/src/test/layoverTemporalFreedom.test.ts",
    "artifacts/api-server/src/test/layoverEnvelope.test.ts",
    "artifacts/api-server/src/test/layoverScenarioMatrix.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): L169 and L267 cite `app/trip/[id].tsx`, which the guard resolves to the legacy repo-root mock (113 lines); the trip screen whose lines they cite is travel-buddy-standalone's, so both are watched rather than one chosen.
    "travel-buddy-standalone/app/trip/[id].tsx",
    "app/trip/[id].tsx",
  ],
  "census-highlights-memories.md": [
    // ── ADDED 2026-09-22 by the INTEGRATING lane. THIS HALF IS THIS PASS'S OWN
    // ── DEFECT, measured rather than assumed: at `4f89330b9` this census was at
    // 99 % against its 0.98 floor, and §W and §X took it to 97 %. The layover
    // entry's gap predates the same pass; this one does not.
    //
    // Both paths are subjects this census grades:
    //   2994_memory_relations_and_outbox_consumer.sql — `memory_relations`, the
    //     outbox claim/ack/fail functions and the claimable index, all of which
    //     §12.2-§12.3 and the H1xx outbox rows turn on.
    //   test/highlightsApiUnhideBoundary.test.ts — §X repoints it to the
    //     three-artifact invariant over the vocabulary, the applier and the route,
    //     and grades H159's boundary on it.
    //
    // NOT ADDED, on the precedent the layover entry above extends:
    // 0179_stamp_criteria_engine.sql belongs to Passport and is cited in passing.
    // (Its citation is also bare, so it resolves onto the STRAY ROOT COPY rather
    // than onto src/migrations/ — docs/stray-sql-inventory-and-disposition.md
    // item 2 owns that repair, together with deleting the strays.)
    "artifacts/api-server/src/migrations/2994_memory_relations_and_outbox_consumer.sql",
    "artifacts/api-server/src/test/highlightsApiUnhideBoundary.test.ts",
    // ── ADDED 2026-09-23 by §Y. THE RULING DIRECTLY ABOVE IS REVERSED, on the ──
    // ── facts that changed, not on the pressure of a red check. ──────────────
    //
    // The 2026-09-22 comment ruled scripts/migrationPrefixRules.ts out as
    // "machinery this census reports on, not a subject", and at the time that was
    // right: §X.4 named the 2100-2999 band only to explain why the amendment it
    // wanted could not be written — the census cited the rule the way it cites a
    // guard that measured it.
    //
    // §Y is a different relationship. PR #527 extended the band to 3000-3999, and
    // the amendment §X.4 had recorded as unbuildable became buildable in the same
    // hour; 3001 below EXISTS because of the line that module now carries. So the
    // module is no longer evidence about why this census could not act — it is a
    // precondition of a migration this census grades, and if the band moves again
    // §Y's argument for 3001's filename goes stale and must be re-read. That is
    // exactly what CENSUS_SCOPE is for.
    //
    // It is deliberately NOT put in checkCensusScopeCoverage.ts's NOT_GRADED
    // list, which would have been the cheaper way to go green: that list is
    // GLOBAL, so one entry stops all thirteen censuses watching a file, and this
    // module is imported by the APPLIER (scripts/src/apply-migrations.ts) as well
    // as by two guards — it is shared rule code, not a checker. NOT_GRADED's own
    // comment names that as the thing that would make it wrong.
    //
    // 3001_highlight_kernel_admits_unhide.sql is a subject outright: it is the
    // CREATE OR REPLACE that makes the §17 applier admit UNHIDE_HIGHLIGHT, which
    // is what §Y moves H159's boundary on.
    "artifacts/api-server/src/scripts/migrationPrefixRules.ts",
    "artifacts/api-server/src/migrations/3001_highlight_kernel_admits_unhide.sql",
    // ── ADDED 2026-09-23 by §Y.7: the un-hide's CLIENT half. ────────────────
    // §Y.4 wired the route and §Y.6 said the migration is applied nowhere;
    // between those two it would be easy to read the un-hide as a server
    // capability with no caller. §Y.7 follows the chain and finds the screen,
    // the client service, and four tests that were there all along — which is
    // what makes H159's `W` mean "not deployed" rather than "not built".
    //
    // A section that rests its argument on a screen must age when that screen
    // changes, so all four are watched. These are SUBJECTS: the archive screen
    // and its service are the surface H159's requirement is about, and the two
    // suites are the evidence §Y.7 cites — the same category as
    // highlightsApiUnhideBoundary.test.ts above, not machinery.
    "travel-buddy-standalone/app/highlights/archived.tsx",
    "travel-buddy-standalone/src/services/highlights.ts",
    "travel-buddy-standalone/app/highlights/__tests__/archived.screen.component.test.tsx",
    "travel-buddy-standalone/src/services/__tests__/highlights.archive.component.test.ts",
    // ── ADDED 2026-09-15: §M and §O's OWN suites, which the ledger could not ──
    // name because this scope did not.
    //
    // §O says its staleness entry names "all eight counted files this section
    // changed". It names eight, and the section changed eleven: the three suites
    // below were written BY §M/§O as the red-first evidence for the rows those
    // sections moved, and none was in this scope, so none was ever a "counted
    // file" and none could reach the ledger. The freshness check reported this
    // census green about a set that excluded its own new evidence.
    //   highlightsMemoriesDeployedStorage.test.ts — §O.1's whole argument. It
    //     re-derives the ten applied migrations from `production-applied-
    //     migrations.json` and the 2026-09-15 snapshot on every run, asserts
    //     every column `probeHighlightObject` reads (a rename would silently
    //     return an enforced §11 control to a no-op), asserts `highlights` still
    //     carries no trip reference (H90) and asserts all four gating flags are
    //     still `false` — which §O.3 makes the whole blocker of roughly thirty
    //     rows. §O.10 names the flags flipping as the thing that turns the
    //     section red, and says it is "the point of writing it as a test".
    //   memoriesListReadDegraded.test.ts — §M.6's red-first evidence for the
    //     `memory_items` refusal, and the POSITIVE CONTROLS this census's own
    //     acknowledgement already leans on when it argues that a database which
    //     answers returns byte-identical responses. The ledger cited the file
    //     while the scope did not watch it.
    //   highlightsUnenforceableControls.test.ts — §O.6's red-first evidence for
    //     the derived `FEED_ENFORCEABLE_CONTROLS` list, and the seven mutations
    //     H90 and H92's restatements rest on.
    "artifacts/api-server/src/test/highlightsMemoriesDeployedStorage.test.ts",
    "artifacts/api-server/src/test/memoriesListReadDegraded.test.ts",
    "artifacts/api-server/src/test/highlightsUnenforceableControls.test.ts",
    // ── ADDED 2026-09-15: four more subjects, same argument, unchanged since ──
    // `1fe72289b` and listed on their merits rather than to pad a ratio.
    //   memoriesSingleReadDegraded.test.ts — §M.6's FIRST red, the sibling of
    //     the list suite above on `GET /memories/:id`. H264 is graded on it.
    //   highlightConsentPolicy.test.ts — H92's evidence in as many words: "the
    //     live feed serves a Highlight carrying the first (asserted in
    //     `highlightConsentPolicy.test.ts`)", and the control that §O.6's
    //     mutation 3 is killed in. Deleting it would not change the code and
    //     would change what this census can claim — the same argument that put
    //     storyHighlightVisibility and memoryParticipantLadder in this list.
    //   snapshots/20260915-production-schema.json — the generated capture of
    //     `information_schema.columns` on production at watermark 20260915083533.
    //     This census's largest single class of verdict is "the table §3.6 names
    //     is not in production", and §O.3 moves ten rows by reading table and
    //     column anchors straight out of this file (H29 on
    //     `:2753#memory_command_receipts`, H90 on `:1918#highlights`, and the
    //     rest). Its 2026-09-08 predecessor has been watched since the
    //     2026-09-11 widening for exactly this reason; the newer capture is the
    //     one the current verdicts are read from.
    //   docs/architecture/mobile-reachability-ledger.json — §N exists to rule on
    //     this file's `/api/users/:userId/memories` entry, and REFUSES §M.7's
    //     repoint request on the ground that the entry is right at its own
    //     `pinnedCommit`. That verdict is a statement about this file's bytes: a
    //     regeneration moves `pinnedCommit` and every line number under it, and
    //     §N's refusal would have to be re-derived. Being pinned is why the
    //     census can rule on it, not a reason not to watch it.
    "artifacts/api-server/src/test/memoriesSingleReadDegraded.test.ts",
    "artifacts/api-server/src/test/highlightConsentPolicy.test.ts",
    "artifacts/api-server/src/lib/capability/snapshots/20260915-production-schema.json",
    "artifacts/api-server/src/lib/capability/snapshots/20260916-production-schema.json",
    "docs/architecture/mobile-reachability-ledger.json",
    // NOT ADDED, and said rather than left silent, per the guard's own second
    // remedy. TWO citations stay uncovered on purpose:
    //   `2320_memory_episode_provenance_spine.sql` — §3 row 2 cites it as
    //     `git show pr/470:artifacts/.../2320_...sql:102`, a blob in an UNMERGED
    //     pull request. The coverage guard resolves the basename onto the
    //     working-tree path, which is a different object from the one the row
    //     reads; watching the tree file would claim to watch the PR and would
    //     not.
    //   `0179_stamp_criteria_engine.sql` — cited bare, and it resolves onto a
    //     STRAY COPY AT THE REPOSITORY ROOT rather than
    //     `src/migrations/0179_stamp_criteria_engine.sql`, because the guard
    //     tries `existsSync(REPO/<cited>)` before the basename index. Scoping
    //     the root copy would watch a duplicate nobody runs. This is a citation
    //     defect owed to the next highlights pass, recorded here rather than
    //     papered over with a scope entry.
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
    // ── WIDENED 2026-09-22 by section Q, on the same argument every test file ──
    // above was added on: each is the EVIDENCE a row's verdict now cites, so
    // deleting it would not change the code and would change what this census
    // can claim.
    //   highlightLifetimeAndPin.test.ts — §Q's evidence for H94–H97. It drives
    //     POST /highlights with a §4 class through to the stored column and back
    //     out of the profile read with its provenance, and pins PERMANENT's
    //     refusal-by-name on a database without 2975. Three mutations in §Q.2
    //     turn it red.
    //   memorySearchRoute.test.ts — §Q's evidence for H110 and H111, whose
    //     shared blocker was "no route imports the module". It also carries the
    //     `deterministicMatchCount` case §Q.3 added after a mutation found the
    //     original green when the field was replaced by the page size.
    //   highlightSourceLinks.test.ts — §Q's red-first evidence for H32, the
    //     first TypeScript writer for `highlight_sources`.
    //   highlightConsentEnforcementMap.test.ts — §Q.5's evidence that the §10
    //     enforcement map served on `GET /highlights/:id/projection-policy` is
    //     DERIVED from the gate rather than retyped beside it.
    //   highlightsSpecHarness.ts — not a suite but the fake all four drive. §Q.1
    //     changed its generated primary key from `new-<hex>` to a UUID, which is
    //     the shape every table it stands in for actually has; a harness that
    //     invents a key shape the database cannot is how a correct handler is
    //     made to look broken. It is watched for the same reason
    //     `highlightRouteHarness.ts` is cited in §P.6.
    "artifacts/api-server/src/test/highlightLifetimeAndPin.test.ts",
    "artifacts/api-server/src/test/memorySearchRoute.test.ts",
    "artifacts/api-server/src/test/highlightSourceLinks.test.ts",
    "artifacts/api-server/src/test/highlightConsentEnforcementMap.test.ts",
    "artifacts/api-server/src/test/highlightsSpecHarness.ts",
    // ── AND FIVE THIS SCOPE SHOULD ALREADY HAVE HAD, found by running ────────
    // check:census-scope-coverage after the five above went in. Each was cited
    // by §P or by the body and watched by nothing, which is the same hole §O
    // recorded about its own three suites one widening ago.
    //   verifyFlowHighlightControls.test.ts — §P.1's whole argument, the
    //     PUT → GET → feed → DELETE flow that falsified §O.2's "they will stay
    //     empty". Cited twice.
    //   highlightPublicProjectionEnforcement.test.ts — §P.2's 39 cases and
    //     twelve mutations, and §Q.5 drives it too.
    //   highlightRouteHarness.ts — the table-backed fake both of those suites
    //     drive. §P.6 names it by name and this scope did not watch it.
    //   2975_highlights_permanent_lifetime.sql — H98's ENTIRE blocker. The row
    //     is NOT-BUILT because `highlights.expires_at` is still NOT NULL, and
    //     this migration is the thing that changes that. §Q.9 names its landing
    //     as one of four events that turn the section red, so a change to it
    //     must age the document.
    //   2320_memory_episode_provenance_spine.sql — PR #470's migration, which
    //     H18, H19, H23 and H24 each cite as "unmerged PR #470 only". If it
    //     merges or changes, four rows change.
    //
    // NOT ADDED, and said rather than left silent, per the guard's own second
    // remedy: `0179_stamp_criteria_engine.sql` is cited by BASENAME with no
    // path, in §N's account of the criteria engine minting a stamp the Passport
    // then counted. This repository holds several files with that basename in
    // frozen non-executable roots, so there is no single path to watch, and
    // adding one would assert a resolution the citation does not make. It is
    // the one citation this census still does not watch.
    "artifacts/api-server/src/test/verifyFlowHighlightControls.test.ts",
    "artifacts/api-server/src/test/highlightPublicProjectionEnforcement.test.ts",
    "artifacts/api-server/src/test/highlightRouteHarness.ts",
    "artifacts/api-server/src/migrations/2975_highlights_permanent_lifetime.sql",
    "artifacts/api-server/src/migrations/2320_memory_episode_provenance_spine.sql",
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
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the evidence for §G's non-temporal endSession, §I.4's red-before-green store assertion, §N.3's presence-evidence select, §P.5's ungated Highlight surfaces and §W.3/§X.2's un-hide applier.
    "artifacts/api-server/src/migrations/2993_highlight_command_boundary.sql",
    "artifacts/api-server/src/services/airport/LayoverSessionService.ts",
    "artifacts/api-server/src/test/memoriesTripMemoryDegraded.test.ts",
    "artifacts/api-server/src/test/stampCriteriaPresenceEvidence.test.ts",
    "artifacts/api-server/src/routes/engagement.ts",
    "artifacts/api-server/src/routes/collections.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14), at integration: §N.1 grades the presence join in distinctStampField; counted once the checker resolved `lib/stamps/criteria/metrics.ts:96#…` by its anchor.
    "artifacts/api-server/src/lib/stamps/criteria/metrics.ts",
],
  // Trust has NO SPEC — its 52 requirements are 20 inbound obligations from
  // other surfaces' specs plus 32 contracts its own code asserts. That makes the
  // scope wider than one directory: the rows about whether OTHER surfaces
  // consume Trust correctly (A13, A17) are aged by the files that consume it,
  // not by services/trust. Listing only the service would have made this census
  // look fresh while the reads it grades moved underneath it.
  "census-trust.md": [
    // ── ADDED 2026-09-22 by the RE-MEASUREMENT LANE, with §24 ──────────────
    // §24.5 cites this suite as the executed evidence for the failure-visibility
    // rows, and this census's scope floor is 100 %, so a file it cites and does
    // not watch is a hole by its own rule: the suite could be deleted and the
    // section would still read as though it had been run.
    "artifacts/api-server/src/test/trustFailureVisibility.test.ts",
    // ── ADDED 2026-09-16 by the PRODUCT lane, with §20 ─────────────────────
    // TV-2a's Rent-a-Buddy half now RESTS on these. The row was W because
    // no screen under `app/(rent-a-buddy)/` routed to `/profile/verification`;
    // it is C because three of them do, through one registry. Until this entry
    // a change to any of them aged no census, so the row could have been
    // falsified by a deleted button and nothing would have said so — which is
    // the failure `gateAge.ts` was added for, one census section earlier.
    "travel-buddy-standalone/src/services/rentABuddyBookingErrors.ts",
    "travel-buddy-standalone/app/(rent-a-buddy)/checkout.tsx",
    "travel-buddy-standalone/app/(rent-a-buddy)/become/apply.tsx",
    "travel-buddy-standalone/src/services/__tests__/rentABuddy.verificationRoute.test.ts",
    // §20.2 cites this one as the PRE-EXISTING suite a mutation reddens: it is
    // what stops `verification_required` being folded into the feature-closed
    // set, so TV-2a's evidence rests on it staying as it is.
    "travel-buddy-standalone/src/services/__tests__/rentABuddy.bookingUnavailable.test.ts",
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
    "artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts", // census-discovery §70: routes/discoverySearch.ts's searchers moved here
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
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the evidence cited on rows TV-0e/TV-2c, TV-2a, TV-3a, TV-4b, TV-6c, TV-U7, TRV2-10, C18, C30 and A18/TRV2-02, and by §18.2 for keeping TV-5b at NB. This census's floor is 100 %, so every file it cites is either here or declared.
    "artifacts/api-server/src/lib/http.ts",
    "artifacts/api-server/src/test/trustNullableScores.test.ts",
    "travel-buddy-standalone/app/(rent-a-buddy)/index.tsx",
    "travel-buddy-standalone/app/u/[username].tsx",
    "travel-buddy-standalone/app/event/[id].tsx",
    "travel-buddy-standalone/app/(rent-a-buddy)/buddy/[id].tsx",
    "artifacts/api-server/src/index.ts",
    "travel-buddy-standalone/src/components/BuddyCard.tsx",
    "travel-buddy-standalone/src/components/compass/CompassTravelerRow.tsx",
    "travel-buddy-standalone/app/(rent-a-buddy)/offers.tsx",
    "travel-buddy-standalone/src/components/layover/LayoverPeopleSection.tsx",
    "artifacts/api-server/src/services/appeals/resolveAppeal.ts",
    "artifacts/api-server/src/test/zeroRowTrustAdjudication.test.ts",
    "artifacts/api-server/src/test/trustProfileUnreadableDowngrade.test.ts",
    "artifacts/api-server/src/services/phoneVerification/PhoneVerificationService.ts",
    "artifacts/api-server/src/test/sensingAnonStore.test.ts",
    "artifacts/api-server/src/routes/rentABuddySpec.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §17.3's is_over_18 finding — the client surfaces the verified bit as display data and no gate reads it, which is TV-5b's subject.
    "travel-buddy-standalone/src/services/verification.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): TV-3a cites `app/post/[id].tsx`, which the guard resolves to the legacy repo-root mock (22 lines); the report entry point it means is travel-buddy-standalone's, so both are watched rather than one chosen.
    "travel-buddy-standalone/app/post/[id].tsx",
    "app/post/[id].tsx",
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
    // ADDED 2026-09-20 by census-wall §13, closing §12.5's cross-lane request
    // and the two other files check:census-scope-coverage reported as cited but
    // unwatched. The truthfulness suite carries W67's and W71's outage half; the
    // gateway is what W71's voice half would have to reach; the mock checker is
    // the client-side pin cited beside them.
    "artifacts/api-server/src/test/wallIntentResolutionTruthfulness.test.ts",
    "artifacts/api-server/src/lib/inputAssistance/gateway.ts",
    "travel-buddy-standalone/scripts/check-test-mocks.mjs",
    // ADDED 2026-09-20 by census-wall §14: the first-page benchmark this census
    // now cites, and the build config it reads to say the repo names no device.
    "artifacts/api-server/src/test/wallFirstPageLiveDb.test.ts",
    "eas.json",
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
    "artifacts/api-server/src/test/wallFeedVariant.test.ts",
    "artifacts/api-server/src/lib/media/mediaProjection.ts",
    // WIDENED 2026-09-26 by census-wall §16 (W151 re-read and rebuilt): its
    // citations took census-wall to 86 watched of 91 cited, under the 95% floor.
    // The two files above are what W151's C now rests on.
    //   - wallFeedVariant.test.ts is the row's server proof.
    //   - lib/media/mediaProjection.ts holds the Media v2 post_media embed
    //     (MEDIA_PROJECTION_POST_MEDIA_COLUMNS) and the mapping that carries
    //     feed_url to the Wall's media lane. An edit there can break W151 with
    //     no Wall file changing.
    // Left unwatched on purpose, because they are cited but not graded:
    //   - services/media/MediaProjectionService.ts, cited only for the
    //     extractor's blind spot;
    //   - the app config, cited for the supported-device range.
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): verdict-row evidence — W166's brand accents, W10's tab registration, W170's video controls and the jest proof §9 ran, W152/W204's failure-vs-empty suite.
    "travel-buddy-standalone/src/theme/tokens.ts",
    "app/(tabs)/_layout.tsx",
    "travel-buddy-standalone/src/components/ui/SharedVideoPlayer.tsx",
    "travel-buddy-standalone/src/components/ui/__tests__/SharedVideoPlayer.component.test.tsx",
    "artifacts/api-server/src/test/wallFailureVsEmpty.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): W71 — the typo half's end-to-end proof and the two normalizers its row names, and the voice intake §14.2 moves the row on.
    "artifacts/api-server/src/test/wallSessionIntent.test.ts",
    "artifacts/api-server/src/routes/discoverySearchHelpers.ts", "artifacts/api-server/src/lib/inputAssistance/searchQueryHelpers.ts", // census-discovery §80: the helpers moved here verbatim; the Wall cites applyAliases at this path
    "artifacts/api-server/src/lib/inputAssistance/queryNormalizer.ts",
    "travel-buddy-standalone/src/platform/input-assistance/voice/voiceIntake.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): W146 — the Wall's own live-DB suite §13.1 names as the fixture shape the benchmark follows.
    "artifacts/api-server/src/test/wallSessionIntentLiveDb.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): W151's C and W118 — server caps the client pins, the shared signing cache, the phone-only app config, and the SELECT that composes Media v2's embed (W118's row grades that delegation, so the §16.8 "left unwatched" note above no longer holds for it or for app.json).
    "artifacts/api-server/src/lib/mediaProcessing.ts",
    "travel-buddy-standalone/src/services/mediaUrl.ts",
    "travel-buddy-standalone/app.json",
    "artifacts/api-server/src/services/media/MediaProjectionService.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): W72 — §17's postcard-link writer and the Quick Media suite that proves the fix.
    "artifacts/api-server/src/routes/postcards.ts",
    "artifacts/api-server/src/test/wallQuickMedia.test.ts",
    // WIDENED 2026-09-27 by lane E (census-media §38.11): W10 now spells its tab-registration citation as the standalone screen, so the guard checks the file the row means rather than the repo-root mock above.
    "travel-buddy-standalone/app/(tabs)/_layout.tsx",
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
    "artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts", // census-discovery §70: routes/discoverySearch.ts's searchers moved here
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
    // WIDENED 2026-09-26 by the integration owner (census-media §19, §20,
    // §23): two files the merged pass GRADES, not merely mentions. The route
    // registry is where §19's five new screens become reachable at all, so
    // MD25–MD28's reachability rests on it; the Telegraph share loader's media
    // gate is the one §20 changed to accept §36's `active`. Watching them keeps
    // the census above its floor for the right reason.
    "travel-buddy-standalone/src/navigation/portavaRoutes.ts",
    "artifacts/api-server/src/services/telegraph/shareables.ts",
    // WIDENED 2026-09-26 by census-media §21 (Lane C). §21 moves 36 rows on
    // what these files do and what these suites assert, and cited them, which
    // took check:census-scope-coverage to 87% against its 96% floor. Each is
    // named because a silent edit to it can falsify a §21 verdict: the §24
    // term library and the §44/§45 producers (lib/mediaAnalytics.ts had been
    // cited since §11 and watched by nothing), the post_event_links writer,
    // the client halves the actions and signals run through, and the six
    // proof suites. Named one by one for the reason the 2026-09-15 entry gives.
    "artifacts/api-server/src/lib/mediaRankingSignals.ts",
    "artifacts/api-server/src/lib/mediaAnalytics.ts",
    "artifacts/api-server/src/lib/mediaEventLinks.ts",
    "artifacts/api-server/src/test/mediaRankingObjectives.test.ts",
    "artifacts/api-server/src/test/mediaContributorTripExpertise.test.ts",
    "artifacts/api-server/src/test/mediaActionsSection21.test.ts",
    "artifacts/api-server/src/test/mediaOutcomeSignals.test.ts",
    "artifacts/api-server/src/test/hiddenGemOutcome.test.ts",
    "artifacts/api-server/src/test/mediaEventLink.test.ts",
    "travel-buddy-standalone/src/hooks/useMediaAnalytics.ts",
    "travel-buddy-standalone/src/services/mediaInteractions.ts",
    "travel-buddy-standalone/src/services/hiddenGems.ts",
    "travel-buddy-standalone/src/services/hiddenGemsMappers.ts",
    "travel-buddy-standalone/src/services/sharedMoments.ts",
    "travel-buddy-standalone/src/services/routePlan.ts",
    "travel-buddy-standalone/src/components/ShareSheet.tsx",
    "travel-buddy-standalone/src/components/CommentsSheet.tsx",
    "travel-buddy-standalone/src/components/gems/GemContributeSection.tsx",
    // WIDENED 2026-09-26 by census-media §22, because check:census-scope-coverage
    // required it: §22 grades MD275/276/281/284/295–301/320/321/323/325 on these
    // files and their tests, and a census that grades a file must go stale when
    // it moves. The client §40 modules live under services/media/ (a directory,
    // tests included); the server video transport is named file by file. The
    // two mount points §22 cites (routes/index.ts, app/_layout.tsx) are NOT
    // added — they change for every feature, and nothing in them is graded.
    "travel-buddy-standalone/src/services/media/",
    "travel-buddy-standalone/src/services/media.ts",
    "travel-buddy-standalone/src/services/mediaUrl.ts",
    "travel-buddy-standalone/src/services/stories.ts",
    "travel-buddy-standalone/src/services/memories.ts",
    "travel-buddy-standalone/src/components/PostcardComposer.tsx",
    "travel-buddy-standalone/src/components/PulseCreate.tsx",
    "travel-buddy-standalone/src/components/__tests__/PostcardComposer.videoPoster.component.test.tsx",
    "travel-buddy-standalone/src/components/__tests__/PulseCreate.locationPrivacy.component.test.tsx",
    "artifacts/api-server/src/lib/videoProbe.ts",
    "artifacts/api-server/src/lib/mediaPosterPath.ts",
    "artifacts/api-server/src/lib/mediaVideoPoster.ts",
    "artifacts/api-server/src/lib/postcardMediaTransport.ts",
    "artifacts/api-server/src/lib/postSchemas.ts",
    "artifacts/api-server/src/routes/postcardMediaTransport.ts",
    "artifacts/api-server/src/routes/mediaVideoPoster.ts",
    "artifacts/api-server/src/test/mediaVideoTransport.test.ts",
    "artifacts/api-server/src/test/mediaVideoPosterGeneral.test.ts",
    "artifacts/api-server/src/test/mediaPrivacyClientParity.test.ts",
    // WIDENED 2026-09-26 by the integration owner at the lane D merge (census-
    // media §22, §23.4): the root layout is where §22 mounts the upload resume
    // (MD284) and the offline warm-up (MD295–MD301), and §22 cites both mounts.
    // Watching it kept the census above its 96% floor after the four lanes met.
    "travel-buddy-standalone/app/_layout.tsx",
    // WIDENED 2026-09-26 by census-media §23.8, because check:census-scope-coverage
    // required it: §20.5 (P1), §23.2 and §23.8 grade production's canonical state
    // on this migration being applied (it is what 3321's precondition reads), so
    // a change to it must age the census. routes/index.ts stays out, as above.
    "artifacts/api-server/src/migrations/2470_media_asset_canonical_columns_flag_agnostic.sql",
    // WIDENED 2026-09-26 by census-media §28.8: the byte-gate route that signs
    // (or masks) every Media object; §28.8 grades its header mask and §23.7 its
    // variant path through lib/mediaAccess, so a change to it must age the census.
    "artifacts/api-server/src/routes/mediaFile.ts",
    // WIDENED 2026-09-26 by the integration owner at the lane I merge (census-
    // media §29.7, §28.9): MD288's C verdict rests on these two routes passing the
    // viewer's point (gated on `ok`) to the World shell and to Search, so a change
    // to either can falsify it. Lane I measured media at 215/225 without them.
    "travel-buddy-standalone/app/media-search/index.tsx",
    "travel-buddy-standalone/app/media-world/index.tsx",
    // WIDENED 2026-09-26 by census-media §30 (Lane J), because
    // check:census-scope-coverage required it (93% against the 96% floor).
    // MD338's C rests on the boot call that starts the processing worker
    // (src/index.ts), on the flag seed that gates it and the retry (3338), on
    // the suite that proves both and the double and fixtures that suite trusts
    // (§30.8), on the GPS parser the worker refuses a stored still with and
    // the test that measured sharp's GPS gap, on the two repo guards §30.3
    // says now cover the worker, and on the lifecycle test §30.11 item 4 finds
    // vacuous. A change to any of them can falsify §30, so each ages the census.
    "artifacts/api-server/src/index.ts",
    "artifacts/api-server/src/migrations/3338_media_processing_worker_flag.sql",
    "artifacts/api-server/src/test/mediaProcessingWorker.test.ts",
    "artifacts/api-server/src/test/helpers/postgrestOracle.ts",
    "artifacts/api-server/src/test/videoProbeFixtures.ts",
    "artifacts/api-server/src/lib/exifFacts.ts",
    "artifacts/api-server/src/test/exifFacts.test.ts",
    "artifacts/api-server/src/test/schedulerRegistration.test.ts",
    "artifacts/api-server/src/test/backgroundWorkerWiring.test.ts",
    "artifacts/api-server/src/test/mediaAssetsRecord.test.ts",
    // WIDENED 2026-09-26 by census-media §32 (Lane M), because
    // check:census-scope-coverage required it (95% against the 96% floor).
    // §32.4 grades the backfill script as staging its rows with the signature
    // the dimension sweep finishes (mediaCanonicalRead's B3), and §32.6's
    // privacy case drives the byte gate through a copy of mediaAccess.test.ts's
    // query double. A change to either can falsify §32, so each ages the census.
    "artifacts/api-server/src/scripts/backfill-media-assets.ts",
    "artifacts/api-server/src/test/mediaAccess.test.ts",
    // WIDENED 2026-09-26 by census-media §31.13 (lane K), because
    // check:census-scope-coverage required it (228/239, 95%, against the 96%
    // floor). MD403's §31.13 evidence rests on three shared components'
    // optional props (StampButton's tone, AppHeader's overlayTint, EmptyState's
    // primaryAction.fill) rendering as Media needs while every other caller is
    // unchanged, so a change to any of them can falsify it. The Grid's
    // full-screen viewer and the Media tab route are measured and fixed there
    // too; the coverage check cannot see them (its citation pattern skips
    // brackets and parentheses), but the same reason applies.
    "travel-buddy-standalone/src/components/stamps/StampButton.tsx",
    "travel-buddy-standalone/src/components/ui/AppHeader.tsx",
    "travel-buddy-standalone/src/components/ui/EmptyState.tsx",
    "travel-buddy-standalone/app/media-viewer/[id].tsx",
    "travel-buddy-standalone/app/(tabs)/media.tsx",
    // WIDENED 2026-09-27 by census-media §31.13 (lane K, pass 4), because
    // check:census-scope-coverage required it (245/258, 95%, against the 96%
    // floor). MD403's §31.13.5 evidence rests on CreationAssist's optional
    // quietColor reaching CorrectionBanner and EntitySuggestionRow, so a change
    // to any of the three can falsify it. census-input-intelligence watches the
    // same files through its directory entry; watching them here as well makes
    // an edit to them age both censuses, which is the point.
    "travel-buddy-standalone/src/platform/input-assistance/creation/CreationAssist.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/CorrectionBanner.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/EntitySuggestionRow.tsx",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §20's canonical contract — MD38, MD41, MD43, MD255, MD274·MD351 and MD369 — the audience rule, the two migrations and the proof suites §20.2 and §20.8 name.
    "artifacts/api-server/src/lib/mediaVisibility.ts",
    "artifacts/api-server/src/lib/postVisibility.ts",
    "artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql",
    "artifacts/api-server/src/migrations/3321_media_moderation_canonical_state.sql",
    "artifacts/api-server/src/test/mediaCanonicalLayers.test.ts",
    "artifacts/api-server/src/test/mediaModerationCanonical.test.ts",
    "artifacts/api-server/src/test/db/mediaCanonicalContract.db.test.ts",
    "artifacts/api-server/src/test/mediaEvidenceEligibility.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): verdict-row evidence for MD51 (the Shared Moment edge), MD150 (the conflict state on the live-claim envelope) and MD252 (the sequencing anchor's tests).
    "artifacts/api-server/src/migrations/2064_shared_moments_foundation.sql",
    "artifacts/api-server/src/lib/liveClaimRead.ts",
    "artifacts/api-server/src/test/compassCensusClosure.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the Expo routes MD25, MD26 and MD28 are reached through, and the place screens MD153 and MD262 are graded on.
    "travel-buddy-standalone/app/media-map/index.tsx",
    "travel-buddy-standalone/app/media-timeline/index.tsx",
    "travel-buddy-standalone/app/media-contribute/index.tsx",
    "travel-buddy-standalone/app/place/[id].tsx",
    "travel-buddy-standalone/src/components/place/living/LivingDestinationPage.tsx",
    "travel-buddy-standalone/src/components/selectors/LocationPrivacySelector.tsx",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §9/§10/§12 — MD105's shared hide writer and its suite (mutation M8), MD112's duplicate detector, and the flag seeds §9.9 and §12.8 read the flag-dark ceiling from.
    "artifacts/api-server/src/lib/postHide.ts",
    "artifacts/api-server/src/test/postHide.test.ts",
    "artifacts/api-server/src/lib/inputAssistance/duplicateDetection.ts",
    "artifacts/api-server/src/migrations/2038_media_admin_flags.sql",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): MD227's Tagged bucket (§11.3.2, §13) — the tags table, its writer, and the schema-strict helper and live-schema suite that now back the row.
    "artifacts/api-server/src/migrations/0044_tags_hashtags.sql",
    "artifacts/api-server/src/services/tagging/TaggingService.ts",
    "artifacts/api-server/src/test/helpers/schemaStrictSupabase.ts",
    "artifacts/api-server/src/test/mediaTaggedBucketLiveSchema.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §21.1 E — the gem duplicate scan the add-gem form now shares with /gems/submit, and the gem page's visit-outcome sentence.
    "artifacts/api-server/src/lib/inputAssistance/creation.ts",
    "travel-buddy-standalone/app/gems/submit.tsx",
    "travel-buddy-standalone/app/gems/[id].tsx",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §23.7's client variant request, §24.3's MD288 radius and MD162's blocker (the Map's place projector, its zone model and the bypass guard), §28.7/§28.10's upload refusal proof.
    "travel-buddy-standalone/src/components/PostcardTile.tsx",
    "artifacts/api-server/src/lib/mapProjectPlace.ts",
    "artifacts/api-server/src/routes/mapProjection.ts",
    "artifacts/api-server/src/test/gatewayBypassGuard.test.ts",
    "artifacts/api-server/src/test/mediaUploadHardening.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): MD403 (§31.12.4, §31.13.3, §31.13.5) — the shared components measured inside Media's layouts, the stamp count's reachability, and the absent-prop proof suites.
    "travel-buddy-standalone/src/components/ui/Avatar.tsx",
    "travel-buddy-standalone/src/components/ui/DisplayMediaImage.tsx",
    "travel-buddy-standalone/src/hooks/useStamp.ts",
    "travel-buddy-standalone/src/components/stamps/__tests__/StampButton.tone.component.test.tsx",
    "travel-buddy-standalone/src/components/ui/__tests__/AppHeader.overlayTint.component.test.tsx",
    "travel-buddy-standalone/src/components/ui/__tests__/EmptyState.fill.component.test.tsx",
    "travel-buddy-standalone/src/components/__tests__/CachedImage.fallbackBg.component.test.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/creation/__tests__/CreationAssist.quietColor.component.test.tsx",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): MD338 (§30, §32) — the receipt reader §32.1's privacy argument rests on, and the byte gate's fail-closed suite §30 and §32.9 ran as regression evidence.
    "artifacts/api-server/src/services/intel/PresenceVerifier.ts",
    "artifacts/api-server/src/test/mediaAccessFailClosed.test.ts",
    // WIDENED 2026-09-27 by lane I (census-media §35): the facts §35.5's MD65/MD53/MD58/MD197/MD162 statements and §35.4's owner questions rest on — the Map evidence path and its consent gate, the consent bridge's contract, the consent text in force, 3002's identity boundary, the aggregator's evidence lift and the crowd-flow payload's zone ids.
    "artifacts/api-server/src/lib/intelEvidenceCapture.ts",
    "artifacts/api-server/src/routes/mapObservations.ts",
    "artifacts/api-server/src/lib/intelConsent.ts",
    "travel-buddy-standalone/src/lib/sensing/consentDisclosure.ts",
    "artifacts/api-server/src/migrations/3002_intel_contribution_identity.sql",
    "artifacts/api-server/src/lib/intelProjectionAggregator.ts",
    "artifacts/api-server/src/lib/mapAggregation.ts",
    // WIDENED 2026-09-27 by lane I (census-media §35): the two suites §35.5's MD37 and MD197 statements rest on.
    "artifacts/api-server/src/test/mediaAssetSourceDeclared.test.ts",
    "artifacts/api-server/src/test/mediaContributorReputationSelfOnly.test.ts",
    // WIDENED 2026-09-27 by lane V (census-media §37): MD63/MD269/MD277/MD280/MD283/MD289/MD293 rest on the vendor-stage flags 3355–3358 and the suite that tests the seams (the seams themselves sit under lib/media/, watched above).
    "artifacts/api-server/src/migrations/3355_media_vision_provider_flag.sql",
    "artifacts/api-server/src/migrations/3356_media_moderation_classifier_flag.sql",
    "artifacts/api-server/src/migrations/3357_media_transcoder_flag.sql",
    "artifacts/api-server/src/migrations/3358_media_captions_flag.sql",
    "artifacts/api-server/src/test/mediaVendorSeams.test.ts",
    // WIDENED 2026-09-27 by census-media §33 (lane T, H7): MD403 now grades the shared sheets Media opens — the role tokens, the sheets and the components drawn inside them that §33 changed, the pairs fixture and the design-system regression guard, and the four nested sheets MD403's RED WHEN names as unmeasured.
    "travel-buddy-standalone/src/theme/tokens.ts",
    "travel-buddy-standalone/src/theme/__tests__/sharedSheetContrast.pairs.ts",
    "travel-buddy-standalone/src/theme/__tests__/sharedSheetContrast.consumers.test.ts",
    "travel-buddy-standalone/src/components/selectors/GlobalPlacePicker.tsx",
    "travel-buddy-standalone/src/components/PlanPickerController.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/DisambiguationSheet.tsx",
    "travel-buddy-standalone/src/components/MentionInput.tsx",
    "travel-buddy-standalone/src/components/MentionSuggestionList.tsx",
    "travel-buddy-standalone/src/components/DateTimePickerField.tsx",
    "travel-buddy-standalone/src/components/itinerary/LockTypeSelector.tsx",
    "travel-buddy-standalone/src/components/RichText.tsx",
    "travel-buddy-standalone/src/components/TagPreviewSheet.tsx",
    "travel-buddy-standalone/src/components/ProfilePreviewCard.tsx",
    "travel-buddy-standalone/src/components/EngagementUserListSheet.tsx",
    "travel-buddy-standalone/src/components/ReportSheet.tsx",
    // WIDENED 2026-09-27 by census-media §34 (lane F): the F1/F2 flag seeds every §34 row's ACTIVATION names, the playback manager MD425's tap-to-play rests on, and the suites that prove each flag's OFF state is today and its ON state the spec.
    "artifacts/api-server/src/migrations/3340_media_tab_world_default_flag.sql",
    "artifacts/api-server/src/migrations/3341_media_watch_context_overlay_flag.sql",
    "artifacts/api-server/src/migrations/3342_media_watch_tap_to_play_flag.sql",
    "artifacts/api-server/src/migrations/3343_media_watch_stage24_ranking_flag.sql",
    "artifacts/api-server/src/test/mediaWatchStage24Ranking.test.ts",
    "travel-buddy-standalone/src/hooks/useWatchPlayback.ts",
    "travel-buddy-standalone/src/hooks/__tests__/useWatchPlayback.autoplay.component.test.tsx",
    "travel-buddy-standalone/app/(tabs)/__tests__/media.worldDefault.component.test.tsx",
    "travel-buddy-standalone/app/(tabs)/__tests__/media.worldDefaultSwitch.component.test.tsx",
    "travel-buddy-standalone/app/(tabs)/__tests__/media.watchChip.component.test.tsx",
    // WIDENED 2026-09-27 by lane P (census-media §36): MD262, MD101 and MD82–MD85/MD444's C rest on migrations 3350–3352 and the four suites that prove them, and §36.5's narrowings on the gem/privacy disclosure suite that now asserts them.
    "artifacts/api-server/src/migrations/3350_media_neighborhood_only_location_mode.sql",
    "artifacts/api-server/src/migrations/3351_media_find_busier_flag.sql",
    "artifacts/api-server/src/migrations/3352_media_perspective_vantage.sql",
    "artifacts/api-server/src/test/mediaNeighborhoodOnlyMode.test.ts",
    "artifacts/api-server/src/test/mediaFindBusier.test.ts",
    "artifacts/api-server/src/test/mediaPerspectiveVantage.test.ts",
    "artifacts/api-server/src/test/mediaProductDecisionPlumbing.test.ts",
    "artifacts/api-server/src/test/mediaGemAndPrivacyDisclosure.test.ts",
    // WIDENED 2026-09-27 by lane V (census-media §37.8): MD269's restated evidence — a held or flagged postcard file neither counts nor becomes the passport cover — rests on this suite's §37.8 block.
    "artifacts/api-server/src/test/postcards.test.ts",
    // WIDENED 2026-09-27 by census-media §33.13 (lane T follow-up): what ReportSheet opens for a safety photo — the photo button, the source sheet and the photo card, now measured Media-flow surfaces MD403 rests on.
    "travel-buddy-standalone/src/components/ui/MediaPickerButton.tsx",
    "travel-buddy-standalone/src/components/ui/MediaSourceSheet.tsx",
    "travel-buddy-standalone/src/components/ui/MediaAttachmentTray.tsx",
    // WIDENED 2026-09-27 by census-media §40 (lane R): the viewer's page-dots layout suite, which §40.3 cites as the pin on the dots' own slot (the route file itself is already watched above).
    "travel-buddy-standalone/app/media-viewer/__tests__/pageDots.layout.component.test.tsx",
    // WIDENED 2026-09-27 by census-media §42 (lane Q, integration): the suite that proves Pulse, Discovery event posts and the trip feed apply mapPublicPost's rule, which §42 cites as its evidence; §36's disclosure rule is graded through it outside Media.
    "artifacts/api-server/src/test/postLocationModeOutsideMedia.test.ts",
    // WIDENED 2026-09-27 by lane V (census-media §37.10): the readers of passport_postcards.media_url that §37.10.3's null cover rests on (MD269) — a change to any of them can break "every reader handles a null cover".
    "artifacts/api-server/src/routes/passport.ts",
    "travel-buddy-standalone/src/components/PostcardsTab.tsx",
    "travel-buddy-standalone/src/types/models.ts",
    "travel-buddy-standalone/src/utils/destinationGrouping.ts",
    "travel-buddy-standalone/app/destinations/[city].tsx",
    "travel-buddy-standalone/src/services/profile.ts",
    // WIDENED 2026-09-27 by census-media §37.10 (integration): MD269's activation now names 3359 (a postcard with no countable file gets a null cover), so the migration and its rollback are graded.
    "artifacts/api-server/src/migrations/3359_passport_postcard_cover_nullable.sql",
    "db/rollback/2026-09-27-3359-passport-postcard-cover-nullable-rollback.sql",
    // WIDENED 2026-09-27 by census-media §40.12–§40.13 (lane R, round 2): the inset hook the Gems and Watch rails and the Gems bottom content now take their tab-bar and FAB clearance from; a change to useLayoverAwareBottomInset can move them under the tab button again.
    "travel-buddy-standalone/src/hooks/useBottomInset.ts",
    // WIDENED 2026-09-27 by census-media §44 (lane G1): migration 3362 (the client roles' column grants on posts), its rollback, and the database suite that proves both, which §44 cites as the fix for §42.6 item 5.
    "artifacts/api-server/src/migrations/3362_posts_client_column_grants.sql",
    "db/rollback/2026-09-27-3362-posts-client-column-grants-rollback.sql",
    "artifacts/api-server/src/test/db/postsClientColumnGrants.db.test.ts",
    // WIDENED 2026-09-27 by census-media §43 (lane G2): the owner-aware form of mapPublicPost's place rule that §43's five readers share, and the suite §43 cites as its evidence (including its both-ways cases).
    "artifacts/api-server/src/lib/postPlaceDisclosure.ts",
    "artifacts/api-server/src/test/postLocationModeRemainingReaders.test.ts",
    // WIDENED 2026-09-27 by census-media §44.11 (lane G1 follow-up): migration 3363 (the client roles' column grants on the three tables holding a copy of a post's place), its rollback, and the database suite that proves both.
    "artifacts/api-server/src/migrations/3363_place_copies_client_column_grants.sql",
    "db/rollback/2026-09-27-3363-place-copies-client-column-grants-rollback.sql",
    "artifacts/api-server/src/test/db/placeCopiesClientColumnGrants.db.test.ts",
    // WIDENED 2026-09-27 by census-media §44.18 (lane G1, write boundaries): migrations 3364 (pulse_geo_tags) and 3365 (post_media, 2158's write intent as a narrowing), their rollbacks, and the two database suites that prove them.
    "artifacts/api-server/src/migrations/3364_pulse_geo_tags_write_boundary.sql",
    "db/rollback/2026-09-27-3364-pulse-geo-tags-write-boundary-rollback.sql",
    "artifacts/api-server/src/migrations/3365_post_media_write_boundary.sql",
    "db/rollback/2026-09-27-3365-post-media-write-boundary-rollback.sql",
    "artifacts/api-server/src/test/db/pulseGeoTagsWriteBoundary.db.test.ts",
    "artifacts/api-server/src/test/db/postMediaWriteBoundary.db.test.ts",
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
    // ADDED 2026-09-23 with §31, on the same rule. 3000 REPLACES 2325's function
    // with a locking one and is what §7.4's "transactionally" now rests on, and
    // telegraphUnsendFunctionFake.ts is the single model of that function that
    // three route suites decide against — a change to either is a change to what
    // the unsend rows grade, so both age this census.
    "artifacts/api-server/src/migrations/3000_telegraph_unsend_authoritative.sql",
    "artifacts/api-server/src/test/telegraphUnsendFunctionFake.ts",
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
    // WIDENED 2026-09-22 by the §16/§18 MEDIA / VOICE / COMPASS lane (§34).
    // Five files §34 rests its measurements on, each cited there and none
    // watched before. `check:census-scope-coverage` caught the gap the moment
    // the section landed, which is the check doing exactly its job: a census
    // that cites a file it does not watch is a census that can go stale in
    // silence on its own evidence.
    //
    // `lib/translation.ts` is the important one. §34.1's whole finding is that
    // `DetectLanguageResult.confidence` existed in THAT file and was discarded
    // by `messageTranslation.ts`, so T240 and T242 now rest on the producer as
    // much as on the consumer — and the consumer was already watched while the
    // producer was not. That asymmetry is precisely how §29.3's "a verdict can
    // rest on a file that a cited file CALLS" goes wrong.
    "artifacts/api-server/src/lib/translation.ts",
    "artifacts/api-server/src/migrations/2991_message_translations_confidence.sql",
    "artifacts/api-server/src/test/translationConfidence.test.ts",
    "artifacts/api-server/src/test/telegraphContextObjectsHonesty.test.ts",
    "artifacts/api-server/src/test/voicePipelineAuthority.test.ts",
    // WIDENED A THIRD TIME 2026-09-12: the §1–§11 lane (census-telegraph §10)
    // added the Shared Context Rail, the share contract, the typed kinds, the
    // coordination surface, unsend, memory notes and the lifecycle routes.
    "artifacts/api-server/src/services/telegraph/",
    "artifacts/api-server/src/routes/telegraphShare.ts",
    "artifacts/api-server/src/routes/telegraphKinds.ts",
    "artifacts/api-server/src/routes/telegraphCoordination.ts",
    "artifacts/api-server/src/routes/telegraphLifecycle.ts",
    "artifacts/api-server/src/routes/telegraphMemory.ts",
    // WIDENED 2026-09-16 by the integrating lane at the telegraph merge. VOICE
    // is built (see census-telegraph §30) and its two new paths are cited by
    // that section, so they belong in the scope that ages this census. The
    // client half, `features/telegraph/voice/`, is already covered by the
    // `features/telegraph/` prefix above.
    "artifacts/api-server/src/routes/telegraphVoice.ts",
    "artifacts/api-server/src/migrations/2989_messages_audio_media_type.sql",
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
    // ADDED 2026-09-22 by the §32 reports reconciliation. §32 rules that the
    // unified `public.reports` already satisfies Telegraph's reporting
    // requirement and that no second system may be built — and it rests that
    // ruling partly on the unified path having REAL readers, of which this
    // end-to-end moderation FK verification is one. Same principle as
    // `messagingSwallowedReadHonesty.test.ts` above: a proof a census rests a
    // closure on is a file that census counts. It sits in `src/scripts/`, but
    // it is not the `check*.ts` machinery the note below excludes — it is
    // evidence, and if it is deleted or stops exercising `reports`, §32's
    // ruling should age with it. Citing it without watching it is what pushed
    // this census below its coverage floor.
    "artifacts/api-server/src/scripts/verifyModerationFkE2E.ts",
    // ADDED 2026-09-22 for the coordination-lifecycle lane (census-telegraph §33).
    // The lane's three new suites are the evidence §33 rests T168, T187-T192,
    // T150 and T266 on — the coordination command's two doors, the four §13.2
    // events, the expiry sweeps and the Discover Together intersection. Same
    // principle as the two entries above: a proof a census rests a closure on is
    // a file that census counts, and citing them without watching them is what
    // pushed the coverage ratio below its floor.
    "artifacts/api-server/src/test/telegraphCoordinationLifecycle.test.ts",
    "artifacts/api-server/src/test/telegraphLifecycleEvents.test.ts",
    "artifacts/api-server/src/test/telegraphDiscoverTogether.test.ts",
    // And the suite whose STALE case §33 replaced. T168 used to be closed by a
    // test asserting `POST /telegraph/commands` answers 501 for a §13.1 command
    // "nothing implements" — which stopped being true when the coordination
    // session entity arrived, so the test was pinning a lie. It now asserts the
    // command is issuable, still refuses a call with no idempotency key, and that
    // UNIMPLEMENTED_COMMANDS is EMPTY so the §13.1 partition stays exhaustive.
    // §33 rests T168 on that file; this census must therefore age with it.
    "artifacts/api-server/src/test/telegraphCommandRoute.test.ts",
    // ADDED 2026-09-22 for the saved-messages lane. T80's evidence is this file:
    // it is what pins that an edit records the PREVIOUS body, that a missing
    // `message_edits` table degrades loudly (`recorded: false` and a 503, never
    // `{versions: []}`), and that the history read re-authorizes like the message
    // content it is. T80 stays W on a DEPLOYMENT ceiling — migration 2811 is
    // unapplied to production — so this census must age with the file that would
    // notice if the code stopped behaving that way.
    "artifacts/api-server/src/test/telegraphMessageEditHistory.test.ts",
    // WIDENED 2026-09-22 at the §34/§35 merge. Five proofs these two sections
    // rest verdicts and findings on, none of which this census aged with before.
    // §34 grades the departed-member gates on the first, and names the other two
    // as the reason two unfiltered membership reads in the same file are CORRECT
    // rather than defects — a ruling that stops being true the day either of
    // those suites stops holding the dedupe/rejoin behaviour. §35's two are the
    // red-first evidence for the dispatch-table fail-open and the command
    // vocabulary; a verdict resting on "the table fails closed" must age with the
    // file that would notice if it stopped.
    "artifacts/api-server/src/test/telegraphMembershipHonesty.test.ts",
    "artifacts/api-server/src/test/messagingThreadDedupe.test.ts",
    "artifacts/api-server/src/test/messagingThreadRejoinWrite.test.ts",
    "artifacts/api-server/src/test/telegraphDispatchTablePrototypeKeys.test.ts",
    "artifacts/api-server/src/test/telegraphCreateCoordinationSession.test.ts",
    // WIDENED 2026-09-22 by the location/proximity/privacy lane
    // (census-telegraph §31): §4's Nearby surface and §30A.2's
    // ReachablePersonProjection are built here, and §17.8/§30A.7's device-bound
    // precise location lands on the two /me/location-state handlers and their
    // client. Every path below is CITED by §31, so an edit to any of them ages
    // the seven rows that section moved — which is exactly what should happen
    // to a verdict that rests on a bucket ladder or a fail-closed gate.
    "artifacts/api-server/src/lib/proximityBuckets.ts",
    "artifacts/api-server/src/lib/invisibleMode.ts",
    "artifacts/api-server/src/lib/preciseLocationDevice.ts",
    "artifacts/api-server/src/lib/mapTravelers.ts",
    "artifacts/api-server/src/services/telegraph/",
    "artifacts/api-server/src/routes/nearbyReachable.ts",
    "artifacts/api-server/src/migrations/2990_nearby_reachable_flag.sql",
    "artifacts/api-server/src/routes/location.ts",
    "artifacts/api-server/src/routes/index.ts",
    "artifacts/api-server/src/test/proximityBuckets.test.ts",
    "artifacts/api-server/src/test/invisibleMode.test.ts",
    "artifacts/api-server/src/test/nearbyRankOrderChannel.test.ts",
    "artifacts/api-server/src/test/reachablePersonProjection.test.ts",
    "artifacts/api-server/src/test/reachablePeopleFailClosed.test.ts",
    "artifacts/api-server/src/test/preciseLocationDeviceBinding.test.ts",
    "artifacts/api-server/src/test/nearbyReachableRoute.test.ts",
    "travel-buddy-standalone/src/hooks/useActiveLocation.ts",
    "travel-buddy-standalone/src/hooks/activeLocation.state.ts",
    "travel-buddy-standalone/src/hooks/__tests__/activeLocation.deviceBoundPrecision.test.ts",
    // Cited by §31 as the pattern the client half copies, not as a Telegraph
    // behaviour — but a census that rests an argument on another lane's module
    // should notice when that module changes.
    "travel-buddy-standalone/src/platform/input-assistance/services/policyStore.ts",
    // STILL NOT WATCHED, deliberately: src/scripts/check*.ts, guardRegistry.ts,
    // generateTelegraphInventory.ts, rlsDispositions.ts, the two workflow YAMLs,
    // and the other censuses this one cross-references. Those are machinery and
    // neighbours this census NAMES; none of them is a Telegraph behaviour it
    // GRADES, and the same exclusion is already in force for Sensing and Media.
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): files verdict rows cite — T9/T28/T262/T266's shared-context routes, T262's Trips command route, T344's routes/telegraph.ts, T79's search, T220's two block helpers, T31's 2217 and T290's permissions suite.
    "artifacts/api-server/src/routes/telegraphSharedContext.ts",
    "artifacts/api-server/src/server/trips/commandRoute.ts",
    "artifacts/api-server/src/routes/telegraph.ts",
    "artifacts/api-server/src/services/telegraphSearch.ts",
    "artifacts/api-server/src/lib/blocks.ts",
    "artifacts/api-server/src/lib/exclusionSet.ts",
    "artifacts/api-server/src/migrations/2217_protected_locations.sql",
    "artifacts/api-server/src/test/telegraphProjectionPermissions.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the red-first suites prose sections rest moves and held verdicts on — §14.2/§14.3 (T79, T344/T438), §15, §16.3, §18.2, §19.3, §19.6 item 4, §20.3, §23.2, §24.7 and §27.1–§27.3 (T178, T233, T416).
    "artifacts/api-server/src/test/telegraphDeletedMediaRedaction.test.ts",
    "artifacts/api-server/src/test/telegraphInboxFailsLoud.test.ts",
    "artifacts/api-server/src/test/telegraphShareFamilies.test.ts",
    "artifacts/api-server/src/test/messageLanguageProvenance.test.ts",
    "artifacts/api-server/src/test/telegraphNotFoundHonesty.test.ts",
    "artifacts/api-server/src/test/telegraphDurableContextHonesty.test.ts",
    "artifacts/api-server/src/test/exclusionFailClosedRoutes.test.ts",
    "artifacts/api-server/src/test/telegraphChatOutageHonesty.test.ts",
    "artifacts/api-server/src/test/telegraphLegacyReadMarkerThreshold.test.ts",
    "artifacts/api-server/src/test/telegraphMentionBlockFailClosed.test.ts",
    "artifacts/api-server/src/test/telegraphDeliveryReceipts.test.ts",
    "artifacts/api-server/src/test/telegraphStreamResume.test.ts",
    "artifacts/api-server/src/test/telegraphFanoutBounds.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): code prose arguments rest on — §10.9's shared write gates, §19.6 item 1's retranslate gate, and §33.3's expiry readers that make the availability sweep safe.
    "artifacts/api-server/src/lib/telegraphThreadWrite.ts",
    "artifacts/api-server/src/lib/retranslateGate.ts",
    "artifacts/api-server/src/services/passport/PassportProjectionService.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): schema facts in the frozen legacy migration root — T260's meetups.chat_thread_id join (§11.9) and §16.2's "no CHECK on language_detection_source".
    "migrations/0013_availability_meetups.sql",
    "migrations/0009_translation.sql",
    "migrations/APPLY_THESE_IN_ORDER.sql",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the bare spelling forty T-row citations write; this checker resolves it to the root app/ mock, so it is listed beside the travel-buddy-standalone/app/messages/ prefix above, which holds the screen they grade.
    "app/messages/[id].tsx",
    // WIDENED 2026-09-27 at the merge of main (#529) into the Discovery integration branch: §31.5 cites the executed unsend probe as the evidence that the receipt lock is observed; on main this census's floor predates 1.0.
    "artifacts/api-server/src/test/db/telegraphUnsend.db.test.ts",
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
    "artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts", // census-discovery §70: routes/discoverySearch.ts's searchers moved here
    // ADDED 2026-09-14 on the Map lane's request. `geoZoneSeed.test.ts` now
    // carries M256's evidence — the first assertions in this repository that a
    // cache HIT avoids the read, where eleven map suites had only ever used the
    // `_clear*Cache()` hooks to DEFEAT the cache. It was unwatched, and adding
    // its citation pushed census-map to exactly its coverage floor.
    "artifacts/api-server/src/test/geoZoneSeed.test.ts",
    // ── ADDED 2026-09-21, M42 ───────────────────────────────────────────────
    // The PLACE-lane repair chain and the live suite that proves it. M42's
    // verdict now rests on these three: 2963 repoints the lane at the union of
    // the two tables saves actually land in, 2965 qualifies the `_canon_saves`
    // DELETE that 2963 left unguarded (which the supautils safeupdate guard
    // rejects in every PostgREST-role session, so every call raised and the
    // whole projection rolled back), and the live suite asserts a place
    // projection THROUGH THE POSTGREST PATH rather than in a database where the
    // guard is unarmed. Citing them without watching them is exactly the
    // inversion this scope check exists to catch: the row claiming something IS
    // right would have been the unguarded half. Coverage 95% -> 97%; the floor
    // stays at 96%.
    "artifacts/api-server/src/migrations/2963_memory_projector_place_lane_union.sql",
    "artifacts/api-server/src/migrations/2965_memory_projector_canon_saves_delete_guard.sql",
    "artifacts/api-server/src/test/memoryProjectionLifecycleLive.test.ts",
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
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the Trip Map's two client files — the sources and the model that M6, M71–M82 and M145 cite on their verdict rows.
    "travel-buddy-standalone/src/features/trips/map/tripMapSources.ts",
    "travel-buddy-standalone/src/features/trips/map/tripMapModel.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): M201's executed evidence for the saved-items search.
    "artifacts/api-server/src/test/mapSearchSavedItems.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the PLACE-lane defect §41.3–§41.4 name as M123's blocker and re-execute for M42 before 2963 repointed the lane.
    "artifacts/api-server/src/migrations/2191_memory_projector_content_and_support.sql",
    // WIDENED 2026-09-27 by lane X (census-map §45): M154's executed evidence that the stored evidence reference names no account.
    "artifacts/api-server/src/test/intelEvidenceReference.test.ts",
    // WIDENED 2026-09-27 by lane X (census-map §45.11–§45.12): the local-harness rehearsal of 3360/3361, and the hook that decides whether the map offers the photo step.
    "artifacts/api-server/src/test/db/intelEvidenceSealedReference.db.test.ts",
    "travel-buddy-standalone/src/hooks/usePhotoEvidenceCoverage.ts",
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
    "artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts", // census-discovery §70: routes/discoverySearch.ts's searchers moved here
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
    // ── S39's CONSUMER SIDE, registered 2026-09-26 with decision #9 ────────
    // The formatter was never in this scope, so an edit to the one module
    // S39 is graded on did not age this census. The producer joins it.
    "artifacts/api-server/src/compass/CompassSensingPresence.ts",
    "artifacts/api-server/src/compass/CompassSensingPresenceProducer.ts",
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
    "artifacts/api-server/src/test/compassSensingPresenceProducer.test.ts",
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
    // WIDENED 2026-09-25 (census-sensing §15-§17). check:census-scope-coverage
    // put this census at 89% against a floor of 90%: §16 re-derived S3/S106
    // against the four REAL fusion call sites and §15/§17 cited the modules that
    // replaced deleted evidence, and none of those paths were watched. A census
    // that cites a file to settle a verdict and then does not age when that file
    // moves is the gap the scope check exists to close.
    //
    // The fusion store and its unrepresentability proof — §16's whole subject.
    // `presence/domain/` was already here; `presence/fusion/` is where the
    // store that domain describes actually lives.
    "artifacts/api-server/src/presence/fusion/",
    "artifacts/api-server/src/test/presenceFusionUnrepresentable.test.ts",
    // The four production callers of `presenceFusion.admit`. §16.2 counts them
    // against `read`/`resolve`/`clear`, so a fifth caller — or a first reader —
    // must age this census. Two are already watched (mapAggregation,
    // locateFriendsSession); these are the other two.
    "artifacts/api-server/src/lib/circleResponseShaper.ts",
    "artifacts/api-server/src/domain/trips/services/TripCrewLocationService.ts",
    // Cited by §15.5 as NEW modules in other censuses' scopes — but they are
    // sensing subject matter (grounding envelope, session revocation reach,
    // experience-session bridge) and this census names them.
    "artifacts/api-server/src/compass/CompassLiveClaimContext.ts",
    "artifacts/api-server/src/services/memoryProjections/experienceSessionBridge.ts",
    "artifacts/api-server/src/services/memoryProjections/sessionRevocationReach.ts",
    // Long-standing sensing citations that were never watched. safetyPolicy is
    // cited six times and intelProjectionAggregator four; a verdict resting on
    // six citations of a file nothing watches is exactly the standing-claim
    // problem this corpus is built to catch.
    "artifacts/api-server/src/lib/safetyPolicy.ts",
    "artifacts/api-server/src/lib/intelProjectionAggregator.ts",
    "artifacts/api-server/src/lib/intelConsent.ts",
    "artifacts/api-server/src/routes/hiddenGems.ts",
    "artifacts/api-server/src/test/intelLiveStateEndpoint.test.ts",
    "artifacts/api-server/src/test/intelPresenceVerification.test.ts",
    "artifacts/api-server/src/test/safetyPublicationPath.test.ts",
    // S19/S97/S111/S118 all turn on this migration; §17 grades its precondition.
    "artifacts/api-server/src/migrations/3002_intel_contribution_identity.sql",
    // WIDENED 2026-09-26 (census-sensing §24.4): S112's production caller and
    // its suite. The reach module itself is already watched above; the caller
    // is what changed the row's measurement, so it must age this census too.
    "artifacts/api-server/src/services/accountDeletion/sensingRevocationReach.ts",
    "artifacts/api-server/src/test/accountDeletionSensingRevocationReach.test.ts",
    // WIDENED 2026-09-26 (census-sensing §26): S112's provenance and erasure
    // recompute, the 3312 feature path, the S39/S24 publisher and zone
    // identity, and the client build the six client rows now rest on.
    "artifacts/api-server/src/services/accountDeletion/sensingErasureRecompute.ts",
    "artifacts/api-server/src/test/sensingErasureRecompute.test.ts",
    "artifacts/api-server/src/test/intelProjection.test.ts",
    "artifacts/api-server/src/migrations/3311_intel_snapshot_input_provenance.sql",
    "artifacts/api-server/src/migrations/3312_sensing_anon_contribution_features.sql",
    "artifacts/api-server/src/migrations/3313_sensing_publication_flag.sql",
    "db/rollback/2026-09-26-3311-intel-snapshot-input-provenance-rollback.sql",
    "db/rollback/2026-09-26-3312-sensing-anon-contribution-features-rollback.sql",
    "db/rollback/2026-09-26-3313-sensing-publication-flag-rollback.sql",
    "artifacts/api-server/src/routes/sensingIngest.ts",
    "artifacts/api-server/src/lib/sensingWindowAggregate.ts",
    "artifacts/api-server/src/lib/sensingPublicationScheduler.ts",
    "artifacts/api-server/src/test/sensingPublicationScheduler.test.ts",
    "artifacts/api-server/src/test/sensingReducedFeatures.test.ts",
    "artifacts/api-server/src/test/sensingIngestRoute.test.ts",
    "artifacts/api-server/src/test/sensingConsumersPresence.test.ts",
    "docs/contracts/sensing-contribution-wire-v1.json",
    "docs/ops/sensing-cutover-runbook.md",
    "travel-buddy-standalone/src/lib/sensing/",
    "travel-buddy-standalone/src/services/sensing/",
    "travel-buddy-standalone/src/services/compass.ts",
    "travel-buddy-standalone/src/services/__tests__/compass.sensingZone.test.ts",
    "travel-buddy-standalone/app/_layout.tsx",
    // WIDENED 2026-09-26 (census-sensing §25, owner decision A): the consent-
    // scope proof and the files it grades. S3/S106 moved on this evidence, so
    // every file that carries it must age this census.
    "artifacts/api-server/src/test/presenceFusionConsent.test.ts",
    "artifacts/api-server/src/test/presenceFusionStore.test.ts",
    "artifacts/api-server/src/test/presenceWireCircleCrew.test.ts",
    "artifacts/api-server/src/test/locateFriendsSession.test.ts",
    // The two remaining revocation points the fused read depends on.
    "artifacts/api-server/src/domain/trips/services/TripCrewLiveShareService.ts",
    "artifacts/api-server/src/routes/circle.ts",
    // WIDENED 2026-09-26 (census-sensing §27): S112's memory stage (the writer,
    // 3314 and its proofs), the consent layer S39/S24 now rest on (the scopes a
    // disclosure covers, 3315, the displayed-version rule and the client gate),
    // and the session issuer S18/S32 were re-derived against. §27 grades each.
    "artifacts/api-server/src/services/memoryProjections/sessionMemoryStore.ts",
    "artifacts/api-server/src/test/sessionMemoryStore.test.ts",
    "artifacts/api-server/src/test/db/sessionMemoryLineage.db.test.ts",
    "artifacts/api-server/src/migrations/3314_memory_projection_claim_refs.sql",
    "artifacts/api-server/src/migrations/3315_sensing_anon_surface_consent.sql",
    "db/rollback/2026-09-26-3314-memory-projection-claim-refs-rollback.sql",
    "db/rollback/2026-09-26-3315-sensing-anon-surface-consent-rollback.sql",
    "artifacts/api-server/src/lib/sensingConsentScopes.ts",
    "artifacts/api-server/src/routes/sensingSession.ts",
    "artifacts/api-server/src/test/sensingSessionRoute.test.ts",
    "artifacts/api-server/src/test/intelConsent.test.ts",
    "docs/contracts/sensing-consent-disclosure-v2.md",
    "travel-buddy-standalone/src/components/intel/IntelConsentGate.tsx",
    //
    // DELIBERATELY NOT ADDED, because this census cites them as context rather
    // than grading them, and widening scope to whatever a census mentions would
    // make every census stale on every commit: routes/admin.ts,
    // routes/moderation.ts, routes/meetups.ts, routes/telegraphChat.ts,
    // lib/envValidation.ts, migrations/2402_telegraph_membership_rls_recursion.sql,
    // baseline/20260819_baseline_structure.sql and app.json. Nor any src/scripts/
    // path: the header above records that doing so broke CI on b94a6fae.
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the §2.1 decision route's Live gate, and the boot and router wiring §22.1 (S92), §26.3 (S39/S24) and §27.3 (S18/S32's session issuer) rest on.
    "artifacts/api-server/src/lib/compassDecisionAssembly.ts",
    "artifacts/api-server/src/index.ts",
    "artifacts/api-server/src/routes/index.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the proofs for S79 (§24.1), S83 (§24.2) and S112 (§22.2), S112's production caller (§24.4–§27.1), and §26.4's S49/S92 controlled-test rows.
    "artifacts/api-server/src/test/compassGroundingLiveClaims.test.ts",
    "artifacts/api-server/src/test/sensingConsumersTripWorld.test.ts",
    "artifacts/api-server/src/test/sensingConsumersRevocationReach.test.ts",
    "artifacts/api-server/src/services/accountDeletion/AccountDeletionService.ts",
    "artifacts/api-server/src/test/memoryProjectionScheduler.test.ts",
    "artifacts/api-server/src/test/discoveryCacheBEligibility.test.ts",
    "artifacts/api-server/src/test/mapDiscoveryCandidateConsumer.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): S39's presence-context flag (3004, §21.1) and S29's permission surface — the §26.2 opt-in screen, the client app.json, and the bare app.json S29's §10.5 verdict row writes (this checker resolves it to the root mock), which therefore leaves the not-added list above.
    "artifacts/api-server/src/migrations/3004_sensing_presence_context_flag.sql",
    "travel-buddy-standalone/app/settings/intel-prompts.tsx",
    "travel-buddy-standalone/app.json",
    "app.json",
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
    // WIDENED 2026-09-20 by census-compass §27. Nine more files this census now
    // CITES: the two flag migrations and the Trails migration it applied to
    // production (27.1), the model client that proves CPH-01 is unmeasurable
    // here (27.2), the decision assembler named as branch-only, and the four the
    // new rows reach through.
    "artifacts/api-server/src/migrations/2840_opportunity_engine_flag.sql",
    "artifacts/api-server/src/migrations/2910_discovery_trails.sql",
    "artifacts/api-server/src/lib/openai.ts",
    "artifacts/api-server/src/lib/compassDecisionAssembly.ts",
    "artifacts/api-server/src/services/airport/LayoverTravelTime.ts",
    "artifacts/api-server/src/routes/memories.ts",
    "artifacts/api-server/src/routes/plan.ts",
    "artifacts/api-server/src/routes/mediaFeed.ts",
    "artifacts/api-server/src/test/verifyFlowHighlightControls.test.ts",
    // WIDENED 2026-09-20 by census-compass §26. Sixteen rows were built in one
    // pass and their evidence lives in files this list did not watch: the
    // shared Attention Engine (CX-08), the §8 intent-mode vocabulary (CX-02),
    // the truth-class stamp (CX-04), the Temporal Freedom gap (CT-03), the
    // layover opportunity notifier (CL-04), the plan compiler (CM-02), the
    // lineage migration (CPV2-11), the shared-layer starters on the client
    // (CG-01), and the ten suites that pin them. Cited, therefore watched.
    "artifacts/api-server/src/lib/attentionEngine.ts",
    "artifacts/api-server/src/lib/intentModes.ts",
    "artifacts/api-server/src/lib/sourceTruth.ts",
    "artifacts/api-server/src/lib/discoveryLiveRank.ts",
    "artifacts/api-server/src/lib/discoveryLiveRankRead.ts",
    "artifacts/api-server/src/lib/layoverLiveIntersection.ts",
    "artifacts/api-server/src/lib/liveIntelligence.ts",
    "artifacts/api-server/src/services/airport/LayoverOpportunityNotifier.ts",
    "artifacts/api-server/src/services/media/MediaActionResolver.ts",
    "artifacts/api-server/src/services/notifications/NotificationRouter.ts",
    "artifacts/api-server/src/domain/trips/invariants/TripFreedomEngine.ts",
    "artifacts/api-server/src/migrations/2996_compass_conversations_phase1_schema.sql",
    "artifacts/api-server/src/migrations/2997_compass_recommendation_lineage.sql",
    "artifacts/api-server/src/scripts/checkFlagSchemaPrerequisites.ts",
    "artifacts/api-server/src/scripts/checkMissingLiveColumns.ts",
    "artifacts/api-server/src/test/compassNotificationAttention.test.ts",
    "artifacts/api-server/src/test/compassPlatformChain.test.ts",
    "artifacts/api-server/src/test/compassTruthClassSurfaces.test.ts",
    "artifacts/api-server/src/test/intentModes.test.ts",
    "artifacts/api-server/src/test/tripFreedomGap.test.ts",
    "artifacts/api-server/src/test/compassSeasonDimension.test.ts",
    "artifacts/api-server/src/test/compassRecommendationLineage.test.ts",
    "artifacts/api-server/src/test/compassLayoverConsumption.test.ts",
    "artifacts/api-server/src/test/compassPlanCompiler.test.ts",
    "artifacts/api-server/src/test/compassOutcomeProducers.test.ts",
    "travel-buddy-standalone/app/(tabs)/ai.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/compass/compassPrompt.ts",
    "travel-buddy-standalone/src/platform/input-assistance/compass/CompassStarters.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/compass/__tests__/compassPrompt.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/index.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/selectionWriterCoverage.test.ts",
    // Six more the coverage check reported as cited-but-unwatched once §26's
    // citations were counted: two journey suites, the layover tool-loop suite,
    // the travel-time module CL-03/CL-04 lean on, the `saved` producer CPH-14
    // pins, and the operational-projections flag migration CT-01/CT-03 name.
    "artifacts/api-server/src/test/compass-trip-context.test.ts",
    "artifacts/api-server/src/test/compassDiscoveryTripsJourney.test.ts",
    "artifacts/api-server/src/services/airport/__tests__/layoverCompassToolLoop.test.ts",
    "artifacts/api-server/src/services/airport/LayoverTravelTime.ts",
    "artifacts/api-server/src/routes/saves.ts",
    "artifacts/api-server/src/migrations/2778_trip_operational_projections_flag.sql",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the evidence cited on rows CT-01, CT-09, CT-11, CX-06 and CPH-14, and §11.4's server half of CP-02.
    "artifacts/api-server/src/test/compassCensusClosure.test.ts",
    "artifacts/api-server/src/domain/trips/commands/tripKernel.ts",
    "artifacts/api-server/src/routes/tripDecisions.ts",
    "travel-buddy-standalone/src/services/compass.ts",
    "artifacts/api-server/src/services/passport/PassportConsumerProjections.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the code and suites §17.1, §24.1-§24.3, §25.2-§25.3 and §27.3/§27.6/§27.7 move or keep CX-04, CL-05, CCL-03/08/09/13/14, C1-01, CTG-08, CP-02 and CPH-EVAL on.
    "artifacts/api-server/src/test/compassCpv2Grounding.test.ts",
    "artifacts/api-server/src/lib/compassPolicy.ts",
    "artifacts/api-server/src/test/compassDecision.test.ts",
    "artifacts/api-server/src/test/compassAutopilotRevalidation.test.ts",
    "artifacts/api-server/src/lib/compassDecisionActions.ts",
    "artifacts/api-server/src/test/compassDecisionActions.test.ts",
    "artifacts/api-server/src/test/compassConversationPhase1Schema.test.ts",
    "artifacts/api-server/src/services/interactionPermissions.ts",
    "artifacts/api-server/src/test/helpers/postgrestOrFilter.ts",
    "scripts/src/compass-eval-history.mjs",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): CG-01, CG-02, CG-04 and CP-04 cite `app/(tabs)/ai.tsx`, which the guard resolves to this legacy repo-root mock (113 lines); the lines they cite are travel-buddy-standalone's copy, already watched above, so both are watched rather than one chosen.
    "app/(tabs)/ai.tsx",
  ],
  // Input Intelligence is the thinnest-citing of the six (36 of 81 backticked
  // paths resolve) and the most client-weighted: its subject is the typing
  // surface, so the hooks ARE the measurement, not evidence about it.
  "census-input-intelligence.md": [
    // ── ADDED 2026-09-21 by §28/§29, for the two owner decisions ────────────
    // The census's OWN evidence. §28 cites both files as what proves the two
    // decisions: `displayNameManual.test.ts` that `display_name` resolves to
    // `no_assistance` with no entity types, and `inputPolicyEndpoint.test.ts`
    // that `GET /input-assistance/policies` PROJECTS the registry rather than
    // restating it. A census that cites a test as its proof and does not watch
    // that test is exactly the inversion this check exists to catch: the file
    // that could silently stop proving the claim would be the unguarded one.
    // Coverage 98%(rounded, 166/170) -> back above the floor. The 98% floor
    // was NOT lowered.
    "artifacts/api-server/src/test/displayNameManual.test.ts",
    "artifacts/api-server/src/test/inputPolicyEndpoint.test.ts",
    // ── ADDED 2026-09-21 by the INTEGRATING LANE, for the a11y/§48 lane ─────
    // Four paths its rows cite as evidence. `app/_layout.tsx` is the
    // telemetry-sink mount that G263/G306 rest on, and the bare spelling is
    // what the census writes; both spellings are listed so the coverage check
    // resolves whichever it reads.
    "artifacts/api-server/src/test/inputAssistanceCompatibility.test.ts",
    "artifacts/api-server/src/lib/circleResponseShaper.ts",
    // ── ADDED 2026-09-26 by §33 ──────────────────────────────────────────
    // G136 names these two to EXCLUDE them: every approximate_area site in
    // the tree is the Circles visibility mode, not a Hidden Gem producer.
    // They are watched because that exclusion is EVIDENCE — if a Hidden Gem
    // approximate_area producer ever appeared in either file, G136's W would
    // be wrong and the row should age. NOT_GRADED was not used: it is for
    // machinery, and a service and a route are product code.
    "artifacts/api-server/src/compass/CompassSocialEngine.ts",
    "artifacts/api-server/src/routes/circle.ts",
    "artifacts/api-server/src/lib/locationPurposes.ts",
    "app/_layout.tsx",
    // ── ADDED 2026-09-21 by the INTEGRATING LANE, for the §44/§57 lane ───────
    // Cited as evidence by rows that lane moved. `routes/locations.ts` enters
    // because G232's own account names it as the entry point the alias-append
    // guard sits behind, and a census must watch the file its evidence names.
    // The 98% floor was not touched.
    "artifacts/api-server/src/test/inputAssistanceMetrics.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/TripWishlistPicker.actionCompleted.component.test.tsx",
    "artifacts/api-server/src/routes/locations.ts",
    // ── ADDED 2026-09-21 by the INTEGRATING LANE, for the seven-lane wave ────
    // Five files that rows this wave MOVED now cite. Leaving them cited but
    // unwatched is the inversion check:census-scope-coverage exists to catch:
    // the rows saying something IS right would be the unguarded half. Coverage
    // 96% -> back above its floor; the 98% floor was NOT lowered.
    "travel-buddy-standalone/src/platform/input-assistance/services/localZeroState.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localZeroState.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.zeroState.component.test.tsx",
    "artifacts/api-server/src/test/inputAssistanceSelectionMemoryLiveDbStatus.test.ts",
    "travel-buddy-standalone/scripts/run-node-tests.mjs",
    // ── ADDED 2026-09-21 by §31, for the offline substrate ──────────────────
    // Ten files the eight rows §31.3 moves cite as their evidence. Four of them
    // are SHIPPED DATA, which is the unusual half and the reason this block is
    // not optional: G197's `C` rests on 250 country names and G198's on ~270
    // city names, so an edit to either artifact can falsify a verdict without
    // touching a line of executable code. A census that grades a data file and
    // does not watch it is the same inversion as one that grades a test and
    // does not watch it.
    "travel-buddy-standalone/src/platform/input-assistance/data/countries.ts",
    "travel-buddy-standalone/src/platform/input-assistance/data/cities.ts",
    "travel-buddy-standalone/src/platform/input-assistance/data/languages.ts",
    "travel-buddy-standalone/src/platform/input-assistance/data/interests.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/localDictionary.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localDictionary.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/localRecentsPersistence.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/installLocalRecents.ts",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.offline.component.test.tsx",
    // G198's bound IS this file's key set, and G197's country pin is measured
    // against this one — they are cited as the artifacts the new ones are
    // derived from and pinned to, so a rename or a trimmed list there moves a
    // verdict here.
    "travel-buddy-standalone/src/lib/cityCentroids.ts",
    "travel-buddy-standalone/src/lib/countryCentroids.ts",
    // ── ADDED 2026-09-21 by §14 (the scattered §27–§56 rows) ────────────────
    // Every path below is cited as EVIDENCE by a row §14 moved or re-read, and
    // scope-coverage measured the census at exactly its 98% floor before them:
    // four new citations took it to 95%. A census must watch the file its
    // evidence names, so they are added rather than the floor lowered — which
    // the checker's own error text calls "the one response that is never
    // right". Kept as one dated block so a parallel lane's additions merge
    // beside it instead of into it.
    "travel-buddy-standalone/src/platform/input-assistance/components/ZeroStatePanel.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/SuggestionList.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/SuggestionGroup.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/__tests__/overlaySurfaces.component.test.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/__tests__/suggestionKeyboardNav.component.test.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/components/__tests__/telemetryLinkage.component.test.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.localTier.component.test.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/search/__tests__/smartActions.test.ts",
    // §43/G305's dispatcher and its end-to-end proof live in the app tree: the
    // row is only closed BECAUSE a screen acts on the action, so a change to
    // that screen is exactly the change that must age this census.
    "travel-buddy-standalone/app/search.tsx",
    "travel-buddy-standalone/app/__tests__/search.openCompassDispatch.component.test.tsx",
    // §40/G277's resolver and the test that refutes the row's fifth clause.
    "artifacts/api-server/src/lib/countryCodes.ts",
    "artifacts/api-server/src/test/discoveryCountryRegistry.test.ts",
    // §37/G240's creation-fallback proof.
    "artifacts/api-server/src/test/inputAssistanceCreation.test.ts",
    // §13.1 names this module as the proof that the country registry is
    // CONSUMED rather than duplicated — the load-bearing half of G277's
    // clause 1 — so it belongs in scope with the registry itself.
    "artifacts/api-server/src/lib/stamps/countryLookup.ts",
    // The two halves of the telemetry transport §12.6 says four rows wait on.
    // They were the only two files this census cited and did not watch before
    // this block; they are the telemetry lane's to CHANGE and this census's to
    // WATCH, which are different things.
    "travel-buddy-standalone/src/platform/input-assistance/services/telemetryBatcher.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/telemetryTransport.ts",
    // ── ADDED 2026-09-21 with the §44 sink attachment ───────────────────────
    // The client SDK as a DIRECTORY rather than seven more single files. Every
    // file under it is this census's own subject — the individually-named
    // entries below predate this line and are kept so the history of what was
    // watched when stays readable.
    "travel-buddy-standalone/src/platform/input-assistance/",
    // `app/search.tsx` is G319's call site: the global-search screen is the only
    // place that learns whether the propose-only trip picker was CONFIRMED, so a
    // change to it is exactly the change that must age this census.
    "travel-buddy-standalone/app/search.tsx",
    // …and the picker it learns it from. Its `onSaveFailed` arm is the half that
    // stops `action_completed` reporting ok:true forever.
    "travel-buddy-standalone/src/components/discovery/TripWishlistPicker.tsx",
    // The §44 store's 90-day retention pass lives on the shared intel timer.
    "artifacts/api-server/src/lib/intelRetentionScheduler.ts",
    // The table the §44 sink posts into, and G354's harness. Migrations are not
    // scoped as a directory (see census-media's note on why); this one is named.
    "artifacts/api-server/src/migrations/2950_input_assistance_telemetry_events.sql",
    "artifacts/api-server/src/scripts/measureInputAssistanceLatency.ts",
    "artifacts/api-server/src/scripts/reportInputMetrics.ts",
    // The Wall's analytics module is cited by §14 as the precedent that decides
    // WHICH telemetry needs D4 Intelligence-Contribution consent: it gates
    // `trackRealWorldOutcome` and nothing else. §44's argument for attaching its
    // sink ungated rests on that line being where it is, so a change to it is a
    // change to this census's reasoning, not merely to the Wall's.
    "travel-buddy-standalone/src/features/wall/services/wallAnalytics.ts",
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
    // WIDENED 2026-09-21 by the §23 username-alternatives pass (G147). Same rule
    // as the two widenings above: a census must watch what it CITES. G147 now
    // rests on the LIVE username path rather than on the gateway lane alone, and
    // every file below is part of that path or is the proof of it — the endpoint
    // that answers availability, the shared client rules and hook it feeds, the
    // two shipping screens that render the offers, and the three test files that
    // would otherwise be deletable without ageing this census.
    //
    // `routes/profile.ts` is the one entry here that is not obviously this
    // census's. It is named anyway, and deliberately: `GET /users/check-username`
    // IS the §23 surface a user reaches, so a change to it is exactly the change
    // that must age G147. It is also watched by census-trust, which is correct —
    // one file can be graded by two censuses.
    "artifacts/api-server/src/routes/profile.ts",
    "artifacts/api-server/src/test/profileUsernameCooldownFailOpen.test.ts",
    "travel-buddy-standalone/src/services/profile.ts",
    "travel-buddy-standalone/src/hooks/useUsernameAvailability.ts",
    "travel-buddy-standalone/src/platform/input-assistance/social/usernameValidation.ts",
    "travel-buddy-standalone/src/platform/input-assistance/social/__tests__/usernameValidation.test.ts",
    "travel-buddy-standalone/app/profile/edit/identity.tsx",
    "travel-buddy-standalone/app/profile/edit/__tests__/identity.usernameAlternatives.component.test.tsx",
    "travel-buddy-standalone/app/(auth)/onboarding.tsx",
    // Cited by G5 and G14 as the file where `setTelemetrySink` is exported and
    // never called. That absence is load-bearing for two verdicts, so the file
    // that would end it must age this census.
    "travel-buddy-standalone/src/platform/input-assistance/index.ts",
    // ── ADDED 2026-09-21, third widening of the day ──────────────────────────
    // The eleven paths check:census-scope-coverage reported as CITED-BUT-
    // UNWATCHED after §22 and §23 landed, which took measured coverage to 93%
    // against a 0.98 floor. The floor was NOT touched — it is a ratchet, and
    // lowering it is the one response the check itself calls never right.
    //
    // THE CITY PICKER, three files. G85's whole account now turns on them:
    // DestinationBar is the surface that declares `city_picker`, its test is
    // what pins the declaration, and `app/trip/edit.tsx` is cited as the idiom
    // the declaration follows — if any of the three changes, G85's evidence
    // has moved and this census should age.
    "travel-buddy-standalone/src/components/discovery/DestinationBar.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/DestinationBar.cityPicker.test.ts",
    "travel-buddy-standalone/app/trip/edit.tsx",
    // §23's own guard.
    "artifacts/api-server/src/test/inputTelemetryPrivacyGuard.test.ts",
    // THE SEVEN MAP FILES §22 NAMES. These belong to census-map's subject, not
    // this one, and they are listed here anyway: §22's re-evaluation of the
    // five Map flags reasons about what these deployed consumers do, so a
    // change to any of them can make §22's argument wrong. A census must watch
    // the files its own evidence names, whoever else also grades them.
    "artifacts/api-server/src/routes/mapProjection.ts",
    "artifacts/api-server/src/routes/mapProjectionTemporal.ts",
    "artifacts/api-server/src/lib/mapDisplayResolver.ts",
    "artifacts/api-server/src/lib/mapProjection.ts",
    "artifacts/api-server/src/lib/mapProducers/worldMomentProducer.ts",
    "artifacts/api-server/src/routes/locateFriends.ts",
    "artifacts/api-server/src/routes/safeReturn.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the suites G85/G86/G89/G100/G109/G226/G228/G232 cite on their rows and G57's evidence names, which the old citation pattern never counted.
    "artifacts/api-server/src/test/inputAssistancePersonalization.test.ts",
    "artifacts/api-server/src/test/inputAssistanceSavedEntities.test.ts",
    "artifacts/api-server/src/test/inputAssistanceVenueBinding.test.ts",
    "artifacts/api-server/src/test/inputAssistanceSelectionMemoryLiveDb.test.ts",
    "artifacts/api-server/src/test/canonicalLocations.test.ts",
    "artifacts/api-server/src/test/canonicalSearchKeyProductionShape.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): G359/G364's Compass screen and G147's onboarding screen — the standalone file, and the bare spellings the rows write, which this checker resolves to the root app/ mock (the app/_layout.tsx precedent above).
    "travel-buddy-standalone/app/(tabs)/ai.tsx",
    "app/(tabs)/ai.tsx",
    "app/(auth)/onboarding.tsx",
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
    // NINE, NOT FIVE, AND THE CORRECTION IS THE POINT. §43.3's first draft said
    // "four call sites outside Discovery", counted off a `grep` read through
    // `head -20` — a list cut mid-output, which is the same mistake as reading a
    // census and stopping at §11. Enumerating it properly found nine modules,
    // including three the first count never reached: the entry-requirements
    // ROUTE (five call sites of its own) and the two trips services that resolve
    // the function through a DYNAMIC import, which no ordinary grep for an
    // `import` statement would have surfaced. All nine are watched, because the
    // corrected sentence is a claim about all nine.
    "artifacts/api-server/src/lib/entryRequirements.ts",
    "artifacts/api-server/src/routes/entryRequirements.ts",
    "artifacts/api-server/src/lib/stampHelper.ts",
    "artifacts/api-server/src/lib/stamps/countryLookup.ts",
    "artifacts/api-server/src/lib/stamps/StampCatalogService.ts",
    "artifacts/api-server/src/lib/stamps/xxCatalogRepair.ts",
    "artifacts/api-server/src/domain/trips/services/tripReadiness.ts",
    "artifacts/api-server/src/domain/trips/services/tripBudgetIntel.ts",
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
    // ADDED by census-discovery §47. The suites §47's findings rest on — cache-B
    // revocation, per-viewer isolation of the shared caches, the legacy golden
    // and the season reason — plus the golden fixture and the scenario module
    // that produced it. A weakened golden or a loosened revocation assertion
    // must age this census, or DSV2-05/06's strengthened `C` and DC-25's move
    // stand on evidence nothing watches.
    "artifacts/api-server/src/test/discoveryCacheRevocation.test.ts",
    "artifacts/api-server/src/test/discoveryServePathIsolation.test.ts",
    "artifacts/api-server/src/test/discoverySeasonReason.test.ts",
    "artifacts/api-server/src/test/fixtures/discoveryLegacyGolden.json",
    "artifacts/api-server/src/test/helpers/discoveryLegacyScenarios.ts",
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
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the evidence cited on rows DV-03, DV-05, DV-35, DV-40, DSV2-09 and A05.
    "artifacts/api-server/src/lib/discoveryRecommendationId.ts",
    "artifacts/api-server/migrations/0055_compass_admin.sql",
    "artifacts/api-server/src/lib/compassDecision.ts",
    "artifacts/api-server/src/migrations/2091_discovery_engine_mode_flags.sql",
    "artifacts/api-server/src/migrations/0202_rank_events_living_page_watch_feed_surfaces.sql",
    "artifacts/api-server/src/migrations/0197_rank_events_analytics_columns.sql",
    "artifacts/api-server/src/lib/intentModes.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): DV-83's refusal-envelope consumers — §18.6's audited consumers, §21.2's panel fix and its two failing-first suites, and the tab screen §29.3 leaves open.
    "travel-buddy-standalone/src/components/discovery/DiscoveryCategoryTab.tsx",
    "travel-buddy-standalone/app/(tabs)/_layout.tsx",
    "travel-buddy-standalone/src/components/search/SearchSuggestionsPanel.tsx",
    "travel-buddy-standalone/src/components/search/__tests__/SearchSuggestionsPanel.refusal.component.test.tsx",
    "travel-buddy-standalone/app/__tests__/search.refusal.component.test.tsx",
    "travel-buddy-standalone/app/(tabs)/discovery.tsx",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): §29.3 cites `app/(tabs)/discovery.tsx`, which the guard resolves to the legacy repo-root mock (80 lines); the screen it means is travel-buddy-standalone's, watched just above, so both are watched rather than one chosen.
    "app/(tabs)/discovery.tsx",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): evidence for keeping a verdict — A14 stays W on the layover travel-time provider (provenance row, §39.6), and §41.1 corrects DV-44's evidence with mediaFeed's live watch_feed writer.
    "artifacts/api-server/src/services/airport/LayoverTravelTime.ts",
    "artifacts/api-server/src/routes/mediaFeed.ts",
    // WIDENED 2026-09-27 by census-discovery §48 (P3 telemetry): DV-37/38/39/45 moved to C on the contract module, 3375/3376 and their rollbacks, and six suites; DV-40/46/78/44 stay W on the map-search stamp, the client echo, the dismiss writer/reader and the writer-proof suite.
    "artifacts/api-server/src/lib/discoveryRecommendationRecord.ts",
    "artifacts/api-server/src/routes/mapSearch.ts",
    "artifacts/api-server/src/lib/discoveryDismissed.ts",
    "artifacts/api-server/src/migrations/3375_rank_events_schema_version_admitted.sql",
    "artifacts/api-server/src/migrations/3376_discovery_recommendations_per_request.sql",
    "db/rollback/2026-09-27-3375-rank-events-schema-version-admitted-rollback.sql",
    "db/rollback/2026-09-27-3376-discovery-recommendations-per-request-rollback.sql",
    "artifacts/api-server/src/test/discoveryRecommendationRecord.test.ts",
    "artifacts/api-server/src/test/discoveryRecommendationPropagationE2E.test.ts",
    "artifacts/api-server/src/test/discoveryTelemetryWriters.test.ts",
    "artifacts/api-server/src/test/discoverySurfaceWriterProof.test.ts",
    "artifacts/api-server/src/test/discoveryServeExposureCursor.test.ts",
    "artifacts/api-server/src/test/db/discoveryTelemetryConstraints.db.test.ts",
    "artifacts/api-server/src/test/db/discoveryTelemetryIdempotency.db.test.ts",
    // WIDENED 2026-09-27 by census-discovery §50.10 (integrator): DSV2-04 moves W -> C on the server leg of why-now validity, and this suite is its evidence.
    "artifacts/api-server/src/test/discoveryCandidateWhyNowValidity.test.ts",
    "travel-buddy-standalone/src/hooks/useRankOutcome.ts",
    "travel-buddy-standalone/src/components/discovery/PlaceCard.tsx",
    // WIDENED 2026-09-27 by census-discovery §46 (search safety, lane P1): B01 moves W -> C on
    // the stored-fold reader and 2220's generated column; B04 stays W on the search adapter,
    // the one protected_zones reader it consumes, 2217's table and 3366's FALSE seed; B02 is
    // pinned by its own suite; serve points 8 and 9 consume P3's served-recommendation
    // contract. Each verdict row in §46 cites these, so each is graded and watched.
    "artifacts/api-server/src/lib/discoverySearchCanonical.ts",
    "artifacts/api-server/src/lib/discoverySearchProtection.ts",
    "artifacts/api-server/src/lib/discoverySearchExposure.ts",
    "artifacts/api-server/src/lib/protectedZoneStore.ts",
    "artifacts/api-server/src/migrations/2217_protected_locations.sql",
    "artifacts/api-server/src/migrations/2220_canonical_locations_search_key.sql",
    "artifacts/api-server/src/migrations/3366_discovery_search_protected_zones_flag.sql",
    "db/rollback/2026-09-27-3366-discovery-search-protected-zones-flag-rollback.sql",
    "artifacts/api-server/src/test/discoverySearchSafetyContracts.test.ts",
    "artifacts/api-server/src/test/discoverySearchProtection.test.ts",
    "artifacts/api-server/src/test/discoverySearchCanonicalFold.test.ts",
    "artifacts/api-server/src/test/discoverySearchExposure.test.ts",
    "artifacts/api-server/src/test/discoverySearchQueryPolicy.test.ts",
    "artifacts/api-server/src/test/discoverySearchTestKit.ts",
    "artifacts/api-server/src/test/db/discoverySearchCanonicalFold.db.test.ts",
    "artifacts/api-server/src/test/db/discoverySearchProtection.db.test.ts",
    "artifacts/api-server/src/test/db/discoverySearchPsqlClient.ts",
    // WIDENED 2026-09-27 by §50 (lane P4, client correctness): DSV2-04's client leg (the chips, the reader and its
    // device-clock expiry, the card that mounts them), C19's byline resolver, the served-id echo, the viewer scope that
    // governs both device caches, and the suites that are §50's evidence.
    "travel-buddy-standalone/src/services/discoveryViewerScope.ts",
    "travel-buddy-standalone/src/features/discovery/candidateProjection.ts",
    "travel-buddy-standalone/src/components/discovery/DiscoveryCandidateChips.tsx",
    "travel-buddy-standalone/src/features/discovery/communityByline.ts",
    "travel-buddy-standalone/src/features/discovery/__tests__/candidateProjection.expiry.component.test.ts",
    "travel-buddy-standalone/src/features/discovery/__tests__/candidateProjection.component.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/PlaceCard.candidateProjection.component.test.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/PlaceCard.whyNowExpiry.component.test.tsx",
    "travel-buddy-standalone/src/services/__tests__/discovery.viewerScope.component.test.ts",
    "travel-buddy-standalone/src/hooks/__tests__/useCommunityDiscovery.viewerScope.component.test.tsx",
    "travel-buddy-standalone/src/hooks/__tests__/useRankOutcome.recommendationId.component.test.ts",
    "travel-buddy-standalone/src/context/__tests__/SessionContext.discoveryViewer.component.test.tsx",
    // WIDENED 2026-09-27 by census-discovery §51 (P7 Trails): DV-20, DV-25 and DC-02 moved to C on the two Trail libraries this census grades and had never watched, migrations 3380/3381 and their rollbacks, and the Trails suites whose red-before runs carry every §51 verdict; the harness bridge is watched because the database suite's evidence runs through it.
    "artifacts/api-server/src/lib/discoveryTrailObject.ts",
    "artifacts/api-server/src/lib/discoveryTrailHealth.ts",
    "artifacts/api-server/src/migrations/3380_content_trails_label_cap_serialised.sql",
    "artifacts/api-server/src/migrations/3381_trail_lifecycle_transitions.sql",
    "db/rollback/2026-09-27-3380-content-trails-label-cap-serialised-rollback.sql",
    "db/rollback/2026-09-27-3381-trail-lifecycle-transitions-rollback.sql",
    "artifacts/api-server/src/test/discoveryTrailServedIds.test.ts",
    "artifacts/api-server/src/test/discoveryTrailAccess.test.ts",
    "artifacts/api-server/src/test/discoveryTrailSchemaContract.test.ts",
    "artifacts/api-server/src/test/discoveryTrailRoutes.test.ts",
    "artifacts/api-server/src/test/discoveryTrailProvenance.test.ts",
    "artifacts/api-server/src/test/db/trailsConstraints.db.test.ts",
    "artifacts/api-server/src/test/db/trailsService.db.test.ts",
    "artifacts/api-server/src/test/db/trailPostgrestBridge.ts",
    // WIDENED 2026-09-27 by census-discovery §52 (P10/P11 creator ledger): DV-65/66/67/68/69/63,
    // DV-26 and DC-23 move N -> W and DV-56..60/64/74 are re-graded on these migrations, their
    // rollbacks, the creator-ledger modules, the two route files and the suites that pin them.
    // Each §52 verdict row cites them, so each is graded and watched.
    "artifacts/api-server/src/migrations/3385_creator_share_ledger_includes_creator_entries.sql",
    "artifacts/api-server/src/migrations/3386_creator_attribution_recommendation_link.sql",
    "artifacts/api-server/src/migrations/3387_creator_ledger_integrity_and_audit.sql",
    "db/rollback/2026-09-27-3385-creator-share-ledger-includes-creator-entries-rollback.sql",
    "db/rollback/2026-09-27-3386-creator-attribution-recommendation-link-rollback.sql",
    "db/rollback/2026-09-27-3387-creator-ledger-integrity-and-audit-rollback.sql",
    "artifacts/api-server/src/lib/creatorShareCanonical.ts",
    "artifacts/api-server/src/lib/creatorServedRecommendation.ts",
    "artifacts/api-server/src/lib/creatorRuleEvaluation.ts",
    "artifacts/api-server/src/lib/creatorLedgerStatus.ts",
    "artifacts/api-server/src/lib/creatorLedgerPlans.ts",
    "artifacts/api-server/src/lib/creatorAttributionScheduler.ts",
    "artifacts/api-server/src/services/creators/CreatorAttributionService.ts",
    "artifacts/api-server/src/services/creators/CreatorLedgerOperations.ts",
    "artifacts/api-server/src/services/creators/CreatorLedgerReader.ts",
    "artifacts/api-server/src/services/creators/CreatorAttributionProducers.ts",
    "artifacts/api-server/src/services/creators/PayoutProvider.ts",
    "artifacts/api-server/src/services/ledger/CanonicalShareReader.ts",
    "artifacts/api-server/src/routes/creatorEconomy.ts",
    "artifacts/api-server/src/routes/adminCreatorLedger.ts",
    "artifacts/api-server/src/test/creatorLedgerPure.test.ts",
    "artifacts/api-server/src/test/creatorPayoutProviderBoundary.test.ts",
    "artifacts/api-server/src/test/creatorLedgerMigrationShape3385.test.ts",
    "artifacts/api-server/src/test/creatorAttributionScheduler.test.ts",
    "artifacts/api-server/src/test/creatorTypeService.test.ts",
    "artifacts/api-server/src/test/creatorLedgerRowSchemaDrift.test.ts",
    "artifacts/api-server/src/test/db/creatorLedgerLifecycle.db.test.ts",
    "artifacts/api-server/src/test/db/creatorLedgerRoutes.db.test.ts",
    "artifacts/api-server/src/test/db/creatorLedgerPsqlClient.ts",
    // WIDENED 2026-09-27 by census-discovery §53 (people privacy adapters, lane P5x): A24 moves
    // N -> C on the Invisible gate for every Discovery people surface; B03 stays W with four of
    // its five legs built on the marketplace reader; the /community byline avatar gate and the
    // opt-out refusal are §53's residual repairs. Each verdict row cites these, so each is watched.
    "artifacts/api-server/src/lib/discoveryPeoplePrivacy.ts",
    "artifacts/api-server/src/lib/discoveryPeopleBuddy.ts",
    "artifacts/api-server/src/test/discoveryPeopleInvisible.test.ts",
    "artifacts/api-server/src/test/discoveryPeopleBuddy.test.ts",
    "artifacts/api-server/src/test/discoveryCommunityAvatar.test.ts",
    // A24's row rests on the one definition of Invisible it consumes, and A08's on the
    // client suite that pins the legacy-typeahead latch; both are graded, so both are watched.
    "artifacts/api-server/src/lib/invisibleMode.ts",
    "travel-buddy-standalone/src/hooks/__tests__/useGlobalSearchSuggestions.singleSystem.component.test.tsx",
    // WIDENED 2026-09-27 by census-discovery §55 (P6 outcome measurement): DV-41 moved to W on the dwell writer, its
    // vocabulary, the 3395 flag and rollback, the client emitter, its hook and the sheet that mounts it; DSV2-12 and DV-19
    // moved to W on the two read-only reports, their read and scripts; and the suites whose red-before runs carry them.
    "artifacts/api-server/src/lib/discoveryDwell.ts",
    "artifacts/api-server/src/lib/discoveryDwellVocabulary.ts",
    "artifacts/api-server/src/lib/discoveryTraceCoverage.ts",
    "artifacts/api-server/src/lib/discoveryOutcomeReport.ts",
    "artifacts/api-server/src/lib/discoveryTraceRead.ts",
    "artifacts/api-server/src/scripts/reportDiscoveryTraceCoverage.ts",
    "artifacts/api-server/src/scripts/reportDiscoveryOutcomes.ts",
    "artifacts/api-server/src/migrations/3395_discovery_dwell_telemetry_flag.sql",
    "db/rollback/2026-09-27-3395-discovery-dwell-telemetry-flag-rollback.sql",
    "artifacts/api-server/src/test/discoveryDwell.test.ts",
    "artifacts/api-server/src/test/discoveryTraceCoverage.test.ts",
    "artifacts/api-server/src/test/discoveryOutcomeReport.test.ts",
    "artifacts/api-server/src/test/discoveryTraceRead.test.ts",
    "artifacts/api-server/src/test/db/discoveryOutcomeMeasurement.db.test.ts",
    "travel-buddy-standalone/src/services/discoveryDwell.ts",
    "travel-buddy-standalone/src/hooks/useDiscoveryDwell.ts",
    "travel-buddy-standalone/src/components/discovery/PlaceDetailSheet.tsx",
    "travel-buddy-standalone/src/services/__tests__/discoveryDwell.component.test.ts",
    "travel-buddy-standalone/src/hooks/__tests__/useDiscoveryDwell.component.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/PlaceDetailSheet.dwell.component.test.tsx",
    // WIDENED 2026-09-27 by §54 (lane P9, database and rollout): DV-71 and DC-15 move W -> C on 3390, the
    // query-path document and its check; DV-82's seven producers; DV-72's rebuild proofs. Each file below is a
    // verdict's evidence, so a weakened migration, test or registry must age this census.
    "artifacts/api-server/src/lib/discoveryStopMeasurements.ts",
    "artifacts/api-server/src/migrations/3390_discovery_rls_explicit_policies.sql",
    "artifacts/api-server/src/migrations/3391_discovery_stop_condition_measurements.sql",
    "db/rollback/2026-09-27-3390-discovery-rls-explicit-policies-rollback.sql",
    "db/rollback/2026-09-27-3391-discovery-stop-condition-measurements-rollback.sql",
    "artifacts/api-server/src/scripts/checkDiscoveryQueryPaths.ts",
    "artifacts/api-server/src/test/discoveryStopSevenConditions.test.ts",
    "artifacts/api-server/src/test/discoveryQueryPathsCheck.test.ts",
    "artifacts/api-server/src/test/db/discoveryRlsExplicitPolicies.db.test.ts",
    "artifacts/api-server/src/test/db/discoveryStopMeasurements.db.test.ts",
    "artifacts/api-server/src/test/db/discoveryDerivedRebuild.db.test.ts",
    "docs/discovery/query-paths.md",
    "docs/discovery/query-paths-explain.sql",
    // ── §56 (lane P5-A, cross-architecture adapters I) ── the files §56's verdict rows rest on. A13/A14: the
    // Hidden Gems layover window, and the surfaces §56.3 re-derived for A13 (Compass, Safe Return, Layover's own
    // recommendations). DV-77: the abandoned-upload sweep, its scheduler and flag, the ingest route and the relay.
    // A21: what Telegraph can execute. DV-51: the graph builder. Each is graded by a §56 row, so each is watched.
    "artifacts/api-server/src/lib/discoveryLayoverGems.ts",
    "artifacts/api-server/src/test/discoveryLayoverGems.test.ts",
    "artifacts/api-server/src/test/discoveryLayoverMode.test.ts",
    "artifacts/api-server/src/test/hiddenGems.test.ts",
    "artifacts/api-server/src/services/airport/LayoverCompassService.ts",
    "artifacts/api-server/src/services/airport/LayoverSafeReturnService.ts",
    "artifacts/api-server/src/services/airport/LayoverReturnEscalation.ts",
    "artifacts/api-server/src/services/airport/LayoverRecommendationService.ts",
    "artifacts/api-server/src/services/media/PendingUploadSweep.ts",
    "artifacts/api-server/src/lib/media/pendingUploadSweepScheduler.ts",
    "artifacts/api-server/src/migrations/3400_media_pending_upload_sweep_flag.sql",
    "db/rollback/2026-09-27-3400-media-pending-upload-sweep-flag-rollback.sql",
    "artifacts/api-server/src/test/mediaPendingUploadSweep.test.ts",
    "artifacts/api-server/src/routes/postcards.ts",
    "artifacts/api-server/src/lib/mediaAccess.ts",
    "artifacts/api-server/src/routes/telegraphCommands.ts",
    "artifacts/api-server/src/compass/CompassGraphEngine.ts",
    // WIDENED 2026-09-27 by census-discovery §57 (cross-architecture adapters II, lane P5-B):
    // A25's Map fold and its two suites, A10's newly named direct Trip reader, A07/A03's
    // live-safety suites, A11's property suite and A10's inventory ratchet. Every §57 verdict
    // row cites these, so each is watched. lib/liveClaimRead.ts is watched too: §57's E1 and
    // F1 rest on its expiry filter and its failed-read branch. compass/CompassLiveConstraints.ts,
    // cited only to name another lane's gate, is declared NOT-GRADED in the census.
    "artifacts/api-server/src/lib/mapDiscoveryCandidates.ts",
    "artifacts/api-server/src/lib/liveClaimRead.ts",
    "artifacts/api-server/src/services/location/DiscoveryLocationContext.ts",
    "artifacts/api-server/src/test/mapDiscoveryCandidateConsumer.test.ts",
    "artifacts/api-server/src/test/mapDiscoveryCandidateAdapter.test.ts",
    "artifacts/api-server/src/test/discoveryLiveRank.test.ts",
    "artifacts/api-server/src/test/discoveryLiveSafetyPrecedence.test.ts",
    "artifacts/api-server/src/test/discoveryLiveSafetyCompassPath.test.ts",
    "artifacts/api-server/src/test/discoveryFreeTimeDuplicate.test.ts",
    "artifacts/api-server/src/test/discoveryTripReadInventory.test.ts",
    // §56.14 (integrator): the snapshot entry fix's suite; A13 and A14 are restated on it.
    "artifacts/api-server/src/test/layoverSnapshotEntry.test.ts",
    // census-discovery §59 (verification lane P12): its own suites and bridge.
    "artifacts/api-server/src/test/db/discoveryVerifyBridge.ts",
    "artifacts/api-server/src/test/db/discoveryVerifyChain.db.test.ts",
    "artifacts/api-server/src/test/db/discoveryVerifyExplain.db.test.ts",
    "artifacts/api-server/src/test/db/discoveryVerifyPhase03.db.test.ts",
    "artifacts/api-server/src/test/discoveryVerifyAudit.test.ts",
    // §59's graded evidence outside Discovery's own files: DC-26's class suites
    // and DV-76's tagging code, test and the production baseline it reads.
    "artifacts/api-server/baseline/20260819_baseline_structure.sql",
    "artifacts/api-server/src/lib/enrichSpans.ts",
    "artifacts/api-server/src/services/tagging/TaggingService.ts",
    "artifacts/api-server/src/test/tagging.test.ts",
    "artifacts/api-server/src/test/portavaRank.test.ts",
    "artifacts/api-server/src/test/discoveryPde.test.ts",
    "artifacts/api-server/src/test/placeMomentumSqlParity.test.ts",
    "artifacts/api-server/src/test/creatorLedgerProperties.test.ts",
    "artifacts/api-server/src/test/ciWorkflowArchitecture.test.ts",
    "artifacts/api-server/src/test/discoveryDivergenceReport.test.ts",
    // WIDENED 2026-09-27 by census-discovery §60 (client consumers + the end-to-end leg, lane P13):
    // DC-33's route→client suite, DV-83's static consumer guard and its two new proof suites.
    // The client files §60 grades (services/discovery.ts, DiscoveryCategoryTab.tsx, ForYouTab.tsx,
    // the rail, the community/suggest hooks) were already watched.
    "artifacts/api-server/src/test/discoveryClientRouteE2E.test.ts",
    "travel-buddy-standalone/src/services/__tests__/discoveryRefusalConsumers.guard.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryCategoryTab.loadMoreRefusal.component.test.tsx",
    "travel-buddy-standalone/src/hooks/__tests__/useGlobalSearchSuggestions.refused.component.test.tsx",
    // WIDENED 2026-09-27 by §58 (lane P8, trending and ecosystem): DV-80 moves N -> W on the monitor report; DC-21,
    // DV-33 and DC-07 stay W on the read-only trend API, 3410's snapshot parity and their suites. Each is evidence.
    "artifacts/api-server/src/lib/discoveryTrendExplanation.ts",
    "artifacts/api-server/src/lib/discoveryEcosystemGovernor.ts",
    "artifacts/api-server/src/routes/discoveryTrending.ts",
    "artifacts/api-server/src/scripts/reportDiscoveryEcosystem.ts",
    "artifacts/api-server/src/migrations/3410_discovery_trend_snapshot_parity.sql",
    "db/rollback/2026-09-27-3410-discovery-trend-snapshot-parity-rollback.sql",
    "artifacts/api-server/src/test/discoveryTrendingApi.test.ts",
    "artifacts/api-server/src/test/discoveryEcosystemGovernor.test.ts",
    "artifacts/api-server/src/test/db/discoveryTrendSnapshotParity.db.test.ts",
    "artifacts/api-server/src/test/db/discoveryEcosystemReport.db.test.ts",
    // census-discovery §62 (P15): migrations 3420–3422 and their rollbacks, its
    // suites, and the two files DV-76 now grades from — the tagging route P3
    // drives and the permission engine whose 'nobody' gap P4 pins.
    "artifacts/api-server/src/migrations/3420_rank_events_outcome_receipts.sql",
    "artifacts/api-server/src/migrations/3421_ranking_debug_samples_content_id_nullable.sql",
    "artifacts/api-server/src/migrations/3422_tags_client_write_boundary.sql",
    "db/rollback/2026-09-27-3420-rank-events-outcome-receipts-rollback.sql",
    "db/rollback/2026-09-27-3421-ranking-debug-samples-content-id-nullable-rollback.sql",
    "db/rollback/2026-09-27-3422-tags-client-write-boundary-rollback.sql",
    "artifacts/api-server/src/test/discoveryKeyedOutcome.test.ts",
    "artifacts/api-server/src/test/discoveryDebugSample.test.ts",
    "artifacts/api-server/src/test/discoveryPdeGraphReading.test.ts",
    "artifacts/api-server/src/test/discoveryPdeGraphReading.fixture.ts",
    "artifacts/api-server/src/test/discoveryQueryPathsConstraints.test.ts",
    "artifacts/api-server/src/routes/tags.ts",
    "artifacts/api-server/src/services/interactionPermissions.ts",
    // WIDENED 2026-09-27 by census-discovery §61 (P14, Trails integrity): DC-03 moves on 3415 and
    // the service seam that calls it; DC-20 is re-graded on the attach check; DV-72 is re-graded on
    // 3416's projection. Every §61 verdict row cites these, their rollbacks or the suites that were
    // seen red, so each is watched.
    "artifacts/api-server/src/services/trails/trailProposal.ts",
    "artifacts/api-server/src/services/trails/trailAttachIntegrity.ts",
    "artifacts/api-server/src/migrations/3415_trail_proposal_serialised.sql",
    "artifacts/api-server/src/migrations/3416_trail_relations_projection.sql",
    "db/rollback/2026-09-27-3415-trail-proposal-serialised-rollback.sql",
    "db/rollback/2026-09-27-3416-trail-relations-projection-rollback.sql",
    "artifacts/api-server/src/test/discoveryTrailIntegrity.test.ts",
    "artifacts/api-server/src/test/db/trailsProposalRace.db.test.ts",
    "artifacts/api-server/src/test/db/trailsAttachIntegrity.db.test.ts",
    "artifacts/api-server/src/test/db/trailRelationsRebuild.db.test.ts",
    // §61 integrator addendum: DV-20's letter fold, DV-25's SQL store (3417, its rollback) and the suite that pins it.
    "artifacts/api-server/src/lib/discoveryTrailFold.ts",
    "artifacts/api-server/src/migrations/3417_place_momentum_dismiss_excluded.sql",
    "db/rollback/2026-09-27-3417-place-momentum-dismiss-excluded-rollback.sql",
    "artifacts/api-server/src/test/db/placeMomentumDismiss.db.test.ts",
    // §63 (lane P16): the evidence DV-76, DV-37 and DV-52 are restated from.
    "artifacts/api-server/src/test/tagPermissionVocabulary.test.ts",
    "artifacts/api-server/src/test/discoveryServedGraphReading.test.ts",
    "artifacts/api-server/src/test/fixtures/discoveryServedGraphReadingGolden.json",
    "travel-buddy-standalone/src/hooks/__tests__/useRankOutcome.clientEventId.component.test.ts",
    "travel-buddy-standalone/src/services/__tests__/rankEvents.clientEventId.component.test.ts",
    "travel-buddy-standalone/src/hooks/__tests__/useRankOutcome.component.test.ts",
    // census-discovery §66 (re-verification lane P20): DV-30, C32, DC-26 and B01 move C -> W on this suite.
    "artifacts/api-server/src/test/discoveryVerifyAudit2.test.ts",
    // WIDENED 2026-09-27 by census-discovery §64 (P17, Trail member visibility): DC-20's re-grade
    // cites the two suites that were seen red on the event and route rules and on the counts.
    "artifacts/api-server/src/test/discoveryTrailMemberVisibility.test.ts",
    "artifacts/api-server/src/test/db/trailsMemberVisibility.db.test.ts",
    // census-discovery §69 (row audit P29): the restated DV-53, DV-55, DC-24, DC-13, DV-12, DC-01 and DV-70 statements cite this suite.
    "artifacts/api-server/src/test/discoveryRowAudit29.test.ts",
    // §69 also cites these two: DV-54's restated repeated-history leg rests on the seen-penalty case, and DV-75's on the third verdict job.
    "artifacts/api-server/src/test/discoveryCategoryAffinity.test.ts",
    ".github/workflows/unwired-checks.yml",
    // census-discovery §68 (lane P21): DC-17's store-owned versions and place_momentum.feature_version
    // (3435, its rollback), A03's signal-grounded nearby_now sentence, and the suites both rows cite.
    "artifacts/api-server/src/migrations/3435_place_momentum_feature_version.sql",
    "db/rollback/2026-09-28-3435-place-momentum-feature-version-rollback.sql",
    "artifacts/api-server/src/test/discoveryDerivedProvenance.test.ts",
    "artifacts/api-server/src/test/discoveryDerivedProvenanceGolden.test.ts",
    "artifacts/api-server/src/test/discoveryReasonTruth.test.ts",
    "artifacts/api-server/src/test/db/placeMomentumFeatureVersion.db.test.ts",
    "artifacts/api-server/src/test/discoveryDerivedStoreProvenance.test.ts",
    "artifacts/api-server/src/test/discoveryRankProvenance.test.ts",
    // A03's "open" is backed only by Compass's open_now factor, which fires on isOpenNow === true; §68.1 cites it.
    "artifacts/api-server/src/compass/CompassRecommendationEngine.ts",
    // census-discovery §71 (lane P31, the intent-mode sender): A05 and DV-42 are restated on the
    // selector, its suites and the parity suite; the selector rests on the app's flag read and the
    // route that reports 2850; A05's For You gap rests on the Compass feed hook taking no mode.
    "travel-buddy-standalone/src/components/discovery/DiscoveryIntentModeSelector.tsx",
    "travel-buddy-standalone/src/services/__tests__/discovery.intentMode.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryIntentModeSelector.component.test.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryScreen.intentMode.component.test.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryTabs.intentMode.component.test.tsx",
    "artifacts/api-server/src/test/discoveryIntentModeSender.test.ts",
    "travel-buddy-standalone/src/context/FeatureFlagsContext.tsx",
    "artifacts/api-server/src/routes/featureFlags.ts",
    "travel-buddy-standalone/src/hooks/compass/useCompassFeed.ts",
    // census-discovery §73 (lane P27, letter-fold completeness): DV-20 and B01 move W -> C on the table, its two
    // SQL twins and the enumeration suite. The other files §73 cites were already watched.
    "artifacts/api-server/src/lib/latinLetterFold.ts",
    "artifacts/api-server/src/migrations/3440_canonical_search_key_letter_fold.sql",
    "artifacts/api-server/src/migrations/3441_trail_letter_fold_decompose_first.sql",
    "artifacts/api-server/src/test/discoveryLetterFoldCompleteness.test.ts",
    // census-discovery §67 (lane P19b, graph revocation): DV-51's revocation leg is graded on this
    // suite (every edge family revoked then rebuilt, against a scratch build; the fail-visible guards).
    // compass/CompassGraphEngine.ts, the code it grades, is already watched above (§56).
    "artifacts/api-server/src/test/compassGraphRevocation.test.ts",
    // WIDENED 2026-09-28 by census-discovery §65 (P19, Layover consumers take the border-entry
    // input): A13 is re-graded on every inline certification site, so the consumers that
    // certify, the resolver they now share with the snapshot, and the suites seen red are watched.
    "artifacts/api-server/src/services/airport/LayoverBuddyGate.ts",
    "artifacts/api-server/src/services/airport/LayoverEventReplanner.ts",
    "artifacts/api-server/src/services/airport/LayoverReplanService.ts",
    "artifacts/api-server/src/services/airport/LayoverExternalReplanPort.ts",
    "artifacts/api-server/src/services/airport/LayoverNotificationService.ts",
    "artifacts/api-server/src/services/airport/layoverEntryGate.ts",
    "artifacts/api-server/src/test/layoverConsumerEntry.test.ts",
    "artifacts/api-server/src/test/layoverEntryGate.test.ts",
    "artifacts/api-server/src/test/layoverRouteSafetyInputs.test.ts",
    "artifacts/api-server/src/test/layoverSafeReturnAbort.test.ts",
    // census-discovery §74 (lane P32, independent verification of §73): DV-20 and B01 go C -> W on this
    // suite (combining diacritics outside U+0300–U+036F; listTrails compares strings). The code it grades
    // is already watched (§46, §51, §61, §73).
    "artifacts/api-server/src/test/discoveryVerifyAudit3.test.ts",
    // census-discovery §70 (search platform boundary, P30): A08 and the drift-footer fix cite these.
    "artifacts/api-server/src/test/searchPlatformBoundary.test.ts",
    "artifacts/api-server/src/test/searchPlatformGolden.test.ts",
    "artifacts/api-server/src/test/fixtures/searchPlatformGolden.json",
    // §70 names it as A08's remaining platform-direction work, and searchPlatformBoundary B5 pins its lib/ importers.
    "artifacts/api-server/src/routes/discoverySearchHelpers.ts",
    // census-discovery §75 (lane P33, DC-17 part 2): §68.6's hunks built — Trail health's snapshot columns (3436,
    // its rollback), the suite that pins the hunks and its Trails fake, and the harness suite over 3436. The lib
    // files and the two changed suites §75 cites (discoveryTrendingApi, discoveryServedGraphReading) were already watched.
    "artifacts/api-server/src/migrations/3436_trail_health_snapshot_provenance.sql",
    "db/rollback/2026-09-28-3436-trail-health-snapshot-provenance-rollback.sql",
    "artifacts/api-server/src/test/discoveryDerivedProvenanceHunks.test.ts",
    "artifacts/api-server/src/test/helpers/fakeTrailsDb.ts",
    "artifacts/api-server/src/test/db/trailHealthSnapshotProvenance.db.test.ts",
    // census-discovery §76 (lane P34): A03's sentence is restated on files already watched above
    // (discoveryReasonCodes, discoveryReasonTruth, discoveryCandidate, the golden). §76.3's claim
    // that the client folds with the server's letter table rests on the client copy of that table
    // and the two suites that pin it (the parity suite fails on any drift in key, value or order).
    "travel-buddy-standalone/src/lib/latinLetterFold.ts",
    "artifacts/api-server/src/test/clientLetterFoldParity.test.ts",
    "travel-buddy-standalone/src/lib/__tests__/cityCentroidsLetterFold.test.ts",
    // census-discovery §83 (lane W10-D, rollout and the portava-ci apply): DC-26, DC-18, DV-70 and DC-27
    // are graded on the apply plan, the production rollout (DC-27's record template), the approval request
    // and the harness rehearsal driver and seed that produced the plan's evidence.
    "docs/ops/discovery-portava-ci-apply-plan.md",
    "docs/ops/discovery-production-rollout.md",
    "docs/ops/discovery-owner-approval-request.md",
    "artifacts/api-server/scripts/local-db/rehearse-pending-apply.ts",
    "artifacts/api-server/scripts/local-db/rehearse-pending-apply.seed.sql",
    // census-discovery §78 (lane W10-R2, scoring designs): A18, DV-09, DV-12, DV-18, DC-13 and DV-54 are
    // graded on these modules, migrations, rollbacks and suites. portavaRank, DRS, the reason-code map and
    // three of the four restated suites were already watched. DV-18's producer rests on the Map's trip reader.
    "artifacts/api-server/src/lib/discoveryRankFlags.ts",
    "artifacts/api-server/src/lib/discoveryRankDesigns.ts",
    "artifacts/api-server/src/lib/discoveryRankObjectives.ts",
    "artifacts/api-server/src/lib/discoveryRankIntegrity.ts",
    "artifacts/api-server/src/lib/discoveryRankIntent.ts",
    "artifacts/api-server/src/lib/discoveryRankTrip.ts",
    "artifacts/api-server/src/lib/discoveryRankDiversity.ts",
    "artifacts/api-server/src/lib/mapProjectionTripRead.ts",
    "artifacts/api-server/src/migrations/3450_discovery_surface_objectives_flag.sql",
    "artifacts/api-server/src/migrations/3451_discovery_engagement_integrity_flag.sql",
    "artifacts/api-server/src/migrations/3452_discovery_feature_families_flag.sql",
    "artifacts/api-server/src/migrations/3453_discovery_intent_trip_terms_flags.sql",
    "artifacts/api-server/src/migrations/3454_discovery_diversity_axes_flag.sql",
    "db/rollback/2026-09-28-3450-discovery-surface-objectives-flag-rollback.sql",
    "db/rollback/2026-09-28-3451-discovery-engagement-integrity-flag-rollback.sql",
    "db/rollback/2026-09-28-3452-discovery-feature-families-flag-rollback.sql",
    "db/rollback/2026-09-28-3453-discovery-intent-trip-terms-flags-rollback.sql",
    "db/rollback/2026-09-28-3454-discovery-diversity-axes-flag-rollback.sql",
    "artifacts/api-server/src/test/portavaRankDesignGolden.test.ts",
    "artifacts/api-server/src/test/fixtures/portavaRankGolden.json",
    "artifacts/api-server/src/test/helpers/portavaRankGoldenScenarios.ts",
    "artifacts/api-server/src/test/discoveryRankObjectives.test.ts",
    "artifacts/api-server/src/test/discoveryRankIntent.test.ts",
    "artifacts/api-server/src/test/discoveryRankTrip.test.ts",
    "artifacts/api-server/src/test/discoveryRankIntegrity.test.ts",
    "artifacts/api-server/src/test/discoveryRankDiversity.test.ts",
    "artifacts/api-server/src/test/discoveryRankDesigns.test.ts",
    "artifacts/api-server/src/test/db/discoveryRankDesignFlags.db.test.ts",
    "artifacts/api-server/src/test/discoveryTrailModifier.test.ts",
    // census-discovery §85 (lane W10-R3): DC-12, DC-11, DC-01, DV-49, DV-53, DV-55 and DC-17 are re-graded
    // on the candidate modules, the city-confidence producer's windowed reads, migrations 3480–3484, their
    // rollbacks and the suites that pin them. lib/discoveryPde.ts, lib/discoveryRankProvenance.ts,
    // lib/discoveryRecommendationRecord.ts, compass/CompassGraphEngine.ts and FeedSlotAllocator.ts were
    // already watched.
    "artifacts/api-server/src/lib/discoveryCandidates/pipelineFlags.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/candidateSources.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/retrievals.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/materialize.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/generate.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/stages.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/viewerColdStart.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/explorationInventory.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/outcomeLearning.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/integrity.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/graphReadingProvenance.ts",
    "artifacts/api-server/src/lib/discoveryCandidates/outputKinds.ts",
    "artifacts/api-server/src/compass/cityConfidenceWindowedReads.ts",
    "artifacts/api-server/src/migrations/3480_discovery_candidate_sources_flag.sql",
    "artifacts/api-server/src/migrations/3481_discovery_exploration_inventory_flag.sql",
    "artifacts/api-server/src/migrations/3482_discovery_cold_start_flag.sql",
    "artifacts/api-server/src/migrations/3483_discovery_pipeline_stages_flags.sql",
    "artifacts/api-server/src/migrations/3484_compass_city_confidence_provenance.sql",
    "db/rollback/2026-09-28-3480-discovery-candidate-sources-flag-rollback.sql",
    "db/rollback/2026-09-28-3481-discovery-exploration-inventory-flag-rollback.sql",
    "db/rollback/2026-09-28-3482-discovery-cold-start-flag-rollback.sql",
    "db/rollback/2026-09-28-3483-discovery-pipeline-stages-flags-rollback.sql",
    "db/rollback/2026-09-28-3484-compass-city-confidence-provenance-rollback.sql",
    "artifacts/api-server/src/test/discoveryCandidatePipelineGolden.test.ts",
    "artifacts/api-server/src/test/compassCityConfidenceWindow.test.ts",
    "artifacts/api-server/src/test/discoveryCandidateSources.test.ts",
    "artifacts/api-server/src/test/discoveryExplorationInventory.test.ts",
    "artifacts/api-server/src/test/discoveryColdStart.test.ts",
    "artifacts/api-server/src/test/discoveryPipelineStages.test.ts",
    "artifacts/api-server/src/test/discoveryOutputKinds.test.ts",
    "artifacts/api-server/src/test/helpers/fakeCandidateDb.ts",
    "artifacts/api-server/src/test/helpers/candidateWorld.ts",
    "artifacts/api-server/src/test/db/discoveryCandidatePipelineMigrations.db.test.ts",
    // census-discovery §79 (lane W10-R4, one ranking pipeline): C32, DC-24, DV-03, A05, A07 and DC-14 are
    // graded on this suite and the client test, the 3455/3456 flag gates, their migrations and rollbacks.
    "artifacts/api-server/src/lib/discoveryOnePipeline.ts",
    "artifacts/api-server/src/test/discoveryOnePipeline.test.ts",
    "artifacts/api-server/src/migrations/3455_discovery_for_you_pde_flag.sql",
    "artifacts/api-server/src/migrations/3456_discovery_cache_a_ranked_flag.sql",
    "db/rollback/2026-09-28-3455-discovery-for-you-pde-enabled-rollback.sql",
    "db/rollback/2026-09-28-3456-discovery-cache-a-ranked-enabled-rollback.sql",
    "travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.onePipeline.component.test.tsx",
    // census-discovery §81 (lane W10-S2, cross-architecture adapters and product rules): A10, A11, A13, A14,
    // A21, DV-51, DV-76 and DV-77 are graded on these files, migrations and suites.
    "artifacts/api-server/src/services/airport/LayoverPlaceDwell.ts",
    "artifacts/api-server/src/domain/trips/contracts/tripViewerProjections.ts",
    "artifacts/api-server/src/lib/discoveryTripViewerConsumer.ts",
    "artifacts/api-server/src/services/discovery/DiscoveryWishlistSave.ts",
    "artifacts/api-server/src/routes/postcardMediaTransport.ts",
    "artifacts/api-server/src/migrations/3465_layover_consumer_flags.sql",
    "artifacts/api-server/src/migrations/3466_layover_place_dwell.sql",
    "artifacts/api-server/src/migrations/3467_cross_architecture_flags.sql",
    "artifacts/api-server/src/migrations/3468_tag_permission_approval_required.sql",
    "artifacts/api-server/src/migrations/3469_compass_graph_decay_flag.sql",
    "artifacts/api-server/src/test/layoverSnapshotConsumers.test.ts",
    "artifacts/api-server/src/test/layoverPlaceDwell.test.ts",
    "artifacts/api-server/src/test/discoveryTripViewerProjections.test.ts",
    "artifacts/api-server/src/test/telegraphDiscoveryAction.test.ts",
    "artifacts/api-server/src/test/mediaPendingUploadRule.test.ts",
    "artifacts/api-server/src/test/tagPermissionApprovalRequired.test.ts",
    "artifacts/api-server/src/test/compassGraphDecay.test.ts",
    "artifacts/api-server/src/test/discoveryFreeTimeRetirement.test.ts",
    // census-discovery §82 (lane W10-O, outcomes and stop conditions): DV-82/DC-32 (the armed halt values,
    // 3470), DV-37 (the keyless retry), DV-19 (the judgement and enrichment), DV-78 (immediate_skip, the
    // separation pins) and DC-22/DC-32/DV-41 (the ruled values) are graded on these.
    "artifacts/api-server/src/lib/discoveryDwellSkip.ts",
    "artifacts/api-server/src/migrations/3470_discovery_stop_enforcement_flag.sql",
    "db/rollback/2026-09-28-3470-discovery-stop-enforcement-flag-rollback.sql",
    "artifacts/api-server/src/test/discoveryStopEnforcement.test.ts",
    "artifacts/api-server/src/test/discoveryKeylessOutcome.test.ts",
    "artifacts/api-server/src/test/discoveryOutcomeJudgement.test.ts",
    "artifacts/api-server/src/test/discoveryDwellSkip.test.ts",
    "artifacts/api-server/src/test/discoveryNegativeFeedbackSeparation.test.ts",
    "artifacts/api-server/src/test/discoveryRulingsPinned.test.ts",
    "artifacts/api-server/src/test/db/discoveryOutcomeEnrichment.db.test.ts",
    // §82.2 DV-78 grades D-W10-O-6 on its dismiss → ITEM_HIDDEN mapping (hide ≡ not_interested).
    "artifacts/api-server/src/services/ranking/rankingAnalytics.ts",
    // census-discovery §86 (lane W10-T, Trails product rules and admin actions): DV-13, DV-23 graded C;
    // DV-21, DV-22, DV-24, DC-04, DC-05, DV-74, DC-20 restated. The migrations, their rollbacks, the new
    // services and admin route, and the suites the rows cite. TrailService, the health/object libs and
    // routes/trails.ts were already watched.
    "artifacts/api-server/src/migrations/3485_discovery_trail_exploration_flags.sql",
    "artifacts/api-server/src/migrations/3486_trail_moderation_audit.sql",
    "artifacts/api-server/src/migrations/3487_trail_member_exposures.sql",
    "artifacts/api-server/src/migrations/3488_trail_content_suggestions.sql",
    "db/rollback/2026-09-28-3485-discovery-trail-exploration-flags-rollback.sql",
    "db/rollback/2026-09-28-3486-trail-moderation-audit-rollback.sql",
    "db/rollback/2026-09-28-3487-trail-member-exposures-rollback.sql",
    "db/rollback/2026-09-28-3488-trail-content-suggestions-rollback.sql",
    "artifacts/api-server/src/services/trails/trailExploration.ts",
    "artifacts/api-server/src/services/trails/trailAdmin.ts",
    "artifacts/api-server/src/routes/adminTrails.ts",
    "artifacts/api-server/src/test/discoveryTrailProductRules.test.ts",
    "artifacts/api-server/src/test/discoveryTrailExploration.test.ts",
    "artifacts/api-server/src/test/adminTrailsRoutes.test.ts",
    "artifacts/api-server/src/test/helpers/fakeTrailRulesDb.ts",
    "artifacts/api-server/src/test/db/trailsModeration.db.test.ts",
    "docs/architecture/discovery-decision-register.md",
    "artifacts/api-server/src/test/discoveryTrailModifier.test.ts", // §86.8: two DC-05 cases restated
    // census-discovery §84 (lane W10-R1, trending: the held designs built): the v2 trend model and its SQL twin
    // (3475 flags, 3476 store, 3477 rebuild, their rollbacks), the scheduler, the retest, the governor's proposal
    // half, and the four suites that grade DV-28..DV-34, DV-80, DC-06, DC-07 and DC-21.
    "artifacts/api-server/src/lib/discoveryTrendNormalised.ts",
    "artifacts/api-server/src/lib/discoveryTrendRebuildScheduler.ts",
    "artifacts/api-server/src/lib/discoveryTrendRediscovery.ts",
    "artifacts/api-server/src/lib/discoveryEcosystemBounds.ts",
    "artifacts/api-server/src/migrations/3475_discovery_trend_v2_flags.sql",
    "artifacts/api-server/src/migrations/3476_discovery_trend_v2_store.sql",
    "artifacts/api-server/src/migrations/3477_discovery_trend_v2_rebuild.sql",
    "db/rollback/2026-09-28-3475-discovery-trend-v2-flags-rollback.sql",
    "db/rollback/2026-09-28-3476-discovery-trend-v2-store-rollback.sql",
    "db/rollback/2026-09-28-3477-discovery-trend-v2-rebuild-rollback.sql",
    "artifacts/api-server/src/test/discoveryTrendNormalised.test.ts",
    "artifacts/api-server/src/test/discoveryTrendingLists.test.ts",
    "artifacts/api-server/src/test/discoveryTrendOps.test.ts",
    "artifacts/api-server/src/test/db/discoveryTrendNormalisedParity.db.test.ts",
    // census-discovery §80 (lane W10-S1): B02, A08, DV-83 and B04 are graded on the gateway's Map
    // page and coverage envelope, the partial wording's home, the Map sheet's platform transport, and
    // the suites seen red. lib/inputAssistance/ (searchPage.ts, searchQueryHelpers.ts) is watched above.
    "artifacts/api-server/src/routes/inputAssistance.ts",
    "artifacts/api-server/src/lib/eventPostsDiscovery.ts", // §80: DV-83's remaining ground (the feed's event-post read)
    "artifacts/api-server/src/migrations/3460_discovery_search_protection_scope.sql",
    "artifacts/api-server/src/test/inputAssistanceMapSearchPage.test.ts",
    "artifacts/api-server/src/test/db/discoverySearchProtectionGateway.db.test.ts",
    "travel-buddy-standalone/src/services/discoveryCoverageNotice.ts",
    "travel-buddy-standalone/src/platform/input-assistance/search/mapSearch.ts",
    "travel-buddy-standalone/src/platform/input-assistance/search/__tests__/mapSearch.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/inputAssistance.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/suggestResponse.ts",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/useInputAssistance.ts",
    "travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.coverage.component.test.tsx",
    "travel-buddy-standalone/src/components/map/__tests__/MapSearchSheet.refusal.component.test.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.refusal.component.test.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryCategoryTab.refusal.component.test.tsx",
    "travel-buddy-standalone/src/hooks/__tests__/useCommunityDiscovery.refusal.component.test.tsx",
    "travel-buddy-standalone/app/map/__tests__/projectedPlaces.component.test.tsx",
    // §80.12 (follow-up): the request budget's suite.
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/requestTimeout.component.test.ts",
    // census-discovery §91 (lane W10-I, integration): DC-11, DC-17, DV-09, DC-01, A18 and A07 are graded on the
    // integration suite, the output-kinds route and the client's Live-safety notice with its two suites.
    "artifacts/api-server/src/routes/discoveryOutputKinds.ts",
    "artifacts/api-server/src/test/discoveryIntegrationHooks.test.ts",
    "travel-buddy-standalone/src/components/discovery/liveUnchecked.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryCategoryTab.liveSafety.component.test.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.liveSafety.component.test.tsx",
    // §80.13 (round 3): the missing-policy fallback and the refresh on use.
    "travel-buddy-standalone/src/hooks/__tests__/useGlobalSearchSuggestions.missingPolicy.component.test.tsx",
    "travel-buddy-standalone/src/platform/input-assistance/services/policyRefreshOnUse.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/__tests__/policyRefreshOnUse.component.test.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/installInputPolicySync.ts",
    "travel-buddy-standalone/src/platform/input-assistance/services/policyStore.ts",
    // §80.15 (round 4): the served-answer signal the handoff reads.
    "travel-buddy-standalone/src/platform/input-assistance/hooks/__tests__/useInputAssistance.answeredText.component.test.tsx",
    // §80.13 (round 3): the routed helper, cited then; fixed in §80.14.
    "artifacts/api-server/src/lib/postgrestFilter.ts",
    // §80.14: the helper's suite, which drives both route callers over HTTP.
    "artifacts/api-server/src/test/postgrestFilterLikeEscape.test.ts",
    // census-discovery §95 (lane W11-X3, projections and client): DV-72, DV-34, DC-12, A21 and DV-76 are graded on
    // the Trail-derived co-occurrence (3495/3496, its reader and tick, the harness suite), the post-after-visit
    // leg, the generated-row parity, the pending-tag route, and the client's Save and "Ask me first" legs.
    "artifacts/api-server/src/migrations/3495_place_cooccurrence_trail_projection.sql",
    "artifacts/api-server/src/migrations/3496_discovery_w11x3_flags.sql",
    "db/rollback/2026-09-28-3495-place-cooccurrence-trail-projection-rollback.sql",
    "db/rollback/2026-09-28-3496-discovery-w11x3-flags-rollback.sql",
    "artifacts/api-server/src/migrations/3497_discovery_trend_post_convergence_stored.sql", // §95.9 (O-1)
    "db/rollback/2026-09-28-3497-discovery-trend-post-convergence-stored-rollback.sql",
    "artifacts/api-server/src/test/db/discoveryTrendPostConvergenceStored.db.test.ts",
    "artifacts/api-server/src/lib/discoveryPlaceCooccurrence.ts",
    "artifacts/api-server/src/lib/discoveryTrendPostConvergence.ts",
    "artifacts/api-server/src/lib/discoveryPlaceAggregates.ts",
    "artifacts/api-server/src/test/db/placeCooccurrenceRebuild.db.test.ts",
    "artifacts/api-server/src/test/discoveryPlaceCooccurrence.test.ts",
    "artifacts/api-server/src/test/discoveryTrendPostConvergence.test.ts",
    "artifacts/api-server/src/test/discoveryCandidateRowParity.test.ts",
    "artifacts/api-server/src/test/tagPendingInbox.test.ts",
    "travel-buddy-standalone/src/services/discoveryCardSave.ts",
    "travel-buddy-standalone/src/services/tagging.ts",
    "travel-buddy-standalone/src/components/PendingTagInbox.tsx",
    "travel-buddy-standalone/app/profile/edit/connected.tsx",
    "travel-buddy-standalone/src/services/__tests__/discoveryCardSave.telegraph.component.test.ts",
    "travel-buddy-standalone/src/services/__tests__/tagging.askMeFirst.component.test.ts",
    "travel-buddy-standalone/src/components/__tests__/DiscoveryCardMessage.telegraphSave.component.test.tsx",
    "travel-buddy-standalone/src/components/__tests__/PendingTagInbox.component.test.tsx",
    // census-discovery §93 (lane W11-X1, ranker core): A11, DV-31, DV-09 and DV-74 are graded on the surface
    // objective ranker, its flag migration, the Trip Planning call site and the three new suites.
    "artifacts/api-server/src/lib/discoverySurfaceObjectiveRank.ts",
    "artifacts/api-server/src/migrations/3500_discovery_surface_objective_rank_flags.sql",
    "artifacts/api-server/src/routes/trips-expansion.ts",
    "artifacts/api-server/src/test/discoveryRediscoveryRetestServe.test.ts",
    "artifacts/api-server/src/test/discoveryTrendReviewSuppression.test.ts",
    "artifacts/api-server/src/test/discoverySurfaceObjectiveRank.test.ts",
    // census-discovery §94 (lane W11-X2, serve path): DV-83 is graded on the feed's event-post suite and the
    // rail's coverage suite; C19, DC-17, DC-01 and A07 on the byline golden, the platform provenance module and
    // suite, the output-kinds serve log and its client call, and the Live claim read's failure suite; 3490 and
    // 3491 with their rollbacks.
    "artifacts/api-server/src/test/discoveryFeedEventPostsCoverage.test.ts",
    "artifacts/api-server/src/test/discoveryCommunityBylineCanonical.test.ts",
    "artifacts/api-server/src/lib/discoveryPlatformGraphProvenance.ts",
    "artifacts/api-server/src/test/discoveryPlatformGraphProvenance.test.ts",
    "artifacts/api-server/src/test/discoveryOutputKindsServeLog.test.ts",
    "artifacts/api-server/src/test/liveClaimReadFailure.test.ts",
    "artifacts/api-server/src/migrations/3490_discovery_serve_path_flags.sql",
    "artifacts/api-server/src/migrations/3491_discovery_recommendations_output_kinds_serve_point.sql",
    "db/rollback/2026-09-28-3490-discovery-serve-path-flags-rollback.sql",
    "db/rollback/2026-09-28-3491-discovery-recommendations-output-kinds-serve-point-rollback.sql",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryEventPostsRail.coverage.component.test.tsx",
    "travel-buddy-standalone/src/services/discoveryRecommendations.ts",
    "travel-buddy-standalone/src/services/__tests__/discoveryRecommendations.test.ts",
    "travel-buddy-standalone/src/components/discovery/DiscoveryOutputKindsRail.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryOutputKindsRail.component.test.tsx",
    // census-discovery §97 (lane W11-S, safety and recovery): DV-82 and DC-32 are graded on the stop gate, its
    // readers and its suite; DC-18 on the eleven rollback files §97 wrote (rehearsed on the harness).
    "artifacts/api-server/src/lib/discoveryStopGate.ts",
    "artifacts/api-server/src/test/discoveryStopGate.test.ts",
    "db/rollback/2026-09-28-2289-discovery-ranking-modifiers-flag-rollback.sql",
    "db/rollback/2026-09-28-2297-rank-events-dismiss-outcome-rollback.sql",
    "db/rollback/2026-09-28-2892-place-momentum-rollback.sql",
    "db/rollback/2026-09-28-2893-rank-events-retire-writerless-surfaces-rollback.sql",
    "db/rollback/2026-09-28-2894-rank-events-trip-add-outcome-rollback.sql",
    "db/rollback/2026-09-28-2901-rent-buddy-earnings-entries-rollback.sql",
    "db/rollback/2026-09-28-2921-creator-earning-entries-rollback.sql",
    "db/rollback/2026-09-28-2930-creator-share-canonical-view-rollback.sql",
    "db/rollback/2026-09-28-2995-rank-events-discovery-dismissed-index-rollback.sql",
    "db/rollback/2026-09-28-3440-canonical-search-key-letter-fold-rollback.sql",
    "db/rollback/2026-09-28-3441-trail-letter-fold-decompose-first-rollback.sql",
    // census-discovery §94.11 (lane W11-X2, round 2): DV-83 re-graded on the Overpass suite, the rail refresh on the
    // real ForYouTab, and the bounded feed call.
    "artifacts/api-server/src/test/discoveryOverpassFailedSource.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.railRefresh.component.test.tsx",
    "travel-buddy-standalone/src/services/__tests__/discovery.feedTimeout.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryEventPostsRail.refusal.component.test.tsx",  // §94.11 cites its restated transport-failure control
    // census-discovery §98 (DV-83, the parallel session's rounds): the suites its C rests on.
    "artifacts/api-server/src/test/discoveryFeedNoServiceClient.test.ts",
    "travel-buddy-standalone/src/components/discovery/__tests__/DiscoveryEventPostsRail.refresh.component.test.tsx",
    "travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.pullToRefresh.component.test.tsx",
    // census-discovery §99 (lane W11-X2, round 3): DV-83 re-graded on ForYouTab's cached replay of a partial page.
    "travel-buddy-standalone/src/components/discovery/__tests__/ForYouTab.cachedPartial.component.test.tsx",
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
    "artifacts/api-server/src/lib/inputAssistance/searchCandidates.ts", // census-discovery §70: routes/discoverySearch.ts's searchers moved here
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
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): the evidence cited on rows P59, P61, P75, P126, P128, P129, P132, P138, P158/F9, P159 and P169, and §14.6's P61 pins.
    "artifacts/api-server/src/lib/entryRequirements.ts",
    "artifacts/api-server/src/domain/telegraph/policies/travelScamSignals.ts",
    "artifacts/api-server/src/lib/places/placeCollectionsWorker.ts",
    "artifacts/api-server/src/test/passportStampTypeVocabulary.test.ts",
    "artifacts/api-server/src/test/unifiedStamps.test.ts",
    "artifacts/api-server/src/compass/CompassGraphEngine.ts",
    "artifacts/api-server/src/test/passportJourneyEventsRecommendations.test.ts",
    "artifacts/api-server/src/test/passportWorldHierarchy.test.ts",
    "travel-buddy-standalone/app/passport/country/[country].tsx",
    "travel-buddy-standalone/src/features/telegraph/theme/telegraphTheme.ts",
    "travel-buddy-standalone/app/(tabs)/_layout.tsx",
    "travel-buddy-standalone/src/components/passport/PassportVerifiedSeal.tsx",
    "travel-buddy-standalone/src/theme/tokens.ts",
    "travel-buddy-standalone/src/lib/travelerState.ts",
    "travel-buddy-standalone/app/passport/[username].tsx",
    "travel-buddy-standalone/app/passport/event/[token].tsx",
    "artifacts/api-server/src/test/passportListIdentityProjection.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): P45's pin (§13.2) and the two D-WORD tripwires §19.4 names.
    "artifacts/api-server/src/test/passportDomainTrustBasis.test.ts",
    "artifacts/api-server/src/test/passportTrustEvidenceConfidence.test.ts",
    // WIDENED 2026-09-27 by the coverage-guard fix (census-media §32.14): P2, P87 and P168 cite `app/(tabs)/passport.tsx` and `app/(tabs)/ai.tsx`, which the guard resolves to the legacy repo-root mocks; the lines they cite are travel-buddy-standalone's, so both copies of each are watched, as for the two stamp components above.
    "travel-buddy-standalone/app/(tabs)/passport.tsx",
    "travel-buddy-standalone/app/(tabs)/ai.tsx",
    "app/(tabs)/passport.tsx",
    "app/(tabs)/ai.tsx",
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
    //
    // AND UNTRACKED FILES. Neither working-tree diff lists a file git does not
    // track yet, so a NEW file in a counted directory passed this check locally
    // and failed it in CI the moment it was committed: on 2026-09-26 three
    // censuses went red on PR #528 for exactly that reason, after a green local
    // run. `ls-files --others --exclude-standard` names what `git add` would add.
    const committed = git(["diff", "--name-only", `${commit}..${head}`, "--", ...scope]);
    const staged = git(["diff", "--name-only", "--cached", "--", ...scope]);
    const unstaged = git(["diff", "--name-only", "--", ...scope]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...scope]);
    changed = [...new Set(
      [committed, staged, unstaged, untracked].flatMap((out) => out.split("\n")).filter(Boolean),
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
