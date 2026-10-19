/**
 * OD-1012-LAY-4a regression review — "Review unrelated notification types for
 * regressions because #701 changes their shared router."
 *
 * Drives NotificationRouter.route() over a matrix of notification rows and
 * traveller settings against a deterministic in-memory database, and records
 * every OBSERVABLE decision: each Expo message (all its fields) and each
 * delivery-attempt row the router writes. The same function runs against
 * main's sources (to write the golden file, `routerDecisionGolden.main.json`)
 * and against this branch (routerRegression.test.ts), so a difference is a
 * change of routing behaviour, not of a test's expectations.
 *
 * The matrix:
 *   - every NotificationTemplateService TEMPLATE, at its default priority and at `urgent`;
 *   - synthetic rows for every category the router's type map reads
 *     (safety, moderation, trip, booking, message, social, compass, discovery,
 *     and the template categories) x event-type shapes that hit each branch
 *     of mapToCompassNotificationType (sos, flight, booking, message, follow,
 *     recommend, nearby, call.incoming, layover opportunity, plain) x all four
 *     priorities;
 *   - the layover return warnings (layover.return.*) — reported, expected to differ;
 *   - four settings: defaults; quiet hours (safety override on); quiet hours
 *     with safety override OFF; push disabled;
 *   - the time-sensitive rollout switch OFF and ON (a device row that reports
 *     the capability is always present, so a non-layover type that started to
 *     read it would show up).
 */
import { createHash } from "node:crypto";
import type { NotificationRow } from "../NotificationService.js";

export const USER = "aa000000-0000-4000-8000-0000000000aa";

export interface Scenario { name: string; quiet: boolean; safetyOverride: boolean; pushEnabled: boolean }
export const SCENARIOS: Scenario[] = [
  { name: "defaults", quiet: false, safetyOverride: true, pushEnabled: true },
  { name: "quiet+override", quiet: true, safetyOverride: true, pushEnabled: true },
  { name: "quiet-override", quiet: true, safetyOverride: false, pushEnabled: true },
  { name: "push_off", quiet: false, safetyOverride: true, pushEnabled: false },
];

export function matrixRows(templates: ReadonlyArray<{ eventType: string; category: string; defaultPriority: string }>): Array<{ eventType: string; category: string; priority: string }> {
  const rows: Array<{ eventType: string; category: string; priority: string }> = [];
  for (const t of templates) {
    rows.push({ eventType: t.eventType, category: t.category, priority: t.defaultPriority });
    if (t.defaultPriority !== "urgent") rows.push({ eventType: t.eventType, category: t.category, priority: "urgent" });
  }
  const cats = [...new Set(["safety", "moderation", "trip", "booking", "message", "social", "compass", "discovery", ...templates.map((t) => t.category)])];
  const evts = ["x.sos", "trip.flight_changed", "booking.confirmed", "message.urgent", "chat.new", "user.follow", "compass.recommendation", "place.nearby", "call.incoming", "compass.layover.opportunity", "x.plain"];
  for (const c of cats) for (const e of evts) for (const p of ["urgent", "important", "normal", "low"]) rows.push({ eventType: e, category: c, priority: p });
  for (const a of ["explore", "start_heading_back", "leave_now", "get_help"]) for (const p of ["urgent", "important", "normal"]) rows.push({ eventType: `layover.return.${a}`, category: "airport", priority: p });
  return rows;
}

function fakeDb(s: Scenario) {
  const attempts: Array<Record<string, unknown>> = [];
  const rows: Record<string, any[]> = {
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }, { flag: "notifications_enabled", enabled: true }],
    notification_preferences: [{
      user_id: USER, push_enabled: s.pushEnabled, email_enabled: false, in_app_enabled: true, digests_enabled: false,
      safety_override: s.safetyOverride, quiet_hours_enabled: s.quiet, quiet_start: quietWindowAroundNow().start, quiet_end: quietWindowAroundNow().end, timezone: "UTC",
      message_previews: true, location_previews: false,
    }],
    notification_devices: [
      { user_id: USER, push_token: "ExponentPushToken[ios_capable]", ios_time_sensitive_capable: true },
      { user_id: USER, push_token: "ExponentPushToken[unknown_build]", ios_time_sensitive_capable: null },
    ],
    profiles: [{ id: USER, expo_push_token: "ExponentPushToken[legacy]" }],
  };
  const db: any = {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let inserting: any = null;
      const list = () => (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const b: any = {
        select() { return b; }, eq(c: string, v: any) { filters.push((r) => r[c] === undefined || r[c] === v); return b; },
        in() { return b; }, gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; }, neq() { return b; },
        order() { return b; }, limit() { return b; }, is() { return b; }, not() { return b; }, or() { return b; }, contains() { return b; },
        update() { return b; }, delete() { return b; }, upsert() { return b; },
        insert(row: any) { inserting = row; if (table === "notification_delivery_attempts") attempts.push({ ...row }); return b; },
        maybeSingle() { return Promise.resolve({ data: inserting ? { id: "x", ...inserting } : list()[0] ?? null, error: null }); },
        single() { return b.maybeSingle(); },
        then(res: any, rej: any) { return Promise.resolve({ data: inserting ? [{ id: "x" }] : list(), error: null, count: 0 }).then(res, rej); },
      };
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { db, attempts };
}

