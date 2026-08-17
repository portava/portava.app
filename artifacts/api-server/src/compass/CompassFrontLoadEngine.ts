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
 *   offline        → max Tier 0 (no data at all beyond safety/auth)
 *   slow / cellular → max Tier 1 (no video previews; slow avoids heavy Tier 2+ loads)
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
import { logger as rootLogger } from "../lib/logger.js";
import type { CompassProfile } from "./types.js";
import { fetchUserTimezone, localHourFor, nowUtcInstant } from "../lib/localTime.js";

const logger = rootLogger.child({ service: "CompassFrontLoadEngine" });
import { buildFeed } from "./CompassFeedBuilder.js";
import { buildCompassContext, defaultSignals } from "./CompassContextEngine.js";
import { hydrateCompassItems } from "./CompassItemHydrator.js";
import { getCachedFeed, setCachedFeed } from "./CompassCacheEngine.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type NetworkHint = 'wifi' | 'cellular' | 'slow' | 'offline';
export type BatteryHint = 'normal' | 'low';
export type FrontLoadTier = 0 | 1 | 2 | 3;

/**
 * A single unit of preloaded data.
 * `type` is a stable string key the client uses to decide where to store it.
 */
export interface FrontLoadItem {
  type:          string;
  data:          unknown;
  tier:          FrontLoadTier;
  cachedAt?:     string;
  /** Computed PreloadScore (0–100). Higher = higher priority for client processing. */
  preloadScore?: number;
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

/**
 * Default tier assignments — mirrors the seed rows in compass_frontload_rules.
 * Used when the DB is unavailable or a rule_name is not present in the live table.
 */
const DEFAULT_TIER_RULES: ReadonlyMap<string, FrontLoadTier> = new Map<string, FrontLoadTier>([
  ['safety_state',         0],
  ['feature_flags',        0],
  ['active_booking',       0],
  ['blocked_users',        0],
  ['privacy_settings',     0],
  ['first_feed_page',      1],
  ['city_pulse_preview',   1],   // matches FrontLoadItem type emitted by loadTier1
  ['notification_preview', 1],   // matches FrontLoadItem type emitted by loadTier1
  ['top_events',           2],
  ['top_buddies',          2],
  ['saved_places',         2],
  ['trip_crew_location',   3],
]);

/**
 * Load tier-assignment rules from the compass_frontload_rules table,
 * falling back to DEFAULT_TIER_RULES for any missing rule.
 * This makes tier assignment operator-configurable without a code deploy.
 */
async function loadTierRules(db: SupabaseClient | null): Promise<Map<string, FrontLoadTier>> {
  const rules = new Map<string, FrontLoadTier>(DEFAULT_TIER_RULES as Map<string, FrontLoadTier>);
  if (!db) return rules;
  try {
    const { data } = await db
      .from('compass_frontload_rules')
      .select('rule_name, tier')
      .eq('enabled', true);
    for (const row of (data as any[]) ?? []) {
      if (typeof row.tier === 'number' && row.tier >= 0 && row.tier <= 3) {
        rules.set(row.rule_name as string, row.tier as FrontLoadTier);
      }
    }
  } catch { /* non-fatal: use defaults */ }
  return rules;
}

/**
 * Per-content-type scoring factors for the PreloadScore formula.
 *
 * Formula: likelihood × safetyPriority × timeSensitivity
 *          − heavyMediaCost − stalenessRisk − privacyRisk
 *
 * Each factor is in [0, 1]:
 *   likelihood      — probability the user needs this content at app open
 *   safetyPriority  — how critical for user safety/auth
 *   timeSensitivity — how quickly the data becomes irrelevant
 *   heavyMediaCost  — bandwidth/CPU cost of loading (0 = lightweight)
 *   stalenessRisk   — how quickly data becomes incorrect (0 = long-lived)
 *   privacyRisk     — data sensitivity (0 = public, 1 = highly private)
 */
export interface PreloadScoreFactors {
  likelihood:      number;
  safetyPriority:  number;
  timeSensitivity: number;
  heavyMediaCost:  number;
  stalenessRisk:   number;
  privacyRisk:     number;
}

/**
 * Baseline scoring factors per content type.
 *
 * Calibrated so formula scores correlate with tier urgency:
 *   Tier 0 (safety/auth/booking):  ~89–100
 *   Tier 1 (feed/notifications):   ~55–78
 *   Tier 2 (events/buddies):       ~11–39
 *   Tier 3 (background/location):  ~8–10
 *
 * `safetyPriority` is the weight given to this content's role in user wellbeing
 * and trust — not just safety-labelled content. Even feed content should be high
 * here because serving wrong/stale feed damages trust.
 *
 * `stalenessRisk` and `heavyMediaCost` are applied as penalties in the formula,
 * reducing the score proportionally. They should stay small (≤0.1) so the
 * positive likelihood × safetyPriority × timeSensitivity product dominates.
 */
export const CONTENT_SCORE_FACTORS: Record<string, PreloadScoreFactors> = {
  //                                  likelihood  safety  time    media   stale   privacy
  safety_state:       { likelihood: 1.0, safetyPriority: 1.0, timeSensitivity: 1.0, heavyMediaCost: 0.00, stalenessRisk: 0.00, privacyRisk: 0.00 },  // → 100
  feature_flags:      { likelihood: 1.0, safetyPriority: 1.0, timeSensitivity: 0.9, heavyMediaCost: 0.00, stalenessRisk: 0.00, privacyRisk: 0.00 },  // →  90
  active_booking:     { likelihood: 0.9, safetyPriority: 1.0, timeSensitivity: 1.0, heavyMediaCost: 0.00, stalenessRisk: 0.00, privacyRisk: 0.05 },  // →  89
  blocked_users:      { likelihood: 1.0, safetyPriority: 1.0, timeSensitivity: 1.0, heavyMediaCost: 0.00, stalenessRisk: 0.00, privacyRisk: 0.10 },  // →  98
  privacy_settings:   { likelihood: 1.0, safetyPriority: 1.0, timeSensitivity: 0.8, heavyMediaCost: 0.00, stalenessRisk: 0.00, privacyRisk: 0.10 },  // →  78
  first_feed_page:    { likelihood: 0.9, safetyPriority: 0.9, timeSensitivity: 0.8, heavyMediaCost: 0.10, stalenessRisk: 0.05, privacyRisk: 0.02 },  // →  58
  notification_preview: { likelihood: 0.9, safetyPriority: 0.9, timeSensitivity: 0.9, heavyMediaCost: 0.00, stalenessRisk: 0.05, privacyRisk: 0.10 },  // →  69
  city_pulse_preview:   { likelihood: 0.7, safetyPriority: 0.8, timeSensitivity: 0.8, heavyMediaCost: 0.05, stalenessRisk: 0.10, privacyRisk: 0.00 },  // →  39
  top_events:         { likelihood: 0.6, safetyPriority: 0.7, timeSensitivity: 0.8, heavyMediaCost: 0.00, stalenessRisk: 0.05, privacyRisk: 0.00 },  // →  32
  top_buddies:        { likelihood: 0.5, safetyPriority: 0.7, timeSensitivity: 0.5, heavyMediaCost: 0.05, stalenessRisk: 0.05, privacyRisk: 0.15 },  // →  11
  saved_places:       { likelihood: 0.5, safetyPriority: 0.6, timeSensitivity: 0.4, heavyMediaCost: 0.05, stalenessRisk: 0.05, privacyRisk: 0.00 },  // →   8
  trip_crew_location: { likelihood: 0.3, safetyPriority: 0.9, timeSensitivity: 0.9, heavyMediaCost: 0.10, stalenessRisk: 0.10, privacyRisk: 0.30 },  // →  10
};

/**
 * Compute a PreloadScore for an item type.
 *
 * Uses the formula:
 *   score = likelihood × safetyPriority × timeSensitivity
 *           − heavyMediaCost × 0.5 − stalenessRisk × 0.3 − privacyRisk × 0.2
 *
 * An optional `navWeight` (0–1) boosts the likelihood component based on how
 * frequently the user navigates to this content type.
 *
 * Falls back to a tier-derived score (100/75/50/25) for unknown types.
 */
export function computePreloadScore(
  type:      string,
  rules:     Map<string, FrontLoadTier>,
  navWeight: number = 0,
): number {
  const f = CONTENT_SCORE_FACTORS[type];
  if (!f) {
    // Unknown type: derive score from operator-configured tier
    const tier = rules.get(type) ?? 3;
    return Math.max(0, 100 - tier * 25);
  }
  const boostedLikelihood = Math.min(1, f.likelihood + navWeight * 0.2);
  const raw = boostedLikelihood * f.safetyPriority * f.timeSensitivity
    - f.heavyMediaCost * 0.5
    - f.stalenessRisk  * 0.3
    - f.privacyRisk    * 0.2;
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Determine the maximum allowed tier given network and battery hints. */
export function resolveMaxTier(
  networkHint: NetworkHint,
  batteryHint: BatteryHint,
): FrontLoadTier {
  if (networkHint === 'offline') return 0;
  // slow and cellular both cap at Tier 1: avoid heavy Tier 2+ DB queries on limited links;
  // slow caps at 1 (not 0) so critical feed data is still preloaded — just no events/buddies.
  if (networkHint === 'slow' || networkHint === 'cellular') return 1;
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
  rules: Map<string, FrontLoadTier> = new Map(DEFAULT_TIER_RULES as Map<string, FrontLoadTier>),
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
  rules: Map<string, FrontLoadTier> = new Map(DEFAULT_TIER_RULES as Map<string, FrontLoadTier>),
  networkHint: NetworkHint = 'wifi',
  localHour?: number,
): Promise<FrontLoadItem[]> {
  const items: FrontLoadItem[] = [];
  const now = new Date().toISOString();
  const isCellular = networkHint === 'cellular';

  // 1. First feed page — built from the full Compass pipeline (cached 5 min)
  let firstFeedPage: unknown = null;
  if (db) {
    try {
      const signals = defaultSignals(profile, localHour);
      const context = buildCompassContext(profile, signals);
      const items_  = await hydrateCompassItems(db, profile);
      let   feed    = await buildFeed(items_, profile, context, db, null);
      // Cellular: strip video items from the first feed page (no video previews on cellular)
      if (isCellular && feed && typeof feed === 'object' && Array.isArray((feed as any).items)) {
        (feed as any).items = (feed as any).items.filter(
          (item: any) => item.post_type !== 'video' && item.type !== 'video',
        );
      }
      firstFeedPage = feed;
    } catch { /* non-fatal — client falls back to direct feed request */ }
  }
  items.push({ type: 'first_feed_page', tier: 1, cachedAt: now, data: firstFeedPage });

  // 2. City pulse preview — last 5 published posts from current city
  //    Per-item authz: exclude posts from blocked users and unverified/delayed posts.
  let pulsePreview: unknown[] = [];
  if (db && profile.currentCity) {
    try {
      const blockedSet = new Set(profile.blockedUserIds ?? []);
      const { data: raw } = await db
        .from("posts")
        .select("id, content, created_at, author_id, post_status, status, visibility, has_video")
        .eq("location_city", profile.currentCity)
        .eq("status", "active")
        // City pulse is a SHARED surface. This query had no visibility
        // predicate at all, and the caller hands it the service-role client
        // (routes/compass.ts), which bypasses RLS — so every private and
        // trip_only post caption in the viewer's city was being returned to any
        // signed-in user who happened to be in that city. The post-filter below
        // checked blocks, delayed-publish and video, but never visibility, and
        // isPermitted() cannot help because for city_pulse_preview `data` is an
        // array, so its per-item checks read undefined and pass unconditionally.
        .eq("visibility", "public")
        .order("created_at", { ascending: false })
        .limit(20);
      pulsePreview = ((raw as any[]) ?? [])
        .filter((p: any) =>
          // Authorization: exclude posts from blocked users
          !blockedSet.has(p.author_id as string) &&
          // Privacy: exclude posts pending delayed-publish
          (!p.post_status || p.post_status === "published") &&
          // Privacy: second gate on visibility, deliberately redundant with the
          // SQL predicate above. Defence in depth against a dropped predicate —
          // and the only half of this fix the test harness can actually observe,
          // because the fake DB in test/compass-cache.test.ts ignores .eq() on
          // its array path and returns every row for the table.
          p.visibility === "public" &&
          // Cellular: no video previews (bandwidth-sensitive)
          !(isCellular && p.has_video === true),
        )
        .slice(0, 5)
        .map(({ post_status: _ps, status: _s, visibility: _v, has_video: _hv, ...rest }: any) => rest);
    } catch { /* non-fatal */ }
  }
  items.push({ type: 'city_pulse_preview', tier: 1, cachedAt: now, data: pulsePreview });

  // 3. Unread notification count
  let notifCount = 0;
  let topNotifs: unknown[] = [];
  if (db) {
    try {
      const { data } = await db
        .from("notifications")
        .select("id, event_type, body, created_at, read_at")
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
  rules: Map<string, FrontLoadTier> = new Map(DEFAULT_TIER_RULES as Map<string, FrontLoadTier>),
): Promise<FrontLoadItem[]> {
  const items: FrontLoadItem[] = [];
  const now = new Date().toISOString();

  // 1. Top upcoming events in current city
  //    Per-item authz: exclude events from blocked users; only published/active events.
  let topEvents: unknown[] = [];
  if (db && profile.currentCity) {
    try {
      const blockedSet = new Set(profile.blockedUserIds ?? []);
      const { data: raw } = await db
        .from("events")
        .select("id, title, description, starts_at, city, created_at, host_id, state")
        .eq("city", profile.currentCity)
        .in("state", ["open", "full", "waitlist"])
        .gt("starts_at", now)
        .order("starts_at", { ascending: true })
        .limit(10);
      topEvents = ((raw as any[]) ?? [])
        .filter((e: any) =>
          !blockedSet.has(e.host_id as string) &&
          ["open", "full", "waitlist"].includes(e.state as string),
        )
        .slice(0, 3)
        .map(({ host_id: _h, state: _st, ...rest }: any) => rest);
    } catch { /* non-fatal */ }
  }
  items.push({ type: 'top_events', tier: 2, cachedAt: now, data: topEvents });

  // 2. Top available buddy profiles
  //    Per-item authz: exclude buddies the user has blocked or who have blocked them.
  let topBuddies: unknown[] = [];
  if (db) {
    try {
      const blockedSet = new Set(profile.blockedUserIds ?? []);
      const { data: raw } = await db
        .from("buddy_profiles")
        .select("user_id, display_name, tagline, city, hourly_rate_usd, average_rating")
        .eq("status", "active")
        .eq("verified", true)
        .order("average_rating", { ascending: false })
        .limit(10);
      topBuddies = ((raw as any[]) ?? [])
        .filter((b: any) => !blockedSet.has(b.user_id as string))
        .slice(0, 3);
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
  _rules: Map<string, FrontLoadTier> = new Map(DEFAULT_TIER_RULES as Map<string, FrontLoadTier>),
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

  // Resolve the traveler's local hour (stored timezone → UTC fallback).
  // Background preload has no client tz offset, so we always use the stored tz.
  const localHour = db
    ? localHourFor(nowUtcInstant(), null, await fetchUserTimezone(db, userId))
    : nowUtcInstant().getUTCHours();

  // Load tier-assignment rules from DB (operator-configurable).
  // Falls back to DEFAULT_TIER_RULES when DB is unavailable.
  const rules = await loadTierRules(db);

  // Tier 0 is always live — safety/auth/booking state never cached
  const tier0 = await loadTier0(db, userId, profile, rules);

  // Tier 1–3: cache-backed assembly.
  // Check the cache first; build live and back-fill the cache on a miss.
  // Cache keys are per-user so they are invalidated atomically when the user's
  // compass cache entry is evicted (e.g. on block, booking change, etc.).
  // Safety/auth items live in Tier 0 and are deliberately excluded from this path.
  //
  // The network hint is included in the cache key to prevent cellular payloads
  // (which strip video) from being served to wifi clients and vice-versa.
  const t1Key = `frontload:tier1:${networkHint}`;
  const t2Key = `frontload:tier2:${networkHint}`;
  const t3Key = `frontload:tier3:${networkHint}`;

  let tier1: FrontLoadItem[] = [];
  if (maxTier >= 1) {
    const cached = await getCachedFeed<FrontLoadItem[]>(db, userId, t1Key, 'frontload');
    if (cached) {
      tier1 = cached;
    } else {
      tier1 = await loadTier1(db, userId, profile, rules, networkHint, localHour);
      // Back-fill asynchronously — caller already has the data it needs
      void setCachedFeed(db, userId, t1Key, 'frontload', tier1);
    }
  }

  let tier2: FrontLoadItem[] = [];
  if (maxTier >= 2) {
    const cached = await getCachedFeed<FrontLoadItem[]>(db, userId, t2Key, 'frontload');
    if (cached) {
      tier2 = cached;
    } else {
      tier2 = await loadTier2(db, userId, profile, rules);
      void setCachedFeed(db, userId, t2Key, 'frontload', tier2);
    }
  }

  let tier3: FrontLoadItem[] = [];
  if (maxTier >= 3) {
    const cached = await getCachedFeed<FrontLoadItem[]>(db, userId, t3Key, 'frontload');
    if (cached) {
      tier3 = cached;
    } else {
      tier3 = await loadTier3(db, userId, profile, rules);
      void setCachedFeed(db, userId, t3Key, 'frontload', tier3);
    }
  }

  // Score-driven scheduling: annotate each item with its PreloadScore and sort
  // within each tier by score descending.  This wires computePreloadScore into the
  // actual data assembly so the highest-value items are first in every tier.
  // Items without a known type fall back to a tier-derived score.
  function applyScores(items: FrontLoadItem[]): FrontLoadItem[] {
    return items
      .map(item => ({ ...item, preloadScore: computePreloadScore(item.type, rules) }))
      .sort((a, b) => (b.preloadScore ?? 0) - (a.preloadScore ?? 0));
  }

  return {
    tier0: applyScores(tier0),
    tier1: applyScores(tier1),
    tier2: applyScores(tier2),
    tier3: applyScores(tier3),
    networkHint,
    batteryHint,
    maxTier,
    builtAt,
  };
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
  // 1. Append raw event (non-fatal)
  const { error: evtError } = await db.from("compass_preload_events").insert({
    user_id:    userId,
    screen_name: screenName,
    occurred_at: occurredAt.toISOString(),
  });
  if (evtError) {
    logger.warn({ err: evtError, userId, screenName }, "compass preload event insert failed (non-fatal)");
  }

  // 2. Update aggregated pattern — read-then-increment because PostgREST
  // does not support `col = col + 1` in upserts. A race between two
  // simultaneous events may lose one count, which is acceptable for ranking.
  const { data: existing, error: readError } = await db
    .from("compass_user_navigation_patterns")
    .select("transition_count")
    .eq("user_id", userId)
    .eq("from_screen", "app")
    .eq("to_screen", screenName)
    .maybeSingle();
  if (readError) {
    logger.warn({ err: readError, userId, screenName }, "navigation pattern read failed (non-fatal)");
    return;
  }

  const newCount = ((existing as any)?.transition_count ?? 0) + 1;

  const { error: upsertError } = await db
    .from("compass_user_navigation_patterns")
    .upsert(
      {
        user_id:          userId,
        from_screen:      "app",
        to_screen:        screenName,
        transition_count: newCount,
        last_seen_at:     occurredAt.toISOString(),
        updated_at:       new Date().toISOString(),
      },
      {
        onConflict:       "user_id,from_screen,to_screen",
        ignoreDuplicates: false,
      },
    );
  if (upsertError) {
    logger.warn({ err: upsertError, userId, screenName }, "navigation pattern upsert failed (non-fatal)");
  }
}
