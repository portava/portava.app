/**
 * Telegraph Privacy Resolver
 *
 * Gating layer called before any Telegraph intelligence context assembly.
 * Checks accepted trip membership, availability sharing consent, and
 * location permissions. Returns a verdict object — never throws on 403s.
 *
 * Privacy guarantees enforced here:
 *  - No exact GPS or live location — `locationSharingEnabled` is always false;
 *    exact coordinates must never be assembled from this resolver.
 *  - Availability sharing is opt-in per user — `availabilitySharingEnabled` is
 *    only set when the requesting user's preference profile has explicitly set
 *    `shareAvailability: true`. Members who have not opted in default to false.
 *  - No other user's preference profile is exposed.
 *  - Non-members get access_denied verdict, not a 403 crash.
 *
 * Access level semantics:
 *   full         — accepted trip member (owner or member role)
 *   partial      — authenticated but no trip specified (global commands)
 *   access_denied — pending invite, not a member, or DB error
 *   unauthenticated — (returned by requireUser before resolver is reached)
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type TelegraphAccessLevel =
  | "full"          // accepted trip member
  | "partial"       // authenticated but not a trip member (can still use commands outside a trip)
  | "access_denied" // pending invite or blocked
  | "unauthenticated";

export interface TelegraphPrivacyVerdict {
  userId: string;
  tripId: string | null;
  access: TelegraphAccessLevel;
  isAcceptedMember: boolean;
  isTripOwner: boolean;
  /**
   * True if the requesting user is a member of the trip owner's circle.
   * Only populated for accepted members; false otherwise.
   * Used for circle-scoped recommendation gating.
   */
  isInTripOwnerCircle: boolean;
  /** True only if the requesting user has explicitly opted in to availability sharing. */
  availabilitySharingEnabled: boolean;
  /**
   * Always false — exact GPS coordinates are never assembled by this resolver.
   * Any feature that would expose live location must go through a dedicated
   * location-permission check with explicit user consent, not this resolver.
   */
  locationSharingEnabled: false;
  canReadPlanItems: boolean;
  canReadMeetups: boolean;
  denialReason?: string;
}

/**
 * Look up whether the requesting user has opted in to availability sharing.
 * Conservative default: false if the preference profile is missing or unset.
 * We check this only for accepted members to avoid unnecessary DB calls.
 */
async function resolveAvailabilityConsent(
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const { data } = await client
      .from("user_preference_profiles")
      .select("explicit_preferences_json")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return false;
    const explicit = (() => {
      try { return JSON.parse(data.explicit_preferences_json); } catch { return {}; }
    })();
    // `shareAvailability` is an explicit opt-in field; absence = false.
    return explicit.shareAvailability === true;
  } catch {
    return false; // fail-safe: deny if we cannot read the preference
  }
}

/**
 * Checks whether the requesting user is a member of the trip owner's circle.
 * Fetches the trip owner from trip_members (role='owner') then checks
 * circle_memberships. Returns false on any DB error (fail-safe).
 */
async function resolveCircleMembership(
  client: SupabaseClient,
  userId: string,
  tripId: string,
): Promise<boolean> {
  try {
    // Get the trip owner
    const { data: ownerRow } = await client
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .eq("role", "owner")
      .maybeSingle();
    const ownerId: string | null = (ownerRow as any)?.user_id ?? null;
    if (!ownerId) return false;

    // The trip owner is always in their own circle
    if (ownerId === userId) return true;

    // Check if userId is a member of the owner's circle
    const { data: membership } = await client
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", ownerId)
      .eq("other_id", userId)
      .maybeSingle();

    return membership !== null;
  } catch {
    return false; // fail-safe: deny on unexpected error
  }
}

/**
 * Resolves privacy context for a user + optional trip.
 * Never rejects the promise — returns access_denied verdict on any DB failure.
 */
export async function resolveContext(
  client: SupabaseClient,
  userId: string,
  tripId?: string | null,
): Promise<TelegraphPrivacyVerdict> {
  const base: TelegraphPrivacyVerdict = {
    userId,
    tripId: tripId ?? null,
    access: "partial",
    isAcceptedMember: false,
    isTripOwner: false,
    isInTripOwnerCircle: false,
    availabilitySharingEnabled: false,
    locationSharingEnabled: false,
    canReadPlanItems: false,
    canReadMeetups: false,
  };

  if (!tripId) {
    base.access = "partial";
    return base;
  }

  try {
    const { data: membership, error } = await client
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      return { ...base, access: "access_denied", denialReason: "db_error" };
    }

    const role = (membership as any)?.role ?? null;

    if (!role) {
      return { ...base, access: "access_denied", denialReason: "not_a_member" };
    }

    if (role === "invited") {
      return { ...base, access: "access_denied", denialReason: "pending_invite" };
    }

    const isOwner = role === "owner";
    const isAccepted = role === "owner" || role === "member";

    if (!isAccepted) {
      return { ...base, access: "access_denied", denialReason: "insufficient_role" };
    }

    // Resolve availability consent + circle membership in parallel.
    // Both are conservative-default false.
    const [availabilitySharingEnabled, isInTripOwnerCircle] = await Promise.all([
      resolveAvailabilityConsent(client, userId),
      resolveCircleMembership(client, userId, tripId),
    ]);

    return {
      ...base,
      access: "full",
      isAcceptedMember: true,
      isTripOwner: isOwner,
      isInTripOwnerCircle,
      availabilitySharingEnabled,
      locationSharingEnabled: false,
      canReadPlanItems: true,
      canReadMeetups: true,
    };
  } catch {
    return { ...base, access: "access_denied", denialReason: "unexpected_error" };
  }
}
