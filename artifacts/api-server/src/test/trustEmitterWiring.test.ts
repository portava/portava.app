/**
 * Trust engine — the five emitters wired in this pass, driven through their
 * REAL routes, processed twice, and followed to a persisted profile.
 *
 *   routes/events.ts  DELETE /events/:id, POST /events/:id/cancel  → event_host_cancelled
 *   routes/events.ts  POST /events/:id/reviews                     → event_positive_review / event_negative_review
 *   routes/admin.ts   POST /admin/reports/:id/hide-content         → content_removed
 *   routes/admin.ts   DELETE /admin/users/:userId/{avatar,cover}   → content_removed
 *   routes/admin.ts   POST /admin/reports/:id/resolve {upheld}     → message_report_confirmed
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
 * Every emitter here is fire-and-forget by design (a cancel, a review, a
 * moderation action must not fail because trust bookkeeping did), so the
 * route's 200 says nothing about the ledger. Each test therefore inspects the
 * in-memory `trust_events` table after the request settles and asserts:
 *
 *   1. PROVENANCE — the subject is the accountable user (host / content owner
 *      / message sender), never the reporter and never the admin; the source
 *      is the object (event id, review id, content id, audit row); the admin
 *      appears only as `reviewed_by` and in trust_admin_actions.
 *   2. IDEMPOTENCY — the same trigger delivered twice (a replayed DELETE, both
 *      cancel verbs, an edited review, a double-clicked hide-content, a
 *      replayed avatar removal, a re-resolved report) leaves ONE event, ONE
 *      cap and ONE score.
 *   3. THE CHAIN — event → (pending_review → trust_reviews → confirm → cap) →
 *      recalculateTrustScore / runTrustMaintenance → trust_profiles.
 *   4. THE RULES THAT REFUSE — a draft cancel, an empty event, a neutral
 *      rating, an unowned target, a report resolved without `upheld`, a
 *      dismissed report: nothing is written, and the helper says why.
 *
 * It does NOT prove reachability in production (the routes are mounted; the
 * triggers have simply never fired there — 0 reviews, 0 message reports, 0
 * cancellations as of 2026-09-07) and it does not exercise the database's
 * partial unique index (migration 2540); the 23505 path that index produces is
 * simulated by injecting the resolved error shape supabase-js returns.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustEmitterWiring.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import eventsRouter from "../routes/events.js";
import adminRouter from "../routes/admin.js";
import {
  recordTrustEvent,
  recordEventHostCancelledTrustEvent,
  recordEventReviewTrustEvent,
  EVENT_HOST_CANCEL_TRIGGER_STATES,
  EVENT_REVIEW_RATING_BANDS,
  COUNTERPARTY_METADATA_KEY,
  TRUST_EVENT_TYPES,
} from "../services/trust/TrustEventService.js";
import { recalculateTrustScore, getTrustProfile } from "../services/trust/TrustScoreService.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

// ── Ids ──────────────────────────────────────────────────────────────────────

const HOST      = "10000000-0000-4000-8000-000000000001";
const ATTENDEE  = "10000000-0000-4000-8000-000000000002";
const ATTENDEE2 = "10000000-0000-4000-8000-000000000003";
const ADMIN     = "10000000-0000-4000-8000-00000000000a";
const AUTHOR    = "10000000-0000-4000-8000-000000000004";
const SENDER    = "10000000-0000-4000-8000-000000000005";
const REPORTER  = "10000000-0000-4000-8000-000000000006";
const EVENT_ID  = "20000000-0000-4000-8000-000000000001";
const POST_ID   = "30000000-0000-4000-8000-000000000001";
const MSG_ID    = "40000000-0000-4000-8000-000000000001";
const REPORT_POST = "50000000-0000-4000-8000-000000000001";
const REPORT_MSG  = "50000000-0000-4000-8000-000000000002";
const REPORT_PLACE = "50000000-0000-4000-8000-000000000003";

// ── Fake client: in-memory tables, resolved-error injection ──────────────────

type Row = Record<string, any>;
type Store = Record<string, Row[]>;
type Op = "select" | "insert" | "update" | "upsert" | "delete";

interface Fake {
  client: any;
  tables: Store;
  /** Make the NEXT `op` on `table` resolve `{ data: null, error }` — never throw. */
  failNext(table: string, op: Op, error: { code?: string; message: string }): void;
}

