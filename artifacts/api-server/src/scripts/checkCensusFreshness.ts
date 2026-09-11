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
  // Trips §29 declares a head_commit — the first Trips section to do so — and
  // this is what makes that declaration mean something. The scope is wide on
  // purpose: §29's central finding is that the WRITERS (the migrations) were
  // being counted while the READERS did not exist, so a scope listing only
  // src/migrations would age this census on exactly the half that was never
  // the problem. Both ends of every vertical slice are listed.
  "census-trips.md": [
    // The kernel and its command families.
    "artifacts/api-server/src/lib/tripKernel.ts",
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
  ],
  "census-layover.md": [
    "artifacts/api-server/src/services/airport/",
    "artifacts/api-server/src/routes/airport.ts",
    "travel-buddy-standalone/src/services/layover.ts",
    "travel-buddy-standalone/src/components/layover/",
    "travel-buddy-standalone/app/layover/",
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
  ],
  "census-compass.md": [
    "artifacts/api-server/src/compass/",
    "artifacts/api-server/src/routes/compass.ts",
    "artifacts/api-server/src/routes/compassAutopilot.ts",
    "artifacts/api-server/src/routes/compassHome.ts",
    "artifacts/api-server/src/routes/compassSense.ts",
    "artifacts/api-server/src/routes/airport.ts",
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
