/**
 * census-trust (wave 5, 2026-10-18) — EVENT READS: a failed read is never
 * not-found, not-allowed or a default.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventFailedReads.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT. supabase-js RESOLVES on a database error. routes/events.ts held
 * 152 reads (checkUncheckedSupabaseReads, every tier) that bound `data` only,
 * and a handful more that bound the error and folded it into the empty answer
 * (canViewEvent's "unavailable" → false, isBlockedBetween's unread → "blocked",
 * isTripEventMember / isGoingAttendee `error || !data → false`,
 * checkEventEligibility's "temporarily unavailable" sent as 403 `forbidden`).
 * So a read that never answered became: 404 "Event not found" (publish,
 * postpone, complete, rsvp, …), 403 "only the host / not a member / you must
 * have a Going RSVP", an event silently missing from a list, `myRsvp: null`,
 * `isSaved: false`, `waitlist_count: 0` WRITTEN over the real count, an
 * average rating rewritten from nothing, a FIRST-event trust bonus for a
 * veteran host, and — at waitlist accept — a DELETED queue place (the join
 * gate's unread request read as "not approved", and the refusal removed them).
 *
 * THE RULE (appendix of routes/events.ts). Every read is one of three classes:
 *   (a) an authorization / existence gate → 503 `degraded_unavailable` (the
 *       EventAccessUnavailableError device, answered by the global handler);
 *       never 404 / 403 / allowed, and nothing written after it.
 *   (b) data the response states as fact → refused the same way; a list
 *       route's PRIMARY read answers as its sibling reads do (500 db_error).
 *   (c) best-effort side data → degrades, LOGS, never widens access, never
 *       claims success, never writes a value derived from the failed read.
 *
 * DOUBLE: schemaStrictSupabase (every column checked against the live schema),
 * wrapped here with a real `.or()` (helpers/postgrestOrFilter — the blocks and
 * friendship reads narrow entirely inside it), `.range()`, a statement log, and
 * READ faults: a fault answers one read statement `{ data: null, error }`,
 * resolved, exactly as supabase-js does; writes are never faulted. The real
 * events router and the real global error handler (lib/errorEnvelope.ts).
 *
 * Each case says whether it was RED or GREEN on the code before this change
 * (54abd5f2e).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import { logger } from "../lib/logger.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import eventsRouter, { checkEventEligibility } from "../routes/events.js";
import adminRouter from "../routes/admin.js";
import * as claimLib from "../lib/eventModerationClaim.js";
import { scanSource } from "../scripts/checkUncheckedSupabaseReads.js";
import { sanitize } from "../scripts/lib/supabaseCallScan.js";
import { makeSchemaStrictClient, type Seed, type Row } from "./helpers/schemaStrictSupabase.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";
import { projectionKeys, projectRow } from "./helpers/selectProjection.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));

// ── people, event, tokens ─────────────────────────────────────────────────────
const HOST   = "a1111111-1111-4111-8111-111111111101";
const COHOST = "a1111111-1111-4111-8111-111111111102";
const ATT    = "a1111111-1111-4111-8111-111111111103"; // a Going attendee
const VIEWER = "a1111111-1111-4111-8111-111111111104"; // the host's friend; no RSVP
const WL     = "a1111111-1111-4111-8111-111111111105"; // waitlisted, holds a live offer
const WL2    = "a1111111-1111-4111-8111-111111111106"; // waitlisted behind them
const OTHER  = "a1111111-1111-4111-8111-111111111107"; // a circle's owner
const ADMIN  = "a1111111-1111-4111-8111-1111111111ad";
const EV     = "b2222222-2222-4222-8222-222222222201";
const DRAFT  = "c3333333-3333-4333-8333-333333333301";
const JR     = "c3333333-3333-4333-8333-333333333302";
const INV    = "c3333333-3333-4333-8333-333333333303";
const REM    = "c3333333-3333-4333-8333-333333333304";
const TRIP   = "c3333333-3333-4333-8333-333333333305";
const COL    = "c3333333-3333-4333-8333-333333333306";
const LINK   = "c3333333-3333-4333-8333-333333333307";
const TOKENS: Record<string, string> = { host: HOST, cohost: COHOST, att: ATT, viewer: VIEWER, wl: WL, admin: ADMIN };
const FAIL = { message: "simulated read failure", code: "57014" };
const at = (n: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, n)).toISOString();
const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();

function world(): Seed {
  const person = (id: string, handle: string) => ({ id, handle, username: handle, name: handle, display_name: handle, role: "user", account_status: "active", created_at: at(0), expo_push_token: `ExponentPushToken[${handle}]`, verified: true, date_of_birth: "1990-01-01" });
  return {
    profiles: [person(HOST, "host"), person(COHOST, "cohost"), person(ATT, "att"), person(VIEWER, "viewer"), person(WL, "wl"), person(WL2, "wl2"), person(OTHER, "other"), { ...person(ADMIN, "admin"), role: "admin" }],
    admin_access_log: [], moderation_actions: [], reports: [], report_evidence: [], compass_settings: [],
    user_account_states: [], profile_privacy_settings: [], identity_verifications: [],
    blocks: [],
    user_friendships: [{ user_a: VIEWER, user_b: HOST, created_at: at(1) }],
    user_follows: [{ follower_id: VIEWER, following_id: HOST, created_at: at(1) }],
    compass_user_preferences: [],
    feature_flags: ["events_enabled", "events_waitlist_enabled", "events_chat_enabled", "push_notifications_enabled"].map((flag) => ({ flag, enabled: true })),
    events: [{
      id: EV, host_id: HOST, title: "Night market", description: null, state: "open", visibility: "public", city: "Tokyo", country: "JP",
      location_name: "Ameyoko", location_lat: 35.7, location_lng: 139.77, starts_at: FUTURE, ends_at: null, chat_enabled: true, chat_thread_id: null,
      waitlist_enabled: true, max_attendees: null, going_count: 7, waitlist_count: 2, avg_rating: 4.5, review_count: 3, rsvp_closed: false, verified_only: false,
      trust_score_min: null, age_min: null, age_max: null, circle_id: null, trip_id: null, attendee_comments_enabled: true, show_exact_location: true,
      price_type: null, price_url: null, ticket_url: null, featured: false, created_at: at(10), updated_at: at(10),
    }],
    event_roles: [{ event_id: EV, user_id: COHOST, role: "co_host", created_at: at(2) }],
    event_rsvps: [{ event_id: EV, user_id: ATT, status: "going", created_at: at(3), updated_at: at(3) }],
    event_waitlist: [
      { event_id: EV, user_id: WL, position: 1, offer_expires_at: FUTURE, created_at: at(4) },
      { event_id: EV, user_id: WL2, position: 2, offer_expires_at: null, created_at: at(5) },
    ],
    event_attendee_states: [{ event_id: EV, user_id: ATT, checked_in_at: at(6), confirmed_at: at(7), created_at: at(6), updated_at: at(7) }],
    event_join_requests: [{ id: JR, event_id: EV, user_id: VIEWER, status: "pending", message: null, created_at: at(8) }],
    event_invites: [{ id: INV, event_id: EV, inviter_id: HOST, invitee_id: VIEWER, status: "pending", created_at: at(8), updated_at: at(8) }],
    event_cohosts: [{ id: "c3333333-3333-4333-8333-333333333308", event_id: EV, user_id: COHOST, permissions: { manage_rsvps: true }, added_by: HOST, added_at: at(2) }],
    event_saves: [{ event_id: EV, user_id: VIEWER, saved_at: at(9) }],
    event_share_links: [{ id: LINK, event_id: EV, creator_id: HOST, token: "share-token-1234", use_count: 0, max_uses: null, expires_at: null, created_at: at(9) }],
    event_drafts: [{ id: DRAFT, host_id: HOST, data: { title: "Draft night" }, last_saved_at: at(9), created_at: at(9) }],
    event_reminders: [{ id: REM, event_id: EV, user_id: VIEWER, remind_at: FUTURE, note: null, sent: false, created_at: at(9) }],
    event_reviews: [], event_posts: [], event_media: [], event_updates: [], event_activity_log: [], event_reports: [], event_attendees: [], event_agenda_items: [],
    collections: [{ id: COL, owner_id: VIEWER, name: "Saved", is_default: true, created_at: at(1), updated_at: at(1) }],
    collection_items: [{ id: "c3333333-3333-4333-8333-333333333309", collection_id: COL, entity_type: "event", entity_id: EV, saved_at: at(9) }],
    circle_memberships: [],
    trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted", created_at: at(1) }],
    trips: [{ id: TRIP, owner_id: VIEWER, title: "Tokyo", destination_city: "Tokyo", start_date: null, end_date: null, created_at: at(1) }],
    trust_profiles: [], trust_events: [], notifications: [], passport_memories: [], message_threads: [], message_thread_members: [], messages: [], trip_plan_items: [],
  };
}
const ev = (s: Seed) => s.events!.find((e) => e.id === EV)!;

// ── the double ────────────────────────────────────────────────────────────────
type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: unknown };
/** Fail matching READ statements of `table` (all of them unless `when` narrows; `times` caps how many). */
interface Fault { table: string; when?: (calls: Call[]) => boolean; times?: number }
/** Replace one statement's answer (after its schema check); null = run it for real. */
type Override = (calls: Call[]) => Answer | null | undefined;

