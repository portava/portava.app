/**
 * Reminders — local, device-only reminder repository.
 *
 * v1 scope (see attached_assets brief):
 *  - ABSOLUTE INSTANT ONLY. `remindAt` is a fixed ISO timestamp computed once
 *    at create/edit time (e.g. "24h before the trip's departure instant").
 *    It never recomputes against the device's current timezone. Floating/
 *    local-time reminders ("9am wherever I am") are a different trigger type
 *    for a later version — do not add a mode flag for it here.
 *  - Local persistent repository ONLY. Reminders live in AsyncStorage on this
 *    device and are honestly presented as device-local, not account-synced.
 *    Reinstalling the app or switching devices loses them — that's expected
 *    for v1, not a bug. Cross-device sync is an explicit later backend task.
 *  - One scheduled `expo-notifications` local notification per reminder.
 *    `notificationId` tracks it so edits/completion/deletion can cancel the
 *    old notification instead of leaving an orphan.
 *
 * Storage shape is a flat JSON array under REMINDERS_STORAGE_KEY. All mutating
 * functions are read-modify-write over the whole array — reminder counts are
 * small (a personal list, not a feed), so this is simpler and safer than a
 * partial-update scheme.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const REMINDERS_STORAGE_KEY = '@travel_buddy/reminders_v1';

/** Minimal notification-scheduling surface this service needs. */
export interface NotifierLike {
  scheduleAt(date: Date, content: { title: string; body?: string; data?: Record<string, unknown> }): Promise<string | null>;
  cancel(id: string | null | undefined): Promise<void>;
}

// Test seam: bypass safeNotifications.ts entirely, which statically imports
// 'react-native' and cannot be loaded in a pure Node.js node:test environment
// (esbuild "Unexpected typeof" on react-native/index.js). Production code
// dynamic-imports safeNotifications lazily instead — mirrors the
// getAuthToken() lazy-import pattern in discoveryBookmarks.ts.
let _testNotifier: NotifierLike | null = null;
export function _setTestNotifier(notifier: NotifierLike | null): void {
  _testNotifier = notifier;
}

async function getNotifier(): Promise<NotifierLike> {
  if (_testNotifier) return _testNotifier;
  const mod = await import('../lib/safeNotifications.ts');
  return {
    scheduleAt: mod.scheduleLocalNotificationAt,
    cancel: mod.cancelScheduledNotification,
  };
}

/** What a reminder is attached to. `custom` means no attachment — a freeform reminder. */
export type ReminderTargetType = 'trip' | 'plan_item' | 'saved_place' | 'custom';

