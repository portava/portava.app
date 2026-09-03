/**
 * WallRankingService — For You ordering (spec §14 / TABLE 1 / TABLE 2).
 *
 * OWNS: For You ordering. DOES NOT OWN: visibility authorization (that is
 * WallProjectionService's gate, run upstream) or content truth.
 *
 * This service does NOT implement a ranker. It WRAPS the canonical
 * DiscoveryRankingService.rankItems and maps the spec's ForYouScore terms (§14)
 * onto that ranker's existing signals:
 *
 *   ForYouScore term (§14)   →   rankItems signal
 *   ──────────────────────────────────────────────────────────────────────────
 *   SocialAffinity           →   relationshipRelevance (followedCreatorIds)
 *   ContentQuality           →   contentQuality (+ qualityEngagementScore)
 *   InterestFit              →   viewerRelevance (tags/language vs travelStyles)
 *   DestinationFit           →   contentRelevance (category vs preferredCities)
 *   TripRelevance            →   geographicRelevance / contentRelevance (city)
 *   Freshness                →   freshness (createdAt half-life)
 *   Novelty                  →   explorationBoost (isUnfamiliarCategory / first impression)
 *   NetworkRelevance         →   relationshipRelevance
 *   RealWorldUtility         →   geographicRelevance (distanceKm, place)
 *   DiversityValue           →   surface profile ("explore": exploration heavy)
 *   RepetitionPenalty        →   repetitionPenalty (repeatCount)
 *   StalenessPenalty         →   freshness decay (createdAt)
 *   IntegrityRisk            →   spamPenalty / flagCount
 *   FatiguePenalty           →   fatiguePenalty (per-viewer creator fatigue)
 *
 * The ranking objective is NOT watch time (spec §14) — the "explore" surface
 * profile weights exploration and diversity, and the Wall never feeds watch-time
 * back as a ranking input.
 *
 * CURSOR STABILITY (spec §28). For You cursors carry a rank session + version +
 * a snapshot timestamp. Within one session the full candidate set is ranked with
 * a session-seeded, TOTAL order (finalScore desc, then a deterministic
 * session-seeded tiebreak), then sliced by offset — so page 2 is a continuation
 * of page 1, never a reshuffle. The snapshot timestamp lets the route hold the
 * candidate set steady across pages; a feed refresh starts a NEW session (a new
 * seed), which is the only thing that reshuffles.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";
import {
  rankItems,
  type RankingInput,
  type RankingViewerContext,
} from "../ranking/DiscoveryRankingService.js";
import type { WallProjection, WallRankingMetadata } from "../../lib/wallProjection.js";
import { logger } from "../../lib/logger.js";

/** Ranking algorithm/config version — bump to force new sessions on rollout. */
export const WALL_RANK_VERSION = "wall-foryou-v1";

/** For You is exploratory/diverse — mapped to the ranker's "explore" surface. */
const FOR_YOU_SURFACE = "explore" as const;

/** Signal-rich fields the route may supply per object to feed the ranker. All
 *  optional — absent signals default to neutral so ranking still runs on the
 *  projection alone (freshness + relationship), degrading gracefully (spec §34). */
export interface WallRankSignals {
  tags?: string[];
  category?: string | null;
  languageCode?: string | null;
  city?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  distanceKm?: number | null;
  completeness?: number;
  positiveReviewRate?: number | null;
  flagCount?: number;
  saveCount?: number;
  shareCount?: number;
  commentCount?: number;
  impressionCount?: number;
  uniqueViewerCount?: number;
  accountAgeDays?: number | null;
  isUnfamiliarCategory?: boolean;
  isFirstImpression?: boolean;
  repeatCount?: number | null;
}

export interface WallRankViewer {
  viewerId: string;
  travelStyles?: string[];
  preferredLanguages?: string[];
  preferredCities?: string[];
  currentCity?: string | null;
  currentCountry?: string | null;
  lat?: number | null;
  lng?: number | null;
  viewerAge?: number | null;
  followedCreatorIds?: Set<string>;
  lastActiveAt?: string | null;
}

export interface ForYouCursor {
  session: string;
  version: string;
  offset: number;
  /** ISO — the candidate-set snapshot horizon that keeps pages stable (§28). */
  snapshotAt: string;
}

export interface RankForYouOptions {
  limit: number;
  /** Continuation cursor from a prior page (same session), or null to start. */
  cursor?: ForYouCursor | null;
  /** Per-object ranking signals keyed by canonicalObjectId. */
  signals?: Map<string, WallRankSignals>;
  /** Test seam: inject ranking flag overrides / avoid DB reads. */
  rankOverrides?: Parameters<typeof rankItems>[4];
}

