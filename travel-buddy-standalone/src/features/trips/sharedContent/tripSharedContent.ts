/**
 * TRIP-F24 — the trip's shared contents on the client (WP-10): documents,
 * notes, checklists, trip reminders and the activity feed.
 *
 * WHERE THE WRITES GO, AND WHY NOT THE KERNEL
 * ==========================================
 * These are the routes in routes/trips-expansion.ts over the 0079 sub-tables.
 * The kernel's command union carries no family for any of them (census-trips
 * TR378, §75.6: "new kernel command families for trip_checklists, trip_notes,
 * trip_documents, … trip_reminders" is the open work), so the route IS the
 * architecture's write path for them today, with its own §6.1 policy checks
 * (canAccessTripContent, canEditOwnOrAsOwner, canSeePrivateContributions).
 * This client calls exactly those routes and writes nothing else.
 *
 * DOCUMENTS ARE TEXT
 * ==================
 * `trip_documents` holds a title, a type and a text body; there is no file
 * column. A "ticket PDF" is therefore recorded as its reference text (booking
 * code, flight, seat) — attaching the file itself needs a storage column and
 * is out of this package (census-trips §77, WP10-D5).
 *
 * TRIP REMINDERS (WP10-D4)
 * ========================
 * `trip_reminders` rows belong to the member who set them (the route reads and
 * deletes only the caller's own), so they follow the account across devices
 * — the device-only list in services/reminders.ts cannot. Nothing on the
 * server delivers them (no worker reads `trip_reminders`), so the device that
 * SETS a reminder schedules its local alert, remembers the notification id
 * against the server row, and cancels it when the reminder is deleted there.
 * The card says so: a reminder set on another device shows in the list but
 * rings only where it was set.
 */
import { readTripJson, sendTripWrite, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';

// ── documents ───────────────────────────────────────────────────────────────

export const DOCUMENT_TYPES = ['note', 'itinerary', 'packing_list', 'visa', 'insurance', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  note: 'Note', itinerary: 'Ticket / itinerary', packing_list: 'Packing list', visa: 'Visa', insurance: 'Insurance', other: 'Other',
};

export interface TripDocument {
  id: string; title: string; document_type: string; is_private: boolean;
  creator_id: string | null; created_at: string; updated_at: string | null;
  /** Only on the by-id read. */
  content?: string | null;
}

export async function fetchDocuments(tripId: string): Promise<ApiRead<TripDocument[]>> {
  const r = await readTripJson<{ documents: TripDocument[] }>(`/api/trips/${tripId}/documents`, (b) => Array.isArray(b?.documents));
  return r.state === 'ok' ? { state: 'ok', data: r.data.documents } : r;
}

export function fetchDocument(tripId: string, docId: string): Promise<ApiRead<TripDocument>> {
  return readTripJson<TripDocument>(`/api/trips/${tripId}/documents/${docId}`, (b) => typeof b?.id === 'string' && typeof b?.title === 'string');
}

export function createDocument(tripId: string, d: { title: string; content: string | null; documentType: DocumentType; isPrivate: boolean }): Promise<ApiWrite<TripDocument>> {
  return sendTripWrite<TripDocument>('POST', `/api/trips/${tripId}/documents`, {
    title: d.title, ...(d.content ? { content: d.content } : {}), documentType: d.documentType, isPrivate: d.isPrivate,
  });
}

export function deleteDocument(tripId: string, docId: string): Promise<ApiWrite<null>> {
  return sendTripWrite<null>('DELETE', `/api/trips/${tripId}/documents/${docId}`);
}

// ── notes ───────────────────────────────────────────────────────────────────

export interface TripNote {
  id: string; title: string | null; content: string; is_private: boolean;
  author_id: string | null; created_at: string; updated_at?: string | null;
}

export async function fetchNotes(tripId: string): Promise<ApiRead<TripNote[]>> {
  const r = await readTripJson<{ notes: TripNote[] }>(`/api/trips/${tripId}/notes`, (b) => Array.isArray(b?.notes));
  return r.state === 'ok' ? { state: 'ok', data: r.data.notes } : r;
}

export function createNote(tripId: string, n: { title: string | null; content: string; isPrivate: boolean }): Promise<ApiWrite<TripNote>> {
  return sendTripWrite<TripNote>('POST', `/api/trips/${tripId}/notes`, {
    ...(n.title ? { title: n.title } : {}), content: n.content, isPrivate: n.isPrivate,
  });
}

export function deleteNote(tripId: string, noteId: string): Promise<ApiWrite<null>> {
  return sendTripWrite<null>('DELETE', `/api/trips/${tripId}/notes/${noteId}`);
}

// ── checklists ──────────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string; checklist_id?: string; label: string; is_done: boolean;
  assigned_to: string | null; due_date: string | null; sort_order: number;
}
export interface Checklist { id: string; title: string; createdBy: string | null; createdAt: string; items: ChecklistItem[] }

export async function fetchChecklists(tripId: string): Promise<ApiRead<Checklist[]>> {
  const r = await readTripJson<{ checklists: Checklist[] }>(
    `/api/trips/${tripId}/checklists`,
    (b) => Array.isArray(b?.checklists) && b.checklists.every((c: any) => c && Array.isArray(c.items)),
  );
  return r.state === 'ok' ? { state: 'ok', data: r.data.checklists } : r;
}

export function checklistProgress(c: Checklist): string {
  return `${c.items.filter((i) => i.is_done).length} of ${c.items.length} done`;
}

