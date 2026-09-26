import { Router, type IRouter } from "express";
import verificationRouter from "./verification.js";
import devicesRouter from "./devices";
import keyPackagesRouter from "./keyPackages";
import healthRouter from "./health";
import authRouter from "./auth";
import tripsRouter from "./trips";
import tripFeasibilityRouter from "./tripFeasibility";
import tripOfflineRouter from "./tripOffline";
import tripMeetingCheckpointsRouter from "./tripMeetingCheckpoints";
import tripPostTripRouter from "./tripPostTrip";
import tripPresenceRouter from "./tripPresence";
import tripDecisionsRouter from "./tripDecisions";
import tripStructureRouter from "./tripStructure";
import tripMapProjectionRouter from "../server/trips/readRoutes/tripMapProjection";
import tripProjectionsRouter from "../server/trips/readRoutes/tripProjections";
import tripCommandsRouter from "../server/trips/commandRoute";
import postsRouter from "./posts";
import followsRouter from "./follows";
import friendsRouter from "./friends";
import profileRouter from "./profile";
import passportRouter from "./passport";
import telegraphRouter from "./telegraph";
import telegraphChatRouter from "./telegraphChat";
import telegraphStreamRouter from "./telegraphStream";
import telegraphSharedContextRouter from "./telegraphSharedContext";
import telegraphShareRouter from "./telegraphShare";
import telegraphKindsRouter from "./telegraphKinds";
import telegraphVoiceRouter from "./telegraphVoice";
import telegraphCoordinationRouter from "./telegraphCoordination";
import telegraphMemoryRouter from "./telegraphMemory";
import savedMessagesRouter from "./savedMessages";
import telegraphLifecycleRouter from "./telegraphLifecycle";
import messagingRouter from "./messaging";
import requestsRouter from "./requests";
import planRouter from "./plan";
import groupChatRouter from "./groupChat";
import availabilityRouter from "./availability";
import meetupsRouter from "./meetups";
import preferencesRouter from "./preferences";
import dailyBriefRouter from "./dailyBrief";
import telegraphCommandsRouter from "./telegraphCommands";
import telegraphFeedbackRouter from "./telegraphFeedback";
// Telegraph §14.1 / §21 / §18.3 — the domain kernel's own server surface.
import telegraphCapabilityRouter from "../server/telegraph/capabilityRoute";
import telegraphSearchRouter from "../server/telegraph/searchRoute";
import telegraphReadReceiptsRouter from "../server/telegraph/readReceiptsRoute";
import telegraphKernelCommandRouter from "../server/telegraph/commandRoute";
import discoveryRouter from "./discovery";
import blocksRouter from "./blocks";
import locationRouter from "./location";
import locationPreferencesRouter from "./locationPreferences";
import mapTravelersRouter from "./mapTravelers";
import geofenceRouter from "./geofence";
import intelRouter from "./intel.js";
import trailsRouter from "./trails.js";
import intelCoverageRouter from "./intelCoverage.js";
import intelApiRouter from "./intelApi.js";
import intelReadModelsRouter from "./intelReadModels.js";
import intelOutcomesRouter from "./intelOutcomes.js";
import intelObservabilityRouter from "./intelObservability.js";
import safeReturnRouter from "./safeReturn";
import tripCrewLocationRouter from "./tripCrewLocation";
import highlightsRouter from "./highlights";
import placesRouter from "./places";
import locationsRouter from "./locations";
import pulseRouter from "./pulse";
import adminRouter from "./admin";
import trustAdminRouter from "./trust-admin";
import phoneVerificationRouter from "./phoneVerification";
import passportStampsRouter from "./passportStamps";
import hiddenGemsRouter from "./hiddenGems";
import notificationsRouter from "./notifications";
import airportRouter from "./airport";import layoverEventsRouter from "./layoverEvents"; // eslint-disable-line -- same-line to keep this file line-count-stable; 27 doc citations anchor on line numbers here
import featureFlagsRouter from "./featureFlags";
import tagsRouter from "./tags";
import hashtagsRouter from "./hashtags";
import circleAgeSettingsRouter from "./circleAgeSettings";
import rentABuddyRouter from "./rentABuddy";
import rentABuddyMarketplaceRouter from "./rentABuddyMarketplace";
import rentABuddyRolloutRouter from "./rentABuddyRollout";
import rentABuddySpecRouter from "./rentABuddySpec";
import compassRouter from "./compass";
import compassHomeRouter from "./compassHome";
import compassSenseRouter from "./compassSense";
import compassLiveRouter from "./compassLive";
import compassAutopilotRouter from "./compassAutopilot";
import compassOutcomesRouter from "./compassOutcomes";
import compassGraphRouter from "./compassGraph";
import adminCompassRouter from "./adminCompass";
import routePlanRouter from "./routePlan";
import interactionContextRouter from "./interactionContext";
import mutesRouter from "./mutes";
import savesRouter from "./saves";
import reportsRouter from "./reports";
import restrictRouter from "./restrict";
import eventsRouter from "./events";
import memoriesRouter from "./memories";
import storiesRouter from "./stories";
import storyArchiveRouter from "./storyArchive";
import closeFriendsRouter from "./closeFriends";
import reviewsRouter from "./reviews";
import appealsRouter from "./appeals";
import collectionsRouter from "./collections";
import wishlistRouter from "./wishlist";
import profileTabsRouter from "./profileTabs";
import tripsExpansionRouter from "./trips-expansion";
import stampsRouter from "./stamps";
import adminStampsRouter from "./adminStamps";
import adminGeocodeRouter from "./adminGeocode";
import adminRankingMetricsRouter from "./adminRankingMetrics";
import adminRankingConfigRouter from "./adminRankingConfig";
import stampCatalogRouter from "./stampCatalog";
import emergencyContactsRouter from "./emergencyContacts";
import crashReportRouter from "./crashReport";
import discoverySearchRouter from "./discoverySearch";
import inputAssistanceRouter from "./inputAssistance";
import searchHistoryRouter from "./searchHistory";
import postcardsRouter from "./postcards";
import engagementRouter from "./engagement";
import circleRouter from "./circle";
import rankEventsRouter from "./rankEvents";
import callsRouter from "./calls";
import moderationRouter from "./moderation";
import entryRequirementsRouter from "./entryRequirements";
import tripReadinessRouter from "./tripReadiness";
import tripBudgetIntelRouter from "./tripBudgetIntel";
import tripReservationsRouter from "./tripReservations";
import tripDraftRouter from "./tripDraft";
import visualsRouter from "./visuals";
import adminVisualsRouter from "./adminVisuals";
import adminPlaceImagesRouter from "./adminPlaceImages.js";
import neighborhoodsRouter from "./neighborhoods";
import stampShowcaseRouter from "./stampShowcase";
import stampAdmireRouter from "./stampAdmire";
import contentStampsRouter from "./contentStamps";
import countryEssentialsRouter from "./countryEssentials";
import mapSearchRouter from "./mapSearch";
import mapProjectionRouter from "./mapProjection";
import mapProjectionTemporalRouter from "./mapProjectionTemporal";
import mapTelemetryRouter from "./mapTelemetry";
import mapObservationsRouter from "./mapObservations";
import locateFriendsRouter from "./locateFriends";
import mediaFileRouter from "./mediaFile";
import mediaWorldRouter from "./mediaWorld";
import mediaActionsRouter from "./mediaActions";
import mediaFeedRouter from "./mediaFeed";
import adminMediaRouter from "./adminMedia.js";
import mediaAnalyticsBatchRouter from "./mediaAnalyticsBatch.js";
import mediaViewRequestRouter from "./mediaViewRequest.js";
import placesCanonicalRouter from "./placesCanonical";
import fsqPlacesRouter from "./fsqPlaces";
import ogRouter from "./og";
import adminPortavaPostsRouter from "./adminPortavaPosts.js";
import adminFeaturedRouter from "./adminFeatured";
import adminPlaceMismatchRouter from "./adminPlaceMismatch.js";
import featuredRouter from "./featured.js";
import placeLivingRouter from "./placeLiving.js";
import placeDaysRouter from "./placeDays.js";
import contentTranslationRouter from "./contentTranslation.js";
import sharedMomentsRouter from "./sharedMoments.js";
import placeRecapsRouter from "./placeRecaps.js";
import wallRouter from "./wall.js";
import wallTelemetryRouter from "./wallTelemetry.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(tripsRouter);
router.use(tripFeasibilityRouter);
router.use(tripOfflineRouter);
router.use(tripMeetingCheckpointsRouter);
router.use(tripPostTripRouter);
router.use(tripPresenceRouter);
router.use(tripDecisionsRouter);
router.use(tripStructureRouter);
router.use(tripMapProjectionRouter);
router.use(tripProjectionsRouter);
router.use(tripCommandsRouter);
router.use(postsRouter);
router.use(profileRouter);
router.use(followsRouter);
router.use(friendsRouter);
router.use(passportRouter);
router.use(passportStampsRouter);
router.use(telegraphRouter);
router.use(telegraphChatRouter);
router.use(telegraphStreamRouter);
router.use(telegraphSharedContextRouter);
router.use(telegraphShareRouter);
router.use(telegraphKindsRouter);
router.use(telegraphVoiceRouter);
router.use(telegraphCoordinationRouter);
router.use(telegraphMemoryRouter);
router.use(savedMessagesRouter);
router.use(telegraphLifecycleRouter);
router.use(telegraphFeedbackRouter);
// The kernel command router and telegraphCommandsRouter BOTH register
// POST /telegraph/commands, for two different bodies. The kernel one goes
// first and yields (`next()`) on any body without a `type`, so the
// natural-language assistant below still receives its own traffic. Mounted the
// other way round — as it was — the assistant answered every request to that
// path and the whole §13.1 command vocabulary was unreachable. See the divider
// at the top of `server/telegraph/commandRoute.ts`.
router.use(telegraphKernelCommandRouter);
router.use(telegraphCommandsRouter);
router.use(telegraphCapabilityRouter);
router.use(telegraphSearchRouter);
router.use(telegraphReadReceiptsRouter);
router.use(messagingRouter);
router.use(requestsRouter);
router.use(planRouter);
router.use(groupChatRouter);
router.use(availabilityRouter);
router.use(meetupsRouter);
router.use(preferencesRouter);
router.use(dailyBriefRouter);
router.use(discoveryRouter);
router.use(blocksRouter);
router.use(locationRouter);
router.use(locationPreferencesRouter);
router.use(mapTravelersRouter);
router.use(geofenceRouter);
router.use(safeReturnRouter);
router.use(tripCrewLocationRouter);
router.use(highlightsRouter);
router.use(placesRouter);
router.use(locationsRouter);
router.use(pulseRouter);
router.use(adminRouter);
router.use(trustAdminRouter);
// Phone verification. Every rent_buddy_launch_controls row requires phone
// verification, but the product had no way to perform one — the only phone
// signal was rent_buddy_profiles.phone_verified, on the BUDDY table, written
// by nothing. These routes are the missing capability.
router.use(phoneVerificationRouter);
router.use(hiddenGemsRouter);
router.use(notificationsRouter);
router.use(airportRouter); router.use(layoverEventsRouter); // §11 producer ingest, separate router — see routes/layoverEvents.ts
router.use(featureFlagsRouter);
router.use(tagsRouter);
router.use(hashtagsRouter);
router.use(circleAgeSettingsRouter);
router.use(rentABuddyRouter);
router.use(rentABuddySpecRouter);
router.use(rentABuddyMarketplaceRouter);
router.use(rentABuddyRolloutRouter);
router.use(compassRouter);
router.use(compassHomeRouter);
router.use(compassSenseRouter);
router.use(compassLiveRouter);
router.use(compassAutopilotRouter);
router.use(compassOutcomesRouter);
router.use(compassGraphRouter);
router.use(adminCompassRouter);
router.use(routePlanRouter);
router.use(interactionContextRouter);
router.use(mutesRouter);
router.use(savesRouter);
router.use(reportsRouter);
router.use(restrictRouter);
router.use(eventsRouter);
router.use(memoriesRouter);
// Registered BEFORE storiesRouter: /stories/retention-policy would otherwise be
// captured by /stories/:id and answered as an invalid story id.
router.use(storyArchiveRouter);
router.use(storiesRouter);
router.use(closeFriendsRouter);
router.use(reviewsRouter);
router.use(appealsRouter);
router.use(collectionsRouter);
router.use(wishlistRouter);
router.use(profileTabsRouter);
router.use(tripsExpansionRouter);
router.use(postcardsRouter);
// Stamp Wave 2 routers (stampShowcase, stampAdmire) must be registered BEFORE
// stampsRouter. stamps.ts registers `GET /stamps/:stampId` which returns 400
// for non-UUID paths (e.g. "showcase") without calling next(), so any static
// /stamps/* path in a later router would be unreachable. Feature-flag gating
// is enforced inside each handler (isFlagEnabled), not by router ordering.
router.use(stampShowcaseRouter);
router.use(stampAdmireRouter);
// contentStampsRouter must be after stampAdmireRouter so /stamps/:id/admire
// routes win before the polymorphic /stamps/:entityType/:entityId DELETE.
router.use(contentStampsRouter);
router.use(stampsRouter);
router.use(adminStampsRouter);
router.use(adminGeocodeRouter);
router.use(adminRankingMetricsRouter);
router.use(adminRankingConfigRouter);
router.use(stampCatalogRouter);
router.use(emergencyContactsRouter);
router.use(crashReportRouter);
router.use(discoverySearchRouter);
router.use(inputAssistanceRouter);
router.use(searchHistoryRouter);
router.use(engagementRouter);
router.use(circleRouter);
router.use(rankEventsRouter);
router.use(callsRouter);
router.use(moderationRouter);
router.use(devicesRouter);
router.use(keyPackagesRouter);
router.use(verificationRouter);
router.use(entryRequirementsRouter);
router.use(tripReadinessRouter);
router.use(tripBudgetIntelRouter);
router.use(tripReservationsRouter);
router.use(tripDraftRouter);
router.use(visualsRouter);
router.use(adminVisualsRouter);
router.use(adminPlaceImagesRouter);
router.use(neighborhoodsRouter);
router.use(countryEssentialsRouter);
router.use(fsqPlacesRouter);
router.use(mapSearchRouter);
router.use(mapProjectionRouter);
router.use(mapProjectionTemporalRouter);
router.use(mapTelemetryRouter);
router.use(mapObservationsRouter);
router.use(locateFriendsRouter);
router.use(mediaFileRouter);
// Media v2 World-first projection endpoints (§43). Registered BEFORE
// mediaFeedRouter so specific paths (/media/world, /media/people, /media/me,
// /media/timeline, /media/map) are not swallowed by mediaFeed's `/media/:id`.
router.use(mediaWorldRouter);
// Media v2 action rail + intent + experience-plan (§15/§43). Registered BEFORE
// mediaFeedRouter so the specific /media/:id/actions and /media/:id/intent paths
// are matched here, not shadowed by mediaFeed's generic /media/:id handlers.
router.use(mediaActionsRouter);
router.use(mediaFeedRouter);
router.use(adminMediaRouter);
router.use(mediaAnalyticsBatchRouter);
router.use(mediaViewRequestRouter);
router.use(placesCanonicalRouter);
router.use(adminPlaceMismatchRouter);
router.use(ogRouter);
router.use(adminPortavaPostsRouter);
router.use(adminFeaturedRouter);
router.use(featuredRouter);
router.use(placeLivingRouter);
router.use(placeDaysRouter);
router.use(contentTranslationRouter);
router.use(sharedMomentsRouter);
router.use(placeRecapsRouter);
router.use(intelRouter);
router.use(trailsRouter);
router.use(intelCoverageRouter);
router.use(intelApiRouter);
router.use(intelReadModelsRouter);
// I4a outcome events — its own file (routes/intel.ts is owned by another unit),
// mounted alongside the other intel routers.
router.use(intelOutcomesRouter);
// §24/Table-32 observability read for the four admin dashboards (admin-gated).
router.use(intelObservabilityRouter);
router.use(wallRouter);
// The §32 telemetry ingest the Wall client has always POSTed to. Its own file
// so the per-event allow-list stays unit-testable; no path overlap with
// wallRouter, which owns /wall, /wall/live, /wall/quick-media and the
// session-intent / impression / action mutations.
router.use(wallTelemetryRouter);

