/**
 * census-telegraph T395 + T397 (wave 5) — §30A.6's COORDINATION notification
 * cause, and deduplication by the underlying causal event.
 *
 * Spec §30A.6: "Define notification causes including MESSAGE, MENTION,
 * PLAN_CHANGED, INVITATION, COORDINATION, LOCATION, CALL, and SAFETY." and
 * "Deduplicate notifications by underlying causal event. A single Plan change
 * must not create redundant Plan, Trip, Telegraph, and Compass notifications."
 *
 * WHAT WOULD TURN THIS RED
 *   T397 — the causal rule keyed on the producer's own category (or event type,
 *   or source) instead of the event; the id not persisted; P0 suppressed by it;
 *   an unreadable ledger read as "not told"; a malformed id acted on. (The
 *   PostgREST spelling of the causal read is pinned through the real
 *   supabase-js client in notificationIssuance.test.ts, "T397 (wave 5)".)
 *   T395 — no template; the act's words taken from the sender's note; NEED_HELP
 *   filed as coordination; a blocked or muted member told; an unreadable roster,
 *   blocks table or thread choice telling anyone; the route not producing it.
 *
 * Run: node --import tsx/esm --test src/test/telegraphCoordinationNotifications.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import {
  CAUSAL_DEDUP_WINDOW_MS,
  NotificationDeduplicationService,
  causalEventIdOf,
  isCausalEventId,
} from "../services/notifications/NotificationDeduplicationService.js";
import { NotificationService, type CreateNotificationInput, type NotificationRow } from "../services/notifications/NotificationService.js";
import { getTemplate, renderTemplate } from "../services/notifications/NotificationTemplateService.js";
import { bandFor } from "../domain/telegraph/policies/attentionLadder.js";
import { NOTIFICATION_CAUSES } from "../domain/telegraph/policies/threadNotificationPolicy.js";
import {
  COORDINATION_ACT_PHRASES,
  COORDINATION_NOTIFICATION_EVENT,
  coordinationActOf,
  notifyCoordinationAct,
  type CoordinationNotifyDeps,
} from "../services/telegraph/coordinationNotifications.js";
import { COORDINATION_QUICK_STATES } from "../services/telegraph/vocabulary.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";
const DANA = "dddddddd-0000-4000-8000-000000000004";
const ERIN = "eeeeeeee-0000-4000-8000-000000000005";
const THREAD = "10000000-0000-4000-8000-000000000001";
const MESSAGE = "20000000-0000-4000-8000-000000000001";

// ── a table-backed fake that understands `metadata->>key` ────────────────────

interface FState {
  rows?: Record<string, any[]>;
  errors?: string[];
}

function fClient(state: FState = {}) {
  const db: Record<string, any[]> = JSON.parse(JSON.stringify(state.rows ?? {}));
  const reads: Array<{ table: string; filters: string[] }> = [];
  let n = 0;
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const names: string[] = [];
    let mode: "select" | "insert" = "select";
    let inserted: any = null;
    let lim: number | null = null;
    const val = (r: any, col: string) => {
      const m = /^(\w+)->>(\w+)$/.exec(col);
      return m ? (r[m[1]!] ?? {})[m[2]!] : r[col];
    };
    const result = () => {
      if ((state.errors ?? []).includes(table) && mode === "select") return { data: null, error: { message: `${table} unreadable` } };
      if (mode === "insert") return { data: inserted, error: null };
      let out = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (lim !== null) out = out.slice(0, lim);
      return { data: out, error: null };
    };
    const t: any = {
      select() { if (mode === "select") reads.push({ table, filters: names }); return p; },
      insert(row: any) { mode = "insert"; inserted = { id: `row-${++n}`, created_at: new Date().toISOString(), ...row }; (db[table] ??= []).push(inserted); return p; },
      eq(c: string, v: any) { names.push(`${c}=eq`); filters.push((r) => String(val(r, c)) === String(v)); return p; },
      neq(c: string, v: any) { names.push(`${c}=neq`); filters.push((r) => String(val(r, c)) !== String(v)); return p; },
      is(c: string, v: any) { names.push(`${c}=is`); filters.push((r) => (v === null ? val(r, c) == null : val(r, c) === v)); return p; },
      in(c: string, vs: any[]) { names.push(`${c}=in`); filters.push((r) => vs.map(String).includes(String(val(r, c)))); return p; },
      gt(c: string, v: any) { names.push(`${c}=gt`); filters.push((r) => String(val(r, c)) > String(v)); return p; },
      limit(k: number) { lim = k; return p; },
      maybeSingle() { const r = result(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
      single() { return t.maybeSingle(); },
      then(res: any, rej?: any) { return Promise.resolve(result()).then(res, rej); },
    };
    const p: any = new Proxy(t, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
    return p;
  }
  return { from, db, reads, rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }) } as any;
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function priorNotification(over: Record<string, unknown>) {
  return { id: `n-${Math.random()}`, user_id: BOB, category: "plans", event_type: "plan.item_updated", source_type: "plan_item", source_id: "p1", metadata: {}, created_at: ago(2), ...over };
}

// ── T397 — the causal identity ───────────────────────────────────────────────

describe("T397 — one underlying event, one notification, whatever category reports it", () => {
  const PLAN_CHANGE = causalEventIdOf({ objectType: "PLAN", objectId: "plan-1", version: 7 })!;

  it("causalEventIdOf names the CHANGE, so two producers compute the same id without knowing about each other", () => {
    assert.equal(PLAN_CHANGE, "PLAN:plan-1@7");
    assert.equal(causalEventIdOf({ objectType: "PLAN", objectId: "plan-1", version: 7 }), PLAN_CHANGE, "deterministic");
    assert.notEqual(causalEventIdOf({ objectType: "PLAN", objectId: "plan-1", version: 8 }), PLAN_CHANGE, "the next change is a new event");
    assert.equal(causalEventIdOf({ objectType: "MESSAGE", objectId: MESSAGE }), `MESSAGE:${MESSAGE}`);
    assert.equal(causalEventIdOf({ objectType: "plan", objectId: "x" }), null, "not the minted shape: no id at all");
    assert.equal(causalEventIdOf({ objectType: "PLAN", objectId: "has space" }), null);
    assert.equal(isCausalEventId("PLAN:plan-1@7"), true);
    assert.equal(isCausalEventId(""), false);
  });

  it("a Trip notification about a Plan change the person was ALREADY told about (as a Plan notification) is a duplicate", async () => {
    const sc = fClient({ rows: { notifications: [priorNotification({ metadata: { causal_event_id: PLAN_CHANGE } })] } });
    const r = await new NotificationDeduplicationService(sc).check({
      userId: BOB, category: "trips", eventType: "trip.plan_updated", sourceType: "trip", sourceId: "trip-1", causalEventId: PLAN_CHANGE,
    });
    assert.deepEqual(r, { isDuplicate: true, reason: "causal_duplicate" });
    const causal = sc.reads.find((x: { table: string; filters: string[] }) => x.filters.includes("metadata->>causal_event_id=eq"));
    assert.ok(causal, "the rule reads by the causal id");
    for (const f of ["category=eq", "event_type=eq", "source_type=eq", "source_id=eq"]) {
      assert.ok(!causal.filters.includes(f), `the causal read is narrowed by ${f} — then two categories can never match`);
    }
  });

  it("CONTROL: without the id, the same two notifications are not duplicates (the redundancy §30A.6 names)", async () => {
    const sc = fClient({ rows: { notifications: [priorNotification({ metadata: { causal_event_id: PLAN_CHANGE } })] } });
    const r = await new NotificationDeduplicationService(sc).check({ userId: BOB, category: "trips", eventType: "trip.plan_updated", sourceType: "trip", sourceId: "trip-1" });
    assert.equal(r.isDuplicate, false);
  });

  it("a different event, or another person's notification, is not a duplicate", async () => {
    const sc = fClient({ rows: { notifications: [priorNotification({ metadata: { causal_event_id: PLAN_CHANGE } }), priorNotification({ user_id: CARL, metadata: { causal_event_id: "PLAN:plan-1@8" } })] } });
    const svc = new NotificationDeduplicationService(sc);
    assert.equal((await svc.check({ userId: BOB, category: "trips", eventType: "trip.plan_updated", sourceType: "trip", sourceId: "trip-1", causalEventId: "PLAN:plan-1@8" })).isDuplicate, false);
  });

  it("the rule looks back a day, not forever", async () => {
    const sc = fClient({ rows: { notifications: [priorNotification({ metadata: { causal_event_id: PLAN_CHANGE }, created_at: new Date(Date.now() - CAUSAL_DEDUP_WINDOW_MS - 60_000).toISOString() })] } });
    assert.equal((await new NotificationDeduplicationService(sc).check({ userId: BOB, category: "trips", eventType: "trip.plan_updated", causalEventId: PLAN_CHANGE })).isDuplicate, false);
  });

  it("P0 safety is never suppressed by it — a second safety alert about one event still goes", async () => {
    const sc = fClient({ rows: { notifications: [priorNotification({ category: "safe_return", event_type: "safe_return.missed", metadata: { causal_event_id: "SAFE_RETURN:s1" } })] } });
    const r = await new NotificationDeduplicationService(sc).check({ userId: BOB, category: "safe_return", eventType: "safe_return.trusted_circle_alert", causalEventId: "SAFE_RETURN:s1" });
    assert.equal(r.isDuplicate, false);
  });

  it("an UNREADABLE ledger is a duplicate (fail closed), as every other rule here answers", async () => {
    const sc = fClient({ errors: ["notifications"] });
    const r = await new NotificationDeduplicationService(sc).check({ userId: BOB, category: "trips", eventType: "trip.plan_updated", causalEventId: PLAN_CHANGE });
    assert.deepEqual(r, { isDuplicate: true, reason: "causal_duplicate" });
  });

  it("a malformed id is not acted on: no causal read at all", async () => {
    const sc = fClient({ rows: { notifications: [priorNotification({ metadata: { causal_event_id: "whatever" } })] } });
    const r = await new NotificationDeduplicationService(sc).check({ userId: BOB, category: "trips", eventType: "trip.plan_updated", causalEventId: "whatever" });
    assert.equal(r.isDuplicate, false);
    assert.ok(!sc.reads.some((x: { filters: string[] }) => x.filters.includes("metadata->>causal_event_id=eq")));
  });

  it("NotificationService.create persists the id, and the next producer's notification about the same event is refused as a duplicate", async () => {
    const sc = fClient({ rows: { notifications: [], feature_flags: [] } });
    const ns = new NotificationService(sc);
    const first = await ns.createDetailed({ userId: BOB, eventType: "plan.item_updated", params: { actor: "Alice" }, sourceType: "plan_item", sourceId: "p1", causalEventId: PLAN_CHANGE });
    assert.ok(first.row, `the first report was not written: ${first.refusal}`);
    assert.equal(sc.db.notifications[0].metadata.causal_event_id, PLAN_CHANGE);
    const second = await ns.createDetailed({ userId: BOB, eventType: "trip.plan_updated", params: { actor: "Alice" }, sourceType: "trip", sourceId: "trip-1", causalEventId: PLAN_CHANGE });
    assert.equal(second.refusal, "duplicate");
    assert.equal(sc.db.notifications.length, 1);
    const unrelated = await ns.createDetailed({ userId: BOB, eventType: "trip.plan_updated", params: { actor: "Alice" }, sourceType: "trip", sourceId: "trip-1", causalEventId: "PLAN:plan-1@8" });
    assert.ok(unrelated.row, "the next change is told");
  });

  it("a malformed id is not persisted as if it named an event", async () => {
    const sc = fClient({ rows: { notifications: [], feature_flags: [] } });
    await new NotificationService(sc).createDetailed({ userId: BOB, eventType: "plan.item_updated", params: { actor: "Alice" }, metadata: { k: 1 }, causalEventId: "nonsense" });
    assert.deepEqual(sc.db.notifications[0].metadata, { k: 1 });
  });
});

// ── T395 — the COORDINATION cause ────────────────────────────────────────────

describe("T395 — §30A.6's COORDINATION cause has a template, a band and fixed words", () => {
  it("COORDINATION is one of §30A.6's eight causes, and now has a notification of its own", () => {
    assert.ok((NOTIFICATION_CAUSES as readonly string[]).includes("COORDINATION"));
    const t = getTemplate(COORDINATION_NOTIFICATION_EVENT);
    assert.ok(t, "no telegraph.coordination template");
    assert.equal(t!.category, "telegraph");
    assert.deepEqual(t!.defaultChannels, ["in_app", "push"], "not the telegraph channel: a coordination push must not post a second message into the thread");
    assert.equal(bandFor(COORDINATION_NOTIFICATION_EVENT), "P1_COORDINATION", "§19: coordination is P1");
  });

  it("the words are the act's own fixed phrase and the actor — nothing else", () => {
    const r = renderTemplate(COORDINATION_NOTIFICATION_EVENT, { actor: "@alice", act: COORDINATION_ACT_PHRASES.RUNNING_LATE, threadId: THREAD });
    assert.equal(r!.title, "Coordination update");
    assert.equal(r!.body, "@alice is running late");
    assert.equal(r!.actionUrl, `/messages/${THREAD}`);
  });

  it("every §9.1 quick state but NEED_HELP is a coordination act; NEED_HELP is SAFETY, never filed as coordination", () => {
    for (const s of COORDINATION_QUICK_STATES) {
      const act = coordinationActOf("COORDINATION", { state: s, note: "secret note" });
      if (s === "NEED_HELP") assert.equal(act, null, "a thread mute must never silence a NEED_HELP");
      else assert.equal(act, s);
    }
    assert.equal(coordinationActOf("COORDINATION_SESSION", { title: "Dinner" }), "SESSION_STARTED");
    assert.equal(coordinationActOf("DECISION", { state: "ON_MY_WAY" }), null);
    assert.equal(coordinationActOf("COORDINATION", { state: "SESSION_STARTED" }), null, "a payload cannot claim the session act");
    assert.equal(coordinationActOf("COORDINATION", { state: "constructor" }), null);
    assert.equal(coordinationActOf("COORDINATION", null), null);
  });
});

/** Members: Alice (actor), Bob (told), Carl (blocked Alice), Dana (muted), Erin (left). */
function coordRows(extra: Record<string, any[]> = {}) {
  return {
    feature_flags: [],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, muted_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, muted_at: null },
      { thread_id: THREAD, user_id: CARL, left_at: null, muted_at: null },
      { thread_id: THREAD, user_id: DANA, left_at: null, muted_at: "2026-10-01T00:00:00.000Z" },
      { thread_id: THREAD, user_id: ERIN, left_at: "2026-10-01T00:00:00.000Z", muted_at: null },
    ],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }],
    profiles: [{ id: ALICE, handle: "alice", display_name: "Alice Real" }],
    profile_privacy_settings: [],
    notifications: [],
    ...extra,
  };
}

