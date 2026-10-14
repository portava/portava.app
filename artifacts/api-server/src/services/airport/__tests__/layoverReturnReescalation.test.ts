/**
 * census-layover L99 — verifier V-L99 on main 9e60178be (ACCEPT-WITH-FIXES), its
 * D1 and D2, against owner ruling OD-1012-LAY-1: "notify when the required action
 * changes, and suppress duplicates. Do not suppress an essential return warning
 * merely because its scheduled time is unchanged."
 *
 * D1 (MED). The warning's identity is `<session>:<action>` with rule 4's 30-minute
 * window. A RE-escalation after an intervening ease was suppressed as a duplicate:
 *   T0     RETURN_SOON → RETURN_NOW   "leave now" written
 *   T0+5   RETURN_NOW  → NORMAL       "your layover window moved" (a compass row)
 *   T0+10  NORMAL      → RETURN_NOW   → { emitted: false, reason: "duplicate_or_refused" }
 * The traveller's last instruction was "you have more time"; LAY-1 calls the new
 * "leave now" an action change. Now a same-action row is a duplicate only when no
 * notice about the session was written after it (another action's warning, or an
 * opportunity notice — the eased one included).
 *
 * D2 (LOW). An ease that is still actionable (get help → start heading back) is an
 * opportunity notice, never a warning; nothing pinned that.
 *
 * Also: an INSERT failure is reported as `insert_failed`, not as a duplicate.
 *
 * The ledger here is a store that FILTERS: it answers the dedup read and the
 * superseding-notice read by the columns they name, so the probe is the
 * verifier's, run against the real notifier, dedup service and router.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/airport/__tests__/layoverReturnReescalation.test.ts
 */
