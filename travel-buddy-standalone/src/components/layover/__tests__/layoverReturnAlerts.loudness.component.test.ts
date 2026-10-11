/**
 * Return alerts are as loud as the server's §15 ladder says, and are moved only
 * when the server's materiality threshold says the move matters — wave W,
 * census-layover L18 / L41 / L99 (recon cluster A1).
 *
 * The defect this holds shut: the server publishes each rung's priority
 * (`LayoverReturnEscalation.ts#returnNotificationPosture`), but the phone
 * scheduled RETURN_SOON and RETURN_NOW with no priority and no channel, so both
 * landed on expo's fallback channel alike and "leave now" could not differ
 * from "start wrapping up". It also rescheduled on a hard-coded copy of
 * the server's 5-minute threshold.
 *
 * Every case drives `syncReturnAlerts` with an injected notifier and asserts
 * the DELIVERY each scheduled alert asked for, not just the return value.
 */
import { AndroidImportance, type NotificationChannelInput } from 'expo-notifications/build/NotificationChannelManager.types';
import {
  ALERT_MATERIAL_DRIFT_MIN,
  LAYOVER_RETURN_CHANNEL,
  LAYOVER_RETURN_CHANNEL_ID,
  alertDelivery,
  alertLoudness,
  alertMaterialDriftMin,
  planReturnAlerts,
  returnAlertsKey,
  syncReturnAlerts,
  type ReturnAlertDeps,
  type ReturnAlertPolicyWire,
} from '../layoverReturnAlerts.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const DEADLINE = new Date(NOW + 3 * 60 * MIN).toISOString();

/** The server's ladder as `returnAlertPolicy()` publishes it today. */
function serverPolicy(over: { soon?: string; now?: string; drift?: unknown } = {}): ReturnAlertPolicyWire {
  return {
    materialDriftMinutes: 'drift' in over ? over.drift : 5,
    rungs: {
      RETURN_SOON: { level: 1, priority: over.soon ?? 'important' },
      RETURN_NOW: { level: 2, priority: over.now ?? 'urgent' },
    },
  };
}

type Call = { at: string; title: string; delivery: unknown; argc: number };

function fakeDeps(opts: { channel?: boolean | 'throws' | 'absent'; timeSensitive?: boolean } = {}) {
  const store = new Map<string, string>();
  const scheduled = new Map<string, Call>();
  const calls: Call[] = [];
  const cancelled: string[] = [];
  const order: string[] = [];
  let n = 0;
  const deps: ReturnAlertDeps = {
    getPermissions: async () => ({ granted: true, status: 'granted' }),
    schedule: async (...args: unknown[]) => {
      const [at, content, delivery] = args as [Date, { title: string }, unknown];
      n += 1;
      const id = `notif-${n}`;
      const call = { at: at.toISOString(), title: content.title, delivery, argc: args.length };
      calls.push(call);
      scheduled.set(id, call);
      order.push(`schedule:${content.title}`);
      return id;
    },
    cancel: async (id) => { cancelled.push(id); scheduled.delete(id); },
    read: async (k) => store.get(k) ?? null,
    write: async (k, v) => { store.set(k, v); },
    remove: async (k) => { store.delete(k); },
    timeSensitiveAvailable: () => opts.timeSensitive === true,
  };
  if (opts.channel !== 'absent') {
    deps.ensureUrgentChannel = async () => {
      order.push('channel');
      if (opts.channel === 'throws') throw new Error('no channel api');
      return opts.channel !== false;
    };
  }
  return { deps, store, scheduled, calls, cancelled, order };
}

const plan = (opts: { deadline?: string; nowMs?: number; policy?: ReturnAlertPolicyWire | null } = {}) =>
  planReturnAlerts({
    sessionId: 's1',
    hardReturnTime: opts.deadline ?? DEADLINE,
    hardReturnLocal: '21:00',
    airportCode: 'TPE',
    nowMs: opts.nowMs ?? NOW,
    policy: opts.policy,
  });