function makeFake(seed: Partial<Store> = {}): Fake {
  const tables: Store = {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: false },
      { flag: "events_enabled", enabled: true },
      { flag: "events_reports_enabled", enabled: true },
    ],
    trust_settings: [{ id: 1, decay_half_life_days: 90 }],
    profiles: [
      { id: ADMIN, role: "admin", account_status: "active", display_name: "Admin" },
      { id: HOST, role: "user", account_status: "active" },
      { id: ATTENDEE, role: "user", account_status: "active" },
      { id: ATTENDEE2, role: "user", account_status: "active" },
      { id: AUTHOR, role: "user", account_status: "active", avatar_url: "https://picsum.photos/200", cover_photo_url: null },
      { id: SENDER, role: "user", account_status: "active" },
    ],
    events: [], event_rsvps: [], event_roles: [], event_attendee_states: [], event_reviews: [],
    event_activity_log: [], posts: [], messages: [], reports: [], moderation_actions: [],
    trust_events: [], trust_caps: [], trust_restrictions: [], trust_profiles: [],
    trust_reviews: [], trust_admin_actions: [], plan_attendance_events: [],
    ...seed,
  };
  const failures = new Map<string, { code?: string; message: string }>();
  let seq = 1;

  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: Op = "select";
    let payload: any = null;
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;

    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(p: any)   { op = "update"; payload = p;   return b; },
      upsert(row: any, opts?: any) { op = "upsert"; payload = { row, key: String(opts?.onConflict ?? "id") }; return b; },
      delete()         { op = "delete"; return b; },
      eq(c: string, v: any)    { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any)   { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any)    { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gt(c: string, v: any)    { filters.push((r) => r[c] > v); return b; },
      gte(c: string, v: any)   { filters.push((r) => r[c] >= v); return b; },
      lt(c: string, v: any)    { filters.push((r) => r[c] < v); return b; },
      lte(c: string, v: any)   { filters.push((r) => r[c] <= v); return b; },
      not(c: string, o: string, v: any) { filters.push((r) => (o === "is" && v === null ? r[c] != null : r[c] !== v)); return b; },
      or(expr: string) {
        const m = /^(\w+)\.is\.null,\1\.gt\.(.+)$/.exec(expr);
        if (m) { const col = m[1]; const iso = m[2]; filters.push((r) => r[col] == null || r[col] > iso); }
        return b;
      },
      ilike() { return b; }, like() { return b; },
      order(col: string, o?: any) { order = { col, asc: o?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      range() { return b; },
      maybeSingle() { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      single()      { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    function matched(): Row[] {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (order) rows = [...rows].sort((a, b2) => (a[order!.col] < b2[order!.col] ? -1 : 1) * (order!.asc ? 1 : -1));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function run(): Promise<{ data: any; error: any; count?: number }> {
      const key = `${table}:${op}`;
      const injected = failures.get(key);
      if (injected) { failures.delete(key); return { data: null, error: injected }; }
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p: any) => ({ id: `fake-${seq++}`, created_at: new Date().toISOString(), ...p }));
        store.push(...rows); return { data: rows, error: null };
      }
      if (op === "upsert") {
        const { row, key: k } = payload as { row: Row; key: string };
        const cols = k.split(",").map((c) => c.trim());
        const i = store.findIndex((r) => cols.every((c) => r[c] === row[c]));
        if (i >= 0) { store[i] = { ...store[i], ...row }; return { data: [store[i]], error: null }; }
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); return { data: [r], error: null };
      }
      if (op === "update") {
        const rows = matched(); rows.forEach((r) => Object.assign(r, payload));
        return { data: rows, error: null };
      }
      if (op === "delete") {
        const rows = matched(); for (const r of rows) store.splice(store.indexOf(r), 1);
        return { data: rows, error: null };
      }
      // Selects return COPIES, as a real client does: a route that reads a row
      // and then updates it must not see its own update through the earlier read.
      const rows = matched().map((r) => ({ ...r }));
      return { data: rows, error: null, count: rows.length };
    }
    return b;
  }

  const client = {
    from,
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    auth: {
      getUser: async (token: string) => {
        const id = token.startsWith("fake-token-") ? token.slice("fake-token-".length) : null;
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad token" } };
      },
    },
  };
  return {
    client, tables,
    failNext(table, op, error) { failures.set(`${table}:${op}`, error); },
  };
}

