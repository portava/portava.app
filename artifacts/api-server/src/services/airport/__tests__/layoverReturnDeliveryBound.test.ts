/**
 * Owner ruling OD-1012-LAY-4a (2026-10-12), on PR #701:
 *
 *   "approve PUSH_IOS_TIME_SENSITIVE_ENTITLED as a server setting rather than a
 *    database feature flag … Default off … The setting is a rollout switch—not
 *    proof of an installed app's entitlement. Account for older or unknown app
 *    builds; use ordinary notifications when capability is unavailable or
 *    uncertain. … Respect notification permissions and safety-override
 *    preferences. Do not use Apple's Critical Alerts level. Keep the in-app
 *    warning available regardless of push success. 'Must-deliver' must mean
 *    'must attempt delivery,' never guaranteed receipt. If notification history
 *    is unavailable, urgent warnings must still be attempted, but retries must
 *    remain bounded to avoid notification storms. Test action escalation,
 *    unchanged-deadline warnings, quiet hours, duplicate suppression, missing
 *    history, and dropped scheduled alerts."
 *
 * This suite pins the rework of #701 for that ruling. Each case named
 * "(red on 1cccc5a70)" fails against the PR's previous head:
 *   - capability: the switch alone made EVERY iOS device time-sensitive;
 *   - bound: an unreadable ledger let an essential warning out once per replan;
 *   - unchanged deadline: an essential warning whose first attempt was never
 *     persisted was never attempted again while the action held.
 * Dropped scheduled alerts are the phone's (travel-buddy-standalone
 * layoverReturnAlerts.essential.component.test.ts); action escalation and the
 * router's quiet-hours rules are also in layoverReturnWarning.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/airport/__tests__/layoverReturnDeliveryBound.test.ts
 */
