/**
 * Return alerts at the certified RETURN_SOON / RETURN_NOW instants — census
 * layover L41 / L18 / L99 / L272, built to the lead's 2026-10-06 ruling on
 * LAYOVER_RETURN_REMINDER_DELIVERY (scheduled on the phone, rescheduled on a
 * material move, never behind a permission the traveller has not given, a
 * denial shown honestly).
 *
 * Every case drives `syncReturnAlerts` with an injected notifier and store and
 * asserts what is SCHEDULED and STORED afterwards, not just the return value.
 * The notifier offers no way to request a permission at all, so "never asks"
 * is structural here; the cases assert nothing is scheduled without one.
 */
import {
  ALERT_MATERIAL_DRIFT_MIN,
  RETURN_SOON_LEAD_MIN,
  cancelReturnAlerts,
  describeReturnAlerts,
  planReturnAlerts,
  returnAlertsKey,
  syncReturnAlerts,
  type ReturnAlertDeps,
} from '../layoverReturnAlerts.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-06T10:00:00.000Z');
const DEADLINE = new Date(NOW + 3 * 60 * MIN).toISOString(); // 13:00Z

function fakeDeps(perms: { granted?: boolean; status?: string }, opts: { failOn?: number } = {}) {
  const store = new Map<string, string>();
  const scheduled = new Map<string, { at: string; title: string; body: string }>();
  const cancelled: string[] = [];
  let n = 0;
  const deps: ReturnAlertDeps = {
    getPermissions: async () => perms,
    schedule: async (at, content) => {
      n += 1;
      if (opts.failOn === n) return null;
      const id = `notif-${n}`;
      scheduled.set(id, { at: at.toISOString(), title: content.title, body: content.body });
      return id;
    },
    cancel: async (id) => { cancelled.push(id); scheduled.delete(id); },
    read: async (k) => store.get(k) ?? null,
    write: async (k, v) => { store.set(k, v); },
    remove: async (k) => { store.delete(k); },
  };
  return { deps, store, scheduled, cancelled };
}

const plan = (deadline = DEADLINE, nowMs = NOW) =>
  planReturnAlerts({ sessionId: 's1', hardReturnTime: deadline, hardReturnLocal: '21:00', airportCode: 'TPE', nowMs });

describe('planReturnAlerts — the two §15 instants, from the certified deadline only', () => {
  it('RETURN_SOON at deadline − 30 min and RETURN_NOW at the deadline', () => {
    const p = plan();
    expect(p.alerts.map((a) => a.rung)).toEqual(['RETURN_SOON', 'RETURN_NOW']);
    expect(p.alerts[0]!.at).toBe(new Date(Date.parse(DEADLINE) - RETURN_SOON_LEAD_MIN * MIN).toISOString());
    expect(p.alerts[1]!.at).toBe(DEADLINE);
    expect(p.alerts[1]!.title).toBe('Head back to TPE now');
    expect(p.alerts[0]!.body).toContain('by 21:00');
  });

  it('an instant already past is not planned', () => {
    const p = plan(DEADLINE, Date.parse(DEADLINE) - 10 * MIN);
    expect(p.alerts.map((a) => a.rung)).toEqual(['RETURN_NOW']);
    expect(plan(DEADLINE, Date.parse(DEADLINE) + MIN).alerts).toEqual([]);
  });

  it('an unreadable deadline plans nothing rather than a guessed time', () => {
    expect(plan('not a date').alerts).toEqual([]);
  });
});

