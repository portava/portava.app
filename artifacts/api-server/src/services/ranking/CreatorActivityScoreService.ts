/**
 * CreatorActivityScoreService
 *
 * Calculates a bounded (0–100) CreatorActivityScore for a given user using
 * multi-window signals with exponential time decay and diminishing-returns
 * transforms. Designed to be called by the background recalculation job; it
 * must never be called on the hot path of a live feed request.
 *
 * Data sources used:
 *   activity_events  — primary signal store: actor_id, user_id, event_type,
 *                      category, created_at, metadata
 *   posts            — contribution count (author_id, status, post_status,
 *                      created_at)
 *   events           — contribution count (host_id, created_at)
 *   trips            — contribution count (owner_id, created_at)
 *   reviews          — contribution count (reviewer_id, created_at)
 *   discovery_places — contribution count (submitted_by, created_at)
 *   blocks           — blocked-account exclusion (blocker_id, blocked_id)
 *   trust_profiles   — safety multiplier (overall_score, public_level)
 *
 * Sub-components (each normalised to 0–100 before weighting):
 *   recent_contribution_score  — original content published in each window
 *   consistency_score          — regularity of meaningful actions over 90 days
 *   community_participation_score — comments/attendance/responses to others
 *   positive_response_score    — saves/shares/comments/follows received,
 *                                 normalised by received-events volume
 *   maintenance_score          — updating stale content / correcting places
 *
 * Penalties:
 *   spam_penalty       — burst posting, duplicates, follow-cycling (max −25)
 *   repetition_penalty — same type rapidly posted/deleted (max −15)
 *
 * Safety:
 *   safety_multiplier — 0.0–1.0 from trust_profiles; collapses score to 0
 *                       on verified severe restriction
 *
 * Anti-gaming filters applied at the query layer:
 *   - Self-actions (actor_id = userId) excluded from received-signal queries
 *   - Actions from accounts the creator has blocked/been blocked by are
 *     excluded from participation and positive-response signals
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "CreatorActivityScoreService" });

// ─── Version ──────────────────────────────────────────────────────────────────

/** Bump this string to force a full recalculation of all stored scores. */
export const ACTIVITY_SCORE_VERSION = "1.0";

// ─── Default weights & parameters ────────────────────────────────────────────

/**
 * Weights applied to each sub-component when computing the weighted sum.
 * Must sum to 1.0.
 */
const COMPONENT_WEIGHTS = {
  recentContribution:     0.30,
  consistency:            0.20,
  communityParticipation: 0.20,
  positiveResponse:       0.20,
  maintenance:            0.10,
} as const;

/** Soft-cap for the saturating transform. */
const SOFT_CAP_CONTRIBUTION      = 20;
const SOFT_CAP_CONSISTENCY_DAYS  = 30;
const SOFT_CAP_PARTICIPATION     = 15;
const SOFT_CAP_RESPONSES         = 50;
const SOFT_CAP_MAINTENANCE       = 10;

/** Default exponential decay half-life in days (overridable via ranking_config). */
const DEFAULT_HALF_LIFE_DAYS = 14;

/** Maximum clamped penalties. */
const MAX_SPAM_PENALTY       = 25;
const MAX_REPETITION_PENALTY = 15;

/**
 * Minimum base score for a new user with zero history — prevents cold-start
 * users from appearing completely inactive relative to established creators.
 */
const NEW_USER_BASE_SCORE = 10;

// ─── Signals returned by the aggregator ──────────────────────────────────────

export interface CreatorSignals {
  /** Original content published per window (after anti-gaming filters). */
  contributions24h:  number;
  contributions7d:   number;
  contributions30d:  number;
  contributions90d:  number;

  /** Number of calendar-day buckets (0–90) with at least one meaningful action. */
  activeDays90:      number;

  /** Distinct-other-user interactions (comments, attendance, helpful replies). */
  participationEvents: number;
  participationDistinctUsers: number;

  /** Received saves + shares + genuine comments + follows. */
  receivedPositiveActions: number;
  /** Total received interaction events used as normalisation denominator. */
  receivedInteractionVolume: number;

  /** Updates to stale/inaccurate content or place data. */
  maintenanceActions: number;

  /** Number of burst-posting episodes detected. */
  burstEpisodes: number;
  /** Near-duplicate content detected (flagged in metadata). */
  duplicateContentCount: number;
  /** Follow-unfollow cycling events approximation. */
  followUnfollowCycles: number;