function recordingDeps() {
  const created: CreateNotificationInput[] = [];
  const routed: string[] = [];
  const deps: CoordinationNotifyDeps = {
    async create(input) { created.push(input); return { id: `n-${created.length}`, userId: input.userId } as NotificationRow; },
    async route(row) { routed.push(row.userId); },
  };
  return { deps, created, routed };
}

const act = (over: Partial<Parameters<typeof notifyCoordinationAct>[1]> = {}) => ({ threadId: THREAD, actorId: ALICE, act: "ON_MY_WAY" as const, messageId: MESSAGE, nowMs: Date.now(), ...over });

describe("T395 — who is told about a coordination act", () => {
  it("the other active members, minus a block either way and a mute; each told once, with fixed words and the act's causal id", async () => {
    const { deps, created, routed } = recordingDeps();
    const r = await notifyCoordinationAct(fClient({ rows: coordRows() }), act(), { deps });
    assert.equal(r.status, "notified");
    assert.deepEqual(created.map((c) => c.userId), [BOB], "only Bob: Carl blocked Alice, Dana muted the thread, Erin left, Alice is the actor");
    assert.deepEqual(routed, [BOB]);
    const c = created[0]!;
    assert.equal(c.eventType, "telegraph.coordination");
    assert.equal(c.sourceType, "telegraph_coordination");
    assert.equal(c.sourceId, `${THREAD}:${ALICE}:ON_MY_WAY`, "a double-tap is one notification, a change of state is not");
    assert.equal(c.causalEventId, `MESSAGE:${MESSAGE}`, "the act's own record is the causal event (T397)");
    assert.deepEqual(c.params, { actor: "@alice", act: "is on the way", threadId: THREAD }, "the real name is not shown: Alice does not show it");
    assert.ok(r.status === "notified" && r.withheld.some((w) => w.userId === CARL && w.reason === "blocked"));
    assert.ok(r.status === "notified" && r.withheld.some((w) => w.userId === DANA && w.reason === "muted"));
  });

  it("the shown name only for a person who shows it", async () => {
    const { deps, created } = recordingDeps();
    await notifyCoordinationAct(fClient({ rows: coordRows({ profile_privacy_settings: [{ user_id: ALICE, show_real_name: true }] }) }), act({ act: "SESSION_STARTED" }), { deps });
    assert.equal(created[0]!.params!.actor, "Alice Real");
    assert.equal(created[0]!.params!.act, "started coordinating");
  });

  it("the blocker is withheld too when it is the ACTOR who blocked", async () => {
    const { deps, created } = recordingDeps();
    await notifyCoordinationAct(fClient({ rows: coordRows({ blocks: [{ blocker_id: ALICE, blocked_id: BOB }] }) }), act(), { deps });
    assert.deepEqual(created.map((c) => c.userId).sort(), [CARL].sort(), "Bob is withheld (Alice blocked him); Carl now has no block with Alice");
  });

  for (const [table, stage] of [["message_thread_members", "roster"], ["blocks", "blocks"], ["feature_flags", "thread_policy"]] as const) {
    it(`an unreadable ${table} tells NOBODY (refused at ${stage})`, async () => {
      const { deps, created } = recordingDeps();
      const r = await notifyCoordinationAct(fClient({ rows: coordRows(), errors: [table] }), act(), { deps });
      assert.deepEqual(r, { status: "refused", stage });
      assert.equal(created.length, 0);
    });
  }

  it("never rejects: a pipeline that throws is reported, the members already told stay told", async () => {
    const r = await notifyCoordinationAct(fClient({ rows: coordRows() }), act(), { deps: { create: async () => { throw new Error("boom"); }, route: async () => undefined } });
    assert.equal(r.status, "notified");
    const r2 = await notifyCoordinationAct({ from() { throw new Error("torn down"); } } as any, act(), {});
    assert.deepEqual(r2, { status: "refused", stage: "threw" });
  });
});