const shift = (minutes: number) => new Date(Date.parse(DEADLINE) + minutes * MIN).toISOString();

describe('the layover_return Android channel', () => {
  it("is HIGH importance in expo-notifications' OWN enum (heads-up), not its DEFAULT, and is never silent", () => {
    // expo's AndroidImportance runs DEFAULT=5, HIGH=6, MAX=7. A literal 5 copied
    // from Android's own IMPORTANCE_HIGH scale would be expo's DEFAULT — the
    // level below the fallback channel the alert used to land on.
    expect(LAYOVER_RETURN_CHANNEL.importance).toBe(AndroidImportance.HIGH);
    expect(LAYOVER_RETURN_CHANNEL.importance).toBeGreaterThan(AndroidImportance.DEFAULT);
    // expo reads `sound` as a NAME: a boolean is read natively as null, and null
    // is a SILENT channel (verifier R1 on #681). Absent = the default sound.
    expect('sound' in LAYOVER_RETURN_CHANNEL).toBe(false);
    const typed: NotificationChannelInput = LAYOVER_RETURN_CHANNEL; // compile-time: the installed input type accepts it as is
    expect(typed.importance).toBe(AndroidImportance.HIGH);
    expect(LAYOVER_RETURN_CHANNEL_ID).toBe('layover_return');
    expect(LAYOVER_RETURN_CHANNEL_ID).not.toBe('incoming_calls');
  });

  it('does not override Do Not Disturb — that is the traveller\'s setting', () => {
    expect(LAYOVER_RETURN_CHANNEL.bypassDnd).toBe(false);
    expect('lockscreenVisibility' in LAYOVER_RETURN_CHANNEL).toBe(false);
  });
});

describe('alertLoudness — the server ladder decides, per escalation level', () => {
  it('the published ladder: RETURN_NOW (level 2, urgent) is urgent; RETURN_SOON (level 1, important) stays default', () => {
    expect(alertLoudness('RETURN_NOW', serverPolicy())).toBe('urgent');
    expect(alertLoudness('RETURN_SOON', serverPolicy())).toBe('default');
  });

  it('follows the server when it says otherwise, in either direction', () => {
    expect(alertLoudness('RETURN_NOW', serverPolicy({ now: 'important' }))).toBe('default');
    expect(alertLoudness('RETURN_SOON', serverPolicy({ soon: 'urgent' }))).toBe('urgent');
    for (const p of ['normal', 'low']) expect(alertLoudness('RETURN_NOW', serverPolicy({ now: p }))).toBe('default');
  });

  it('an older server (no policy) or an unreadable priority fails LOUD for RETURN_NOW and default for RETURN_SOON', () => {
    for (const policy of [null, undefined, {}, { rungs: null }, serverPolicy({ now: 'URGENT', soon: 'URGENT' }), { rungs: { RETURN_NOW: { priority: 2 }, RETURN_SOON: { priority: 9 } } }] as ReturnAlertPolicyWire[]) {
      expect(alertLoudness('RETURN_NOW', policy)).toBe('urgent');
      expect(alertLoudness('RETURN_SOON', policy)).toBe('default');
    }
  });
});

describe('alertDelivery — what an alert of each loudness asks the OS for', () => {
  it('default asks for nothing: the request the app always made', () => {
    expect(alertDelivery('default', { channelReady: true, timeSensitive: true })).toEqual({});
  });
  it('urgent names the channel, max priority, and time-sensitive only when the build has the entitlement', () => {
    expect(alertDelivery('urgent', { channelReady: true, timeSensitive: false })).toEqual({ channelId: 'layover_return', priority: 'max' });
    expect(alertDelivery('urgent', { channelReady: true, timeSensitive: true })).toEqual({ channelId: 'layover_return', priority: 'max', interruptionLevel: 'timeSensitive' });
    expect(alertDelivery('urgent', { channelReady: false, timeSensitive: false })).toEqual({ priority: 'max' });
  });
});

