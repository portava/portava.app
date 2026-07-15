/**
 * NotificationPreferenceService
 *
 * Reads and writes notification_preferences and notification_category_preferences.
 * Enforces:
 *   - Quiet hours: skip push during window UNLESS urgent or admin priority
 *   - Safety override: urgent + admin priority always deliver even when push is off
 *   - Per-category in-app/push/email/digest toggles
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationCategory, NotificationChannel, NotificationPriority } from "./NotificationTemplateService.js";

export interface NotificationPreferences {
  userId: string;
  pushEnabled: boolean;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  digestsEnabled: boolean;
  safetyOverride: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;   // "HH:MM"
  quietEnd: string;     // "HH:MM"
  messagePreviews: boolean;
  locationPreviews: boolean;
}

export interface CategoryPreferences {
  category: NotificationCategory;
  inAppEnabled: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean;
  digestEnabled: boolean;
}

const DEFAULTS: Omit<NotificationPreferences, 'userId'> = {
  pushEnabled: true,
  emailEnabled: false,
  inAppEnabled: true,
  digestsEnabled: false,
  safetyOverride: true,
  quietHoursEnabled: false,
  quietStart: '22:00',
  quietEnd: '08:00',
  messagePreviews: true,
  locationPreviews: false,
};

function rowToPrefs(userId: string, row: Record<string, any> | null): NotificationPreferences {
  if (!row) return { userId, ...DEFAULTS };
  return {
    userId,
    pushEnabled:       Boolean(row.push_enabled ?? DEFAULTS.pushEnabled),
    emailEnabled:      Boolean(row.email_enabled ?? DEFAULTS.emailEnabled),
    inAppEnabled:      Boolean(row.in_app_enabled ?? DEFAULTS.inAppEnabled),
    digestsEnabled:    Boolean(row.digests_enabled ?? DEFAULTS.digestsEnabled),
    safetyOverride:    Boolean(row.safety_override ?? DEFAULTS.safetyOverride),
    quietHoursEnabled: Boolean(row.quiet_hours_enabled ?? DEFAULTS.quietHoursEnabled),
    quietStart:        (row.quiet_start as string) ?? DEFAULTS.quietStart,
    quietEnd:          (row.quiet_end as string) ?? DEFAULTS.quietEnd,
    messagePreviews:   Boolean(row.message_previews ?? DEFAULTS.messagePreviews),
    locationPreviews:  Boolean(row.location_previews ?? DEFAULTS.locationPreviews),
  };
}

function prefsToRow(p: Partial<Omit<NotificationPreferences, 'userId'>>) {
  const patch: Record<string, unknown> = {};
  if (p.pushEnabled       !== undefined) patch.push_enabled        = p.pushEnabled;
  if (p.emailEnabled      !== undefined) patch.email_enabled       = p.emailEnabled;
  if (p.inAppEnabled      !== undefined) patch.in_app_enabled      = p.inAppEnabled;
  if (p.digestsEnabled    !== undefined) patch.digests_enabled     = p.digestsEnabled;
  if (p.safetyOverride    !== undefined) patch.safety_override     = p.safetyOverride;
  if (p.quietHoursEnabled !== undefined) patch.quiet_hours_enabled = p.quietHoursEnabled;
  if (p.quietStart        !== undefined) patch.quiet_start         = p.quietStart;
  if (p.quietEnd          !== undefined) patch.quiet_end           = p.quietEnd;
  if (p.messagePreviews   !== undefined) patch.message_previews    = p.messagePreviews;
  if (p.locationPreviews  !== undefined) patch.location_previews   = p.locationPreviews;
  return patch;
}

export class NotificationPreferenceService {
  constructor(private readonly db: SupabaseClient) {}

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const { data } = await this.db
      .from('notification_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return rowToPrefs(userId, data as Record<string, any> | null);
  }

  async upsertPreferences(
    userId: string,
    patch: Partial<Omit<NotificationPreferences, 'userId'>>,
  ): Promise<NotificationPreferences> {
    const row = { user_id: userId, ...prefsToRow(patch), updated_at: new Date().toISOString() };
    const { data, error } = await this.db
      .from('notification_preferences')
      .upsert(row, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return rowToPrefs(userId, data as Record<string, any>);
  }

  async getCategoryPreferences(userId: string): Promise<CategoryPreferences[]> {
    const { data } = await this.db
      .from('notification_category_preferences')
      .select('*')
      .eq('user_id', userId);
    return (data ?? []).map((r: any) => ({
      category:       r.category as NotificationCategory,
      inAppEnabled:   Boolean(r.in_app_enabled),
      pushEnabled:    Boolean(r.push_enabled),
      emailEnabled:   Boolean(r.email_enabled),
      digestEnabled:  Boolean(r.digest_enabled),
    }));
  }

  async upsertCategoryPreferences(
    userId: string,
    category: NotificationCategory,
    patch: Partial<Omit<CategoryPreferences, 'category'>>,
  ): Promise<void> {
    const row: Record<string, unknown> = { user_id: userId, category, updated_at: new Date().toISOString() };
    if (patch.inAppEnabled  !== undefined) row.in_app_enabled = patch.inAppEnabled;
    if (patch.pushEnabled   !== undefined) row.push_enabled   = patch.pushEnabled;
    if (patch.emailEnabled  !== undefined) row.email_enabled  = patch.emailEnabled;
    if (patch.digestEnabled !== undefined) row.digest_enabled = patch.digestEnabled;
    await this.db
      .from('notification_category_preferences')
      .upsert(row, { onConflict: 'user_id,category' });
  }

  /**
   * Given a priority, category and user prefs, decide which channels should be used.
   *
   * Safety override applies when:
   *   - priority === 'urgent'  (true safety-critical, e.g. safe_return alerts), OR
   *   - category === 'admin'   (platform notices must reach the user regardless of push state)
   *
   * `important` priority alone does NOT bypass user preferences — it is high-priority
   * but still respects push-off / quiet-hours settings.
   */
  filterChannels(
    channels: NotificationChannel[],
    prefs: NotificationPreferences,
    catPrefs: CategoryPreferences | undefined,
    priority: NotificationPriority,
    category?: string,
  ): NotificationChannel[] {
    const isSafetyCritical = priority === 'urgent' || category === 'admin';
    const safetyOverrideApplies = prefs.safetyOverride && isSafetyCritical;

    return channels.filter((ch) => {
      switch (ch) {
        case 'in_app':
          if (!prefs.inAppEnabled) return false;
          if (catPrefs && !catPrefs.inAppEnabled) return false;
          return true;
        case 'push': {
          if (!prefs.pushEnabled && !safetyOverrideApplies) return false;
          if (catPrefs && !catPrefs.pushEnabled && !safetyOverrideApplies) return false;
          if (prefs.quietHoursEnabled && !safetyOverrideApplies && this.isQuietHour(prefs)) return false;
          return true;
        }
        case 'email':
          if (!prefs.emailEnabled) return false;
          if (catPrefs && !catPrefs.emailEnabled) return false;
          return true;
        case 'telegraph':
          // Respect per-category in_app toggle as the opt-out proxy for Telegraph delivery
          if (catPrefs && !catPrefs.inAppEnabled) return false;
          return true;
        default:
          return false;
      }
    });
  }

  /** Returns true if the current time is inside the quiet window. */
  isQuietHour(prefs: NotificationPreferences): boolean {
    if (!prefs.quietHoursEnabled) return false;
    const now = new Date();
    const [sh, sm] = prefs.quietStart.split(':').map(Number);
    const [eh, em] = prefs.quietEnd.split(':').map(Number);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const startMins = sh * 60 + sm;
    const endMins   = eh * 60 + em;
    if (startMins < endMins) {
      // Same-day window (e.g. 09:00–17:00)
      return nowMins >= startMins && nowMins < endMins;
    }
    // Overnight window (e.g. 22:00–08:00)
    return nowMins >= startMins || nowMins < endMins;
  }
}