export interface RankForYouResult {
  items: WallProjection[];
  nextCursor: ForYouCursor | null;
  session: string;
  version: string;
  snapshotAt: string;
}

/** Start a fresh rank session (spec §28 — a refresh may start a new session). */
export function newRankSession(nowIso?: string): {
  session: string;
  version: string;
  snapshotAt: string;
} {
  return {
    session: randomUUID(),
    version: WALL_RANK_VERSION,
    snapshotAt: nowIso ?? new Date().toISOString(),
  };
}

// ── Opaque cursor codec ──────────────────────────────────────────────────────

export function encodeForYouCursor(c: ForYouCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeForYouCursor(token: string): ForYouCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof obj.session !== "string" || !UUID_RE.test(obj.session)) return null;
    if (typeof obj.version !== "string" || obj.version.length > 64) return null;
    if (typeof obj.offset !== "number" || !Number.isInteger(obj.offset) || obj.offset < 0) {
      return null;
    }
    if (typeof obj.snapshotAt !== "string" || isNaN(new Date(obj.snapshotAt).getTime())) {
      return null;
    }
    return {
      session: obj.session,
      version: obj.version,
      offset: obj.offset,
      snapshotAt: obj.snapshotAt,
    };
  } catch {
    return null;
  }
}

// ── Signal mapping ───────────────────────────────────────────────────────────

/**
 * Map a gated projection (+ optional signals) into a RankingInput. Because the
 * object already cleared the Wall eligibility/block/visibility gates upstream,
 * every eligibility signal is set to its PASS value here — the ranker's
 * EligibilityChecker becomes a no-op safety net rather than a second, possibly
 * divergent, gate.
 */
function toRankingInput(p: WallProjection, s: WallRankSignals | undefined): RankingInput {
  const sig = s ?? {};
  return {
    itemId: p.canonicalObjectId,
    itemType: p.objectType,
    creatorId: p.actor?.userId ?? null,
    createdAt: p.publishedAt,
    city: sig.city ?? p.place?.city ?? null,
    country: sig.country ?? p.place?.country ?? null,
    tags: sig.tags ?? [],
    category: sig.category ?? null,
    languageCode: sig.languageCode ?? null,
    hasMedia: !!(p.media && p.media.length > 0),
    completeness: sig.completeness ?? (p.text ? 0.6 : 0.4),
    positiveReviewRate: sig.positiveReviewRate ?? null,
    flagCount: sig.flagCount ?? 0,
    saveCount: sig.saveCount ?? 0,
    shareCount: sig.shareCount ?? 0,
    commentCount: sig.commentCount ?? 0,
    impressionCount: sig.impressionCount ?? 0,
    uniqueViewerCount: sig.uniqueViewerCount ?? 0,
    lat: sig.lat ?? p.place?.lat ?? null,
    lng: sig.lng ?? p.place?.lng ?? null,
    distanceKm: sig.distanceKm ?? null,
    // Already gated upstream — pass-through eligibility.
    isDeleted: false,
    isExpired: false,
    isSuspended: false,
    isModerated: false,
    isPrivate: false,
    isAgeRestricted: false,
    minAgeRequired: null,
    isGeoRestricted: false,
    geoRestrictionCountries: null,
    authorIsBlockedByViewer: false,
    authorBlocksViewer: false,
    authorIsMutedByViewer: false,
    viewerHasReportedItem: false,
    viewerHasHiddenItem: false,
    viewerHasHiddenCreator: false,
    repeatCount: sig.repeatCount ?? null,
    expiresAt: null,
    accountAgeDays: sig.accountAgeDays ?? null,
    isUnfamiliarCategory: sig.isUnfamiliarCategory ?? false,
    isFirstImpression: sig.isFirstImpression ?? true,
  };
}

function toViewerContext(v: WallRankViewer, session: string): RankingViewerContext {
  return {
    viewerId: v.viewerId,
    travelStyles: v.travelStyles ?? [],
    preferredLanguages: v.preferredLanguages ?? [],
    preferredCities: v.preferredCities ?? [],
    currentCity: v.currentCity ?? null,
    currentCountry: v.currentCountry ?? null,
    lat: v.lat ?? null,
    lng: v.lng ?? null,
    viewerAge: v.viewerAge ?? null,
    followedCreatorIds: v.followedCreatorIds ?? new Set<string>(),
    mutedCreatorIds: new Set<string>(),
    blockedCreatorIds: new Set<string>(),
    seenItemIds: new Set<string>(),
    sessionId: session,
    lastActiveAt: v.lastActiveAt ?? null,
  };
}