// ── Sensing §10: the Compass decision surface (GO NOW … RETURN) ─────────────
// Its own file behind compass_decision_enabled (2800, seeded FALSE);
// routes/compass*.ts are owned by the Compass unit and are not touched.
// Registered at the tail, and the import with it, so no line above moves —
// census-trips.md and sensing-surface-inventory.md cite this file by line.
import compassDecisionRouter from "./compassDecision.js";
router.use(compassDecisionRouter);
// ── Sensing §9 / §15: the Wall's moments, routed through the Attention Engine ─
// Its own file behind wall_enabled AND wall_moments_enabled (2801, seeded
// FALSE); routes/wall.ts is untouched. At the tail for the same reason.
import wallMomentsRouter from "./wallMoments.js";
router.use(wallMomentsRouter);
// ── Sensing §12: canonical live references in Telegraph ───────────────────────
// Its own file behind telegraph_live_references_enabled (2802, seeded FALSE);
// routes/telegraph*.ts are untouched. At the tail for the same reason.
import telegraphLiveReferencesRouter from "./telegraphLiveReferences.js";
router.use(telegraphLiveReferencesRouter);
// ── Sensing §16: the safety candidate stage, feeding the existing review ─────
// Its own file behind intel_safety_candidates_enabled (2803, seeded FALSE) and
// requireAdmin; routes/admin.ts is untouched. At the tail for the same reason.
import adminSafetyCandidatesRouter from "./adminSafetyCandidates.js";
router.use(adminSafetyCandidatesRouter);
// ── Sensing §6: CONTEXT KERNEL → OPPORTUNITY ENGINE → surface projections ────
// Its own file behind opportunity_engine_enabled (2840, seeded FALSE); no
// existing surface's route is touched and every legacy candidate builder keeps
// working. At the tail for the same reason.
import opportunitiesRouter from "./opportunities.js";
router.use(opportunitiesRouter);
// ── Sensing §5.4: the ExperienceSession bridge, over canonical_events ────────
// Its own file behind experience_session_enabled (2841, seeded FALSE); no
// table and no verb are added and routes/intel.ts is untouched. At the tail
// for the same reason.
import experienceSessionsRouter from "./experienceSessions.js";
router.use(experienceSessionsRouter);

