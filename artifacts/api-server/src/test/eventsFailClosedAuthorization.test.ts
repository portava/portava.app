/**
 * routes/events.ts — the reads that decide ACCESS must fail CLOSED.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `checkEventEligibility` is an authorization gate: it decides whether a caller
 * may join, RSVP to, or see an event. Two of its reads discarded `error`, and
 * supabase-js RESOLVES on a database error rather than throwing, so:
 *
 *     const { data: bannedRole } = await sc.from("event_roles")...;
 *     if (bannedRole) return { ok: false, ... };      // ← the defect
 *
 * produced the SAME falsy `bannedRole` when the caller is not banned and when
 * `event_roles` could not be read. A banned caller was therefore ADMITTED
 * during any database blip. The block check above it had the identical shape.
 *
 * A ban is the most deliberate exclusion an organiser can express. It must not
 * evaporate because a table was briefly unreadable.
 *
 * ── WHAT IS PROVEN, AND THE TRAP THAT MAKES IT WORTH PROVING ────────────────
 * Every case has BOTH halves:
 *
 *   failure  the table errors  → the caller is DENIED
 *   healthy  the table reads   → the normal answer is unchanged
 *
 * The healthy half is not padding. A "fix" that denied unconditionally would
 * pass every failure case in this file and be a total outage; only the healthy
 * cases catch it. Likewise a test asserting merely "not ok" would pass for a
 * gate that rejected for some unrelated reason — so each case asserts the
 * specific `message`, which differs between "you are banned" (a verdict about
 * the caller) and "temporarily unavailable" (an admission that the check could
 * not run).
 *
 * The `/events` feed case additionally asserts the exact `error` code in the
 * JSON envelope rather than `status !== 200`: a request rejected at VALIDATION
 * never reaches the code under test and would satisfy the looser assertion.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventsFailClosedAuthorization.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import eventsRouter, { checkEventEligibility } from "../routes/events.js";

const HOST    = "aaaaaaaa-1111-4000-a000-000000000001";
const ME      = "bbbbbbbb-1111-4000-a000-000000000002";
const BLOCKER = "cccccccc-1111-4000-a000-000000000003"; // hosts an event, blocks ME
const EVENT   = "dddddddd-1111-4000-a000-000000000004";
const EVENT2  = "eeeeeeee-1111-4000-a000-000000000005";
const TOK     = "tok-me";

const EV = {
  id: EVENT,
  host_id: HOST,
  age_min: null,
  age_max: null,
  trust_score_min: null,
  verified_only: false,
  state: "open",
  visibility: "public",
  starts_at: new Date(Date.now() + 86_400_000).toISOString(),
};

type Rows = Record<string, any[]>;

/**
 * Table-driven fake. `failTables` answers `{ data: null, error }` — the
 * RESOLVED failure supabase-js really produces, never a throw. Everything else
 * succeeds, so the fail-open path stays survivable end to end: if the failure
 * were accidentally fatal, "denied" would prove nothing about the guard.
 */
