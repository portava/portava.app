/**
 * Meetup routes — node:test suite
 *
 * Covers:
 *   POST   /api/meetups                                  — create
 *   GET    /api/meetups/:meetupId                        — detail + access gates
 *   PATCH  /api/meetups/:meetupId                        — update (creator only)
 *   DELETE /api/meetups/:meetupId                        — cancel (creator only)
 *   POST   /api/meetups/:meetupId/invite                 — invite users
 *   POST   /api/meetups/:meetupId/rsvp                   — RSVP
 *   POST   /api/meetups/:meetupId/time-options           — add option (creator)
 *   POST   /api/meetups/:meetupId/time-options/:id/vote  — vote
 *   POST   /api/meetups/:meetupId/time-options/:id/confirm — confirm time
 *   POST   /api/meetups/:meetupId/add-to-trip-plan       — add to trip plan
 *   GET    /api/me/meetup-invites                        — own pending invites
 *
 * Runtime: node:test + fetch() on a real Express server at a random port.
 * Fake Supabase injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/meetups.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import meetupsRouter from "../routes/meetups.js";
import planRouter from "../routes/plan.js";

// ── IDs ───────────────────────────────────────────────────────────────────────

const ALICE_ID  = "00000000-0000-0000-0000-0000000000a1";
const BOB_ID    = "00000000-0000-0000-0000-0000000000b2";
const MEETUP_ID = "00000000-0000-0000-0000-000000000001";
const TRIP_ID   = "00000000-0000-0000-0000-000000000002";
const OPT_ID    = "00000000-0000-0000-0000-000000000003";
const CIRCLE_ID = "00000000-0000-0000-0000-000000000004";

const NOW = new Date().toISOString();

// ── Row factories ─────────────────────────────────────────────────────────────

function makeMeetup(overrides: Record<string, any> = {}) {
  return {
    id: MEETUP_ID,
    creator_id: ALICE_ID,
    title: "Test meetup",
    description: null,
    location_name: "Somewhere",
    approximate_date: null,
    time_block: null,
    starts_at: null,
    ends_at: null,
    status: "active",
    trip_id: null,
    circle_owner_id: null,
    visibility: "invitees",
    chat_thread_id: null,
    chat_message_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeTimeOption(overrides: Record<string, any> = {}) {
  return {
    id: OPT_ID,
    meetup_id: MEETUP_ID,
    proposed_date: "2026-08-01",
    time_block: "evening",
    label: null,
    confirmed: false,
    created_at: NOW,
    ...overrides,
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

interface State {
  users: Record<string, { id: string } | null>;
  meetups: any[];
  meetup_invites: any[];
  meetup_time_options: any[];
  meetup_time_votes: any[];
  trip_members: any[];
  trips: any[];
  circle_memberships: any[];
  trip_plan_items: any[];
  user_friendships: any[];
  profiles: any[];
  message_threads: any[];
  /** census-trust §31: the age seam's second input (lib/gateAge.ts). */
  identity_verifications?: any[];
  /** Tables whose SELECTs resolve `{ data: null, error }` — the real supabase-js failure shape. */
  readErrors?: Record<string, { code: string; message: string }>;
  /** Every insert ISSUED, by table, so a case can prove who was (not) invited. */
  inserts?: Array<{ table: string; rows: any[] }>;
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
    },
    meetups: [],
    meetup_invites: [],
    meetup_time_options: [],
    meetup_time_votes: [],
    trip_members: [],
    trips: [],
    circle_memberships: [],
    trip_plan_items: [],
    user_friendships: [],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null },
      { id: BOB_ID,   handle: "bob",   name: "Bob",   avatar_url: null },
    ],
    message_threads: [],
    ...overrides,
  };
}