function row(r: { eventType: string; category: string; priority: string }, i: number): NotificationRow {
  return {
    id: `n-${i}`, userId: USER, category: r.category, eventType: r.eventType, priority: r.priority,
    title: "Title", body: "Body", actionUrl: "/x", imageUrl: null, sourceType: "src", sourceId: `s-${i}`, actorId: null,
    metadata: {}, privacyLevel: "standard", readAt: null, dismissedAt: null, expiresAt: null, createdAt: "2026-10-12T00:00:00.000Z",
  } as any;
}

export interface Decision { key: string; sent: unknown[]; attempts: unknown[] }

/** Route every row under every scenario and switch position; return the observable decisions, keyed. */
export async function runRouterMatrix(
  Router: new (db: any) => { route(n: NotificationRow): Promise<void> },
  setFetch: (f: typeof fetch | null) => void,
  templates: ReadonlyArray<{ eventType: string; category: string; defaultPriority: string }>,
): Promise<Decision[]> {
  const out: Decision[] = [];
  const rows = matrixRows(templates);
  const prevSwitch = process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED;
  try {
    for (const sw of ["off", "on"] as const) {
      if (sw === "on") process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED = "true"; else delete process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED;
      for (const s of SCENARIOS) {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]!;
          const sent: any[] = [];
          setFetch((async (_u: unknown, init?: RequestInit) => {
            const m = JSON.parse(String(init?.body ?? "[]"));
            sent.push(...m);
            return new Response(JSON.stringify({ data: m.map(() => ({ status: "ok", id: "r" })) }), { status: 200 });
          }) as typeof fetch);
          const { db, attempts } = fakeDb(s);
          await new Router(db).route(row(r, i));
          out.push({
            key: `${sw}|${s.name}|${r.category}|${r.eventType}|${r.priority}#${i}`,
            sent: sent.map((m) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)))),
            attempts: attempts
              .map((a) => ({ channel: a.channel, status: a.status, error: a.error_message ?? null, metadata: a.metadata ?? null }))
              .sort((a, b) => `${a.channel}|${a.status}`.localeCompare(`${b.channel}|${b.status}`)),
          });
        }
      }
    }
  } finally {
    if (prevSwitch === undefined) delete process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED; else process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED = prevSwitch;
    setFetch(null);
  }
  return out;
}

/** `category|eventType` of a decision key. */
export function typeOf(key: string): string {
  const [, , category, eventType] = key.split("|");
  return `${category}|${eventType}`;
}

/** One digest per category + event type over ALL its decisions (every priority, setting and switch position), in matrix order. */
export function digestByType(decisions: Decision[]): Record<string, string> {
  const groups = new Map<string, Decision[]>();
  for (const d of decisions) {
    const t = typeOf(d.key);
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t)!.push(d);
  }
  const out: Record<string, string> = {};
  for (const t of [...groups.keys()].sort()) out[t] = createHash("sha256").update(JSON.stringify(groups.get(t))).digest("hex").slice(0, 16);
  return out;
}

/**
 * A quiet window that is IN EFFECT NOW, at any hour: two hours either side of the current UTC minute. An "all day"
 * fixture ("00:00"–"23:59") left the last minute of every day outside the window (the end bound is exclusive), and
 * "00:00"–"00:00" is all day to NotificationPreferenceService but no window at all to the Compass gate. So a fixed
 * window made the quiet-hours cases fail between 23:59 and 00:00 UTC, or under one gate. This one holds under both.
 */
export function quietWindowAroundNow(): { start: string; end: string } {
  const now = new Date();
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  const hhmm = (x: number) => { const v = ((x % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; };
  return { start: hhmm(m - 120), end: hhmm(m + 120) };
}