export function createChecklist(tripId: string, title: string): Promise<ApiWrite<Checklist>> {
  return sendTripWrite<Checklist>('POST', `/api/trips/${tripId}/checklists`, { title });
}

export function addChecklistItem(tripId: string, checklistId: string, label: string, sortOrder: number): Promise<ApiWrite<ChecklistItem>> {
  return sendTripWrite<ChecklistItem>('POST', `/api/trips/${tripId}/checklists/${checklistId}/items`, { label, sortOrder });
}

export function setChecklistItemDone(tripId: string, checklistId: string, itemId: string, isDone: boolean): Promise<ApiWrite<ChecklistItem>> {
  return sendTripWrite<ChecklistItem>('PATCH', `/api/trips/${tripId}/checklists/${checklistId}/items/${itemId}`, { isDone });
}

// ── trip reminders ──────────────────────────────────────────────────────────

export interface TripReminder { id: string; title: string; remind_at: string; is_sent: boolean; created_at: string }

/** The alert + storage surface this needs; production loads it lazily. */
export interface AlertsLike {
  scheduleAt(date: Date, content: { title: string; body?: string; data?: Record<string, unknown> }): Promise<string | null>;
  cancel(id: string | null | undefined): Promise<void>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
let _testAlerts: AlertsLike | null = null;
/** Test seam: replace notifications + storage; null restores. */
export function _setTestAlerts(a: AlertsLike | null): void { _testAlerts = a; }

async function alerts(): Promise<AlertsLike> {
  if (_testAlerts) return _testAlerts;
  const [n, s] = await Promise.all([
    import('../../../lib/safeNotifications.ts'),
    import('@react-native-async-storage/async-storage'),
  ]);
  const storage = s.default;
  return {
    scheduleAt: n.scheduleLocalNotificationAt,
    cancel: n.cancelScheduledNotification,
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => storage.setItem(k, v),
  };
}

const ALERTS_KEY = '@travel_buddy/trip_reminder_alerts_v1';

async function readAlertMap(a: AlertsLike): Promise<Record<string, string>> {
  try {
    const raw = await a.getItem(ALERTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export async function fetchTripReminders(tripId: string): Promise<ApiRead<TripReminder[]>> {
  const r = await readTripJson<{ reminders: TripReminder[] }>(`/api/trips/${tripId}/reminders`, (b) => Array.isArray(b?.reminders));
  return r.state === 'ok' ? { state: 'ok', data: r.data.reminders } : r;
}

/** Whether THIS device holds the alert for a reminder. */
export async function reminderAlertsHere(): Promise<Set<string>> {
  return new Set(Object.keys(await readAlertMap(await alerts())));
}

export async function createTripReminder(tripId: string, title: string, remindAt: string): Promise<ApiWrite<TripReminder>> {
  const w = await sendTripWrite<TripReminder>('POST', `/api/trips/${tripId}/reminders`, { title, remindAt });
  if (w.state !== 'done' || !w.data?.id) return w;
  // The row is saved; the alert is this device's. A failure to schedule does
  // not unsave it — the card shows which reminders ring here.
  try {
    const a = await alerts();
    const notificationId = await a.scheduleAt(new Date(w.data.remind_at ?? remindAt), { title, data: { tripId, tripReminderId: w.data.id } });
    if (notificationId) {
      const map = await readAlertMap(a);
      map[w.data.id] = notificationId;
      await a.setItem(ALERTS_KEY, JSON.stringify(map));
    }
  } catch { /* alert not scheduled; the reminder is still saved */ }
  return w;
}

export async function deleteTripReminder(tripId: string, reminderId: string): Promise<ApiWrite<null>> {
  const w = await sendTripWrite<null>('DELETE', `/api/trips/${tripId}/reminders/${reminderId}`);
  if (w.state !== 'done') return w;
  try {
    const a = await alerts();
    const map = await readAlertMap(a);
    if (map[reminderId]) {
      await a.cancel(map[reminderId]);
      delete map[reminderId];
      await a.setItem(ALERTS_KEY, JSON.stringify(map));
    }
  } catch { /* nothing scheduled here */ }
  return w;
}

// ── activity ────────────────────────────────────────────────────────────────

export interface TripActivity { id: string; actor_id: string | null; event_type: string; metadata: unknown; created_at: string }

/** Host-only on the server (canHostTrip). A 403 comes back as `unavailable` with status 403. */
export async function fetchActivity(tripId: string, limit = 50): Promise<ApiRead<TripActivity[]>> {
  const r = await readTripJson<{ activity: TripActivity[] }>(`/api/trips/${tripId}/activity?limit=${limit}`, (b) => Array.isArray(b?.activity));
  return r.state === 'ok' ? { state: 'ok', data: r.data.activity } : r;
}

const ACTIVITY_TEXT: Record<string, string> = {
  trip_updated: 'The trip was edited',
  trip_cancelled: 'The trip was cancelled',
  trip_completed: 'The trip was completed',
  trip_archived: 'The trip was archived',
  trip_deleted: 'The trip was deleted',
  join_request_created: 'Someone asked to join',
  join_request_approved: 'A join request was approved',
  join_request_declined: 'A join request was declined',
  joined_via_invite_link: 'Someone joined with an invite link',
  destination_added: 'A destination was added',
  destination_removed: 'A destination was removed',
};

/** An unknown event type is shown as its words, never dropped. */
export function activityText(a: TripActivity): string {
  return ACTIVITY_TEXT[a.event_type] ?? a.event_type.replace(/_/g, ' ');
}