// ── Fake Supabase ─────────────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  let insertedRow: any = null;
  let upsertedRow: any = null;

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "upsert" | "insert" = "select";
    let _pendingInsert: any = null;
    let _pendingUpdate: any = null;
    let _pendingUpsert: any = null;

    const b: any = {
      select(_sel?: string) { return b; },
      insert(row: any) {
        _op = "insert";
        _pendingInsert = Array.isArray(row) ? row[0] : row;
        state.inserts?.push({ table, rows: Array.isArray(row) ? row : [row] });
        return b;
      },
      update(patch: any) { _op = "update"; _pendingUpdate = patch; return b; },
      delete()           { _op = "delete"; return b; },
      upsert(row: any, _opts?: any) {
        _op = "upsert";
        _pendingUpsert = Array.isArray(row) ? row[0] : row;
        return b;
      },
      eq(col: string, val: any)    { filters.push((r: any) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r: any) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      is()    { return b; },
      not()   { return b; },
      or()    { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolveOne(); },
      single()      { return resolveSingle(); },
      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        if (_op === "upsert") return resolveUpsert().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matched()          { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    const readErr = state.readErrors?.[table] ?? null;
    async function resolveOne() { return readErr ? { data: null, error: readErr } : { data: matched()[0] ?? null, error: null }; }
    async function resolveSingle() {
      if (_op === "insert" && _pendingInsert) {
        const row = { id: `gen-${table}-${Date.now()}`, ...(_pendingInsert) };
        getSource().push(row);
        insertedRow = row;
        return { data: row, error: null };
      }
      if (_op === "upsert" && _pendingUpsert) {
        const source = getSource();
        const existing = source.find((r) => filters.every((f) => f(r)));
        if (existing) { Object.assign(existing, _pendingUpsert); return { data: existing, error: null }; }
        source.push(_pendingUpsert);
        return { data: _pendingUpsert, error: null };
      }
      return { data: matched()[0] ?? null, error: null };
    }
    async function resolveList() {
      if (_op === "select" && readErr) return { data: null, error: readErr };
      return { data: matched(), error: null };
    }
    async function resolveUpdate() {
      for (const row of getSource()) {
        if (filters.every((f) => f(row))) Object.assign(row, _pendingUpdate);
      }
      return { data: null, error: null };
    }
    async function resolveDelete() {
      (state as any)[table] = getSource().filter((r: any) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    async function resolveUpsert() {
      if (!_pendingUpsert) return { data: null, error: null };
      const source = getSource();
      const existing = source.find((r: any) => filters.every((f) => f(r)));
      if (existing) { Object.assign(existing, _pendingUpsert); return { data: existing, error: null }; }
      source.push(_pendingUpsert);
      upsertedRow = _pendingUpsert;
      return { data: _pendingUpsert, error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

// ── Server helpers ────────────────────────────────────────────────────────────

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  // Mirror production mounting order (routes/index.ts): planRouter is mounted
  // before meetupsRouter, so POST /meetups/:id/add-to-trip-plan is served by
  // plan.ts (the shadowed duplicate handler in meetups.ts was removed).
  app.use("/api", planRouter);
  app.use("/api", meetupsRouter);

  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, state, close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())) });
    });
    srv.on("error", reject);
  });
}

async function get(port: number, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function httpPost(port: number, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function httpDelete(port: number, path: string, token: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── POST /api/meetups ─────────────────────────────────────────────────────────

describe("POST /api/meetups", () => {
  it("rejects unauthenticated requests", async () => {
    const s = await startServer(baseState());
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/meetups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test" }),
      });
      assert.equal(res.status, 401);
    } finally { await s.close(); }
  });

  it("rejects missing title", async () => {
    const s = await startServer(baseState());
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", { description: "no title" });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("rejects title over 200 chars", async () => {
    const s = await startServer(baseState());
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", { title: "x".repeat(201) });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("creates a basic invitee-scoped meetup", async () => {
    const state = baseState({ meetups: [makeMeetup()] });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "Rooftop drinks",
        locationName: "Top floor",
        visibility: "invitees",
      });
      assert.equal(r.status, 201);
      assert.ok(r.body.id);
      assert.ok(r.body.title);
    } finally { await s.close(); }
  });

  it("rejects trip meetup if not a trip member", async () => {
    const state = baseState(); // alice has no trip_members rows
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "Trip meetup",
        tripId: TRIP_ID,
        visibility: "trip",
      });
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("creates trip meetup when user is trip owner", async () => {
    const state = baseState({
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
      meetups: [makeMeetup({ trip_id: TRIP_ID, visibility: "trip" })],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "Trip meetup",
        tripId: TRIP_ID,
        visibility: "trip",
      });
      assert.equal(r.status, 201);
    } finally { await s.close(); }
  });
});