const selectOf = (calls: Call[]) => String(calls.find(([m]) => m === "select")?.[1]?.[0] ?? "");
const has = (calls: Call[], m: string, ...args: unknown[]) => calls.some(([n, a]) => n === m && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x)));
const isWriteCalls = (calls: Call[]) => calls.some(([m]) => m === "update" || m === "insert" || m === "upsert" || m === "delete");
const sel = (s: string) => (calls: Call[]) => selectOf(calls) === s;

function install(seed: Seed, o: { faults?: Fault[]; overrides?: Record<string, Override> } = {}) {
  const strict = makeSchemaStrictClient(seed);
  const statements: Array<{ table: string; calls: Call[]; faulted: boolean }> = [];
  const faults = (o.faults ?? []).map((f) => ({ ...f, left: f.times ?? Infinity }));
  const from = (table: string) => {
    const b = strict.from(table);
    const st = { table, calls: [] as Call[], faulted: false };
    statements.push(st);
    const calls = st.calls;
    for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order", "ilike", "like", "update", "upsert", "insert", "delete"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); return orig(...args); };
    }
    let orPred: ((r: Row) => boolean) | null = null;
    let lim: number | null = null;
    let rng: [number, number] | null = null;
    // `.or()` narrows on columns the select list may not carry (blocks: select blocker_id, or on blocked_id),
    // so the statement is re-selected whole (its columns were already checked) and projected after the filter.
    const origSelect = b.select;
    b.or = (expr: string) => { calls.push(["or", [expr]]); orPred = orPredicate(expr); origSelect("*"); return b; };
    b.range = (lo: number, hi: number) => { calls.push(["range", [lo, hi]]); rng = [lo, hi]; return b; };
    b.limit = (n: number) => { calls.push(["limit", [n]]); lim = n; return b; };
    const origThen = b.then;
    const runList = () => new Promise<Answer>((res, rej) => origThen(res, rej));
    const post = (a: Answer): Answer => {
      if (!Array.isArray(a?.data) || isWriteCalls(calls)) return a;
      let rows = a.data as Row[];
      if (orPred) { rows = rows.filter(orPred); const keys = projectionKeys(selectOf(calls)); if (keys) rows = rows.map((r) => projectRow(r, keys) as Row); }
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      return { ...a, data: rows };
    };
    const pgrst116 = (n: number) => ({ data: null, error: { code: "PGRST116", message: `JSON object requested, ${n} rows returned` } });
    const exec = async (kind: "list" | "maybe" | "single"): Promise<Answer> => {
      if (kind !== "list") calls.push([kind === "maybe" ? "maybeSingle" : "single", []]);
      if (!isWriteCalls(calls)) {
        const f = faults.find((x) => x.table === table && x.left > 0 && (!x.when || x.when(calls)));
        if (f) { f.left--; st.faulted = true; return { data: null, error: FAIL, count: null }; }
      }
      const ov = o.overrides?.[table]?.(calls);
      if (ov) return ov;
      const a = post(await runList());
      if (kind === "list" || a.error || a.data === null) return kind === "list" ? a : { data: a.data, error: a.error };
      const rows = a.data as Row[];
      if (kind === "maybe") return rows.length > 1 ? pgrst116(rows.length) : { data: rows[0] ?? null, error: null };
      return rows.length === 1 ? { data: rows[0], error: null } : pgrst116(rows.length);
    };
    b.then = (onF: any, onR: any) => exec("list").then(onF, onR);
    b.maybeSingle = () => exec("maybe");
    b.single = () => exec("single");
    return b;
  };
  const client = {
    from,
    rpc: () => Promise.resolve({ data: null, error: { message: "no rpc in this double" } }),
    auth: { getUser: async (token: string) => (TOKENS[token] ? { data: { user: { id: TOKENS[token] } }, error: null } : { data: { user: null }, error: { message: "bad token", status: 401 } }) },
  };
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { seed, strict, statements, faulted: () => statements.filter((s) => s.faulted).map((s) => s.table) };
}
type Rig = ReturnType<typeof install>;
const writesTo = (d: Rig, table: string) => d.strict.writes.filter((w) => w.table === table);

// ── the server, the logs, the pushes ──────────────────────────────────────────
let server: http.Server;
let base = "";
const logs: Array<{ level: string; msg: string }> = [];
const pushes: unknown[] = [];
const origLogger = { warn: logger.warn, error: logger.error };
before(async () => {
  (logger as any).warn = (o: unknown, m?: string) => { logs.push({ level: "warn", msg: String(m ?? o) }); };
  (logger as any).error = (o: unknown, m?: string) => { logs.push({ level: "error", msg: String(m ?? o) }); };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const cap = (level: string) => (o: unknown, m?: string) => { logs.push({ level, msg: String(m ?? o) }); };
    req.log = { error: cap("error"), warn: cap("warn"), info() {}, debug() {} };
    next();
  });
  app.use(adminRouter);
  app.use(eventsRouter);
  app.use(globalErrorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  (logger as any).warn = origLogger.warn;
  (logger as any).error = origLogger.error;
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => {
  _resetRateLimit();
  logs.length = 0;
  pushes.length = 0;
  _setTestFetch((async (_u: any, init: any) => { pushes.push(JSON.parse(String(init?.body ?? "null"))); return new Response(JSON.stringify({ data: (JSON.parse(String(init?.body ?? "[]")) as any[]).map(() => ({ status: "ok" })) }), { status: 200, headers: { "content-type": "application/json" } }); }) as any);
});
afterEach(() => _setTestFetch(null));

