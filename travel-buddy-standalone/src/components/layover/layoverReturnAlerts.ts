/**
 * Return alerts — the notification half of census-layover L41 / L18 / L99 /
 * L272, built to the lead's 2026-10-06 ruling on LAYOVER_RETURN_REMINDER_DELIVERY:
 *
 *   "Local notifications are scheduled on the phone at the certified 'return
 *    soon' / 'return now' times and rescheduled when the deadline moves
 *    materially. Nothing goes server-side. Notification permission is the
 *    user's choice, and a denied permission is shown honestly."
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────
 * The only notification the layover surface ever sent was the traveller's own
 * "Remind me" tap: one alert, 30 minutes before the deadline, scheduled only if
 * they pressed it, with its id held in a `useRef` that a remount forgets — so a
 * moved deadline left it firing at the old time (the server's
 * `reminderDisposition` can only say so in a banner). Nothing fired at
 * RETURN_SOON or RETURN_NOW on its own.
 *
 * ── WHAT THIS DOES ───────────────────────────────────────────────────────────
 * `planReturnAlerts` turns the CERTIFIED hard return time into the two §15
 * instants the server's `computeReturnState` uses — RETURN_SOON at
 * deadline − 30 min, RETURN_NOW at the deadline — and drops any already past.
 * It computes no deadline of its own: the input is the server's.
 *
 * `syncReturnAlerts` makes the phone's scheduled alerts match that plan:
 *   - it NEVER asks for permission. If notifications are not already allowed it
 *     schedules nothing and says why (`permission_denied` when the traveller or
 *     the OS refused, `permission_not_asked` when nobody has asked yet) — the
 *     screen asks only behind the traveller's own tap, with a rationale;
 *   - it keeps what is scheduled when the certified deadline moved by less than
 *     the server's own materiality threshold (5 minutes, the same figure as
 *     `REMINDER_MATERIAL_DRIFT_MIN`), and otherwise cancels and reschedules;
 *   - the ids it scheduled are stored per session, so a later mount — or the
 *     end of the layover — can cancel what an earlier mount scheduled;
 *   - a schedule the device refused is `unavailable`, never "on".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cancelScheduledNotification,
  getPermissionsAsync,
  scheduleLocalNotificationAt,
} from '../../lib/safeNotifications.ts';

/** Mirrors the server's `RETURN_SOON_LEAD_MIN` (LayoverSafetyEngine.ts). */
export const RETURN_SOON_LEAD_MIN = 30;
/** Mirrors the server's `REMINDER_MATERIAL_DRIFT_MIN` (LayoverReturnEscalation.ts). */
export const ALERT_MATERIAL_DRIFT_MIN = 5;

export type ReturnAlertRung = 'RETURN_SOON' | 'RETURN_NOW';

export interface PlannedAlert {
  rung: ReturnAlertRung;
  /** ISO instant the alert fires. */
  at: string;
  title: string;
  body: string;
}

export interface ReturnAlertPlan {
  sessionId: string;
  /** The certified hard return time the plan was built from, verbatim. */
  hardReturnTime: string;
  alerts: PlannedAlert[];
}

export function planReturnAlerts(input: {
  sessionId: string;
  hardReturnTime: string;
  /** The deadline as the AIRPORT's clock shows it, e.g. "14:50". */
  hardReturnLocal: string | null;
  airportCode: string | null;
  nowMs: number;
}): ReturnAlertPlan {
  const deadlineMs = Date.parse(input.hardReturnTime);
  const plan: ReturnAlertPlan = { sessionId: input.sessionId, hardReturnTime: input.hardReturnTime, alerts: [] };
  // An unreadable deadline plans nothing: an alert at a guessed time would put
  // a notification on a traveller's phone that no certified record produced.
  if (!Number.isFinite(deadlineMs)) return plan;
  const where = input.airportCode ? input.airportCode : 'the airport';
  const by = input.hardReturnLocal ? ` by ${input.hardReturnLocal}` : '';
  const soonMs = deadlineMs - RETURN_SOON_LEAD_MIN * 60_000;
  if (soonMs > input.nowMs) {
    plan.alerts.push({
      rung: 'RETURN_SOON',
      at: new Date(soonMs).toISOString(),
      title: `Head back to ${where} soon`,
      body: `Start back now to be at the airport${by} for your flight.`,
    });
  }
  if (deadlineMs > input.nowMs) {
    plan.alerts.push({
      rung: 'RETURN_NOW',
      at: new Date(deadlineMs).toISOString(),
      title: `Head back to ${where} now`,
      body: `It is your return time${by ? ` (${input.hardReturnLocal})` : ''}. Go to the airport now to make your flight.`,
    });
  }
  return plan;
}

export type ReturnAlertStatus =
  | { state: 'scheduled'; alerts: Array<{ rung: ReturnAlertRung; at: string }>; rescheduled: boolean }
  | { state: 'permission_denied' }
  | { state: 'permission_not_asked' }
  | { state: 'unavailable' }
  | { state: 'nothing_to_schedule' };

interface StoredAlerts {
  version: 1;
  sessionId: string;
  hardReturnTime: string;
  ids: string[];
  alerts: Array<{ rung: ReturnAlertRung; at: string }>;
}

