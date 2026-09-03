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

export interface AvailabilityProjection {
  openToPlans: boolean;
  socialAvailability: "open" | "maybe" | "crew_only" | "following_only" | "not_open";
  /** Current explicit window, filtered to non-expired (§31 "never render stale"). */
  currentWindow: { status: string; expiresAt: string | null } | null;
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

function buildIdentity(profile: Record<string, any>, permissions: ViewerPermissions): PassportIdentity {
  const isSelf = permissions.relationshipLabel === "self";
  const showAvatar = isSelf || profile.show_profile_picture_publicly !== false;
  // Home country / base are user-controlled (TABLE 24): shown to self and to
  // full-profile viewers; coarse country may show publicly, home base does not.
  const showHomeBase = isSelf || permissions.canViewFullProfile;
  return {
    userId: profile.id,
    name: profile.display_name ?? profile.name ?? null,
    handle: profile.handle ?? profile.username ?? null,
    avatarUrl: showAvatar ? (profile.avatar_url ?? null) : null,
    coverUrl: profile.cover_photo_url ?? null,
    verified: profile.verified === true || Boolean(profile.verified_at),
    verificationLevel: profile.verification_level ?? null,
    homeCountry: profile.home_country ?? null,
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
  permissions: ViewerPermissions,
): TravelerState {
  const isSelf = permissions.relationshipLabel === "self";
  const showCity = isSelf || permissions.canSeeLocationContext;
  const currentCity = norm(profile.current_city);
  const homeCity = norm(profile.home_city);

  let state: TravelerStateKind = "home";
  let city: string | null = null;

  if (quick?.status === "busy") {
    state = "unavailable";
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

  const labels: Record<TravelerStateKind, string> = {
    home: "Home",
    traveling: city ? `Traveling · ${city}` : "Traveling",
    exploring: "Exploring",
    open_to_plans: "Open to Plans",
    at_event: "At Event",
    with_crew: "With Crew",
    unavailable: "Unavailable",
  };

  return {
    state,
    label: labels[state],
    city: showCity ? city : null,
    validFrom: null,
    expiresAt: quick?.expiresAt ?? null,
  };
}

async function buildAvailability(
  sc: SupabaseClient,
  userId: string,
  quick: { status: string; expiresAt: string | null } | null,
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
  const openToPlans = openToMeet || (quick != null && quick.status !== "busy");
  const social: AvailabilityProjection["socialAvailability"] = openToPlans ? "open" : "not_open";
  return {
    openToPlans,
    socialAvailability: social,
    currentWindow: quick,
    weekly,
    expiresAt: quick?.expiresAt ?? null,
  };
}

function buildIntent(profile: Record<string, any>, quick: { status: string; expiresAt: string | null } | null): IntentProjection | undefined {
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

  // 2. Viewer context + permissions (server-side authority).
  const resolver = opts.resolveViewerContext ?? resolvePassportViewerContext;
  const resolution = await resolver(sc, userId, viewerId);
  const { context, permissions } = resolution;
  const isSelf = context === "self";
  const callerCtx = toCallerContext(context, permissions);

  const identity = buildIdentity(profile, permissions);

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
  const [statsRaw, tripCount, unified, quick, prefs] = await Promise.all([
    buildStats(sc, userId).catch(() => ({ countries: 0, cities: 0, hiddenGemStamps: 0, totalStamps: 0 } as any)),
    countUserTrips(sc, userId).catch(() => ({ count: 0 })),
    buildUnifiedStamps(sc, userId).catch(() => ({ stamps: [] as UnifiedStamp[], count: 0 } as any)),
    loadQuickStatus(sc, userId),
    loadVisibilityPrefs(sc, userId),
  ]);

  const stats: TravelStats = {
    countries: statsRaw.countries ?? 0,
    cities: statsRaw.cities ?? 0,
    stamps: unified.count ?? 0,
    trips: tripCount.count ?? 0,
  };

  // 5. Traveler state + availability + intent (availability/intent gated).
  const activeTripCity = await loadActiveTripCity(sc, userId);
  const travelerState = buildTravelerState(profile, quick, activeTripCity, permissions);

  let availability: AvailabilityProjection | undefined;
  let intent: IntentProjection | undefined;
  if (isSelf || permissions.canSeeAvailability) {
    availability = await buildAvailability(sc, userId, quick);
    intent = buildIntent(profile, quick);
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
    // Restrictions are already reflected in the safe summary; we conservatively
    // treat "no exposed restriction" as unrestricted for capability display.
    restrictions: { hosting: false, privatePlan: false, messaging: false, locationPlan: false },
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
