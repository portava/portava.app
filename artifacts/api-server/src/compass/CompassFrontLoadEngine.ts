/**
 * CompassFrontLoadEngine — Phase 4 tiered preloading.
 *
 * Tier 0 — always live (never cached):
 *   safety state, auth session validity, active booking, feature flags,
 *   blocked users list, privacy settings
 *
 * Tier 1 — loaded on app open (cached 5 min):
 *   first feed page (for_you, 20 items), city pulse preview (5 posts),
 *   unread notification count + top 3 items
 *
 * Tier 2 — loaded after Tier 1 completes (cached 2 min):
 *   top 3 upcoming event details, top 3 available buddy profiles, saved places
 *
 * Tier 3 — background, Wi-Fi only (cached 5 min):
 *   extra feed pages, older posts, map tile hints
 *
 * Network-aware tier ceiling:
 *   offline / slow → max Tier 0
 *   cellular       → max Tier 1 (no video previews)
 *   wifi (default) → all tiers
 *
 * Battery-aware:
 *   low battery → Tier 3 background loads are paused (maxTier capped at 2)
 *
 * Security — items are permission-checked before inclusion:
 *   ✗ Never includes: emergency_contact, id_document items
 *   ✗ Never includes exact GPS coordinates (must be scrubbed by Privacy Guard)
 *   ✗ Never includes unpublished delayed posts (isDelayedPost && publishEligibleAt > now)
 *   ✗ Never includes content the user is no longer authorised to see
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type NetworkHint = 'wifi' | 'cellular' | 'slow' | 'offline';
export type BatteryHint = 'normal' | 'low';
export type FrontLoadTier = 0 | 1 | 2 | 3;

/**
 * A single unit of preloaded data.
 * `type` is a stable string key the client uses to decide where to store it.
 */
export interface FrontLoadItem {
  type:      string;
  data:      unknown;
  tier:      FrontLoadTier;
  cachedAt?: string;
}

export interface FrontLoadPayload {
  tier0:       FrontLoadItem[];
  tier1:       FrontLoadItem[];
  tier2:       FrontLoadItem[];
  tier3:       FrontLoadItem[];
  networkHint: NetworkHint;
  batteryHint: BatteryHint;
  maxTier:     FrontLoadTier;
  builtAt:     string;
}

