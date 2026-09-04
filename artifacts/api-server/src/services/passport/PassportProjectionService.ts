/**
 * PassportProjectionService — §4/§21/§29/§30/§33.
 *
 * ONE Passport projection system (§4, §33): every Portava surface asks for the
 * appropriate context-specific view of a traveler instead of rebuilding
 * identity / availability / trust / social context. This service assembles the
 * §29 `PassportProjection` aggregate (TABLE 28) by CALLING the existing
 * canonical services — it owns no identity storage of its own.
 *
 * TWO hard rules baked in here:
 *   • Privacy filtering happens SERVER-SIDE before anything is returned (§4,
 *     §22, §30). A blocked / unavailable viewer never receives owner data.
 *   • Authorization is SERVER-PROJECTED (§30): the aggregate carries an explicit
 *     `capabilities` block (positive owner credentials + per-viewer action
 *     flags). The client renders those flags; it never re-derives policy such as
 *     "if trust > 60 show Make Plan".
 *
 * The viewer-context resolver (`resolvePassportViewerContext`) maps the
 * viewer↔owner relationship onto TABLE 5's `PassportViewerContext`, reusing the
 * canonical `resolveInteractionPermissions` engine (blocking, follows, trips,
 * account state, trust restrictions) rather than re-implementing any of it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveInteractionPermissions,
  type InteractionPermissions,
} from "../interactionPermissions.js";
import type { CallerContext } from "./PassportPrivacyGuard.js";
import { getSafeTrustSummary, getPublicTrustBadge } from "../trust/TrustPrivacyGuard.js";
import { getRestrictionState, type RestrictionState } from "../trust/TrustRestrictionService.js";
import { buildStats } from "./PassportMapService.js";
import { buildUnifiedStamps, type UnifiedStamp } from "./UnifiedStampService.js";
import { loadMemories } from "./PassportMemoryService.js";
import { filterMemories } from "./PassportPrivacyGuard.js";
import { countUserTrips } from "../../lib/tripCounts.js";
import { buildFeaturedJourney, type JourneyProjection, type JourneyPermissions } from "./PassportJourneyService.js";
import {
  buildSharedContext,
  type SharedContextProjection,
  type SharedContextPermissions,
} from "./SharedContextService.js";
import {
  buildTravelIdentity,
  filterTravelIdentityForViewer,
  type TravelIdentityProjection,
  type TravelIdentitySignals,
} from "./PassportTravelIdentityService.js";
import {
  listWindows,
  projectPublicWindows,
  isActive as isWindowActive,
  effectiveExpiry as windowEffectiveExpiry,
  type AvailabilityWindow,
  type ViewerRelationship as WindowViewerRelationship,
} from "./OpenToPlansService.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";

/**
 * §8 availability-windows capability flag (seeded OFF, migration 2260). A local
 * literal, matching routes/availability.ts, so check:flag-polarity can resolve
 * the argument to isFlagEnabled below (it does not follow imported constants).
 */
const OPEN_TO_PLANS_WINDOWS_FLAG = "open_to_plans_windows_enabled";

// ─────────────────────────────────────────────────────────────────────────────
// TABLE 5 — viewer context
// ─────────────────────────────────────────────────────────────────────────────

export type PassportViewerContext =
  | "self"
  | "public"
  | "follower"
  | "following"
  | "trip_crew"
  | "trip_host"
  | "buddy_customer"
  | "buddy_provider"
  | "event_group";

/** Subset of interaction permissions the projection layer consumes. */
export interface ViewerPermissions {
  relationshipLabel: string;
  isBlocked: boolean;
  isUnavailable: boolean;
  canViewProfile: boolean;
  canViewFullProfile: boolean;
  canSeeAvailability: boolean;
  canSeeTrips: boolean;
  canSeeMutuals: boolean;
  canSeeLocationContext: boolean;
  canSeeFriendOnlyPosts: boolean;
  canMessage: boolean;
  canSendMessageRequest: boolean;
  canFollow: boolean;
  canInviteToTripCrew: boolean;
}

