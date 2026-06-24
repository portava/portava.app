/**
 * NotificationDeduplicationService
 *
 * Prevents duplicate / spammy notifications:
 *  - Coalesces repeated "new message" events within a configurable window.
 *  - Throttles nearby-recommendation events (1 per location per interval).
 *  - Rate-limits Compass suggestions (max N per day).
 *  - Deduplicates on (user_id, category, source_type, source_id) within a rolling window.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

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

    // 1. Message coalescing: suppress repeated "new message" for the same thread
    if (category === 'telegraph' && eventType === 'telegraph.message' && sourceId) {
      const isDup = await this.hasRecentNotification(userId, category, sourceType ?? 'thread', sourceId, COALESCE_WINDOW_MS);
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

    // 4. General deduplication on (user, category, sourceType, sourceId)
    if (sourceType && sourceId) {
      const isDup = await this.hasRecentNotification(userId, category, sourceType, sourceId, DEFAULT_DEDUP_WINDOW_MS);
      if (isDup) {
        logger.debug({ userId, category, sourceType, sourceId }, 'dedup: general dedup hit');
        return { isDuplicate: true, reason: 'general_dedup' };
      }
    }

    return { isDuplicate: false };
  }

  private async hasRecentNotification(
    userId: string,
    category: string,
    sourceType: string,
    sourceId: string,
    windowMs: number,
  ): Promise<boolean> {
    try {
      const since = new Date(Date.now() - windowMs).toISOString();
      const { data } = await this.db
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('category', category)
        .eq('source_type', sourceType)
        .eq('source_id', sourceId)
        .gt('created_at', since)
        .limit(1);
      return Array.isArray(data) && data.length > 0;
    } catch (err) {
      logger.warn({ err }, 'dedup: DB check failed, allowing notification');
      return false;
    }
  }

  private async countTodayNotifications(userId: string, category: string): Promise<number> {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const { data } = await this.db
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('category', category)
        .gt('created_at', startOfDay.toISOString());
      return Array.isArray(data) ? data.length : 0;
    } catch {
      return 0;
    }
  }
}