  /** Same content type posted rapidly (repetition signals). */
  rapidSameTypeCount: number;
  /** Same event created/deleted repeatedly. */
  eventCreateDeleteCycles: number;

  /** 0.0–1.0 from trust_profiles; undefined = no profile (treat as 1.0). */
  safetyMultiplier: number;
}

// ─── Score result ─────────────────────────────────────────────────────────────

export interface CreatorActivityScoreResult {
  userId:                       string;
  score:                        number;
  recentContributionScore:      number;
  consistencyScore:             number;
  communityParticipationScore:  number;
  positiveResponseScore:        number;
  maintenanceScore:             number;
  spamPenalty:                  number;
  repetitionPenalty:            number;
  safetyMultiplier:             number;
  calculationVersion:           string;
}

// ─── Saturating transform ─────────────────────────────────────────────────────

/**
 * Saturating (diminishing-returns) transform.
 *   result = maxPoints × (1 − e^(−rawCount / softCap))
 *
 * At rawCount = softCap  → ~63% of maxPoints.
 * At rawCount = 3×softCap → ~95% of maxPoints.
 * 100 events can never equal 100× one event.
 */
export function saturate(rawCount: number, softCap: number, maxPoints: number): number {
  if (rawCount <= 0 || softCap <= 0) return 0;
  return maxPoints * (1 - Math.exp(-rawCount / softCap));
}

// ─── Exponential decay weight ─────────────────────────────────────────────────

/**
 * Decay multiplier for an event based on its age.
 * w = 2^(−ageDays / halfLifeDays)
 */
export function decayWeight(ageDays: number, halfLifeDays: number): number {
  return Math.pow(2, -ageDays / halfLifeDays);
}

// ─── Weighted contribution score using multi-window counts ────────────────────

function weightedContributionScore(
  c24h: number,
  c7d:  number,
  c30d: number,
  c90d: number,
  halfLifeDays: number,
): number {
  // Marginal counts per window (windows are cumulative — subtract inner ones)
  const marginal7d  = Math.max(0, c7d  - c24h);
  const marginal30d = Math.max(0, c30d - c7d);
  const marginal90d = Math.max(0, c90d - c30d);

  // Decay weight at the midpoint of each window
  const w24h  = decayWeight(0.5,  halfLifeDays);
  const w7d   = decayWeight(3.5,  halfLifeDays);
  const w30d  = decayWeight(18.5, halfLifeDays);
  const w90d  = decayWeight(60,   halfLifeDays);

  const raw =
    saturate(c24h,       SOFT_CAP_CONTRIBUTION, 100) * w24h +
    saturate(marginal7d, SOFT_CAP_CONTRIBUTION, 100) * w7d +
    saturate(marginal30d, SOFT_CAP_CONTRIBUTION, 100) * w30d +
    saturate(marginal90d, SOFT_CAP_CONTRIBUTION, 100) * w90d;

  const maxRaw = 100 * (w24h + w7d + w30d + w90d);
  return maxRaw > 0 ? Math.min(100, (raw / maxRaw) * 100) : 0;
}

// ─── Sub-component calculations ───────────────────────────────────────────────

function calcRecentContributionScore(signals: CreatorSignals, halfLifeDays: number): number {
  return weightedContributionScore(
    signals.contributions24h,
    signals.contributions7d,
    signals.contributions30d,
    signals.contributions90d,
    halfLifeDays,
  );
}

function calcConsistencyScore(signals: CreatorSignals): number {
  return saturate(signals.activeDays90, SOFT_CAP_CONSISTENCY_DAYS, 100);
}

function calcCommunityParticipationScore(signals: CreatorSignals): number {
  const distinctUserBonus = saturate(signals.participationDistinctUsers, SOFT_CAP_PARTICIPATION, 70);
  const totalBonus        = saturate(signals.participationEvents, SOFT_CAP_PARTICIPATION * 2, 30);
  return Math.min(100, distinctUserBonus + totalBonus);
}

function calcPositiveResponseScore(signals: CreatorSignals): number {
  const { receivedPositiveActions, receivedInteractionVolume } = signals;
  if (receivedPositiveActions <= 0) return 0;
  // Normalise by total received interactions to prevent large-account bias.
  const denominator = Math.max(1, receivedInteractionVolume);
  const rate = receivedPositiveActions / denominator;
  // rate of 0.05 (5%) → saturate at softCap 5 = ~63% of 100
  return saturate(rate * 100, 5, 100);
}

