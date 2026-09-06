/**
 * CreatorActivityScoreService
 *
 * Calculates a bounded (0–100) CreatorActivityScore for a given user using
 * multi-window signals with exponential time decay and diminishing-returns
 * transforms. Designed to be called by the background recalculation job; it
 * must never be called on the hot path of a live feed request.
 *
 * Data sources used:
 *   posts            — contributions, received saves/shares/comments, and the
 *                      spam signals (author_id, status, post_status,
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
 *
 * ─── THIS LANE WAS DEAD, AND WHAT REPLACED IT ───────────────────────────────
 *
 * Until 2026-09-06 every component except recentContribution read
 * `public.activity_events`, a table with exactly ONE writer — POST
 * /internal/activity-events (routes/notifications.ts) — which is gated on the
 * internal-service secret and called by NOTHING: not this server, not the
 * client, not a scheduler, not a trigger. Its `event_type` is plain TEXT with
 * no ENUM and no CHECK, so all 22 literals SUCCEEDED and matched nothing,
 * silently and permanently. `check:enum-literals` could not see them, because
 * that guard only judges columns that carry a vocabulary and this one carries
 * none.
 *
 * The consequence was total: 0.70 of the weight and BOTH penalties were
 * structurally zero, so a real score was the NEW_USER_BASE_SCORE floor of 10,
 * or at most 30. And the scheduler could not even reach that — its candidate
 * pool was (stale scores) UNION (activity_events actors), and since
 * creator_activity_scores is written only by that same job, both halves were
 * empty forever and NO CREATOR WAS EVER SCORED A FIRST TIME.
 *
 * Every component now reads first-class tables that have real production
 * writers. Per component, with the honest caveat attached:
 *
 *   consistency      → actor-side day-stamps unioned across 13 tables. It must
 *                      stay ACTIONS, not publications: sourcing it from the
 *                      contribution tables alone would make it collinear with
 *                      recentContribution and silently turn the model into 0.50
 *                      "did you publish".
 *   participation    → posts_comments + event_rsvps, with the OWNER resolved so
 *                      the distinct-user half (70% of the component) is real.
 *                      `event_attended` and `helpful_response` are DROPPED —
 *                      neither exists in the schema, and approximating them onto
 *                      a neighbouring table would move the score on a different
 *                      population than it claims to measure.
 *   positiveResponse → a COUNT, no longer a rate. This is a product change, not
 *                      a repair: the old denominator was reach, and no source
 *                      for reach exists (post_impressions has no writer either).
 *                      See _fetchPositiveResponses for why every substitute
 *                      denominator was worse than removing it.
 *   maintenance      → post_edits only. Four of the five original upkeep kinds
 *                      have no producer, so this component is narrower than it
 *                      was and will read 0 for most creators until the edit
 *                      writer is widened. That is true of the data, and it is
 *                      visible in the persisted signals rather than hidden.
 *   spam/repetition  → burst, duplicate and rapid-same-type from posts. Follow-
 *                      cycling and event create/delete cycles are NOT
 *                      representable: user_follows and event state are current
 *                      state, hard-deleted, so a cycle leaves no trace. They
 *                      report 0 — the same value as before, but now a stated
 *                      absence rather than an empty query.
 *
 * A PROPERTY WORTH KNOWING: several of these sources are mutable state, not an
 * append-only log. post_saves, content_stamps, user_follows and event_rsvps rows
 * are DELETEd on unsave / unstamp / unfollow / RSVP-cancel, and user_follows in
 * BOTH directions on a block. So a creator's score can fall because someone else
 * undid their engagement, and past active-days can shrink retroactively. The
 * direction is safe — signal is only lost, never invented — but the score is no
 * longer reproducible from an audit trail. activity_events was meant to be that
 * log; it never had a writer, and this is the cost of not having one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "CreatorActivityScoreService" });

// ─── Version ──────────────────────────────────────────────────────────────────

/** Bump this string to force a full recalculation of all stored scores. */
export const ACTIVITY_SCORE_VERSION = "2.0";
// 1.0 -> 2.0: every component moved off the writerless `activity_events` table
// onto first-class rows. Every score stored under 1.0 was computed against
// sources that were structurally empty, so this bump exists precisely to force
// a full recalculation rather than let stale ~10-30 values persist.

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