// ── Telegraph §4 / §30A.2: Nearby & Available, as a server-built projection ──
// Its own file behind nearby_reachable_enabled (no feature_flags row exists, so
// it is OFF everywhere); no existing location, map or availability route is
// touched. Registered at the tail, and the import with it, so no line above
// moves — census-trips.md and sensing-surface-inventory.md cite this file by
// line.
import nearbyReachableRouter from "./nearbyReachable.js";
router.use(nearbyReachableRouter);

// ── Sensing §4.3: the anonymous signal ingest ────────────────────────────
// Its own file. It is the FIRST transport the anonymous sensing store has ever
// had, and it deliberately carries no user session: it authenticates the opaque
// contribution credential (2480) and nothing else, reads and writes no
// actor_id, and never touches location_snapshots. routes/intel.ts — the
// requireUser-bound human-claim capture — is untouched and shares no path with
// it. Registered at the tail, and the import with it, so no line above moves:
// census-sensing.md and sensing-surface-inventory.md cite this file by line.
import sensingIngestRouter from "./sensingIngest.js";
router.use(sensingIngestRouter);

// ── Sensing §3: ELIGIBILITY — the credential the ingest above authenticates ──
// The one sensing request that carries an account, and the place consent is
// read: the session carries only the scopes the person's recorded disclosure
// covers (lib/sensingConsentScopes). Tail-registered for the same reason.
import sensingSessionRouter from "./sensingSession.js";
router.use(sensingSessionRouter);

export default router;
