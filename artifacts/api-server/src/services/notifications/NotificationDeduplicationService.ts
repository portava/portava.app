/**
 * NotificationDeduplicationService
 *
 * Prevents duplicate / spammy notifications:
 *  - Coalesces repeated "new message" events within a configurable window.
 *  - Throttles nearby-recommendation events (1 per location per interval).
 *  - Rate-limits Compass suggestions (max N per day).
 *  - Deduplicates on (user_id, category, source_type, source_id) within a rolling window.
 *
 * ── THE ROLLING WINDOW IS WHERE TELEGRAPH §19'S PRIORITY BANDS LAND ──────────
 * §19 declares six attention bands (P0 Safety … P5 AI), and census-telegraph
 * T255 measured what they were worth: `important` "carries no delivery
 * difference from `normal` — only `urgent` changes behaviour. It is a label,
 * not a priority."
 *
 * The band is NOT allowed to change delivery: NotificationPreferenceService
 * draws the override line at `urgent` + `admin` on purpose, and a meetup moving
 * is not a reason to wake somebody at 3am. What a band legitimately changes is
 * HOW LONG one notification SUPPRESSES the next, and rule 4 below is the only
 * place that number lived. It was one flat 30 minutes for everything, which
 * meant a second safety alert was a duplicate of the first, and "the meetup
 * moved to 8" then "the meetup moved to the other bar" was one notification.
 *
 * `dedupeWindowFor` (domain/telegraph/policies/attentionLadder.ts) supplies the
 * per-band number. Its three answers are three different instructions and the
 * difference is load-bearing:
 *   undefined -> the ladder does not claim this event; keep the 30-minute default
 *   0         -> P0; never suppress
 *   null      -> P4; not persisted at all
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { dedupeWindowFor } from "../../domain/telegraph/policies/attentionLadder.js";

const logger = rootLogger.child({ service: "NotificationDeduplicationService" });

const COALESCE_WINDOW_MS = 5 * 60 * 1000;          // 5 minutes for message coalescence
const NEARBY_THROTTLE_MS = 60 * 60 * 1000;          // 1 hour for nearby recommendations
const COMPASS_DAILY_LIMIT = 3;                        // max Compass suggestions per day
const DEFAULT_DEDUP_WINDOW_MS = 30 * 60 * 1000;     // 30 minutes for general dedup

export interface DeduplicationResult {
  isDuplicate: boolean;
  reason?: string;
}

export class NotificationDeduplicationService {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Check whether a notification should be suppressed as a duplicate.
   * Returns { isDuplicate: true } when the notification should be skipped.
   */
  async check(params: {
    userId: string;
    category: string;
    eventType: string;
    sourceType?: string;
    sourceId?: string;
  }): Promise<DeduplicationResult> {
    const { userId, category, eventType, sourceType, sourceId } = params;

    // 0. §19 P4 — "realtime only; no persistent push". A band the ladder marks
    // as not persisted must not reach the notifications table at all. Nothing
    // maps to P4 today (there is deliberately no typing template anywhere in
    // this repository, T258), so this is a guard against one being added and
    // quietly acquiring a push path rather than a branch with live traffic.
    const ladderWindowMs = dedupeWindowFor(eventType);
    if (ladderWindowMs === null) {
      logger.debug({ userId, eventType }, 'dedup: ephemeral band is not persisted');
      return { isDuplicate: true, reason: 'ephemeral_not_persisted' };
    }

    // 1. Message coalescing: suppress repeated "new message" for the same thread.
    // The window comes from the ladder (P2 = 5 minutes, the same number this
    // rule always used) so that the constant and the band cannot drift apart.
    if (category === 'telegraph' && eventType === 'telegraph.message' && sourceId) {
      const isDup = await this.hasRecentNotification(userId, category, sourceType ?? 'thread', sourceId, ladderWindowMs ?? COALESCE_WINDOW_MS);
      if (isDup) {
        logger.debug({ userId, sourceId }, 'dedup: coalescing telegraph.message');
        return { isDuplicate: true, reason: 'message_coalesced' };
      }
    }

    // 2. Nearby throttle for location notifications
    if (category === 'location' && (eventType === 'location.nearby_traveler' || eventType === 'airport.traveler_nearby')) {
      const isDup = await this.hasRecentNotification(userId, category, sourceType ?? 'area', sourceId ?? '', NEARBY_THROTTLE_MS);
      if (isDup) {
        logger.debug({ userId }, 'dedup: throttling nearby recommendation');
        return { isDuplicate: true, reason: 'nearby_throttled' };
      }
    }

    // 3. Compass daily rate limit
    if (category === 'compass' && eventType === 'compass.recommendation') {
      const count = await this.countTodayNotifications(userId, category);
      if (count >= COMPASS_DAILY_LIMIT) {
        logger.debug({ userId, count }, 'dedup: compass daily limit reached');
        return { isDuplicate: true, reason: 'compass_rate_limited' };
      }
    }

    // 4. General deduplication on (user, category, eventType, sourceType, sourceId).
    // event_type must be part of the match: different events about the same
    // source (e.g. trip.invite then trip.reminder for one trip) are not
    // duplicates of each other and must not suppress one another.
    //
    // The window is the ladder's when the ladder claims the event, and the flat
    // default otherwise. `0` — P0 safety — skips the check entirely: a second
    // SOS is not a duplicate of the first, and the cost of being wrong in that
    // direction is unbounded, whereas the cost of a repeated safety push is an
    // annoyed traveller who is still alive to be annoyed.
    if (sourceType && sourceId) {
      const windowMs = ladderWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
      if (windowMs > 0) {
        const isDup = await this.hasRecentNotification(userId, category, sourceType, sourceId, windowMs, eventType);
        if (isDup) {
          logger.debug({ userId, category, eventType, sourceType, sourceId, windowMs }, 'dedup: general dedup hit');
          return { isDuplicate: true, reason: 'general_dedup' };
        }
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Has an equivalent notification already been written inside the window?
   *
   * ── AN UNREADABLE LEDGER IS A DUPLICATE ───────────────────────────────────
   * supabase-js RESOLVES on a DB error rather than throwing, so the `catch`
   * below — and its "DB check failed, allowing notification" log — could never
   * fire for the case it was written for: a PostgREST/Postgres failure came
   * back as `{ data: null, error }`, `Array.isArray(null)` was false, and the
   * function answered "not a duplicate" SILENTLY. Every coalescing rule in
   * `check()` (telegraph message bursts, nearby-traveler throttling, the
   * general per-source dedupe) then let the notification through, once per
   * event, for as long as the table stayed unreadable.
   *
   * An unknown ledger now answers `true` — treat as already sent. The direction
   * is not arbitrary: the row this check exists to avoid duplicating is written
   * to `notifications`, the very table that just failed to read, so a read
   * failure is overwhelmingly a write failure too and suppressing costs a
   * notification that was not going to be persisted anyway. Duplicated push
   * spam, by contrast, is delivered, durable and impossible to recall.
   */
  private async hasRecentNotification(
    userId: string,
    category: string,
    sourceType: string,
    sourceId: string,
    windowMs: number,
    eventType?: string,
  ): Promise<boolean> {
    try {
      const since = new Date(Date.now() - windowMs).toISOString();
      let query = this.db
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('category', category)
        .eq('source_type', sourceType)
        .eq('source_id', sourceId);
      // notifications.event_type is NOT NULL (0062_notifications_schema.sql) and
      // always written by NotificationService.create — safe to match on.
      if (eventType) {
        query = query.eq('event_type', eventType);
      }
      const { data, error } = await query
        .gt('created_at', since)
        .limit(1);
      if (error) {
        logger.warn({ err: error, userId, category }, 'dedup: DB check failed, suppressing as duplicate');
        return true;
      }
      return Array.isArray(data) && data.length > 0;
    } catch (err) {
      logger.warn({ err }, 'dedup: DB check threw, suppressing as duplicate');
      return true;
    }
  }

  /**
   * How many notifications of this category has the user already had today?
   *
   * ── SAME LEDGER, SAME DIRECTION ───────────────────────────────────────────
   * `hasRecentNotification` above was fixed to answer "already sent" when the
   * notifications table cannot be read. This function is the OTHER half of the
   * same ledger and it disagreed: `const { data } = await …` discarded the
   * error, `Array.isArray(null)` was false, and an unreadable table counted as
   * ZERO notifications sent today — i.e. the Compass daily cap read as "no
   * budget used" and every Compass suggestion went out, uncapped, for as long
   * as the table stayed unreadable. The `catch { return 0 }` could never fire
   * for that case either: supabase-js RESOLVES on a database error.
   *
   * An unknown count now answers COMPASS_DAILY_LIMIT — treat the budget as
   * spent. Same asymmetry as its sibling: a suppressed suggestion is a
   * suggestion the user can still get tomorrow; a burst of delivered pushes
   * cannot be recalled.
   */
  private async countTodayNotifications(userId: string, category: string): Promise<number> {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const { data, error } = await this.db
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('category', category)
        .gt('created_at', startOfDay.toISOString());
      if (error) {
        logger.warn({ err: error, userId, category }, 'dedup: daily-count read failed, treating the daily budget as spent');
        return COMPASS_DAILY_LIMIT;
      }
      return Array.isArray(data) ? data.length : 0;
    } catch (err) {
      logger.warn({ err, userId, category }, 'dedup: daily-count read threw, treating the daily budget as spent');
      return COMPASS_DAILY_LIMIT;
    }
  }
}