/**
 * Deterministic session-seeded tiebreak. Two objects with equal finalScore keep
 * a STABLE relative order within a session (so paging never reshuffles), but a
 * new session (new seed) can reorder ties — the intended exploratory variety on
 * refresh (spec §28).
 */
function seededKey(session: string, canonicalObjectId: string): string {
  return createHash("sha256").update(`${session}:${canonicalObjectId}`).digest("hex");
}

/**
 * Rank a set of already-gated projections for For You and return one page.
 *
 * The FULL set is ranked to a total order every call; the page is a slice at the
 * cursor offset. Callers MUST pass a candidate set that is stable across the
 * pages of one session (filter by `snapshotAt`) so the sliced prefix does not
 * drift (spec §28). Never throws: if the ranker fails, it falls back to the
 * input order (spec §34 / TABLE 5 — ranking unavailable ⇒ safe recent ordering).
 */
export async function rankForYou(
  sc: SupabaseClient | null,
  projections: WallProjection[],
  viewer: WallRankViewer,
  opts: RankForYouOptions,
): Promise<RankForYouResult> {
  const limit = Math.max(1, Math.min(opts.limit, 50));
  const sess =
    opts.cursor && opts.cursor.version === WALL_RANK_VERSION
      ? { session: opts.cursor.session, version: opts.cursor.version, snapshotAt: opts.cursor.snapshotAt }
      : newRankSession();
  const offset = opts.cursor && opts.cursor.session === sess.session ? opts.cursor.offset : 0;

  // De-duplicate by canonicalObjectId — the same object never appears twice in
  // one feed session (spec §28). First occurrence wins (input order).
  const seen = new Set<string>();
  const deduped: WallProjection[] = [];
  for (const p of projections) {
    if (seen.has(p.canonicalObjectId)) continue;
    seen.add(p.canonicalObjectId);
    deduped.push(p);
  }

  const byId = new Map(deduped.map((p) => [p.canonicalObjectId, p]));

  // Rank the full set. finalScore is populated even in the ranker's shadow mode,
  // so the Wall's For You order is realized from the composite score regardless
  // of the ranker's own experiment flags.
  const scoreOf = new Map<string, number>();
  try {
    const inputs = deduped.map((p) => toRankingInput(p, opts.signals?.get(p.canonicalObjectId)));
    const ranked = await rankItems(
      inputs,
      FOR_YOU_SURFACE,
      toViewerContext(viewer, sess.session),
      sc,
      opts.rankOverrides ?? {},
    );
    for (const r of ranked) {
      if (r.eligibilityPassed) scoreOf.set(r.itemId, r.finalScore);
    }
  } catch (err) {
    // Fallback: unranked, keep input order (safe recent ordering). Every item
    // gets score 0 so the stable tiebreak below preserves input order.
    logger.warn({ err }, "wallRanking: rankItems failed — falling back to input order");
  }

  // Total order: finalScore desc, then session-seeded stable tiebreak. Items the
  // ranker dropped (not in scoreOf) sink to the end but are still served (Wall
  // gate is authoritative; the ranker eligibility net is advisory here).
  const ordered = [...deduped].sort((a, b) => {
    const sa = scoreOf.get(a.canonicalObjectId) ?? -Infinity;
    const sb = scoreOf.get(b.canonicalObjectId) ?? -Infinity;
    if (sb !== sa) return sb - sa;
    const ka = seededKey(sess.session, a.canonicalObjectId);
    const kb = seededKey(sess.session, b.canonicalObjectId);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const page = ordered.slice(offset, offset + limit).map((p, i) => {
    const meta: WallRankingMetadata = {
      session: sess.session,
      version: sess.version,
      rank: offset + i,
    };
    return { ...p, ranking: meta } as WallProjection;
  });

  const nextOffset = offset + page.length;
  const nextCursor: ForYouCursor | null =
    nextOffset < ordered.length
      ? { session: sess.session, version: sess.version, offset: nextOffset, snapshotAt: sess.snapshotAt }
      : null;

  return {
    items: page,
    nextCursor,
    session: sess.session,
    version: sess.version,
    snapshotAt: sess.snapshotAt,
  };
}