describe('syncReturnAlerts — the delivery each scheduled alert carries', () => {
  it('with the server ladder: RETURN_SOON on the default channel, RETURN_NOW on layover_return at max priority, channel created first', async () => {
    const f = fakeDeps();
    const status = await syncReturnAlerts(plan({ policy: serverPolicy() }), f.deps);
    expect(status.state).toBe('scheduled');
    expect(f.calls.map((c) => c.title)).toEqual(['Head back to TPE soon', 'Head back to TPE now']);
    expect(f.calls[0]!.argc).toBe(2); // no delivery argument at all: unchanged default
    expect(f.calls[1]!.delivery).toEqual({ channelId: LAYOVER_RETURN_CHANNEL_ID, priority: 'max' });
    expect(f.order[0]).toBe('channel');
    expect(f.order.filter((o) => o === 'channel')).toHaveLength(1);
    const stored = JSON.parse(f.store.get(returnAlertsKey('s1'))!);
    expect(stored.alerts.map((a: { loudness: string }) => a.loudness)).toEqual(['default', 'urgent']);
  });

  it('iOS time-sensitive is requested for the urgent alert only, and only when available', async () => {
    const on = fakeDeps({ timeSensitive: true });
    await syncReturnAlerts(plan({ policy: serverPolicy() }), on.deps);
    expect(on.calls[0]!.argc).toBe(2);
    expect(on.calls[1]!.delivery).toEqual({ channelId: LAYOVER_RETURN_CHANNEL_ID, priority: 'max', interruptionLevel: 'timeSensitive' });
    const off = fakeDeps({ timeSensitive: false });
    await syncReturnAlerts(plan({ policy: serverPolicy() }), off.deps);
    expect(off.calls[1]!.delivery).not.toHaveProperty('interruptionLevel');
  });

  it('a channel the OS refused (or that cannot be created) is not named — the alert still goes out at max priority', async () => {
    for (const channel of [false, 'throws', 'absent'] as const) {
      const f = fakeDeps({ channel });
      expect((await syncReturnAlerts(plan({ policy: serverPolicy() }), f.deps)).state).toBe('scheduled');
      expect(f.calls[1]!.delivery).toEqual({ priority: 'max' });
    }
  });

  it('when the server makes no alert urgent, no channel is created and nothing asks for more than the default', async () => {
    const f = fakeDeps();
    await syncReturnAlerts(plan({ policy: serverPolicy({ now: 'important' }) }), f.deps);
    expect(f.order).not.toContain('channel');
    expect(f.calls.map((c) => c.argc)).toEqual([2, 2]);
  });
});