export interface Reminder {
  id: string;
  title: string;
  note: string | null;
  /** Absolute instant this reminder fires at. Fixed at create/edit time — never recomputed. */
  remindAt: string;
  targetType: ReminderTargetType;
  /** null only for targetType === 'custom'. */
  targetId: string | null;
  /**
   * Parent trip id. Required (non-null) when targetType === 'plan_item',
   * because TripPlanItem has no standalone lookup — it's only resolvable
   * through GET /api/trips/:tripId/plan. Always null for other target types.
   */
  tripId: string | null;
  /** Human-readable label for the attached target, shown in the list/detail UI. */
  targetLabel: string | null;
  status: 'upcoming' | 'completed';
  /** expo-notifications identifier for the currently-scheduled local notification, if any. */
  notificationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReminderInput {
  title: string;
  note?: string | null;
  remindAt: string;
  targetType: ReminderTargetType;
  targetId?: string | null;
  tripId?: string | null;
  targetLabel?: string | null;
}

export interface EditReminderPatch {
  title?: string;
  note?: string | null;
  remindAt?: string;
}

/** Minimal subset of AsyncStorage needed by these helpers — mirrors savedPlacesMapFilterStorage's StorageLike. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function genId(): string {
  return `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Reads the full reminder list. Corrupt/missing storage resolves to an empty list, never throws. */
export async function loadReminders(storage: StorageLike = AsyncStorage): Promise<Reminder[]> {
  try {
    const raw = await storage.getItem(REMINDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persist(storage: StorageLike, reminders: Reminder[]): Promise<void> {
  await storage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(reminders));
}

export async function getReminder(id: string, storage: StorageLike = AsyncStorage): Promise<Reminder | null> {
  const all = await loadReminders(storage);
  return all.find((r) => r.id === id) ?? null;
}

/**
 * Creates a reminder, schedules its local notification, and persists it.
 * Validates the non-negotiable data-model rule: plan_item attachments must
 * carry a tripId (TripPlanItem has no standalone lookup).
 */
export async function createReminder(
  input: CreateReminderInput,
  storage: StorageLike = AsyncStorage,
): Promise<Reminder> {
  if (input.targetType === 'plan_item' && !input.tripId) {
    throw new Error('Plan item reminders require a tripId — plan items have no standalone lookup.');
  }
  const now = new Date().toISOString();
  const id = genId();
  const notifier = await getNotifier();
  const notificationId = await notifier.scheduleAt(new Date(input.remindAt), {
    title: input.title,
    body: input.note ?? undefined,
    data: { reminderId: id },
  });
  const reminder: Reminder = {
    id,
    title: input.title,
    note: input.note ?? null,
    remindAt: input.remindAt,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    tripId: input.targetType === 'plan_item' ? (input.tripId ?? null) : null,
    targetLabel: input.targetLabel ?? null,
    status: 'upcoming',
    notificationId,
    createdAt: now,
    updatedAt: now,
  };
  const all = await loadReminders(storage);
  all.push(reminder);
  await persist(storage, all);
  return reminder;
}

/**
 * Edits title/note/remindAt. When remindAt changes, the previously scheduled
 * notification is cancelled and a new one scheduled at the new instant, so a
 * stale notification never survives an edit.
 */
export async function editReminder(
  id: string,
  patch: EditReminderPatch,
  storage: StorageLike = AsyncStorage,
): Promise<Reminder | null> {
  const all = await loadReminders(storage);
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const existing = all[idx];

  let notificationId = existing.notificationId;
  const remindAtChanged = patch.remindAt !== undefined && patch.remindAt !== existing.remindAt;
  if (remindAtChanged && existing.status === 'upcoming') {
    const notifier = await getNotifier();
    await notifier.cancel(existing.notificationId);
    notificationId = await notifier.scheduleAt(new Date(patch.remindAt!), {
      title: patch.title ?? existing.title,
      body: (patch.note !== undefined ? patch.note : existing.note) ?? undefined,
      data: { reminderId: id },
    });
  }

  const updated: Reminder = {
    ...existing,
    title: patch.title ?? existing.title,
    note: patch.note !== undefined ? patch.note : existing.note,
    remindAt: patch.remindAt ?? existing.remindAt,
    notificationId,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  await persist(storage, all);
  return updated;
}

/**
 * Snoozes a reminder to a new absolute instant. Distinct from editReminder
 * only in intent (UI affordance); mechanically it's the same
 * cancel-old/schedule-new/persist sequence, always applied even if the
 * reminder was already completed (snoozing un-completes it).
 */
export async function snoozeReminder(
  id: string,
  newRemindAt: string,
  storage: StorageLike = AsyncStorage,
): Promise<Reminder | null> {
  const all = await loadReminders(storage);
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const existing = all[idx];

  const notifier = await getNotifier();
  await notifier.cancel(existing.notificationId);
  const notificationId = await notifier.scheduleAt(new Date(newRemindAt), {
    title: existing.title,
    body: existing.note ?? undefined,
    data: { reminderId: id },
  });

  const updated: Reminder = {
    ...existing,
    remindAt: newRemindAt,
    status: 'upcoming',
    notificationId,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  await persist(storage, all);
  return updated;
}

/** Marks a reminder completed and cancels its scheduled notification, so a completed reminder never still fires. */
export async function completeReminder(id: string, storage: StorageLike = AsyncStorage): Promise<Reminder | null> {
  const all = await loadReminders(storage);
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const existing = all[idx];
  const notifier = await getNotifier();
  await notifier.cancel(existing.notificationId);
  const updated: Reminder = {
    ...existing,
    status: 'completed',
    notificationId: null,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  await persist(storage, all);
  return updated;
}

/** Reopens a completed reminder as upcoming and reschedules its notification if the instant is still in the future. */
export async function reopenReminder(id: string, storage: StorageLike = AsyncStorage): Promise<Reminder | null> {
  const all = await loadReminders(storage);
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const existing = all[idx];
  const notifier = await getNotifier();
  const notificationId = await notifier.scheduleAt(new Date(existing.remindAt), {
    title: existing.title,
    body: existing.note ?? undefined,
    data: { reminderId: id },
  });
  const updated: Reminder = {
    ...existing,
    status: 'upcoming',
    notificationId,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  await persist(storage, all);
  return updated;
}

/** Deletes a reminder and cancels its scheduled notification, so no orphaned notification survives. */
export async function deleteReminder(id: string, storage: StorageLike = AsyncStorage): Promise<void> {
  const all = await loadReminders(storage);
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const notifier = await getNotifier();
  await notifier.cancel(all[idx].notificationId);
  all.splice(idx, 1);
  await persist(storage, all);
}