// ── census-trust §31 — both invite paths apply the AGE pre-check ─────────────
//
// POST /meetups/:id/invites filtered age-ineligible invitees through the age
// seam; POST /meetups — which ALSO invites, from `inviteeIds` — applied the
// scope rules and skipped the age rule, so an age-ineligible friend (a
// verified minor included) was invited into an 18+ meetup, and the invite row
// is what canAccessMeetup admits on. A scope read that fails must not invite
// nobody silently (create) or list real friends as `ineligible` (/invites).

const CAROL_ID = "00000000-0000-0000-0000-0000000000c3";

function ageState(extra: Partial<State> = {}): State {
  const s = baseState({
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null, date_of_birth: "1990-01-01" },
      { id: BOB_ID,   handle: "bob",   name: "Bob",   avatar_url: null, date_of_birth: "1990-01-01" },
      // 19 years old on any date this suite runs, so below a 21+ limit.
      { id: CAROL_ID, handle: "carol", name: "Carol", avatar_url: null,
        date_of_birth: `${new Date().getUTCFullYear() - 19}-01-01` },
    ],
    user_friendships: [
      { user_a: ALICE_ID, user_b: BOB_ID },
      { user_a: ALICE_ID, user_b: CAROL_ID },
    ],
    identity_verifications: [],
    ...extra,
  });
  s.inserts = [];
  return s;
}

/** The response fields these cases read — the shape POST /meetups and /invites emit. */
interface InviteResponseBody {
  error?: string;
  inviteErrors?: string[];
  ageIneligible?: string[];
  invited?: string[];
}
const bodyOf = (r: { body: unknown }): InviteResponseBody => (r.body ?? {}) as InviteResponseBody;

const invitedBy = (s: State) =>
  (s.inserts ?? []).filter((i) => i.table === "meetup_invites").flatMap((i) => i.rows.map((r: any) => r.user_id));

describe("census-trust §31 — POST /api/meetups applies the age pre-check to its invitees", () => {
  it("A1. CONTROL — an age-limited meetup still invites an eligible adult friend", async () => {
    const state = ageState();
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "21+ tasting", visibility: "invitees", inviteeIds: [BOB_ID], ageLimitEnabled: true, minAge: 21,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(invitedBy(state), [BOB_ID]);
      assert.deepEqual(bodyOf(r).ageIneligible, []);
    } finally { await s.close(); }
  });

  it("A2. an UNDER-AGE friend is NOT invited into an age-limited meetup, and is reported", async () => {
    const state = ageState();
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "21+ tasting", visibility: "invitees", inviteeIds: [BOB_ID, CAROL_ID], ageLimitEnabled: true, minAge: 21,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(invitedBy(state), [BOB_ID], "the 19-year-old must not receive an invitation to a 21+ meetup");
      assert.deepEqual(bodyOf(r).ageIneligible, [CAROL_ID]);
    } finally { await s.close(); }
  });

  it("A3. a VERIFIED MINOR with an adult typed birthday is NOT invited into an 18+ meetup", async () => {
    const state = ageState({
      identity_verifications: [{ user_id: BOB_ID, is_over_18: false, created_at: NOW }],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "18+ night", visibility: "invitees", inviteeIds: [BOB_ID], ageLimitEnabled: true, minAge: 18,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(invitedBy(state), [], "a provider result saying 'not over 18' outranks the typed date of birth");
      assert.deepEqual(bodyOf(r).ageIneligible, [BOB_ID]);
    } finally { await s.close(); }
  });

  it("A4. CONTROL — with no age limit the same friends are all invited", async () => {
    const state = ageState();
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "Coffee", visibility: "invitees", inviteeIds: [BOB_ID, CAROL_ID],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(invitedBy(state).sort(), [BOB_ID, CAROL_ID].sort());
    } finally { await s.close(); }
  });

  it("A5. an UNREADABLE identity_verifications invites nobody on an age-limited meetup (unknown is not 'adult')", async () => {
    const state = ageState({ readErrors: { identity_verifications: { code: "57014", message: "statement timeout" } } });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "21+ tasting", visibility: "invitees", inviteeIds: [BOB_ID], ageLimitEnabled: true, minAge: 21,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(invitedBy(state), []);
    } finally { await s.close(); }
  });

  it("A6. an unreadable user_friendships invites nobody AND says so (it used to answer 201 with no inviteErrors)", async () => {
    const state = ageState({ readErrors: { user_friendships: { code: "57014", message: "statement timeout" } } });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, "/api/meetups", "alice-tok", {
        title: "Coffee", visibility: "invitees", inviteeIds: [BOB_ID],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(invitedBy(state), []);
      assert.ok((bodyOf(r).inviteErrors ?? []).length > 0,
        `an invitation that was not sent because a read failed must be reported: ${JSON.stringify(r.body)}`);
    } finally { await s.close(); }
  });
});

