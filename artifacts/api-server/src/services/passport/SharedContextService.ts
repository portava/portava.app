/**
 * SharedContextService — §17 "Shared Context ME ↔ THEM" and §18 "See What You
 * Could Do" (Compass handoff).
 *
 * Shared Context is COMPUTED FOR THE VIEWER RELATIONSHIP each time it is
 * requested — it is never a stored, permanent "match score" (§18, TABLE 18).
 * The output is a set of EXPLAINABLE FACTS (both-in-city, both-free-tonight,
 * mutual follows, shared cities, intent overlap, shared trips, shared moments)
 * plus a qualitative summary label ("Strong travel overlap") derived purely
 * from how many facts hold. There is deliberately no numeric compatibility
 * percentage.
 *
 * The `compassHandoff` block is the §18 bridge: a small, permission-checked
 * candidate SEED (shared city, overlap window, shared intents, trust
 * eligibility) that Compass can consume to propose real experiences. It carries
 * NO exact location and NO private history — only the facts both viewers are
 * already entitled to.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { areSharedMomentsEnabled } from "../../lib/places/sharedMoments.js";

/** One explainable overlap fact. `detail` is safe, coarse, viewer-permitted. */
export interface SharedContextFact {
  key:
    | "both_in_city"
    | "both_free_tonight"
    | "mutual_follows"
    | "shared_cities"
    | "intent_overlap"
    | "shared_trips"
    | "shared_moments"
    | "both_going_to";
  label: string;
  detail: string | null;
  /** A numeric magnitude for the fact where one is meaningful (count), else null. */
  magnitude: number | null;
}

export interface CompassHandoff {
  /** Whether policy/eligibility permits proposing a real-world action. */
  eligible: boolean;
  /** Coarse city both are in (or both heading to), never coordinates. */
  city: string | null;
  /** Explicit availability window both share tonight, when both opted in. */
  overlapWindow: { status: string; expiresAt: string | null } | null;
  /** Intents both expressed (Food, Nightlife, …). */
  sharedIntents: string[];
  /** Why the handoff is / isn't eligible (explainable, non-sensitive). */
  reasons: string[];
}

export interface SharedContextProjection {
  viewerId: string;
  ownerId: string;
  /** Explainable facts — the substance of Shared Context. */
  facts: SharedContextFact[];
  /** Qualitative label derived from fact count; NOT a stored match score. */
  summaryLabel: "No overlap yet" | "Some overlap" | "Good travel overlap" | "Strong travel overlap";
  /** §18 candidate seed for Compass. */
  compassHandoff: CompassHandoff;
}

/** Minimal viewer-permission surface this service needs (subset of interaction perms). */
export interface SharedContextPermissions {
  canSeeAvailability: boolean;
  canSeeMutuals: boolean;
  canSeeTrips: boolean;
  /** Owner is reachable for a real-world action (not blocked / restricted). */
  canMakePlan: boolean;
}

const DEFAULT_PERMS: SharedContextPermissions = {
  canSeeAvailability: true,
  canSeeMutuals: true,
  canSeeTrips: true,
  canMakePlan: true,
};

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

async function loadProfileLite(sc: SupabaseClient, userId: string): Promise<Record<string, any> | null> {
  try {
    const { data } = await sc
      .from("profiles")
      .select("id, current_city, home_city, home_country, interests, availability_tags, open_to_meet")
      .eq("id", userId)
      .maybeSingle();
    return (data as any) ?? null;
  } catch {
    return null;
  }
}

/** Active (non-stale) quick availability status for a user, or null. */
async function loadActiveQuickStatus(
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
    if (row.expires_at && row.expires_at <= new Date().toISOString()) return null; // never render stale
    return { status: row.status, expiresAt: row.expires_at ?? null };
  } catch {
    return null;
  }
}

