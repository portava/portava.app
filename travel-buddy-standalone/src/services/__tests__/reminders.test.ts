/**
 * Reminders service — local repository CRUD, snooze/complete/reopen, and
 * notification-id lifecycle (schedule-on-create, cancel-on-delete/complete,
 * cancel+reschedule on edit/snooze — never an orphaned notification id).
 *
 * The real notification scheduler (safeNotifications.ts) statically imports
 * 'react-native', which cannot load under node:test — _setTestNotifier swaps
 * in an in-memory fake so this file never touches that import at all.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReminder, editReminder, snoozeReminder, completeReminder, reopenReminder,
  deleteReminder, getReminder, loadReminders, _setTestNotifier,
  type StorageLike, type NotifierLike,
} from '../reminders.ts';

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeFakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    async getItem(key) { return map.has(key) ? map.get(key)! : null; },
    async setItem(key, value) { map.set(key, value); },
    async removeItem(key) { map.delete(key); },
  };
}

function makeFakeNotifier() {
  let counter = 0;
  const scheduled = new Set<string>();
  const notifier: NotifierLike = {
    async scheduleAt(date) {
      if (date.getTime() <= Date.now()) return null;
      const id = `notif_${++counter}`;
      scheduled.add(id);
      return id;
    },
    async cancel(id) {
      if (id) scheduled.delete(id);
    },
  };
  return { notifier, scheduled };
}

const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString(); // +1h
const FUTURE_2 = new Date(Date.now() + 2 * 60 * 60_000).toISOString(); // +2h

describe('reminders service', () => {
  let storage: StorageLike;
  let fake: ReturnType<typeof makeFakeNotifier>;

  beforeEach(() => {
    storage = makeFakeStorage();
    fake = makeFakeNotifier();
    _setTestNotifier(fake.notifier);
  });

  afterEach(() => {
    _setTestNotifier(null);
  });

  it('creates a reminder, schedules one notification, and persists it', async () => {
    const r = await createReminder({
      title: 'Pack bags', remindAt: FUTURE, targetType: 'custom',
    }, storage);
    assert.equal(r.title, 'Pack bags');
    assert.equal(r.status, 'upcoming');
    assert.ok(r.notificationId);
    assert.equal(fake.scheduled.size, 1);

    const all = await loadReminders(storage);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, r.id);
  });

  it('rejects a plan_item reminder without a tripId — TripPlanItem has no standalone lookup', async () => {
    await assert.rejects(
      () => createReminder({ title: 'x', remindAt: FUTURE, targetType: 'plan_item', targetId: 'item1' }, storage),
      /tripId/,
    );
  });

  it('stores tripId for plan_item and null tripId for every other target type', async () => {
    const planItem = await createReminder({
      title: 'Dinner reservation', remindAt: FUTURE, targetType: 'plan_item', targetId: 'item1', tripId: 'trip1',
    }, storage);
    assert.equal(planItem.tripId, 'trip1');

    const trip = await createReminder({
      title: 'Trip', remindAt: FUTURE, targetType: 'trip', targetId: 'trip1',
    }, storage);
    assert.equal(trip.tripId, null);

    const custom = await createReminder({ title: 'Custom', remindAt: FUTURE, targetType: 'custom' }, storage);
    assert.equal(custom.tripId, null);
  });

  it('editReminder cancels the old notification and schedules a new one when remindAt changes', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    const oldNotifId = r.notificationId!;
    assert.ok(fake.scheduled.has(oldNotifId));

    const updated = await editReminder(r.id, { remindAt: FUTURE_2 }, storage);
    assert.ok(updated);
    assert.notEqual(updated!.notificationId, oldNotifId);
    assert.equal(fake.scheduled.has(oldNotifId), false, 'old notification must be cancelled, not orphaned');
    assert.ok(fake.scheduled.has(updated!.notificationId!));
    assert.equal(fake.scheduled.size, 1, 'exactly one live notification after edit');
  });

  it('editReminder leaves the notification alone when only title/note change', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    const oldNotifId = r.notificationId!;
    const updated = await editReminder(r.id, { title: 'y' }, storage);
    assert.equal(updated!.notificationId, oldNotifId);
    assert.equal(updated!.title, 'y');
  });

  it('snoozeReminder cancels the old notification and reschedules — no duplicate, no orphan', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    const oldNotifId = r.notificationId!;

    const snoozed = await snoozeReminder(r.id, FUTURE_2, storage);
    assert.ok(snoozed);
    assert.equal(snoozed!.status, 'upcoming');
    assert.equal(fake.scheduled.has(oldNotifId), false);
    assert.equal(fake.scheduled.size, 1);
  });

  it('completeReminder cancels the scheduled notification so a completed reminder never fires', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    const completed = await completeReminder(r.id, storage);
    assert.equal(completed!.status, 'completed');
    assert.equal(completed!.notificationId, null);
    assert.equal(fake.scheduled.size, 0);
  });

  it('reopenReminder reschedules a fresh notification for a completed reminder', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    await completeReminder(r.id, storage);
    assert.equal(fake.scheduled.size, 0);

    const reopened = await reopenReminder(r.id, storage);
    assert.equal(reopened!.status, 'upcoming');
    assert.ok(reopened!.notificationId);
    assert.equal(fake.scheduled.size, 1);
  });

  it('deleteReminder cancels the notification and removes the reminder — no orphaned notification id survives', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    await deleteReminder(r.id, storage);
    assert.equal(fake.scheduled.size, 0);
    assert.equal(await getReminder(r.id, storage), null);
    assert.equal((await loadReminders(storage)).length, 0);
  });

  it('a batch of one create + one edit + one snooze + one complete leaves exactly zero live notifications and one persisted reminder', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    await editReminder(r.id, { remindAt: FUTURE_2 }, storage);
    await snoozeReminder(r.id, FUTURE, storage);
    await completeReminder(r.id, storage);
    assert.equal(fake.scheduled.size, 0);
    assert.equal((await loadReminders(storage)).length, 1);
  });

  it('loadReminders resolves to an empty array for missing/corrupt storage instead of throwing', async () => {
    const corrupt = makeFakeStorage();
    await corrupt.setItem('@travel_buddy/reminders_v1', 'not json');
    const all = await loadReminders(corrupt);
    assert.deepEqual(all, []);
  });

  it('getReminder / edit / complete / delete on an unknown id resolve to null/no-op instead of throwing', async () => {
    assert.equal(await getReminder('missing', storage), null);
    assert.equal(await editReminder('missing', { title: 'x' }, storage), null);
    assert.equal(await completeReminder('missing', storage), null);
    assert.equal(await reopenReminder('missing', storage), null);
    await deleteReminder('missing', storage); // must not throw
  });
});
