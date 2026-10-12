/**
 * OD-1012-LAY-1 (owner, 2026-10-12): "prioritize actionable return warnings,
 * notify when the required action changes, and suppress duplicates. Do not
 * suppress an essential return warning merely because its scheduled time is
 * unchanged." — and OD-1012-LAY-4 on time-sensitive delivery.
 *
 * On the phone, "suppress duplicates" is `syncReturnAlerts` KEEPING a stored
 * schedule when the certified deadline has not moved materially. On main
 * (2c3323167) it kept it on the strength of its own AsyncStorage record alone:
 * an alert the OS no longer held (notifications cleared, an app restored from a
 * backup with its storage, another caller's cancel-all) was "kept" forever and
 * never fired — an essential warning suppressed only because its time was
 * unchanged. And RETURN_SOON, which asks the traveller to act, kept the
 * platform's default delivery.
 */
import {
  LAYOVER_RETURN_CHANNEL_ID,
  planReturnAlerts,
  syncReturnAlerts,
  type ReturnAlertDeps,
  type ReturnAlertPolicyWire,
} from '../layoverReturnAlerts.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const DEADLINE = new Date(NOW + 3 * 60 * MIN).toISOString();
const POLICY: ReturnAlertPolicyWire = {
  materialDriftMinutes: 5,
  rungs: { RETURN_SOON: { level: 1, priority: 'important' }, RETURN_NOW: { level: 2, priority: 'urgent' } },
};

type Held = 'os' | 'null' | 'throws' | 'absent';
function fakeDeps(held: Held = 'os', timeSensitive = false) {
  const store = new Map<string, string>();
  const osHeld = new Map<string, { at: string; title: string; delivery: unknown }>();
  const scheduleCalls: Array<{ at: string; title: string; delivery: unknown }> = [];
  const cancelled: string[] = [];
  let n = 0;
  const deps: ReturnAlertDeps = {
    getPermissions: async () => ({ granted: true, status: 'granted' }),
    schedule: async (at, content, delivery) => {
      n += 1;
      const id = `notif-${n}`;
      const c = { at: at.toISOString(), title: content.title, delivery };
      scheduleCalls.push(c);
      osHeld.set(id, c);
      return id;
    },
    ensureUrgentChannel: async () => true,
    timeSensitiveAvailable: () => timeSensitive,
    cancel: async (id) => { cancelled.push(id); osHeld.delete(id); },
    read: async (k) => store.get(k) ?? null,
    write: async (k, v) => { store.set(k, v); },
    remove: async (k) => { store.delete(k); },
  };
  if (held === 'os') deps.scheduledIds = async () => new Set(osHeld.keys());
  if (held === 'null') deps.scheduledIds = async () => null;
  if (held === 'throws') deps.scheduledIds = async () => { throw new Error('native module gone'); };
  return { deps, osHeld, scheduleCalls, cancelled };
}

const plan = (deadline = DEADLINE, policy: ReturnAlertPolicyWire | null = POLICY) =>
  planReturnAlerts({ sessionId: 's1', hardReturnTime: deadline, hardReturnLocal: '21:00', airportCode: 'TPE', nowMs: NOW, policy });

