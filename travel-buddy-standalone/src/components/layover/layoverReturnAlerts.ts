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
 *     the materiality threshold the SERVER publishes (`returnAlertPolicy`
 *     on the overview), and otherwise cancels and reschedules. Only a server
 *     that publishes none falls back to the old mirrored figure;
 *   - each alert is as loud as the server's §15 ladder says its rung is. Both
 *     rungs ask the traveller to MOVE, so both are actionable and both go out
 *     on the high-importance `layover_return` Android channel, and as
 *     time-sensitive on iOS when the build carries that entitlement: RETURN_NOW
 *     (`urgent`) at max priority, RETURN_SOON (`important`) at high (owner
 *     ruling OD-1012-LAY-1, "prioritize actionable return warnings"; census
 *     L18 / L41 / L99). A rung the ladder calls `normal` or `low` keeps the
 *     platform default;
 *   - a schedule it cannot SEE on the device is not trusted: when the OS no
 *     longer holds an alert this module stored (reinstalled app restored from
 *     a backup, cleared notifications, another caller's cancel-all), or when it
 *     cannot tell, the alerts are scheduled again even though their times are
 *     unchanged (OD-1012-LAY-1, "do not suppress an essential return warning
 *     merely because its scheduled time is unchanged");
 *   - the ids it scheduled are stored per session, so a later mount — or the
 *     end of the layover — can cancel what an earlier mount scheduled;
 *   - a schedule the device refused is `unavailable`, never "on".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cancelScheduledNotification,
  getPermissionsAsync,
  getScheduledNotificationIds,
  iosTimeSensitiveAvailable,
  scheduleLocalNotificationAt,
  setNotificationChannelAsync,
  type LocalNotificationDelivery,
} from '../../lib/safeNotifications.ts';

/** Mirrors the server's `RETURN_SOON_LEAD_MIN` (LayoverSafetyEngine.ts). */
export const RETURN_SOON_LEAD_MIN = 30;
/**
 * FALLBACK ONLY — the server's `REMINDER_MATERIAL_DRIFT_MIN` as it stood when
 * this was written, used when the overview carries no `returnAlertPolicy` (an
 * older server). The figure in force is the one the server publishes.
 */
export const ALERT_MATERIAL_DRIFT_MIN = 5;

export type ReturnAlertRung = 'RETURN_SOON' | 'RETURN_NOW';

/**
 * The wire shape of the server's `returnAlertPolicy`
 * (api-server `LayoverReturnEscalation.ts#returnAlertPolicy`). Structural and
 * every field `unknown`-tolerant: an older server sends none of it, and a value
 * this client cannot read must fall back, not crash or go quiet.
 */
export interface ReturnAlertPolicyWire {
  materialDriftMinutes?: unknown;
  rungs?: Partial<Record<ReturnAlertRung, { level?: unknown; priority?: unknown } | null>> | null;
}

/**
 * How loud an alert is. `urgent` (leave now) and `actionable` (start heading
 * back) both take the `layover_return` channel; only `default` keeps the
 * platform's own.
 */
export type AlertLoudness = 'urgent' | 'actionable' | 'default';

/** The server's `NotificationPriority` vocabulary (NotificationTemplateService.ts). */
const KNOWN_PRIORITIES: ReadonlySet<string> = new Set(['urgent', 'important', 'normal', 'low']);

/**
 * The loudness of the alert for `rung`, as the server's ladder decides it.
 *
 * Read from the policy when it names a priority this client knows: `urgent` is
 * urgent, `important` is actionable (OD-1012-LAY-1: a warning that asks the
 * traveller to act is prioritized), `normal` and `low` are default. Otherwise —
 * an older server, or a value it cannot read — RETURN_NOW is `urgent` and
 * RETURN_SOON is `actionable`, because both rungs ask the traveller to move:
 * the same direction the server's own `returnEscalationRung` fails in (an
 * over-loud warning a traveller can dismiss, never a silent one they do not
 * hear).
 */
export function alertLoudness(rung: ReturnAlertRung, policy: ReturnAlertPolicyWire | null | undefined): AlertLoudness {
  const priority = policy?.rungs?.[rung]?.priority;
  if (typeof priority === 'string' && KNOWN_PRIORITIES.has(priority)) {
    return priority === 'urgent' ? 'urgent' : priority === 'important' ? 'actionable' : 'default';
  }
  return rung === 'RETURN_NOW' ? 'urgent' : 'actionable';
}

/** The materiality threshold in force: the server's, or the fallback when it sends none. */
export function alertMaterialDriftMin(policy: ReturnAlertPolicyWire | null | undefined): { minutes: number; source: 'server' | 'fallback' } {
  const m = policy?.materialDriftMinutes;
  if (typeof m === 'number' && Number.isFinite(m) && m > 0) return { minutes: m, source: 'server' }; // 0 or less would reschedule on every mount: unreadable, not a rule
  return { minutes: ALERT_MATERIAL_DRIFT_MIN, source: 'fallback' };
}

/**
 * The Android channel an `urgent` return alert is posted on. Without it every
 * alert lands on expo's own fallback channel (HIGH, default sound), so on
 * Android 8+ RETURN_NOW could not differ from RETURN_SOON, and a traveller
 * could not keep "leave now" on while silencing anything else the app posts.
 * `importance: 6` is expo-notifications' OWN `AndroidImportance.HIGH` (DEFAULT=5,
 * HIGH=6, MAX=7 — not Android's 3/4/5), pinned against the installed enum.
 * NO `sound` KEY, deliberately: expo reads `sound` as a string, so a boolean
 * becomes null, and null means a SILENT channel; an absent key is Android's
 * default notification sound (verifier R1 on #681). DND is not bypassed and
 * lock-screen visibility is left to the system: the traveller's settings.
 */
export const LAYOVER_RETURN_CHANNEL_ID = 'layover_return';
export const LAYOVER_RETURN_CHANNEL = {
  name: 'Layover: time to head back',
  importance: 6,
  // (no `sound`: absent = the default sound; see above)
  vibrationPattern: [0, 400, 200, 400],
  enableLights: true,
  bypassDnd: false,
} as const;

/**
 * The delivery request for an alert of this loudness. `default` asks for
 * nothing (the request the app always made). `urgent` and `actionable` name
 * the channel when it exists, ask Android 7 and below for max (urgent) or
 * high (actionable) priority, and ask iOS for time-sensitive only when the
 * build has the entitlement — without it they go at the normal level
 * (OD-1012-LAY-4). iOS applies the traveller's own Time Sensitive and Focus
 * settings to the request; nothing here can override them.
 */
export function alertDelivery(
  loudness: AlertLoudness,
  env: { channelReady: boolean; timeSensitive: boolean },
): LocalNotificationDelivery {
  if (loudness === 'default') return {};
  return {
    ...(env.channelReady ? { channelId: LAYOVER_RETURN_CHANNEL_ID } : {}),
    priority: loudness === 'urgent' ? 'max' : 'high',
    ...(env.timeSensitive ? { interruptionLevel: 'timeSensitive' as const } : {}),
  };
}

export interface PlannedAlert {
  rung: ReturnAlertRung;
  /** From the server's ladder (`alertLoudness`). */
  loudness: AlertLoudness;
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
  /** The threshold a later sync compares a moved deadline against, and whose it is. */
  materialDriftMin: number;
  materialDriftSource: 'server' | 'fallback';
}

export function planReturnAlerts(input: {
  sessionId: string;
  hardReturnTime: string;
  /** The deadline as the AIRPORT's clock shows it, e.g. "14:50". */
  hardReturnLocal: string | null;
  airportCode: string | null;
  nowMs: number;
  /** The overview's `returnAlertPolicy`. Absent on an older server. */
  policy?: ReturnAlertPolicyWire | null;
}): ReturnAlertPlan {
  const deadlineMs = Date.parse(input.hardReturnTime);
  const drift = alertMaterialDriftMin(input.policy);
  const plan: ReturnAlertPlan = {
    sessionId: input.sessionId,
    hardReturnTime: input.hardReturnTime,
    alerts: [],
    materialDriftMin: drift.minutes,
    materialDriftSource: drift.source,
  };
  // An unreadable deadline plans nothing: an alert at a guessed time would put
  // a notification on a traveller's phone that no certified record produced.
  if (!Number.isFinite(deadlineMs)) return plan;
  const where = input.airportCode ? input.airportCode : 'the airport';
  const by = input.hardReturnLocal ? ` by ${input.hardReturnLocal}` : '';
  const soonMs = deadlineMs - RETURN_SOON_LEAD_MIN * 60_000;
  if (soonMs > input.nowMs) {
    plan.alerts.push({
      rung: 'RETURN_SOON',
      loudness: alertLoudness('RETURN_SOON', input.policy),
      at: new Date(soonMs).toISOString(),
      title: `Head back to ${where} soon`,
      body: `Start back now to be at the airport${by} for your flight.`,
    });
  }
  if (deadlineMs > input.nowMs) {
    plan.alerts.push({
      rung: 'RETURN_NOW',
      loudness: alertLoudness('RETURN_NOW', input.policy),
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
  /** `loudness` is absent on a record written before wave W: such a record is rescheduled once. */
  alerts: Array<{ rung: ReturnAlertRung; at: string; loudness?: AlertLoudness }>;
}

export interface ReturnAlertDeps {
  getPermissions(): Promise<{ granted?: boolean; status?: string; canAskAgain?: boolean }>;
  schedule(
    at: Date,
    content: { title: string; body: string; data: Record<string, unknown> },
    delivery?: LocalNotificationDelivery,
  ): Promise<string | null>;
  /** Create the `layover_return` channel; TRUE when an alert may name it. Absent = not available. */
  ensureUrgentChannel?(): Promise<boolean>;
  /** Whether iOS time-sensitive delivery may be requested. Absent = no. */
  timeSensitiveAvailable?(): boolean;
  /**
   * The ids of the notifications the OS still holds for later. NULL (or an
   * absent dependency, or a throw) = this device cannot say, and a stored
   * schedule it cannot see is scheduled again (OD-1012-LAY-1).
   */
  scheduledIds?(): Promise<ReadonlySet<string> | null>;
  cancel(id: string): Promise<void>;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const defaultReturnAlertDeps: ReturnAlertDeps = {
  getPermissions: () => getPermissionsAsync(),
  schedule: (at, content, delivery) => (delivery ? scheduleLocalNotificationAt(at, content, delivery) : scheduleLocalNotificationAt(at, content)),
  ensureUrgentChannel: () => setNotificationChannelAsync(LAYOVER_RETURN_CHANNEL_ID, { ...LAYOVER_RETURN_CHANNEL, vibrationPattern: [...LAYOVER_RETURN_CHANNEL.vibrationPattern] }),
  timeSensitiveAvailable: () => iosTimeSensitiveAvailable(),
  scheduledIds: () => getScheduledNotificationIds(),
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

/**
 * The session states a return alert may be armed for — the server's
 * LAYOVER_LIVE_SESSION_STATUSES (services/airport/LayoverSessionService.ts).
 * A completed, cancelled or expired layover cancels its alerts.
 */
export const RETURN_ALERT_LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'returning']);

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
    // The server's rule, applied the way the server applies it
    // (`reminderDisposition`: whole minutes, material at >= the threshold).
    const driftMin = Math.abs(Math.round((Date.parse(plan.hardReturnTime) - Date.parse(stored.hardReturnTime)) / 60_000));
    const sameRungs = stored.alerts.map((a) => a.rung).join() === plan.alerts.map((a) => a.rung).join();
    // An alert scheduled quieter (or louder) than the ladder now says is wrong
    // whatever the deadline did — including every alert stored before alerts
    // carried a loudness at all.
    const sameLoudness = stored.alerts.map((a) => a.loudness ?? '?').join() === plan.alerts.map((a) => a.loudness).join();
    if (Number.isFinite(driftMin) && driftMin < plan.materialDriftMin && sameRungs && sameLoudness && await stillHeldByOs(deps, stored)) {
      return { state: 'scheduled', alerts: stored.alerts.map((a) => ({ rung: a.rung, at: a.at })), rescheduled: false };
    }
  }

  if (stored) for (const id of stored.ids) await deps.cancel(id);
  // The channel is created before the first alert that names it — and only
  // when one does. A channel the OS refused is not named: the alert still goes
  // out at max priority on the default channel rather than not at all.
  let channelReady = false;
  if (plan.alerts.some((a) => a.loudness !== 'default') && deps.ensureUrgentChannel) {
    try { channelReady = (await deps.ensureUrgentChannel()) === true; } catch { channelReady = false; }
  }
  let timeSensitive = false;
  try { timeSensitive = deps.timeSensitiveAvailable?.() === true; } catch { timeSensitive = false; }
  const ids: string[] = [];
  for (const a of plan.alerts) {
    const content = {
      title: a.title,
      body: a.body,
      data: { url: `/layover/${plan.sessionId}`, rung: a.rung },
    };
    const delivery = alertDelivery(a.loudness, { channelReady, timeSensitive });
    const id = Object.keys(delivery).length > 0
      ? await deps.schedule(new Date(a.at), content, delivery)
      : await deps.schedule(new Date(a.at), content);
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
    alerts: plan.alerts.map((a) => ({ rung: a.rung, at: a.at, loudness: a.loudness })),
  };
  try {
    await deps.write(returnAlertsKey(plan.sessionId), JSON.stringify(record));
  } catch {
    // Alerts this device cannot record are alerts it cannot cancel or move: the
    // next mount would schedule a SECOND pair beside them (verifier minor 10).
    // Undo them and say so, as a half-scheduled set is undone above.
    for (const done of ids) await deps.cancel(done);
    return { state: 'unavailable' };
  }
  return { state: 'scheduled', alerts: plan.alerts.map((a) => ({ rung: a.rung, at: a.at })), rescheduled: stored !== null };
}

/**
 * OD-1012-LAY-1 — is every alert this module stored still waiting in the OS?
 *
 * Keeping a stored schedule is how duplicates are suppressed (same rung, same
 * session, the time has not moved materially). It is only a duplicate if the
 * phone still HOLDS it: an alert the OS has dropped would otherwise be
 * "kept" forever and never fire. Unknown is not "held" — scheduling again
 * cancels first, so the cost of being wrong that way is one replaced entry,
 * never a second notification.
 */
async function stillHeldByOs(deps: ReturnAlertDeps, stored: StoredAlerts): Promise<boolean> {
  if (!deps.scheduledIds) return false;
  let held: ReadonlySet<string> | null;
  try { held = await deps.scheduledIds(); } catch { return false; }
  if (!held) return false;
  return stored.ids.every((id) => held!.has(id));
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
