/**
 * NotificationDigestService
 *
 * Builds daily digests per type (travel, trip, Pulse, Passport, Hidden Gems, Compass).
 * Groups notifications created since the last digest, formats a summary, and routes it.
 *
 * Safety-critical (urgent/important) notifications are NEVER digest-only — they
 * must have already been delivered immediately when created.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { NotificationService, type CreateNotificationInput } from "./NotificationService.js";
import { NotificationRouter } from "./NotificationRouter.js";
import { NotificationPreferenceService } from "./NotificationPreferenceService.js";

const logger = rootLogger.child({ service: "NotificationDigestService" });

const DIGEST_CATEGORIES = ['trips', 'pulse', 'passport', 'hidden_gems', 'compass'] as const;
type DigestCategory = typeof DIGEST_CATEGORIES[number];

const CATEGORY_LABELS: Record<DigestCategory, string> = {
  trips:       'Trips',
  pulse:       'City Pulse',
  passport:    'Passport',
  hidden_gems: 'Hidden Gems',
  compass:     'Compass AI',
};

export class NotificationDigestService {
  private readonly notifService: NotificationService;
  private readonly router: NotificationRouter;
  private readonly prefService: NotificationPreferenceService;

  constructor(private readonly db: SupabaseClient) {
    this.notifService = new NotificationService(db);
    this.router = new NotificationRouter(db);
    this.prefService = new NotificationPreferenceService(db);
  }

  /**
   * Build and send a daily digest for a single user.
   * Should be called once per day per user who has digests_enabled.
   */
  async sendDailyDigest(userId: string): Promise<void> {
    const since = this.getStartOfYesterday();

    for (const category of DIGEST_CATEGORIES) {
      await this.sendCategoryDigest(userId, category, since);
    }
  }

  /**
   * Run digests for all users who have digest preferences enabled.
   * Called by the scheduled cleanup/job infrastructure.
   */
  async runForAllUsers(): Promise<{ usersProcessed: number }> {
    try {
      const { data: prefs } = await this.db
        .from('notification_preferences')
        .select('user_id')
        .eq('digests_enabled', true);

      const users = (prefs ?? []).map((r: any) => r.user_id as string);
      logger.info({ count: users.length }, 'DigestService: processing daily digests');

      await Promise.allSettled(users.map((uid) => this.sendDailyDigest(uid)));
      return { usersProcessed: users.length };
    } catch (err) {
      logger.error({ err }, 'DigestService.runForAllUsers: failed');
      return { usersProcessed: 0 };
    }
  }

  private async sendCategoryDigest(
    userId: string,
    category: DigestCategory,
    since: string,
  ): Promise<void> {
    try {
      // Enforce per-category digest preference before generating the digest.
      // A user may have global digests_enabled=true but turned off a specific category.
      const catPref = (await this.prefService.getCategoryPreferences(userId))
        .find((c) => c.category === category);
      if (catPref && !catPref.digestEnabled) {
        logger.debug({ userId, category }, 'DigestService: digest suppressed by category preference');
        return;
      }

      // Fetch low-priority, non-urgent notifications created since the window
      const { data: rows } = await this.db
        .from('notifications')
        .select('id, title, body, priority')
        .eq('user_id', userId)
        .eq('category', category)
        .gt('created_at', since)
        .is('dismissed_at', null)
        .in('priority', ['normal', 'low']);

      const notifications = (rows ?? []) as Array<{ id: string; title: string; body: string; priority: string }>;
      if (notifications.length === 0) return;

      const label = CATEGORY_LABELS[category];
      const title = `Your ${label} digest`;
      const body  = notifications.length === 1
        ? notifications[0].body
        : `${notifications.length} updates — ${notifications.map((n) => n.title).slice(0, 3).join(', ')}${notifications.length > 3 ? '…' : ''}`;

      const input: CreateNotificationInput = {
        userId,
        eventType:  `digest.${category}` as any,
        title,
        body,
        category,  // preserve per-category semantics; routes through NotificationRouter
        priority:  'low',
        channels:  ['in_app'],
        sourceType: 'digest',
        sourceId:   `${category}_${since.slice(0, 10)}`,
        metadata:   { digestCategory: category, count: notifications.length },
      };

      const row = await this.notifService.create(input);
      if (row) {
        // Route via NotificationRouter so delivery attempts are logged and
        // category/global digest preferences are enforced (push, email, etc.).
        await this.router.route(row).catch((err) => {
          logger.warn({ err, userId, category }, 'DigestService: router delivery failed');
        });
      }
      logger.info({ userId, category, count: notifications.length }, 'DigestService: digest created');
    } catch (err) {
      logger.warn({ err, userId, category }, 'DigestService: category digest failed');
    }
  }

  private getStartOfYesterday(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
}