function calcMaintenanceScore(signals: CreatorSignals): number {
  return saturate(signals.maintenanceActions, SOFT_CAP_MAINTENANCE, 100);
}

function calcSpamPenalty(signals: CreatorSignals): number {
  const burst     = signals.burstEpisodes        * 5;
  const duplicate = signals.duplicateContentCount * 3;
  const cycling   = signals.followUnfollowCycles  * 4;
  return Math.min(MAX_SPAM_PENALTY, burst + duplicate + cycling);
}

function calcRepetitionPenalty(signals: CreatorSignals): number {
  const rapid  = signals.rapidSameTypeCount      * 2;
  const cycles = signals.eventCreateDeleteCycles * 3;
  return Math.min(MAX_REPETITION_PENALTY, rapid + cycles);
}

// ─── Main scoring formula ─────────────────────────────────────────────────────

/**
 * Compute the CreatorActivityScore from pre-aggregated signals.
 * All DB I/O has already happened; this function is pure and testable.
 *
 * @param userId       Creator user ID
 * @param signals      Aggregated signals from CreatorSignalAggregator
 * @param halfLifeDays Decay half-life in days (from ranking_config or default)
 */
export function computeActivityScore(
  userId:       string,
  signals:      CreatorSignals,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): CreatorActivityScoreResult {
  const recentContributionScore     = calcRecentContributionScore(signals, halfLifeDays);
  const consistencyScore            = calcConsistencyScore(signals);
  const communityParticipationScore = calcCommunityParticipationScore(signals);
  const positiveResponseScore       = calcPositiveResponseScore(signals);
  const maintenanceScore            = calcMaintenanceScore(signals);

  const spamPenalty       = calcSpamPenalty(signals);
  const repetitionPenalty = calcRepetitionPenalty(signals);

  const { recentContribution, consistency, communityParticipation, positiveResponse, maintenance } =
    COMPONENT_WEIGHTS;

  const weightedSum =
    recentContributionScore     * recentContribution +
    consistencyScore            * consistency +
    communityParticipationScore * communityParticipation +
    positiveResponseScore       * positiveResponse +
    maintenanceScore            * maintenance;

  // Apply penalties
  const afterPenalties = weightedSum - spamPenalty - repetitionPenalty;

  // Apply safety multiplier (0.0 collapses the score entirely)
  const safetyMultiplier = signals.safetyMultiplier;
  const afterSafety = afterPenalties * safetyMultiplier;

  // Enforce new-user floor (only when safety multiplier is non-zero and no history)
  const isNewUserWithNoHistory =
    signals.contributions90d  === 0 &&
    signals.activeDays90      === 0 &&
    signals.participationEvents === 0 &&
    signals.receivedPositiveActions === 0;

  const floor = isNewUserWithNoHistory && safetyMultiplier > 0 ? NEW_USER_BASE_SCORE : 0;

  // Clamp to [floor, 100]
  const score = Math.min(100, Math.max(floor, afterSafety));

  return {
    userId,
    score:                        Math.round(score * 100) / 100,
    recentContributionScore:      Math.round(recentContributionScore * 100) / 100,
    consistencyScore:             Math.round(consistencyScore * 100) / 100,
    communityParticipationScore:  Math.round(communityParticipationScore * 100) / 100,
    positiveResponseScore:        Math.round(positiveResponseScore * 100) / 100,
    maintenanceScore:             Math.round(maintenanceScore * 100) / 100,
    spamPenalty:                  Math.round(spamPenalty * 100) / 100,
    repetitionPenalty:            Math.round(repetitionPenalty * 100) / 100,
    safetyMultiplier:             safetyMultiplier,
    calculationVersion:           ACTIVITY_SCORE_VERSION,
  };
}

// ─── Signal aggregator (DB layer) ─────────────────────────────────────────────

/**
 * CreatorSignalAggregator — pulls windowed counts from the DB for one creator.
 *
 * Tables used (with exact live columns accessed):
 *   activity_events  — actor_id, user_id, event_type, created_at, metadata
 *   posts            — author_id, status, created_at
 *   events           — host_id, created_at
 *   trips            — owner_id, created_at
 *   reviews          — reviewer_id, state, created_at
 *   discovery_places — submitted_by, created_at
 *   blocks           — blocker_id, blocked_id
 *   trust_profiles   — user_id, overall_score, public_level
 *
 * Anti-gaming filters:
 *   - Self-actions excluded: actor_id != userId on received-signal queries
 *   - Blocked-account exclusion: build a block-set from `blocks` table and
 *     filter out those actor_ids from participation/response signals
 *   - Burst detection: >10 identical event_type rows within 60 seconds
 */