describe('rescheduling — only when the SERVER says the move matters', () => {
  it('the threshold is the server\'s when it publishes one, the fallback only when it does not', () => {
    expect(alertMaterialDriftMin(serverPolicy({ drift: 10 }))).toEqual({ minutes: 10, source: 'server' });
    // 0 (or less) would cancel and re-raise both alerts on every mount: unreadable, so the fallback.
    for (const drift of [undefined, null, '10', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(alertMaterialDriftMin(serverPolicy({ drift }))).toEqual({ minutes: ALERT_MATERIAL_DRIFT_MIN, source: 'fallback' });
    }
    expect(alertMaterialDriftMin(null)).toEqual({ minutes: ALERT_MATERIAL_DRIFT_MIN, source: 'fallback' });
    expect(plan({ policy: serverPolicy({ drift: 10 }) }).materialDriftSource).toBe('server');
    expect(plan({ policy: null }).materialDriftSource).toBe('fallback');
  });

  it('a server threshold of 10: a 7-minute move is NOT material — what is scheduled is kept', async () => {
    const f = fakeDeps();
    await syncReturnAlerts(plan({ policy: serverPolicy({ drift: 10 }) }), f.deps);
    const status = await syncReturnAlerts(plan({ deadline: shift(-7), policy: serverPolicy({ drift: 10 }) }), f.deps);
    expect(status.state === 'scheduled' && status.rescheduled).toBe(false);
    expect(f.cancelled).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it('a server threshold of 10: a 10-minute move IS material (>=, as the server decides) — both are moved', async () => {
    const f = fakeDeps();
    await syncReturnAlerts(plan({ policy: serverPolicy({ drift: 10 }) }), f.deps);
    const status = await syncReturnAlerts(plan({ deadline: shift(-10), policy: serverPolicy({ drift: 10 }) }), f.deps);
    expect(status.state === 'scheduled' && status.rescheduled).toBe(true);
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
    expect([...f.scheduled.values()].map((c) => c.at)).toEqual(plan({ deadline: shift(-10) }).alerts.map((a) => a.at));
  });

  it('a server threshold of 2: a 3-minute move IS material, though the old hard-coded 5 would have kept it', async () => {
    const f = fakeDeps();
    await syncReturnAlerts(plan({ policy: serverPolicy({ drift: 2 }) }), f.deps);
    const status = await syncReturnAlerts(plan({ deadline: shift(3), policy: serverPolicy({ drift: 2 }) }), f.deps);
    expect(status.state === 'scheduled' && status.rescheduled).toBe(true);
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
  });

  it('a FRACTIONAL move is rounded to whole minutes, as the server rounds it: 4.4 kept, 4.6 moved (threshold 5)', async () => {
    const f = fakeDeps();
    await syncReturnAlerts(plan({ policy: serverPolicy({ drift: 5 }) }), f.deps);
    const kept = await syncReturnAlerts(plan({ deadline: shift(4.4), policy: serverPolicy({ drift: 5 }) }), f.deps);
    expect(kept.state === 'scheduled' && kept.rescheduled).toBe(false);
    expect(f.cancelled).toEqual([]);
    const moved = await syncReturnAlerts(plan({ deadline: shift(4.6), policy: serverPolicy({ drift: 5 }) }), f.deps);
    expect(moved.state === 'scheduled' && moved.rescheduled).toBe(true);
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
  });

  it('an older server (no policy) keeps the old rule: 4 minutes kept, 5 minutes moved', async () => {
    const f = fakeDeps();
    await syncReturnAlerts(plan(), f.deps);
    expect((await syncReturnAlerts(plan({ deadline: shift(4) }), f.deps)).state).toBe('scheduled');
    expect(f.cancelled).toEqual([]);
    const moved = await syncReturnAlerts(plan({ deadline: shift(5) }), f.deps);
    expect(moved.state === 'scheduled' && moved.rescheduled).toBe(true);
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
  });

  it('a ladder change with an unmoved deadline still replaces the alert: a quiet "leave now" is wrong at any drift', async () => {
    const f = fakeDeps();
    await syncReturnAlerts(plan({ policy: serverPolicy({ now: 'important' }) }), f.deps);
    expect(f.calls[1]!.argc).toBe(2);
    const status = await syncReturnAlerts(plan({ policy: serverPolicy() }), f.deps);
    expect(status.state === 'scheduled' && status.rescheduled).toBe(true);
    expect(f.cancelled).toEqual(['notif-1', 'notif-2']);
    expect(f.calls[3]!.delivery).toEqual({ channelId: LAYOVER_RETURN_CHANNEL_ID, priority: 'max' });
  });

  it('alerts stored before alerts carried a loudness are replaced once, then left alone', async () => {
    const f = fakeDeps();
    f.store.set(returnAlertsKey('s1'), JSON.stringify({
      version: 1, sessionId: 's1', hardReturnTime: DEADLINE, ids: ['old-1', 'old-2'],
      alerts: plan().alerts.map((a) => ({ rung: a.rung, at: a.at })),
    }));
    const first = await syncReturnAlerts(plan({ policy: serverPolicy() }), f.deps);
    expect(first.state === 'scheduled' && first.rescheduled).toBe(true);
    expect(f.cancelled).toEqual(['old-1', 'old-2']);
    const second = await syncReturnAlerts(plan({ policy: serverPolicy() }), f.deps);
    expect(second.state === 'scheduled' && second.rescheduled).toBe(false);
    expect(f.cancelled).toEqual(['old-1', 'old-2']);
  });
});
