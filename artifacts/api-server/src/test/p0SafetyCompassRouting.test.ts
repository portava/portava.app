/**
 * census-telegraph T254 (W5S.1, 2026-10-17) — every §19 P0 SAFETY event is
 * interruptive under the EXISTING rule, through the real NotificationRouter
 * and the real Compass gate.
 *
 * THE DEFECT
 *   `circle.need_help_host_alert` (a Circle member asked for help; the host is
 *   told) is urgent and filed P0_SAFETY by the attention ladder. But
 *   NotificationRouter's Compass type map read its NAME: "circle" filed it as
 *   activity_social (Compass level 7), and level 7 obeys quiet hours. So the
 *   Compass gate held it with `quiet_hours_active` even when the recipient
 *   kept their safety_override ON, the one setting that exists to let exactly
 *   this through. The other five P0 types (safe_return.* x4, telegraph.sos)
 *   escaped only because their names happen to contain "safe_return" / "sos".
 *
 * THE FIX
 *   The router maps every attentionLadder P0_SAFETY event to emergency_safety
 *   by its BAND. Nothing new is decided: the existing rule (filterChannels'
 *   urgent + safety_override) now reaches every P0 type. Quiet hours and
 *   push-off yield only to the recipient's own safety_override; with the
 *   override OFF the push is still held.
 *
 * WHAT TURNS THIS RED
 *   - the band check removed: the circle alert held in quiet hours again;
 *   - the check widened beyond P0 (any band, or P1): an ordinary circle type
 *     or the P1 meeting-point update reaching emergency_safety;
 *   - a P0 alert piercing a recipient's safety_override OFF;
 *   - a type joining or leaving the ladder's P0 set without this file (and
 *     routerRegression's INTENDED) being reviewed.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/p0SafetyCompassRouting.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { _setTestFetch } from "../lib/push.js";
import { TEMPLATES } from "../services/notifications/NotificationTemplateService.js";
import type { NotificationRow } from "../services/notifications/NotificationService.js";
import { NotificationRouter } from "../services/notifications/NotificationRouter.js";
import { runRouterMatrix, type Decision } from "../services/notifications/__tests__/routerDecisionMatrix.js";
import { bandFor } from "../domain/telegraph/policies/attentionLadder.js";

const CIRCLE_ALERT = "circle.need_help_host_alert";
const P0_TYPES = TEMPLATES.filter((t) => bandFor(t.eventType) === "P0_SAFETY");
// Ordinary circle activity: an every-day check-in, the P1 neighbour (a meetup
// moved), and an invite. None is a safety event; none may change.
const ORDINARY_CIRCLE = ["circle.checkin", "circle.meeting_point_updated", "trip_crew.circle_invite"];
const SWITCHES = ["off", "on"] as const;

describe("T254: every P0 safety event, through the real NotificationRouter + Compass gate", () => {
  let decisions: Decision[] = [];
  before(async () => {
    const pick = (e: string) => TEMPLATES.find((t) => t.eventType === e)!;
    decisions = await runRouterMatrix(NotificationRouter as any, _setTestFetch, [...P0_TYPES, ...ORDINARY_CIRCLE.map(pick)]);
  });
  const one = (sw: string, scenario: string, eventType: string, priority: string) => {
    const t = TEMPLATES.find((x) => x.eventType === eventType)!;
    const d = decisions.filter((x) => x.key.startsWith(`${sw}|${scenario}|${t.category}|${eventType}|${priority}#`));
    assert.equal(d.length, 1, `${sw} ${scenario} ${eventType} ${priority}`);
    const push = (d[0]!.attempts as Array<{ channel: string; status: string; error: string | null }>).filter((a) => a.channel === "push");
    return { pushed: d[0]!.sent.length > 0, push };
  };

  it("the ladder's P0 set is exactly the six safety events, each urgent and filed safe_return", () => {
    assert.deepEqual(P0_TYPES.map((t) => t.eventType).sort(), [
      CIRCLE_ALERT, "safe_return.check_in_prompt", "safe_return.missed", "safe_return.reminder",
      "safe_return.trusted_circle_alert", "telegraph.sos",
    ]);
    for (const t of P0_TYPES) {
      assert.equal(t.defaultPriority, "urgent", t.eventType);
      assert.equal(t.category, "safe_return", t.eventType);
      assert.ok(t.defaultChannels.includes("push"), t.eventType);
    }
  });

  it("circle.need_help_host_alert in quiet hours with the recipient's safety_override ON is PUSHED (was held: quiet_hours_active)", () => {
    for (const sw of SWITCHES) {
      const d = one(sw, "quiet+override", CIRCLE_ALERT, "urgent");
      assert.equal(d.pushed, true, `${sw}: P0 is interruptive; the Compass gate must read it as emergency_safety`);
      assert.deepEqual(d.push.map((a) => a.status), ["sent"], sw);
    }
  });

  it("…with the override OFF it is HELD: quiet hours yield only to the recipient's own setting", () => {
    for (const sw of SWITCHES) {
      const d = one(sw, "quiet-override", CIRCLE_ALERT, "urgent");
      assert.equal(d.pushed, false, sw);
      assert.deepEqual(d.push.map((a) => a.status), ["suppressed"], sw);
    }
  });

  it("…with push OFF and the override ON it is PUSHED, and with defaults it is pushed", () => {
    for (const sw of SWITCHES) {
      assert.equal(one(sw, "push_off", CIRCLE_ALERT, "urgent").pushed, true, sw);
      assert.equal(one(sw, "defaults", CIRCLE_ALERT, "urgent").pushed, true, sw);
    }
  });

  it("every P0 type obeys the same rule: pushed in quiet hours and with push off under the override, held with it off", () => {
    for (const t of P0_TYPES) for (const sw of SWITCHES) {
      assert.equal(one(sw, "quiet+override", t.eventType, "urgent").pushed, true, `${sw} ${t.eventType} quiet+override`);
      assert.equal(one(sw, "push_off", t.eventType, "urgent").pushed, true, `${sw} ${t.eventType} push_off`);
      assert.equal(one(sw, "quiet-override", t.eventType, "urgent").pushed, false, `${sw} ${t.eventType} quiet-override`);
    }
  });

  it("the circle alert now routes EXACTLY as safe_return.missed in every setting and switch position", () => {
    const norm = (eventType: string) => decisions
      .filter((d) => d.key.split("|")[3] === eventType)
      .map((d) => JSON.stringify({ key: d.key.replace(/\|[^|]+\|(urgent)#\d+$/, "|$1"), sent: d.sent, attempts: d.attempts })
        .replaceAll(eventType, "EVT").replace(/"notificationId":"n-\d+"/g, '"notificationId":"N"'));
    const circle = norm(CIRCLE_ALERT);
    assert.equal(circle.length, 8, "4 settings x 2 switch positions");
    assert.deepEqual(circle, norm("safe_return.missed"));
  });

  it("ordinary circle activity is unchanged: still held in quiet hours (at urgent, by the Compass gate's quiet_hours_active)", () => {
    for (const e of ORDINARY_CIRCLE) for (const sw of SWITCHES) {
      const t = TEMPLATES.find((x) => x.eventType === e)!;
      assert.equal(one(sw, "defaults", e, t.defaultPriority).pushed, true, `${sw} ${e} defaults`);
      assert.equal(one(sw, "quiet+override", e, t.defaultPriority).pushed, false, `${sw} ${e} quiet at default priority`);
      const urgent = one(sw, "quiet+override", e, "urgent");
      assert.equal(urgent.pushed, false, `${sw} ${e}: urgent is not P0; level 7 still obeys quiet hours`);
      assert.deepEqual(urgent.push.map((a) => `${a.status}:${a.error}`), ["suppressed:quiet_hours_active"], `${sw} ${e}`);
    }
  });
});

// ── the Compass gate's own record: which level each template reaches ────────

const USER = "aa000000-0000-4000-8000-0000000000ab";
function gateRecordingDb() {
  const gate: Array<Record<string, unknown>> = [];
  const rows: Record<string, any[]> = {
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }, { flag: "notifications_enabled", enabled: true }],
    notification_preferences: [{
      user_id: USER, push_enabled: true, email_enabled: false, in_app_enabled: true, digests_enabled: false,
      safety_override: true, quiet_hours_enabled: true, quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC",
      message_previews: true, location_previews: false,
    }],
    notification_devices: [{ user_id: USER, push_token: "ExponentPushToken[a]" }],
    profiles: [{ id: USER, expo_push_token: null }],
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
        insert(row: any) { inserting = row; if (table === "compass_notification_decisions") gate.push({ ...row }); return b; },
        maybeSingle() { return Promise.resolve({ data: inserting ? { id: "x", ...inserting } : list()[0] ?? null, error: null }); },
        single() { return b.maybeSingle(); },
        then(res: any, rej: any) { return Promise.resolve({ data: inserting ? [{ id: "x" }] : list(), error: null, count: 0 }).then(res, rej); },
      };
      return b;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  return { db, gate };
}

describe("T254: the Compass gate's level for every push template (its own decision record)", () => {
  const level = new Map<string, { type: unknown; level: unknown; outcome: unknown; reason: unknown }>();
  before(async () => {
    _setTestFetch((async (_u: unknown, init?: RequestInit) => {
      const m = JSON.parse(String(init?.body ?? "[]"));
      return new Response(JSON.stringify({ data: m.map(() => ({ status: "ok", id: "r" })) }), { status: 200 });
    }) as typeof fetch);
    try {
      let i = 0;
      for (const t of TEMPLATES) {
        if (!t.defaultChannels.includes("push")) continue;
        const { db, gate } = gateRecordingDb();
        // urgent, so filterChannels (urgent + safety_override) carries push to the gate in quiet hours
        await new NotificationRouter(db).route({
          id: `g-${i}`, userId: USER, category: t.category, eventType: t.eventType, priority: "urgent",
          title: "Title", body: "Body", actionUrl: "/x", imageUrl: null, sourceType: "src", sourceId: `s-${i++}`, actorId: null,
          metadata: {}, privacyLevel: "standard", readAt: null, dismissedAt: null, expiresAt: null, createdAt: "2026-10-17T00:00:00.000Z",
        } as unknown as NotificationRow);
        if (gate.length === 1) {
          level.set(t.eventType, { type: gate[0]!.notification_type, level: gate[0]!.priority_level, outcome: gate[0]!.outcome, reason: gate[0]!.suppression_reason });
        }
      }
    } finally { _setTestFetch(null); }
  });

  it("every P0_SAFETY event reaches the gate as emergency_safety (level 1) and is sent in quiet hours", () => {
    assert.equal(P0_TYPES.length, 6);
    for (const t of P0_TYPES) {
      assert.deepEqual(level.get(t.eventType), { type: "emergency_safety", level: 1, outcome: "sent", reason: null }, t.eventType);
    }
  });

  it("ordinary circle templates are still activity_social (level 7), held in quiet hours by the gate", () => {
    const ordinary = TEMPLATES.filter((t) => /circle/.test(t.eventType) && bandFor(t.eventType) !== "P0_SAFETY" && t.defaultChannels.includes("push"));
    assert.ok(ordinary.length >= 7, `${ordinary.length} ordinary circle push templates`);
    for (const t of ordinary) {
      assert.deepEqual(level.get(t.eventType), { type: "activity_social", level: 7, outcome: "suppressed_quiet_hours", reason: "quiet_hours_active" }, t.eventType);
    }
  });

  it("the band check reaches nothing outside P0: every non-P0 emergency_safety template already matched by name", () => {
    const viaName = [...level.entries()].filter(([e, v]) => v.type === "emergency_safety" && bandFor(e) !== "P0_SAFETY").map(([e]) => e).sort();
    for (const e of viaName) assert.match(e.toLowerCase(), /sos|safe_return|danger/, `${e} reached emergency_safety without a name match`);
    // The one non-P0 template at level 1 is the P1 "they are back", by its name, exactly as on main
    // (it is `normal`, so filterChannels still holds it in quiet hours).
    assert.deepEqual(viaName, ["safe_return.cleared"]);
    assert.ok(level.size > 50, `${level.size} push templates reached the gate`);
  });
});