export interface ReturnAlertDeps {
  getPermissions(): Promise<{ granted?: boolean; status?: string; canAskAgain?: boolean }>;
  schedule(at: Date, content: { title: string; body: string; data: Record<string, unknown> }): Promise<string | null>;
  cancel(id: string): Promise<void>;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const defaultReturnAlertDeps: ReturnAlertDeps = {
  getPermissions: () => getPermissionsAsync(),
  schedule: (at, content) => scheduleLocalNotificationAt(at, content),
  cancel: (id) => cancelScheduledNotification(id),
  read: (key) => AsyncStorage.getItem(key),
  write: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};

export function returnAlertsKey(sessionId: string): string {
  return `layover.returnAlerts.v1:${sessionId}`;
}

async function readStored(deps: ReturnAlertDeps, sessionId: string): Promise<StoredAlerts | null> {
  try {
    const raw = await deps.read(returnAlertsKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAlerts>;
    if (parsed.version !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.ids)) return null;
    return parsed as StoredAlerts;
  } catch {
    return null;
  }
}

/** Cancel every alert this module stored for the session, and forget them. */
export async function cancelReturnAlerts(sessionId: string, deps: ReturnAlertDeps = defaultReturnAlertDeps): Promise<void> {
  const stored = await readStored(deps, sessionId);
  if (stored) for (const id of stored.ids) await deps.cancel(id);
  try { await deps.remove(returnAlertsKey(sessionId)); } catch { /* nothing stored */ }
}

export async function syncReturnAlerts(
  plan: ReturnAlertPlan,
  deps: ReturnAlertDeps = defaultReturnAlertDeps,
): Promise<ReturnAlertStatus> {
  let perms: { granted?: boolean; status?: string };
  try { perms = await deps.getPermissions(); } catch { perms = {}; }
  if (perms.granted !== true) {
    // Never prompt from here. "denied" is the traveller's (or the OS's) answer;
    // anything else means nobody has asked, and the screen asks behind a tap.
    return perms.status === 'denied' ? { state: 'permission_denied' } : { state: 'permission_not_asked' };
  }

  const stored = await readStored(deps, plan.sessionId);
  if (plan.alerts.length === 0) {
    await cancelReturnAlerts(plan.sessionId, deps);
    return { state: 'nothing_to_schedule' };
  }

  if (stored && stored.ids.length === stored.alerts.length && stored.alerts.length > 0) {
    const driftMin = Math.abs(Date.parse(plan.hardReturnTime) - Date.parse(stored.hardReturnTime)) / 60_000;
    const sameRungs = stored.alerts.map((a) => a.rung).join() === plan.alerts.map((a) => a.rung).join();
    if (Number.isFinite(driftMin) && driftMin < ALERT_MATERIAL_DRIFT_MIN && sameRungs) {
      return { state: 'scheduled', alerts: stored.alerts, rescheduled: false };
    }
  }

  if (stored) for (const id of stored.ids) await deps.cancel(id);
  const ids: string[] = [];
  for (const a of plan.alerts) {
    const id = await deps.schedule(new Date(a.at), {
      title: a.title,
      body: a.body,
      data: { url: `/layover/${plan.sessionId}`, rung: a.rung },
    });
    if (!id) {
      // Half a set of alerts is not "alerts on". Undo what did schedule and say so.
      for (const done of ids) await deps.cancel(done);
      try { await deps.remove(returnAlertsKey(plan.sessionId)); } catch { /* nothing stored */ }
      return { state: 'unavailable' };
    }
    ids.push(id);
  }
  const record: StoredAlerts = {
    version: 1,
    sessionId: plan.sessionId,
    hardReturnTime: plan.hardReturnTime,
    ids,
    alerts: plan.alerts.map((a) => ({ rung: a.rung, at: a.at })),
  };
  try { await deps.write(returnAlertsKey(plan.sessionId), JSON.stringify(record)); } catch { /* the alerts still fire; a later mount reschedules */ }
  return { state: 'scheduled', alerts: record.alerts, rescheduled: stored !== null };
}

/** The sentence the dashboard shows for a status. Never claims "on" without a schedule. */
export function describeReturnAlerts(status: ReturnAlertStatus | null, fmt: (iso: string) => string): string | null {
  if (!status) return null;
  switch (status.state) {
    case 'scheduled': {
      const soon = status.alerts.find((a) => a.rung === 'RETURN_SOON');
      const now = status.alerts.find((a) => a.rung === 'RETURN_NOW');
      const parts = [soon ? `${fmt(soon.at)} (head back soon)` : null, now ? `${fmt(now.at)} (head back now)` : null].filter(Boolean);
      return `Return alerts on: ${parts.join(' and ')}.`;
    }
    case 'permission_denied':
      return 'Return alerts are off: notifications are not allowed for Portava. Turn them on in Settings to be warned when it is time to head back.';
    case 'permission_not_asked':
      return 'Return alerts are off. Turn them on to be warned when it is time to head back.';
    case 'unavailable':
      return 'Return alerts could not be set on this device. Keep an eye on the countdown.';
    case 'nothing_to_schedule':
      return null;
  }
}
