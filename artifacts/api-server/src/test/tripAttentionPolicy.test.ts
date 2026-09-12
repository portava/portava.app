/**
 * Trips spec §11.4 — the attention model IGNORE | PASSIVE | SURFACE | NOTIFY |
 * INTERRUPT, and the rule that every trip push passes it (lib/tripPush.ts);
 * §21.1 notification_actionability_rate. census-trips TR199, TR200, TR398.
 *
 * Run: node --import tsx/esm --test src/test/tripAttentionPolicy.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideAttention, mayPush, ATTENTION_LEVELS, TRIP_PUSH_EVENT_PROFILES, NOTIFY_BUDGET_PER_HOUR, DISCOVERY_EVENT_KINDS,
  type AttentionContext,
} from "../services/trips/TripAttentionPolicy.js";
import { sendTripPush, recordNotificationActed, readNotificationActionability, attentionLevelFor, _resetTripPushBudget } from "../lib/tripPush.js";
import { _setTestFetch } from "../lib/push.js";
import { readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const ctx = (o: Partial<AttentionContext> = {}): AttentionContext => ({ now: NOW, mode: "NORMAL", recentNotifyCount: 0, quietHours: false, ...o });
const ev = (kind: string, o: Partial<Parameters<typeof decideAttention>[0]> = {}) => ({ kind, significance: "high" as const, affectsViewer: true, actionable: false, ...o });

beforeEach(() => { _resetTripMetrics(); _resetTripPushBudget(); });

describe("§11.4 decideAttention — a cost ladder", () => {
  it("the five levels, in the spec's order; only the top two may push", () => {
    assert.deepEqual([...ATTENTION_LEVELS], ["IGNORE", "PASSIVE", "SURFACE", "NOTIFY", "INTERRUPT"]);
    assert.deepEqual(ATTENTION_LEVELS.map(mayPush), [false, false, false, true, true]);
  });
  it("significance sets the base level: none → IGNORE, low → PASSIVE, medium → SURFACE, high/critical → NOTIFY", () => {
    assert.equal(decideAttention(ev("x", { significance: "none" }), ctx()).level, "IGNORE");
    assert.equal(decideAttention(ev("x", { significance: "low" }), ctx()).level, "PASSIVE");
    assert.equal(decideAttention(ev("x", { significance: "medium" }), ctx()).level, "SURFACE");
    assert.equal(decideAttention(ev("x", { significance: "high" }), ctx()).level, "NOTIFY");
    assert.equal(decideAttention(ev("x", { significance: "critical" }), ctx()).level, "NOTIFY");
  });
  it("safety is always INTERRUPT — through quiet hours, an exhausted budget and a safety-event mode", () => {
    const d = decideAttention(ev("safety_needs_help", { safety: true }), ctx({ quietHours: true, recentNotifyCount: 99, mode: "SAFETY_EVENT" }));
    assert.equal(d.level, "INTERRUPT"); assert.deepEqual(d.reasons, ["SAFETY"]);
  });
  it("an onlooker's high-significance event is a SURFACE, not a push", () => {
    const d = decideAttention(ev("trip_invite_accepted", { affectsViewer: false }), ctx());
    assert.equal(d.level, "SURFACE"); assert.ok(d.reasons.includes("ONLOOKER"));
  });
  it("a deadline the viewer can act on raises the level: within 2 h → NOTIFY, within 30 min → INTERRUPT; a passed deadline lowers a push to SURFACE", () => {
    const soon = decideAttention(ev("x", { significance: "medium", actionable: true, deadlineAt: new Date(NOW + 60 * 60 * 1000).toISOString() }), ctx());
    assert.equal(soon.level, "NOTIFY"); assert.ok(soon.reasons.includes("ACTIONABLE_DEADLINE_SOON"));
    const imminent = decideAttention(ev("x", { significance: "medium", actionable: true, deadlineAt: new Date(NOW + 10 * 60 * 1000).toISOString() }), ctx());
    assert.equal(imminent.level, "INTERRUPT"); assert.ok(imminent.reasons.includes("ACTIONABLE_DEADLINE_IMMINENT"));
    const passed = decideAttention(ev("x", { significance: "high", actionable: true, deadlineAt: new Date(NOW - 1000).toISOString() }), ctx());
    assert.equal(passed.level, "SURFACE"); assert.ok(passed.reasons.includes("DEADLINE_PASSED"));
  });
  it("the hourly budget turns a NOTIFY into a SURFACE and says so; INTERRUPT is exempt; quiet hours do the same unless the deadline is soon", () => {
    const budget = decideAttention(ev("x"), ctx({ recentNotifyCount: NOTIFY_BUDGET_PER_HOUR }));
    assert.equal(budget.level, "SURFACE"); assert.equal(budget.unbudgetedLevel, "NOTIFY"); assert.ok(budget.reasons.includes("RATE_BUDGET_EXHAUSTED"));
    const under = decideAttention(ev("x"), ctx({ recentNotifyCount: NOTIFY_BUDGET_PER_HOUR - 1 }));
    assert.equal(under.level, "NOTIFY");
    const quiet = decideAttention(ev("x"), ctx({ quietHours: true }));
    assert.equal(quiet.level, "SURFACE"); assert.ok(quiet.reasons.includes("QUIET_HOURS"));
    const quietSoon = decideAttention(ev("x", { significance: "medium", actionable: true, deadlineAt: new Date(NOW + 60 * 60 * 1000).toISOString() }), ctx({ quietHours: true }));
    assert.equal(quietSoon.level, "NOTIFY");
    const interrupt = decideAttention(ev("x", { significance: "critical", actionable: true, deadlineAt: new Date(NOW + 60 * 1000).toISOString() }), ctx({ recentNotifyCount: 99, quietHours: true }));
    assert.equal(interrupt.level, "INTERRUPT");
  });
  it("§17.2 modes: SAFETY_EVENT makes every non-safety event PASSIVE; AT_RISK makes the discovery kinds PASSIVE and leaves logistics alone", () => {
    assert.equal(decideAttention(ev("trip_invite_received"), ctx({ mode: "SAFETY_EVENT" })).level, "PASSIVE");
    for (const k of DISCOVERY_EVENT_KINDS) assert.equal(decideAttention(ev(k), ctx({ mode: "AT_RISK" })).level, "PASSIVE", k);
    assert.equal(decideAttention(ev("commitment_at_risk", { significance: "critical" }), ctx({ mode: "AT_RISK" })).level, "INTERRUPT");
    assert.equal(decideAttention(ev("trip_invite_received"), ctx({ mode: "AT_RISK" })).level, "NOTIFY");
  });
});

describe("§11.4 every trip push passes the policy — lib/tripPush.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  it("no route or scheduler calls sendPushWithRetry for a trip push any more; every push kind those files send has a profile", () => {
    const files = ["../routes/trips.ts", "../routes/trips-expansion.ts", "../lib/tripReminderScheduler.ts"].map((f) => readFileSync(resolve(here, f), "utf8"));
    for (const src of files) {
      assert.equal(src.includes("sendPushWithRetry("), false, "a trip push bypasses the attention policy");
      for (const m of src.matchAll(/type:\s*"([a-z_0-9]+)"/g)) {
        if (!m[1].startsWith("trip_") && m[1] !== "review_prompt") continue;
        assert.ok(m[1] in TRIP_PUSH_EVENT_PROFILES, `push kind ${m[1]} has no TRIP_PUSH_EVENT_PROFILES row`);
      }
    }
    assert.ok((files[0].match(/sendTripPush\(/g) ?? []).length >= 4);
    assert.ok((files[1].match(/sendTripPush\(/g) ?? []).length >= 5);
    assert.ok((files[2].match(/sendTripPush\(/g) ?? []).length >= 1);
  });
  it("refuses a payload with no type, and a type with no profile — a new site cannot skip the policy by omission", async () => {
    await assert.rejects(() => sendTripPush(null, { userId: "u", tokens: [] }, { title: "t", body: "b", data: {} } as any), /data\.type is required/);
    await assert.rejects(() => sendTripPush(null, { userId: "u", tokens: [] }, { title: "t", body: "b", data: { type: "made_up" } } as any), /no TRIP_PUSH_EVENT_PROFILES row/);
  });
  it("NOTIFY pushes (once, through sendPushWithRetry); SURFACE holds; both are counted per level, and only the push counts as sent", async () => {
    const calls: any[] = [];
    _setTestFetch(async (_url: any, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }); });
    try {
      const invite = await sendTripPush(null, { userId: "u1", tokens: ["ExponentPushToken[abc]"] }, { title: "Trip invitation", body: "b", data: { type: "trip_invite_received", tripId: "t" } } as any, { now: NOW });
      assert.deepEqual(invite.pushed, ["u1"]); assert.deepEqual(invite.held, []); assert.equal(invite.decisions[0].decision.level, "NOTIFY");
      const archived = await sendTripPush(null, [{ userId: "u1", tokens: ["ExponentPushToken[abc]"] }, { userId: "u2", tokens: ["ExponentPushToken[def]"] }], { title: "Trip archived", body: "b", data: { type: "trip_archived", tripId: "t" } } as any, { now: NOW });
      assert.deepEqual(archived.pushed, []); assert.deepEqual(archived.held, ["u1", "u2"]); assert.equal(archived.push, null);
      assert.ok(archived.decisions.every((d) => d.decision.level === "SURFACE"));
      const byLevel = Object.fromEntries(readTripMetric("trip_notification_attention_total").map((s) => [`${s.labels.kind}:${s.labels.level}`, s.count]));
      assert.deepEqual(byLevel, { "trip_invite_received:NOTIFY": 1, "trip_archived:SURFACE": 2 });
      assert.deepEqual(readTripMetric("notification_sent_total").map((s) => [s.labels.kind, s.count]), [["trip_invite_received", 1]]);
    } finally { _setTestFetch(null); }
  });
  it("the per-recipient hourly budget is enforced across calls, and reset clears it", async () => {
    _setTestFetch(async () => new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    try {
      const payload = { title: "t", body: "b", data: { type: "trip_join_approved", tripId: "t" } } as any;
      const levels: string[] = [];
      for (let i = 0; i < NOTIFY_BUDGET_PER_HOUR + 2; i++) {
        const r = await sendTripPush(null, { userId: "u1", tokens: ["ExponentPushToken[abc]"] }, payload, { now: NOW + i });
        levels.push(r.decisions[0].decision.level);
      }
      assert.deepEqual(levels, [...Array(NOTIFY_BUDGET_PER_HOUR).fill("NOTIFY"), "SURFACE", "SURFACE"]);
      assert.equal(attentionLevelFor("trip_join_approved", { userId: "u1", now: NOW }), "SURFACE");
      _resetTripPushBudget();
      assert.equal(attentionLevelFor("trip_join_approved", { userId: "u1", now: NOW }), "NOTIFY");
    } finally { _setTestFetch(null); }
  });
  it("§21.1 notification_actionability_rate = acted / sent per kind; null when nothing was sent", async () => {
    _setTestFetch(async () => new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    try {
      const payload = { title: "t", body: "b", data: { type: "trip_invite_received", tripId: "t" } } as any;
      await sendTripPush(null, { userId: "u1", tokens: ["ExponentPushToken[abc]"] }, payload, { now: NOW });
      await sendTripPush(null, { userId: "u2", tokens: ["ExponentPushToken[def]"] }, payload, { now: NOW });
      recordNotificationActed("trip_invite_received", "u1");
      recordNotificationActed("trip_cancelled", "u9");
      const rates = readNotificationActionability();
      assert.deepEqual(rates, [
        { kind: "trip_cancelled", sent: 0, acted: 1, rate: null },
        { kind: "trip_invite_received", sent: 2, acted: 1, rate: 0.5 },
      ]);
    } finally { _setTestFetch(null); }
  });
});
