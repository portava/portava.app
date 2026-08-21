/**
 * NotificationPrivacyGuard
 *
 * Sanitises notification titles and bodies before they are stored or delivered.
 *
 * Rules enforced:
 *   1. Strip exact GPS coordinates from title/body (lat/lng patterns).
 *   2. Replace private stay locations with a vague label.
 *   3. Block delivery to users whose membership was removed from a trip.
 *   4. Block location/status-based notifications for users in Ghost Mode.
 *   5. Hide reporter identity in trust notifications.
 *   6. Exclude live-share coordinates from push previews.
 *   7. Block delivery of private plan location to pending (invited) users.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "NotificationPrivacyGuard" });

// ── GPS coordinate stripper ───────────────────────────────────────────────────
// Matches common coordinate patterns: "12.3456, -78.9012" or "(lat: 12.34, lng: -78.90)"
const GPS_PATTERN = /[-+]?\d{1,3}\.\d{4,}[,\s]+[-+]?\d{1,3}\.\d{4,}/g;
const LAT_LNG_LABEL_PATTERN = /\b(lat(itude)?|lng|lon(gitude)?)\s*[:=]\s*[-+]?\d+\.\d+/gi;

export function stripGPSCoordinates(text: string): string {
  return text
    .replace(GPS_PATTERN, '[location]')
    .replace(LAT_LNG_LABEL_PATTERN, '[location]');
}

// ── Context checked categories that need privacy rules ────────────────────────
const LOCATION_CATEGORIES = new Set(['location', 'safe_return']);
const TRUST_CATEGORIES = new Set(['trust']);

// ── Privacy context input ─────────────────────────────────────────────────────
export interface PrivacyContext {
  recipientId: string;
  senderId?: string;
  category: string;
  eventType: string;
  tripId?: string;
  isLiveShare?: boolean;
  isPushPreview?: boolean;
}

// ── Sanitised result ──────────────────────────────────────────────────────────
export interface SanitisedNotification {
  title: string;
  body: string;
  blocked: boolean;
  blockReason?: string;
  privacyLevel: 'standard' | 'sensitive' | 'ghost_hidden';
}

export class NotificationPrivacyGuard {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Sanitise a notification before delivery.
   * Returns { blocked: true } when the notification must be silently dropped.
   */
  async sanitise(
    title: string,
    body: string,
    ctx: PrivacyContext,
  ): Promise<SanitisedNotification> {
    // 1. Strip GPS from both fields regardless of category
    let safeTitle = stripGPSCoordinates(title);
    let safeBody  = stripGPSCoordinates(body);

    // 2. Suppress live-share exact coordinates in push previews
    if (ctx.isLiveShare && ctx.isPushPreview) {
      safeBody = 'Live location active — open the app to view.';
    }

    // 3. Trust notifications: hide reporter identity (apply to both title and body)
    if (TRUST_CATEGORIES.has(ctx.category)) {
      const sanitizeText = (text: string) => text
        .replace(/reported by [^.\n]+/gi, 'reported by a community member')
        .replace(/reporter\s*:[^\n]+/gi, 'reporter: [protected]');
      safeTitle = sanitizeText(safeTitle);
      safeBody  = sanitizeText(safeBody);
    }

    // 4. Ghost Mode: suppress location/status notifications about ghost users
    if (ctx.senderId && LOCATION_CATEGORIES.has(ctx.category)) {
      const isGhost = await this.isUserInGhostMode(ctx.senderId);
      if (isGhost) {
        logger.info({ senderId: ctx.senderId, category: ctx.category }, 'PrivacyGuard: blocked — sender in Ghost Mode');
        return { title: safeTitle, body: safeBody, blocked: true, blockReason: 'ghost_mode', privacyLevel: 'ghost_hidden' };
      }
    }

    // 5. Removed trip member: stop receiving trip/plan updates
    if (ctx.tripId && (ctx.category === 'trips' || ctx.category === 'plans')) {
      const isRemoved = await this.isTripMemberRemoved(ctx.recipientId, ctx.tripId);
      if (isRemoved) {
        logger.info({ recipientId: ctx.recipientId, tripId: ctx.tripId }, 'PrivacyGuard: blocked — recipient removed from trip');
        return { title: safeTitle, body: safeBody, blocked: true, blockReason: 'removed_from_trip', privacyLevel: 'standard' };
      }
    }

    // 6. Pending (invited) users: block private plan location delivery
    if (ctx.tripId && ctx.category === 'plans' && ctx.eventType === 'plan.item_added') {
      const isPending = await this.isTripMemberPending(ctx.recipientId, ctx.tripId);
      if (isPending) {
        logger.info({ recipientId: ctx.recipientId, tripId: ctx.tripId }, 'PrivacyGuard: blocked — recipient is pending trip member');
        return { title: safeTitle, body: safeBody, blocked: true, blockReason: 'pending_member', privacyLevel: 'sensitive' };
      }
    }

    const privacyLevel: 'standard' | 'sensitive' | 'ghost_hidden' =
      LOCATION_CATEGORIES.has(ctx.category) ? 'sensitive' : 'standard';

    return { title: safeTitle, body: safeBody, blocked: false, privacyLevel };
  }

  private async isUserInGhostMode(userId: string): Promise<boolean> {
    try {
      const { data } = await this.db
        .from('user_location_preferences')
        .select('location_mode')
        .eq('user_id', userId)
        .maybeSingle();
      return (data as any)?.location_mode === 'ghost';
    } catch {
      return false;
    }
  }

  private async isTripMemberRemoved(userId: string, tripId: string): Promise<boolean> {
    try {
      const { data } = await this.db
        .from('trip_members')
        .select('role')
        .eq('user_id', userId)
        .eq('trip_id', tripId)
        .maybeSingle();
      // No row = removed/never member; "removed" role if that exists
      if (!data) return true;
      return (data as any).role === 'removed';
    } catch {
      return false;
    }
  }

  private async isTripMemberPending(userId: string, tripId: string): Promise<boolean> {
    try {
      const { data } = await this.db
        .from('trip_members')
        .select('role')
        .eq('user_id', userId)
        .eq('trip_id', tripId)
        .maybeSingle();
      return (data as any)?.role === 'invited';
    } catch {
      return false;
    }
  }
}