async function call(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
/** Fire-and-forget work the route started after answering. */
const settle = () => new Promise((r) => setTimeout(r, 60));
const logged = (re: RegExp, level?: string) => logs.some((l) => re.test(l.msg) && (!level || l.level === level));

/** (a)/(b): refused — 503 degraded_unavailable, retryable, naming the input that could not be read. */
function assertRefused(r: { status: number; body: any; raw: string }, input?: RegExp) {
  assert.equal(r.status, 503, r.raw);
  assert.equal(r.body?.error, "degraded_unavailable", r.raw);
  assert.equal(r.body?.retryable, true, r.raw);
  if (input) assert.match(String(r.body?.message), input, r.raw);
}
/** A list route's primary read: answered as its sibling reads are (500 db_error). */
function assertDbError(r: { status: number; body: any; raw: string }) {
  assert.equal(r.status, 500, r.raw);
  assert.equal(r.body?.error, "db_error", r.raw);
}

const evRead = (s: string) => ({ table: "events", when: sel(s) });
const rsvpOf = (userId: string) => ({ table: "event_rsvps", when: (c: Call[]) => has(c, "eq", "user_id", userId) && has(c, "eq", "event_id", EV) });

// ═════════════════════════════════════════════════════════════════════════════
describe("A. the feed, the city / nearby / search / circles / near-trip / following lists, and the personal lists", () => {
  it("RED before: GET /events — an unread friendship is 503, not a feed with the friends-only event silently missing", async () => {
    const s = world(); ev(s).visibility = "friends_only";
    install(world2(s));
    const control = await call("GET", "/events", "viewer");
    assert.equal(control.status, 200, control.raw);
    assert.deepEqual(control.body.events.map((e: any) => e.id), [EV], "control: a friend sees the friends-only event");
    install(world2(s), { faults: [{ table: "user_friendships" }] });
    assertRefused(await call("GET", "/events", "viewer"), /user_friendships/);
  });

  it("RED before: GET /events — an unread own RSVP is 503, not `myRsvp: null`", async () => {
    const s = world(); s.event_rsvps!.push({ event_id: EV, user_id: VIEWER, status: "going", created_at: at(3), updated_at: at(3) });
    install(s, { faults: [{ table: "event_rsvps", when: (c) => selectOf(c) === "event_id, status" }] });
    assertRefused(await call("GET", "/events", "viewer"), /event_rsvps/);
  });

  it("GREEN before (CONTROL): GET /events — a readable saved state is served (`isSaved: true` for the viewer's bookmark)", async () => {
    install(world());
    const r = await call("GET", "/events", "viewer");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.events[0].isSaved, true);
  });

  it("RED before: GET /events (c) — an unread collections list serves `isSaved: null` (unknown), never false; the feed is KEPT, and LOGGED", async () => {
    install(world(), { faults: [{ table: "collections" }] });
    const r = await call("GET", "/events", "viewer");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.events.map((e: any) => e.id), [EV], "the feed is kept");
    assert.strictEqual(r.body.events[0].isSaved, null, "unknown, not false");
    assert.ok(logged(/saved state unreadable — isSaved served as null/, "warn"), JSON.stringify(logs));
  });

  it("RED before: GET /events (c) — unread collection items likewise serve `isSaved: null`, never false", async () => {
    install(world(), { faults: [{ table: "collection_items" }] });
    const r = await call("GET", "/events", "viewer");
    assert.equal(r.status, 200, r.raw);
    assert.strictEqual(r.body.events[0].isSaved, null);
  });

  it("RED before: GET /events — verified-only gate: an unread profile is 503, not the event silently hidden", async () => {
    const s = world(); ev(s).verified_only = true;
    s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    install(s, { faults: [{ table: "profiles", when: sel("verified, date_of_birth") }] });
    assertRefused(await call("GET", "/events", "viewer"), /profiles/);
  });

  it("RED before: GET /events (c) — unread live going counts serve the STORED going_count (7), never 0, and say so", async () => {
    install(world(), { faults: [{ table: "event_rsvps", when: (c) => selectOf(c) === "event_id" && has(c, "eq", "status", "going") }] });
    const r = await call("GET", "/events", "viewer");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.events[0].goingCount, 7, "the stored counter, not a count of nothing");
    assert.ok(logged(/live going counts unreadable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: GET /events (c) — unread host profiles and follows degrade the card / ranking and are LOGGED", async () => {
    install(world(), { faults: [{ table: "profiles", when: sel("id, name, handle, avatar_url") }, { table: "user_follows" }] });
    const r = await call("GET", "/events", "viewer");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.events[0].hostName, null);
    assert.ok(logged(/host profiles unreadable/, "warn") && logged(/follows unreadable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: GET /events/city/:city — an unreadable blocks table is 503, not the event silently dropped", async () => {
    install(world(), { faults: [{ table: "blocks" }] });
    assertRefused(await call("GET", "/events/city/Tokyo", "viewer"), /blocks/);
  });

  it("RED before: GET /events/city/:city — an unread staff role (eligibility) is 503, not a co-host judged by the viewer gates", async () => {
    install(world(), { faults: [{ table: "event_roles", when: (c) => has(c, "in", "role", ["co_host", "moderator"]) }] });
    assertRefused(await call("GET", "/events/city/Tokyo", "cohost"), /eligibility/);
  });

  it("RED before: GET /events/city/:city — an unread friendship is 503, not the friends-only event silently dropped", async () => {
    const s = world(); ev(s).visibility = "friends_only";
    install(world2(s));
    const control = await call("GET", "/events/city/Tokyo", "viewer");
    assert.deepEqual(control.body.events.map((e: any) => e.id), [EV], "control: a friend sees it");
    install(world2(s), { faults: [{ table: "user_friendships" }] });
    assertRefused(await call("GET", "/events/city/Tokyo", "viewer"), /user_friendships/);
  });

  it("RED before: GET /events/nearby — an unread friendship is 503, not the friends-only event silently dropped", async () => {
    const s = world(); ev(s).visibility = "friends_only";
    install(s, { faults: [{ table: "user_friendships" }] });
    assertRefused(await call("GET", "/events/nearby?lat=35.7&lng=139.77", "viewer"), /user_friendships/);
  });

  it("RED before: GET /events/search — an unread events table is 500 db_error, not \"no events match\"", async () => {
    install(world(), { faults: [{ table: "events" }] });
    assertDbError(await call("GET", "/events/search?q=Night", "viewer"));
  });

  it("GREEN before (CONTROL): GET /events/search finds the event when everything reads", async () => {
    install(world());
    const r = await call("GET", "/events/search?q=Night", "viewer");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.events.map((e: any) => e.id), [EV]);
  });

  it("RED before: GET /events/circles — an unread membership is 503, not the viewer's own circle only", async () => {
    install(world(), { faults: [{ table: "circle_memberships" }] });
    assertRefused(await call("GET", "/events/circles", "viewer"), /circle_memberships/);
  });

  it("RED before: GET /events/near-trip/:tripId — an unread trip membership is 503, not 403 \"must be a trip member\"", async () => {
    install(world(), { faults: [{ table: "trip_members" }] });
    assertRefused(await call("GET", `/events/near-trip/${TRIP}`, "viewer"), /trip_members/);
  });

  it("RED before: GET /events/following — an unread follows list is 500 db_error, not `events: []`", async () => {
    install(world(), { faults: [{ table: "user_follows" }] });
    assertDbError(await call("GET", "/events/following", "viewer"));
  });

  it("RED before: GET /events/following — an unreadable view-access input is 503, not the event silently skipped", async () => {
    const s = world(); ev(s).visibility = "friends_only";
    install(s, { faults: [{ table: "user_friendships" }] });
    assertRefused(await call("GET", "/events/following", "viewer"), /view access/);
  });

  it("RED before: GET /events/me — an unread hosted list is 500 db_error, not \"no events\"", async () => {
    install(world(), { faults: [{ table: "events" }] });
    assertDbError(await call("GET", "/events/me", "host"));
  });

  it("RED before: GET /events/joined — an unread RSVP list is 500 db_error, not \"no events\"", async () => {
    install(world(), { faults: [{ table: "event_rsvps" }] });
    assertDbError(await call("GET", "/events/joined", "att"));
  });

  it("RED before: GET /events/saved — an unread saves list is 500 db_error, not \"nothing saved\"", async () => {
    install(world(), { faults: [{ table: "event_saves" }] });
    assertDbError(await call("GET", "/events/saved", "viewer"));
  });

  it("RED before: GET /events/invites — an unread events table is 500 db_error, not `event: null` on the invite", async () => {
    install(world(), { faults: [{ table: "events" }] });
    assertDbError(await call("GET", "/events/invites", "viewer"));
  });

  it("RED before: GET /events/requests — an unread events table is 500 db_error, not `event: null` on the request", async () => {
    install(world(), { faults: [{ table: "events" }] });
    assertDbError(await call("GET", "/events/requests", "viewer"));
  });
});

/** A fresh copy of a seed (each install mutates its seed). */
function world2(s: Seed): Seed { return JSON.parse(JSON.stringify(s)); }