/** Set of user IDs `userId` follows. */
async function loadFollowingSet(sc: SupabaseClient, userId: string): Promise<Set<string>> {
  try {
    const { data } = await sc.from("user_follows").select("following_id").eq("follower_id", userId);
    return new Set(((data as any[]) ?? []).map((r) => r.following_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Distinct stamp cities for a user (used as "cities visited"). */
async function loadStampCities(sc: SupabaseClient, userId: string): Promise<Set<string>> {
  try {
    const { data } = await sc
      .from("user_stamps")
      .select("city")
      .eq("user_id", userId)
      .eq("is_revoked", false);
    return new Set(((data as any[]) ?? []).map((r) => norm(r.city)).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Accepted trip IDs for a user. */
async function loadTripIds(sc: SupabaseClient, userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const [members, owned] = await Promise.all([
      sc.from("trip_members").select("trip_id").eq("user_id", userId).neq("role", "invited"),
      sc.from("trips").select("id").eq("owner_id", userId),
    ]);
    for (const r of ((members as any).data ?? []) as any[]) if (r.trip_id) ids.add(r.trip_id);
    for (const r of ((owned as any).data ?? []) as any[]) if (r.id) ids.add(r.id);
  } catch {
    /* tolerate */
  }
  return ids;
}

/** Upcoming destination cities for a user (future/active trips). */
async function loadUpcomingCities(sc: SupabaseClient, tripIds: Set<string>): Promise<Set<string>> {
  if (tripIds.size === 0) return new Set();
  try {
    const { data } = await sc
      .from("trips")
      .select("destination_city, status")
      .in("id", Array.from(tripIds))
      .in("status", ["planning", "upcoming", "active"]);
    return new Set(((data as any[]) ?? []).map((r) => norm(r.destination_city)).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Count the active Shared Moments the viewer AND owner are BOTH accepted
 * members of (§15/§17, TABLE 17 — "2 Shared Moments").
 *
 * Authorization is intrinsic and needs no extra per-relationship permission:
 * every moment counted here is one the VIEWER themselves is an accepted member
 * of, so the viewer is already entitled to know it exists (they belong to it).
 * The count therefore reveals nothing the viewer could not already list from
 * their own memberships — it never surfaces a moment the viewer is not in, and
 * carries no title, place, date or coordinate. Archived / removed moments and
 * pending / declined memberships are excluded.
 */
async function loadSharedMomentCount(
  sc: SupabaseClient,
  ownerId: string,
  viewerId: string,
): Promise<number> {
  try {
    const [ownerRows, viewerRows] = await Promise.all([
      sc.from("shared_moment_memberships").select("moment_id").eq("user_id", ownerId).eq("status", "accepted"),
      sc.from("shared_moment_memberships").select("moment_id").eq("user_id", viewerId).eq("status", "accepted"),
    ]);
    const ownerMoments = new Set(
      (((ownerRows as any).data ?? []) as any[]).map((r) => r.moment_id).filter(Boolean),
    );
    const shared: string[] = [];
    for (const r of (((viewerRows as any).data ?? []) as any[])) {
      if (r.moment_id && ownerMoments.has(r.moment_id)) shared.push(r.moment_id);
    }
    if (shared.length === 0) return 0;
    // Only Moments that are still active count (an archived Moment is history
    // that neither party is actively part of any more).
    const { data } = await sc
      .from("shared_moments")
      .select("id")
      .in("id", Array.from(new Set(shared)))
      .eq("status", "active");
    return (((data as any[]) ?? [])).length;
  } catch {
    return 0;
  }
}

function intersect<T>(a: Set<T>, b: Set<T>): T[] {
  const out: T[] = [];
  for (const v of a) if (b.has(v)) out.push(v);
  return out;
}

/** Two quick statuses count as "both free tonight" when both are socially open. */
const OPEN_STATUSES = new Set(["free_now", "free_tonight", "open_to_plans"]);

/**
 * Build the viewer↔owner Shared Context. Returns null-safe empty overlap when
 * viewer === owner (a passport shows no shared context with itself).
 */
export async function buildSharedContext(
  sc: SupabaseClient,
  ownerId: string,
  viewerId: string,
  perms: SharedContextPermissions = DEFAULT_PERMS,
): Promise<SharedContextProjection> {
  const facts: SharedContextFact[] = [];

  const emptyHandoff: CompassHandoff = { eligible: false, city: null, overlapWindow: null, sharedIntents: [], reasons: [] };

  if (!viewerId || viewerId === ownerId) {
    return {
      viewerId,
      ownerId,
      facts,
      summaryLabel: "No overlap yet",
      compassHandoff: { ...emptyHandoff, reasons: ["no_viewer_relationship"] },
    };
  }

  const [ownerP, viewerP, ownerQuick, viewerQuick, ownerFollows, viewerFollows, ownerCities, viewerCities, ownerTrips, viewerTrips] =
    await Promise.all([
      loadProfileLite(sc, ownerId),
      loadProfileLite(sc, viewerId),
      loadActiveQuickStatus(sc, ownerId),
      loadActiveQuickStatus(sc, viewerId),
      perms.canSeeMutuals ? loadFollowingSet(sc, ownerId) : Promise.resolve(new Set<string>()),
      perms.canSeeMutuals ? loadFollowingSet(sc, viewerId) : Promise.resolve(new Set<string>()),
      loadStampCities(sc, ownerId),
      loadStampCities(sc, viewerId),
      perms.canSeeTrips ? loadTripIds(sc, ownerId) : Promise.resolve(new Set<string>()),
      perms.canSeeTrips ? loadTripIds(sc, viewerId) : Promise.resolve(new Set<string>()),
    ]);

  // ── Both in city (coarse city only) ─────────────────────────────────────────
  const ownerCity = norm(ownerP?.current_city) || norm(ownerP?.home_city);
  const viewerCity = norm(viewerP?.current_city) || norm(viewerP?.home_city);
  let bothInCity: string | null = null;
  if (ownerCity && ownerCity === viewerCity) {
    bothInCity = ownerP?.current_city || ownerP?.home_city || null;
    facts.push({ key: "both_in_city", label: "Both in the same city", detail: bothInCity, magnitude: null });
  }

  // ── Both free tonight (explicit availability only, never stale) ──────────────
  let overlapWindow: { status: string; expiresAt: string | null } | null = null;
  if (perms.canSeeAvailability && ownerQuick && viewerQuick && OPEN_STATUSES.has(ownerQuick.status) && OPEN_STATUSES.has(viewerQuick.status)) {
    // The shorter of the two expiries bounds the shared window.
    const exp = [ownerQuick.expiresAt, viewerQuick.expiresAt].filter(Boolean).sort()[0] ?? null;
    overlapWindow = { status: "open", expiresAt: exp };
    facts.push({ key: "both_free_tonight", label: "Both free tonight", detail: null, magnitude: null });
  }

  // ── Mutual follows ──────────────────────────────────────────────────────────
  if (perms.canSeeMutuals) {
    const mutual = intersect(ownerFollows, viewerFollows);
    if (mutual.length > 0) {
      facts.push({
        key: "mutual_follows",
        label: `${mutual.length} mutual follow${mutual.length === 1 ? "" : "s"}`,
        detail: null,
        magnitude: mutual.length,
      });
    }
  }

  // ── Shared cities (places both have been) ───────────────────────────────────
  const sharedCities = intersect(ownerCities, viewerCities);
  if (sharedCities.length > 0) {
    facts.push({
      key: "shared_cities",
      label: `${sharedCities.length} shared cit${sharedCities.length === 1 ? "y" : "ies"}`,
      detail: sharedCities.slice(0, 3).join(", "),
      magnitude: sharedCities.length,
    });
  }

  // ── Intent overlap (interests + explicit intent tags) ───────────────────────
  const ownerIntents = new Set<string>([
    ...((Array.isArray(ownerP?.interests) ? ownerP!.interests : []) as string[]).map(norm),
    ...((Array.isArray(ownerP?.availability_tags) ? ownerP!.availability_tags : []) as string[]).map(norm),
  ]);
  const viewerIntents = new Set<string>([
    ...((Array.isArray(viewerP?.interests) ? viewerP!.interests : []) as string[]).map(norm),
    ...((Array.isArray(viewerP?.availability_tags) ? viewerP!.availability_tags : []) as string[]).map(norm),
  ]);
  ownerIntents.delete("");
  viewerIntents.delete("");
  const sharedIntents = intersect(ownerIntents, viewerIntents);
  if (sharedIntents.length > 0) {
    facts.push({
      key: "intent_overlap",
      label: "Shared interests",
      detail: sharedIntents.slice(0, 4).join(" · "),
      magnitude: sharedIntents.length,
    });
  }

  // ── Shared trips (past/any) ─────────────────────────────────────────────────
  if (perms.canSeeTrips) {
    const sharedTrips = intersect(ownerTrips, viewerTrips);
    if (sharedTrips.length > 0) {
      facts.push({
        key: "shared_trips",
        label: `${sharedTrips.length} trip${sharedTrips.length === 1 ? "" : "s"} together`,
        detail: null,
        magnitude: sharedTrips.length,
      });
    }

    // ── Both going to (future overlap) ────────────────────────────────────────
    const [ownerUpcoming, viewerUpcoming] = await Promise.all([
      loadUpcomingCities(sc, ownerTrips),
      loadUpcomingCities(sc, viewerTrips),
    ]);
    const bothGoing = intersect(ownerUpcoming, viewerUpcoming);
    if (bothGoing.length > 0) {
      facts.push({
        key: "both_going_to",
        label: "Both heading to the same place",
        detail: bothGoing.slice(0, 2).join(", "),
        magnitude: bothGoing.length,
      });
    }
  }

  // ── Shared Moments (§15/§17, TABLE 17) — private, membership-authorized ──────
  // Gated behind the Shared Moments capability chain (fail-closed): when the
  // subsystem is off there is nothing to surface. Membership itself authorizes
  // each counted Moment, so no per-relationship permission flag applies.
  if (await areSharedMomentsEnabled(sc)) {
    const sharedMoments = await loadSharedMomentCount(sc, ownerId, viewerId);
    if (sharedMoments > 0) {
      facts.push({
        key: "shared_moments",
        label: `${sharedMoments} Shared Moment${sharedMoments === 1 ? "" : "s"}`,
        detail: null,
        magnitude: sharedMoments,
      });
    }
  }

  // ── Summary label — qualitative, derived from fact count (NOT a score) ───────
  const n = facts.length;
  const summaryLabel: SharedContextProjection["summaryLabel"] =
    n === 0 ? "No overlap yet" : n <= 1 ? "Some overlap" : n <= 3 ? "Good travel overlap" : "Strong travel overlap";

  // ── Compass handoff (§18) ───────────────────────────────────────────────────
  const handoffReasons: string[] = [];
  if (!perms.canMakePlan) handoffReasons.push("plan_not_permitted");
  const handoffCity = bothInCity ?? null;
  const eligible = perms.canMakePlan && (Boolean(bothInCity) || overlapWindow != null || sharedIntents.length > 0);
  if (eligible) handoffReasons.push("shared_context_present");
  else if (perms.canMakePlan) handoffReasons.push("insufficient_overlap");

  const compassHandoff: CompassHandoff = {
    eligible,
    city: handoffCity,
    overlapWindow,
    sharedIntents: sharedIntents.slice(0, 6),
    reasons: handoffReasons,
  };

  return { viewerId, ownerId, facts, summaryLabel, compassHandoff };
}