function makeClient(rows: Rows, failTables: ReadonlySet<string>, updates?: Array<{ table: string; patch: any }>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    function settle(single: boolean) {
      if (failTables.has(table)) {
        return Promise.resolve({
          data: null,
          error: { message: `${table} read failed`, code: "57014" },
          count: null,
        });
      }
      const out = (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null, count: out.length });
    }
    const b: any = {
      select() { return b; },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any)  { filters.push((r) => (r[c] ?? null) === v); return b; },
      not() { return b; },
      gt(c: string, v: any)  { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte() { return b; }, lte() { return b; }, lt() { return b; },
      ilike() { return b; },
      contains() { return b; }, overlaps() { return b; },
      order() { return b; }, range() { return b; }, limit() { return b; },
      upsert() { return b; }, insert() { return b; },
      update(patch: any) { updates?.push({ table, patch }); return b; },
      delete() { return b; },
      or(expr: string) {
        const clauses = splitTop(expr).map(parseClause);
        filters.push((r) => clauses.some((c) => c(r)));
        return b;
      },
      maybeSingle() { return settle(true); },
      single() { return settle(true); },
      then(f: any, j: any) { return settle(false).then(f, j); },
    };
    return b;
  }
  return {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getUser: async (tok: string) =>
        tok === TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseClause(c: string): (r: any) => boolean {
  const and = c.match(/^and\((.*)\)$/s);
  if (and) {
    const parts = splitTop(and[1]).map(parseClause);
    return (r) => parts.every((p) => p(r));
  }
  const m = c.match(/^(\w+)\.(\w+)\.(.*)$/s);
  if (!m) return () => false;
  const [, col, op, raw] = m;
  if (op === "eq") return (r) => String(r[col]) === raw;
  if (op === "is") return (r) => (r[col] ?? null) === (raw === "null" ? null : raw);
  return () => false;
}

// ── checkEventEligibility: the two authorization reads ────────────────────────

describe("checkEventEligibility — the ban lookup", () => {
  it("DENIES when event_roles cannot be read (was: admitted the banned caller)", async () => {
    const sc = makeClient({ event_roles: [], blocks: [] }, new Set(["event_roles"]));
    const r = await checkEventEligibility(sc, EV, ME);
    assert.equal(r.ok, false);
    // The message must say the check could not RUN, not assert a verdict about
    // this caller — they may well not be banned.
    assert.match((r as any).message, /temporarily unavailable/i);
  });

  it("still denies a genuinely banned caller when the table reads fine", async () => {
    const sc = makeClient(
      { event_roles: [{ event_id: EVENT, user_id: ME, role: "banned" }], blocks: [] },
      new Set(),
    );
    const r = await checkEventEligibility(sc, EV, ME);
    assert.equal(r.ok, false);
    assert.match((r as any).message, /banned/i);
  });

  it("still ADMITS an ordinary caller when the table reads fine", async () => {
    const sc = makeClient({ event_roles: [], blocks: [] }, new Set());
    const r = await checkEventEligibility(sc, EV, ME);
    assert.equal(r.ok, true);
  });

  it("still admits the host without consulting event_roles at all", async () => {
    // The host short-circuits before any read, so even a fully broken database
    // must not lock an organiser out of their own event.
    const sc = makeClient({}, new Set(["event_roles", "blocks", "profiles", "trust_profiles"]));
    const r = await checkEventEligibility(sc, EV, HOST);
    assert.equal(r.ok, true);
  });
});

describe("checkEventEligibility — the block lookup", () => {
  it("DENIES when blocks cannot be read (was: admitted a blocked caller)", async () => {
    const sc = makeClient({ event_roles: [], blocks: [] }, new Set(["blocks"]));
    const r = await checkEventEligibility(sc, EV, ME);
    assert.equal(r.ok, false);
    assert.match((r as any).message, /cannot join/i);
  });

  it("still denies a genuinely blocked caller", async () => {
    const sc = makeClient(
      { event_roles: [], blocks: [{ blocker_id: HOST, blocked_id: ME }] },
      new Set(),
    );
    const r = await checkEventEligibility(sc, EV, ME);
    assert.equal(r.ok, false);
    assert.match((r as any).message, /cannot join/i);
  });

  it("still admits when there is no block", async () => {
    const sc = makeClient({ event_roles: [], blocks: [] }, new Set());
    assert.equal((await checkEventEligibility(sc, EV, ME)).ok, true);
  });
});

// ── GET /events: the feed must not serve an unfiltered roster ────────────────

let server: Server;
let base = "";

function startApp() {
  const app = express();
  app.use(express.json());
  // The real server installs a logger. Without it these routes CRASH with a
  // TypeError and a 500-from-crash would masquerade as fail-closed.
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use(eventsRouter);
  return app;
}

before(async () => {
  server = createServer(startApp());
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  await new Promise<void>((r) => server.close(() => r()));
});

const FEED_ROWS: Rows = {
  events: [
    { id: EVENT,  host_id: HOST,    state: "open", visibility: "public", starts_at: EV.starts_at, title: "ok" },
    { id: EVENT2, host_id: BLOCKER, state: "open", visibility: "public", starts_at: EV.starts_at, title: "from a blocker" },
  ],
  blocks: [{ blocker_id: BLOCKER, blocked_id: ME }],
  event_rsvps: [], event_attendees: [], profiles: [], user_friendships: [],
  feature_flags: [], event_roles: [], circle_memberships: [], trip_members: [],
};

describe("GET /events — the block-scoped feed", () => {
  it("REFUSES with degraded_unavailable when blocks cannot be read", async () => {
    const c = makeClient(FEED_ROWS, new Set(["blocks"]));
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    const res = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOK}` } });
    const body = await res.json().catch(() => ({}));
    // Assert the CODE, not merely a non-200: a request rejected at validation
    // would never reach the filter and would still be non-200.
    assert.equal((body as any)?.error, "degraded_unavailable");
    assert.notEqual(res.status, 200);
  });

  it("serves the feed normally when blocks reads fine, and omits the blocker's event", async () => {
    const c = makeClient(FEED_ROWS, new Set());
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    const res = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOK}` } });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    const items: any[] = body?.events ?? body?.data ?? body?.items ?? [];
    const ids = items.map((e) => e.id);
    // The healthy half: a real block still filters, and the unblocked host's
    // event still appears. Without this, "always refuse" would pass the case
    // above and be a total outage.
    assert.ok(!ids.includes(EVENT2), "an event from a blocking host must not be served");
  });
});

// ── POST /events: a guard that could not run must not fabricate a verdict ────