describe('syncReturnAlerts — what the phone ends up holding', () => {
  it('with permission granted, both alerts are scheduled at the certified instants and stored', async () => {
    const f = fakeDeps({ granted: true });
    const status = await syncReturnAlerts(plan(), f.deps);
    expect(status).toEqual({ state: 'scheduled', alerts: plan().alerts.map((a) => ({ rung: a.rung, at: a.at })), rescheduled: false });
    expect([...f.scheduled.values()].map((s) => s.at)).toEqual(plan().alerts.map((a) => a.at));
    const stored = JSON.parse(f.store.get(returnAlertsKey('s1'))!);
    expect(stored.ids).toEqual(['notif-1', 'notif-2']);
    expect(stored.hardReturnTime).toBe(DEADLINE);
  });

  it('with permission NOT yet given, nothing is scheduled and the screen is told nobody has asked', async () => {
    const f = fakeDeps({ granted: false, status: 'undetermined' });
    expect(await syncReturnAlerts(plan(), f.deps)).toEqual({ state: 'permission_not_asked' });
    expect(f.scheduled.size).toBe(0);
    expect(f.store.size).toBe(0);
  });

  it('a DENIED permission is reported as denied, and nothing is scheduled', async () => {
    const f = fakeDeps({ granted: false, status: 'denied' });
    expect(await syncReturnAlerts(plan(), f.deps)).toEqual({ state: 'permission_denied' });
    expect(f.scheduled.size).toBe(0);
  });

  it('a permission read that throws is treated as not given — never as granted', async () => {
    const f = fakeDeps({ granted: true });
    f.deps.getPermissions = async () => { throw new Error('native module missing'); };
    expect(await syncReturnAlerts(plan(), f.deps)).toEqual({ state: 'permission_not_asked' });
    expect(f.scheduled.size).toBe(0);
  });

  it(`a deadline that moved by less than ${ALERT_MATERIAL_DRIFT_MIN} min keeps what is scheduled`, async () => {
    const f = fakeDeps({ granted: true });
    await syncReturnAlerts(plan(), f.deps);
    const moved = new Date(Date.parse(DEADLINE) - 3 * MIN).toISOString();
    const status = await syncReturnAlerts(plan(moved), f.deps);
    expect(status.state).toBe('scheduled');
    expect(status.state === 'scheduled' && status.rescheduled).toBe(false);
    expect(f.cancelled).toEqual([]);
    expect(f.scheduled.size).toBe(2);
  });

  it('a MATERIAL move cancels both old alerts and schedules them at the new instants', async () => {
    const f = fakeDeps({ granted: true });
    await syncReturnAlerts(plan(), f.deps);
    const earlier = new Date(Date.parse(DEADLINE) - 15 * MIN).toISOString();
    const status = await syncReturnAlerts(plan(earlier), f.deps);
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
    expect([...f.scheduled.values()].map((s) => s.at)).toEqual(plan(earlier).alerts.map((a) => a.at));
    expect(status.state === 'scheduled' && status.rescheduled).toBe(true);
    expect(JSON.parse(f.store.get(returnAlertsKey('s1'))!).hardReturnTime).toBe(earlier);
  });

  it('a later mount can cancel what an earlier one scheduled (the ids are stored, not held in memory)', async () => {
    const f = fakeDeps({ granted: true });
    await syncReturnAlerts(plan(), f.deps);
    await cancelReturnAlerts('s1', f.deps);
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
    expect(f.scheduled.size).toBe(0);
    expect(f.store.has(returnAlertsKey('s1'))).toBe(false);
  });

  it('a schedule the device refuses is UNAVAILABLE, never half "on" — the one that did schedule is undone', async () => {
    const f = fakeDeps({ granted: true }, { failOn: 2 });
    expect(await syncReturnAlerts(plan(), f.deps)).toEqual({ state: 'unavailable' });
    expect(f.cancelled).toEqual(['notif-1']);
    expect(f.scheduled.size).toBe(0);
    expect(f.store.size).toBe(0);
  });

  it('once the deadline has passed, stored alerts are cancelled and nothing new is set', async () => {
    const f = fakeDeps({ granted: true });
    await syncReturnAlerts(plan(), f.deps);
    const status = await syncReturnAlerts(plan(DEADLINE, Date.parse(DEADLINE) + MIN), f.deps);
    expect(status).toEqual({ state: 'nothing_to_schedule' });
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
    expect(f.store.size).toBe(0);
  });
});

describe('describeReturnAlerts — the sentence never claims "on" without a schedule', () => {
  const fmt = (iso: string) => iso.slice(11, 16);
  it('scheduled names both times', () => {
    const text = describeReturnAlerts({ state: 'scheduled', rescheduled: false, alerts: plan().alerts.map((a) => ({ rung: a.rung, at: a.at })) }, fmt);
    expect(text).toBe('Return alerts on: 12:30 (head back soon) and 13:00 (head back now).');
  });
  it('a denial says notifications are not allowed', () => {
    expect(describeReturnAlerts({ state: 'permission_denied' }, fmt)).toMatch(/not allowed/);
  });
  it('unavailable and not-asked both say the alerts are not on', () => {
    expect(describeReturnAlerts({ state: 'unavailable' }, fmt)).toMatch(/could not be set/);
    expect(describeReturnAlerts({ state: 'permission_not_asked' }, fmt)).toMatch(/^Return alerts are off/);
  });
});