describe("T395 — the coordination route produces it", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  before(async () => {
    const { default: router } = await import("../routes/telegraphCoordination.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", router);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(async () => {
    _setTestClient(null, false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function routeClient() {
    const c = fClient({ rows: {
      ...coordRows(),
      feature_flags: [{ flag: "disable_messaging", enabled: false }],
      message_threads: [{ id: THREAD, is_e2ee: false, thread_type: "group", status: "active" }],
      messages: [],
    } });
    return { ...c, auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) }, channel: () => ({ send: async () => undefined, subscribe: () => undefined }), removeChannel: async () => undefined };
  }
  async function post(body: unknown) {
    const r = await fetch(`${base}/threads/${THREAD}/coordination`, { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as { id?: string; error?: string } | null };
  }
  async function settle(c: { db: Record<string, any[]> }, want: number) {
    for (let i = 0; i < 50 && (c.db.notifications ?? []).filter((n) => n.event_type === "telegraph.coordination").length < want; i++) await new Promise((r) => setTimeout(r, 10));
    return (c.db.notifications ?? []).filter((n) => n.event_type === "telegraph.coordination");
  }

  it("a quick state: Bob's notification is written (Carl, Dana and Erin are not), and the response did not wait for it", async () => {
    const c = routeClient();
    _setTestClient(c, true);
    const r = await post({ kind: "COORDINATION", payload: { state: "RUNNING_LATE", note: "stuck behind the tram on Tran Phu" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const told = await settle(c, 1);
    assert.deepEqual(told.map((n) => n.user_id), [BOB]);
    assert.equal(told[0].body, "@alice is running late", "the sender's note never reaches a notification");
    assert.equal(told[0].metadata.causal_event_id, `MESSAGE:${r.body?.id}`);
  });

  it("NEED_HELP produces no coordination notification", async () => {
    const c = routeClient();
    _setTestClient(c, true);
    const r = await post({ kind: "COORDINATION", payload: { state: "NEED_HELP" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((c.db.notifications ?? []).filter((n: any) => n.event_type === "telegraph.coordination").length, 0);
  });

  it("a coordination session opened tells the members too", async () => {
    const c = routeClient();
    _setTestClient(c, true);
    const r = await post({ kind: "COORDINATION_SESSION", payload: { title: "Dinner", idempotencyKey: "k-1" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const told = await settle(c, 1);
    assert.deepEqual(told.map((n) => n.user_id), [BOB]);
    assert.equal(told[0].body, "@alice started coordinating");
  });
});