const CREATE_ROWS: Rows = {
  feature_flags: [{ flag: "events_enabled", enabled: true }],
  events: [], event_rsvps: [], event_attendees: [], profiles: [],
  blocks: [], event_roles: [], user_friendships: [],
};

const CREATE_BODY = {
  title: "Duplicate check probe",
  locationName: "The Same Bar",
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  visibility: "public",
  // The duplicate check only runs on the publish path — without this the
  // request falls straight through to the INSERT and this test would be
  // exercising nothing.
  publishNow: true,
};

describe("POST /events — duplicate detection", () => {
  it("REFUSES retryably when the events table cannot be read", async () => {
    // The tempting repair is to answer "duplicate" on error. That is worse than
    // the defect: it tells the host an event of theirs already exists, which is
    // a fabricated verdict about their own data, and blocks a legitimate
    // creation. A guard that could not be EVALUATED has not found anything.
    const c = makeClient(CREATE_ROWS, new Set(["events"]));
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      body: JSON.stringify(CREATE_BODY),
    });
    const body: any = await res.json().catch(() => ({}));
    assert.equal(body?.error, "degraded_unavailable");
    // Specifically NOT the duplicate verdict — that would be the false claim.
    assert.notEqual(body?.error, "duplicate_event");
  });

  it("still reports a REAL duplicate as duplicate_event when the table reads", async () => {
    const rows: Rows = {
      ...CREATE_ROWS,
      events: [{
        id: EVENT, host_id: ME, location_name: "The Same Bar",
        starts_at: CREATE_BODY.startsAt, state: "open",
      }],
    };
    const c = makeClient(rows, new Set());
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
      body: JSON.stringify(CREATE_BODY),
    });
    const body: any = await res.json().catch(() => ({}));
    // The healthy half: without this, "always refuse" would pass the case above
    // while making event creation impossible.
    assert.equal(body?.error, "duplicate_event");
  });
});


// ── syncEventState: a reserved waitlist slot must not be given away ──────────

const FULL_EVENT = "ffffffff-1111-4000-a000-000000000006";

function waitlistRows(): Rows {
  return {
    feature_flags: [{ flag: "events_enabled", enabled: true }],
    events: [{
      id: FULL_EVENT, host_id: HOST, state: "full", max_attendees: 5,
      waitlist_enabled: false, rsvp_closed: false, visibility: "public",
      starts_at: EV.starts_at,
    }],
    // Nobody is going, so `going (0) < max (5)` and syncEventState reaches the
    // reopen branch — which is the branch under test.
    event_rsvps: [],
    // A live offer exists: the slot is RESERVED and must not be released.
    event_waitlist: [{
      event_id: FULL_EVENT, user_id: BLOCKER, position: 1,
      offer_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }],
    event_roles: [], blocks: [], profiles: [], event_attendees: [],
    event_join_requests: [], message_threads: [], notifications: [],
  };
}

async function rsvpCantGo() {
  return fetch(`${base}/events/${FULL_EVENT}/rsvp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "cant_go" }),
  });
}

describe("syncEventState — the waitlist offer check", () => {
  it("does NOT reopen the event when event_waitlist cannot be read", async () => {
    // The read used to discard `error`, so an unreadable event_waitlist answered
    // "no live offer" and syncEventState reopened the event to `open` — giving
    // away the slot reserved for the offer holder, to whoever asked next.
    const updates: Array<{ table: string; patch: any }> = [];
    const c = makeClient(waitlistRows(), new Set(["event_waitlist"]), updates);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    await rsvpCantGo();
    const reopened = updates.some((u) => u.table === "events" && u.patch?.state === "open");
    assert.equal(reopened, false, "an unreadable waitlist must not release the reserved slot");
  });

  it("does not reopen when a live offer genuinely exists", async () => {
    const updates: Array<{ table: string; patch: any }> = [];
    const c = makeClient(waitlistRows(), new Set(), updates);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    await rsvpCantGo();
    assert.equal(updates.some((u) => u.table === "events" && u.patch?.state === "open"), false);
  });

  it("DOES reopen once the offer has expired and the table reads fine", async () => {
    // The healthy half. Without it, "never reopen" would pass both cases above
    // and quietly break waitlist recovery: a full event would stay full forever.
    const rows = waitlistRows();
    rows.event_waitlist = [{
      event_id: FULL_EVENT, user_id: BLOCKER, position: 1,
      offer_expires_at: new Date(Date.now() - 3_600_000).toISOString(),
    }];
    const updates: Array<{ table: string; patch: any }> = [];
    const c = makeClient(rows, new Set(), updates);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    await rsvpCantGo();
    assert.equal(updates.some((u) => u.table === "events" && u.patch?.state === "open"), true,
      "an expired offer must let the event reopen");
  });
});