import { describe, it, afterEach, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { shouldNotify, type OpportunityEvent, type ActionUniverseDiff } from "../LayoverEventReplanner.js";
import { layoverReturnWarningPayload, notifyLayoverOpportunity, returnWarningSupersededSince, LAYOVER_OPPORTUNITY_EVENT_TYPE } from "../LayoverOpportunityNotifier.js";
import * as Budget from "../../notifications/essentialAttemptBudget.js";
import { _setTestFetch } from "../../../lib/push.js";
import type { LayoverReturnState } from "../LayoverSafetyEngine.js";

const USER = "ab000000-0000-4000-8000-0000000000ab";
const T0 = Date.parse("2026-10-14T10:00:00.000Z");
const MIN = 60_000;

const budget = Budget as unknown as { _resetEssentialAttemptBudget?: () => void };
/** No case may reach the network: a route still in flight when a case ends gets this, never a real fetch. */
const noNetwork = async () => new Response("test: no network", { status: 503 });
beforeEach(() => { budget._resetEssentialAttemptBudget?.(); _setTestFetch(async (_u, init) => new Response(JSON.stringify({ data: JSON.parse(String(init?.body ?? "[]")).map(() => ({ status: "ok", id: "r" })) }), { status: 200 })); });
afterEach(() => { _setTestFetch(noNetwork); mock.timers.reset(); });
after(() => { _setTestFetch(null); });

// ─── fixtures ───────────────────────────────────────────────────────────────

function states(before: LayoverReturnState, after: LayoverReturnState): ActionUniverseDiff {
  return {
    verdictChanged: false, returnStateChanged: before !== after, tierChanged: false,
    usableMinutesDelta: 0, deadlineDeltaMinutes: 0,
    candidatesGained: [], candidatesLost: [], candidatesUnmeasured: [],
    reasonCodesAdded: [], reasonCodesRemoved: [],
    returnStateBefore: before, returnStateAfter: after,
  };
}
let seq = 0;
function publication(sessionId: string, d: ActionUniverseDiff) {
  const o = { replannerVersion: "t", sessionId, causedByEventId: `e${++seq}`, causedByEventType: "flight.departure_delayed", diff: d, reasonCodes: [], why: ["the return state changed"] } as unknown as OpportunityEvent;
  return {
    wiringVersion: "w", replannerVersion: "r",
    event: { eventId: `e${seq}`, eventType: "flight.departure_delayed", occurredAt: "t", receivedAt: "t", source: "portava.layover.session_edit", dedupKey: `dk-${seq}`, confidence: "stated" },
    diff: d, invalidation: {}, opportunity: { why: o.why, reasonCodes: [] },
    notify: shouldNotify(o), disruptionState: null, certification: {}, reasonCodes: [],
    snapshotPersisted: false, snapshotUnavailableReason: "no_snapshot_storage",
    counts: { impacted: 1, replanned: 1, skipped: 0, notifications: 1 },
  } as any;
}

interface LedgerOpts {
  /** The superseding-notice read (it alone selects `created_at` by `action_url`) fails; every other read works. */
  supersedeUnreadable?: boolean;
  /** The notifications INSERT fails. */
  insertFails?: boolean;
}
/** One in-memory database for the notifier, the dedup service and the router; `notifications` FILTERS. */
function ledgerDb(o: LedgerOpts = {}) {
  const notifications: Array<Record<string, any>> = [];
  const rows: Record<string, any[]> = {
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }, { flag: "notifications_enabled", enabled: true }],
    notification_preferences: [{
      user_id: USER, push_enabled: true, email_enabled: false, in_app_enabled: true, digests_enabled: false,
      safety_override: true, quiet_hours_enabled: false, quiet_start: "00:00", quiet_end: "00:00", timezone: "UTC",
      message_previews: true, location_previews: false,
    }],
    notification_devices: [{ user_id: USER, push_token: "ExponentPushToken[ios1]", ios_time_sensitive_capable: null }],
    profiles: [{ id: USER, expo_push_token: null }],
  };
  let n = 0;
  const db: any = {
    from(table: string) {
      let insertRow: any = null;
      let patch: any = null;
      let selectCols = "";
      let orderDesc: string | null = null;
      let limitN: number | null = null;
      const filters: Array<(r: any) => boolean> = [];
      const named = new Set<string>();
      const settle = () => {
        if (table === "notifications" && insertRow) {
          if (o.insertFails) return { data: null, error: { message: "insert failed: connection reset", code: "08006" } };
          const row = { id: `n-${++n}`, created_at: new Date().toISOString(), ...insertRow };
          notifications.push(row);
          return { data: row, error: null };
        }
        if (insertRow || patch) return { data: insertRow ? { id: "x", ...insertRow } : null, error: null };
        if (table === "notifications") {
          if (o.supersedeUnreadable && named.has("action_url") && selectCols.includes("created_at")) {
            return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
          }
          let out = notifications.filter((r) => filters.every((f) => f(r)));
          if (orderDesc) out = [...out].sort((a, b) => (a[orderDesc!] < b[orderDesc!] ? 1 : a[orderDesc!] > b[orderDesc!] ? -1 : 0));
          if (limitN !== null) out = out.slice(0, limitN);
          return { data: out, error: null };
        }
        return { data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null, count: 0 };
      };
      const b: any = {
        select(c?: string) { selectCols = c ?? ""; return b; },
        eq(c: string, v: any) { named.add(c); filters.push((r) => (table === "notifications" ? r[c] === v : r[c] === undefined || r[c] === v)); return b; },
        in(c: string, vs: any[]) { named.add(c); filters.push((r) => vs.includes(r[c])); return b; },
        gt(c: string, v: any) { named.add(c); filters.push((r) => Date.parse(r[c]) > Date.parse(v)); return b; },
        gte() { return b; }, lt() { return b; }, is() { return b; }, neq() { return b; },
        order(c: string, opts?: { ascending?: boolean }) { if (opts?.ascending === false) orderDesc = c; return b; },
        limit(k: number) { limitN = k; return b; },
        update(p: any) { patch = p; return b; },
        insert(row: any) { insertRow = row; return b; },
        maybeSingle() { const r = settle(); return Promise.resolve(Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r); },
        single() { return b.maybeSingle(); },
        then(res: any, rej: any) { return Promise.resolve(settle()).then(res, rej); },
      };
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { db, notifications };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
async function at(ms: number, db: any, sessionId: string, before: LayoverReturnState, afterState: LayoverReturnState) {
  mock.timers.setTime(ms);
  const out = await notifyLayoverOpportunity(db, USER, sessionId, publication(sessionId, states(before, afterState)));
  await flush();
  return out;
}

// ─── D1: a re-escalation after an intervening ease is an action change ──────

describe("V-L99 D1 — a re-escalation after an intervening ease is NOT a duplicate", () => {
  it("THE PROBE: leave now, eased (told), leave now again inside 30 minutes → the second leave now goes out (red on 9e60178be)", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb();
    const first = await at(T0, db, "s-probe", "RETURN_SOON", "RETURN_NOW");
    assert.equal(first.emitted && first.returnWarning, "leave_now");
    const eased = await at(T0 + 5 * MIN, db, "s-probe", "RETURN_NOW", "NORMAL");
    assert.equal(eased.emitted, true, "the ease is told (an opportunity notice)");
    assert.equal(eased.emitted && eased.returnWarning, undefined, "the ease is not a return warning");
    const again = await at(T0 + 10 * MIN, db, "s-probe", "NORMAL", "RETURN_NOW");
    assert.deepEqual(again.emitted, true, `suppressed: ${JSON.stringify(again)}`);
    assert.equal(again.emitted && again.returnWarning, "leave_now");
    assert.deepEqual(
      notifications.map((r) => [r.event_type, r.source_type]),
      [["layover.return.leave_now", "layover_return"], [LAYOVER_OPPORTUNITY_EVENT_TYPE, "layover_replan"], ["layover.return.leave_now", "layover_return"]],
    );
  });

  it("CONTROL (unchanged): the same action again with NOTHING said in between is still a duplicate", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb();
    await at(T0, db, "s-dup", "RETURN_SOON", "RETURN_NOW");
    const again = await at(T0 + 5 * MIN, db, "s-dup", "RETURN_SOON", "RETURN_NOW");
    assert.deepEqual(again, { emitted: false, reason: "duplicate_or_refused" });
    assert.equal(notifications.length, 1);
  });

  it("a notice about ANOTHER session does not reset this one's duplicate", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb();
    await at(T0, db, "s-a", "RETURN_SOON", "RETURN_NOW");
    await at(T0 + 3 * MIN, db, "s-b", "RETURN_SOON", "RETURN_NOW");
    await at(T0 + 4 * MIN, db, "s-b", "RETURN_NOW", "NORMAL");
    const again = await at(T0 + 6 * MIN, db, "s-a", "RETURN_SOON", "RETURN_NOW");
    assert.deepEqual(again, { emitted: false, reason: "duplicate_or_refused" });
    assert.equal(notifications.filter((r) => r.source_id === "s-a:leave_now").length, 1);
  });

  it("another ACTION's warning written after it resets it too (leave now → get help → leave now)", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb();
    await at(T0, db, "s-gh", "RETURN_SOON", "RETURN_NOW");
    const help = await at(T0 + 4 * MIN, db, "s-gh", "RETURN_NOW", "CONNECTION_AT_RISK");
    assert.equal(help.emitted && help.returnWarning, "get_help");
    const again = await at(T0 + 8 * MIN, db, "s-gh", "RETURN_SOON", "RETURN_NOW");
    assert.equal(again.emitted && again.returnWarning, "leave_now");
    assert.equal(notifications.filter((r) => r.source_id === "s-gh:leave_now").length, 2);
  });

  it("an OLDER notice does not stretch the window: a same-action row outside 30 minutes never suppresses", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb();
    await at(T0, db, "s-old", "RETURN_NOW", "NORMAL");           // a notice about the session, written first
    await at(T0 + 2 * MIN, db, "s-old", "RETURN_SOON", "RETURN_NOW"); // then leave now, nothing after it
    const later = await at(T0 + 40 * MIN, db, "s-old", "RETURN_SOON", "RETURN_NOW");
    assert.equal(later.emitted && later.returnWarning, "leave_now", "rule 4's window still bounds the duplicate");
    assert.equal(notifications.filter((r) => r.source_id === "s-old:leave_now").length, 2);
  });

  it("a superseding-notice read that FAILS: the essential is attempted, within its bound (2 per 30 minutes)…", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb();
    await at(T0, db, "s-unk", "RETURN_SOON", "RETURN_NOW");
    const unreadable = ledgerDb({ supersedeUnreadable: true });
    unreadable.notifications.push(...notifications);
    const outs = [];
    for (let i = 1; i <= 4; i++) outs.push(await at(T0 + i * MIN, unreadable.db, "s-unk", "RETURN_SOON", "RETURN_NOW"));
    assert.deepEqual(outs.map((x) => x.emitted), [true, true, false, false]);
    assert.equal(unreadable.notifications.filter((r) => r.source_id === "s-unk:leave_now").length, 3);
  });

  it("…and a NON-essential (start heading back) keeps the duplicate answer", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb({ supersedeUnreadable: true });
    notifications.push({ id: "prior", user_id: USER, category: "airport", event_type: "layover.return.start_heading_back", source_type: "layover_return", source_id: "s-ne:start_heading_back", action_url: "/airport/sessions/s-ne", created_at: new Date(T0).toISOString() });
    const again = await at(T0 + 5 * MIN, db, "s-ne", "NORMAL", "RETURN_SOON");
    assert.deepEqual(again, { emitted: false, reason: "duplicate_or_refused" });
  });

  it("returnWarningSupersededSince: the newest OTHER notice about this session; null when none; `unknown` on a failed read", async () => {
    const { db, notifications } = ledgerDb();
    const row = (sid: string, type: string, source: string, iso: string, url = "/airport/sessions/s1") => ({ user_id: USER, source_type: type, source_id: source, action_url: url, created_at: iso, category: "airport", event_type: "x" });
    assert.equal(await returnWarningSupersededSince(db, USER, "s1", "s1:leave_now"), null);
    notifications.push(row("s1", "layover_return", "s1:leave_now", "2026-10-14T10:00:00.000Z"));
    assert.equal(await returnWarningSupersededSince(db, USER, "s1", "s1:leave_now"), null, "its own identity never supersedes itself");
    notifications.push(row("s1", "layover_replan", "dk-9", "2026-10-14T10:05:00.000Z"));
    notifications.push(row("s2", "layover_replan", "dk-10", "2026-10-14T10:07:00.000Z", "/airport/sessions/s2"));
    notifications.push(row("s1", "trip_update", "t", "2026-10-14T10:08:00.000Z"));
    assert.equal(await returnWarningSupersededSince(db, USER, "s1", "s1:leave_now"), "2026-10-14T10:05:00.000Z");
    const broken = ledgerDb({ supersedeUnreadable: true });
    assert.equal(await returnWarningSupersededSince(broken.db, USER, "s1", "s1:leave_now"), "unknown");
    assert.equal(await returnWarningSupersededSince({ from() { throw new Error("socket hang up"); } } as any, USER, "s1", "s1:leave_now"), "unknown");
  });
});