export class CreatorSignalAggregator {
  constructor(private readonly db: SupabaseClient) {}

  async aggregate(userId: string): Promise<CreatorSignals> {
    const now    = Date.now();
    const ago24h = new Date(now - 1  * 24 * 60 * 60 * 1_000).toISOString();
    const ago7d  = new Date(now - 7  * 24 * 60 * 60 * 1_000).toISOString();
    const ago30d = new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const ago90d = new Date(now - 90 * 24 * 60 * 60 * 1_000).toISOString();

    // Fetch blocked IDs first — required to filter participation and response
    // signals before counting. Block lists are typically small so one serial
    // round-trip is acceptable; everything else runs in parallel after.
    const blockedIds = await this._fetchBlockedIds(userId);

    const [
      contributions,
      activeDays,
      participation,
      positiveResponses,
      maintenance,
      spamSignals,
      safetyMultiplier,
    ] = await Promise.all([
      this._fetchContributions(userId, ago24h, ago7d, ago30d, ago90d),
      this._fetchActiveDays(userId, ago90d),
      this._fetchParticipation(userId, ago90d, blockedIds),
      this._fetchPositiveResponses(userId, ago90d, blockedIds),
      this._fetchMaintenance(userId, ago90d),
      this._fetchSpamSignals(userId, ago90d),
      this._fetchSafetyMultiplier(userId),
    ]);

    return {
      ...contributions,
      activeDays90: activeDays,
      ...participation,
      ...positiveResponses,
      maintenanceActions: maintenance,
      ...spamSignals,
      safetyMultiplier,
    };
  }

  // ── Blocked account IDs ───────────────────────────────────────────────────