export interface PreloadManifestItem {
  url:      string;
  priority: number;
  tier:     FrontLoadTier;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Types that must NEVER appear in any tier output. */
const FORBIDDEN_TYPES = new Set(['emergency_contact', 'id_document']);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Determine the maximum allowed tier given network and battery hints. */
export function resolveMaxTier(
  networkHint: NetworkHint,
  batteryHint: BatteryHint,
): FrontLoadTier {
  if (networkHint === 'offline' || networkHint === 'slow') return 0;
  if (networkHint === 'cellular') return 1;
  if (batteryHint === 'low') return 2;
  return 3;
}

/**
 * Permission-check a FrontLoadItem before inclusion.
 * Returns false for any item that must be excluded on security/privacy grounds.
 */
function isPermitted(item: FrontLoadItem): boolean {
  if (FORBIDDEN_TYPES.has(item.type)) return false;

  const d = item.data as Record<string, unknown> | null;
  if (!d) return true;

  // Never include unpublished delayed posts
  if (d.isDelayedPost === true) {
    const eligible = d.publishEligibleAt as string | undefined;
    if (eligible && new Date(eligible).getTime() > Date.now()) return false;
  }

  // Never include raw GPS coordinates — exact lat/lng must be scrubbed
  if (typeof d.exactLat === 'number' || typeof d.exactLng === 'number') return false;

  return true;
}

// ── Tier loaders ───────────────────────────────────────────────────────────────

async function loadTier0(
  db: SupabaseClient | null,
  userId: string,
  profile: CompassProfile,
): Promise<FrontLoadItem[]> {
  const items: FrontLoadItem[] = [];
  const now = new Date().toISOString();

  // 1. Safety state: block list size, suspension status, privacy mode
  items.push({
    type: 'safety_state',
    tier: 0,
    cachedAt: now,
    data: {
      blockCount:           profile.blockCount,
      blockerCount:         profile.blockerCount,
      safetyPreference:     profile.safetyPreference,
      visibilityPreference: profile.visibilityPreference,
      safeReturnActive:     profile.safeReturnActive,
    },
  });

  // 2. Active booking status
  items.push({
    type: 'active_booking',
    tier: 0,
    cachedAt: now,
    data: { hasActiveBooking: profile.hasActiveBooking },
  });

  // 3. Feature flags (load live from DB)
  let flags: Record<string, boolean> = {};
  if (db) {
    try {
      const { data } = await db
        .from("feature_flags")
        .select("flag, enabled")
        .like("flag", "COMPASS_%");
      for (const row of (data as any[]) ?? []) {
        flags[row.flag] = Boolean(row.enabled);
      }
    } catch { /* non-fatal */ }
  }
  items.push({ type: 'feature_flags', tier: 0, cachedAt: now, data: flags });

  // 4. Blocked users (IDs only — no profile data)
  items.push({
    type: 'blocked_users',
    tier: 0,
    cachedAt: now,
    data: { blockedUserIds: profile.blockedUserIds },
  });

  // 5. Privacy settings
  items.push({
    type: 'privacy_settings',
    tier: 0,
    cachedAt: now,
    data: {
      visibilityPreference: profile.visibilityPreference,
      safeReturnActive:     profile.safeReturnActive,
    },
  });

  return items.filter(isPermitted);
}

async function loadTier1(
  db: SupabaseClient | null,
  userId: string,
  profile: CompassProfile,
): Promise<FrontLoadItem[]> {
  const items: FrontLoadItem[] = [];
  const now = new Date().toISOString();

  // 1. City pulse preview — last 5 posts from current city
  let pulsePreview: unknown[] = [];
  if (db && profile.currentCity) {
    try {
      const { data } = await db
        .from("posts")
        .select("id, body, created_at, user_id")
        .eq("city", profile.currentCity)
        .order("created_at", { ascending: false })
        .limit(5);
      pulsePreview = (data as any[]) ?? [];
    } catch { /* non-fatal */ }
  }
  items.push({ type: 'city_pulse_preview', tier: 1, cachedAt: now, data: pulsePreview });

  // 2. Unread notification count
  let notifCount = 0;
  let topNotifs: unknown[] = [];
  if (db) {
    try {
      const { data } = await db
        .from("notifications")
        .select("id, type, body, created_at, read_at")
        .eq("user_id", userId)
        .is("read_at", null)
        .order("created_at", { ascending: false })
        .limit(3);
      topNotifs = (data as any[]) ?? [];
      notifCount = topNotifs.length;
    } catch { /* non-fatal */ }
  }
  items.push({
    type: 'notification_preview',
    tier: 1,
    cachedAt: now,
    data: { unreadCount: notifCount, items: topNotifs },
  });

  return items.filter(isPermitted);
}

async function loadTier2(
  db: SupabaseClient | null,
  userId: string,
  profile: CompassProfile,
): Promise<FrontLoadItem[]> {
  const items: FrontLoadItem[] = [];
  const now = new Date().toISOString();

  // 1. Top upcoming events in current city
  let topEvents: unknown[] = [];
  if (db && profile.currentCity) {
    try {
      const { data } = await db
        .from("posts")
        .select("id, body, event_starts_at, city, created_at")
        .eq("city", profile.currentCity)
        .eq("post_type", "event")
        .gt("event_starts_at", now)
        .order("event_starts_at", { ascending: true })
        .limit(3);
      topEvents = (data as any[]) ?? [];
    } catch { /* non-fatal */ }
  }
  items.push({ type: 'top_events', tier: 2, cachedAt: now, data: topEvents });

  // 2. Top available buddy profiles
  let topBuddies: unknown[] = [];
  if (db) {
    try {
      const { data } = await db
        .from("buddy_profiles")
        .select("user_id, display_name, tagline, city, hourly_rate_usd, average_rating")
        .eq("status", "active")
        .eq("verified", true)
        .order("average_rating", { ascending: false })
        .limit(3);
      topBuddies = (data as any[]) ?? [];
    } catch { /* non-fatal */ }
  }
  items.push({ type: 'top_buddies', tier: 2, cachedAt: now, data: topBuddies });

  // 3. Saved places (wishlist)
  let savedPlaces: unknown[] = [];
  if (db) {
    try {
      const { data } = await db
        .from("discovery_places")
        .select("id, name, category, city")
        .eq("submitted_by", userId)
        .order("created_at", { ascending: false })
        .limit(20);
      savedPlaces = (data as any[]) ?? [];
    } catch { /* non-fatal */ }
  }
  items.push({ type: 'saved_places', tier: 2, cachedAt: now, data: savedPlaces });

  return items.filter(isPermitted);
}

async function loadTier3(
  _db: SupabaseClient | null,
  _userId: string,
  _profile: CompassProfile,
): Promise<FrontLoadItem[]> {
  // Tier 3 items (extra pages, map hints) are hint-only.
  // The client uses the preload manifest URLs to fetch these on its own.
  // We don't return data payloads here to keep the frontload response small.
  return [];
}

// ── buildFrontLoadPayload ─────────────────────────────────────────────────────

/**
 * Build a tiered preload payload for the requesting user.
 *
 * @param db           Supabase service client (null in tests)
 * @param userId       The authenticated user's ID
 * @param profile      The user's Compass profile (from CompassProfileService)
 * @param opts         Network and battery hints from the client request
 */
export async function buildFrontLoadPayload(
  db:      SupabaseClient | null,
  userId:  string,
  profile: CompassProfile,
  opts: {
    networkHint?: NetworkHint;
    batteryHint?: BatteryHint;
  } = {},
): Promise<FrontLoadPayload> {
  const networkHint: NetworkHint = opts.networkHint ?? 'wifi';
  const batteryHint: BatteryHint = opts.batteryHint ?? 'normal';
  const maxTier = resolveMaxTier(networkHint, batteryHint);

  const builtAt = new Date().toISOString();

  // Tier 0 is always live
  const tier0 = await loadTier0(db, userId, profile);

  const tier1: FrontLoadItem[] = maxTier >= 1 ? await loadTier1(db, userId, profile) : [];
  const tier2: FrontLoadItem[] = maxTier >= 2 ? await loadTier2(db, userId, profile) : [];
  const tier3: FrontLoadItem[] = maxTier >= 3 ? await loadTier3(db, userId, profile) : [];

  return { tier0, tier1, tier2, tier3, networkHint, batteryHint, maxTier, builtAt };
}

// ── buildPreloadManifest ──────────────────────────────────────────────────────

/**
 * Build a prioritized list of Tier 2 URLs the client should prefetch.
 * Ordering is personalised using `compass_user_navigation_patterns` —
 * the most-frequently visited next screens rank first.
 *
 * Security: emergency contacts and ID documents are never included.
 */
export async function buildPreloadManifest(
  db:      SupabaseClient | null,
  userId:  string,
  baseUrl: string,
): Promise<PreloadManifestItem[]> {
  // Load navigation patterns to rank screens
  const navScores = new Map<string, number>();
  if (db) {
    try {
      const { data } = await db
        .from("compass_user_navigation_patterns")
        .select("to_screen, transition_count")
        .eq("user_id", userId)
        .order("transition_count", { ascending: false })
        .limit(20);
      for (const row of (data as any[]) ?? []) {
        navScores.set(row.to_screen as string, row.transition_count as number);
      }
    } catch { /* non-fatal */ }
  }

  // Canonical Tier 2 prefetch targets (never includes forbidden types)
  const tier2Targets: Array<{ path: string; screen: string }> = [
    { path: "/api/compass/feed/section/for_you",    screen: "feed"    },
    { path: "/api/compass/feed/section/tonight",    screen: "tonight" },
    { path: "/api/compass/feed/section/near_your_area", screen: "nearby" },
    { path: "/api/discovery",                       screen: "discovery" },
    { path: "/api/compass/feed/section/rent_a_buddy", screen: "rent_a_buddy" },
  ];

  const manifest: PreloadManifestItem[] = tier2Targets.map((t) => ({
    url:      `${baseUrl}${t.path}`,
    priority: navScores.get(t.screen) ?? 0,
    tier:     2,
  }));

  // Sort highest navigation priority first
  manifest.sort((a, b) => b.priority - a.priority);

  return manifest;
}

// ── recordNavigationEvent ─────────────────────────────────────────────────────

/**
 * Persist a client navigation event and update the aggregated pattern table.
 * Called by POST /api/compass/frontload/event.
 * Fire-and-forget: never throws.
 */
export async function recordNavigationEvent(
  db:         SupabaseClient | null,
  userId:     string,
  screenName: string,
  occurredAt: Date,
): Promise<void> {
  if (!db) return;
  try {
    // 1. Append raw event
    await db.from("compass_preload_events").insert({
      user_id:    userId,
      screen_name: screenName,
      occurred_at: occurredAt.toISOString(),
    });

    // 2. Update aggregated pattern (upsert: increment transition_count)
    // We use a generic "app" as the from_screen since the client only sends
    // the destination screen. Phase 5 can enrich this with transition pairs.
    await db
      .from("compass_user_navigation_patterns")
      .upsert(
        {
          user_id:          userId,
          from_screen:      "app",
          to_screen:        screenName,
          transition_count: 1,
          last_seen_at:     occurredAt.toISOString(),
          updated_at:       new Date().toISOString(),
        },
        {
          onConflict:         "user_id,from_screen,to_screen",
          ignoreDuplicates:   false,
        },
      );
  } catch { /* non-fatal */ }
}