describe("census-trust §31 — POST /api/meetups/:id/invites does not call real friends ineligible on a failed read", () => {
  it("I1. an unreadable user_friendships answers 503, not 403 'none of the provided users are eligible'", async () => {
    const state = ageState({
      meetups: [makeMeetup()],
      readErrors: { user_friendships: { code: "57014", message: "statement timeout" } },
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/invites`, "alice-tok", { userIds: [BOB_ID] });
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(bodyOf(r).error, "degraded_unavailable");
      assert.deepEqual(invitedBy(state), []);
    } finally { await s.close(); }
  });

  it("I2. CONTROL — a readable non-friend is still refused as out of scope", async () => {
    const state = ageState({ meetups: [makeMeetup()], user_friendships: [] });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/invites`, "alice-tok", { userIds: [BOB_ID] });
      assert.equal(r.status, 403, JSON.stringify(r.body));
    } finally { await s.close(); }
  });

  it("I3. CONTROL — the /invites age pre-check still withholds an under-age friend", async () => {
    const state = ageState({ meetups: [makeMeetup({ age_limit_enabled: true, min_age: 21, max_age: null })] });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/invites`, "alice-tok", { userIds: [BOB_ID, CAROL_ID] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(bodyOf(r).invited, [BOB_ID]);
      assert.deepEqual(bodyOf(r).ageIneligible, [CAROL_ID]);
    } finally { await s.close(); }
  });
});

// ── GET /api/meetups/:meetupId ────────────────────────────────────────────────

describe("GET /api/meetups/:meetupId", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, `/api/meetups/${MEETUP_ID}`);
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("returns 404 when meetup not found", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, `/api/meetups/${MEETUP_ID}`, "alice-tok");
      assert.equal(r.status, 404);
    } finally { await s.close(); }
  });

  it("returns meetup for creator", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_invites: [],
      meetup_time_options: [],
      meetup_time_votes: [],
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, `/api/meetups/${MEETUP_ID}`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.id, MEETUP_ID);
      assert.equal(r.body.isCreator, true);
      assert.ok(Array.isArray(r.body.timeOptions));
      assert.ok(r.body.counts);
    } finally { await s.close(); }
  });

  it("returns meetup for direct invitee", async () => {
    const state = baseState({
      meetups: [makeMeetup({ creator_id: BOB_ID })],
      meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
      meetup_time_options: [],
      meetup_time_votes: [],
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, `/api/meetups/${MEETUP_ID}`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.isCreator, false);
      assert.equal(r.body.myRsvp, "pending");
    } finally { await s.close(); }
  });

  it("returns time options with vote tallies", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_invites: [],
      meetup_time_options: [makeTimeOption()],
      meetup_time_votes: [
        { option_id: OPT_ID, user_id: ALICE_ID, vote: "yes" },
        { option_id: OPT_ID, user_id: BOB_ID,   vote: "maybe" },
      ],
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, `/api/meetups/${MEETUP_ID}`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.timeOptions.length, 1);
      const opt = r.body.timeOptions[0];
      assert.equal(opt.votes.yes, 1);
      assert.equal(opt.votes.maybe, 1);
      assert.equal(opt.votes.no, 0);
      assert.equal(opt.votes.myVote, "yes"); // alice voted yes
    } finally { await s.close(); }
  });
});

// ── DELETE /api/meetups/:meetupId ─────────────────────────────────────────────

describe("DELETE /api/meetups/:meetupId", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/meetups/${MEETUP_ID}`, { method: "DELETE" });
      assert.equal(res.status, 401);
    } finally { await s.close(); }
  });

  it("returns 403 when non-creator tries to cancel", async () => {
    const state = baseState({ meetups: [makeMeetup({ creator_id: BOB_ID })] });
    const s = await startServer(state);
    try {
      const r = await httpDelete(s.port, `/api/meetups/${MEETUP_ID}`, "alice-tok");
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("creator can cancel meetup", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: BOB_ID, status: "pending" }],
    });
    const s = await startServer(state);
    try {
      const r = await httpDelete(s.port, `/api/meetups/${MEETUP_ID}`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
    } finally { await s.close(); }
  });
});