  /** Build the set of user IDs the creator has blocked or been blocked by. */
  private async _fetchBlockedIds(userId: string): Promise<Set<string>> {
    try {
      // blocks table: blocker_id, blocked_id
      const { data } = await (this.db as any)
        .from("blocks")
        .select("blocker_id, blocked_id")
        .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);

      const ids = new Set<string>();
      for (const r of (data as any[]) ?? []) {
        if (r.blocker_id !== userId) ids.add(String(r.blocker_id));
        if (r.blocked_id !== userId) ids.add(String(r.blocked_id));
      }
      return ids;
    } catch {
      return new Set();
    }
  }

  // ── Contribution counts ───────────────────────────────────────────────────

  /**
   * Count original content created by the user across tables.
   * Uses direct table queries for accuracy.
   */
  private async _fetchContributions(
    userId: string,
    ago24h: string, ago7d: string, ago30d: string, ago90d: string,
  ): Promise<Pick<CreatorSignals, "contributions24h"|"contributions7d"|"contributions30d"|"contributions90d">> {
    try {
      // Fetch content timestamps from all contribution tables in parallel.
      const [postsData, eventsData, tripsData, reviewsData, placesData] = await Promise.all([
        // posts: author_id, status, post_status, created_at
        //
        // TWO columns, TWO similarly-named enums — do not conflate them:
        //   posts.status      public.post_status
        //                     ('active','hidden','reported','deleted')
        //   posts.post_status public.delayed_post_status
        //                     ('draft','private','pending_location_exit',
        //                      'pending_delay','pending_safety_review',
        //                      'published','canceled','expired')
        // This lane previously sent .eq("status","published") — 'published' is
        // NOT a post_status label, so PostgREST rejected it with 22P02 and the
        // surrounding catch swallowed it: the posts contribution count was
        // permanently zero for every creator.
        //
        // The canonical "live post" predicate used by the Wall, Pulse, the
        // global/Following feeds and profile tabs is status='active' AND
        // post_status='published'; a contribution score must use the same one.
        // Deliberately excluded: hidden/reported/deleted (not visible to the
        // community, and counting `reported` would reward flagged content) and
        // draft/private/pending_*/canceled/expired (never published).
        (this.db as any)
          .from("posts")
          .select("created_at")
          .eq("author_id", userId)
          .eq("status", "active")
          .eq("post_status", "published")
          .gte("created_at", ago90d),

        // events: host_id, created_at
        (this.db as any)
          .from("events")
          .select("created_at")
          .eq("host_id", userId)
          .gte("created_at", ago90d),

        // trips: owner_id, created_at
        (this.db as any)
          .from("trips")
          .select("created_at")
          .eq("owner_id", userId)
          .gte("created_at", ago90d),

        // reviews: reviewer_id, state, created_at
        (this.db as any)
          .from("reviews")
          .select("created_at")
          .eq("reviewer_id", userId)
          .eq("state", "published")
          .gte("created_at", ago90d),

        // discovery_places: submitted_by, created_at
        (this.db as any)
          .from("discovery_places")
          .select("created_at")
          .eq("submitted_by", userId)
          .gte("created_at", ago90d),
      ]);

      // Merge all timestamps into one flat array
      const timestamps: string[] = [
        ...((postsData.data  as any[]) ?? []).map((r: any) => r.created_at),
        ...((eventsData.data as any[]) ?? []).map((r: any) => r.created_at),
        ...((tripsData.data  as any[]) ?? []).map((r: any) => r.created_at),
        ...((reviewsData.data as any[]) ?? []).map((r: any) => r.created_at),
        ...((placesData.data  as any[]) ?? []).map((r: any) => r.created_at),
      ].filter(Boolean);

      return {
        contributions24h: timestamps.filter((t) => t >= ago24h).length,
        contributions7d:  timestamps.filter((t) => t >= ago7d).length,
        contributions30d: timestamps.filter((t) => t >= ago30d).length,
        contributions90d: timestamps.length,
      };
    } catch {
      return { contributions24h: 0, contributions7d: 0, contributions30d: 0, contributions90d: 0 };
    }
  }

  // ── Active days ───────────────────────────────────────────────────────────

  /** Count distinct calendar days with at least one activity in the last 90 days. */
  private async _fetchActiveDays(userId: string, ago90d: string): Promise<number> {
    try {
      // Use activity_events where actor_id = userId (actions performed by creator)
      const { data } = await (this.db as any)
        .from("activity_events")
        .select("created_at")
        .eq("actor_id", userId)
        .gte("created_at", ago90d);

      const rows: any[] = (data as any[]) ?? [];
      const days = new Set(
        rows.map((r) => String(r.created_at ?? "").slice(0, 10)).filter((d) => d.length === 10),
      );
      return days.size;
    } catch {
      return 0;
    }
  }

  // ── Community participation ───────────────────────────────────────────────

  /**
   * Count participation events where this user acted on OTHERS' content.
   * activity_events: actor_id (who did it), user_id (whose content it's about).
   *
   * Blocked-account exclusion: rows where user_id (the content owner) is in
   * blockedIds are excluded so interactions with blocked/blocking users do
   * not inflate the participation score.
   */
  private async _fetchParticipation(
    userId: string, ago90d: string, blockedIds: Set<string>,
  ): Promise<Pick<CreatorSignals, "participationEvents"|"participationDistinctUsers">> {
    try {
      const PARTICIPATION_TYPES = [
        "comment_posted",
        "event_attended",
        "helpful_response",
        "event_rsvp",
      ];

      // actor_id = userId (this user acted), user_id != userId (on someone else's content)
      const { data } = await (this.db as any)
        .from("activity_events")
        .select("user_id")
        .eq("actor_id", userId)
        .neq("user_id", userId)
        .in("event_type", PARTICIPATION_TYPES)
        .gte("created_at", ago90d);

      // Filter out blocked accounts (content owners this user has blocked or
      // been blocked by).
      const rows: any[] = ((data as any[]) ?? []).filter(
        (r: any) => !blockedIds.has(String(r.user_id)),
      );
      const distinctCreators = new Set(rows.map((r: any) => r.user_id).filter(Boolean));

      return {
        participationEvents:        rows.length,
        participationDistinctUsers: distinctCreators.size,
      };
    } catch {
      return { participationEvents: 0, participationDistinctUsers: 0 };
    }
  }

  // ── Positive responses received ───────────────────────────────────────────

  /**
   * Count positive interactions received by this user from others.
   * actor_id != userId ensures self-engagement is excluded.
   *
   * Blocked-account exclusion: rows where actor_id is in blockedIds are
   * excluded so likes/saves/follows from blocked/blocking accounts do not
   * inflate the positive-response score.
   */
  private async _fetchPositiveResponses(
    userId: string, ago90d: string, blockedIds: Set<string>,
  ): Promise<Pick<CreatorSignals, "receivedPositiveActions"|"receivedInteractionVolume">> {
    try {
      const POSITIVE_TYPES = [
        "content_saved",
        "content_shared",
        "comment_received",
        "follow_received",
      ];

      // All interaction types received by this creator (used as normalisation
      // denominator so the rate stays meaningful even with blocked filtering).
      const ALL_INTERACTION_TYPES = [
        ...POSITIVE_TYPES,
        "content_impression",
        "profile_visited",
      ];

      // Fetch both in parallel — they share the same base filter.
      const [{ data: positiveData }, { data: allData }] = await Promise.all([
        // Positive actions: user_id = userId (this user's content/profile),
        //                   actor_id != userId (not self)
        (this.db as any)
          .from("activity_events")
          .select("actor_id")
          .eq("user_id", userId)
          .neq("actor_id", userId)
          .in("event_type", POSITIVE_TYPES)
          .gte("created_at", ago90d),

        // All interactions (wider set) for the normalisation denominator.
        (this.db as any)
          .from("activity_events")
          .select("actor_id")
          .eq("user_id", userId)
          .neq("actor_id", userId)
          .in("event_type", ALL_INTERACTION_TYPES)
          .gte("created_at", ago90d),
      ]);

      // Apply blocked-account exclusion: discard rows from blocked/blocking
      // actors so engagement-baiting with block-toggling cannot inflate scores.
      const isAllowed = (r: any) => !blockedIds.has(String(r.actor_id));
      const positiveRows: any[] = ((positiveData as any[]) ?? []).filter(isAllowed);
      const allRows: any[]      = ((allData as any[]) ?? []).filter(isAllowed);

      return {
        receivedPositiveActions:  positiveRows.length,
        receivedInteractionVolume: allRows.length,
      };
    } catch {
      return { receivedPositiveActions: 0, receivedInteractionVolume: 0 };
    }
  }

  // ── Maintenance actions ───────────────────────────────────────────────────

  private async _fetchMaintenance(userId: string, ago90d: string): Promise<number> {
    try {
      const MAINTENANCE_TYPES = [
        "content_updated",
        "place_corrected",
        "event_details_completed",
        "trip_details_completed",
        "review_updated",
      ];

      const { data } = await (this.db as any)
        .from("activity_events")
        .select("id")
        .eq("actor_id", userId)
        .in("event_type", MAINTENANCE_TYPES)
        .gte("created_at", ago90d);

      return ((data as any[]) ?? []).length;
    } catch {
      return 0;
    }
  }

  // ── Spam / anti-gaming signals ────────────────────────────────────────────

  private async _fetchSpamSignals(
    userId: string, ago90d: string,
  ): Promise<Pick<CreatorSignals, "burstEpisodes"|"duplicateContentCount"|"followUnfollowCycles"|"rapidSameTypeCount"|"eventCreateDeleteCycles">> {
    try {
      // Fetch all activity events for this user (as actor) in 90-day window
      const { data } = await (this.db as any)
        .from("activity_events")
        .select("event_type, created_at, metadata")
        .eq("actor_id", userId)
        .gte("created_at", ago90d)
        .order("created_at", { ascending: true });

      const rows: any[] = (data as any[]) ?? [];

      // Detect burst episodes: >10 identical event_type rows within 60 seconds
      let burstEpisodes = 0;
      {
        const byType = new Map<string, number[]>();
        for (const r of rows) {
          const t = new Date(r.created_at).getTime();
          if (!byType.has(r.event_type)) byType.set(r.event_type, []);
          byType.get(r.event_type)!.push(t);
        }
        for (const times of byType.values()) {
          for (let i = 0; i < times.length; i++) {
            let count = 1;
            for (let j = i + 1; j < times.length && times[j]! - times[i]! <= 60_000; j++) {
              count++;
            }
            if (count > 10) {
              burstEpisodes++;
              break; // one episode per type per scan
            }
          }
        }
      }

      // Follow-unfollow cycling: approximate from event pairs
      const followRows   = rows.filter((r) => r.event_type === "follow_action");
      const unfollowRows = rows.filter((r) => r.event_type === "unfollow_action");
      const followUnfollowCycles = Math.floor(
        Math.min(followRows.length, unfollowRows.length) / 3,
      );

      // Rapid same-type posting: same content event_type within 5 minutes
      const CONTENT_TYPES = [
        "post_published", "story_published", "event_created", "trip_created",
      ];
      const contentRows = rows.filter((r) => CONTENT_TYPES.includes(r.event_type));
      let rapidSameTypeCount = 0;
      for (let i = 1; i < contentRows.length; i++) {
        const prev = new Date(contentRows[i - 1]!.created_at).getTime();
        const cur  = new Date(contentRows[i]!.created_at).getTime();
        if (contentRows[i]!.event_type === contentRows[i - 1]!.event_type && cur - prev < 5 * 60_000) {
          rapidSameTypeCount++;
        }
      }

      // Event create/delete cycles
      const eventCreateDeleteCycles = Math.floor(
        Math.min(
          rows.filter((r) => r.event_type === "event_created").length,
          rows.filter((r) => r.event_type === "event_deleted").length,
        ) / 2,
      );

      // Near-duplicate content flagged in metadata
      const duplicateContentCount = rows.filter(
        (r) => (r.metadata as any)?.duplicate_flag === true,
      ).length;

      return {
        burstEpisodes,
        duplicateContentCount,
        followUnfollowCycles,
        rapidSameTypeCount,
        eventCreateDeleteCycles,
      };
    } catch {
      return {
        burstEpisodes:           0,
        duplicateContentCount:   0,
        followUnfollowCycles:    0,
        rapidSameTypeCount:      0,
        eventCreateDeleteCycles: 0,
      };
    }
  }

  // ── Safety multiplier ─────────────────────────────────────────────────────

  private async _fetchSafetyMultiplier(userId: string): Promise<number> {
    try {
      const { data } = await (this.db as any)
        .from("trust_profiles")
        .select("overall_score, public_level")
        .eq("user_id", userId)
        .maybeSingle();

      if (!data) return 1.0; // no profile → default full multiplier

      const d = data as any;
      const level: string = d.public_level ?? "new_traveler";

      // Severe restriction: explicitly suspended / restricted levels
      if (level === "suspended" || level === "restricted") return 0.0;

      const overallScore = Number(d.overall_score) || 50;
      if (overallScore < 20) return 0.0;
      if (overallScore < 30) return 0.3;
      if (overallScore < 40) return 0.6;
      if (overallScore < 50) return 0.8;
      return 1.0;
    } catch {
      return 1.0; // fail-open: don't penalise on DB error
    }
  }
}