// ── Server ───────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", eventsRouter);
  app.use("/api", adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

async function req(method: string, path: string, body: unknown, userId: string): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer fake-token-${userId}` },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

/** The emitters are fire-and-forget; let their promise chains drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 15));
}

const evRow = (over: Row = {}): Row => ({
  id: EVENT_ID, host_id: HOST, title: "Wired", state: "open", visibility: "public",
  starts_at: new Date(Date.now() + 48 * 3600e3).toISOString(), going_count: 0, ...over,
});

// ── 1. event_host_cancelled ──────────────────────────────────────────────────

describe("event_host_cancelled — DELETE /events/:id and POST /events/:id/cancel", () => {
  let f: Fake;
  beforeEach(() => {
    f = makeFake({
      events: [evRow()],
      event_rsvps: [{ event_id: EVENT_ID, user_id: ATTENDEE, status: "going" }, { event_id: EVENT_ID, user_id: ATTENDEE2, status: "maybe" }],
    });
    _setTestClient(f.client, true);
  });

  it("the host cancelling a published event with a committed attendee writes ONE event, with the host as subject and the event as source", async () => {
    const r = await req("DELETE", `/api/events/${EVENT_ID}`, null, HOST);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();

    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.user_id, HOST, "the HOST is the subject");
    assert.equal(e.event_type, "event_host_cancelled");
    assert.equal(e.category, TRUST_EVENT_TYPES.EVENT_HOST_CANCELLED.category);
    assert.equal(e.delta, TRUST_EVENT_TYPES.EVENT_HOST_CANCELLED.delta);
    assert.equal(e.severity, TRUST_EVENT_TYPES.EVENT_HOST_CANCELLED.severity);
    assert.equal(e.status, "applied", "moderate → applied, not queued");
    assert.equal(e.source_type, "event");
    assert.equal(e.source_id, EVENT_ID, "keyed on the event id");
    assert.equal(e.metadata.priorState, "open");
    assert.equal(e.metadata.committedAttendees, 1, "'going' counts; 'maybe' does not; the host never does");
    assert.equal(typeof e.metadata.leadTimeHours, "number", "lead time recorded for the owner's policy call");
    assert.equal(f.tables.events[0].state, "cancelled", "the cancel itself happened");
  });

  it("processed twice — DELETE replayed, then POST /cancel on the same event — still ONE event and ONE score", async () => {
    await req("DELETE", `/api/events/${EVENT_ID}`, null, HOST);
    await settle();
    // Replay with the event re-opened (an admin restore, a retried client) —
    // the dedup key is the event id, so the second delivery is a skip.
    f.tables.events[0].state = "open";
    await req("DELETE", `/api/events/${EVENT_ID}`, null, HOST);
    await settle();
    f.tables.events[0].state = "open";
    const r3 = await req("POST", `/api/events/${EVENT_ID}/cancel`, { reason: "again" }, HOST);
    assert.equal(r3.status, 200);
    await settle();
    assert.equal(f.tables.trust_events.length, 1, "two verbs, three deliveries, one event");

    const a = await recalculateTrustScore(f.client, HOST);
    const b = await recalculateTrustScore(f.client, HOST);
    assert.equal(a.overall_score, b.overall_score);
    assert.ok(a.categories.host_quality < 50, "host_quality moved below neutral once");
    assert.equal(f.tables.trust_profiles.length, 1);
  });

  it("POST /events/:id/cancel by the host also produces the event, keyed identically", async () => {
    const r = await req("POST", `/api/events/${EVENT_ID}/cancel`, { reason: "Venue fell through" }, HOST);
    assert.equal(r.status, 200);
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
    assert.equal(f.tables.trust_events[0].source_id, EVENT_ID);
    assert.equal(f.tables.trust_events[0].metadata.reason, "Venue fell through");
  });

  it("a DRAFT cancelled is not a broken commitment — nothing is written", async () => {
    f.tables.events[0].state = "draft";
    const r = await req("DELETE", `/api/events/${EVENT_ID}`, null, HOST);
    assert.equal(r.status, 200);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });

  it("an event nobody committed to is not host-quality evidence — nothing is written", async () => {
    f.tables.event_rsvps.length = 0;
    f.tables.event_rsvps.push({ event_id: EVENT_ID, user_id: HOST, status: "going" }); // the host's own RSVP never counts
    await req("DELETE", `/api/events/${EVENT_ID}`, null, HOST);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });

  it("a non-host is refused by the route and nothing is written", async () => {
    const r = await req("DELETE", `/api/events/${EVENT_ID}`, null, ATTENDEE);
    assert.equal(r.status, 403);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });

  it("the helper names its refusals, so 'skipped by rule' is distinguishable from 'skipped by the engine'", async () => {
    const base = { hostId: HOST, eventId: EVENT_ID, committedAttendees: 1, priorState: "open" };
    assert.deepEqual(EVENT_HOST_CANCEL_TRIGGER_STATES, ["open", "started"]);
    assert.equal((await recordEventHostCancelledTrustEvent(f.client, { ...base, priorState: "draft" })).skipReason, "not_published");
    assert.equal((await recordEventHostCancelledTrustEvent(f.client, { ...base, priorState: "completed" })).skipReason, "not_published");
    assert.equal((await recordEventHostCancelledTrustEvent(f.client, { ...base, committedAttendees: 0 })).skipReason, "no_committed_attendees");
    assert.equal((await recordEventHostCancelledTrustEvent(f.client, base)).ok, true);
    assert.equal((await recordEventHostCancelledTrustEvent(f.client, base)).skipReason, "dedup");
    assert.equal(f.tables.trust_events.length, 1);
  });
});

// ── 2. event_positive_review / event_negative_review ─────────────────────────

describe("event_positive_review / event_negative_review — POST /events/:id/reviews, for the HOST", () => {
  let f: Fake;
  beforeEach(() => {
    f = makeFake({
      events: [evRow({ state: "completed" })],
      event_attendee_states: [
        { event_id: EVENT_ID, user_id: ATTENDEE, confirmed_at: new Date().toISOString() },
        { event_id: EVENT_ID, user_id: ATTENDEE2, confirmed_at: new Date().toISOString() },
      ],
    });
    _setTestClient(f.client, true);
  });

  it("a 5-star review credits the HOST, keyed on the review id, with the reviewer as counterparty", async () => {
    const r = await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 5, body: "Great" }, ATTENDEE);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();

    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.user_id, HOST, "the host is rated; the reviewer is never the subject");
    assert.equal(e.event_type, "event_positive_review");
    assert.equal(e.delta, TRUST_EVENT_TYPES.EVENT_POSITIVE_REVIEW.delta);
    assert.equal(e.source_type, "event_review");
    assert.equal(e.source_id, r.body.id, "keyed on the event_reviews row");
    assert.equal(e.metadata[COUNTERPARTY_METADATA_KEY], ATTENDEE, "the reviewer is the counterparty for the ring scan");
    assert.equal(e.metadata.rating, 5);
    assert.equal(e.metadata.reviewerAnonymous, false);
  });

  it("processed twice — the same reviewer resubmits (an EDIT, same review id) — still ONE event, even if the sentiment flips", async () => {
    await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 5 }, ATTENDEE);
    await settle();
    const r2 = await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 1 }, ATTENDEE);
    assert.equal(r2.status, 201);
    await settle();
    assert.equal(f.tables.event_reviews.length, 1, "upsert kept one review row");
    assert.equal(f.tables.trust_events.length, 1, "one review is one piece of evidence");
    assert.equal(f.tables.trust_events[0].event_type, "event_positive_review", "the edit did not stack a negative on top");
  });

  it("a 1-star review from a second attendee is a negative event for the host; a 3 is neutral and writes nothing", async () => {
    await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 3 }, ATTENDEE);
    await settle();
    assert.equal(f.tables.trust_events.length, 0, "neutral rating → nothing");

    const r = await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 1 }, ATTENDEE2);
    assert.equal(r.status, 201);
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
    const e = f.tables.trust_events[0];
    assert.equal(e.user_id, HOST);
    assert.equal(e.event_type, "event_negative_review");
    assert.equal(e.delta, TRUST_EVENT_TYPES.EVENT_NEGATIVE_REVIEW.delta);
    assert.equal(e.status, "applied", "moderate → applied");
    assert.equal(e.metadata[COUNTERPARTY_METADATA_KEY], ATTENDEE2);
  });

  it("an ANONYMOUS review does not record the reviewer as counterparty (te_select_own would let the host read it)", async () => {
    await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 1, anonymous: true }, ATTENDEE);
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
    const e = f.tables.trust_events[0];
    assert.equal(e.user_id, HOST);
    assert.equal(e.metadata[COUNTERPARTY_METADATA_KEY], undefined, "anonymous reviewer id is NOT in the subject-readable row");
    assert.equal(e.metadata.reviewerAnonymous, true, "the blind spot is recorded, not hidden");
    assert.equal(JSON.stringify(e).includes(ATTENDEE), false, "the reviewer id appears nowhere on the row");
  });

  it("the host cannot review their own event (route) and the helper refuses a self-review too", async () => {
    const r = await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 5 }, HOST);
    assert.equal(r.status, 403);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
    const h = await recordEventReviewTrustEvent(f.client, { hostId: HOST, reviewerId: HOST, eventId: EVENT_ID, reviewId: "x", rating: 5, anonymous: false, isFirstSubmission: true });
    assert.equal(h.skipReason, "self_review");
    assert.equal((await recordEventReviewTrustEvent(f.client, { hostId: HOST, reviewerId: ATTENDEE, eventId: EVENT_ID, reviewId: "x", rating: 5, anonymous: false, isFirstSubmission: false })).skipReason, "review_edit");
    assert.equal((await recordEventReviewTrustEvent(f.client, { hostId: HOST, reviewerId: ATTENDEE, eventId: EVENT_ID, reviewId: "x", rating: 3, anonymous: false, isFirstSubmission: true })).skipReason, "neutral_rating");
    assert.deepEqual(EVENT_REVIEW_RATING_BANDS, { positiveMin: 4, negativeMax: 2 });
  });

  it("chain: review → applied event → maintenance pass → host profile with host_quality above neutral, evidence measured", async () => {
    await req("POST", `/api/events/${EVENT_ID}/reviews`, { rating: 5 }, ATTENDEE);
    await settle();
    assert.equal(await getTrustProfile(f.client, HOST), null, "no profile before the pass");
    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.eventsSeen, 1);
    assert.equal(pass.usersRecalculated, 1);
    const p = await getTrustProfile(f.client, HOST);
    assert.ok(p && p.categories.host_quality > 50);
    assert.equal(p!.evidenceCount, 1);
    const pass2 = await runTrustMaintenance(f.client);
    assert.equal(pass2.usersRecalculated, 0, "a second pass finds nobody dirty");
  });
});

// ── 3. content_removed ───────────────────────────────────────────────────────

describe("content_removed — POST /admin/reports/:id/hide-content and DELETE /admin/users/:id/{avatar,cover}", () => {
  let f: Fake;
  beforeEach(() => {
    f = makeFake({
      posts: [{ id: POST_ID, author_id: AUTHOR, post_status: "published" }],
      reports: [
        { id: REPORT_POST, reporter_id: REPORTER, target_type: "post", target_id: POST_ID, status: "open" },
        { id: REPORT_PLACE, reporter_id: REPORTER, target_type: "place", target_id: "60000000-0000-4000-8000-000000000001", status: "open" },
      ],
    });
    _setTestClient(f.client, true);
  });

  it("hiding a reported post charges the post AUTHOR via the adjudicated path: confirmed, capped, admin as reviewer only", async () => {
    const r = await req("POST", `/api/admin/reports/${REPORT_POST}/hide-content`, { reason: "Harassment" }, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.contentHidden, true);
    await settle();

    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.user_id, AUTHOR, "the content OWNER is the subject");
    assert.notEqual(e.user_id, ADMIN); assert.notEqual(e.user_id, REPORTER);
    assert.equal(e.event_type, "content_removed");
    assert.equal(e.severity, "serious");
    assert.equal(e.delta, TRUST_EVENT_TYPES.CONTENT_REMOVED.delta);
    assert.equal(e.source_type, "moderation");
    assert.equal(e.source_id, POST_ID, "keyed on the CONTENT id, not the per-click audit row");
    assert.equal(e.status, "confirmed", "serious → pending_review → confirmed in the same request (adjudicated)");
    assert.equal(e.reviewed_by, ADMIN, "the admin is the reviewer, never the subject");
    assert.equal(e.metadata.reportId, REPORT_POST);
    assert.ok(e.metadata.moderationActionId, "the audit row rides in metadata");

    const caps = f.tables.trust_caps.filter((c) => c.user_id === AUTHOR);
    assert.equal(caps.length, 1, "one content_quality ceiling");
    assert.equal(caps[0].category, "content_quality");
    assert.equal(caps[0].ceiling_score, 50);
    assert.equal(caps[0].source_event_id, e.id);
    assert.equal(f.tables.trust_reviews.filter((rv) => rv.source_event_id === e.id && rv.status === "open").length, 0, "the queue row was closed");
    assert.ok(f.tables.trust_admin_actions.some((a) => a.admin_id === ADMIN && a.target_user === AUTHOR && a.action_type === "confirm_event"));

    const p = await getTrustProfile(f.client, AUTHOR);
    assert.ok(p, "confirmEvent recalculated → a profile exists");
    assert.ok(p!.categories.content_quality < 50);
  });

  it("processed twice — hide-content double-clicked — ONE event, ONE cap, one profile, same score", async () => {
    await req("POST", `/api/admin/reports/${REPORT_POST}/hide-content`, { reason: "x" }, ADMIN);
    await settle();
    const first = (await getTrustProfile(f.client, AUTHOR))!.overall_score;
    const r2 = await req("POST", `/api/admin/reports/${REPORT_POST}/hide-content`, { reason: "x" }, ADMIN);
    assert.equal(r2.status, 200, "the route itself is not guarded against replay");
    await settle();
    assert.equal(f.tables.moderation_actions.length, 2, "the audit trail DID get a second row — which is why the audit id cannot be the key");
    assert.equal(f.tables.trust_events.length, 1);
    assert.equal(f.tables.trust_caps.length, 1);
    assert.equal(f.tables.trust_profiles.length, 1);
    assert.equal((await recalculateTrustScore(f.client, AUTHOR)).overall_score, first);
  });

  it("a target with no accountable owner (place) is audited as skipped and charges nobody", async () => {
    const r = await req("POST", `/api/admin/reports/${REPORT_PLACE}/hide-content`, { reason: "x" }, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.contentHidden, false);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });

  it("avatar removal charges the profile owner once, keyed on the audit row; the replay finds no media and writes nothing", async () => {
    const r = await req("DELETE", `/api/admin/users/${AUTHOR}/avatar`, { reason: "Explicit image" }, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.storage, "external_reference");
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
    const e = f.tables.trust_events[0];
    assert.equal(e.user_id, AUTHOR);
    assert.equal(e.event_type, "content_removed");
    assert.equal(e.status, "confirmed");
    assert.equal(e.source_id, f.tables.moderation_actions[0].id, "keyed on THIS removal's audit row");
    assert.equal(e.metadata.actionType, "avatar_removed");

    const r2 = await req("DELETE", `/api/admin/users/${AUTHOR}/avatar`, { reason: "again" }, ADMIN);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.storage, "no_media");
    await settle();
    assert.equal(f.tables.trust_events.length, 1, "removing nothing is not a finding");
    assert.equal(f.tables.trust_caps.length, 1);
  });

  it("cover removal with no cover set writes nothing (there was nothing to remove)", async () => {
    const r = await req("DELETE", `/api/admin/users/${AUTHOR}/cover`, {}, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.storage, "no_media");
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });
});

// ── 4. message_report_confirmed ──────────────────────────────────────────────

describe("message_report_confirmed — POST /admin/reports/:id/resolve with upheld: true on a message report", () => {
  let f: Fake;
  beforeEach(() => {
    f = makeFake({
      messages: [{ id: MSG_ID, sender_id: SENDER }],
      posts: [{ id: POST_ID, author_id: AUTHOR, post_status: "published" }],
      reports: [
        { id: REPORT_MSG, reporter_id: REPORTER, target_type: "message", target_id: MSG_ID, status: "open" },
        { id: REPORT_POST, reporter_id: REPORTER, target_type: "post", target_id: POST_ID, status: "open" },
      ],
    });
    _setTestClient(f.client, true);
  });

  it("an upheld message report charges the SENDER — confirmed, communication ceiling 45 — keyed on the message", async () => {
    const r = await req("POST", `/api/admin/reports/${REPORT_MSG}/resolve`, { action: "warned sender", upheld: true }, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.user_id, SENDER, "the message sender is the subject");
    assert.notEqual(e.user_id, REPORTER); assert.notEqual(e.user_id, ADMIN);
    assert.equal(e.event_type, "message_report_confirmed");
    assert.equal(e.delta, TRUST_EVENT_TYPES.MESSAGE_REPORT_CONFIRMED.delta);
    assert.equal(e.status, "confirmed");
    assert.equal(e.reviewed_by, ADMIN);
    assert.equal(e.source_type, "moderation");
    assert.equal(e.source_id, MSG_ID);
    assert.equal(e.metadata.reportId, REPORT_MSG);
    assert.equal(e.metadata.action, "warned sender");
    const cap = f.tables.trust_caps.find((c) => c.user_id === SENDER);
    assert.ok(cap); assert.equal(cap!.category, "communication"); assert.equal(cap!.ceiling_score, 45);
    assert.ok((await getTrustProfile(f.client, SENDER))!.categories.communication <= 45);
  });

  it("processed twice — the second resolve is refused by the report's status guard — ONE event", async () => {
    await req("POST", `/api/admin/reports/${REPORT_MSG}/resolve`, { action: "x", upheld: true }, ADMIN);
    await settle();
    const r2 = await req("POST", `/api/admin/reports/${REPORT_MSG}/resolve`, { action: "x", upheld: true }, ADMIN);
    assert.equal(r2.status, 404);
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
    assert.equal(f.tables.trust_caps.length, 1);
  });

  it("a second REPORT against the same message, upheld, confirms it once (keyed on the message, not the report)", async () => {
    f.tables.reports.push({ id: "50000000-0000-4000-8000-000000000009", reporter_id: ATTENDEE, target_type: "message", target_id: MSG_ID, status: "open" });
    await req("POST", `/api/admin/reports/${REPORT_MSG}/resolve`, { action: "x", upheld: true }, ADMIN);
    await settle();
    await req("POST", `/api/admin/reports/50000000-0000-4000-8000-000000000009/resolve`, { action: "x", upheld: true }, ADMIN);
    await settle();
    assert.equal(f.tables.reports.filter((r) => r.status === "resolved").length, 2, "both reports resolved");
    assert.equal(f.tables.trust_events.length, 1, "one message, one confirmation");
  });

  it("a resolve WITHOUT upheld is inert (free-text action is not an adjudication), and dismiss writes nothing", async () => {
    const r = await req("POST", `/api/admin/reports/${REPORT_MSG}/resolve`, { action: "no action needed" }, ADMIN);
    assert.equal(r.status, 200);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
    f.tables.reports.push({ id: "50000000-0000-4000-8000-000000000008", reporter_id: REPORTER, target_type: "message", target_id: MSG_ID, status: "open" });
    const d = await req("POST", `/api/admin/reports/50000000-0000-4000-8000-000000000008/dismiss`, { notes: "not actionable" }, ADMIN);
    assert.equal(d.status, 200);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });

  it("upheld on a NON-message report does not emit message_report_confirmed (a post's adjudication is content_removed's, not this)", async () => {
    await req("POST", `/api/admin/reports/${REPORT_POST}/resolve`, { action: "x", upheld: true }, ADMIN);
    await settle();
    assert.equal(f.tables.trust_events.length, 0);
  });
});

// ── 5. The database's last word: 23505 is a dedup, not a failure ─────────────

describe("migration 2540's unique index — a 23505 on insert is reported as a dedup skip", () => {
  it("recordTrustEvent returns skipped/dedup instead of throwing when the index refuses the second row", async () => {
    const f = makeFake();
    _setTestClient(f.client, true);
    const input = {
      userId: HOST, eventType: "event_host_cancelled", category: "host_quality" as const,
      delta: -8, severity: "moderate" as const, sourceType: "event", sourceId: EVENT_ID,
    };
    // Two concurrent deliveries both passed the read; the database refuses the second.
    f.failNext("trust_events", "insert", { code: "23505", message: "duplicate key value violates unique constraint \"trust_events_one_shot_uniq\"" });
    const r = await recordTrustEvent(f.client, input);
    assert.deepEqual(r, { ok: false, skipped: true, skipReason: "dedup" });
    assert.equal(f.tables.trust_events.length, 0);

    // Any OTHER insert error is still a failure the caller must see.
    f.failNext("trust_events", "insert", { code: "57014", message: "canceling statement" });
    await assert.rejects(() => recordTrustEvent(f.client, input), /recordTrustEvent DB error/);
  });
});

// ── 6. Cross-emitter: one adjudication reaching TWO routes charges once ──────
//
// Everything above proves PER-EMITTER idempotency: the same route replayed is a
// dedup skip. It does not prove that one ADJUDICATION reaching two DIFFERENT
// emitters charges once — and the admin report routes make that sequence
// legal: hide-content has no status guard and leaves the report `in_review`;
// resolve accepts any report that is not yet `resolved`. So one report on one
// post can be hidden AND then upheld, and one message report can be "hidden"
// (no mutation) and then upheld. The declared-but-unproduced
// `pulse_post_reported` sits exactly on that seam: wired at resolve without
// subsuming content_removed, one post removal would charge −10 AND −5. These
// are the assertions that fail if anyone does that.

describe("cross-emitter: one adjudication reaching two admin routes writes ONE trust event", () => {
  const REPORT_POST_2 = "50000000-0000-4000-8000-000000000011";
  let f: Fake;
  beforeEach(() => {
    f = makeFake({
      posts: [{ id: POST_ID, author_id: AUTHOR, post_status: "published" }],
      messages: [{ id: MSG_ID, sender_id: SENDER }],
      reports: [
        { id: REPORT_POST, reporter_id: REPORTER, target_type: "post", target_id: POST_ID, status: "open" },
        { id: REPORT_MSG, reporter_id: REPORTER, target_type: "message", target_id: MSG_ID, status: "open" },
      ],
    });
    _setTestClient(f.client, true);
  });

  it("post report: hide-content, then resolve {upheld:true} on the SAME report — content_removed once, nothing else", async () => {
    const h = await req("POST", `/api/admin/reports/${REPORT_POST}/hide-content`, { reason: "x" }, ADMIN);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    await settle();
    assert.equal(f.tables.reports.find((r) => r.id === REPORT_POST)!.status, "in_review", "hide-content leaves the report resolvable");
    const score1 = (await getTrustProfile(f.client, AUTHOR))!.overall_score;

    const r = await req("POST", `/api/admin/reports/${REPORT_POST}/resolve`, { action: "removed", upheld: true }, ADMIN);
    assert.equal(r.status, 200, "the second route ACCEPTS the same report — the sequence is legal, so the ledger must guard it");
    await settle();

    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1, `one adjudication, one event; got ${JSON.stringify(evs.map((e) => e.event_type))}`);
    assert.equal(evs[0].event_type, "content_removed");
    assert.equal(evs[0].user_id, AUTHOR);
    assert.equal(f.tables.trust_caps.length, 1);
    assert.equal(f.tables.moderation_actions.length, 2, "both routes audited — the audit trail is NOT the dedup key");
    assert.equal((await recalculateTrustScore(f.client, AUTHOR)).overall_score, score1, "the second route moved the score by nothing");
  });

  it("post report: resolve {upheld:true} first, then hide-content — still content_removed once", async () => {
    await req("POST", `/api/admin/reports/${REPORT_POST}/resolve`, { action: "warned", upheld: true }, ADMIN);
    await settle();
    assert.equal(f.tables.trust_events.length, 0, "an upheld post report alone charges nothing today (pulse_post_reported is unwired)");
    const h = await req("POST", `/api/admin/reports/${REPORT_POST}/hide-content`, { reason: "x" }, ADMIN);
    assert.equal(h.status, 200, "hide-content has no status guard");
    await settle();
    assert.equal(f.tables.trust_events.length, 1);
    assert.equal(f.tables.trust_events[0].event_type, "content_removed");
  });

  it("two REPORTS on one post, both hidden — one content item, one content_removed", async () => {
    f.tables.reports.push({ id: REPORT_POST_2, reporter_id: ATTENDEE, target_type: "post", target_id: POST_ID, status: "open" });
    await req("POST", `/api/admin/reports/${REPORT_POST}/hide-content`, { reason: "x" }, ADMIN);
    await settle();
    await req("POST", `/api/admin/reports/${REPORT_POST_2}/hide-content`, { reason: "y" }, ADMIN);
    await settle();
    assert.equal(f.tables.moderation_actions.length, 2, "two audit rows — two reports were actioned");
    assert.equal(f.tables.trust_events.length, 1, "keyed on the content id, not the report or the audit row");
    assert.equal(f.tables.trust_caps.length, 1);
  });

  it("message report: hide-content (no mutation for a message), then resolve {upheld:true} — message_report_confirmed once", async () => {
    const h = await req("POST", `/api/admin/reports/${REPORT_MSG}/hide-content`, { reason: "x" }, ADMIN);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal(h.body.contentHidden, false);
    await settle();
    assert.equal(f.tables.trust_events.length, 0, "removing nothing charges nothing");
    await req("POST", `/api/admin/reports/${REPORT_MSG}/resolve`, { action: "warned", upheld: true }, ADMIN);
    await settle();
    const evs = f.tables.trust_events;
    assert.equal(evs.length, 1);
    assert.equal(evs[0].event_type, "message_report_confirmed");
    assert.equal(evs[0].user_id, SENDER);
    assert.equal(evs[0].source_id, MSG_ID);
  });
});