// ── POST /api/meetups/:meetupId/rsvp ─────────────────────────────────────────

describe("POST /api/meetups/:meetupId/rsvp", () => {
  it("rejects invalid status", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/rsvp`, "alice-tok", { status: "attending" });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("creator can RSVP going", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_invites: [],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/rsvp`, "alice-tok", { status: "going" });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "going");
      assert.ok(r.body.counts);
    } finally { await s.close(); }
  });

  it("invitee can RSVP maybe", async () => {
    const state = baseState({
      meetups: [makeMeetup({ creator_id: BOB_ID })],
      meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/rsvp`, "alice-tok", { status: "maybe" });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "maybe");
    } finally { await s.close(); }
  });

  it("returns 404 for unknown meetup", async () => {
    const s = await startServer(baseState());
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/rsvp`, "alice-tok", { status: "going" });
      assert.equal(r.status, 404);
    } finally { await s.close(); }
  });
});

// ── POST /api/meetups/:meetupId/time-options ──────────────────────────────────

describe("POST /api/meetups/:meetupId/time-options", () => {
  it("rejects non-creator", async () => {
    const state = baseState({ meetups: [makeMeetup({ creator_id: BOB_ID })] });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/time-options`, "alice-tok", { proposedDate: "2026-08-01" });
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("rejects bad date format", async () => {
    const state = baseState({ meetups: [makeMeetup()] });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/time-options`, "alice-tok", { proposedDate: "not-a-date" });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("rejects missing proposedDate", async () => {
    const state = baseState({ meetups: [makeMeetup()] });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/time-options`, "alice-tok", { timeBlock: "evening" });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("creates time option for creator", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_time_options: [makeTimeOption()],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/time-options`, "alice-tok", {
        proposedDate: "2026-08-01",
        timeBlock: "evening",
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.proposedDate, "2026-08-01");
      assert.equal(r.body.timeBlock, "evening");
      assert.equal(r.body.confirmed, false);
    } finally { await s.close(); }
  });
});

// ── POST /api/meetups/:meetupId/time-options/:optionId/vote ───────────────────

