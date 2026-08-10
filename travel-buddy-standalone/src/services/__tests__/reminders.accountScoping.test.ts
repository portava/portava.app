/**
 * Account-scoped storage tests for reminders.ts — read isolation between two
 * accounts, one-time legacy migration (including notification cancellation),
 * and the flag-OFF path staying byte-identical to pre-existing behavior.
 *
 * See src/config/accountScopedStorageFlag.ts — the flag ships OFF by
 * default; these tests force it on via the test seam to exercise the new
 * code paths without touching the default runtime behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReminder, loadReminders, deleteReminder, REMINDERS_STORAGE_KEY,
  _setTestNotifier, _resetMigratedRemindersAccountIds,
  type StorageLike, type NotifierLike, type Reminder,
} from '../reminders.ts';
import { _setTestAccountScopedStorageFlag } from '../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../accountId.ts';

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

const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();

describe('reminders — account-scoped storage (flag on)', () => {
  let storage: StorageLike;
  let fake: ReturnType<typeof makeFakeNotifier>;

  beforeEach(() => {
    storage = makeFakeStorage();
    fake = makeFakeNotifier();
    _setTestNotifier(fake.notifier);
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedRemindersAccountIds();
  });

  afterEach(() => {
    _setTestNotifier(null);
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('read isolation: account A never sees account B\'s reminders', async () => {
    _setTestAccountId('user-a');
    await createReminder({ title: 'A-only', remindAt: FUTURE, targetType: 'custom' }, storage);

    _setTestAccountId('user-b');
    await createReminder({ title: 'B-only', remindAt: FUTURE, targetType: 'custom' }, storage);

    const bList = await loadReminders(storage);
    assert.equal(bList.length, 1);
    assert.equal(bList[0].title, 'B-only');

    _setTestAccountId('user-a');
    const aList = await loadReminders(storage);
    assert.equal(aList.length, 1);
    assert.equal(aList[0].title, 'A-only');
  });

  it('createReminder throws instead of writing when no account is resolvable (never falls back to the legacy key)', async () => {
    _setTestAccountId(null);
    await assert.rejects(
      () => createReminder({ title: 'orphan', remindAt: FUTURE, targetType: 'custom' }, storage),
      /no account is signed in/,
    );
    // Nothing should have leaked into the legacy key either.
    const legacyRaw = await storage.getItem(REMINDERS_STORAGE_KEY);
    assert.equal(legacyRaw, null);
  });

  it('loadReminders resolves to [] (not the legacy list) when no account is resolvable', async () => {
    // Seed the legacy key directly, as if written pre-upgrade.
    const legacy: Reminder[] = [{
      id: 'r1', title: 'legacy', note: null, remindAt: FUTURE, targetType: 'custom',
      targetId: null, tripId: null, targetLabel: null, status: 'upcoming',
      notificationId: null, createdAt: FUTURE, updatedAt: FUTURE,
    }];
    await storage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(legacy));

    _setTestAccountId(null);
    const list = await loadReminders(storage);
    assert.deepEqual(list, []);
  });

  it('migrates the legacy blob to the signed-in account on first access, cancels its notifications, and deletes the legacy key', async () => {
    const legacyNotifId = 'legacy-notif-1';
    fake.scheduled.add(legacyNotifId); // simulate a notification scheduled before migration
    const legacy: Reminder[] = [{
      id: 'r1', title: 'legacy reminder', note: null, remindAt: FUTURE, targetType: 'custom',
      targetId: null, tripId: null, targetLabel: null, status: 'upcoming',
      notificationId: legacyNotifId, createdAt: FUTURE, updatedAt: FUTURE,
    }];
    await storage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(legacy));

    _setTestAccountId('user-a');
    const migrated = await loadReminders(storage);

    assert.equal(migrated.length, 1, 'migrated reminder must be visible to the attributed account');
    assert.equal(migrated[0].title, 'legacy reminder');
    assert.equal(migrated[0].notificationId, null, 'notificationId must be nulled out post-migration');

    assert.equal(await storage.getItem(REMINDERS_STORAGE_KEY), null, 'legacy key must be deleted after migration');
    assert.equal(fake.scheduled.has(legacyNotifId), false, 'the legacy scheduled notification must be cancelled during migration');
  });

  it('migration is idempotent — running it twice does not duplicate or re-migrate', async () => {
    const legacy: Reminder[] = [{
      id: 'r1', title: 'legacy', note: null, remindAt: FUTURE, targetType: 'custom',
      targetId: null, tripId: null, targetLabel: null, status: 'upcoming',
      notificationId: null, createdAt: FUTURE, updatedAt: FUTURE,
    }];
    await storage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(legacy));

    _setTestAccountId('user-a');
    const first = await loadReminders(storage);
    assert.equal(first.length, 1);

    // Create a second reminder for the same account after migration.
    await createReminder({ title: 'new one', remindAt: FUTURE, targetType: 'custom' }, storage);

    const second = await loadReminders(storage);
    assert.equal(second.length, 2, 'migrated reminder + newly created one, no duplication');
  });

  it('a wrongly-attributed migration does not resurrect a live notification for the new owner', async () => {
    // Simulates: device previously used by user-a, now user-b signs in first
    // post-upgrade. The migration attributes the blob to user-b (best guess)
    // but must still cancel the OS notification so user-b never receives a
    // notification for a reminder they have no context for.
    const legacyNotifId = 'notif-from-user-a';
    fake.scheduled.add(legacyNotifId);
    const legacy: Reminder[] = [{
      id: 'r1', title: 'was actually user-a\'s reminder', note: null, remindAt: FUTURE, targetType: 'custom',
      targetId: null, tripId: null, targetLabel: null, status: 'upcoming',
      notificationId: legacyNotifId, createdAt: FUTURE, updatedAt: FUTURE,
    }];
    await storage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(legacy));

    _setTestAccountId('user-b');
    await loadReminders(storage);

    assert.equal(fake.scheduled.size, 0, 'no live notification should survive migration regardless of attribution correctness');
  });
});

describe('reminders — flag OFF is byte-identical to legacy behavior', () => {
  let storage: StorageLike;
  let fake: ReturnType<typeof makeFakeNotifier>;

  beforeEach(() => {
    storage = makeFakeStorage();
    fake = makeFakeNotifier();
    _setTestNotifier(fake.notifier);
    _setTestAccountScopedStorageFlag(false);
    _setTestAccountId(null); // even with no session, flag-off must ignore account resolution entirely
  });

  afterEach(() => {
    _setTestNotifier(null);
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('reads and writes the legacy unscoped key regardless of account id / session state', async () => {
    const r = await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    assert.ok(r.id);

    const raw = await storage.getItem(REMINDERS_STORAGE_KEY);
    assert.ok(raw, 'legacy key must be written to even though _setTestAccountId(null) simulates no session');

    const all = await loadReminders(storage);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, r.id);

    await deleteReminder(r.id, storage);
    assert.deepEqual(await loadReminders(storage), []);
  });

  it('never creates a scoped key when the flag is off', async () => {
    await createReminder({ title: 'x', remindAt: FUTURE, targetType: 'custom' }, storage);
    // Scoped keys are namespaced with ':' + accountId; since no account was
    // ever consulted, no such key can exist.
    const raw = await storage.getItem('@travel_buddy/reminders_scoped_v1:user-a');
    assert.equal(raw, null);
  });

  it('pre-existing legacy data is untouched (no migration attempt) and its live notification survives', async () => {
    const preExistingNotifId = 'pre-existing-live-notification';
    fake.scheduled.add(preExistingNotifId);
    const preUpgrade: Reminder[] = [{
      id: 'r1', title: 'was already there pre-upgrade', note: null, remindAt: FUTURE, targetType: 'custom',
      targetId: null, tripId: null, targetLabel: null, status: 'upcoming',
      notificationId: preExistingNotifId, createdAt: FUTURE, updatedAt: FUTURE,
    }];
    const preRaw = JSON.stringify(preUpgrade);
    await storage.setItem(REMINDERS_STORAGE_KEY, preRaw);

    // Exercise every read/write path a real app run would hit, with the
    // flag off and no simulated session — this is the exact runtime
    // condition the flag ships in today.
    const list = await loadReminders(storage);
    await createReminder({ title: 'newly added', remindAt: FUTURE, targetType: 'custom' }, storage);

    assert.equal(list.length, 1, 'loadReminders must return the pre-existing reminder unchanged');
    assert.equal(list[0].notificationId, preExistingNotifId, 'notificationId must NOT be nulled — that only happens during migration');
    assert.ok(
      fake.scheduled.has(preExistingNotifId),
      'CRITICAL: a real, live OS notification scheduled before this ran must still be scheduled after — migration must never fire with the flag off',
    );
    assert.equal(
      await storage.getItem('@travel_buddy/reminders_scoped_v1:user-a'),
      null,
      'no scoped key may exist — this data is not "unmigrated pending", it was never a migration candidate',
    );
    // The legacy key itself: still present, and the original entry still
    // byte-identical within it (a second reminder was appended alongside).
    const finalRaw = await storage.getItem(REMINDERS_STORAGE_KEY);
    assert.ok(finalRaw, 'legacy key must still exist');
    const finalParsed: Reminder[] = JSON.parse(finalRaw!);
    const original = finalParsed.find((r) => r.id === 'r1');
    assert.deepEqual(original, preUpgrade[0], 'the pre-existing entry must be byte-identical to what was written before this ran');
  });
});
