/**
 * census-telegraph T397 (wave 5, lane 7) — the Plan, Trip and Compass producers
 * name the underlying change, so one change never notifies twice.
 *
 * Spec §30A.6: "Deduplicate notifications by underlying causal event. A single
 * Plan change must not create redundant Plan, Trip, Telegraph, and Compass
 * notifications."
 *
 * 49780ca56 built the rule (NotificationDeduplicationService rule 0b) and the
 * mint (`causalEventIdOf`); only the coordination producer passed an id. This
 * suite drives every Plan / Trip / Compass producer that writes through
 * NotificationService and checks each names its change — and, for the one
 * change two producers really do report (a Plan's confirmed time: the Plan
 * producer at POST /meetups/:id/confirm-time and Compass Sense's
 * circle_plan_change), that the second report is refused in either order.
 *
 * WHAT WOULD TURN THIS RED
 *   - a producer that stops passing `causalEventId`, or mints it from its own
 *     category / source instead of the change (the two producers then disagree);
 *   - the confirmed time read from anything but the stored row (Z vs +00:00);
 *   - the meetup push going back outside the ledger (no row, no dedupe);
 *   - a Trip push sent for an in-app row the ledger refused.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/notificationCausalProducers.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { causalEventIdOf, isCausalEventId } from "../services/notifications/NotificationDeduplicationService.js";
import { planStatusEventId, tripStatusEventId, tripMemberEventId, tripJoinRequestEventId } from "../services/notifications/causalEvents.js";
import { PLAN_TIME_CONFIRMED_EVENT, notifyPlanTimeConfirmed, type PlanNotifyDeps } from "../services/notifications/planNotifications.js";
import { renderTemplate, getTemplate } from "../services/notifications/NotificationTemplateService.js";
import type { CreateNotificationInput, NotificationRow } from "../services/notifications/NotificationService.js";
import { runSense } from "../compass/CompassSenseEngine.js";
import { runLiveCheck } from "../compass/CompassLiveEngine.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { readTripMetric, _resetTripMetrics } from "../domain/trips/services/tripMetrics.js";
import { _resetTripPushBudget } from "../domain/trips/policies/tripPush.js";

const ALICE = "a1000000-0000-4000-8000-000000000001"; // organiser / owner
const BOB = "b2000000-0000-4000-8000-000000000002";   // RSVP / invitee / requester
const CARL = "c3000000-0000-4000-8000-000000000003";  // second RSVP
const MEETUP = "d4000000-0000-4000-8000-000000000004";
const OPTION = "e5000000-0000-4000-8000-000000000005";
const TRIP = "f6000000-0000-4000-8000-000000000006";
const REQUEST = "a7000000-0000-4000-8000-000000000007";

// ── a store-backed fake: writes visible to the next read, `metadata->>key` understood ──
type Row = Record<string, any>;
function store(seed: Record<string, Row[]> = {}, opts: { failReads?: string[] } = {}) {
  const db: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  let n = 0;
  const val = (r: Row, col: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? (r[m[1]!] ?? {})[m[2]!] : r[col];
  };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    let conflict = "id";
    let lim: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let head = false;
    const t = () => (db[table] ??= []);
    const exec = (): { data: any; error: any; count?: number | null } => {
      if (mode === "select" && (opts.failReads ?? []).includes(table)) return { data: null, error: { message: `${table} unreadable` }, count: null };
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `${table}-${++n}`, created_at: new Date().toISOString(), ...r }));
        t().push(...rows);
        return { data: rows, error: null };
      }
      if (mode === "upsert") {
        const keys = conflict.split(",").map((k) => k.trim());
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows) {
          const hit = t().find((e) => keys.every((k) => String(e[k]) === String(r[k])));
          if (hit) Object.assign(hit, r); else t().push({ id: `${table}-${++n}`, ...r });
        }
        return { data: rows, error: null };
      }
      const matched = t().filter((r) => filters.every((f) => f(r)));
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: matched, error: null }; }
      if (mode === "delete") { db[table] = t().filter((r) => !matched.includes(r)); return { data: matched, error: null }; }
      let out = [...matched];
      if (order) out.sort((a, b) => (String(a[order!.col]) < String(b[order!.col]) ? -1 : 1) * (order!.asc ? 1 : -1));
      if (lim !== null) out = out.slice(0, lim);
      return { data: head ? null : out.map((r) => ({ ...r })), error: null, count: matched.length }; // copies: a later write must not change a row a handler already read
    };
    const b: any = {
      select(_c?: string, o?: { head?: boolean }) { if (o?.head) head = true; return p; },
      insert(r: any) { mode = "insert"; payload = r; return p; },
      upsert(r: any, o?: { onConflict?: string }) { mode = "upsert"; payload = r; conflict = o?.onConflict ?? "id"; return p; },
      update(r: any) { mode = "update"; payload = r; return p; },
      delete() { mode = "delete"; return p; },
      eq(c: string, v: any) { filters.push((r) => String(val(r, c)) === String(v)); return p; },
      neq(c: string, v: any) { filters.push((r) => String(val(r, c)) !== String(v)); return p; },
      in(c: string, vs: any[]) { filters.push((r) => vs.map(String).includes(String(val(r, c)))); return p; },
      is(c: string, v: any) { filters.push((r) => (v === null ? val(r, c) == null : val(r, c) === v)); return p; },
      gt(c: string, v: any) { filters.push((r) => String(val(r, c) ?? "") > String(v)); return p; },
      gte(c: string, v: any) { filters.push((r) => String(val(r, c) ?? "") >= String(v)); return p; },
      lt(c: string, v: any) { filters.push((r) => String(val(r, c) ?? "") < String(v)); return p; },
      lte(c: string, v: any) { filters.push((r) => String(val(r, c) ?? "") <= String(v)); return p; },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return p; },
      limit(k: number) { lim = k; return p; },
      maybeSingle() { const r = exec(); if (r.error) return Promise.resolve({ data: null, error: r.error }); const rows = Array.isArray(r.data) ? r.data : []; return Promise.resolve(rows.length > 1 && mode === "select" ? { data: null, error: { code: "PGRST116" } } : { data: rows[0] ?? null, error: null }); },
      single() { const r = exec(); if (r.error) return Promise.resolve({ data: null, error: r.error }); const rows = Array.isArray(r.data) ? r.data : []; return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116" } }); },
      then(res: any, rej?: any) { return Promise.resolve(exec()).then(res, rej); },
    };
    const p: any = new Proxy(b, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
    return p;
  }
  return {
    db,
    from,
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    channel: () => ({ send: async () => undefined, subscribe: () => undefined, on() { return this; } }),
    removeChannel: async () => undefined,
  } as any;
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const causalRows = (sc: { db: Record<string, Row[]> }, user: string, id: string | undefined) =>
  (sc.db.notifications ?? []).filter((r) => r.user_id === user && r.metadata?.causal_event_id === id);
async function settle(pred: () => boolean, ms = 8000) { // a fire-and-forget block may dynamic-import a module graph first
  for (let i = 0; i < ms / 10 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
}

// ── 1. the names ─────────────────────────────────────────────────────────────

describe("T397 — the underlying events are named once, from the change", () => {
  it("a Plan's confirmed time: the stored start, normalised, so '+00:00' and 'Z' are one event", () => {
    const a = planStatusEventId(MEETUP, "confirmed", "2026-10-20T18:00:00+00:00");
    const b = planStatusEventId(MEETUP, "confirmed", "2026-10-20T18:00:00.000Z");
    assert.equal(a, `PLAN:${MEETUP}@confirmed:${Date.parse("2026-10-20T18:00:00Z")}`);
    assert.equal(a, b, "the Plan producer reads the row back as +00:00, Compass may hold Z — one event");
    assert.notEqual(planStatusEventId(MEETUP, "confirmed", "2026-10-20T19:00:00Z"), a, "a meetup confirmed for 8pm and then 9pm is two pieces of news (§19 P1)");
    assert.equal(planStatusEventId(MEETUP, "confirmed", null), `PLAN:${MEETUP}@confirmed`);
    assert.equal(planStatusEventId(MEETUP, "cancelled"), `PLAN:${MEETUP}@cancelled`);
    for (const id of [a, planStatusEventId(MEETUP, "cancelled")]) assert.ok(isCausalEventId(id), `${id} is not an id the dedupe service acts on`);
  });

  it("trip events: status, membership and join request — each through causalEventIdOf", () => {
    assert.equal(tripStatusEventId(TRIP, "completed"), causalEventIdOf({ objectType: "TRIP", objectId: TRIP, version: "completed" }));
    assert.equal(tripMemberEventId(TRIP, BOB, "invited"), `TRIP_MEMBER:${TRIP}:${BOB}@invited`);
    assert.equal(tripJoinRequestEventId(REQUEST, "approved"), `TRIP_JOIN_REQUEST:${REQUEST}@approved`);
    assert.notEqual(tripJoinRequestEventId(REQUEST, "declined"), tripJoinRequestEventId(REQUEST, "approved"));
  });

  it("a part that would not round-trip yields no id at all (never a malformed one)", () => {
    assert.equal(planStatusEventId("has space", "cancelled"), undefined);
    assert.equal(tripStatusEventId(TRIP, "bad status!"), undefined);
  });
});

// ── 2. the Plan producer ─────────────────────────────────────────────────────

function recordingDeps() {
  const created: CreateNotificationInput[] = [];
  const routed: string[] = [];
  const deps: PlanNotifyDeps = {
    async create(input) { created.push(input); return input.userId === "refused" ? null : ({ id: `n-${created.length}`, userId: input.userId } as NotificationRow); },
    async route(row) { routed.push(row.userId); },
  };
  return { deps, created, routed };
}

describe("T397 — the Plan producer (a meetup's confirmed time) writes through the ledger", () => {
  const STORED = "2026-10-20T18:00:00+00:00";
  it("one notification per RSVP, never the confirmer, each carrying the change's causal id, routed only when written", async () => {
    const { deps, created, routed } = recordingDeps();
    const r = await notifyPlanTimeConfirmed({} as any, { meetupId: MEETUP, actorId: ALICE, actorLabel: "@alice", recipientIds: [BOB, CARL, ALICE, BOB, "refused"], meetupTitle: "Sunset drinks", when: "Tue, Oct 20 · 6:00 PM", storedStartsAt: STORED }, { deps });
    assert.deepEqual(created.map((c) => c.userId).sort(), [BOB, CARL, "refused"].sort(), "the confirmer is never told about their own act; a duplicate RSVP is told once");
    for (const c of created) {
      assert.equal(c.eventType, PLAN_TIME_CONFIRMED_EVENT);
      assert.equal(c.causalEventId, planStatusEventId(MEETUP, "confirmed", STORED));
      assert.equal(c.sourceType, "meetup");
      assert.equal(c.sourceId, MEETUP);
    }
    assert.deepEqual(routed.sort(), [BOB, CARL].sort(), "a refused row is not pushed");
    assert.deepEqual(r.notCreated, ["refused"]);
  });

  it("the words are the old push's words, and the tap lands on the meetup", () => {
    const t = getTemplate(PLAN_TIME_CONFIRMED_EVENT)!;
    assert.deepEqual(t.defaultChannels, ["in_app", "push"]);
    const r = renderTemplate(PLAN_TIME_CONFIRMED_EVENT, { actor: "@alice", meetupTitle: "Sunset drinks", when: "Tue, Oct 20 · 6:00 PM", meetupId: MEETUP })!;
    assert.equal(r.title, "@alice confirmed a meetup time");
    assert.equal(r.body, "Sunset drinks — Tue, Oct 20 · 6:00 PM");
    assert.equal(r.actionUrl, `/meetup/${MEETUP}`);
    assert.equal(r.category, "plans");
  });

  it("never rejects: a pipeline that throws for one recipient leaves the rest told", async () => {
    let calls = 0;
    const r = await notifyPlanTimeConfirmed({} as any, { meetupId: MEETUP, actorId: ALICE, actorLabel: "@alice", recipientIds: [BOB, CARL], meetupTitle: "x", when: "y", storedStartsAt: STORED }, { deps: { create: async (i) => { calls++; if (i.userId === BOB) throw new Error("boom"); return { id: "n", userId: i.userId } as NotificationRow; }, route: async () => undefined } });
    assert.equal(calls, 2);
    assert.deepEqual(r.notified, [CARL]);
  });
});

// ── 3. the routes and engines, end to end on one store ───────────────────────

function meetupWorld(extra: Record<string, Row[]> = {}) {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    meetups: [{ id: MEETUP, creator_id: ALICE, title: "Sunset drinks", status: "active", trip_id: null, circle_owner_id: null, location_name: null, updated_at: minsAgo(300), visibility: "private" }],
    meetup_time_options: [{ id: OPTION, meetup_id: MEETUP, proposed_date: "2026-10-20", proposed_time: "18:00:00", time_block: null, confirmed: false }],
    meetup_invites: [{ meetup_id: MEETUP, user_id: BOB, status: "going" }, { meetup_id: MEETUP, user_id: CARL, status: "maybe" }, { meetup_id: MEETUP, user_id: ALICE, status: "going" }],
    profiles: [{ id: ALICE, name: "Alice Real", handle: "alice" }, { id: BOB, handle: "bob" }, { id: CARL, handle: "carl" }],
    compass_sense_settings: [{ user_id: BOB, presence_level: "active", categories: {} }],
    notifications: [],
    ...extra,
  };
}

describe("T397 — one Plan change, two producers (Plan and Compass), one notification", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  before(async () => {
    const { default: meetups } = await import("../routes/meetups.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } }; next(); });
    app.use("/api", meetups);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(async () => {
    _setTestClient(null, false);
    _setTestServiceClient(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => invalidateFlagsCache());

  async function confirm(sc: any) {
    _setTestClient(sc, true);
    const r = await fetch(`${base}/meetups/${MEETUP}/confirm-time`, { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify({ optionId: OPTION }) });
    const body = (await r.json().catch(() => null)) as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    await settle(() => (sc.db.notifications ?? []).filter((n: Row) => n.event_type === PLAN_TIME_CONFIRMED_EVENT).length >= 2);
    return body;
  }

  it("the Plan producer: a row per RSVP (not the confirmer), each carrying PLAN:<id>@confirmed:<stored start>", async () => {
    const sc = store(meetupWorld());
    await confirm(sc);
    const stored = sc.db.meetups[0].starts_at;
    const id = planStatusEventId(MEETUP, "confirmed", stored)!;
    assert.match(id, /^PLAN:.+@confirmed:\d+$/);
    const rows = sc.db.notifications.filter((n: Row) => n.event_type === PLAN_TIME_CONFIRMED_EVENT);
    assert.deepEqual(rows.map((n: Row) => n.user_id).sort(), [BOB, CARL].sort());
    for (const n of rows) assert.equal(n.metadata.causal_event_id, id);
    assert.equal(rows[0].title, "@alice confirmed a meetup time", "Alice does not show her real name");
  });

  it("…then Compass Sense, reporting the same confirmation for Bob, is refused as a duplicate (no second row)", async () => {
    const sc = store(meetupWorld());
    await confirm(sc);
    const before = sc.db.notifications.length;
    const r = await runSense(sc, BOB, { hourUtc: 12, nowMinutes: 720 });
    const circle = r.delivered.filter((d) => d.type === "circle_plan_change");
    assert.equal(circle.length, 1, `Sense evaluated the change: ${JSON.stringify(r)}`);
    assert.equal(circle[0]!.causalEventId, planStatusEventId(MEETUP, "confirmed", sc.db.meetups[0].starts_at), "Compass names the change exactly as the Plan producer did");
    assert.equal(sc.db.notifications.length, before, "a second notification about one Plan change");
    assert.equal(sc.db.notifications.filter((n: Row) => n.user_id === BOB && n.event_type === "compass.sense.circle_plan_change").length, 0);
  });

  it("the other order: Compass told Bob first, so the Plan producer's notification to Bob is refused — Carl is still told", async () => {
    const stored = "2026-10-20T18:00:00+00:00";
    const sc = store(meetupWorld({ meetups: [{ id: MEETUP, creator_id: ALICE, title: "Sunset drinks", status: "confirmed", starts_at: stored, updated_at: minsAgo(5) }] }));
    const r = await runSense(sc, BOB, { hourUtc: 12, nowMinutes: 720 });
    assert.equal(r.delivered.filter((d) => d.type === "circle_plan_change").length, 1);
    const id = planStatusEventId(MEETUP, "confirmed", stored);
    assert.equal(causalRows(sc, BOB, id).length, 1, "Compass's row carries the change's id");
    await notifyPlanTimeConfirmed(sc, { meetupId: MEETUP, actorId: ALICE, actorLabel: "@alice", recipientIds: [BOB, CARL], meetupTitle: "Sunset drinks", when: "6pm", storedStartsAt: stored });
    assert.equal(causalRows(sc, BOB, id).length, 1, "Bob was told twice about one Plan change");
    assert.equal(causalRows(sc, CARL, id).length, 1, "Carl, whom Compass never told, is told by the Plan producer");
  });

  it("CONTROL: a confirmation for a different time is a different change, and is told", async () => {
    const sc = store(meetupWorld({ meetups: [{ id: MEETUP, creator_id: ALICE, title: "Sunset drinks", status: "confirmed", starts_at: "2026-10-20T18:00:00+00:00", updated_at: minsAgo(5) }] }));
    await runSense(sc, BOB, { hourUtc: 12, nowMinutes: 720 });
    await notifyPlanTimeConfirmed(sc, { meetupId: MEETUP, actorId: ALICE, actorLabel: "@alice", recipientIds: [BOB], meetupTitle: "Sunset drinks", when: "7pm", storedStartsAt: "2026-10-20T19:00:00+00:00" });
    assert.equal(sc.db.notifications.filter((n: Row) => n.user_id === BOB).length, 2);
  });

  it("Compass Live carries the same id for a Sense-derived Plan change, so the Plan producer after it is refused", async () => {
    const stored = "2026-10-20T18:00:00+00:00";
    const sc = store(meetupWorld({
      meetups: [{ id: MEETUP, creator_id: ALICE, title: "Sunset drinks", status: "confirmed", starts_at: stored, updated_at: minsAgo(5) }],
      compass_live_sessions: [{ id: "live-1", user_id: BOB, status: "active", started_at: minsAgo(30), context: {}, nudges_delivered: 0, checks: 0 }],
    }));
    const r = await runLiveCheck(sc, BOB, { hourUtc: 12 });
    const live = r.delivered.find((d) => d.type === "circle_plan_change");
    assert.ok(live, `Live did not deliver the Sense candidate: ${JSON.stringify(r)}`);
    const id = planStatusEventId(MEETUP, "confirmed", stored);
    assert.equal(causalRows(sc, BOB, id).length, 1, "Live's row names the change");
    assert.equal(causalRows(sc, BOB, id)[0].event_type, "compass.live.circle_plan_change");
    await notifyPlanTimeConfirmed(sc, { meetupId: MEETUP, actorId: ALICE, actorLabel: "@alice", recipientIds: [BOB], meetupTitle: "Sunset drinks", when: "6pm", storedStartsAt: stored });
    assert.equal(causalRows(sc, BOB, id).length, 1, "the Plan producer told Bob again after Compass Live had");
  });

  it("a nudge that reports no change carries no id (rain today, a saved event starting)", async () => {
    const sc = store({ feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }], compass_sense_settings: [{ user_id: BOB, presence_level: "active", categories: {} }], event_saves: [{ event_id: "e1", user_id: BOB }], events: [{ id: "e1", title: "Jazz", starts_at: new Date(Date.now() + 3600_000).toISOString(), state: "published" }], notifications: [] });
    const r = await runSense(sc, BOB, { hourUtc: 12, nowMinutes: 720 });
    assert.equal(r.delivered.length, 1);
    assert.equal(r.delivered[0]!.causalEventId, undefined);
    assert.equal(sc.db.notifications[0].metadata.causal_event_id, undefined);
  });
});

// ── 4. the Trip producers ────────────────────────────────────────────────────

const attention = (kind: string) => readTripMetric("trip_notification_attention_total").filter((s) => s.labels.kind === kind).reduce((a, s) => a + s.count, 0);

describe("T397 — the Trip producers name their change, and push only what the ledger wrote", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  before(async () => {
    const { default: trips } = await import("../routes/trips.js");
    const { default: tripsExpansion } = await import("../routes/trips-expansion.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } }; next(); });
    app.use("/api", trips);
    app.use("/api", tripsExpansion);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: "db_error", message: String(err?.message ?? err) }));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(async () => {
    _setTestClient(null, false);
    _setTestServiceClient(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => { _resetTripMetrics(); _resetTripPushBudget(); invalidateFlagsCache(); });

  function tripWorld(extra: Record<string, Row[]> = {}) {
    return {
      feature_flags: [],
      trips: [{ id: TRIP, owner_id: ALICE, title: "Hoi An", status: "upcoming", visibility: "private" }],
      trip_members: [{ trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" }],
      trip_join_requests: [{ id: REQUEST, trip_id: TRIP, user_id: BOB, status: "pending", created_at: minsAgo(60) }],
      profiles: [{ id: ALICE, handle: "alice", display_name: "Alice Real" }, { id: BOB, handle: "bob", expo_push_token: "ExponentPushToken[bob]" }],
      blocks: [],
      notifications: [],
      ...extra,
    };
  }
  async function post(path: string, body: unknown = {}) {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }

  for (const [outcome, kind, eventType] of [["approve", "trip_join_approved", "trip.join_approved"], ["decline", "trip_join_declined", "trip.join_declined"]] as const) {
    it(`join request ${outcome}: the row carries TRIP_JOIN_REQUEST:<id>@${outcome}d and the push follows the row`, async () => {
      const sc = store(tripWorld());
      _setTestClient(sc, true);
      const r = await post(`/trips/${TRIP}/join-requests/${REQUEST}/${outcome}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const id = tripJoinRequestEventId(REQUEST, `${outcome}d`);
      await settle(() => causalRows(sc, BOB, id).length > 0 && attention(kind) > 0);
      const rows = causalRows(sc, BOB, id);
      assert.equal(rows.length, 1, JSON.stringify(sc.db.notifications));
      assert.equal(rows[0].event_type, eventType);
      assert.equal(attention(kind), 1, "the push was judged once, after the row");
    });

    it(`join request ${outcome}: when another producer already told Bob about this answer, neither the row NOR the push is sent`, async () => {
      const id = tripJoinRequestEventId(REQUEST, `${outcome}d`);
      const sc = store(tripWorld({ notifications: [{ id: "prior", user_id: BOB, category: "telegraph", event_type: "telegraph.coordination", source_type: "x", source_id: "y", metadata: { causal_event_id: id }, created_at: minsAgo(1) }] }));
      _setTestClient(sc, true);
      const r = await post(`/trips/${TRIP}/join-requests/${REQUEST}/${outcome}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(causalRows(sc, BOB, id).length, 1, "a second notification about one answer");
      assert.equal(attention(kind), 0, "pushed although the ledger refused the notification");
    });
  }

  it("an invitation: the row carries TRIP_MEMBER:<trip>:<invitee>@invited, and the push follows the row", async () => {
    const sc = store(tripWorld({ trip_join_requests: [] }));
    _setTestClient(sc, true);
    const r = await post(`/trips/${TRIP}/invite`, { userId: BOB });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = tripMemberEventId(TRIP, BOB, "invited");
    await settle(() => causalRows(sc, BOB, id).length > 0 && attention("trip_invite_received") > 0);
    assert.equal(causalRows(sc, BOB, id)[0]?.event_type, "trip.invite_received", JSON.stringify(sc.db.notifications));
    assert.equal(attention("trip_invite_received"), 1);
  });

  it("an invitation already told by another producer: no second row and no push", async () => {
    const id = tripMemberEventId(TRIP, BOB, "invited");
    const sc = store(tripWorld({ trip_join_requests: [], notifications: [{ id: "prior", user_id: BOB, category: "telegraph", event_type: "telegraph.message_request", source_type: "x", source_id: "y", metadata: { causal_event_id: id }, created_at: minsAgo(1) }] }));
    _setTestClient(sc, true);
    const r = await post(`/trips/${TRIP}/invite`, { userId: BOB });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(causalRows(sc, BOB, id).length, 1);
    assert.equal(attention("trip_invite_received"), 0);
  });

  async function complete(sc: any) {
    _setTestClient(sc, true);
    const r = await fetch(`${base}/trips/${TRIP}`, { method: "PATCH", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify({ status: "completed" }) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }
  function completionWorld(extra: Record<string, Row[]> = {}) {
    return tripWorld({
      trips: [{ id: TRIP, owner_id: ALICE, title: "Hoi An", destination_city: "Hoi An", start_date: "2026-09-01", end_date: "2026-09-05", status: "active", visibility: "private" }],
      trip_members: [{ trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" }, { trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" }],
      trip_join_requests: [],
      ...extra,
    });
  }

  it("the trip's completion (review prompt): every member's row carries TRIP:<id>@completed, and the push follows the rows", async () => {
    const sc = store(completionWorld());
    const r = await complete(sc);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = tripStatusEventId(TRIP, "completed");
    await settle(() => causalRows(sc, BOB, id).length > 0 && causalRows(sc, ALICE, id).length > 0 && attention("review_prompt") >= 1);
    assert.equal(causalRows(sc, BOB, id)[0]?.event_type, "trip.review_prompt", JSON.stringify(sc.db.notifications));
    assert.equal(causalRows(sc, ALICE, id).length, 1);
    await settle(() => attention("review_prompt") >= 2);
    assert.equal(attention("review_prompt"), 2, "one push decision per member whose row was written");
  });

  it("the trip's completion already told to Bob by another producer: Bob gets no second row and no push; Alice still does", async () => {
    const id = tripStatusEventId(TRIP, "completed");
    const sc = store(completionWorld({ notifications: [{ id: "prior", user_id: BOB, category: "compass", event_type: "compass.sense.x", source_type: "x", source_id: "y", metadata: { causal_event_id: id }, created_at: minsAgo(1) }] }));
    const r = await complete(sc);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle(() => causalRows(sc, ALICE, id).length > 0 && attention("review_prompt") >= 1);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(causalRows(sc, BOB, id).length, 1, "a second notification about one completion");
    assert.equal(causalRows(sc, ALICE, id).length, 1);
    assert.equal(attention("review_prompt"), 1, "Bob was pushed although the ledger refused his row");
  });
});