/**
 * Max ids per `.in()` when resolving owners. Keeps the generated query string
 * well inside PostgREST's URL limit; see _ownersOf for why that matters.
 */
const OWNER_LOOKUP_CHUNK = 100;

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
  // A COUNT, NOT A RATE — see _fetchPositiveResponses for why the rate could
  // not survive. Briefly: the denominator was reach (`content_impression`), and
  // no first-class source for reach exists — post_impressions has no writer
  // either. Every candidate substitute was either so much smaller that all
  // creators saturate (making the component carry no information at all) or
  // privacy-gated in a way that would reward restrictive settings with a higher
  // rank. Scoring the volume directly is the honest option and is a stated
  // product change: large accounts are no longer normalised down.
  const { receivedPositiveActions } = signals;
  if (receivedPositiveActions <= 0) return 0;
  return saturate(receivedPositiveActions, SOFT_CAP_RESPONSES, 100);
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
 *   posts            — author_id, status, id, created_at
 *   events           — host_id, id, created_at
 *   trips            — owner_id, created_at
 *   reviews          — reviewer_id, state, created_at
 *   discovery_places — submitted_by, created_at
 *   posts_comments   — user_id, post_id, deleted_at, created_at
 *   post_saves       — user_id, post_id, created_at
 *   post_shares      — user_id, post_id, created_at
 *   content_stamps   — user_id, entity_type, entity_id, created_at
 *   event_rsvps      — user_id, event_id, created_at
 *   user_follows     — follower_id, following_id, created_at
 *   post_edits       — user_id, post_id, edited_at        (NOT created_at)
 *   profile_views    — viewer_id, viewed_at               (NOT created_at)
 *   blocks           — blocker_id, blocked_id
 *   trust_profiles   — user_id, overall_score, public_level
 *
 * The two odd timestamp columns are not a stylistic quirk to normalise away:
 * reading `created_at` on post_edits or profile_views is a 42703 that supabase-js
 * RETURNS rather than throws, so the surrounding try/catch would not fire and the
 * component would silently read zero — the exact failure that killed this lane.
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

  /**
   * Distinct calendar days on which the creator DID SOMETHING, over 90 days.
   *
   * PRESENCE, NOT AUTHORSHIP — and that distinction is the whole component.
   * The activity_events version filtered on `actor_id` with NO event_type
   * restriction, so it counted any day the lane logged an action of any kind.
   * recentContribution already measures publishing, with volume and decay;
   * consistency is what separates a creator who shows up daily and publishes
   * monthly from one who dumps ten posts and vanishes.
   *
   * SO THIS MUST NOT BE PUBLISH-DAYS. Sourcing it from the five contribution
   * tables alone would make `contributions90d === 0` imply `activeDays90 === 0`
   * for every creator, collapsing two independent 0.20/0.30 signals into one
   * 0.50 "did you publish" term — and silently, because both components would
   * still look populated. It would also break the new-user floor below, which
   * ANDs four conjuncts that would no longer be four distinct predicates.
   *
   * The union is therefore over every table where the creator ACTED, keyed on
   * the actor column, not the owner column.
   *
   * TWO TIMESTAMP COLUMNS ARE NOT `created_at`: post_edits uses `edited_at` and
   * profile_views uses `viewed_at`. Naming them wrong yields a silent empty
   * result rather than an error, which is exactly the failure this lane is
   * being repaired for.
   *
   * KNOWN PROPERTY, deliberately accepted: five of these sources are mutable
   * state rather than an append-only log — post_saves, content_stamps,
   * user_follows and event_rsvps rows are DELETEd on unsave / unstamp /
   * unfollow / RSVP-cancel, and user_follows is additionally deleted in BOTH
   * directions on a block. So a creator's past active-days can shrink
   * retroactively. The direction is safe (days are only lost, never invented)
   * but the score is no longer reproducible from an audit trail. That is the
   * price of having no append-only log at all; activity_events was that log and
   * never had a writer.
   */
  private async _fetchActiveDays(userId: string, ago90d: string): Promise<number> {
    /** [table, actorColumn, timeColumn] — time column is NOT always created_at. */
    const ACTOR_DAY_SOURCES: Array<[string, string, string]> = [
      // Authored contributions — the same rows recentContribution counts.
      ["posts",             "author_id",    "created_at"],
      ["events",            "host_id",      "created_at"],
      ["trips",             "owner_id",     "created_at"],
      ["reviews",           "reviewer_id",  "created_at"],
      ["discovery_places",  "submitted_by", "created_at"],
      // Actions on other people's content — the half publish-days would lose.
      ["posts_comments",    "user_id",      "created_at"],
      ["post_saves",        "user_id",      "created_at"],
      ["post_shares",       "user_id",      "created_at"],
      ["content_stamps",    "user_id",      "created_at"],
      ["event_rsvps",       "user_id",      "created_at"],
      ["user_follows",      "follower_id",  "created_at"],
      ["post_edits",        "user_id",      "edited_at"],
      ["profile_views",     "viewer_id",    "viewed_at"],
    ];

    const days = new Set<string>();
    const results = await Promise.all(
      ACTOR_DAY_SOURCES.map(async ([table, actorCol, timeCol]) => {
        try {
          const { data } = await (this.db as any)
            .from(table)
            .select(timeCol)
            .eq(actorCol, userId)
            .gte(timeCol, ago90d);
          return { rows: ((data as any[]) ?? []), timeCol };
        } catch {
          // One unavailable source must not zero the whole component — that is
          // how the previous version failed, silently and completely.
          return { rows: [] as any[], timeCol };
        }
      }),
    );
    for (const { rows, timeCol } of results) {
      for (const r of rows) {
        const d = String(r?.[timeCol] ?? "").slice(0, 10);
        if (d.length === 10) days.add(d);
      }
    }
    return days.size;
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
  /**
   * Resolve `ids` on `table` to their owner column, as a Map(id -> ownerId).
   *
   * Two-step rather than a PostgREST embedded select (`posts!inner(author_id)`)
   * ON PURPOSE. The in-memory Supabase doubles in this repo do not model embeds;
   * an embed against them returns rows with the joined key ABSENT, which reads
   * downstream as "no owner" and silently zeroes the component. That is the
   * exact failure mode this whole rewrite exists to remove, so the query shape
   * stays one the doubles can actually answer.
   */
  private async _ownersOf(table: string, ownerCol: string, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return out;

    // CHUNKED, and the chunking is load-bearing. `.in()` becomes a query string,
    // and a prolific commenter easily has several hundred distinct post_ids in
    // 90 days; at 36 chars per UUID plus escaping, one unbounded request runs
    // past the URL limit and comes back 414. supabase-js RETURNS that rather
    // than throwing, so `data` would be undefined, the owner map empty, and
    // participation silently 0 — for exactly the heaviest participants, the
    // ones the component most needs to see. Same silent-zero signature as the
    // defect this file exists to fix, just with a size threshold in front of it.
    for (let i = 0; i < unique.length; i += OWNER_LOOKUP_CHUNK) {
      const chunk = unique.slice(i, i + OWNER_LOOKUP_CHUNK);
      try {
        const { data } = await (this.db as any).from(table).select(`id, ${ownerCol}`).in("id", chunk);
        for (const r of ((data as any[]) ?? [])) {
          const owner = r?.[ownerCol];
          if (r?.id && owner) out.set(String(r.id), String(owner));
        }
      } catch {
        // One bad chunk must not discard the owners already resolved.
        continue;
      }
    }
    return out;
  }

  private async _fetchParticipation(
    userId: string, ago90d: string, blockedIds: Set<string>,
  ): Promise<Pick<CreatorSignals, "participationEvents"|"participationDistinctUsers">> {
    // The distinct-USER half carries 70% of this component (see the scorer):
    // breadth of contact with different people beats depth with one. So the
    // owner of each touched item has to be resolved, not just the row counted.
    //
    // `event_attended` and `helpful_response` have NO first-class equivalent.
    // event_attendees is a roster synced from RSVP state, not an attendance
    // fact, and nothing in the schema represents a helpful response. They are
    // dropped rather than approximated onto a table that means something else —
    // repointing a signal at the nearest-looking source is how this lane came
    // to measure a population it does not claim to.
    try {
      const [comments, rsvps] = await Promise.all([
        (async () => {
          try {
            const { data } = await (this.db as any)
              .from("posts_comments")
              .select("post_id")
              .eq("user_id", userId)
              .is("deleted_at", null)
              .gte("created_at", ago90d);
            return ((data as any[]) ?? []).map((r) => String(r?.post_id ?? "")).filter(Boolean);
          } catch { return [] as string[]; }
        })(),
        (async () => {
          try {
            const { data } = await (this.db as any)
              .from("event_rsvps")
              .select("event_id")
              .eq("user_id", userId)
              .gte("created_at", ago90d);
            return ((data as any[]) ?? []).map((r) => String(r?.event_id ?? "")).filter(Boolean);
          } catch { return [] as string[]; }
        })(),
      ]);

      const [postOwners, eventOwners] = await Promise.all([
        this._ownersOf("posts", "author_id", comments),
        this._ownersOf("events", "host_id", rsvps),
      ]);

      // Same two exclusions the activity_events version applied: never count
      // acting on your OWN content, and drop owners on either side of a block.
      const owners: string[] = [];
      for (const id of comments) {
        const o = postOwners.get(id);
        if (o && o !== userId && !blockedIds.has(o)) owners.push(o);
      }
      for (const id of rsvps) {
        const o = eventOwners.get(id);
        if (o && o !== userId && !blockedIds.has(o)) owners.push(o);
      }

      return {
        participationEvents:        owners.length,
        participationDistinctUsers: new Set(owners).size,
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
    // ── THIS COMPONENT IS NOW A COUNT, NOT A RATE. A PRODUCT CHANGE. ─────────
    // The activity_events version measured CONVERSION: positive actions divided
    // by total received interactions, where the denominator's bulk was
    // `content_impression` — i.e. reach. There is no first-class source for
    // reach: `post_impressions` has no writer either, exactly like the table
    // this rewrite is retiring.
    //
    // Substituting profile_views as the denominator was considered and REFUSED,
    // for two reasons that would each be worse than the defect being fixed:
    //   1. It is one to two orders of magnitude smaller than reach, so every
    //      creator with any engagement saturates at ~100 (softCap 5). A
    //      component that reads 100 for everyone carries NO information — the
    //      0.20 weight would be dead again, just less visibly.
    //   2. profile_views is written only for authenticated non-owner viewers who
    //      pass the privacy gate, while the numerator has no such gate. A
    //      smaller denominator would mean a HIGHER score, coupling restrictive
    //      privacy settings to discovery ranking. Nobody chose that.
    // So the denominator is retired with the rate, and volume is scored directly
    // against SOFT_CAP_RESPONSES. `receivedInteractionVolume` is still returned
    // (it is part of the persisted signal shape) but no longer divides anything.
    //
    // NOTE these sources are retractable: post_saves, content_stamps and
    // user_follows rows are DELETEd on unsave / unstamp / unfollow, and
    // user_follows in BOTH directions on a block. So this counts followers
    // ACQUIRED AND KEPT in the window, not follow events. That is arguably more
    // honest than an append-only log, but it is a different measurement, and a
    // creator's score can fall because someone else undid their engagement.
    try {
      const authored = await this._fetchAuthoredPostIds(userId, ago90d);
      const postIdSet = new Set(authored);

      const countOn = async (table: string, actorCol: string, timeCol: string): Promise<string[]> => {
        if (postIdSet.size === 0) return [];
        try {
          const { data } = await (this.db as any)
            .from(table)
            .select(`${actorCol}, post_id`)
            .in("post_id", authored)
            .gte(timeCol, ago90d);
          return ((data as any[]) ?? [])
            .map((r) => String(r?.[actorCol] ?? ""))
            .filter((a) => a && a !== userId && !blockedIds.has(a));
        } catch { return []; }
      };

      const [saves, shares, comments, follows, stamps] = await Promise.all([
        countOn("post_saves",     "user_id", "created_at"),
        countOn("post_shares",    "user_id", "created_at"),
        countOn("posts_comments", "user_id", "created_at"),
        (async () => {
          try {
            const { data } = await (this.db as any)
              .from("user_follows")
              .select("follower_id")
              .eq("following_id", userId)
              .gte("created_at", ago90d);
            return ((data as any[]) ?? [])
              .map((r) => String(r?.follower_id ?? ""))
              .filter((a) => a && a !== userId && !blockedIds.has(a));
          } catch { return [] as string[]; }
        })(),
        (async () => {
          // content_stamps is polymorphic with NO owner column and NO FK, and
          // one user can hold TWO rows for the same post — routes/posts.ts
          // stamps entity_type='post' while routes/mediaFeed.ts stamps
          // entity_type='media' with a post id, and the unique index is
          // (user_id, entity_type, entity_id). So both types are read against
          // this creator's post ids and then DEDUPED on (user_id, entity_id),
          // or a single like would count twice.
          if (postIdSet.size === 0) return [] as string[];
          try {
            const { data } = await (this.db as any)
              .from("content_stamps")
              .select("user_id, entity_id, entity_type")
              .in("entity_id", authored)
              .in("entity_type", ["post", "media"])
              .gte("created_at", ago90d);
            const seen = new Set<string>();
            const out: string[] = [];
            for (const r of ((data as any[]) ?? [])) {
              const actor = String(r?.user_id ?? "");
              const key = `${actor}:${String(r?.entity_id ?? "")}`;
              if (!actor || actor === userId || blockedIds.has(actor)) continue;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push(actor);
            }
            return out;
          } catch { return [] as string[]; }
        })(),
      ]);

      const positive = saves.length + shares.length + comments.length + follows.length + stamps.length;
      return { receivedPositiveActions: positive, receivedInteractionVolume: positive };
    } catch {
      return { receivedPositiveActions: 0, receivedInteractionVolume: 0 };
    }
  }

  /** This creator's live post ids in the window — the join key for received signals. */
  private async _fetchAuthoredPostIds(userId: string, ago90d: string): Promise<string[]> {
    try {
      const { data } = await (this.db as any)
        .from("posts")
        .select("id")
        .eq("author_id", userId)
        .eq("status", "active")
        .gte("created_at", ago90d);
      return ((data as any[]) ?? []).map((r) => String(r?.id ?? "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  // ── Maintenance actions ───────────────────────────────────────────────────

  private async _fetchMaintenance(userId: string, ago90d: string): Promise<number> {
    // NARROWER THAN IT WAS, and the narrowing is stated rather than hidden. The
    // activity_events version counted five kinds of upkeep: content_updated,
    // place_corrected, event_details_completed, trip_details_completed,
    // review_updated. Only the first has a first-class producer — post_edits,
    // written by PATCH /posts/:postId and ONLY when the body text actually
    // changes. Place corrections, event/trip completion and review edits leave
    // no row anywhere.
    //
    // The weight stays 0.10 rather than being redistributed, because the source
    // is real and will broaden if the edit-logging writer is widened. If it is
    // not widened, this component will read 0 for most creators — which is TRUE
    // of the data, not a defect in the scorer, and is visible in the persisted
    // signals rather than silently folded into another lane.
    try {
      const { data } = await (this.db as any)
        .from("post_edits")
        .select("id")
        .eq("user_id", userId)
        .gte("edited_at", ago90d);   // NB: edited_at, not created_at
      return ((data as any[]) ?? []).length;
    } catch {
      return 0;
    }
  }

  // ── Spam / anti-gaming signals ────────────────────────────────────────────

  private async _fetchSpamSignals(
    userId: string, ago90d: string,
  ): Promise<Pick<CreatorSignals, "burstEpisodes"|"duplicateContentCount"|"followUnfollowCycles"|"rapidSameTypeCount"|"eventCreateDeleteCycles">> {
    // TWO OF THE FIVE SIGNALS ARE NOT REPRESENTABLE, and are reported as 0
    // rather than approximated:
    //   followUnfollowCycles  — user_follows is CURRENT STATE, hard-deleted on
    //                           unfollow. A cycle leaves no trace at all, so
    //                           there is nothing to count. Detecting it needs an
    //                           append-only follow log, which is a build.
    //   eventCreateDeleteCycles — events are soft-deleted via state, but nothing
    //                           records a create→delete pair, and `events` is
    //                           behind the unseeded `events_enabled` flag.
    // Reporting them as 0 is the same value the dead lane produced, so no
    // creator's penalty changes because of them — but now the zero is a stated
    // absence rather than a silently empty query.
    //
    // Burst and rapid-same-type ARE representable from posts.created_at, which
    // has a real writer and an index (idx_posts_created).
    try {
      const { data } = await (this.db as any)
        .from("posts")
        .select("created_at, content")
        .eq("author_id", userId)
        .gte("created_at", ago90d)
        .order("created_at", { ascending: true });

      const rows: any[] = (data as any[]) ?? [];
      const times = rows
        .map((r) => new Date(String(r?.created_at ?? "")).getTime())
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);

      // Burst: more than 10 posts inside any 60-second window.
      let burstEpisodes = 0;
      for (let i = 0; i < times.length; i++) {
        let count = 1;
        for (let j = i + 1; j < times.length && times[j]! - times[i]! <= 60_000; j++) count++;
        if (count > 10) { burstEpisodes++; break; }
      }

      // Rapid same-type: consecutive posts less than 5 minutes apart.
      let rapidSameTypeCount = 0;
      for (let i = 1; i < times.length; i++) {
        if (times[i]! - times[i - 1]! < 5 * 60_000) rapidSameTypeCount++;
      }

      // Duplicate content: identical non-empty bodies published more than once.
      const seen = new Map<string, number>();
      for (const r of rows) {
        const body = String(r?.content ?? "").trim().toLowerCase();
        if (body.length === 0) continue;
        seen.set(body, (seen.get(body) ?? 0) + 1);
      }
      let duplicateContentCount = 0;
      for (const n of seen.values()) if (n > 1) duplicateContentCount += n - 1;

      return {
        burstEpisodes,
        duplicateContentCount,
        followUnfollowCycles: 0,
        rapidSameTypeCount,
        eventCreateDeleteCycles: 0,
      };
    } catch {
      return {
        burstEpisodes: 0, duplicateContentCount: 0, followUnfollowCycles: 0,
        rapidSameTypeCount: 0, eventCreateDeleteCycles: 0,
      };
    }
  }

  // ── Safety multiplier ─────────────────────────────────────────────────────

  /**
   * Safety multiplier from `trust_profiles`.
   *
   * THE KILL-SWITCH THAT NEVER FIRED
   * --------------------------------
   * This used to open with `if (level === "suspended" || level === "restricted")
   * return 0.0;` — the documented "collapse the score on verified severe
   * restriction" rule. `trust_profiles_public_level_check` admits exactly six
   * labels (new_traveler, building_trust, reliable_traveler, trusted_traveler,
   * highly_trusted, city_trusted) and `scoreToLevel` only ever produces those
   * six, so neither label can exist in any row. Nothing caught it because the
   * value was widened to `string` on the way in, which walked the comparison
   * past both the CHECK constraint and the `PublicTrustLevel` union; and
   * because `public_level` carries a CHECK rather than an ENUM, the wrong
   * label raised no 22P02 either — the branch was simply never taken.
   *
   * WHY IT WAS NOT REPOINTED AT A LIVE SIGNAL
   * -----------------------------------------
   * The schema has no platform-suspension concept to repoint at:
   * `profiles.account_status` is active/deactivated/pending_deletion/deleted,
   * and `user_restrictions` is one member muting another. `trust_restrictions`
   * is real and written (TrustRestrictionService.applyRestriction) but its four
   * types are behavioural scopes — hosting, messaging, private_plan_access,
   * location_plan_join. Collapsing a creator's discovery ranking to zero
   * because they cannot start a DM, or cannot host a group trip, would de-rank
   * a different population than "this creator's content is unsafe to boost".
   * That is the wrong-but-plausible signal, which is worse than a missing one.
   *
   * The live kill-switch is the numeric rung below: overall_score < 20 → 0.0.
   * It is authoritative (TrustScoreService writes overall_score from applied
   * trust_events) and reachable, and the same trust events that earn a
   * restriction drive that score down. A per-restriction de-ranking rule, if
   * it is wanted, is a product decision about WHICH restrictions should mute a
   * creator — not a repair to this reader.
   *
   * `public_level` is no longer selected: with the branch gone nothing reads
   * it, and a column fetched for a rule that does not exist reads like a rule
   * that does. creatorActivitySafetyMultiplier.test.ts pins both halves — the
   * six-label vocabulary, and that no label collapses the multiplier.
   */
  private async _fetchSafetyMultiplier(userId: string): Promise<number> {
    try {
      const { data } = await (this.db as any)
        .from("trust_profiles")
        .select("overall_score")
        .eq("user_id", userId)
        .maybeSingle();

      if (!data) return 1.0; // no profile → default full multiplier

      const d = data as any;
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