import { describe, it, afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import * as Escalation from "../LayoverReturnEscalation.js";
import { returnWarningEventType, returnWarningSourceId } from "../LayoverReturnEscalation.js";
import { shouldNotify, type OpportunityEvent, type ActionUniverseDiff } from "../LayoverEventReplanner.js";
import { notifyLayoverOpportunity } from "../LayoverOpportunityNotifier.js";
import { NotificationRouter } from "../../notifications/NotificationRouter.js";
import { NotificationDeduplicationService } from "../../notifications/NotificationDeduplicationService.js";
import * as Budget from "../../notifications/essentialAttemptBudget.js";
import * as Capability from "../../../lib/pushDeviceCapability.js";
import { sendPushNotification, _setTestFetch } from "../../../lib/push.js";
import type { LayoverReturnState } from "../LayoverSafetyEngine.js";

const USER = "aa000000-0000-4000-8000-0000000000aa";
const T0 = Date.parse("2026-10-12T10:00:00.000Z");

const budget = Budget as unknown as {
  _resetEssentialAttemptBudget?: () => void;
  ESSENTIAL_UNREADABLE_MAX_ATTEMPTS?: number;
  ESSENTIAL_UNREADABLE_WINDOW_MS?: number;
  ESSENTIAL_BUDGET_MAX_KEYS?: number;
  takeEssentialAttempt?: (k: string, now?: number) => boolean;
  _essentialAttemptBudgetSize?: () => number;
};

beforeEach(() => { budget._resetEssentialAttemptBudget?.(); });
afterEach(() => { _setTestFetch(null); delete process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED; mock.timers.reset(); });

// ─── fixtures ───────────────────────────────────────────────────────────────

function states(before: LayoverReturnState, after: LayoverReturnState, over: Partial<ActionUniverseDiff> = {}): ActionUniverseDiff {
  return {
    verdictChanged: false, returnStateChanged: before !== after, tierChanged: false,
    usableMinutesDelta: 0, deadlineDeltaMinutes: 0,
    candidatesGained: [], candidatesLost: [], candidatesUnmeasured: [],
    reasonCodesAdded: [], reasonCodesRemoved: [],
    returnStateBefore: before, returnStateAfter: after,
    ...over,
  };
}
function publication(d: ActionUniverseDiff, withOpportunity = true) {
  const o = { replannerVersion: "t", sessionId: "s1", causedByEventId: "e1", causedByEventType: "flight.departure_delayed", diff: d, reasonCodes: [], why: ["x"] } as unknown as OpportunityEvent;
  return {
    wiringVersion: "w", replannerVersion: "r",
    event: { eventId: "e1", eventType: "flight.departure_delayed", occurredAt: "t", receivedAt: "t", source: "portava.layover.session_edit", dedupKey: "dk-1", confidence: "stated" },
    diff: d, invalidation: {}, opportunity: withOpportunity ? { why: o.why, reasonCodes: [] } : null,
    notify: shouldNotify(withOpportunity ? o : null), disruptionState: null, certification: {}, reasonCodes: [],
    snapshotPersisted: false, snapshotUnavailableReason: "no_snapshot_storage",
    counts: { impacted: 1, replanned: 1, skipped: 0, notifications: 1 },
  } as any;
}

type Ledger = "empty" | "has_same" | "unreadable";
interface DbOpts {
  ledger?: Ledger;
  devices?: Array<{ push_token: string; ios_time_sensitive_capable?: boolean | null }>;
  devicesCapabilityUnreadable?: boolean;
  quiet?: boolean;
  safetyOverride?: boolean;
  pushEnabled?: boolean;
}
/** One in-memory database for the notifier, the dedup service and the router. */
function fakeDb(o: DbOpts = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const rows: Record<string, any[]> = {
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }, { flag: "notifications_enabled", enabled: true }],
    notification_preferences: [{
      user_id: USER, push_enabled: o.pushEnabled ?? true, email_enabled: false, in_app_enabled: true, digests_enabled: false,
      safety_override: o.safetyOverride ?? true, quiet_hours_enabled: o.quiet === true, quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC",
      message_previews: true, location_previews: false,
    }],
    notification_devices: (o.devices ?? [{ push_token: "ExponentPushToken[ios1]", ios_time_sensitive_capable: null }]).map((d) => ({ user_id: USER, ...d })),
    profiles: [{ id: USER, expo_push_token: null }],
  };
  const db: any = {
    from(table: string) {
      let insertRow: any = null;
      let selectCols = "";
      let patch: any = null;
      const filters: Array<(r: any) => boolean> = [];
      const b: any = {
        select(c?: string) { selectCols = c ?? ""; return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === undefined || r[c] === v); return b; },
        gt() { return b; }, gte() { return b; }, lt() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; }, is() { return b; }, neq() { return b; },
        update(p: any) { patch = p; updates.push({ table, patch: p }); return b; },
        insert(row: any) { insertRow = row; if (table === "notifications") inserted.push(row); if (table === "notification_delivery_attempts") attempts.push(row); return b; },
        maybeSingle() {
          if (insertRow) return Promise.resolve({ data: { id: table === "notifications" ? `n-${inserted.length}` : "a", created_at: new Date(T0).toISOString(), ...insertRow }, error: null });
          return Promise.resolve({ data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
        },
        single() { return b.maybeSingle(); },
        then(res: any, rej: any) {
          if (patch) return Promise.resolve({ data: null, error: null }).then(res, rej);
          if (table === "notifications" && !insertRow) {
            const r = o.ledger === "unreadable" ? { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
              : { data: o.ledger === "has_same" ? [{ id: "earlier" }] : [], error: null };
            return Promise.resolve(r).then(res, rej);
          }
          if (table === "notification_devices" && selectCols.includes("ios_time_sensitive_capable") && o.devicesCapabilityUnreadable) {
            return Promise.resolve({ data: null, error: { message: "column notification_devices.ios_time_sensitive_capable does not exist", code: "42703" } }).then(res, rej);
          }
          if (insertRow) return Promise.resolve({ data: [{ id: "x" }], error: null }).then(res, rej);
          return Promise.resolve({ data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null, count: 0 }).then(res, rej);
        },
      };
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { db, inserted, attempts, updates };
}
function capture(status = 200) {
  const sent: any[] = [];
  _setTestFetch(async (_u, init) => {
    const m = JSON.parse(String(init?.body ?? "[]"));
    sent.push(...m);
    if (status !== 200) return new Response("upstream", { status });
    return new Response(JSON.stringify({ data: m.map(() => ({ status: "ok", id: "r" })) }), { status: 200 });
  });
  return sent;
}
function warningRow(action: "start_heading_back" | "leave_now" | "get_help", priority: "important" | "urgent") {
  return {
    id: `n-${action}`, userId: USER, category: "airport", eventType: returnWarningEventType(action), priority,
    title: "t", body: "b", actionUrl: "/airport/sessions/s1", imageUrl: null, sourceType: "layover_return",
    sourceId: returnWarningSourceId("s1", action), actorId: null, metadata: {},
    privacyLevel: "standard", readAt: null, dismissedAt: null, expiresAt: null, createdAt: new Date(T0).toISOString(),
  } as any;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// ─── 1. per-device capability ───────────────────────────────────────────────

describe("LAY-4a: time-sensitive needs the switch AND the device's own report", () => {
  const twoDevices = [
    { push_token: "ExponentPushToken[new_ios]", ios_time_sensitive_capable: true },
    { push_token: "ExponentPushToken[old_build]", ios_time_sensitive_capable: null },
    { push_token: "ExponentPushToken[reported_no]", ios_time_sensitive_capable: false },
  ];

  it("switch OFF: no device gets time-sensitive, not even one that reported the capability", async () => {
    const sent = capture();
    await new NotificationRouter(fakeDb({ devices: twoDevices }).db).route(warningRow("leave_now", "urgent"));
    assert.equal(sent.length, 3);
    assert.ok(sent.every((m) => !("interruptionLevel" in m)));
    assert.ok(sent.every((m) => m.priority === "high" && m.channelId === "layover_return"));
  });

  it("switch ON + capability reported: ONLY that device is time-sensitive (red on 1cccc5a70)", async () => {
    process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED = "true";
    const sent = capture();
    await new NotificationRouter(fakeDb({ devices: twoDevices }).db).route(warningRow("leave_now", "urgent"));
    const level = Object.fromEntries(sent.map((m) => [m.to, m.interruptionLevel ?? "ordinary"]));
    assert.deepEqual(level, {
      "ExponentPushToken[new_ios]": "time-sensitive",
      "ExponentPushToken[old_build]": "ordinary",
      "ExponentPushToken[reported_no]": "ordinary",
    });
  });

  it("switch ON + capability unknown (older build, nothing reported): ordinary (red on 1cccc5a70)", async () => {
    process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED = "true";
    const sent = capture();
    await new NotificationRouter(fakeDb({ devices: [{ push_token: "ExponentPushToken[old_build]", ios_time_sensitive_capable: null }] }).db).route(warningRow("get_help", "urgent"));
    assert.equal(sent.length, 1);
    assert.equal("interruptionLevel" in sent[0], false);
  });

  it("switch ON + capabilities unreadable (3771 unapplied): the push still goes, ordinary (red on 1cccc5a70)", async () => {
    process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED = "true";
    const sent = capture();
    const { db, attempts } = fakeDb({ devices: [{ push_token: "ExponentPushToken[new_ios]", ios_time_sensitive_capable: true }], devicesCapabilityUnreadable: true });
    await new NotificationRouter(db).route(warningRow("start_heading_back", "important"));
    assert.equal(sent.length, 1);
    assert.equal("interruptionLevel" in sent[0], false);
    assert.equal(attempts.find((a) => a.channel === "push")?.status, "sent");
  });

  it("only the exact string \"true\" turns the switch on (red on 1cccc5a70: name)", () => {
    const on = (Escalation as any).iosTimeSensitiveRolloutEnabled as (e: Record<string, string | undefined>) => boolean;
    assert.equal(typeof on, "function");
    assert.equal(on({}), false);
    for (const v of ["", "1", "yes", "TRUE", "True", "false", " true"]) assert.equal(on({ PUSH_IOS_TIME_SENSITIVE_ENTITLED: v }), false, v);
    assert.equal(on({ PUSH_IOS_TIME_SENSITIVE_ENTITLED: "true" }), true);
  });

  it("timeSensitivePushTokens: true only — null, false, strings and junk are ordinary", () => {
    const f = (Escalation as any).timeSensitivePushTokens as (d: unknown) => string[];
    assert.deepEqual(f([
      { push_token: "a", ios_time_sensitive_capable: true },
      { push_token: "b", ios_time_sensitive_capable: null },
      { push_token: "c", ios_time_sensitive_capable: false },
      { push_token: "d", ios_time_sensitive_capable: "true" },
      { push_token: "e" },
      { push_token: "", ios_time_sensitive_capable: true },
      null,
    ]), ["a"]);
    assert.deepEqual(f(null), []);
  });

  it("sendPushNotification sets the level per listed token, and never anything but time-sensitive", async () => {
    const sent: any[] = [];
    const fetchImpl: typeof fetch = async (_u, init) => { const m = JSON.parse(String(init?.body)); sent.push(...m); return new Response(JSON.stringify({ data: m.map(() => ({ status: "ok" })) }), { status: 200 }); };
    await sendPushNotification(["ExponentPushToken[a]", "ExponentPushToken[b]"], { title: "t", body: "b", timeSensitiveTokens: ["ExponentPushToken[b]"] } as any, { fetchImpl });
    assert.equal("interruptionLevel" in sent[0], false);
    assert.equal(sent[1].interruptionLevel, "time-sensitive");
    assert.ok(!JSON.stringify(sent).includes("critical"));
    assert.ok(!("timeSensitiveTokens" in sent[1]), "the token list never reaches Expo");
  });

  it("registration records exactly what the build reported: true / false / NULL for nothing (an older build)", async () => {
    const rec = (Capability as any).recordPushDeviceCapabilities as (...a: unknown[]) => Promise<string>;
    for (const [caps, want] of [[{ iosTimeSensitive: true }, true], [{ iosTimeSensitive: false }, false], [undefined, null], [{}, null], [{ iosTimeSensitive: "true" }, null]] as const) {
      const { db, updates } = fakeDb();
      assert.equal(await rec(db, USER, "row-1", caps), "recorded");
      assert.deepEqual(updates.at(-1), { table: "notification_devices", patch: { ios_time_sensitive_capable: want } });
    }
  });

  it("registration with the column absent (3771 unapplied) never fails the registration", async () => {
    const rec = (Capability as any).recordPushDeviceCapabilities as (...a: unknown[]) => Promise<string>;
    const db: any = { from: () => { const b: any = { update: () => b, eq: () => b, then: (r: any, j: any) => Promise.resolve({ error: { code: "PGRST204", message: "Could not find the 'ios_time_sensitive_capable' column" } }).then(r, j) }; return b; } };
    assert.equal(await rec(db, USER, "row-1", { iosTimeSensitive: true }), "column_absent");
    assert.equal(await rec(db, USER, null, { iosTimeSensitive: true }), "no_row");
  });
});

// ─── 2. missing history: attempted, and BOUNDED ─────────────────────────────

describe("LAY-4a: an unreadable ledger — the essential warning is attempted, and the attempts are bounded", () => {
  it("storm: 20 replans escalating to leave now inside 30 minutes write at most 2 warnings (red on 1cccc5a70)", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    capture();
    const { db, inserted } = fakeDb({ ledger: "unreadable" });
    for (let i = 0; i < 20; i++) {
      mock.timers.setTime(T0 + i * 60_000);
      await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW")));
      await flush();
    }
    assert.equal(inserted.length, 2, "the bound: 2 attempts per session+action per 30 minutes");
    assert.equal(budget.ESSENTIAL_UNREADABLE_MAX_ATTEMPTS, 2);
    assert.equal(budget.ESSENTIAL_UNREADABLE_WINDOW_MS, 30 * 60 * 1000);
  });

  it("the window rolls: after 30 minutes one more attempt is allowed, never a burst", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    capture();
    const { db, inserted } = fakeDb({ ledger: "unreadable" });
    for (let i = 0; i < 2; i++) { await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW"))); await flush(); }
    mock.timers.setTime(T0 + 29 * 60_000);
    await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW")));
    assert.equal(inserted.length, 2);
    mock.timers.setTime(T0 + 30 * 60_000 + 1);
    for (let i = 0; i < 5; i++) { await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW"))); await flush(); }
    assert.equal(inserted.length, 4, "2 more in the new window, then capped again");
  });

  it("the bound is per session + action: another session, or get help, has its own attempts", async () => {
    capture();
    const { db, inserted } = fakeDb({ ledger: "unreadable" });
    for (let i = 0; i < 5; i++) await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW")));
    for (let i = 0; i < 5; i++) await notifyLayoverOpportunity(db, USER, "s2", publication(states("RETURN_SOON", "RETURN_NOW")));
    for (let i = 0; i < 5; i++) await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_NOW", "CONNECTION_AT_RISK")));
    await flush();
    assert.deepEqual(inserted.map((r) => r.source_id), ["s1:leave_now", "s1:leave_now", "s2:leave_now", "s2:leave_now", "s1:get_help", "s1:get_help"]);
  });

  it("the dedup service names the cap: `essential_attempt_cap`, not a ledger duplicate", async () => {
    const svc = new NotificationDeduplicationService(fakeDb({ ledger: "unreadable" }).db);
    const p = { userId: USER, category: "airport", eventType: "layover.return.leave_now", sourceType: "layover_return", sourceId: "s9:leave_now", essential: true };
    assert.deepEqual(await svc.check(p), { isDuplicate: false });
    assert.deepEqual(await svc.check(p), { isDuplicate: false });
    assert.deepEqual(await svc.check(p), { isDuplicate: true, reason: "essential_attempt_cap" });
  });

  it("a READABLE ledger never consumes the budget: the ledger's own rule decides", async () => {
    const empty = new NotificationDeduplicationService(fakeDb({ ledger: "empty" }).db);
    const p = { userId: USER, category: "airport", eventType: "layover.return.leave_now", sourceType: "layover_return", sourceId: "s8:leave_now", essential: true };
    for (let i = 0; i < 5; i++) assert.deepEqual(await empty.check(p), { isDuplicate: false });
    assert.equal(budget._essentialAttemptBudgetSize?.(), 0);
    const same = new NotificationDeduplicationService(fakeDb({ ledger: "has_same" }).db);
    assert.deepEqual(await same.check(p), { isDuplicate: true, reason: "general_dedup" });
  });

  it("a NON-essential notification keeps the ledger's fail-closed answer on an unreadable ledger (unchanged)", async () => {
    const svc = new NotificationDeduplicationService(fakeDb({ ledger: "unreadable" }).db);
    assert.deepEqual(await svc.check({ userId: USER, category: "airport", eventType: "layover.return.start_heading_back", sourceType: "layover_return", sourceId: "s1:start_heading_back" }), { isDuplicate: true, reason: "general_dedup" });
    assert.deepEqual(await svc.check({ userId: USER, category: "trips", eventType: "trip.invite", sourceType: "trip", sourceId: "t1" }), { isDuplicate: true, reason: "general_dedup" });
    assert.equal(budget._essentialAttemptBudgetSize?.(), 0);
  });

  it("a process restart starts the budget empty — the stated bound is 2 per window PER PROCESS START", () => {
    const take = budget.takeEssentialAttempt!;
    assert.equal(take("k", T0), true); assert.equal(take("k", T0), true); assert.equal(take("k", T0), false);
    budget._resetEssentialAttemptBudget!();
    assert.equal(take("k", T0), true);
  });

  it("memory is bounded: at most ESSENTIAL_BUDGET_MAX_KEYS keys, expired keys pruned first", () => {
    const take = budget.takeEssentialAttempt!;
    const max = budget.ESSENTIAL_BUDGET_MAX_KEYS!;
    for (let i = 0; i < max + 50; i++) take(`k${i}`, T0);
    assert.ok(budget._essentialAttemptBudgetSize!() <= max);
    take("fresh", T0 + budget.ESSENTIAL_UNREADABLE_WINDOW_MS! + 1);
    assert.equal(budget._essentialAttemptBudgetSize!(), 1, "every expired key pruned");
  });
});

// ─── 3. unchanged deadline ──────────────────────────────────────────────────

describe("LAY-1: an essential warning is not suppressed because its time is unchanged", () => {
  it("still leave now, deadline unchanged, NO warning on record: the warning is attempted (red on 1cccc5a70)", async () => {
    capture();
    const { db, inserted } = fakeDb({ ledger: "empty" });
    const out = await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_NOW", "RETURN_NOW"), false));
    assert.equal(out.emitted, true);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.event_type, "layover.return.leave_now");
    assert.equal(inserted[0]!.priority, "urgent");
    assert.deepEqual((inserted[0]!.metadata as any).returnWarning, { action: "leave_now", from: "leave_now", essential: true });
  });

  it("…the same for get help (red on 1cccc5a70)", async () => {
    capture();
    const { db, inserted } = fakeDb({ ledger: "empty" });
    await notifyLayoverOpportunity(db, USER, "s1", publication(states("CONNECTION_AT_RISK", "CONNECTION_AT_RISK"), false));
    assert.equal(inserted[0]?.source_id, "s1:get_help");
  });

  it("the warning IS on record: nothing is re-sent — a duplicate is suppressed", async () => {
    const { db, inserted } = fakeDb({ ledger: "has_same" });
    const out = await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_NOW", "RETURN_NOW"), false));
    assert.deepEqual(out, { emitted: false, reason: "no_opportunity" });
    assert.equal(inserted.length, 0);
  });

  it("start heading back (not essential) is never re-raised on an unchanged action", async () => {
    const { db, inserted } = fakeDb({ ledger: "empty" });
    await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_SOON"), false));
    assert.equal(inserted.length, 0);
  });

  it("history unreadable on an unchanged leave now: attempted, and bounded the same way", async () => {
    capture();
    const { db, inserted } = fakeDb({ ledger: "unreadable" });
    for (let i = 0; i < 10; i++) { await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_NOW", "RETURN_NOW"), false)); await flush(); }
    assert.equal(inserted.length, 2);
  });
});

// ─── 4. "must attempt delivery", never receipt; the in-app row regardless ───

describe("LAY-4a: must ATTEMPT delivery — the in-app warning exists whatever the push does", () => {
  it("Expo down (5xx): the warning row exists, the push is queued `pending` — never `delivered`", async () => {
    capture(503);
    const { db, inserted, attempts } = fakeDb({ ledger: "empty" });
    const out = await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW")));
    await flush(); await flush();
    assert.equal(out.emitted, true);
    assert.equal(inserted.length, 1);
    assert.ok(attempts.length > 0);
    assert.ok(attempts.every((a) => a.status !== "delivered"));
    assert.equal(attempts.find((a) => a.channel === "push")?.status, "pending");
  });

  it("push switched off by the traveller: the warning row still exists; the push is `suppressed`", async () => {
    capture();
    const { db, inserted, attempts } = fakeDb({ ledger: "empty", pushEnabled: false, safetyOverride: false });
    await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW")));
    await flush(); await flush();
    assert.equal(inserted.length, 1);
    assert.equal(attempts.find((a) => a.channel === "push")?.status, "suppressed");
  });
});

// ─── 5. quiet hours, permissions, safety override ───────────────────────────

describe("LAY-4a: notification permissions and the safety override decide first", () => {
  for (const action of ["leave_now", "get_help"] as const) {
    it(`${action}, quiet hours, safety override ON: pierces (urgent rung)`, async () => {
      const sent = capture();
      await new NotificationRouter(fakeDb({ quiet: true, safetyOverride: true }).db).route(warningRow(action, "urgent"));
      assert.equal(sent.length, 1);
    });
    it(`${action}, quiet hours, safety override OFF: not pierced, logged suppressed`, async () => {
      const sent = capture();
      const { db, attempts } = fakeDb({ quiet: true, safetyOverride: false });
      await new NotificationRouter(db).route(warningRow(action, "urgent"));
      assert.equal(sent.length, 0);
      assert.equal(attempts.find((a) => a.channel === "push")?.status, "suppressed");
    });
  }
  it("start heading back respects quiet hours even with the safety override ON", async () => {
    const sent = capture();
    await new NotificationRouter(fakeDb({ quiet: true, safetyOverride: true }).db).route(warningRow("start_heading_back", "important"));
    assert.equal(sent.length, 0);
  });
  it("switch ON does not change any of that: quiet hours + override OFF still suppresses a capable device", async () => {
    process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED = "true";
    const sent = capture();
    await new NotificationRouter(fakeDb({ quiet: true, safetyOverride: false, devices: [{ push_token: "ExponentPushToken[new_ios]", ios_time_sensitive_capable: true }] }).db).route(warningRow("leave_now", "urgent"));
    assert.equal(sent.length, 0);
  });
});