// ═════════════════════════════════════════════════════════════════════════════
describe("B. drafts and the share-link preview", () => {
  it("RED before: PATCH /events/drafts/:id — an unread draft is 503, not 404; nothing written", async () => {
    const d = install(world(), { faults: [{ table: "event_drafts" }] });
    assertRefused(await call("PATCH", `/events/drafts/${DRAFT}`, "host", { title: "x" }), /event_drafts/);
    assert.equal(writesTo(d, "event_drafts").length, 0);
  });

  it("RED before: DELETE /events/drafts/:id — an unread draft is 503, not 404; the draft is still there", async () => {
    const d = install(world(), { faults: [{ table: "event_drafts" }] });
    assertRefused(await call("DELETE", `/events/drafts/${DRAFT}`, "host"), /event_drafts/);
    assert.equal(d.seed.event_drafts!.length, 1);
  });

  it("RED before: POST /events/drafts/:id/publish — an unread draft is 503, not 404; no event created", async () => {
    const d = install(world(), { faults: [{ table: "event_drafts" }] });
    assertRefused(await call("POST", `/events/drafts/${DRAFT}/publish`, "host", {}), /event_drafts/);
    assert.equal(writesTo(d, "events").length, 0);
  });

  it("RED before: GET /events/share-link/:token/preview — an unread link is 503, not 404", async () => {
    install(world(), { faults: [{ table: "event_share_links" }] });
    assertRefused(await call("GET", "/events/share-link/share-token-1234/preview", "viewer"), /event_share_links/);
  });

  it("RED before: share-link preview — an unread event is 503, not 404; the link's use is not counted", async () => {
    const d = install(world(), { faults: [{ table: "events" }] });
    assertRefused(await call("GET", "/events/share-link/share-token-1234/preview", "viewer"), /events/);
    assert.equal(d.seed.event_share_links![0].use_count, 0);
  });

  it("RED before: share-link preview — an unreadable blocks table is 503, not 404", async () => {
    install(world(), { faults: [{ table: "blocks" }] });
    assertRefused(await call("GET", "/events/share-link/share-token-1234/preview", "viewer"), /blocks/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("C. GET /events/:id", () => {
  it("GREEN before (CONTROL): the detail answers with live counts when everything reads", async () => {
    install(world());
    const r = await call("GET", `/events/${EV}`, "att");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.counts.going, 1);
    assert.equal(r.body.myRsvp, "going");
    assert.equal(r.body.waitlistCount, 2);
  });

  it("GREEN before (CONTROL): a missing event is still 404, not 503", async () => {
    install(world());
    const r = await call("GET", "/events/b2222222-2222-4222-8222-2222222222ff", "viewer");
    assert.equal(r.status, 404, r.raw);
  });

  it("RED before: an unread event row is 503, not 404", async () => {
    install(world(), { faults: [evRead("*")] });
    assertRefused(await call("GET", `/events/${EV}`, "viewer"), /events/);
  });

  it("RED before: an unreadable blocks table is 503, not 404", async () => {
    install(world(), { faults: [{ table: "blocks" }] });
    assertRefused(await call("GET", `/events/${EV}`, "viewer"), /blocks/);
  });

  it("RED before: a friends-only event whose friendship cannot be read is 503, not the locked sentinel", async () => {
    const s = world(); ev(s).visibility = "friends_only";
    install(s, { faults: [{ table: "user_friendships" }] });
    assertRefused(await call("GET", `/events/${EV}`, "viewer"), /view access/);
  });

  it("RED before: an unread ban role (eligibility) is 503, not 404", async () => {
    install(world(), { faults: [{ table: "event_roles", when: (c) => has(c, "eq", "role", "banned") }] });
    assertRefused(await call("GET", `/events/${EV}`, "viewer"), /eligibility/);
  });

  it("RED before: the attendee's own unread RSVP is 503, not `myRsvp: null` and a hidden attendee list", async () => {
    install(world(), { faults: [{ table: "event_rsvps", when: (c) => selectOf(c) === "status" && has(c, "eq", "user_id", ATT) }] });
    assertRefused(await call("GET", `/events/${EV}`, "att"), /event_rsvps/);
  });

  it("RED before: an unread waitlist is 503, not `waitlistCount: 0`", async () => {
    install(world(), { faults: [{ table: "event_waitlist", when: (c) => selectOf(c) === "user_id" }] });
    assertRefused(await call("GET", `/events/${EV}`, "att"), /event_waitlist/);
  });

  it("RED before: (c) an unread host profile serves the detail without the host card, LOGGED", async () => {
    install(world(), { faults: [{ table: "profiles", when: (c) => selectOf(c) === "id, handle, name, avatar_url" && has(c, "eq", "id", HOST) }] });
    const r = await call("GET", `/events/${EV}`, "att");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.host, null);
    assert.ok(logged(/host profile unreadable/, "warn"), JSON.stringify(logs));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("D. RSVP, join, leave, waitlist", () => {
  it("RED before: POST /events/:id/rsvp — an unread event is 503, not 404; no RSVP written", async () => {
    const d = install(world(), { faults: [evRead("*")] });
    assertRefused(await call("POST", `/events/${EV}/rsvp`, "viewer", { status: "going" }), /events/);
    assert.equal(writesTo(d, "event_rsvps").length, 0);
  });

  it("RED before: rsvp on an invite-only event — an unread join request is 503, not 403 \"requires host approval\"", async () => {
    const s = world(); ev(s).visibility = "invite_only";
    const d = install(s, { faults: [{ table: "event_join_requests" }] });
    assertRefused(await call("POST", `/events/${EV}/rsvp`, "viewer", { status: "going" }), /event_join_requests/);
    assert.equal(writesTo(d, "event_rsvps").length, 0);
  });

  it("RED before: rsvp on a circle event — an unread circle membership is 503, not 403 \"only open to circle members\"", async () => {
    const s = world(); ev(s).visibility = "circle"; ev(s).circle_id = OTHER;
    install(s, { faults: [{ table: "circle_memberships" }] });
    assertRefused(await call("POST", `/events/${EV}/rsvp`, "viewer", { status: "going" }), /circle_memberships/);
  });

  it("RED before: DELETE /events/:id/rsvp — an unread RSVP is 503, not 404 \"No RSVP found\"; the RSVP stays", async () => {
    const d = install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("DELETE", `/events/${EV}/rsvp`, "att"), /event_rsvps/);
    assert.equal(d.seed.event_rsvps!.filter((r) => r.user_id === ATT).length, 1);
  });

  it("GREEN before (CONTROL): DELETE /events/:id/rsvp with no RSVP is still 404", async () => {
    install(world());
    const r = await call("DELETE", `/events/${EV}/rsvp`, "viewer");
    assert.equal(r.status, 404, r.raw);
  });

  it("RED before: (c) the capacity sync's unread event writes no state and is LOGGED (it returned in silence)", async () => {
    const d = install(world(), { faults: [evRead("state, max_attendees, waitlist_enabled")] });
    const r = await call("DELETE", `/events/${EV}/rsvp`, "att");
    assert.equal(r.status, 200, r.raw);
    assert.ok(!writesTo(d, "events").some((w) => "state" in (w.rows[0] ?? {})), "no state written");
    assert.ok(logged(/event capacity sync: event unreadable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: (c) a promoted waitlister's unread push token: the offer stands, the push is skipped and LOGGED", async () => {
    const s = world(); s.event_waitlist = [{ event_id: EV, user_id: WL2, position: 1, offer_expires_at: null, created_at: at(5) }];
    const d = install(s, { faults: [{ table: "profiles", when: sel("expo_push_token") }] });
    const r = await call("DELETE", `/events/${EV}/rsvp`, "att");
    assert.equal(r.status, 200, r.raw);
    assert.ok(d.seed.event_waitlist![0].offer_expires_at, "the offer was written");
    assert.ok(logged(/push token unreadable — the offer stands/, "warn"), JSON.stringify(logs));
  });

  it("RED before: POST /events/:id/join — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("*")] });
    assertRefused(await call("POST", `/events/${EV}/join`, "viewer"), /events/);
  });

  it("RED before: join a trip event — an unread trip membership is 503, not 403 \"only open to trip members\"", async () => {
    const s = world(); ev(s).visibility = "trip"; ev(s).trip_id = TRIP;
    install(s, { faults: [{ table: "trip_members" }] });
    assertRefused(await call("POST", `/events/${EV}/join`, "viewer"), /trip_members/);
  });

  it("RED before: POST /events/:id/leave — an unread RSVP is 503, not 404; nothing deleted", async () => {
    const d = install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/leave`, "att"), /event_rsvps/);
    assert.equal(d.seed.event_rsvps!.length, 1);
  });

  it("RED before: POST /events/:id/waitlist — an unread event is 503, not 404", async () => {
    install(world(), { faults: [{ table: "events", when: (c) => selectOf(c).startsWith("state, waitlist_enabled") }] });
    assertRefused(await call("POST", `/events/${EV}/waitlist`, "viewer"), /events/);
  });

  it("RED before: waitlist join — an unreadable blocks table is 503, not 403 \"Cannot join waitlist\"", async () => {
    const s = world(); ev(s).state = "full";
    const d = install(s, { faults: [{ table: "blocks" }] });
    assertRefused(await call("POST", `/events/${EV}/waitlist`, "viewer"), /blocks/);
    assert.equal(writesTo(d, "event_waitlist").length, 0);
  });

  it("RED before: waitlist join — an unread verified flag is 503, not 403 \"for verified users only\"", async () => {
    const s = world(); ev(s).state = "full"; ev(s).verified_only = true;
    s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    install(s, { faults: [{ table: "profiles", when: sel("verified") }] });
    assertRefused(await call("POST", `/events/${EV}/waitlist`, "viewer"), /profiles/);
  });

  it("RED before: waitlist join — an unreadable trust profile is 503, not 403 `forbidden` \"temporarily unavailable\"", async () => {
    const s = world(); ev(s).state = "full"; ev(s).trust_score_min = 40;
    s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    install(s, { faults: [{ table: "trust_profiles" }] });
    const r = await call("POST", `/events/${EV}/waitlist`, "viewer");
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("RED before: waitlist join — an unreadable age is 503, not 403 `forbidden` with the age-check-unavailable message", async () => {
    const s = world(); ev(s).state = "full"; ev(s).age_min = 21;
    s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    const d = install(s, { faults: [{ table: "profiles", when: sel("date_of_birth") }] });
    const r = await call("POST", `/events/${EV}/waitlist`, "viewer");
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(writesTo(d, "event_waitlist").length, 0);
  });

  it("RED before: waitlist accept on an invite-only event — an unread join request is 503 and the queue place is KEPT (it was deleted, and the next person promoted)", async () => {
    const s = world(); ev(s).visibility = "invite_only";
    const d = install(s, { faults: [{ table: "event_join_requests" }] });
    assertRefused(await call("POST", `/events/${EV}/waitlist/accept`, "wl"), /event_join_requests/);
    assert.ok(d.seed.event_waitlist!.some((w) => w.user_id === WL), "WL's place is still in the queue");
    assert.equal(d.seed.event_waitlist!.find((w) => w.user_id === WL2)!.offer_expires_at, null, "nobody else was offered their seat");
  });

  it("RED before: waitlist accept — an unread queue entry is 503, not 404 \"Not on waitlist\"", async () => {
    install(world(), { faults: [{ table: "event_waitlist", when: sel("position, offer_expires_at") }] });
    assertRefused(await call("POST", `/events/${EV}/waitlist/accept`, "wl"), /event_waitlist/);
  });

  it("RED before: waitlist accept — the post-accept recount that cannot read leaves waitlist_count alone (it wrote 0)", async () => {
    const d = install(world(), { faults: [{ table: "event_waitlist", when: (c) => selectOf(c) === "user_id" && !c.some(([m]) => m === "gt" || m === "is" || m === "order") }] });
    const r = await call("POST", `/events/${EV}/waitlist/accept`, "wl");
    assert.equal(r.status, 200, r.raw);
    const counted = writesTo(d, "events").filter((w) => "waitlist_count" in (w.rows[0] ?? {}));
    assert.ok(counted.every((w) => w.rows[0].waitlist_count === undefined), `waitlist_count written from nothing: ${JSON.stringify(counted)}`);
    assert.ok(logged(/queue recount unreadable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: DELETE /events/:id/waitlist — an unread recount writes no waitlist_count (it wrote 0)", async () => {
    const d = install(world(), { faults: [{ table: "event_waitlist", when: (c) => selectOf(c) === "user_id" && !isWriteCalls(c) }] });
    const r2 = await call("DELETE", `/events/${EV}/waitlist`, "wl");
    assert.equal(r2.status, 200, r2.raw);
    assert.equal(writesTo(d, "events").length, 0, JSON.stringify(writesTo(d, "events")));
    assert.ok(logged(/waitlist leave: recount unreadable/, "warn"), JSON.stringify(logs));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("E. join requests, roles, invites, co-hosts", () => {
  it("RED before: POST /events/:id/requests — an unread event is 503, not 404; no request written", async () => {
    const d = install(world(), { faults: [{ table: "events", when: sel("visibility, state, host_id, title") }] });
    assertRefused(await call("POST", `/events/${EV}/requests`, "viewer", {}), /events/);
    assert.equal(writesTo(d, "event_join_requests").length, 0);
  });

  it("RED before: GET /events/:id/requests — an unread request list is 500 db_error, not \"no requests\"", async () => {
    install(world(), { faults: [{ table: "event_join_requests" }] });
    assertDbError(await call("GET", `/events/${EV}/requests`, "host"));
  });

  it("RED before: PATCH /events/:id/requests/:userId approve — an unread event is 503, not 404; nothing approved", async () => {
    const d = install(world(), { faults: [evRead("*")] });
    assertRefused(await call("PATCH", `/events/${EV}/requests/${VIEWER}`, "host", { action: "approve" }), /events/);
    assert.equal(writesTo(d, "event_join_requests").length, 0);
  });

  it("RED before: POST /events/:id/join-request — an unread event is 503, not 404", async () => {
    install(world(), { faults: [{ table: "events", when: sel("visibility, state, host_id, title") }] });
    assertRefused(await call("POST", `/events/${EV}/join-request`, "viewer", {}), /events/);
  });

  it("RED before: join-requests/:id/approve — an unread request is 503, not 404", async () => {
    install(world(), { faults: [{ table: "event_join_requests" }] });
    assertRefused(await call("POST", `/events/${EV}/join-requests/${JR}/approve`, "host"), /event_join_requests/);
  });

  it("RED before: join-requests/:id/approve — the target's unread ban role is 503, not 403 \"Cannot approve\"", async () => {
    const d = install(world(), { faults: [{ table: "event_roles", when: (c) => has(c, "eq", "role", "banned") }] });
    assertRefused(await call("POST", `/events/${EV}/join-requests/${JR}/approve`, "host"));
    assert.equal(writesTo(d, "event_rsvps").length, 0);
  });

  it("RED before: join-requests/:id/decline — an unread request is 503, not 404", async () => {
    install(world(), { faults: [{ table: "event_join_requests" }] });
    assertRefused(await call("POST", `/events/${EV}/join-requests/${JR}/decline`, "host"), /event_join_requests/);
  });

  it("RED before: join-requests/:id/cancel — an unread request is 503, not 404; nothing deleted", async () => {
    const d = install(world(), { faults: [{ table: "event_join_requests" }] });
    assertRefused(await call("POST", `/events/${EV}/join-requests/${JR}/cancel`, "viewer"), /event_join_requests/);
    assert.equal(d.seed.event_join_requests!.length, 1);
  });

  it("RED before: POST /events/:id/roles ban — an unread event chat is 503 \"recorded, but not removed from the chat\", not ok", async () => {
    const s = world(); ev(s).chat_thread_id = "d4444444-4444-4444-8444-444444444401";
    const d = install(s, { faults: [evRead("chat_thread_id")] });
    const r = await call("POST", `/events/${EV}/roles`, "host", { userId: ATT, role: "banned" });
    assertRefused(r);
    assert.match(r.body.message, /ban was recorded/);
    assert.ok(d.seed.event_roles!.some((x) => x.user_id === ATT && x.role === "banned"), "the ban itself stands");
  });

  it("RED before: roles ban — an unread queue recount leaves waitlist_count alone (it wrote 0)", async () => {
    const d = install(world(), { faults: [{ table: "event_waitlist", when: (c) => selectOf(c) === "user_id" && !c.some(([m]) => m === "gt" || m === "is" || m === "order") && !isWriteCalls(c) }] });
    const r = await call("POST", `/events/${EV}/roles`, "host", { userId: WL2, role: "banned" });
    assert.equal(r.status, 200, r.raw);
    const counted = writesTo(d, "events").filter((w) => "waitlist_count" in (w.rows[0] ?? {}));
    assert.ok(counted.length > 0 && counted.every((w) => w.rows[0].waitlist_count === undefined), JSON.stringify(counted));
  });

  it("RED before: POST /events/:id/invite — an unreadable blocks table is 503, not 403 \"Cannot invite\"; no invite written", async () => {
    const d = install(world(), { faults: [{ table: "blocks" }] });
    assertRefused(await call("POST", `/events/${EV}/invite`, "host", { userId: WL2 }), /blocks/);
    assert.equal(writesTo(d, "event_invites").length, 0);
  });

  it("RED before: invites/:id/accept — an unread invite is 503, not 404", async () => {
    install(world(), { faults: [{ table: "event_invites" }] });
    assertRefused(await call("POST", `/events/${EV}/invites/${INV}/accept`, "viewer"), /event_invites/);
  });

  it("RED before: invites/:id/accept — an unread trust profile is 503, not 403 \"Cannot accept invite\"; the invite stays pending", async () => {
    const s = world(); ev(s).trust_score_min = 40;
    s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    const d = install(s, { faults: [{ table: "trust_profiles" }] });
    const r = await call("POST", `/events/${EV}/invites/${INV}/accept`, "viewer");
    assert.equal(r.status, 503, r.raw);
    assert.equal(d.seed.event_invites![0].status, "pending");
  });

  it("RED before: invites/:id/decline — an unread invite is 503, not 404", async () => {
    install(world(), { faults: [{ table: "event_invites" }] });
    assertRefused(await call("POST", `/events/${EV}/invites/${INV}/decline`, "viewer"), /event_invites/);
  });

  it("RED before: GET /events/:id/cohosts — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("host_id, state")] });
    assertRefused(await call("GET", `/events/${EV}/cohosts`, "host"), /events/);
  });

  it("RED before: POST /events/:id/cohosts — an unreadable blocks table is 503, not 403 blocked_user; nothing written", async () => {
    const d = install(world(), { faults: [{ table: "blocks" }] });
    assertRefused(await call("POST", `/events/${EV}/cohosts`, "host", { userId: VIEWER }), /blocks/);
    assert.equal(writesTo(d, "event_cohosts").length, 0);
  });

  it("RED before: PATCH cohost permissions — an unread co-host row is 503, not 404; nothing merged", async () => {
    const d = install(world(), { faults: [{ table: "event_cohosts" }] });
    assertRefused(await call("PATCH", `/events/${EV}/cohosts/${COHOST}/permissions`, "host", { manage_chat: false }), /event_cohosts/);
    assert.equal(writesTo(d, "event_cohosts").length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("F. attendance, chat, memory, reviews, lifecycle", () => {
  it("RED before: POST /events/:id/checkin — an unread RSVP is 503, not 403 \"must have a Going RSVP\"", async () => {
    install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/checkin`, "att"), /event_rsvps/);
  });

  it("RED before: POST /events/:id/attendance/:userId — an unread event state is 503, not 403", async () => {
    install(world(), { faults: [evRead("state")] });
    assertRefused(await call("POST", `/events/${EV}/attendance/${ATT}`, "host"), /events/);
  });

  it("RED before: POST /events/:id/noshow/:userId — the target's unread RSVP is 503, not 403", async () => {
    const s = world(); ev(s).state = "started";
    install(s, { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/noshow/${ATT}`, "host"), /event_rsvps/);
  });

  it("RED before: GET /events/:id/attendees — unread attendance states are 503, not \"not checked in\"", async () => {
    install(world(), { faults: [{ table: "event_attendee_states" }] });
    assertRefused(await call("GET", `/events/${EV}/attendees`, "host"), /event_attendee_states/);
  });

  it("RED before: POST /events/:id/memory — a Going attendee's unread RSVP is 503, not 403", async () => {
    const s = world(); ev(s).state = "completed";
    install(s, { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/memory`, "att"), /event_rsvps/);
  });

  it("RED before: POST /events/:id/memory — an unread event is 503, not 404; no memory written", async () => {
    const d = install(world(), { faults: [evRead("*")] });
    assertRefused(await call("POST", `/events/${EV}/memory`, "host"), /events/);
    assert.equal(writesTo(d, "passport_memories").length, 0);
  });

  it("RED before: POST /events/:id/chat — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("chat_thread_id, chat_enabled, title, host_id, state")] });
    assertRefused(await call("POST", `/events/${EV}/chat`, "host"), /events/);
  });

  it("RED before: POST /events/:id/chat/join — an unread RSVP is 503, not 403", async () => {
    install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/chat/join`, "att"), /event_rsvps/);
  });

  it("RED before: chat/join — a lost claim whose winning thread cannot be read is 503, not 404 \"Event chat not found\"", async () => {
    const s = world(); ev(s).chat_thread_id = "d4444444-4444-4444-8444-444444444401"; // the winner's thread, already claimed
    let threadReads = 0;
    install(s, {
      overrides: {
        events: (c) => {
          if (selectOf(c) === "chat_thread_id, chat_enabled, state, title") return { data: { chat_thread_id: null, chat_enabled: true, state: "open", title: "Night market" }, error: null };
          if (selectOf(c) === "chat_thread_id" && !isWriteCalls(c)) return ++threadReads === 1 ? { data: { chat_thread_id: null }, error: null } : { data: null, error: FAIL };
          return null;
        },
      },
    });
    assertRefused(await call("POST", `/events/${EV}/chat/join`, "att"), /events/);
    assert.ok(logged(/winning thread could not be read/, "error"), JSON.stringify(logs));
  });

  it("RED before: (c) a pinned update's unread event title is pushed as \"Event\" and LOGGED", async () => {
    install(world(), { faults: [evRead("title")] });
    const r = await call("POST", `/events/${EV}/updates`, "host", { body: "Gates open at 6", pinned: true });
    assert.equal(r.status, 201, r.raw);
    await settle();
    assert.ok(logged(/event-update push: title unreadable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: POST /events/:id/reviews — the attendee's unread confirmation is 503, not 403 \"Only confirmed attendees\"", async () => {
    const s = world(); ev(s).state = "completed";
    install(s, { faults: [{ table: "event_attendee_states" }] });
    assertRefused(await call("POST", `/events/${EV}/reviews`, "att", { rating: 5 }), /event_attendee_states/);
  });

  it("RED before: reviews — an unread ratings list does not rewrite avg_rating / review_count (it wrote the one rating and 0)", async () => {
    const s = world(); ev(s).state = "completed";
    const d = install(s, { faults: [{ table: "event_reviews", when: sel("rating") }] });
    const r = await call("POST", `/events/${EV}/reviews`, "att", { rating: 1 });
    assert.equal(r.status, 201, r.raw);
    assert.equal(writesTo(d, "events").filter((w) => "avg_rating" in (w.rows[0] ?? {})).length, 0);
    assert.equal(ev(d.seed).avg_rating, 4.5);
    assert.ok(logged(/ratings unreadable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: GET /events/:id/reviews — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("*")] });
    assertRefused(await call("GET", `/events/${EV}/reviews`, "viewer"), /events/);
  });

  it("RED before: GET /events/:id/reviews — an unreadable view-access input is 503, not 404", async () => {
    const s = world(); ev(s).visibility = "friends_only";
    install(s, { faults: [{ table: "user_friendships" }] });
    assertRefused(await call("GET", `/events/${EV}/reviews`, "viewer"), /view access/);
  });

  it("RED before: POST /events/:id/publish — an unread event is 503, not 404; nothing published", async () => {
    const s = world(); ev(s).state = "draft";
    const d = install(s, { faults: [evRead("*")] });
    assertRefused(await call("POST", `/events/${EV}/publish`, "host"), /events/);
    assert.equal(ev(d.seed).state, "draft");
  });

  it("RED before: publish — an unread \"prior event\" awards NO first-event trust bonus (it awarded one to a veteran host)", async () => {
    const s = world(); ev(s).state = "draft";
    const d = install(s, { faults: [{ table: "events", when: (c) => selectOf(c) === "id" && has(c, "eq", "state", "open") }] });
    const r = await call("POST", `/events/${EV}/publish`, "host");
    assert.equal(r.status, 200, r.raw);
    await settle();
    assert.equal(writesTo(d, "trust_events").filter((w) => w.rows[0]?.event_type === "first_event_hosted").length, 0);
    assert.ok(logged(/first_event_hosted: prior-event check unavailable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: POST /events/:id/postpone — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("title, state")] });
    assertRefused(await call("POST", `/events/${EV}/postpone`, "host", {}), /events/);
  });

  it("RED before: POST /events/:id/complete — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("state, title, host_id")] });
    assertRefused(await call("POST", `/events/${EV}/complete`, "host"), /events/);
  });

  it("RED before: (c) complete — unread check-ins skip the attendee awards and are LOGGED (they were skipped in silence)", async () => {
    const s = world(); ev(s).state = "started";
    install(s, { faults: [{ table: "event_attendee_states" }] });
    const r = await call("POST", `/events/${EV}/complete`, "host");
    assert.equal(r.status, 200, r.raw);
    await settle();
    assert.ok(logged(/complete: check-ins unreadable/, "warn"), JSON.stringify(logs));
  });

  it("RED before: POST /events/:id/close-rsvps — an unread event is 503, not 404; nothing written", async () => {
    const d = install(world(), { faults: [evRead("id")] });
    assertRefused(await call("POST", `/events/${EV}/close-rsvps`, "host"), /events/);
    assert.equal(writesTo(d, "events").length, 0);
  });

  it("RED before: POST /events/:id/reopen-rsvps — an unread event is 503, not 404; nothing written", async () => {
    const d = install(world(), { faults: [evRead("id")] });
    assertRefused(await call("POST", `/events/${EV}/reopen-rsvps`, "host"), /events/);
    assert.equal(writesTo(d, "events").length, 0);
  });

  it("RED before: DELETE /events/:id/attendees/:userId — an unread chat lookup answers chatRemoved: false (a retry would promote a second waitlister), LOGGED", async () => {
    const s = world(); ev(s).chat_thread_id = "d4444444-4444-4444-8444-444444444401";
    install(s, { faults: [evRead("chat_thread_id")] });
    const r = await call("DELETE", `/events/${EV}/attendees/${ATT}`, "host");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { ok: true, chatRemoved: false });
    assert.ok(logged(/they were not removed from it/, "error"), JSON.stringify(logs));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("G. save, content, reports, block, reminders, cross-system", () => {
  it("RED before: POST /events/:id/save — an unread event is 503, not 404; nothing saved", async () => {
    const d = install(world(), { faults: [evRead("id, state")] });
    assertRefused(await call("POST", `/events/${EV}/save`, "att"), /events/);
    assert.equal(writesTo(d, "event_saves").length, 0);
  });

  it("RED before: GET /events/:id/posts — an attendee's unread RSVP is 503, not 403", async () => {
    install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("GET", `/events/${EV}/posts`, "att"), /event_rsvps/);
  });

  it("GREEN before (CONTROL): GET /events/:id/posts still refuses a stranger 403", async () => {
    install(world());
    const r = await call("GET", `/events/${EV}/posts`, "viewer");
    assert.equal(r.status, 403, r.raw);
  });

  it("RED before: POST /events/:id/posts — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("state, host_id, attendee_comments_enabled")] });
    assertRefused(await call("POST", `/events/${EV}/posts`, "att", { body: "hi" }), /events/);
  });

  it("RED before: GET /events/:id/media — an attendee's unread RSVP is 503, not 403", async () => {
    install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("GET", `/events/${EV}/media`, "att"), /event_rsvps/);
  });

  it("RED before: POST /events/:id/media — an attendee's unread RSVP is 503, not 403", async () => {
    install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/media`, "att", { mediaUrl: "post-media/a.jpg" }), /event_rsvps/);
  });

  it("RED before: GET /events/:id/comments — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("visibility, host_id, state")] });
    assertRefused(await call("GET", `/events/${EV}/comments`, "att"), /events/);
  });

  it("RED before: POST /events/:id/comments — an attendee's unread RSVP is 503, not 403", async () => {
    install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/comments`, "att", { body: "hello" }), /event_rsvps/);
  });

  it("RED before: POST /events/:id/report — an unread event is 503, not 404; no report written", async () => {
    const d = install(world(), { faults: [evRead("id")] });
    assertRefused(await call("POST", `/events/${EV}/report`, "viewer", { reason: "spam spam" }), /events/);
    assert.equal(writesTo(d, "event_reports").length, 0);
  });

  it("RED before: POST /events/:id/report-user/:userId — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("id")] });
    assertRefused(await call("POST", `/events/${EV}/report-user/${ATT}`, "viewer", { reason: "rude rude" }), /events/);
  });

  it("RED before: POST /events/:id/block-user/:userId — an unread recount leaves waitlist_count alone (it wrote 0)", async () => {
    const d = install(world(), { faults: [{ table: "event_waitlist", when: (c) => selectOf(c) === "user_id" && !c.some(([m]) => m === "gt" || m === "is" || m === "order") && !isWriteCalls(c) }] });
    const r = await call("POST", `/events/${EV}/block-user/${WL2}`, "host");
    assert.equal(r.status, 200, r.raw);
    const counted = writesTo(d, "events").filter((w) => "waitlist_count" in (w.rows[0] ?? {}));
    assert.ok(counted.length > 0 && counted.every((w) => w.rows[0].waitlist_count === undefined), JSON.stringify(counted));
  });

  it("RED before: POST /events/:id/reminders — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("id, state")] });
    assertRefused(await call("POST", `/events/${EV}/reminders`, "viewer", { remindAt: FUTURE }), /events/);
  });

  it("RED before: PATCH /events/:id/reminders/:id — an unread reminder is 503, not 404", async () => {
    install(world(), { faults: [{ table: "event_reminders" }] });
    assertRefused(await call("PATCH", `/events/${EV}/reminders/${REM}`, "viewer", { note: "x" }), /event_reminders/);
  });

  it("RED before: DELETE /events/:id/reminders/:id — an unread reminder is 503, not 404; nothing deleted", async () => {
    const d = install(world(), { faults: [{ table: "event_reminders" }] });
    assertRefused(await call("DELETE", `/events/${EV}/reminders/${REM}`, "viewer"), /event_reminders/);
    assert.equal(d.seed.event_reminders!.length, 1);
  });

  it("RED before: POST /events/:id/add-to-trip — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("*")] });
    assertRefused(await call("POST", `/events/${EV}/add-to-trip`, "viewer", { tripId: TRIP }), /events/);
  });

  it("RED before: add-to-trip — an unread trip membership is 503, not 403; nothing added", async () => {
    const d = install(world(), { faults: [{ table: "trip_members", when: sel("role") }] });
    assertRefused(await call("POST", `/events/${EV}/add-to-trip`, "viewer", { tripId: TRIP }), /trip_members/);
    assert.equal(writesTo(d, "trip_plan_items").length, 0);
  });

  it("RED before: POST /events/:id/link-circle — an unread circle membership is 503, not 403", async () => {
    install(world(), { faults: [{ table: "circle_memberships" }] });
    assertRefused(await call("POST", `/events/${EV}/link-circle`, "host", { circleId: OTHER }), /circle_memberships/);
  });

  it("RED before: POST /events/:id/telegraph-thread — an unread event is 503, not 404", async () => {
    install(world(), { faults: [{ table: "events", when: (c) => selectOf(c).startsWith("title, state, host_id, chat_enabled") }] });
    assertRefused(await call("POST", `/events/${EV}/telegraph-thread`, "host"), /events/);
  });

  it("RED before: GET /events/:id/agenda-items — an unread event is 503, not 404", async () => {
    install(world(), { faults: [evRead("host_id")] });
    assertRefused(await call("GET", `/events/${EV}/agenda-items`, "att"), /events/);
  });

  it("RED before: POST /events/:id/agenda-items — an attendee's unread RSVP is 503, not 403", async () => {
    install(world(), { faults: [rsvpOf(ATT)] });
    assertRefused(await call("POST", `/events/${EV}/agenda-items`, "att", { title: "Dinner" }), /event_rsvps/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("H. checkEventEligibility (exported: mapSearch, collections, calls and the sweeper ask it too)", () => {
  const evRow = (o: Record<string, unknown> = {}) => ({ id: EV, host_id: HOST, verified_only: false, trust_score_min: null, age_min: null, age_max: null, ...o });
  it("RED before: an unread staff role is `unavailable` (degraded_unavailable), not the viewer gates run on a co-host", async () => {
    const s = world(); s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    install(s, { faults: [{ table: "event_roles", when: (c) => has(c, "in", "role", ["co_host", "moderator"]) }] });
    const { getServiceClient } = await import("../lib/supabase.js");
    const r: any = await checkEventEligibility(getServiceClient(), evRow({ trust_score_min: 99 }), COHOST);
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, true);
    assert.equal(r.errorCode, "degraded_unavailable");
  });

  it("RED before: every `unavailable` refusal carries degraded_unavailable (so a route that sends errorCode answers 503, not 403)", async () => {
    const s = world(); s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    const { getServiceClient } = await import("../lib/supabase.js");
    for (const [fault, row] of [
      [{ table: "event_roles", when: (c: Call[]) => has(c, "eq", "role", "banned") }, evRow()],
      [{ table: "profiles", when: sel("verified") }, evRow({ verified_only: true })],
      [{ table: "trust_profiles" }, evRow({ trust_score_min: 40 })],
      [{ table: "blocks" }, evRow()],
    ] as Array<[Fault, any]>) {
      install(world2(s), { faults: [fault] });
      const r: any = await checkEventEligibility(getServiceClient(), row, VIEWER);
      assert.equal(r.ok, false, fault.table);
      assert.equal(r.unavailable, true, fault.table);
      assert.equal(r.errorCode, "degraded_unavailable", fault.table);
    }
  });

  it("GREEN before (CONTROL): a co-host is admitted past every gate; a genuinely blocked user is refused `forbidden`", async () => {
    const s = world(); s.feature_flags!.push({ flag: "events_trust_gates_enabled", enabled: true });
    s.blocks!.push({ id: "e5555555-5555-4555-8555-555555555501", blocker_id: HOST, blocked_id: VIEWER, created_at: at(1) });
    install(s);
    const { getServiceClient } = await import("../lib/supabase.js");
    assert.equal((await checkEventEligibility(getServiceClient(), evRow({ trust_score_min: 99 }), COHOST)).ok, true);
    const r: any = await checkEventEligibility(getServiceClient(), evRow(), VIEWER);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "forbidden");
    assert.equal(r.unavailable, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("I. structural — no read in routes/events.ts discards its error, and no gate folds an unread answer", () => {
  const EVENTS = join(SRC, "routes/events.ts");
  const text = readFileSync(EVENTS, "utf8");
  const code = sanitize(text);

  it("RED before: checkUncheckedSupabaseReads, judged at EVERY tier, finds no read in routes/events.ts that ignores its error (152 did)", () => {
    const scan = scanSource(text, "routes/events.ts");
    assert.ok(scan.sitesJudged >= 200, `vacuity: only ${scan.sitesJudged} read sites judged`);
    assert.deepEqual(scan.reads.map((r) => `:${r.line} ${r.fn} ${r.table}.${r.terminal} (${r.shape})`), []);
    assert.equal(scan.unresolved, 0, scan.unresolvedSamples.join("\n"));
  });

  it("RED before: the routes ask viewableOrThrow, never canViewEvent (which folds `unavailable` into false)", () => {
    const calls = [...code.matchAll(/\bcanViewEvent\(/g)].map((m) => text.slice(0, m.index!).split("\n").length);
    const decl = text.split("\n").findIndex((l) => l.startsWith("export async function canViewEvent(")) + 1;
    assert.deepEqual(calls, [decl], "canViewEvent is declared (exported for other surfaces) and called nowhere in this file");
    assert.ok([...code.matchAll(/\bviewableOrThrow\(/g)].length >= 5);
  });

  it("RED before: no list loop drops an event on an UNAVAILABLE eligibility, and no route sends a gate's \"temporarily unavailable\" as 403", () => {
    assert.equal([...code.matchAll(/if \(!elig\.ok\) continue;/g)].length, 0);
    assert.equal([...text.matchAll(/sendError\(res, "forbidden", (?:AGE_CHECK_UNAVAILABLE_MESSAGE|"[^"]*temporarily unavailable)/g)].length, 0);
    assert.equal([...text.matchAll(/errorCode: "forbidden", message: (?:AGE_CHECK_UNAVAILABLE_MESSAGE|"[^"]*temporarily unavailable)/g)].length, 0);
  });

  it("RED before: the block check, isTripEventMember and isGoingAttendee no longer fold an unread answer into \"no\"", () => {
    assert.ok(!/return isBlockedBetween\(sc, userA, userB\);/.test(code), "isBlocked still delegates to the fold");
    assert.ok(!/if \(error \|\| !data\) return false;/.test(code), "isTripEventMember still folds");
    assert.ok(!/return !error && \(data as any\)\?\.status === "going";/.test(code), "isGoingAttendee still folds");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// J. Item 3 — a host may cancel an event a moderator hid (the owner ruling on
// holding it is open); the restore must not then stick. It refused WHOLE (no
// recorded moderation put the event in `cancelled` — its host did), so the hide
// it could reverse was never reversed: cancelled and hidden for good.
// ═════════════════════════════════════════════════════════════════════════════
describe("J. a restore keeps a state its HOST chose and still reverses the moderator's hide", () => {
  const C: any = claimLib;
  const moderate = (action: string) => call("PATCH", `/admin/events/${EV}/moderate`, "admin", { action });
  const activity = (s: Seed) => s.event_activity_log!.map((a) => ({ action: a.action, ...(a.metadata as any) }));

  it("GREEN before (CONTROL): the host may still cancel a moderator-hidden event (the hide holds visibility only)", async () => {
    const s = world();
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal(ev(s).visibility, "invite_only");
    const c = await call("POST", `/events/${EV}/cancel`, "host", {});
    assert.equal(c.status, 200, c.raw);
    assert.equal(ev(s).state, "cancelled");
  });

  it("RED before: hide, then the HOST cancels — the moderator's restore puts the visibility back (public) and keeps the host's cancel, saying why (it refused whole)", async () => {
    const s = world();
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await call("POST", `/events/${EV}/cancel`, "host", {})).status, 200);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.visibility, { from: "invite_only", to: "public" });
    assert.equal(r.body.state, undefined, "no state change");
    assert.match(String(r.body.stateKept), /no recorded moderation put it there/);
    assert.equal(ev(s).visibility, "public");
    assert.equal(ev(s).state, "cancelled", "the host's cancel stands");
    const last = activity(s).at(-1)!;
    assert.equal(last.action, "admin_restore");
    assert.equal(last.from_visibility, "invite_only");
    assert.equal(last.to_visibility, "public");
    assert.equal(last.from_state, undefined);
    const hold = C.decideEventModerationHold([...s.event_activity_log!].reverse());
    assert.deepEqual(hold, { visibility: null, state: null }, "the restore released the visibility hold");
  });

  it("RED before: hide, then the host ARCHIVES (from open) — the restore still reverses the hide and keeps `archived`", async () => {
    const s = world();
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await call("POST", `/events/${EV}/archive`, "host", {})).status, 200);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).visibility, "public");
    assert.equal(ev(s).state, "archived");
    assert.ok(r.body.stateKept);
  });

  it("RED before: the APPEAL path likewise — reverseModeratedEventOnAppeal restores the visibility and keeps the host's cancel", async () => {
    const s = world();
    const d = install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await call("POST", `/events/${EV}/cancel`, "host", {})).status, 200);
    const { getServiceClient } = await import("../lib/supabase.js");
    const out = await C.reverseModeratedEventOnAppeal(getServiceClient(), { eventId: EV, hostId: HOST, actorId: ADMIN, appealId: "c3333333-3333-4333-8333-3333333333ee", note: null });
    assert.equal(out.outcome, "restored", JSON.stringify(out));
    assert.deepEqual(out.visibility, { from: "invite_only", to: "public" });
    assert.equal(out.state, null);
    assert.match(String(out.stateKept), /no recorded moderation put it there/);
    assert.equal(ev(s).state, "cancelled");
    void d;
  });

  it("GREEN before (CONTROL): a host-cancelled event with NO hide to reverse is still refused, with the state's own message", async () => {
    const s = world(); ev(s).state = "cancelled";
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.match(r.body.message, /no recorded moderation put it there.*Nothing was changed or recorded\./);
    assert.equal(ev(s).state, "cancelled");
  });

  it("GREEN before (CONTROL): a MODERATOR's hide and cancel are both reversed by the restore, as before", async () => {
    const s = world();
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await moderate("cancel")).status, 200);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "public");
    assert.equal(r.body.stateKept, undefined);
  });

  it("GREEN before (CONTROL): an unreadable moderation record still refuses the restore — nothing written", async () => {
    const s = world();
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await call("POST", `/events/${EV}/cancel`, "host", {})).status, 200);
    install(s, { faults: [{ table: "event_activity_log" }] });
    const r = await moderate("restore");
    assert.ok(r.status >= 500, r.raw);
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("RED before: the kept-state restore never WIDENS — a friends-only event the moderator hid comes back friends-only, not public", async () => {
    const s = world(); ev(s).visibility = "friends_only";
    install(s);
    assert.equal((await moderate("hide")).status, 200);
    assert.equal((await call("POST", `/events/${EV}/cancel`, "host", {})).status, 200);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.visibility, { from: "invite_only", to: "friends_only" });
    assert.equal(ev(s).visibility, "friends_only");
  });

  it("RED before: the kept-state restore never releases a moderator's STATE hold — a recorded cancel that something moved since (legacy archive) still holds; only the hide is reversed", async () => {
    const s = world(); Object.assign(ev(s), { state: "archived", visibility: "invite_only" });
    const row = (n: number, action: string, metadata: Record<string, unknown>) => ({ id: `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, event_id: EV, actor_id: ADMIN, action, metadata: { reason: null, ...metadata }, created_at: at(100 + n) });
    s.event_activity_log = [row(1, "admin_cancel", { from_state: "open", to_state: "cancelled" }), row(2, "admin_hide", { from_visibility: "public", to_visibility: "invite_only" })];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.match(String(r.body.stateKept), /something else has moved it since/);
    assert.equal(ev(s).state, "archived", "never un-cancelled, never moved");
    assert.equal(ev(s).visibility, "public");
    const hold = C.decideEventModerationHold([...s.event_activity_log!].reverse());
    assert.deepEqual(hold, { visibility: null, state: "admin_cancel" }, "the moderator's cancel still holds the state");
  });

  it("RED before: decideModeratedEventState answers a restore of a host-cancelled event KEPT (ok, no decision, the reason) — and an unreadable record still refuses", async () => {
    const s = world(); ev(s).state = "cancelled";
    install(s);
    const { getServiceClient } = await import("../lib/supabase.js");
    const kept = await C.decideModeratedEventState(getServiceClient(), ev(s), { reverse: true });
    assert.equal(kept.ok, true, JSON.stringify(kept));
    assert.equal(kept.decision, null);
    assert.match(String(kept.kept), /no recorded moderation put it there/);
    install(world2(s), { faults: [{ table: "event_activity_log" }] });
    const failed = await C.decideModeratedEventState(getServiceClient(), ev(s), { reverse: true });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "db_error");
  });

  it("RED before: keepHostStateOnRestore — a state refusal becomes `kept` (reason, without \"Nothing was changed\"); a failed read stays a refusal; an allowed decision passes through", () => {
    assert.equal(typeof C.keepHostStateOnRestore, "function", "keepHostStateOnRestore is not exported");
    assert.deepEqual(C.keepHostStateOnRestore({ ok: false, code: "invalid_state_transition", message: "Event is 'cancelled', and no recorded moderation put it there. Nothing was changed or recorded." }), { ok: true, decision: null, kept: "Event is 'cancelled', and no recorded moderation put it there." });
    const failed = { ok: false, code: "db_error", message: "read failed. Nothing was changed or recorded." };
    assert.deepEqual(C.keepHostStateOnRestore(failed), failed);
    const allowed = { ok: true, decision: { allowed: true, from: "cancelled", to: "open" } };
    assert.deepEqual(C.keepHostStateOnRestore(allowed), allowed);
  });
});