export interface ViewerResolution {
  context: PassportViewerContext;
  permissions: ViewerPermissions;
  sharedTrip: boolean;
  sharedEvent: boolean;
  ownerIsTripHost: boolean;
  buddyRole: "provider" | "customer" | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TABLE 14 + TABLE 29 — capabilities & action eligibility
// ─────────────────────────────────────────────────────────────────────────────

/** Positive owner credentials (TABLE 14) — what the OWNER is permitted to do. */
export interface PassportPositiveCapabilities {
  canJoinPublicTrip: boolean;
  canHostTrip: boolean;
  canCreateLargePlan: boolean;
  canUseCrewLocation: boolean;
  canContributeLiveIntel: boolean;
  canBecomeBuddy: boolean;
}

/** Per-viewer action flags (TABLE 29) — what THIS viewer may do to the owner. */
export interface PassportViewerActions {
  can_follow: boolean;
  can_message: boolean;
  can_make_plan: boolean;
  can_invite_trip: boolean;
  can_view_availability: boolean;
  can_view_trust: boolean;
}

export interface PassportActionCapabilities {
  owner: PassportPositiveCapabilities;
  actions: PassportViewerActions;
}

// ─────────────────────────────────────────────────────────────────────────────
// §29 sub-projections
// ─────────────────────────────────────────────────────────────────────────────

export interface PassportIdentity {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  verified: boolean;
  verificationLevel: string | null;
  homeCountry: string | null;
  homeBase: string | null;
  isOfficial: boolean;
}

export type TravelerStateKind =
  | "home"
  | "traveling"
  | "exploring"
  | "open_to_plans"
  | "at_event"
  | "with_crew"
  | "unavailable";

export interface TravelerState {
  state: TravelerStateKind;
  label: string;
  /** Broad city context only — never exact coordinates (§5, §23). */
  city: string | null;
  validFrom: string | null;
  expiresAt: string | null;
}

/**
 * The §8 explicit availability window (TABLE 8) currently active for the owner
 * and visible to this viewer. Projected from `availability_windows` via
 * OpenToPlansService, so it is EXPLICIT-only and expiry-checked on read (§7/§31).
 */
export interface ActiveAvailabilityWindow {
  type: string;
  startAt: string;
  endAt: string;
  intents: string[];
  groupPreference: string | null;
  maxTravelMinutes: number | null;
  /** TABLE 10 SocialAvailability the owner set on this window, if any. */
  socialAvailability: "open" | "maybe" | "crew_only" | "following_only" | "not_open" | null;
  /** COALESCE(expiresAt, endAt): the instant this window stops being current. */
  expiresAt: string;
}

export interface AvailabilityProjection {
  openToPlans: boolean;
  socialAvailability: "open" | "maybe" | "crew_only" | "following_only" | "not_open";
  /** Current quick-status window, filtered to non-expired (§31 "never render stale"). */
  currentWindow: { status: string; expiresAt: string | null } | null;
  /**
   * The §8 explicit availability window active now (TABLE 8), if the windows
   * feature is on and one is visible to this viewer under §7 rules. Distinct
   * from the legacy quick status + weekly grid — it carries intents, group
   * preference and travel radius, and expires on read.
   */
  explicitWindow: ActiveAvailabilityWindow | null;
  weekly: Record<string, string[]>;
  expiresAt: string | null;
}

export interface IntentProjection {
  current: string[];
  ttlExpiresAt: string | null;
  source: "explicit" | "inferred";
}

export interface TrustProjection {
  label: string;
  publicLevel: string;
  /** Numeric 0–100 exposed only where appropriate (§9) — self view. */
  score: number | null;
  confidence: "low" | "medium" | "high";
  strengths: string[];
}

export interface CredentialProjection {
  key: string;
  label: string;
  detail: string | null;
  tier: "verified" | "positive";
}

export interface TravelStats {
  countries: number;
  cities: number;
  stamps: number;
  trips: number;
}

export interface StampProjection {
  source: string;
  name: string | null;
  city: string | null;
  country: string | null;
  earnedAt: string | null;
  rarity: string | null;
  artworkUrl: string | null;
  verification: "verified" | "reported" | "decorative";
}

export interface PlanProjection {
  tripId: string;
  title: string;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  visibility: string;
}

export interface MemoryProjection {
  id: string;
  title: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  photoUrl: string | null;
  earnedAt: string | null;
  tripId: string | null;
}

/** §29 aggregate (TABLE 28), plus a server-side `restricted` discriminator. */
export interface PassportProjection {
  userId: string;
  identity: PassportIdentity;
  travelerState?: TravelerState;
  availability?: AvailabilityProjection;
  intent?: IntentProjection;
  trust?: TrustProjection;
  credentials: CredentialProjection[];
  stats: TravelStats;
  stamps: StampProjection[];
  featuredJourney?: JourneyProjection;
  upcomingPlans: PlanProjection[];
  memories: MemoryProjection[];
  travelIdentity?: TravelIdentityProjection;
  sharedContext?: SharedContextProjection;
  capabilities: PassportActionCapabilities;
  viewerContext: PassportViewerContext;
  /** Present when privacy/blocking reduced the projection to a minimal card. */
  restricted?: { reason: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewer context
// ─────────────────────────────────────────────────────────────────────────────

/** Pure classifier — maps relationship facts onto TABLE 5. Exposed for tests. */
export function classifyViewerContext(input: {
  isSelf: boolean;
  isBlocked: boolean;
  relationshipLabel: string;
  sharedTrip: boolean;
  ownerIsTripHost: boolean;
  sharedEvent: boolean;
  buddyRole: "provider" | "customer" | null;
}): PassportViewerContext {
  if (input.isSelf) return "self";
  // A block collapses to the least-privileged context; the projection layer
  // additionally strips data, but the context must not leak a relationship.
  if (input.isBlocked) return "public";
  if (input.sharedTrip && input.ownerIsTripHost) return "trip_host";
  if (input.sharedTrip) return "trip_crew";
  if (input.buddyRole === "provider") return "buddy_provider";
  if (input.buddyRole === "customer") return "buddy_customer";
  if (input.sharedEvent) return "event_group";
  const rel = input.relationshipLabel;
  if (rel === "following" || rel === "mutual_follow" || rel === "friend") return "following";
  if (rel === "follower") return "follower";
  return "public";
}

function toViewerPermissions(p: InteractionPermissions): ViewerPermissions {
  const blocked = p.relationshipLabel === "blocked" || p.relationshipLabel === "blocks_you" || p.relationshipLabel === "mutual_block";
  return {
    relationshipLabel: p.relationshipLabel,
    isBlocked: blocked,
    isUnavailable: p.relationshipLabel === "unavailable",
    canViewProfile: p.canViewProfile,
    canViewFullProfile: p.canViewFullProfile,
    canSeeAvailability: p.canSeeAvailability,
    canSeeTrips: p.canSeeTrips,
    canSeeMutuals: p.canSeeMutuals,
    canSeeLocationContext: p.canSeeLocationContext,
    canSeeFriendOnlyPosts: p.canSeeFriendOnlyPosts,
    canMessage: p.canMessage,
    canSendMessageRequest: p.canSendMessageRequest,
    canFollow: p.canFollow,
    canInviteToTripCrew: p.canInviteToTripCrew,
  };
}

/** Determine whether owner + viewer share a trip and whether the OWNER hosts it. */
async function resolveSharedTripRole(
  sc: SupabaseClient,
  ownerId: string,
  viewerId: string,
): Promise<{ sharedTrip: boolean; ownerIsTripHost: boolean }> {
  try {
    const [ownerTrips, viewerTrips] = await Promise.all([
      sc.from("trip_members").select("trip_id, role").eq("user_id", ownerId).neq("role", "invited"),
      sc.from("trip_members").select("trip_id").eq("user_id", viewerId).neq("role", "invited"),
    ]);
    const viewerSet = new Set(((viewerTrips as any).data ?? []).map((r: any) => r.trip_id).filter(Boolean));
    const shared = (((ownerTrips as any).data ?? []) as any[]).filter((r) => viewerSet.has(r.trip_id));
    if (shared.length === 0) return { sharedTrip: false, ownerIsTripHost: false };
    const sharedIds = shared.map((r) => r.trip_id);
    // Owner hosts when they own any shared trip.
    const { data: owned } = await sc
      .from("trips")
      .select("id, owner_id")
      .in("id", sharedIds)
      .eq("owner_id", ownerId);
    return { sharedTrip: true, ownerIsTripHost: Array.isArray(owned) && owned.length > 0 };
  } catch {
    return { sharedTrip: false, ownerIsTripHost: false };
  }
}

/** Determine a buddy service relationship between owner and viewer, if any. */
async function resolveBuddyRole(
  sc: SupabaseClient,
  ownerId: string,
  viewerId: string,
): Promise<"provider" | "customer" | null> {
  const active = ["confirmed", "active", "completed", "in_progress"];
  try {
    const { data } = await sc
      .from("rent_buddy_bookings")
      .select("buddy_id, traveler_id, status")
      .or(
        `and(buddy_id.eq.${ownerId},traveler_id.eq.${viewerId}),and(buddy_id.eq.${viewerId},traveler_id.eq.${ownerId})`,
      );
    for (const r of ((data as any[]) ?? [])) {
      if (!active.includes(String(r.status))) continue;
      if (r.buddy_id === ownerId && r.traveler_id === viewerId) return "provider"; // owner provides
      if (r.traveler_id === ownerId && r.buddy_id === viewerId) return "customer"; // owner is customer
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the viewer's context (TABLE 5) plus the permission surface the
 * projection layer needs. Reuses the canonical interaction-permission engine.
 */
export async function resolvePassportViewerContext(
  sc: SupabaseClient,
  ownerId: string,
  viewerId: string | null,
): Promise<ViewerResolution> {
  if (viewerId && viewerId === ownerId) {
    return {
      context: "self",
      permissions: {
        relationshipLabel: "self",
        isBlocked: false,
        isUnavailable: false,
        canViewProfile: true,
        canViewFullProfile: true,
        canSeeAvailability: true,
        canSeeTrips: true,
        canSeeMutuals: true,
        canSeeLocationContext: true,
        canSeeFriendOnlyPosts: true,
        canMessage: false,
        canSendMessageRequest: false,
        canFollow: false,
        canInviteToTripCrew: false,
      },
      sharedTrip: false,
      sharedEvent: false,
      ownerIsTripHost: false,
      buddyRole: null,
    };
  }

  // Unauthenticated viewer → public, no relationship queries needed.
  if (!viewerId) {
    return {
      context: "public",
      permissions: {
        relationshipLabel: "stranger",
        isBlocked: false,
        isUnavailable: false,
        canViewProfile: true,
        canViewFullProfile: false,
        canSeeAvailability: false,
        canSeeTrips: false,
        canSeeMutuals: false,
        canSeeLocationContext: false,
        canSeeFriendOnlyPosts: false,
        canMessage: false,
        canSendMessageRequest: false,
        canFollow: true,
        canInviteToTripCrew: false,
      },
      sharedTrip: false,
      sharedEvent: false,
      ownerIsTripHost: false,
      buddyRole: null,
    };
  }

  const raw = await resolveInteractionPermissions(sc, viewerId, ownerId);
  const permissions = toViewerPermissions(raw);

  // A block / unavailable target ends resolution at the least-privileged context.
  if (permissions.isBlocked || permissions.isUnavailable) {
    return {
      context: "public",
      permissions,
      sharedTrip: false,
      sharedEvent: raw.context.sharedEvent,
      ownerIsTripHost: false,
      buddyRole: null,
    };
  }

  const [{ sharedTrip, ownerIsTripHost }, buddyRole] = await Promise.all([
    raw.context.sharedTrip
      ? resolveSharedTripRole(sc, ownerId, viewerId)
      : Promise.resolve({ sharedTrip: false, ownerIsTripHost: false }),
    resolveBuddyRole(sc, ownerId, viewerId),
  ]);

  const context = classifyViewerContext({
    isSelf: false,
    isBlocked: permissions.isBlocked,
    relationshipLabel: permissions.relationshipLabel,
    sharedTrip,
    ownerIsTripHost,
    sharedEvent: raw.context.sharedEvent,
    buddyRole,
  });

  return { context, permissions, sharedTrip, sharedEvent: raw.context.sharedEvent, ownerIsTripHost, buddyRole };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/** Trust facts the owner-capability derivation needs (already privacy-safe). */
export interface OwnerTrustFacts {
  publicLevel: string;
  verified: boolean;
  buddyVerified: boolean;
  restrictions: {
    hosting: boolean;
    privatePlan: boolean;
    messaging: boolean;
    locationPlan: boolean;
  };
}

/**
 * Map the owner's live restriction state (the same authoritative read every
 * action gate uses) onto the capability facts. A degraded read keeps
 * getRestrictionState's fail-closed posture on hosting/messaging, so a
 * transient error can never re-light a chip the gate itself would refuse.
 */
export function ownerRestrictionsFromState(state: RestrictionState): OwnerTrustFacts["restrictions"] {
  return {
    hosting: !state.canHost,
    privatePlan: !state.canJoinPrivatePlans,
    messaging: !state.canMessage,
    locationPlan: !state.canJoinLocationPlans,
  };
}

const LEVEL_RANK: Record<string, number> = {
  new_traveler: 0,
  building_trust: 1,
  reliable_traveler: 2,
  trusted_traveler: 3,
  highly_trusted: 4,
  city_trusted: 5,
};

/**
 * Positive owner capabilities (TABLE 14) — derived server-side from trust
 * level + active restrictions. These are the OWNER's credentials; they are NOT
 * an authorization the viewer's client may infer a policy from (§11, §30).
 */
export function buildOwnerCapabilities(facts: OwnerTrustFacts): PassportPositiveCapabilities {
  const rank = LEVEL_RANK[facts.publicLevel] ?? 0;
  const r = facts.restrictions;
  return {
    canJoinPublicTrip: !r.privatePlan && !r.locationPlan,
    canHostTrip: !r.hosting && rank >= 1,
    canCreateLargePlan: !r.hosting && rank >= 3,
    canUseCrewLocation: !r.locationPlan && rank >= 1,
    canContributeLiveIntel: rank >= 2,
    canBecomeBuddy: facts.buddyVerified || (facts.verified && rank >= 3),
  };
}

/**
 * Per-viewer action eligibility (TABLE 29). Server owns this — the client
 * renders the booleans and never re-derives them.
 */
export function buildViewerActions(
  permissions: ViewerPermissions,
  ownerCaps: PassportPositiveCapabilities,
): PassportViewerActions {
  if (permissions.isBlocked || permissions.isUnavailable) {
    return {
      can_follow: false,
      can_message: false,
      can_make_plan: false,
      can_invite_trip: false,
      can_view_availability: false,
      can_view_trust: false,
    };
  }
  const canInvite = permissions.canInviteToTripCrew;
  return {
    can_follow: permissions.canFollow,
    can_message: permissions.canMessage || permissions.canSendMessageRequest,
    // A plan needs BOTH a permitted viewer relationship AND an owner who can
    // actually join a plan — both computed server-side.
    can_make_plan: canInvite && ownerCaps.canJoinPublicTrip,
    can_invite_trip: canInvite,
    can_view_availability: permissions.canSeeAvailability,
    // Trust badge is contextual: viewable whenever the profile itself is.
    can_view_trust: permissions.canViewProfile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate assembly helpers
// ─────────────────────────────────────────────────────────────────────────────

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/** PassportViewerContext → PassportPrivacyGuard.CallerContext for stamp/memory gating. */
export function toCallerContext(context: PassportViewerContext, permissions: ViewerPermissions): CallerContext {
  if (context === "self") return "owner";
  if (context === "trip_crew" || context === "trip_host") return "trip_crew";
  // Friend/full-profile relationships act as the "circle" proxy for tiered items.
  if (permissions.canViewFullProfile || permissions.canSeeFriendOnlyPosts) return "circle";
  return "public";
}

/**
 * The owner's TABLE 24 location opt-outs (§22) from profile_privacy_settings.
 * Only the columns that exist there are read — nothing is invented.
 */
export interface OwnerFieldVisibility {
  /** profile_privacy_settings.show_home_country — gates identity.homeCountry (+ homeBase). */
  showHomeCountry: boolean;
  /** profile_privacy_settings.show_current_city — gates travelerState.city/label. */
  showCurrentCity: boolean;
}

const OWNER_FIELDS_HIDDEN: OwnerFieldVisibility = { showHomeCountry: false, showCurrentCity: false };

/**
 * Load the owner's location opt-outs. The model is show-by-default, so an
 * absent settings row shows; but a READ ERROR fails CLOSED (hide), since these
 * guard the known location-after-opt-out privacy class (same posture as the
 * public-passport reader in routes/follows.ts). The self view never consults
 * the result — the owner always sees their own data.
 */
async function loadOwnerFieldVisibility(sc: SupabaseClient, userId: string): Promise<OwnerFieldVisibility> {
  try {
    const { data, error } = await sc
      .from("profile_privacy_settings")
      .select("show_home_country, show_current_city")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return OWNER_FIELDS_HIDDEN;
    const row = (data as any) ?? null;
    return {
      showHomeCountry: row?.show_home_country !== false,
      showCurrentCity: row?.show_current_city !== false,
    };
  } catch {
    return OWNER_FIELDS_HIDDEN;
  }
}

function buildIdentity(
  profile: Record<string, any>,
  permissions: ViewerPermissions,
  visibility: OwnerFieldVisibility,
): PassportIdentity {
  const isSelf = permissions.relationshipLabel === "self";
  const showAvatar = isSelf || profile.show_profile_picture_publicly !== false;
  // Home country / base are user-controlled (TABLE 24, §22). The owner always
  // sees their own. A non-owner sees the coarse country only while
  // show_home_country is on, and the home base only with a full-profile
  // relationship AND that same opt-in — a home base is a strict refinement of
  // the country ("Hanoi" discloses the country the owner just hid).
  const showHomeCountry = isSelf || visibility.showHomeCountry;
  const showHomeBase = isSelf || (permissions.canViewFullProfile && visibility.showHomeCountry);
  return {
    userId: profile.id,
    name: profile.display_name ?? profile.name ?? null,
    handle: profile.handle ?? profile.username ?? null,
    avatarUrl: showAvatar ? (profile.avatar_url ?? null) : null,
    coverUrl: profile.cover_photo_url ?? null,
    verified: profile.verified === true || Boolean(profile.verified_at),
    verificationLevel: profile.verification_level ?? null,
    homeCountry: showHomeCountry ? (profile.home_country ?? null) : null,
    homeBase: showHomeBase ? (profile.home_city ?? null) : null,
    isOfficial: profile.is_official === true,
  };
}

/** Current, non-stale quick availability. */
async function loadQuickStatus(
  sc: SupabaseClient,
  userId: string,
): Promise<{ status: string; expiresAt: string | null } | null> {
  try {
    const { data } = await sc
      .from("quick_availability_status")
      .select("status, expires_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    const row = data as any;
    if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;
    return { status: row.status, expiresAt: row.expires_at ?? null };
  } catch {
    return null;
  }
}

function buildTravelerState(
  profile: Record<string, any>,
  quick: { status: string; expiresAt: string | null } | null,
  activeTripCity: string | null,
  activity: TravelerActivity,
  permissions: ViewerPermissions,
  visibility: OwnerFieldVisibility,
): TravelerState {
  const isSelf = permissions.relationshipLabel === "self";
  // A non-owner needs BOTH a relationship that may see location context AND
  // the owner's show_current_city opt-in (TABLE 24, §22) — whichever source
  // the city came from (profile.current_city or the active trip), it is the
  // owner's current city.
  const showCity = isSelf || (permissions.canSeeLocationContext && visibility.showCurrentCity);
  const currentCity = norm(profile.current_city);
  const homeCity = norm(profile.home_city);

  let state: TravelerStateKind = "home";
  let city: string | null = null;
  // §5: every temporary state carries validFrom + expiration. Defaults null;
  // each derived state below sets its own bounds from the underlying record.
  let validFrom: string | null = null;
  let expiresAt: string | null = quick?.expiresAt ?? null;

  // Precedence (most specific/actionable first). An explicit "busy" always wins
  // — the traveler has said not to bother them, so no activity overrides it.
  // Otherwise the concrete real-time activities (§5) rank above the coarse
  // traveling / open-to-plans reads, which rank above the default home.
  if (quick?.status === "busy") {
    state = "unavailable";
  } else if (activity.atEvent) {
    state = "at_event";
    // Broad event city is ordinary Passport context, still gated below.
    city = activity.atEvent.city;
    validFrom = activity.atEvent.startsAt;
    expiresAt = activity.atEvent.endsAt;
  } else if (activity.withCrew) {
    state = "with_crew";
    // Crew session location is purpose-bound Presence (§23/§25) — never a city here.
    validFrom = activity.withCrew.startedAt;
    expiresAt = activity.withCrew.expiresAt;
  } else if (activity.exploring) {
    state = "exploring";
    // Trip-stop coordinates are purpose-bound Presence (§23/§25) — never a city here.
    validFrom = activity.exploring.arrivedAt;
    expiresAt = activity.exploring.departsAt;
  } else if (activeTripCity) {
    state = "traveling";
    city = activeTripCity;
  } else if (currentCity && currentCity !== homeCity) {
    state = "traveling";
    city = profile.current_city ?? null;
  } else if (quick && (quick.status === "open_to_plans" || quick.status === "free_tonight" || quick.status === "free_now")) {
    state = "open_to_plans";
  } else if (profile.open_to_meet === true) {
    state = "open_to_plans";
  }

  // City is projected only when the viewer may see location context (§5/§23).
  // The human-readable label must honor the SAME gate — otherwise a viewer with
  // the structured `city` field nulled would still read "Traveling · Da Nang".
  const displayCity = showCity ? city : null;

  const labels: Record<TravelerStateKind, string> = {
    home: "Home",
    traveling: displayCity ? `Traveling · ${displayCity}` : "Traveling",
    exploring: "Exploring",
    open_to_plans: "Open to Plans",
    at_event: displayCity ? `At Event · ${displayCity}` : "At Event",
    with_crew: "With Crew",
    unavailable: "Unavailable",
  };

  return {
    state,
    label: labels[state],
    city: displayCity,
    validFrom,
    expiresAt,
  };
}

/** TABLE 5 viewer context → the §7 window visibility relationship. */
export function toWindowViewerRelationship(context: PassportViewerContext): WindowViewerRelationship {
  switch (context) {
    case "self": return "self";
    case "follower": return "follower";
    case "following": return "following";
    // Trip crew/host are the "crew" relationship for window visibility.
    case "trip_crew":
    case "trip_host": return "crew";
    // Buddy/event/public relationships get only public windows.
    default: return "public";
  }
}

/**
 * The §8 explicit availability window active NOW for the owner and visible to
 * this viewer, or null. Gated by the windows feature flag (fail-closed): when
 * off, the aggregate carries no window and the legacy quick-status/grid still
 * apply. §7 (explicit-only, visibility) and §31 (expiry-on-read) are enforced by
 * OpenToPlansService — for a non-self viewer via projectPublicWindows (explicit
 * + visible + non-expired), for the owner via their own active windows.
 */
async function loadActiveExplicitWindow(
  sc: SupabaseClient,
  userId: string,
  context: PassportViewerContext,
): Promise<ActiveAvailabilityWindow | null> {
  try {
    if (!(await isFlagEnabled(sc, OPEN_TO_PLANS_WINDOWS_FLAG))) return null;
    const nowMs = Date.now();
    const relationship = toWindowViewerRelationship(context);
    let candidates: AvailabilityWindow[];
    if (relationship === "self") {
      // The owner sees their own active windows regardless of visibility, but
      // the aggregate is EXPLICIT-only (§7): an inferred (plan_derived) window is
      // a private "Free tonight?" prompt, never the owner's shared availability.
      const own = await listWindows(sc, userId, { includeExpired: false, nowMs });
      candidates = own.filter((w) => w.source === "explicit" && isWindowActive(w, nowMs));
    } else {
      // projectPublicWindows already applies §7 (explicit-only + visibility) and
      // §31 (non-expired); narrow to those actually active (already started).
      const visible = await projectPublicWindows(sc, userId, relationship, nowMs);
      candidates = visible.filter((w) => isWindowActive(w, nowMs));
    }
    if (candidates.length === 0) return null;
    // Soonest-ending active window is the current one.
    candidates.sort((a, b) => windowEffectiveExpiry(a) - windowEffectiveExpiry(b));
    const w = candidates[0];
    return {
      type: w.type,
      startAt: w.startAt,
      endAt: w.endAt,
      intents: Array.isArray(w.intents) ? w.intents.slice(0, 8) : [],
      groupPreference: w.groupPreference,
      maxTravelMinutes: w.maxTravelMinutes,
      socialAvailability: w.socialAvailability,
      expiresAt: new Date(windowEffectiveExpiry(w)).toISOString(),
    };
  } catch {
    return null;
  }
}

async function buildAvailability(
  sc: SupabaseClient,
  userId: string,
  quick: { status: string; expiresAt: string | null } | null,
  explicitWindow: ActiveAvailabilityWindow | null,
): Promise<AvailabilityProjection> {
  let weekly: Record<string, string[]> = {};
  let openToMeet = false;
  try {
    const { data } = await sc.from("user_availability").select("weekly_days, open_to_meet").eq("user_id", userId).maybeSingle();
    if (data) {
      weekly = ((data as any).weekly_days ?? {}) as Record<string, string[]>;
      openToMeet = (data as any).open_to_meet === true;
    }
  } catch {
    /* tolerate */
  }
  // An active explicit window is the strongest signal (§8): its openToPlans and
  // socialAvailability override the coarse legacy reads when present.
  const openToPlans = explicitWindow != null || openToMeet || (quick != null && quick.status !== "busy");
  const social: AvailabilityProjection["socialAvailability"] =
    explicitWindow?.socialAvailability ?? (openToPlans ? "open" : "not_open");
  // The aggregate expiry is the SOONEST of the quick-status and window expiries —
  // never render either as current past its horizon (§31).
  const expiryCandidates = [quick?.expiresAt ?? null, explicitWindow?.expiresAt ?? null].filter(
    (x): x is string => typeof x === "string",
  );
  const expiresAt = expiryCandidates.length
    ? expiryCandidates.reduce((a, b) => (a <= b ? a : b))
    : null;
  return {
    openToPlans,
    socialAvailability: social,
    currentWindow: quick,
    explicitWindow,
    weekly,
    expiresAt,
  };
}

function buildIntent(
  profile: Record<string, any>,
  quick: { status: string; expiresAt: string | null } | null,
  explicitWindow: ActiveAvailabilityWindow | null,
): IntentProjection | undefined {
  // §8: an explicit window's intents are the current temporary intent and carry
  // the window's TTL. They take precedence over the profile's availability_tags.
  if (explicitWindow && explicitWindow.intents.length > 0) {
    return {
      current: explicitWindow.intents.slice(0, 8),
      ttlExpiresAt: explicitWindow.expiresAt,
      source: "explicit",
    };
  }
  const tags: string[] = Array.isArray(profile.availability_tags) ? profile.availability_tags.filter(Boolean) : [];
  if (tags.length === 0) return undefined;
  return {
    current: tags.slice(0, 8),
    ttlExpiresAt: quick?.expiresAt ?? null,
    source: "explicit",
  };
}

async function buildTrust(
  sc: SupabaseClient,
  userId: string,
  context: PassportViewerContext,
  stats: TravelStats,
  verified: boolean,
): Promise<TrustProjection> {
  // Confidence is evidence-aware (§9/§10): a score built on many stamps/trips is
  // more trustworthy than the same number on a brand-new account.
  const evidence = stats.stamps + stats.trips * 2 + (verified ? 3 : 0);
  const confidence: TrustProjection["confidence"] = evidence >= 12 ? "high" : evidence >= 4 ? "medium" : "low";

  if (context === "public") {
    const badge = await getPublicTrustBadge(sc, userId);
    // Non-stigmatizing copy for low-evidence accounts (§10).
    const label = confidence === "low" ? (verified ? "New Traveler · Verified" : "New Traveler") : badge.label;
    return { label, publicLevel: badge.level, score: null, confidence, strengths: badge.strengths };
  }

  const summary = await getSafeTrustSummary(sc, userId);
  const label = confidence === "low" && summary.publicLevel === "new_traveler"
    ? (verified ? "New Traveler · Verified" : "New Traveler")
    : (summary.publicLevel.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));

  // Numeric score is exposed only on the owner's own view (§9).
  let score: number | null = null;
  if (context === "self") {
    try {
      const { data } = await sc.from("trust_profiles").select("overall_score").eq("user_id", userId).maybeSingle();
      score = data ? Number((data as any).overall_score ?? 0) : null;
    } catch {
      score = null;
    }
  }

  return { label, publicLevel: summary.publicLevel, score, confidence, strengths: summary.strengths };
}

function buildCredentials(
  profile: Record<string, any>,
  trust: TrustProjection,
  stats: TravelStats,
): CredentialProjection[] {
  const creds: CredentialProjection[] = [];
  if (profile.verified === true || profile.verified_at) {
    creds.push({ key: "identity", label: "Identity Verified", detail: null, tier: "verified" });
  }
  // Established account (age > ~180 days).
  if (profile.created_at) {
    const ageDays = (Date.now() - new Date(profile.created_at).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays >= 180) {
      creds.push({ key: "established", label: "Established Account", detail: null, tier: "positive" });
    }
  }
  for (const s of trust.strengths.slice(0, 2)) {
    creds.push({ key: `strength_${norm(s)}`, label: s, detail: "Good standing", tier: "positive" });
  }
  if (stats.trips > 0) {
    creds.push({
      key: "trip_experience",
      label: "Trip Experience",
      detail: `${stats.trips} trip${stats.trips === 1 ? "" : "s"}`,
      tier: "positive",
    });
  }
  return creds;
}

function mapStamp(s: UnifiedStamp): StampProjection {
  return {
    source: s.source,
    name: s.name,
    city: s.city,
    country: s.country,
    earnedAt: s.earnedAt,
    rarity: s.rarity,
    artworkUrl: s.artworkUrl,
    // Unified stamps are all system/earned — never a self-reported decorative
    // badge, so they are safe to present as verified travel facts (§12).
    verification: "verified",
  };
}

/** Load passport visibility preferences (best-effort). */
async function loadVisibilityPrefs(sc: SupabaseClient, userId: string): Promise<Record<string, any> | null> {
  try {
    const { data } = await sc
      .from("passport_visibility_preferences")
      .select("stamps_visible, memories_visible")
      .eq("user_id", userId)
      .maybeSingle();
    return (data as any) ?? null;
  } catch {
    return null;
  }
}

/** Does a collection-level "public|friends_only|private" tier permit this caller? */
function tierPermits(tier: string | null | undefined, caller: CallerContext): boolean {
  const t = norm(tier);
  if (caller === "owner") return true;
  if (!t || t === "public") return true;
  if (t === "private") return false;
  // friends_only / circle_only / followers → circle or trip_crew only.
  return caller === "circle" || caller === "trip_crew";
}

async function buildUpcomingPlans(
  sc: SupabaseClient,
  userId: string,
  permissions: ViewerPermissions,
  context: PassportViewerContext,
): Promise<PlanProjection[]> {
  // Plans use PER-PLAN visibility (§16), not the blanket trips gate that
  // governs travel history: a trip explicitly set public + show_on_profile is
  // shown to any viewer; buddies/invite trips require a full-profile
  // relationship; private plans are never exposed (§34 non-goal).
  const isSelf = context === "self";
  const tripIds = new Set<string>();
  try {
    const [members, owned] = await Promise.all([
      sc.from("trip_members").select("trip_id").eq("user_id", userId).neq("role", "invited"),
      sc.from("trips").select("id").eq("owner_id", userId),
    ]);
    for (const r of ((members as any).data ?? []) as any[]) if (r.trip_id) tripIds.add(r.trip_id);
    for (const r of ((owned as any).data ?? []) as any[]) if (r.id) tripIds.add(r.id);
  } catch {
    return [];
  }
  if (tripIds.size === 0) return [];

  let rows: any[] = [];
  try {
    const { data } = await sc
      .from("trips")
      .select("id, title, destination_city, destination_country, start_date, end_date, status, visibility, show_on_profile, show_exact_dates")
      .in("id", Array.from(tripIds))
      .in("status", ["planning", "upcoming", "active"]);
    rows = (data as any[]) ?? [];
  } catch {
    return [];
  }

  const canSeeRestricted = permissions.canViewFullProfile || context === "trip_crew" || context === "trip_host";
  return rows
    .filter((t) => {
      if (isSelf) return true;
      if (t.show_on_profile === false) return false; // Plans default private/followers (TABLE 24)
      const v = String(t.visibility ?? "private");
      if (v === "public") return true;
      return (v === "buddies" || v === "invite") && canSeeRestricted;
    })
    .map((t) => {
      const showDates = isSelf || t.show_exact_dates !== false;
      return {
        tripId: t.id,
        title: t.title ?? "Trip",
        destinationCity: t.destination_city ?? null,
        destinationCountry: t.destination_country ?? null,
        startDate: showDates ? (t.start_date ?? null) : null,
        endDate: showDates ? (t.end_date ?? null) : null,
        visibility: String(t.visibility ?? "private"),
      };
    });
}

/** City of an active trip the user is currently on, if any. */
async function loadActiveTripCity(sc: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data: owned } = await sc
      .from("trips")
      .select("destination_city, status")
      .eq("owner_id", userId)
      .eq("status", "active")
      .limit(1);
    if (Array.isArray(owned) && owned.length > 0) return (owned[0] as any).destination_city ?? null;
  } catch {
    /* tolerate */
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-time traveler-state signals (§5): exploring / at_event / with_crew.
//
// §5 requires that Passport separate PERMANENT identity from TEMPORARY traveler
// state, and that every temporary state carry `validFrom` + expiration semantics.
// buildTravelerState (below) previously only ever produced home / traveling /
// open_to_plans / unavailable and always left `validFrom` null. These loaders
// derive the three activity states from CANONICAL records — never invented, and
// always time-bounded so a stale activity can never read as "now" (§31):
//
//   • exploring  — an active trip stop in progress: a route_stops row the owner
//                  has ARRIVED at, still within its planned departure window.
//   • at_event   — an event the owner RSVP'd "going" to that is happening now
//                  (started, not yet ended, in a live state).
//   • with_crew  — an active, un-expired Locate/crew session the owner has
//                  opted into and not left.
//
// Location boundary (§23/§25): `at_event` may surface the event's BROAD city as
// ordinary Passport context (subject to the same show_current_city gate as every
// other city here). `with_crew` and `exploring` are purpose-bound Presence — the
// crew session and the trip-stop coordinates belong to Locate/Crew, never to an
// ordinary Passport read — so those states expose NO city at all.
// ─────────────────────────────────────────────────────────────────────────────

/** The highest-priority real-time activity a traveler is currently engaged in. */
interface TravelerActivity {
  atEvent: { city: string | null; startsAt: string | null; endsAt: string } | null;
  withCrew: { startedAt: string | null; expiresAt: string } | null;
  exploring: { arrivedAt: string | null; departsAt: string } | null;
}

const NO_ACTIVITY: TravelerActivity = { atEvent: null, withCrew: null, exploring: null };

/** Event states in which an RSVP'd event is genuinely happening (not draft/cancelled/archived). */
const LIVE_EVENT_STATES = new Set(["open", "full", "waitlist", "started"]);

/** An event the user RSVP'd "going" to that is happening right now (bounded by ends_at). */
async function loadActiveRsvpEvent(
  sc: SupabaseClient,
  userId: string,
  nowIso: string,
): Promise<TravelerActivity["atEvent"]> {
  const { data: rsvps } = await sc
    .from("event_rsvps")
    .select("event_id, status")
    .eq("user_id", userId)
    .eq("status", "going");
  const ids = ((rsvps as any[]) ?? []).map((r) => r.event_id).filter(Boolean);
  if (ids.length === 0) return null;
  const { data: events } = await sc
    .from("events")
    .select("id, city, starts_at, ends_at, state")
    .in("id", ids);
  // Happening now: live state, started, and an explicit end still in the future.
  // An event with no ends_at cannot be time-bounded, so it never becomes an
  // unbounded "At Event" — §5 requires expiration semantics.
  const live = ((events as any[]) ?? []).filter(
    (e) =>
      LIVE_EVENT_STATES.has(String(e.state)) &&
      typeof e.starts_at === "string" && e.starts_at <= nowIso &&
      typeof e.ends_at === "string" && e.ends_at >= nowIso,
  );
  if (live.length === 0) return null;
  // Prefer the event ending soonest — the most concretely "now".
  live.sort((a, b) => String(a.ends_at).localeCompare(String(b.ends_at)));
  const e = live[0];
  return { city: e.city ?? null, startsAt: e.starts_at ?? null, endsAt: String(e.ends_at) };
}

/** An active, un-expired Locate/crew session the user has opted into and not left. */
async function loadActiveCrewSession(
  sc: SupabaseClient,
  userId: string,
  nowIso: string,
): Promise<TravelerActivity["withCrew"]> {
  const { data: members } = await sc
    .from("locate_friends_members")
    .select("session_id, left_at")
    .eq("user_id", userId)
    .is("left_at", null);
  const ids = ((members as any[]) ?? []).map((m) => m.session_id).filter(Boolean);
  if (ids.length === 0) return null;
  const { data: sessions } = await sc
    .from("locate_friends_sessions")
    .select("id, started_at, expires_at, ended_at")
    .in("id", ids)
    .is("ended_at", null)
    .gt("expires_at", nowIso);
  const active = ((sessions as any[]) ?? []).filter((s) => typeof s.expires_at === "string");
  if (active.length === 0) return null;
  // Soonest-expiring active session bounds the state.
  active.sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)));
  const s = active[0];
  return { startedAt: s.started_at ?? null, expiresAt: String(s.expires_at) };
}

/** A trip stop the owner has arrived at and is still within the planned departure window. */
async function loadActiveTripStop(
  sc: SupabaseClient,
  userId: string,
  nowIso: string,
): Promise<TravelerActivity["exploring"]> {
  const { data: plans } = await sc
    .from("route_plans")
    .select("id, status")
    .eq("owner_user_id", userId)
    .eq("status", "active");
  const planIds = ((plans as any[]) ?? []).map((p) => p.id).filter(Boolean);
  if (planIds.length === 0) return null;
  const { data: stops } = await sc
    .from("route_stops")
    .select("route_plan_id, checkpoint_status, arrived_at, planned_arrival_time, planned_departure_time")
    .in("route_plan_id", planIds)
    .eq("checkpoint_status", "arrived");
  // In progress now: arrived, still before the planned departure, and (if a
  // planned arrival exists) already past it. A stop with no planned departure
  // cannot be bounded, so it never becomes an unbounded "Exploring".
  const inProgress = ((stops as any[]) ?? []).filter(
    (s) =>
      typeof s.planned_departure_time === "string" && s.planned_departure_time >= nowIso &&
      (s.planned_arrival_time == null || s.planned_arrival_time <= nowIso),
  );
  if (inProgress.length === 0) return null;
  inProgress.sort((a, b) => String(a.planned_departure_time).localeCompare(String(b.planned_departure_time)));
  const s = inProgress[0];
  return {
    arrivedAt: s.arrived_at ?? s.planned_arrival_time ?? null,
    departsAt: String(s.planned_departure_time),
  };
}

/** Load all three activity signals in parallel; any failure degrades to "no signal". */
async function loadTravelerActivity(sc: SupabaseClient, userId: string): Promise<TravelerActivity> {
  const nowIso = new Date().toISOString();
  const [atEvent, withCrew, exploring] = await Promise.all([
    loadActiveRsvpEvent(sc, userId, nowIso).catch(() => null),
    loadActiveCrewSession(sc, userId, nowIso).catch(() => null),
    loadActiveTripStop(sc, userId, nowIso).catch(() => null),
  ]);
  return { atEvent, withCrew, exploring };
}

/** Derive light Travel-DNA signals from unified stamps + stats. */
function deriveTravelSignals(profile: Record<string, any>, stamps: UnifiedStamp[], stats: TravelStats, hiddenGems: number): TravelIdentitySignals {
  let nightlife = 0;
  let food = 0;
  const tags = new Set<string>();
  for (const s of stamps) {
    const t = norm(s.stampType) + " " + norm(s.name);
    if (t.includes("night") || t.includes("bar") || t.includes("club")) nightlife++;
    if (t.includes("food") || t.includes("cuisine") || t.includes("restaurant") || t.includes("eat")) food++;
    if (s.stampType) tags.add(norm(s.stampType));
  }
  return {
    interestTags: Array.from(tags).slice(0, 12),
    hiddenGemCount: hiddenGems,
    nightlifeCount: nightlife,
    foodCount: food,
    countriesCount: stats.countries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildPassportProjection
// ─────────────────────────────────────────────────────────────────────────────

const PROJECTION_PROFILE_COLUMNS =
  "id, username, handle, display_name, name, avatar_url, cover_photo_url, verified, verified_at, verification_level, " +
  "home_city, home_country, current_city, is_official, is_private, passport_visibility, show_profile_picture_publicly, " +
  "interests, availability_tags, spoken_languages, travel_pace, planning_style, budget_style, travel_group_style, " +
  "open_to_meet, buddy_verified_at, created_at";

export interface BuildProjectionOptions {
  /** Inject a resolver (tests) — defaults to the real relationship engine. */
  resolveViewerContext?: (
    sc: SupabaseClient,
    ownerId: string,
    viewerId: string | null,
  ) => Promise<ViewerResolution>;
  /** Pre-loaded profile row (avoids a round trip when the caller has it). */
  profileRow?: Record<string, any> | null;
}

/**
 * Assemble the §29 aggregate for `userId` as seen by `viewerId` (null = public).
 * All privacy filtering is applied here, server-side, before returning.
 */
export async function buildPassportProjection(
  sc: SupabaseClient,
  userId: string,
  viewerId: string | null,
  opts: BuildProjectionOptions = {},
): Promise<PassportProjection | null> {
  // 1. Owner profile.
  let profile = opts.profileRow ?? null;
  if (!profile) {
    try {
      const { data } = await sc.from("profiles").select(PROJECTION_PROFILE_COLUMNS).eq("id", userId).maybeSingle();
      profile = (data as any) ?? null;
    } catch {
      profile = null;
    }
  }
  if (!profile) return null;

  // 2. Viewer context + permissions (server-side authority), alongside the
  //    owner's TABLE 24 location opt-outs (the self view ignores them).
  const resolver = opts.resolveViewerContext ?? resolvePassportViewerContext;
  const [resolution, ownerVisibility] = await Promise.all([
    resolver(sc, userId, viewerId),
    loadOwnerFieldVisibility(sc, userId),
  ]);
  const { context, permissions } = resolution;
  const isSelf = context === "self";
  const callerCtx = toCallerContext(context, permissions);

  const identity = buildIdentity(profile, permissions, ownerVisibility);

  // 3. Blocked / unavailable → minimal restricted card (§4/§22/§30).
  if (permissions.isBlocked || permissions.isUnavailable) {
    const ownerCaps = buildOwnerCapabilities({
      publicLevel: "new_traveler",
      verified: identity.verified,
      buddyVerified: false,
      restrictions: { hosting: false, privatePlan: false, messaging: false, locationPlan: false },
    });
    return {
      userId,
      identity: { ...identity, homeBase: null, homeCountry: null },
      credentials: [],
      stats: { countries: 0, cities: 0, stamps: 0, trips: 0 },
      stamps: [],
      upcomingPlans: [],
      memories: [],
      capabilities: { owner: ownerCaps, actions: buildViewerActions(permissions, ownerCaps) },
      viewerContext: context,
      restricted: { reason: permissions.isUnavailable ? "account_unavailable" : "blocked" },
    };
  }

  // 4. Shared canonical reads (in parallel).
  const [statsRaw, tripCount, unified, quick, prefs, restrictionState] = await Promise.all([
    buildStats(sc, userId).catch(() => ({ countries: 0, cities: 0, hiddenGemStamps: 0, totalStamps: 0 } as any)),
    countUserTrips(sc, userId).catch(() => ({ count: 0 })),
    buildUnifiedStamps(sc, userId).catch(() => ({ stamps: [] as UnifiedStamp[], count: 0 } as any)),
    loadQuickStatus(sc, userId),
    loadVisibilityPrefs(sc, userId),
    // The owner's ACTIVE trust restrictions — never throws (degraded reads
    // resolve fail-closed on hosting/messaging inside the service).
    getRestrictionState(sc, userId),
  ]);

  const stats: TravelStats = {
    countries: statsRaw.countries ?? 0,
    cities: statsRaw.cities ?? 0,
    stamps: unified.count ?? 0,
    trips: tripCount.count ?? 0,
  };

  // 5. Traveler state + availability + intent (availability/intent gated).
  const [activeTripCity, activity] = await Promise.all([
    loadActiveTripCity(sc, userId),
    loadTravelerActivity(sc, userId),
  ]);
  const travelerState = buildTravelerState(profile, quick, activeTripCity, activity, permissions, ownerVisibility);

  let availability: AvailabilityProjection | undefined;
  let intent: IntentProjection | undefined;
  if (isSelf || permissions.canSeeAvailability) {
    // §8: an explicit availability window (visible to this viewer under §7) is
    // projected into the aggregate alongside the legacy quick-status/grid.
    const explicitWindow = await loadActiveExplicitWindow(sc, userId, context);
    availability = await buildAvailability(sc, userId, quick, explicitWindow);
    intent = buildIntent(profile, quick, explicitWindow);
  }

  // 6. Trust + credentials.
  const trust = await buildTrust(sc, userId, context, stats, identity.verified);
  const credentials = buildCredentials(profile, trust, stats);

  // 7. Stamps (collection-level visibility + per-item privacy already earned).
  let stamps: StampProjection[] = [];
  if (tierPermits(prefs?.stamps_visible, callerCtx)) {
    stamps = (unified.stamps as UnifiedStamp[]).slice(0, 24).map(mapStamp);
  }

  // 8. Featured journey + upcoming plans.
  const journeyPerms: JourneyPermissions = {
    isSelf,
    canSeeTrips: permissions.canSeeTrips,
    canSeeRestricted: permissions.canViewFullProfile || context === "trip_crew" || context === "trip_host",
    // Per-memory gate for the featured journey's memories (same context the
    // standalone `memories` array uses in step 9).
    callerCtx,
  };
  const [featuredJourney, upcomingPlans] = await Promise.all([
    buildFeaturedJourney(sc, userId, journeyPerms).catch(() => null),
    buildUpcomingPlans(sc, userId, permissions, context),
  ]);

  // 9. Memories (privacy-guarded per item + collection tier).
  let memories: MemoryProjection[] = [];
  if (tierPermits(prefs?.memories_visible, callerCtx)) {
    try {
      const raw = await loadMemories(sc, userId);
      const guarded = filterMemories(raw as any[], callerCtx);
      memories = guarded.slice(0, 24).map((m: any) => ({
        id: m.id,
        title: m.title ?? null,
        city: m.city ?? null,
        country: m.country ?? null,
        category: m.category ?? null,
        photoUrl: m.photo_url ?? null,
        earnedAt: m.earned_at ?? null,
        tripId: m.trip_id ?? null,
      }));
    } catch {
      memories = [];
    }
  }

  // 10. Travel identity (Travel DNA).
  const signals = deriveTravelSignals(profile, unified.stamps as UnifiedStamp[], stats, statsRaw.hiddenGemStamps ?? 0);
  let travelIdentity: TravelIdentityProjection | undefined;
  try {
    const ti = await buildTravelIdentity(sc, userId, profile, signals, { isSelf });
    travelIdentity = filterTravelIdentityForViewer(ti, isSelf);
  } catch {
    travelIdentity = undefined;
  }

  // 11. Shared context (viewer relationship only; never for self/public).
  let sharedContext: SharedContextProjection | undefined;
  if (!isSelf && viewerId) {
    const scPerms: SharedContextPermissions = {
      canSeeAvailability: permissions.canSeeAvailability,
      canSeeMutuals: permissions.canSeeMutuals,
      canSeeTrips: permissions.canSeeTrips,
      canMakePlan: permissions.canInviteToTripCrew,
    };
    sharedContext = await buildSharedContext(sc, userId, viewerId, scPerms).catch(() => undefined);
  }

  // 12. Capabilities (server-projected).
  const ownerCaps = buildOwnerCapabilities({
    publicLevel: trust.publicLevel,
    verified: identity.verified,
    buddyVerified: Boolean(profile.buddy_verified_at),
    // The owner's live restriction state (TABLE 14): a restricted owner must
    // not display a chip ("Host trips", "Share crew location", ...) for an
    // action the gates would refuse. The safe trust summary flattens these to
    // messages, so the structured read is threaded here explicitly.
    restrictions: ownerRestrictionsFromState(restrictionState),
  });
  const capabilities: PassportActionCapabilities = {
    owner: ownerCaps,
    actions: buildViewerActions(permissions, ownerCaps),
  };

  const projection: PassportProjection = {
    userId,
    identity,
    travelerState,
    availability,
    intent,
    trust,
    credentials,
    stats,
    stamps,
    featuredJourney: featuredJourney ?? undefined,
    upcomingPlans,
    memories,
    travelIdentity,
    sharedContext,
    capabilities,
    viewerContext: context,
  };
  return projection;
}

// ─────────────────────────────────────────────────────────────────────────────
// §31 cache tiering
//
// §31 splits the aggregate into two cache classes:
//   • STATIC — identity, stamp metadata, travel stats, travel identity, credentials
//     and permitted public journeys/memories/plans change rarely.
//   • DYNAMIC — Availability, current state, Open to Plans, Shared Context, Trust
//     projection and capabilities MUST use short TTLs and "never render stale".
//
// The route sets one Cache-Control max-age (the SHORTEST TTL among the sections
// actually present, so the response as a whole is only cacheable as long as its
// most volatile part) plus an ETag. The per-section `sections` map is returned
// in the body so the CLIENT can tier its own cache — holding identity/stamps for
// an hour while re-fetching availability/state every 30s.
// ─────────────────────────────────────────────────────────────────────────────

/** Static-tier TTL, seconds — identity, stamps, stats, credentials, DNA, journeys. */
export const PASSPORT_STATIC_MAX_AGE = 3600;
/** Dynamic-tier TTL, seconds — availability, state, intent, trust, shared context, capabilities. */
export const PASSPORT_DYNAMIC_MAX_AGE = 30;

/** Which cache tier each §29 aggregate section belongs to (§31). */
const SECTION_TIER: Record<string, number> = {
  // Static
  identity: PASSPORT_STATIC_MAX_AGE,
  stamps: PASSPORT_STATIC_MAX_AGE,
  stats: PASSPORT_STATIC_MAX_AGE,
  credentials: PASSPORT_STATIC_MAX_AGE,
  travelIdentity: PASSPORT_STATIC_MAX_AGE,
  featuredJourney: PASSPORT_STATIC_MAX_AGE,
  memories: PASSPORT_STATIC_MAX_AGE,
  upcomingPlans: PASSPORT_STATIC_MAX_AGE,
  // Dynamic
  travelerState: PASSPORT_DYNAMIC_MAX_AGE,
  availability: PASSPORT_DYNAMIC_MAX_AGE,
  intent: PASSPORT_DYNAMIC_MAX_AGE,
  trust: PASSPORT_DYNAMIC_MAX_AGE,
  sharedContext: PASSPORT_DYNAMIC_MAX_AGE,
  capabilities: PASSPORT_DYNAMIC_MAX_AGE,
};

export interface ProjectionCachePolicy {
  /** Cache-Control max-age for the whole response: the shortest present-section TTL. */
  maxAge: number;
  /** Per-section max-age so the client cache can tier the aggregate (§31). */
  sections: Record<string, number>;
}

/**
 * Derive the §31 cache policy for a built projection. Pure and deterministic:
 * only sections actually PRESENT in the projection contribute, and the overall
 * `maxAge` is the minimum of those — so a public view lacking availability is
 * still bounded by its dynamic traveler-state/trust/capabilities sections, while
 * a restricted card (a relationship state) is treated as fully dynamic.
 */
export function buildProjectionCachePolicy(projection: PassportProjection): ProjectionCachePolicy {
  const sections: Record<string, number> = {};
  for (const [key, ttl] of Object.entries(SECTION_TIER)) {
    if ((projection as any)[key] !== undefined) sections[key] = ttl;
  }
  // A restricted (blocked/unavailable) card carries a relationship-dependent
  // `restricted` marker — never cache it beyond the dynamic horizon.
  if (projection.restricted) sections.restricted = PASSPORT_DYNAMIC_MAX_AGE;
  const ttls = Object.values(sections);
  const maxAge = ttls.length ? Math.min(...ttls) : PASSPORT_DYNAMIC_MAX_AGE;
  return { maxAge, sections };
}