describe('duplicates are suppressed — but only what the phone really still holds', () => {
  it('an EXACT duplicate (same rungs, same session, same deadline, both still held by the OS) is kept: nothing cancelled, nothing re-raised', async () => {
    const f = fakeDeps('os');
    await syncReturnAlerts(plan(), f.deps);
    const again = await syncReturnAlerts(plan(), f.deps);
    expect(again.state === 'scheduled' && again.rescheduled).toBe(false);
    expect(f.scheduleCalls).toHaveLength(2);
    expect(f.cancelled).toEqual([]);
  });

  it('a schedule the OS LOST is put back even though its time is unchanged (the essential "leave now" included)', async () => {
    const f = fakeDeps('os');
    await syncReturnAlerts(plan(), f.deps);
    f.osHeld.delete('notif-2'); // the OS dropped "head back now"; our storage still lists it
    const again = await syncReturnAlerts(plan(), f.deps);
    expect(again.state === 'scheduled' && again.rescheduled).toBe(true);
    expect(f.scheduleCalls.map((c) => c.title)).toEqual(['Head back to TPE soon', 'Head back to TPE now', 'Head back to TPE soon', 'Head back to TPE now']);
    expect(f.scheduleCalls[3]!.at).toBe(DEADLINE);
    // Re-raising cancels first, so the traveller can never get two of the same alert.
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
    expect([...f.osHeld.keys()]).toEqual(['notif-3', 'notif-4']);
  });

  it.each(['null', 'throws', 'absent'] as const)('a device that cannot say what it holds (%s) is not trusted: the alerts are put back', async (held) => {
    const f = fakeDeps(held);
    await syncReturnAlerts(plan(), f.deps);
    const again = await syncReturnAlerts(plan(), f.deps);
    expect(again.state === 'scheduled' && again.rescheduled).toBe(true);
    expect(f.scheduleCalls).toHaveLength(4);
    expect(f.osHeld.size).toBe(2);
  });

  it('only the TIME moved, below the server threshold, and the OS still holds both: no change (not a notification, not a reschedule)', async () => {
    const f = fakeDeps('os');
    await syncReturnAlerts(plan(), f.deps);
    const moved = await syncReturnAlerts(plan(new Date(Date.parse(DEADLINE) - 3 * MIN).toISOString()), f.deps);
    expect(moved.state === 'scheduled' && moved.rescheduled).toBe(false);
    expect(f.scheduleCalls).toHaveLength(2);
  });
});

describe('actionable warnings are prioritized (OD-1012-LAY-1) and time-sensitive only where the build can be (OD-1012-LAY-4)', () => {
  it('both rungs go out on layover_return: RETURN_SOON at high, RETURN_NOW at max — with or without a server policy', async () => {
    for (const policy of [POLICY, null]) {
      const f = fakeDeps('os');
      await syncReturnAlerts(plan(DEADLINE, policy), f.deps);
      expect(f.scheduleCalls.map((c) => c.delivery)).toEqual([
        { channelId: LAYOVER_RETURN_CHANNEL_ID, priority: 'high' },
        { channelId: LAYOVER_RETURN_CHANNEL_ID, priority: 'max' },
      ]);
    }
  });

  it('an actionable alert alone (no urgent one in the plan) still creates the channel and names it', async () => {
    const f = fakeDeps('os');
    let created = 0;
    f.deps.ensureUrgentChannel = async () => { created += 1; return true; };
    await syncReturnAlerts(plan(DEADLINE, { ...POLICY, rungs: { ...POLICY.rungs, RETURN_NOW: { level: 2, priority: 'normal' } } }), f.deps);
    expect(created).toBe(1);
    expect(f.scheduleCalls[0]!.delivery).toEqual({ channelId: LAYOVER_RETURN_CHANNEL_ID, priority: 'high' });
  });

  it('with the entitlement, both are time-sensitive; without it, both go at the normal level', async () => {
    const on = fakeDeps('os', true);
    await syncReturnAlerts(plan(), on.deps);
    expect(on.scheduleCalls.every((c) => (c.delivery as { interruptionLevel?: string }).interruptionLevel === 'timeSensitive')).toBe(true);
    const off = fakeDeps('os', false);
    await syncReturnAlerts(plan(), off.deps);
    expect(off.scheduleCalls.some((c) => 'interruptionLevel' in (c.delivery as object))).toBe(false);
  });

  it('an alert stored at the old default loudness (RETURN_SOON before this ruling) is upgraded once', async () => {
    const f = fakeDeps('os');
    await syncReturnAlerts(plan(DEADLINE, { ...POLICY, rungs: { ...POLICY.rungs, RETURN_SOON: { level: 1, priority: 'normal' } } }), f.deps);
    expect(f.scheduleCalls[0]!.delivery).toBeUndefined();
    const up = await syncReturnAlerts(plan(), f.deps);
    expect(up.state === 'scheduled' && up.rescheduled).toBe(true);
    expect(f.scheduleCalls[2]!.delivery).toEqual({ channelId: LAYOVER_RETURN_CHANNEL_ID, priority: 'high' });
  });
});