// ─── D2: an ease that is still actionable is told, never as a warning ───────

describe("V-L99 D2 — an EASED action that is still actionable is an opportunity notice, not a warning", () => {
  it("get help → start heading back (CONNECTION_AT_RISK → RETURN_SOON): no warning payload", () => {
    const p = publication("s-d2", states("CONNECTION_AT_RISK", "RETURN_SOON"));
    assert.equal(p.notify.notify, true, "the ease is notify-worthy");
    assert.equal(p.notify.returnAction?.escalated, false);
    assert.equal(p.notify.returnAction?.actionable, true);
    assert.equal(layoverReturnWarningPayload("s-d2", p), null);
  });

  it("…and what goes out is the opportunity notice (compass), not `layover.return.start_heading_back`", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb();
    const out = await at(T0, db, "s-d2b", "CONNECTION_AT_RISK", "RETURN_SOON");
    assert.equal(out.emitted, true);
    assert.equal(out.emitted && out.returnWarning, undefined);
    assert.deepEqual(notifications.map((r) => [r.event_type, r.category]), [[LAYOVER_OPPORTUNITY_EVENT_TYPE, "compass"]]);
  });
});

// ─── an insert failure is not a duplicate ───────────────────────────────────

describe("V-L99 minor — an INSERT failure is named, not called a duplicate", () => {
  it("the warning's row cannot be written → `insert_failed`", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    const { db, notifications } = ledgerDb({ insertFails: true });
    const out = await at(T0, db, "s-ins", "RETURN_SOON", "RETURN_NOW");
    assert.deepEqual(out, { emitted: false, reason: "insert_failed" });
    assert.equal(notifications.length, 0);
  });
});
