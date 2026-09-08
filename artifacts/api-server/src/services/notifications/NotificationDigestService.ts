/**
 * NotificationDigestService
 *
 * Builds daily digests per type (travel, trip, Pulse, Passport, Hidden Gems, Compass).
 * Groups notifications created since the last digest, formats a summary, and routes it.
 *
 * Safety-critical (urgent/important) notifications are NEVER digest-only — they
 * must have already been delivered immediately when created.
 *
 * ── THE DELIVERY CLAIM THIS FILE MAKES, AND NOW IMPLEMENTS ───────────────────
 * AT MOST ONCE per (user, category, digest day). A digest is named after the
 * day it summarises (`sourceId = "<category>_<YYYY-MM-DD>"`), so running the
 * job twice for that day must produce ONE digest.
 *
 * It did not. The only thing standing between two runs was
 * NotificationDeduplicationService's general dedupe, whose window is
 * DEFAULT_DEDUP_WINDOW_MS = 30 minutes. Two runs 31 minutes apart — a retried
 * cron, an operator re-poking POST /internal/notifications/digest, a second
 * instance picking up the schedule — each wrote their own digest for the same
 * day, because a 30-minute window cannot enforce a per-day claim. The
 * `alreadyDigestedForDay` check below is scoped to the day, like the claim.
 *
 * The window was also wrong in the other direction: it ran from the start of
 * YESTERDAY to NOW, so everything created today was summarised in today's
 * digest and then again in tomorrow's. It is now the closed day
 * [start of yesterday, start of today), which is the day the sourceId names.
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
   *
   * ── "NOBODY TO NOTIFY" vs "THE RECIPIENT LIST IS UNREADABLE" ──────────────
   * `const { data: prefs } = await …` discarded the error. supabase-js resolves
   * on a database failure, so an unreadable notification_preferences table gave
   * `prefs === null`, `users === []`, a cheerful
   * `DigestService: processing daily digests { count: 0 }` in the log, and
   * `{ usersProcessed: 0 }` back to POST /internal/notifications/digest, which
   * answered HTTP 200 `ok: true`. A day on which every digest was skipped
   * because the database was unreachable was indistinguishable — in the logs,
   * in the response, and in the metrics — from a day on which no user had
   * digests enabled.
   *
   * `recipientsUnreadable` carries that distinction out to the caller; the
   * route turns it into a 503 so a failed run cannot be counted as a clean one.
   */
  async runForAllUsers(): Promise<{ usersProcessed: number; recipientsUnreadable: boolean }> {
    try {
      const { data: prefs, error } = await this.db
        .from('notification_preferences')
        .select('user_id')
        .eq('digests_enabled', true);

      if (error) {
        logger.error({ err: error }, 'DigestService.runForAllUsers: recipient list unreadable — this is NOT "no users have digests enabled"');
        return { usersProcessed: 0, recipientsUnreadable: true };
      }

      const users = (prefs ?? []).map((r: any) => r.user_id as string);
      logger.info({ count: users.length }, 'DigestService: processing daily digests');

      await Promise.allSettled(users.map((uid) => this.sendDailyDigest(uid)));
      return { usersProcessed: users.length, recipientsUnreadable: false };
    } catch (err) {
      logger.error({ err }, 'DigestService.runForAllUsers: failed');
      return { usersProcessed: 0, recipientsUnreadable: true };
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
      //
      // An unreadable overrides table used to come back as an EMPTY LIST, i.e.
      // "this user muted nothing" — so a user who had switched this digest off
      // received it anyway, for as long as the table stayed unreadable. A
      // digest is the least urgent thing this pipeline sends and the day guard
      // above writes no row when we bail, so the next run still produces it:
      // declining is free, and guessing at consent is not.
      const { categoryPrefs, readFailed } = await this.prefService.getCategoryPreferencesResult(userId);
      if (readFailed) {
        logger.error({ userId, category }, 'DigestService: category preferences unreadable — declining the digest rather than assuming it was not muted');
        return;
      }
      const catPref = categoryPrefs.find((c) => c.category === category);
      if (catPref && !catPref.digestEnabled) {
        logger.debug({ userId, category }, 'DigestService: digest suppressed by category preference');
        return;
      }

      // AT MOST ONCE per day: refuse if this day's digest already exists.
      // The 30-minute dedupe window inside NotificationService cannot enforce a
      // per-day claim, so the claim is enforced here, at its own scale.
      const digestSourceId = `${category}_${since.slice(0, 10)}`;
      const already = await this.alreadyDigestedForDay(userId, category, digestSourceId);
      if (already) {
        logger.debug({ userId, category, digestSourceId }, 'DigestService: digest for this day already exists — skipping');
        return;
      }

      // Fetch the notifications for the CLOSED day this digest is named after.
      // `.gt(since)` alone ran to NOW, so anything created today was summarised
      // in today's digest and again in tomorrow's.
      const { data: rows, error: rowsErr } = await this.db
        .from('notifications')
        .select('id, title, body, priority')
        .eq('user_id', userId)
        .eq('category', category)
        .gt('created_at', since)
        .lt('created_at', this.getStartOfToday())
        .is('dismissed_at', null)
        .in('priority', ['normal', 'low']);

      // An unreadable source table is not an empty day. Returning here without
      // saying so would file "the database was down" under "nothing happened",
      // and — because no digest row is written — the next run for this day is
      // still free to produce it once the table is readable again.
      if (rowsErr) {
        logger.error({ err: rowsErr, userId, category }, 'DigestService: digest source read failed — NOT an empty day; no digest written for this run');
        return;
      }

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
        sourceId:   digestSourceId,
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

  /**
   * Has the digest for this exact day already been written?
   *
   * Fails CLOSED (answers "yes, skip") when the table cannot be read, matching
   * NotificationDeduplicationService: an unreadable ledger is treated as
   * already-sent, because a digest that is delayed to the next run costs
   * nothing, while a second digest for a day is delivered and cannot be
   * recalled.
   */
  private async alreadyDigestedForDay(
    userId: string,
    category: DigestCategory,
    digestSourceId: string,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('category', category)
      .eq('event_type', `digest.${category}`)
      .eq('source_type', 'digest')
      .eq('source_id', digestSourceId)
      .limit(1);
    if (error) {
      logger.warn({ err: error, userId, category, digestSourceId }, 'DigestService: could not check for an existing digest — skipping rather than risk a duplicate');
      return true;
    }
    return Array.isArray(data) && data.length > 0;
  }

  private getStartOfYesterday(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  private getStartOfToday(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
}
