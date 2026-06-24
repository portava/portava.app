/**
 * NotificationService
 *
 * Core CRUD for the notifications pipeline:
 *   create → privacy guard → dedup → preference check → persist
 *   list   → paginated, filterable
 *   markRead (single + all)
 *   dismiss
 *   expire  → cleanup job integration
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { NotificationPrivacyGuard, type PrivacyContext } from "./NotificationPrivacyGuard.js";
import { NotificationPreferenceService } from "./NotificationPreferenceService.js";
import { NotificationDeduplicationService } from "./NotificationDeduplicationService.js";
import { renderTemplate, type NotificationCategory, type NotificationChannel, type NotificationPriority } from "./NotificationTemplateService.js";

const logger = rootLogger.child({ service: "NotificationService" });

export interface CreateNotificationInput {
  userId: string;
  eventType: string;
  params?: Record<string, string>;
  // overrides from template defaults:
  title?: string;
  body?: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  channels?: string[];
  actionUrl?: string;
  imageUrl?: string;
  sourceType?: string;
  sourceId?: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: string;
  // privacy context extras:
  tripId?: string;
  senderId?: string;
  isLiveShare?: boolean;
}

export interface NotificationRow {
  id: string;
  userId: string;
  category: string;
  eventType: string;
  priority: string;
  title: string;
  body: string;
  actionUrl: string | null;
  imageUrl: string | null;
  sourceType: string | null;
  sourceId: string | null;
  actorId: string | null;
  metadata: Record<string, unknown>;
  privacyLevel: string;
  readAt: string | null;
  dismissedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ListNotificationsOptions {
  userId: string;
  category?: string;
  priority?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  since?: string;
}

function rowToDto(r: any): NotificationRow {
  return {
    id:           r.id,
    userId:       r.user_id,
    category:     r.category,
    eventType:    r.event_type,
    priority:     r.priority,
    title:        r.title,
    body:         r.body,
    actionUrl:    r.action_url ?? null,
    imageUrl:     r.image_url ?? null,
    sourceType:   r.source_type ?? null,
    sourceId:     r.source_id ?? null,
    actorId:      r.actor_id ?? null,
    metadata:     r.metadata ?? {},
    privacyLevel: r.privacy_level ?? 'standard',
    readAt:       r.read_at ?? null,
    dismissedAt:  r.dismissed_at ?? null,
    expiresAt:    r.expires_at ?? null,
    createdAt:    r.created_at,
  };
}

export class NotificationService {
  private readonly guard: NotificationPrivacyGuard;
  private readonly prefService: NotificationPreferenceService;
  private readonly dedup: NotificationDeduplicationService;

  constructor(private readonly db: SupabaseClient) {
    this.guard = new NotificationPrivacyGuard(db);
    this.prefService = new NotificationPreferenceService(db);
    this.dedup = new NotificationDeduplicationService(db);
  }

  /**
   * Create a notification through the full pipeline:
   * template render → privacy guard → dedup → preference check → persist.
   * Returns the created row or null if blocked/deduped.
   */
  async create(input: CreateNotificationInput): Promise<NotificationRow | null> {
    // 1. Render template or use override values
    let title    = input.title ?? '';
    let body     = input.body ?? '';
    let category = input.category;
    let priority = input.priority;
    let channels = input.channels;
    let actionUrl = input.actionUrl;

    if (input.eventType) {
      const rendered = renderTemplate(input.eventType, input.params ?? {});
      if (rendered) {
        if (!title)    title    = rendered.title;
        if (!body)     body     = rendered.body;
        if (!category) category = rendered.category;
        if (!priority) priority = rendered.priority;
        if (!channels) channels = rendered.channels as string[];
        if (!actionUrl) actionUrl = rendered.actionUrl;
      }
    }

    if (!title || !body || !category) {
      logger.warn({ eventType: input.eventType }, 'NotificationService.create: missing title/body/category');
      return null;
    }

    // 2. Deduplication check
    const dedupResult = await this.dedup.check({
      userId:     input.userId,
      category,
      eventType:  input.eventType,
      sourceType: input.sourceType,
      sourceId:   input.sourceId,
    });
    if (dedupResult.isDuplicate) {
      logger.debug({ userId: input.userId, eventType: input.eventType, reason: dedupResult.reason }, 'NotificationService: deduped');
      return null;
    }

    // 3. Privacy guard
    const privacyCtx: PrivacyContext = {
      recipientId: input.userId,
      senderId:    input.senderId,
      category,
      eventType:   input.eventType,
      tripId:      input.tripId,
      isLiveShare: input.isLiveShare,
      isPushPreview: channels?.includes('push'),
    };
    const sanitised = await this.guard.sanitise(title, body, privacyCtx);
    if (sanitised.blocked) {
      logger.info({ userId: input.userId, reason: sanitised.blockReason }, 'NotificationService: blocked by privacy guard');
      return null;
    }

    // 4. Persist the row — always store notifications that pass privacy/dedup rules
    // so the Activity Center and audit trail remain complete.  Channel preferences
    // (in_app/push/email/telegraph) are enforced in NotificationRouter after the
    // row exists, allowing independent per-channel control even when in_app is off.
    const row: Record<string, unknown> = {
      user_id:       input.userId,
      category,
      event_type:    input.eventType,
      priority:      priority ?? 'normal',
      title:         sanitised.title,
      body:          sanitised.body,
      action_url:    actionUrl ?? null,
      image_url:     input.imageUrl ?? null,
      source_type:   input.sourceType ?? null,
      source_id:     input.sourceId ?? null,
      actor_id:      input.actorId ?? null,
      metadata:      input.metadata ?? {},
      privacy_level: sanitised.privacyLevel,
      expires_at:    input.expiresAt ?? null,
    };

    const { data, error } = await this.db
      .from('notifications')
      .insert(row)
      .select('*')
      .single();

    if (error) {
      logger.error({ err: error }, 'NotificationService.create: DB insert failed');
      return null;
    }

    logger.info({ id: (data as any).id, userId: input.userId, eventType: input.eventType }, 'NotificationService: created');
    return rowToDto(data);
  }

  async list(opts: ListNotificationsOptions): Promise<{ notifications: NotificationRow[]; total: number }> {
    const limit  = Math.min(opts.limit ?? 20, 100);
    const offset = opts.offset ?? 0;

    let query = this.db
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', opts.userId)
      .is('dismissed_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (opts.category) query = (query as any).eq('category', opts.category);
    if (opts.priority) query = (query as any).eq('priority', opts.priority);
    if (opts.unreadOnly) query = (query as any).is('read_at', null);
    if (opts.since) query = (query as any).gt('created_at', opts.since);

    // Exclude expired
    const now = new Date().toISOString();
    query = (query as any).or(`expires_at.is.null,expires_at.gt.${now}`);

    const { data, error, count } = await (query as any);
    if (error) throw new Error(error.message);

    return {
      notifications: (data ?? []).map(rowToDto),
      total: count ?? 0,
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    const now = new Date().toISOString();
    const { count, error } = await (this.db
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null)
      .is('dismissed_at', null)
      .or(`expires_at.is.null,expires_at.gt.${now}`) as any);
    if (error) return 0;
    return count ?? 0;
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    // Update + select verifies the row both exists and belongs to the user.
    // Removing the read_at IS NULL filter makes this idempotent (already-read
    // notifications still return true instead of a confusing 404).
    const { data, error } = await (this.db
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle() as any);
    if (error) return false;
    return data !== null;
  }

  async markAllRead(userId: string, category?: string): Promise<number> {
    let query = this.db
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null)
      .is('dismissed_at', null);
    if (category) query = (query as any).eq('category', category);
    const { count, error } = await (query as any).select('id', { count: 'exact' });
    if (error) return 0;
    return count ?? 0;
  }

  async dismiss(userId: string, notificationId: string): Promise<boolean> {
    // Update + select verifies the row exists and belongs to the user before
    // treating the dismiss as successful.
    const { data, error } = await (this.db
      .from('notifications')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle() as any);
    if (error) return false;
    return data !== null;
  }

  /** Hard-delete rows that have passed their expiry. Called by cleanup job. */
  async expireOldNotifications(): Promise<number> {
    const now = new Date().toISOString();
    const { count, error } = await (this.db
      .from('notifications')
      .delete()
      .lt('expires_at', now) as any).select('id', { count: 'exact' });
    if (error) {
      logger.error({ err: error }, 'NotificationService.expireOldNotifications: failed');
      return 0;
    }
    const deleted = count ?? 0;
    logger.info({ deleted }, 'NotificationService: expired old notifications');
    return deleted;
  }
}
