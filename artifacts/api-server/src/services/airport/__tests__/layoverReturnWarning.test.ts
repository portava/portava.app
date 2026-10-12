/**
 * Owner rulings 2026-10-12 (docs/ops/owner-decisions-20261012.md):
 *
 *   OD-1012-LAY-1 — "prioritize actionable return warnings, notify when the
 *   required action changes, and suppress duplicates. Do not suppress an
 *   essential return warning merely because its scheduled time is unchanged."
 *
 *   OD-1012-LAY-4 — "Implement and test appropriate Apple time-sensitive
 *   notification support, respecting user settings and normal-delivery
 *   fallback. Never treat push delivery as guaranteed."
 *
 * What was wrong on main (2c3323167), each pinned below:
 *   - step 8 (`shouldNotify`) had no notion of a REQUIRED ACTION: a return
 *     state that escalated was notified only as "your layover options changed",
 *     behind a deadline-direction proxy, and an eased action never;
 *   - the one push the layover sends was a `compass` WORLD CHANGE, so the
 *     Attention Engine could budget a "leave now" away to the Wall, and quiet
 *     hours dropped it whatever the ladder said (`urgent` pierces them);
 *   - an unreadable notification ledger suppressed every notification as a
 *     "duplicate", a "leave now" included;
 *   - no push carried a channel, a priority or an iOS interruption level.
 *
 * Mutation log: see the census section (census-layover §66) — each mutant was
 * applied alone, this suite run, the source restored.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/airport/__tests__/layoverReturnWarning.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  RETURN_ESCALATION_LADDER,
  returnRequiredAction,
  returnActionChange,
  returnWarningPushDelivery,
  returnWarningEventType,
  returnWarningSourceId,
  iosTimeSensitivePushEntitled,
  returnNotificationPosture,
  LAYOVER_RETURN_PUSH_CHANNEL_ID,
} from "../LayoverReturnEscalation.js";
import { shouldNotify, type OpportunityEvent, type ActionUniverseDiff } from "../LayoverEventReplanner.js";
import { layoverReturnWarningPayload, notifyLayoverOpportunity } from "../LayoverOpportunityNotifier.js";
import { NotificationRouter } from "../../notifications/NotificationRouter.js";
import { sendPushNotification, _setTestFetch } from "../../../lib/push.js";
import type { LayoverReturnState } from "../LayoverSafetyEngine.js";

const USER = "aa000000-0000-4000-8000-0000000000aa";

afterEach(() => { _setTestFetch(null); delete process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED; });

// ─── fixtures ───────────────────────────────────────────────────────────────

function diff(over: Partial<ActionUniverseDiff> = {}): ActionUniverseDiff {
  return {
    verdictChanged: false, returnStateChanged: false, tierChanged: false,
    usableMinutesDelta: 0, deadlineDeltaMinutes: 0,
    candidatesGained: [], candidatesLost: [], candidatesUnmeasured: [],
    reasonCodesAdded: [], reasonCodesRemoved: [],
    ...over,
  };
}
function states(before: LayoverReturnState, after: LayoverReturnState, over: Partial<ActionUniverseDiff> = {}) {
  return diff({ returnStateChanged: before !== after, returnStateBefore: before, returnStateAfter: after, ...over });
}
function op(d: ActionUniverseDiff): OpportunityEvent {
  return { replannerVersion: "t", sessionId: "s1", causedByEventId: "e1", causedByEventType: "flight.departure_delayed", diff: d, reasonCodes: [], why: ["the return state changed"] } as OpportunityEvent;
}
function publication(d: ActionUniverseDiff) {
  const o = op(d);
  return {
    wiringVersion: "w", replannerVersion: "r",
    event: { eventId: "e1", eventType: "flight.departure_delayed", occurredAt: "t", receivedAt: "t", source: "portava.layover.session_edit", dedupKey: "dk-1", confidence: "stated" },
    diff: d, invalidation: {}, opportunity: { why: o.why, reasonCodes: o.reasonCodes },
    notify: shouldNotify(o), disruptionState: null, certification: {}, reasonCodes: [],
    snapshotPersisted: false, snapshotUnavailableReason: "no_snapshot_storage",
    counts: { impacted: 1, replanned: 1, skipped: 0, notifications: 1 },
  } as any;
}

// ─── 1. the required action, off the ladder ─────────────────────────────────

describe("LAY-1: the required action is the ladder's, one per rung", () => {
  it("explore → start_heading_back → leave_now → get_help, in ladder order", () => {
    assert.deepEqual(
      (["NORMAL", "RETURN_SOON", "RETURN_NOW", "CONNECTION_AT_RISK"] as const).map(returnRequiredAction),
      ["explore", "start_heading_back", "leave_now", "get_help"],
    );
    assert.equal(new Set(RETURN_ESCALATION_LADDER.map((r) => r.requiredAction)).size, RETURN_ESCALATION_LADDER.length);
  });

  it("the overview's posture publishes it (additive), with `actionable` from level >= 1", () => {
    assert.equal(returnNotificationPosture("NORMAL").actionable, false);
    assert.equal(returnNotificationPosture("RETURN_SOON").requiredAction, "start_heading_back");
    assert.equal(returnNotificationPosture("RETURN_SOON").actionable, true);
    assert.equal(returnNotificationPosture("RETURN_NOW").delivery, "not_sent_here");
  });

  it("a change is null when the action holds; escalated / actionable / essential otherwise", () => {
    assert.equal(returnActionChange("RETURN_NOW", "RETURN_NOW"), null);
    assert.deepEqual(returnActionChange("NORMAL", "RETURN_SOON"), { from: "explore", to: "start_heading_back", fromLevel: 0, toLevel: 1, escalated: true, actionable: true, essential: false });
    const now = returnActionChange("RETURN_SOON", "RETURN_NOW")!;
    assert.equal(now.essential, true);
    assert.equal(now.escalated, true);
    const eased = returnActionChange("RETURN_NOW", "NORMAL")!;
    assert.equal(eased.escalated, false);
    assert.equal(eased.actionable, false);
  });
});

// ─── 2. step 8: notify when the required action changes ─────────────────────

describe("LAY-1: §11.1 step 8 notifies on a change of REQUIRED ACTION, not of time", () => {
  it("an escalated action notifies HIGH and carries the change — ahead of a lost candidate", () => {
    const n = shouldNotify(op(states("NORMAL", "RETURN_SOON", { candidatesLost: ["c1"], deadlineDeltaMinutes: -40 })));
    assert.equal(n.notify, true);
    assert.equal(n.notify && n.priority, "high");
    assert.equal(n.notify && n.returnAction?.to, "start_heading_back");
    assert.match(n.notify ? n.reason : "", /required return action changed: explore -> start_heading_back/);
  });

  it("only the TIME moved (same action, deadline 25 min earlier): no notification", () => {
    const n = shouldNotify(op(states("RETURN_NOW", "RETURN_NOW", { deadlineDeltaMinutes: -25 })));
    assert.equal(n.notify, false);
  });

  it("an ESCALATION with a LATER deadline still notifies — the action, not the direction of the move, decides", () => {
    // The pre-LAY-1 proxy (`deadlineDeltaMinutes <= 0`) would have said nothing here.
    const n = shouldNotify(op(states("RETURN_SOON", "RETURN_NOW", { deadlineDeltaMinutes: 3 })));
    assert.equal(n.notify && n.priority, "high");
    assert.equal(n.notify && n.returnAction?.essential, true);
  });

  it("an EASED action notifies at NORMAL priority (the traveller may stop rushing)", () => {
    const n = shouldNotify(op(states("RETURN_NOW", "NORMAL", { deadlineDeltaMinutes: 120 })));
    assert.equal(n.notify, true);
    assert.equal(n.notify && n.priority, "normal");
    assert.equal(n.notify && n.returnAction?.escalated, false);
  });

  it("a diff without the two states keeps the old rule (an older caller)", () => {
    assert.equal(shouldNotify(op(diff({ returnStateChanged: true, deadlineDeltaMinutes: -10 }))).notify, true);
    assert.equal(shouldNotify(op(diff({ returnStateChanged: true, deadlineDeltaMinutes: 10 }))).notify, false);
  });
});

// ─── 3. the warning payload ─────────────────────────────────────────────────

describe("LAY-1: the return warning — prioritized, identified by session + action", () => {
  it("leave now: urgent, essential, its own event type; identity has NO deadline in it", () => {
    const w = layoverReturnWarningPayload("s1", publication(states("RETURN_SOON", "RETURN_NOW")))!;
    assert.equal(w.eventType, "layover.return.leave_now");
    assert.equal(w.priority, "urgent");
    assert.equal(w.essential, true);
    assert.equal(w.sourceType, "layover_return");
    assert.equal(w.sourceId, "s1:leave_now");
    assert.equal(w.title, "Head back to the airport now");
  });

  it("start heading back: important (the ladder's), not essential", () => {
    const w = layoverReturnWarningPayload("s1", publication(states("NORMAL", "RETURN_SOON")))!;
    assert.equal(w.priority, "important");
    assert.equal(w.essential, false);
  });

  it("an eased action, or no action change, is not a return warning", () => {
    assert.equal(layoverReturnWarningPayload("s1", publication(states("RETURN_NOW", "NORMAL"))), null);
    assert.equal(layoverReturnWarningPayload("s1", publication(states("RETURN_NOW", "RETURN_NOW", { candidatesLost: ["c"] }))), null);
  });
});

// ─── 4. emission: one interruption, duplicates suppressed, essentials kept ──

type LedgerMode = "empty" | "has_same" | "unreadable";
function notifierDb(ledger: LedgerMode) {
  const inserted: Array<Record<string, unknown>> = [];
  const db: any = {
    from(table: string) {
      let insertRow: any = null;
      const b: any = {
        select() { return b; }, eq() { return b; }, gt() { return b; }, gte() { return b; }, lt() { return b; },
        in() { return b; }, order() { return b; }, limit() { return b; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(row: any) { insertRow = row; if (table === "notifications") inserted.push(row); return b; },
        single() { return Promise.resolve({ data: { id: `n-${inserted.length}`, created_at: new Date().toISOString(), ...insertRow }, error: null }); },
        then(res: any, rej: any) {
          if (table === "notifications" && !insertRow) {
            const r = ledger === "unreadable" ? { data: null, error: { message: "connection reset", code: "08006" } }
              : { data: ledger === "has_same" ? [{ id: "earlier" }] : [], error: null };
            return Promise.resolve(r).then(res, rej);
          }
          return Promise.resolve({ data: [], error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
  return { db, inserted };
}

describe("LAY-1: emission — one interruption per event, duplicates suppressed, an essential never lost to an unreadable ledger", () => {
  const quietFetch = () => _setTestFetch(async (_u, init) => new Response(JSON.stringify({ data: JSON.parse(String(init?.body ?? "[]")).map(() => ({ status: "ok" })) }), { status: 200 }));

  it("an escalation to leave now writes ONE row — the warning, category airport — and no opportunity notice beside it", async () => {
    quietFetch();
    const { db, inserted } = notifierDb("empty");
    const out = await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW", { candidatesLost: ["c1"] })));
    assert.equal(out.emitted, true);
    assert.equal(out.emitted && out.returnWarning, "leave_now");
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.event_type, "layover.return.leave_now");
    assert.equal(inserted[0]!.category, "airport");
    assert.equal(inserted[0]!.priority, "urgent");
    assert.equal(inserted[0]!.source_id, "s1:leave_now");
  });

  it("the same action for the same session already in the ledger: a DUPLICATE, suppressed", async () => {
    const { db, inserted } = notifierDb("has_same");
    const out = await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW")));
    assert.deepEqual(out, { emitted: false, reason: "duplicate_or_refused" });
    assert.equal(inserted.length, 0);
  });

  it("an UNREADABLE ledger does not suppress the essential leave-now warning…", async () => {
    quietFetch();
    const { db, inserted } = notifierDb("unreadable");
    const out = await notifyLayoverOpportunity(db, USER, "s1", publication(states("RETURN_SOON", "RETURN_NOW")));
    assert.equal(out.emitted, true);
    assert.equal(inserted.length, 1);
  });

  it("…while a non-essential warning keeps the ledger's fail-closed answer", async () => {
    const { db, inserted } = notifierDb("unreadable");
    const out = await notifyLayoverOpportunity(db, USER, "s1", publication(states("NORMAL", "RETURN_SOON")));
    assert.equal(out.emitted, false);
    assert.equal(inserted.length, 0);
  });
});

// ─── 5. push delivery: priority, channel, iOS interruption level ────────────

describe("LAY-4: how a return-warning push is delivered", () => {
  it("time-sensitive is declared available ONLY by PUSH_IOS_TIME_SENSITIVE_ENTITLED=true", () => {
    assert.equal(iosTimeSensitivePushEntitled({}), false);
    for (const v of ["", "1", "yes", "TRUE", "false"]) assert.equal(iosTimeSensitivePushEntitled({ PUSH_IOS_TIME_SENSITIVE_ENTITLED: v }), false, v);
    assert.equal(iosTimeSensitivePushEntitled({ PUSH_IOS_TIME_SENSITIVE_ENTITLED: "true" }), true);
  });

  it("an actionable warning: high priority on layover_return; time-sensitive only when entitled; otherwise the normal level", () => {
    for (const a of ["start_heading_back", "leave_now", "get_help"] as const) {
      assert.deepEqual(returnWarningPushDelivery(returnWarningEventType(a), { timeSensitiveEntitled: false }), { priority: "high", channelId: LAYOVER_RETURN_PUSH_CHANNEL_ID });
      assert.deepEqual(returnWarningPushDelivery(returnWarningEventType(a), { timeSensitiveEntitled: true }), { priority: "high", channelId: "layover_return", interruptionLevel: "time-sensitive" });
    }
  });

  it("anything else asks for nothing extra — never `critical`", () => {
    assert.deepEqual(returnWarningPushDelivery(returnWarningEventType("explore"), { timeSensitiveEntitled: true }), {});
    assert.deepEqual(returnWarningPushDelivery("compass.layover.opportunity", { timeSensitiveEntitled: true }), {});
    assert.deepEqual(returnWarningPushDelivery("layover.return.bogus", { timeSensitiveEntitled: true }), {});
    assert.deepEqual(returnWarningPushDelivery(null, { timeSensitiveEntitled: true }), {});
  });

  it("sendPushNotification forwards interruptionLevel only when asked", async () => {
    const sent: any[] = [];
    const fetchImpl: typeof fetch = async (_u, init) => { const m = JSON.parse(String(init?.body)); sent.push(...m); return new Response(JSON.stringify({ data: m.map(() => ({ status: "ok" })) }), { status: 200 }); };
    await sendPushNotification(["ExponentPushToken[a]"], { title: "t", body: "b", interruptionLevel: "time-sensitive" }, { fetchImpl });
    await sendPushNotification(["ExponentPushToken[a]"], { title: "t", body: "b" }, { fetchImpl });
    assert.equal(sent[0].interruptionLevel, "time-sensitive");
    assert.equal("interruptionLevel" in sent[1], false);
  });
});

// ─── 6. the router: settings respected, not budgeted away, never "delivered" ─

function routerDb(opts: { quiet?: boolean; safetyOverride?: boolean; pushEnabled?: boolean } = {}) {
  const attempts: Array<Record<string, unknown>> = [];
  const rows: Record<string, any[]> = {
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }, { flag: "notifications_enabled", enabled: true }],
    notification_preferences: [{
      user_id: USER, push_enabled: opts.pushEnabled ?? true, email_enabled: false, in_app_enabled: true, digests_enabled: false,
      safety_override: opts.safetyOverride ?? true,
      quiet_hours_enabled: opts.quiet === true, quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC",
      message_previews: true, location_previews: false,
    }],
    notification_devices: [{ user_id: USER, push_token: "ExponentPushToken[ios1]" }],
    profiles: [{ id: USER, expo_push_token: null }],
  };
  const db: any = {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let inserting: any = null;
      const list = () => (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const b: any = {
        select() { return b; }, eq(c: string, v: any) { filters.push((r) => r[c] === undefined || r[c] === v); return b; },
        in() { return b; }, gt() { return b; }, gte() { return b; }, lt() { return b; }, order() { return b; }, limit() { return b; }, is() { return b; },
        insert(row: any) { inserting = row; if (table === "notification_delivery_attempts") attempts.push(row); return b; },
        maybeSingle() { return Promise.resolve({ data: inserting ? { id: "x", ...inserting } : list()[0] ?? null, error: null }); },
        single() { return b.maybeSingle(); },
        then(res: any, rej: any) { return Promise.resolve({ data: inserting ? [{ id: "x" }] : list(), error: null, count: 0 }).then(res, rej); },
      };
      return b;
    },
  };
  return { db, attempts };
}
function warningRow(action: "start_heading_back" | "leave_now", priority: "important" | "urgent") {
  return {
    id: `n-${action}`, userId: USER, category: "airport", eventType: returnWarningEventType(action), priority,
    title: "t", body: "b", actionUrl: "/airport/sessions/s1", imageUrl: null, sourceType: "layover_return",
    sourceId: returnWarningSourceId("s1", action), actorId: null, metadata: { returnWarning: { action } },
    privacyLevel: "standard", readAt: null, dismissedAt: null, expiresAt: null, createdAt: new Date().toISOString(),
  } as any;
}
function capture() {
  const sent: any[] = [];
  _setTestFetch(async (_u, init) => { const m = JSON.parse(String(init?.body ?? "[]")); sent.push(...m); return new Response(JSON.stringify({ data: m.map(() => ({ status: "ok", id: "r" })) }), { status: 200 }); });
  return sent;
}

describe("LAY-1 / LAY-4: the router delivers the warning as the traveller's settings allow", () => {
  it("leave now goes out high, on layover_return, at the NORMAL iOS level when no entitlement is declared", async () => {
    const sent = capture();
    const { db, attempts } = routerDb();
    await new NotificationRouter(db).route(warningRow("leave_now", "urgent"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].priority, "high");
    assert.equal(sent[0].channelId, "layover_return");
    assert.equal("interruptionLevel" in sent[0], false);
    const push = attempts.find((a) => a.channel === "push");
    assert.equal(push?.status, "sent", "a push handed to Expo is `sent` — NEVER `delivered`");
  });

  it("with the entitlement declared, the same push is time-sensitive", async () => {
    process.env.PUSH_IOS_TIME_SENSITIVE_ENTITLED = "true";
    const sent = capture();
    await new NotificationRouter(routerDb().db).route(warningRow("start_heading_back", "important"));
    assert.equal(sent[0].interruptionLevel, "time-sensitive");
  });

  it("quiet hours: leave now pierces them through the traveller's own safety override; start heading back does not", async () => {
    const sent = capture();
    await new NotificationRouter(routerDb({ quiet: true }).db).route(warningRow("leave_now", "urgent"));
    assert.equal(sent.length, 1, "the urgent rung is not dropped by quiet hours, nor budgeted away by the Attention Engine");
    const sent2 = capture();
    const quiet = routerDb({ quiet: true });
    await new NotificationRouter(quiet.db).route(warningRow("start_heading_back", "important"));
    assert.equal(sent2.length, 0);
    assert.equal(quiet.attempts.find((a) => a.channel === "push")?.status, "suppressed");
  });

  it("a traveller who turned the safety override OFF is not pierced, even for leave now", async () => {
    const sent = capture();
    await new NotificationRouter(routerDb({ quiet: true, safetyOverride: false }).db).route(warningRow("leave_now", "urgent"));
    assert.equal(sent.length, 0);
  });
});