// ─── Persist result ───────────────────────────────────────────────────────────

/**
 * Upsert the calculated score to `creator_activity_scores`.
 * ON CONFLICT user_id DO UPDATE — idempotent, safe to re-run.
 */
export async function persistActivityScore(
  db:     SupabaseClient,
  result: CreatorActivityScoreResult,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await (db as any)
    .from("creator_activity_scores")
    .upsert(
      {
        user_id:                       result.userId,
        score:                         result.score,
        recent_contribution_score:     result.recentContributionScore,
        consistency_score:             result.consistencyScore,
        community_participation_score: result.communityParticipationScore,
        positive_response_score:       result.positiveResponseScore,
        maintenance_score:             result.maintenanceScore,
        spam_penalty:                  result.spamPenalty,
        repetition_penalty:            result.repetitionPenalty,
        safety_multiplier:             result.safetyMultiplier,
        calculation_version:           result.calculationVersion,
        calculated_at:                 now,
        updated_at:                    now,
      },
      { onConflict: "user_id" },
    );

  if (error) {
    logger.warn({ err: error, userId: result.userId }, "persistActivityScore: upsert failed (non-fatal)");
  }
}

// ─── High-level entry point ───────────────────────────────────────────────────

/**
 * Calculate and persist the CreatorActivityScore for a single user.
 * Safe to call from a background job; never throws.
 *
 * @returns The computed result, or null on unexpected error.
 */
export async function calculateAndPersistScore(
  db:           SupabaseClient,
  userId:       string,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): Promise<CreatorActivityScoreResult | null> {
  try {
    const aggregator = new CreatorSignalAggregator(db);
    const signals    = await aggregator.aggregate(userId);
    const result     = computeActivityScore(userId, signals, halfLifeDays);
    await persistActivityScore(db, result);
    return result;
  } catch (err) {
    logger.warn({ err, userId }, "calculateAndPersistScore: unexpected error");
    return null;
  }
}
