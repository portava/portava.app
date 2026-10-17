/**
 * Wave 5 safety lane — a help request is TOLD (census-telegraph T254, T398,
 * T395/T256's missing kinds).
 *
 * Before this lane nothing produced a notification for a §6.2 SAFETY message
 * or §9.1's NEED_HELP: a person who asked for help told nobody who was not
 * already looking at the conversation. LOCATION and ANNOUNCEMENT had no
 * producer either, and ACTION, a check-in and a forward told nobody.
 *
 * WHAT WOULD TURN THIS RED
 *   - a help request (either carrier, any of the three doors) not reaching a
 *     member who MUTED the thread, chose MENTIONS, or is temporarily muted;
 *   - the sender told; a member who left told; a blocked pair (either way)
 *     told — the spec carves out no exception for safety;
 *   - the label, note or place the sender typed reaching a notification;
 *   - an unreadable thread-choice table stopping a help request; a transient
 *     roster or blocks failure stopping it (they are retried); an unreadable
 *     roster or blocks table after the retries telling ANYONE;
 *   - a P0 alert suppressed in quiet hours where the recipient kept the safety
 *     override on (the real router, end to end) — or delivered where they
 *     turned it off; a second help request coalesced into the first;
 *   - a help request ALSO told as an ordinary message (twice);
 *   - an ALL CLEAR that ends nothing piercing a mute, or one that ends a raised
 *     mode NOT reaching a muted member;
 *   - LOCATION or ANNOUNCEMENT filed as MESSAGE (IMPORTANT would hide them) or
 *     carrying the place / title; ACTION or a check-in telling nobody;
 *   - a forward telling nobody with the flag ON, or anything with it OFF.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphSafetyNotifications.test.ts
 * (the door cases listen on loopback)
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import { getTemplate, renderTemplate, TEMPLATES } from "../services/notifications/NotificationTemplateService.js";
import { NotificationService, type CreateNotificationInput, type NotificationRow } from "../services/notifications/NotificationService.js";
import { NotificationRouter } from "../services/notifications/NotificationRouter.js";
import { runRouterMatrix, type Decision } from "../services/notifications/__tests__/routerDecisionMatrix.js";
import { bandFor, dedupeWindowFor } from "../domain/telegraph/policies/attentionLadder.js";
import { THREAD_NOTIFICATION_POLICY_FLAG } from "../services/telegraph/threadNotificationState.js";
import {
  SAFETY_ALERT_EVENT,
  SAFETY_ALL_CLEAR_EVENT,
  isNeedHelpQuickState,
  notifySafetySignal,
  safetySignalOfRow,
  type SafetyNotifyDeps,
} from "../services/telegraph/safetyNotifications.js";
import { ANNOUNCEMENT_NOTIFICATION_EVENT, LOCATION_NOTIFICATION_EVENT, kindPolicyOf, notifyNewMessage } from "../services/telegraph/messageNotifications.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import telegraphForwardRouter from "../routes/telegraphForward.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import { makeFakeClient, startRouter, call, resetFakeIds, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "73000000-0000-4000-8000-000000000001"; // asks for help
const BOB = "73000000-0000-4000-8000-000000000002";   // told
const CARL = "73000000-0000-4000-8000-000000000003";  // blocked Alice
const DANA = "73000000-0000-4000-8000-000000000004";  // MUTED the thread
const ERIN = "73000000-0000-4000-8000-000000000005";  // left
const FRAN = "73000000-0000-4000-8000-000000000006";  // Alice blocked her
const GINA = "73000000-0000-4000-8000-000000000007";  // MENTIONS-only and temporarily muted
const THREAD = "73000000-0000-4000-8000-0000000000d1";
const SRC_THREAD = "73000000-0000-4000-8000-0000000000d2";
const MSG = "73000000-0000-4000-8000-0000000000e1";
const SECRET_LABEL = "behind the pier gate 4417";
const SECRET_NOTE = "my phone is dying, room 2209";

// ── a small fake for the producer cases: per-table read failures, counted ───
type Row = Record<string, any>;
interface FakeOpts { failReads?: Record<string, number | "always"> }
function fake(seed: Record<string, Row[]>, opts: FakeOpts = {}) {
  const db: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  const reads: Record<string, number> = {};
  const failures: Record<string, number> = {};
  let n = 0;
  const val = (r: Row, c: string) => { const m = /^(\w+)->>(\w+)$/.exec(c); return m ? (r[m[1]!] ?? {})[m[2]!] : r[c]; };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" = "select";
    let inserted: Row | null = null;
    let lim: number | null = null;
    let counted = false;
    const run = () => {
      if (mode === "select") {
        if (!counted) { counted = true; reads[table] = (reads[table] ?? 0) + 1; }
        const f = opts.failReads?.[table];
        if (f === "always" || (typeof f === "number" && (failures[table] ?? 0) < f)) {
          failures[table] = (failures[table] ?? 0) + 1;
          return { data: null, error: { message: `${table} unreadable` } };
        }
      }
      if (mode === "insert") return { data: inserted, error: null };
      const out = (db[table] ?? []).filter((r) => filters.every((fn) => fn(r)));
      return { data: lim === null ? out : out.slice(0, lim), error: null };
    };
    const t: any = {
      select() { return p; },
      insert(r: Row) { mode = "insert"; inserted = { id: `n-${++n}`, created_at: new Date().toISOString(), ...r }; (db[table] ??= []).push(inserted); return p; },
      eq(c: string, v: unknown) { filters.push((r) => String(val(r, c)) === String(v)); return p; },
      neq(c: string, v: unknown) { filters.push((r) => String(val(r, c)) !== String(v)); return p; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.map(String).includes(String(val(r, c)))); return p; },
      is(c: string, v: unknown) { filters.push((r) => (v === null ? val(r, c) == null : val(r, c) === v)); return p; },
      gt(c: string, v: unknown) { filters.push((r) => String(val(r, c) ?? "") > String(v)); return p; },
      limit(k: number) { lim = k; return p; },
      maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }); },
      single() { return t.maybeSingle(); },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    const p: any = new Proxy(t, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
    return p;
  }
  return { db, reads, from, rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as any;
}

const member = (user_id: string, over: Row = {}) => ({ thread_id: THREAD, user_id, left_at: null, muted_at: null, ...over });
const FUTURE = "2099-01-01T00:00:00.000Z";
function world(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    feature_flags: [{ flag: THREAD_NOTIFICATION_POLICY_FLAG, enabled: true }],
    message_thread_members: [
      member(ALICE, { notification_level: "all", muted_until: null }),
      member(BOB, { notification_level: "all", muted_until: null }),
      member(CARL, { notification_level: "all", muted_until: null }),
      member(DANA, { notification_level: "muted", muted_until: null, muted_at: "2026-10-01T00:00:00.000Z" }),
      member(ERIN, { left_at: "2026-10-01T00:00:00.000Z", notification_level: "all", muted_until: null }),
      member(FRAN, { notification_level: "all", muted_until: null }),
      member(GINA, { notification_level: "mentions", muted_until: FUTURE }),
    ],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }, { blocker_id: ALICE, blocked_id: FRAN }],
    profiles: [{ id: ALICE, handle: "alice", display_name: "Alice Real" }],
    profile_privacy_settings: [],
    messages: [],
    notifications: [],
    ...extra,
  };
}
function recording() {
  const created: CreateNotificationInput[] = [];
  const routed: string[] = [];
  const deps: SafetyNotifyDeps = {
    async create(i) { created.push(i); return { id: `n-${created.length}`, userId: i.userId } as NotificationRow; },
    async route(r) { routed.push(r.userId); },
  };
  return { deps, created, routed };
}
function logs() {
  const errors: string[] = [];
  const warns: string[] = [];
  return { errors, warns, log: { error: (_o: object, m: string) => { errors.push(m); }, warn: (_o: object, m: string) => { warns.push(m); } } };
}
const NO_WAIT = [0, 0] as const;
const signal = (over: Partial<Parameters<typeof notifySafetySignal>[1]> = {}) => ({ threadId: THREAD, senderId: ALICE, messageId: MSG, signal: "need_help" as const, nowMs: Date.now(), ...over });
const sorted = (xs: string[]) => [...xs].sort();
const envRow = (id: string, sender: string, at: string, msg_type: string, subtype: string | null, envelope: unknown) =>
  ({ id, thread_id: THREAD, sender_id: sender, created_at: at, deleted_at: null, msg_type, subtype, body: JSON.stringify(envelope) });
const needHelpQuick = (id: string, sender: string, at: string) => envRow(id, sender, at, "coordination", null, { kind: "COORDINATION", envelopeVersion: "1", payload: { state: "NEED_HELP" } });
const safetyRow = (id: string, sender: string, at: string, kind: string) => envRow(id, sender, at, "safety", kind, { kind: "SAFETY", envelopeVersion: "1", payload: { kind, label: "x" } });

// ── 1. the vocabulary ────────────────────────────────────────────────────────

describe("the templates, bands and words", () => {
  it("telegraph.sos is §19 P0: urgent, never coalesced, in-app + push, the safety category, fixed words", () => {
    const t = getTemplate(SAFETY_ALERT_EVENT)!;
    assert.ok(t);
    assert.equal(bandFor(SAFETY_ALERT_EVENT), "P0_SAFETY");
    assert.equal(dedupeWindowFor(SAFETY_ALERT_EVENT), 0);
    assert.equal(t.defaultPriority, "urgent", "P0 is interruptive only through urgent");
    assert.equal(t.category, "safe_return");
    assert.deepEqual(t.defaultChannels, ["in_app", "push"], "never the telegraph channel: no second message in the thread");
    const r = renderTemplate(SAFETY_ALERT_EVENT, { actor: "@alice", signal: "asked for help", threadId: THREAD, label: SECRET_LABEL, note: SECRET_NOTE, preview: SECRET_NOTE })!;
    assert.equal(r.title, "Safety alert");
    assert.equal(r.body, "@alice asked for help");
    assert.equal(r.actionUrl, `/messages/${THREAD}`);
  });

  it("the ALL CLEAR is §19 P1 ('return state'), normal — safe_return.cleared's shape", () => {
    const t = getTemplate(SAFETY_ALL_CLEAR_EVENT)!;
    assert.equal(bandFor(SAFETY_ALL_CLEAR_EVENT), "P1_COORDINATION");
    assert.equal(t.defaultPriority, getTemplate("safe_return.cleared")!.defaultPriority);
    assert.equal(t.category, "safe_return");
    assert.equal(renderTemplate(SAFETY_ALL_CLEAR_EVENT, { actor: "@alice" })!.body, "@alice posted ALL CLEAR");
  });

  it("LOCATION is P2 under the location category; an ANNOUNCEMENT is P1; neither says the place or the title", () => {
    assert.equal(bandFor(LOCATION_NOTIFICATION_EVENT), "P2_MESSAGE");
    assert.equal(getTemplate(LOCATION_NOTIFICATION_EVENT)!.category, "location");
    assert.equal(renderTemplate(LOCATION_NOTIFICATION_EVENT, { actor: "@alice", label: SECRET_LABEL, preview: SECRET_LABEL })!.body, "Shared a location");
    assert.equal(bandFor(ANNOUNCEMENT_NOTIFICATION_EVENT), "P1_COORDINATION");
    assert.equal(renderTemplate(ANNOUNCEMENT_NOTIFICATION_EVENT, { actor: "@alice", title: SECRET_NOTE, preview: SECRET_NOTE })!.body, "Posted an announcement");
  });

  it("which rows are safety signals, and the cause every other kind is told under", () => {
    for (const [msgType, subtype, want] of [["safety", "need_help", "need_help"], ["safety", "heads_up", "heads_up"], ["safety", "all_clear", "all_clear"], ["safety", "check_in", null], ["coordination", null, null], ["text", null, null]] as const) {
      assert.equal(safetySignalOfRow({ msgType, subtype }), want, `${msgType}/${subtype}`);
    }
    assert.equal(isNeedHelpQuickState("COORDINATION", { state: "NEED_HELP" }), true);
    assert.equal(isNeedHelpQuickState("COORDINATION", { state: "RUNNING_LATE" }), false);
    assert.equal(isNeedHelpQuickState("DECISION", { state: "NEED_HELP" }), false);
    for (const [msgType, subtype, cause] of [["text", null, "MESSAGE"], ["action", "meet_here", "MESSAGE"], ["safety", "check_in", "MESSAGE"], ["location", "area", "LOCATION"], ["announcement", null, "COORDINATION"], ["safety", "need_help", null], ["safety", "all_clear", null], ["coordination", null, null], ["system", "e2ee_welcome", null]] as const) {
      assert.equal(kindPolicyOf({ msgType, subtype })?.cause ?? null, cause, `${msgType}/${subtype}`);
    }
  });
});

// ── 2. the real router: what P0 overrides, and what it does not ─────────────

describe("quiet hours and push-off, through the real NotificationRouter (the spec is silent; the urgent + safety_override precedent rules)", () => {
  let decisions: Decision[] = [];
  before(async () => {
    const pick = (e: string) => TEMPLATES.find((t) => t.eventType === e)!;
    decisions = await runRouterMatrix(NotificationRouter as any, _setTestFetch, [pick(SAFETY_ALERT_EVENT), pick(SAFETY_ALL_CLEAR_EVENT), pick("telegraph.message")]);
  });
  const pushed = (scenario: string, category: string, eventType: string, priority: string) => {
    const d = decisions.filter((x) => x.key.startsWith(`off|${scenario}|${category}|${eventType}|${priority}#`));
    assert.equal(d.length, 1, `${scenario} ${eventType}`);
    return d[0]!.sent.length > 0;
  };

  it("a help request is pushed during quiet hours and with push off, while the recipient's safety override is on", () => {
    assert.equal(pushed("defaults", "safe_return", SAFETY_ALERT_EVENT, "urgent"), true);
    assert.equal(pushed("quiet+override", "safe_return", SAFETY_ALERT_EVENT, "urgent"), true, "P0 is interruptive: the Compass gate must read it as emergency_safety");
    assert.equal(pushed("push_off", "safe_return", SAFETY_ALERT_EVENT, "urgent"), true);
  });

  it("…and NOT when the recipient turned their own safety override off: it is their setting", () => {
    assert.equal(pushed("quiet-override", "safe_return", SAFETY_ALERT_EVENT, "urgent"), false);
  });

  it("the ALL CLEAR and an ordinary message respect quiet hours", () => {
    assert.equal(pushed("defaults", "safe_return", SAFETY_ALL_CLEAR_EVENT, "normal"), true);
    assert.equal(pushed("quiet+override", "safe_return", SAFETY_ALL_CLEAR_EVENT, "normal"), false);
    assert.equal(pushed("quiet+override", "telegraph", "telegraph.message", "important"), false);
  });
});

// ── 3. who is told ───────────────────────────────────────────────────────────

describe("who is told about a help request", () => {
  it("every other active member — a MUTE, MENTIONS-only and a temporary mute included; never the sender, a member who left, or a blocked pair", async () => {
    const { deps, created, routed } = recording();
    const r = await notifySafetySignal(fake(world()), signal(), { deps });
    assert.equal(r.status, "notified");
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([BOB, DANA, GINA]), "Carl blocked Alice, Alice blocked Fran, Erin left, Alice asked");
    assert.deepEqual(sorted(routed), sorted([BOB, DANA, GINA]));
    for (const c of created) {
      assert.equal(c.eventType, "telegraph.sos");
      assert.deepEqual(c.params, { actor: "@alice", signal: "asked for help", threadId: THREAD }, "fixed words; Alice does not show her real name");
      assert.equal(c.causalEventId, `MESSAGE:${MSG}`);
      assert.deepEqual(c.metadata, { cause: "SAFETY", signal: "need_help" });
      assert.equal("senderId" in c, false, "the privacy guard's Ghost Mode key is not passed: a person's own help request is not about their location");
    }
    assert.ok(r.status === "notified" && r.withheld.some((w) => w.userId === CARL && w.reason === "blocked") && r.withheld.some((w) => w.userId === FRAN && w.reason === "blocked"));
  });

  it("a heads-up is told the same way, in its own words", async () => {
    const { deps, created } = recording();
    await notifySafetySignal(fake(world()), signal({ signal: "heads_up" }), { deps });
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([BOB, DANA, GINA]));
    assert.equal(created[0]!.params!.signal, "raised a safety heads-up");
  });

  it("the thread choices are not even read — an unreadable settings table cannot stop it", async () => {
    const sc = fake(world(), { failReads: { feature_flags: "always" } });
    const { deps, created } = recording();
    await notifySafetySignal(sc, signal(), { deps });
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([BOB, DANA, GINA]));
    assert.equal(sc.reads.feature_flags ?? 0, 0);
    assert.equal(sc.reads.message_thread_members, 1, "one roster read, no thread-choice read");
  });

  it("an unreadable roster is RETRIED, then tells nobody and says so at ERROR", async () => {
    const sc = fake(world(), { failReads: { message_thread_members: "always" } });
    const { deps, created } = recording();
    const l = logs();
    const r = await notifySafetySignal(sc, signal(), { deps, log: l.log, retryDelaysMs: NO_WAIT });
    assert.deepEqual(r, { status: "refused", stage: "roster" });
    assert.equal(created.length, 0);
    assert.equal(sc.reads.message_thread_members, 3, "the first read and two retries");
    assert.ok(l.errors.some((m) => /REFUSED.*reached NOBODY/.test(m)), l.errors.join(" | "));
  });

  it("a roster that blinks once is retried and the help request still goes", async () => {
    const { deps, created } = recording();
    const r = await notifySafetySignal(fake(world(), { failReads: { message_thread_members: 1 } }), signal(), { deps, retryDelaysMs: NO_WAIT });
    assert.equal(r.status, "notified");
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([BOB, DANA, GINA]));
  });

  it("an unreadable blocks table is RETRIED, then tells NOBODY (§27.1: a block makes direct delivery impossible) and says so at ERROR", async () => {
    const sc = fake(world(), { failReads: { blocks: "always" } });
    const { deps, created } = recording();
    const l = logs();
    const r = await notifySafetySignal(sc, signal(), { deps, log: l.log, retryDelaysMs: NO_WAIT });
    assert.deepEqual(r, { status: "refused", stage: "blocks" });
    assert.equal(created.length, 0);
    assert.equal(sc.reads.blocks, 6, "each attempt reads both directions: three attempts");
    assert.ok(l.errors.some((m) => /block state unknown/.test(m)), l.errors.join(" | "));
  });

  it("a blocks table that blinks once is retried and the help request still goes", async () => {
    const { deps, created } = recording();
    await notifySafetySignal(fake(world(), { failReads: { blocks: 1 } }), signal(), { deps, retryDelaysMs: NO_WAIT });
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([BOB, DANA, GINA]));
  });

  it("an unreadable profile names 'Someone' and stops nothing; one member's failure does not stop the others", async () => {
    const created: string[] = [];
    const l = logs();
    const deps: SafetyNotifyDeps = {
      async create(i) { created.push(i.userId); if (i.userId === BOB) return null; return { id: "n", userId: i.userId } as NotificationRow; },
      async route() { throw new Error("push provider down"); },
    };
    const r = await notifySafetySignal(fake(world(), { failReads: { profiles: "always" } }), signal(), { deps, log: l.log });
    assert.ok(r.status === "notified");
    assert.deepEqual(sorted(r.notified), sorted([DANA, GINA]));
    assert.ok(r.withheld.some((w) => w.userId === BOB && w.reason === "not_created"));
    assert.ok(l.errors.length >= 3, "the not-created member and both route failures are ERRORs");
  });

  it("never rejects", async () => {
    const r = await notifySafetySignal({ from() { throw new Error("torn down"); } } as any, signal(), {});
    assert.deepEqual(r, { status: "refused", stage: "threw" });
  });
});

// ── 4. dedupe and privacy, through the real NotificationService ─────────────

describe("dedupe and the privacy guard, through the real NotificationService", () => {
  const twoMembers = () => world({ message_thread_members: [member(ALICE), member(BOB)], blocks: [] });

  it("a second help request a moment later is a second notification (P0 is never coalesced); each carries its message as the causal event", async () => {
    const sc = fake(twoMembers());
    const ns = new NotificationService(sc);
    const deps: SafetyNotifyDeps = { create: (i) => ns.create(i), route: async () => undefined };
    await notifySafetySignal(sc, signal({ messageId: "m-1" }), { deps });
    await notifySafetySignal(sc, signal({ messageId: "m-2" }), { deps });
    const bobs = sc.db.notifications.filter((n: Row) => n.user_id === BOB);
    assert.equal(bobs.length, 2);
    assert.deepEqual(bobs.map((n: Row) => n.metadata.causal_event_id), ["MESSAGE:m-1", "MESSAGE:m-2"]);
    assert.equal(bobs[0].priority, "urgent");
  });

  it("the help request's causal id makes a later ordinary report of the SAME message a duplicate", async () => {
    const sc = fake(twoMembers());
    const ns = new NotificationService(sc);
    await notifySafetySignal(sc, signal(), { deps: { create: (i) => ns.create(i), route: async () => undefined } });
    const again = await ns.createDetailed({ userId: BOB, eventType: "telegraph.mention", actorId: ALICE, sourceType: "thread", sourceId: THREAD, params: { actor: "@alice", threadId: THREAD }, causalEventId: `MESSAGE:${MSG}` });
    assert.equal(again.refusal, "duplicate");
  });

  it("Ghost Mode does not swallow a person's own help request — but does withhold their LOCATION share, as before", async () => {
    const ghost = () => fake({ ...twoMembers(), location_preferences: [{ user_id: ALICE, location_mode: "ghost" }] });
    const sc1 = ghost();
    const ns1 = new NotificationService(sc1);
    await notifySafetySignal(sc1, signal(), { deps: { create: (i) => ns1.create(i), route: async () => undefined } });
    assert.equal(sc1.db.notifications.length, 1);
    const sc2 = ghost();
    const ns2 = new NotificationService(sc2);
    await notifyNewMessage(sc2, { threadId: THREAD, senderId: ALICE, messageId: MSG, msgType: "location", subtype: "area", nowMs: Date.now() }, { deps: { create: (i) => ns2.create(i), route: async () => undefined } });
    assert.equal(sc2.db.notifications.length, 0, "the privacy guard's Ghost Mode rule still holds for a location");
  });
});

// ── 5. the ALL CLEAR, and the other kinds ───────────────────────────────────

describe("the ALL CLEAR is the safety producer's only when it ENDS something", () => {
  const send = (over: Partial<Parameters<typeof notifyNewMessage>[1]> = {}) => ({ threadId: THREAD, senderId: ALICE, messageId: MSG, msgType: "safety", subtype: "all_clear", nowMs: Date.now(), ...over });
  const clear = () => safetyRow(MSG, ALICE, "2026-10-17T11:00:00.000Z", "all_clear");

  it("after a help request (SAFETY_EVENT): telegraph.safety_all_clear, and the member who muted is told it is over", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(world({ messages: [needHelpQuick("h1", ALICE, "2026-10-17T10:00:00.000Z"), clear()] })), send(), { deps });
    assert.ok(r.status === "delegated" && r.outcome.status === "notified" && r.outcome.eventType === "telegraph.safety_all_clear");
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([BOB, DANA, GINA]));
    assert.equal(created[0]!.params!.signal, "posted ALL CLEAR");
  });

  it("after a heads-up (SAFETY_ATTENTION), from anyone: the same", async () => {
    const { deps, created } = recording();
    await notifyNewMessage(fake(world({ messages: [safetyRow("h2", BOB, new Date(Date.now() - 60_000).toISOString(), "heads_up"), clear()] })), send(), { deps });
    assert.ok(created.every((c) => c.eventType === "telegraph.safety_all_clear"));
    assert.ok(created.some((c) => c.userId === DANA));
  });

  it("an ALL CLEAR that ends nothing is an ordinary message: the mute holds", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(world({ messages: [clear()] })), send(), { deps });
    assert.ok(r.status === "notified" && r.cause === "MESSAGE");
    assert.deepEqual(created.map((c) => c.userId), [BOB]);
    assert.equal(created[0]!.eventType, "telegraph.message");
  });

  it("an unreadable safety state is no evidence anything ended: ordinary, and said", async () => {
    const { deps, created } = recording();
    const l = logs();
    await notifyNewMessage(fake(world({ messages: [needHelpQuick("h1", ALICE, "2026-10-17T10:00:00.000Z"), clear()] }), { failReads: { messages: "always" } }), send(), { deps, log: l.log });
    assert.deepEqual(created.map((c) => c.userId), [BOB]);
    assert.ok(l.warns.some((m) => /ALL CLEAR.*unreadable/.test(m)));
  });

  it("need_help and heads_up through the message door are the safety producer's, never ALSO an ordinary message", async () => {
    for (const subtype of ["need_help", "heads_up"]) {
      const { deps, created } = recording();
      const r = await notifyNewMessage(fake(world()), send({ subtype }), { deps });
      assert.ok(r.status === "delegated" && r.outcome.status === "notified");
      assert.ok(created.every((c) => c.eventType === "telegraph.sos"), subtype);
      assert.equal(created.length, 3, `${subtype}: one per member, once`);
    }
  });
});

describe("LOCATION and ANNOUNCEMENT have their own causes; ACTION and a check-in are messages", () => {
  const send = (msgType: string, subtype: string | null = null) => ({ threadId: THREAD, senderId: ALICE, messageId: MSG, msgType, subtype, nowMs: Date.now() });
  const levels = () => world({
    message_thread_members: [member(ALICE, { notification_level: "all", muted_until: null }), member(BOB, { notification_level: "mentions", muted_until: null }), member(CARL, { notification_level: "important", muted_until: null }), member(DANA, { notification_level: "all", muted_until: null })],
    blocks: [],
  });

  it("LOCATION: telegraph.location, coalesced per conversation on its own source; IMPORTANT admits it, MENTIONS does not", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(levels()), send("location", "area"), { deps });
    assert.ok(r.status === "notified" && r.cause === "LOCATION");
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([CARL, DANA]));
    assert.equal(created[0]!.eventType, "telegraph.location");
    assert.equal(created[0]!.sourceType, "thread_location");
    assert.equal(created[0]!.sourceId, THREAD);
    assert.equal(created[0]!.senderId, ALICE, "the Ghost Mode key IS passed for a location");
    assert.deepEqual(created[0]!.params, { actor: "@alice", threadId: THREAD });
  });

  it("ANNOUNCEMENT: COORDINATION (P1), each one its own news; IMPORTANT admits it", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(levels()), send("announcement"), { deps });
    assert.ok(r.status === "notified" && r.cause === "COORDINATION");
    assert.deepEqual(sorted(created.map((c) => c.userId)), sorted([CARL, DANA]));
    assert.equal(created[0]!.eventType, "telegraph.announcement");
    assert.equal(created[0]!.sourceId, MSG, "two announcements are two pieces of news");
  });

  it("CONTROL: an ordinary message under the same choices reaches only ALL", async () => {
    const { deps, created } = recording();
    await notifyNewMessage(fake(levels()), send("text"), { deps });
    assert.deepEqual(created.map((c) => c.userId), [DANA]);
  });

  it("ACTION and a safety check-in are messages; a mute holds for both", async () => {
    for (const [msgType, subtype] of [["action", "meet_here"], ["safety", "check_in"]] as const) {
      const { deps, created } = recording();
      const r = await notifyNewMessage(fake(world()), send(msgType, subtype), { deps });
      assert.ok(r.status === "notified" && r.cause === "MESSAGE", msgType);
      assert.deepEqual(created.map((c) => c.userId), [BOB], `${msgType}: Dana muted, Gina is MENTIONS-only`);
      assert.equal(created[0]!.eventType, "telegraph.message");
    }
  });

  it("a LOCATION from the person who asked for help, while it stands, is SAFETY: the mute does not hide it", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(world({ messages: [needHelpQuick("h1", ALICE, "2026-10-17T10:00:00.000Z")] })), send("location", "exact"), { deps });
    assert.ok(r.status === "notified" && r.cause === "SAFETY");
    assert.ok(created.some((c) => c.userId === DANA));
    assert.equal(created[0]!.sourceType, "thread_safety");
  });
});

// ── 6. the doors ─────────────────────────────────────────────────────────────

function doorSeed(over: Record<string, unknown[]> = {}): Record<string, unknown[]> {
  const m = (thread_id: string, user_id: string, extra: Row = {}) => ({ thread_id, user_id, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, ...extra });
  const th = (id: string) => ({ id, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "Crew", status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z" });
  return {
    feature_flags: [], blocks: [{ blocker_id: CARL, blocked_id: ALICE }],
    profiles: [ALICE, BOB, CARL, DANA].map((id, i) => ({ id, handle: ["alice", "bob", "carl", "dana"][i], name: null, account_status: null, preferred_language: "en" })),
    user_message_settings: [], user_friendships: [], user_follows: [], circle_memberships: [], trust_profiles: [], trust_restrictions: [],
    message_requests: [], user_privacy_settings: [], profile_privacy_settings: [], reports: [], message_translations: [], telegraph_events: [],
    message_threads: [th(THREAD), th(SRC_THREAD)],
    message_thread_members: [m(THREAD, ALICE), m(THREAD, BOB), m(THREAD, CARL), m(THREAD, DANA, { muted_at: "2026-10-01T00:00:00.000Z" }), m(SRC_THREAD, ALICE), m(SRC_THREAD, BOB)],
    messages: [{ id: "73000000-0000-4000-8000-0000000000f1", thread_id: SRC_THREAD, sender_id: BOB, body: SECRET_NOTE, msg_type: "text", subtype: null, media_url: null, deleted_at: null, created_at: "2026-10-01T10:00:00.000Z" }],
    message_content_capabilities: [{ message_id: "73000000-0000-4000-8000-0000000000f1", capability: "ALLOW", set_by: BOB }], message_forwards: [],
    notifications: [], location_preferences: [],
    ...over,
  };
}

describe("the doors produce it", () => {
  let harness: RouterHarness;
  before(async () => {
    const all = express.Router();
    all.use(commandRouter); // first, exactly as routes/index.ts mounts it
    all.use(telegraphKindsRouter);
    all.use(telegraphCoordinationRouter);
    all.use(telegraphForwardRouter);
    harness = await startRouter(all);
  });
  after(async () => { _setTestClient(null, false); await harness.close(); });
  beforeEach(() => { resetFakeIds(); _resetRateLimit(); _clearSendTierCache(); });

  function use(over: Record<string, unknown[]> = {}): FakeClient {
    // The dedupe rules read `metadata->>causal_event_id` and `created_at > since`: give each notification row what the database would.
    const c = makeFakeClient(doorSeed(over) as Record<string, any[]>, { onRead: (table, store) => { if (table === "notifications") for (const r of store.notifications ?? []) { r["metadata->>causal_event_id"] = r.metadata?.causal_event_id; r.created_at ??= new Date().toISOString(); } } });
    // 3665's telegraph_record_forward, reduced to the forwarded outcome (telegraphForwarding.test.ts holds its refusals).
    c.rpc = async (name: string, a: any) => {
      if (name !== "telegraph_record_forward") return { data: null, error: { message: "rpc not modelled" } };
      const id = "73000000-0000-4000-8000-0000000000f9";
      const createdAt = new Date().toISOString();
      c._store.messages!.push({ id, thread_id: a.p_target_thread_id, sender_id: a.p_forwarder_id, body: a.p_body, msg_type: a.p_msg_type, subtype: a.p_subtype, media_url: null, deleted_at: null, created_at: createdAt });
      return { data: { outcome: "forwarded", messageId: id, createdAt }, error: null };
    };
    _setTestClient(c, true);
    return c;
  }
  const rows = (c: FakeClient, eventType: string) => (c._store.notifications ?? []).filter((n: Row) => n.event_type === eventType);
  async function settle(c: FakeClient, eventType: string, want: number) {
    for (let i = 0; i < 300 && rows(c, eventType).length < want; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 60));
    return rows(c, eventType);
  }
  function noLeak(c: FakeClient) {
    const all = JSON.stringify(c._store.notifications ?? []);
    for (const word of ["pier", "4417", "phone", "2209", "Pier 2", "Meet at the"]) assert.ok(!all.includes(word), `typed words reached a notification (${word})`);
  }
  const forMessage = (c: FakeClient, id: string) => (c._store.notifications ?? []).filter((n: Row) => n.metadata?.causal_event_id === `MESSAGE:${id}`);

  it("the typed door, SAFETY need_help: Bob and Dana (MUTED) are told, Carl (blocked) and Alice are not, once each, with no word she typed", async () => {
    const c = use();
    const r = await call(harness.base, "POST", `/threads/${THREAD}/typed-messages`, ALICE, { kind: "SAFETY", payload: { kind: "need_help", label: SECRET_LABEL, note: SECRET_NOTE, approximateLabel: "Pier 2" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const told = await settle(c, "telegraph.sos", 2);
    assert.deepEqual(sorted(told.map((n: Row) => n.user_id)), sorted([BOB, DANA]));
    assert.equal(told[0].body, "@alice asked for help");
    assert.equal(told[0].priority, "urgent");
    assert.equal(forMessage(c, r.body.id).length, 2, "told once each — never ALSO as an ordinary message");
    noLeak(c);
  });

  it("the typed door, SAFETY heads_up: the same people, its own words", async () => {
    const c = use();
    const r = await call(harness.base, "POST", `/threads/${THREAD}/typed-messages`, ALICE, { kind: "SAFETY", payload: { kind: "heads_up", label: SECRET_LABEL } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const told = await settle(c, "telegraph.sos", 2);
    assert.deepEqual(sorted(told.map((n: Row) => n.user_id)), sorted([BOB, DANA]));
    assert.equal(told[0].body, "@alice raised a safety heads-up");
    noLeak(c);
  });

  it("the coordination door, the NEED_HELP quick state: told as SAFETY, not as coordination", async () => {
    const c = use();
    const r = await call(harness.base, "POST", `/threads/${THREAD}/coordination`, ALICE, { kind: "COORDINATION", payload: { state: "NEED_HELP", note: SECRET_NOTE } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const told = await settle(c, "telegraph.sos", 2);
    assert.deepEqual(sorted(told.map((n: Row) => n.user_id)), sorted([BOB, DANA]));
    assert.equal(rows(c, "telegraph.coordination").length, 0);
    assert.equal(forMessage(c, r.body.id).length, 2);
    noLeak(c);
  });

  it("the §13.1 bus: NEED_HELP is SAFETY, a quick state is COORDINATION, SHARE_LOCATION is LOCATION — as on the route doors", async () => {
    const c = use();
    const help = await call(harness.base, "POST", "/telegraph/commands", ALICE, { type: "SET_COORDINATION_STATUS", conversationId: THREAD, params: { state: "NEED_HELP", note: SECRET_NOTE } });
    assert.equal(help.status, 200, JSON.stringify(help.body));
    assert.deepEqual(sorted((await settle(c, "telegraph.sos", 2)).map((n: Row) => n.user_id)), sorted([BOB, DANA]));
    assert.equal(forMessage(c, help.body.data.messageId).length, 2);
    noLeak(c);
    // A fresh conversation for the rest: after Alice's NEED_HELP her own location share is SAFETY (the next case pins that).
    const c2 = use();
    const late = await call(harness.base, "POST", "/telegraph/commands", ALICE, { type: "SET_COORDINATION_STATUS", conversationId: THREAD, params: { state: "RUNNING_LATE" } });
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.deepEqual((await settle(c2, "telegraph.coordination", 1)).map((n: Row) => n.user_id), [BOB], "Dana muted; Carl blocked Alice");
    const loc = await call(harness.base, "POST", "/telegraph/commands", ALICE, { type: "SHARE_LOCATION", conversationId: THREAD, params: { label: "Pier 2", precision: "area", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    assert.equal(loc.status, 200, JSON.stringify(loc.body));
    const located = await settle(c2, "telegraph.location", 1);
    assert.deepEqual(located.map((n: Row) => n.user_id), [BOB]);
    assert.equal(located[0].body, "Shared a location");
    noLeak(c2);
  });

  it("the bus: after Alice asked for help, her own location share reaches the member who muted (SAFETY), as an ordinary-looking message", async () => {
    const c = use();
    const help = await call(harness.base, "POST", "/telegraph/commands", ALICE, { type: "SET_COORDINATION_STATUS", conversationId: THREAD, params: { state: "NEED_HELP" } });
    assert.equal(help.status, 200, JSON.stringify(help.body));
    await settle(c, "telegraph.sos", 2);
    const loc = await call(harness.base, "POST", "/telegraph/commands", ALICE, { type: "SHARE_LOCATION", conversationId: THREAD, params: { label: "Pier 2", precision: "area", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    assert.equal(loc.status, 200, JSON.stringify(loc.body));
    const told = (await settle(c, "telegraph.message", 2)).filter((n: Row) => n.metadata?.causal_event_id === `MESSAGE:${loc.body.data.messageId}`);
    assert.deepEqual(sorted(told.map((n: Row) => n.user_id)), sorted([BOB, DANA]));
    assert.ok(told.every((n: Row) => n.source_type === "thread_safety" && n.body === "New message"));
    noLeak(c);
  });

  it("the typed door, LOCATION / ANNOUNCEMENT / ACTION: each under its cause, none with the words typed", async () => {
    const c = use();
    const loc = await call(harness.base, "POST", `/threads/${THREAD}/typed-messages`, ALICE, { kind: "LOCATION", payload: { label: "Pier 2", precision: "area" } });
    assert.equal(loc.status, 201, JSON.stringify(loc.body));
    assert.deepEqual((await settle(c, "telegraph.location", 1)).map((n: Row) => n.user_id), [BOB]);
    const ann = await call(harness.base, "POST", `/threads/${THREAD}/typed-messages`, ALICE, { kind: "ANNOUNCEMENT", payload: { title: "Meet at the pier gate 4417", body: SECRET_NOTE, requiresAcknowledgement: true } });
    assert.equal(ann.status, 201, JSON.stringify(ann.body));
    const announced = await settle(c, "telegraph.announcement", 1);
    assert.deepEqual(announced.map((n: Row) => n.user_id), [BOB]);
    assert.equal(announced[0].body, "Posted an announcement");
    const act = await call(harness.base, "POST", `/threads/${THREAD}/typed-messages`, ALICE, { kind: "ACTION", payload: { action: "MEET_HERE", title: "Meet at the pier gate 4417" } });
    assert.equal(act.status, 201, JSON.stringify(act.body));
    assert.deepEqual((await settle(c, "telegraph.message", 1)).map((n: Row) => n.user_id), [BOB]);
    noLeak(c);
  });

  it("the forward door: OFF (the seed) forwards nothing and tells nobody; ON, the forward is a message the target conversation is told about", async () => {
    const SOURCE = "73000000-0000-4000-8000-0000000000f1";
    const off = use();
    const refused = await call(harness.base, "POST", `/threads/${THREAD}/forward`, ALICE, { sourceMessageId: SOURCE });
    assert.equal(refused.body?.error, "feature_disabled", JSON.stringify(refused.body));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((off._store.notifications ?? []).length, 0);
    const on = use({ feature_flags: [{ flag: "telegraph_forwarding_enabled", enabled: true }] });
    const fwd = await call(harness.base, "POST", `/threads/${THREAD}/forward`, ALICE, { sourceMessageId: SOURCE });
    assert.equal(fwd.status, 201, JSON.stringify(fwd.body));
    const told = await settle(on, "telegraph.message", 1);
    assert.deepEqual(told.map((n: Row) => n.user_id), [BOB], "Carl blocked Alice, Dana muted the thread");
    assert.equal(told[0].body, "New message");
    assert.equal(told[0].metadata.causal_event_id, `MESSAGE:${fwd.body.id}`);
    noLeak(on);
  });
});