describe("POST /api/meetups/:id/time-options/:optId/vote", () => {
  it("rejects invalid vote value", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_invites: [],
      meetup_time_options: [makeTimeOption()],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/time-options/${OPT_ID}/vote`, "alice-tok", { vote: "unsure" });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("creator can vote yes on own meetup", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      meetup_invites: [],
      meetup_time_options: [makeTimeOption()],
      meetup_time_votes: [{ option_id: OPT_ID, user_id: ALICE_ID, vote: "yes" }],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/time-options/${OPT_ID}/vote`, "alice-tok", { vote: "yes" });
      assert.equal(r.status, 200);
      assert.equal(r.body.optionId, OPT_ID);
      assert.ok("yes" in r.body.votes);
      assert.ok("maybe" in r.body.votes);
      assert.ok("no" in r.body.votes);
    } finally { await s.close(); }
  });

  it("invitee can vote maybe", async () => {
    const state = baseState({
      meetups: [makeMeetup({ creator_id: BOB_ID })],
      meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
      meetup_time_options: [makeTimeOption()],
      meetup_time_votes: [{ option_id: OPT_ID, user_id: ALICE_ID, vote: "maybe" }],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/time-options/${OPT_ID}/vote`, "alice-tok", { vote: "maybe" });
      assert.equal(r.status, 200);
      assert.equal(r.body.votes.maybe, 1);
    } finally { await s.close(); }
  });
});

// ── POST /api/meetups/:meetupId/add-to-trip-plan ──────────────────────────────

describe("POST /api/meetups/:meetupId/add-to-trip-plan", () => {
  it("rejects missing tripId body", async () => {
    const s = await startServer(baseState());
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/add-to-trip-plan`, "alice-tok", {});
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("rejects non-trip-members", async () => {
    const state = baseState({
      meetups: [makeMeetup()],
      trips: [{ id: TRIP_ID, owner_id: BOB_ID, plan_edit_permission: "all_members" }],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/add-to-trip-plan`, "alice-tok", { tripId: TRIP_ID });
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("rejects when meetup is scoped to a different trip", async () => {
    const OTHER_TRIP = "00000000-0000-0000-0000-000000000099";
    const state = baseState({
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
      trips: [{ id: TRIP_ID, owner_id: ALICE_ID, plan_edit_permission: "all_members" }],
      meetups: [makeMeetup({ trip_id: OTHER_TRIP, visibility: "trip" })],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/add-to-trip-plan`, "alice-tok", { tripId: TRIP_ID });
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("creates plan item for trip owner", async () => {
    const state = baseState({
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
      trips: [{ id: TRIP_ID, owner_id: ALICE_ID, plan_edit_permission: "all_members" }],
      meetups: [makeMeetup()],
      trip_plan_items: [],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/add-to-trip-plan`, "alice-tok", { tripId: TRIP_ID });
      assert.equal(r.status, 201);
      assert.equal(r.body.tripId, TRIP_ID);
      assert.equal(r.body.sourceType, "meetup");
      assert.equal(r.body.sourceId, MEETUP_ID);
    } finally { await s.close(); }
  });

  it("duplicate — returns 409 if already added", async () => {
    const state = baseState({
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
      trips: [{ id: TRIP_ID, owner_id: ALICE_ID, plan_edit_permission: "all_members" }],
      meetups: [makeMeetup()],
      trip_plan_items: [{
        id: "plan-1", trip_id: TRIP_ID, source_type: "meetup", source_id: MEETUP_ID,
        title: "Test meetup", removed_at: null,
      }],
    });
    const s = await startServer(state);
    try {
      const r = await httpPost(s.port, `/api/meetups/${MEETUP_ID}/add-to-trip-plan`, "alice-tok", { tripId: TRIP_ID });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "duplicate");
    } finally { await s.close(); }
  });
});

// ── GET /api/me/meetup-invites ────────────────────────────────────────────────

describe("GET /api/me/meetup-invites", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, "/api/me/meetup-invites");
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("returns empty list when no invites", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, "/api/me/meetup-invites", "alice-tok");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.invites, []);
    } finally { await s.close(); }
  });

  it("returns pending invite with meetup info", async () => {
    const state = baseState({
      meetup_invites: [{
        id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID,
        status: "pending", invited_at: NOW,
      }],
      meetups: [makeMeetup({ creator_id: BOB_ID })],
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, "/api/me/meetup-invites", "alice-tok");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.invites));
      assert.equal(r.body.invites.length, 1);
      assert.equal(r.body.invites[0].meetupId, MEETUP_ID);
      assert.equal(r.body.invites[0].status, "pending");
    } finally { await s.close(); }
  });
});
