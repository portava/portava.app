/**
 * Rent-a-Buddy — signals that were read by production code and written by nothing.
 *
 * Three defects of one shape, plus the route shadow that hid a fourth:
 *
 *   response_time_h   scored by the buddy-search ranker (+15 / +10 / +5 at
 *                     0.5h / 1h / 4h, routes/rentABuddy.ts scoreProfile) and
 *                     never written outside src/scripts/seed-demo-buddies.ts.
 *                     NULL for every real buddy => `Number(null ?? Infinity)`
 *                     => 0 points for everyone => not a ranking signal at all.
 *
 *   profile_views     surfaced to the buddy as `profileViews` on
 *                     GET /rent-a-buddy/me/dashboard and never incremented.
 *                     (The `profile_views` TABLE routes/profile.ts writes is a
 *                     different object and does not touch this column.)
 *
 *   DELETE /rent-a-buddy/waitlist/:waitlistId
 *                     declared by rentABuddyMarketplace but unreachable:
 *                     rentABuddy mounts DELETE /rent-a-buddy/waitlist/:city
 *                     first, so a uuid was compared against the `city` column,
 *                     deleted 0 rows and returned { ok: true } — silent success
 *                     while the entry stayed on the waitlist.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyDeadSignals.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import rentABuddyMarketplaceRouter from "../routes/rentABuddyMarketplace.js";
import {
  hoursSince,
  recordBuddyResponseTime,
} from "../services/rentBuddy/ReliabilityCounters.js";

// ── Identities ───────────────────────────────────────────────────────────────

const TRAVELER_TOKEN = "ds-traveler-token";
const BUDDY_TOKEN    = "ds-buddy-token";
const TRAVELER_ID    = "ds-traveler-user-1";
const BUDDY_USER_ID  = "ds-buddy-user-1";
const BUDDY_PROF_ID  = "ds-buddy-profile-1";
const BOOKING_ID     = "ds-booking-1";
/** Real uuid shape — the point of the route-shadow case. */
const WAITLIST_ID    = "3f2a1c4e-9b7d-4e21-8c55-0a1b2c3d4e5f";

const ADMIN_TOKEN    = "ds-admin-token";
const ADMIN_ID       = "ds-admin-user-1";

const TOKEN_MAP: Record<string, string> = {
  [TRAVELER_TOKEN]: TRAVELER_ID,
  [BUDDY_TOKEN]:    BUDDY_USER_ID,
  [ADMIN_TOKEN]:    ADMIN_ID,
};

// ── Fake state ───────────────────────────────────────────────────────────────

interface DSState {
  profiles: Record<string, any>;
  buddyProfiles: Record<string, any>;
  bookings: Record<string, any>;
  waitlist: any[];
  rpcCalls: Array<[string, any]>;
  bookingEvents: any[];
  profileUpdates: Array<Record<string, unknown>>;
}

let state: DSState;
let now: number;

function freshState(): DSState {
  return {
    profiles: {
      [ADMIN_ID]:    { id: ADMIN_ID,    role: "admin" },
      [TRAVELER_ID]: { id: TRAVELER_ID, role: "user" },
      [BUDDY_USER_ID]: { id: BUDDY_USER_ID, role: "user" },
    },
    buddyProfiles: {
      [BUDDY_PROF_ID]: {
        id: BUDDY_PROF_ID,
        user_id: BUDDY_USER_ID,
        status: "active",
        admin_status: "active",
        city: "Bangkok",
        response_time_h: null,
        profile_views: 0,
        // The column defaults, as every real buddy carries them: nothing in
        // src/ ever wrote any of the three.
        verified: false,
        verified_at: null,
        verification_status: "unverified",
        id_verified: false,
      },
    },
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id: BUDDY_PROF_ID,
        status: "requested",
        booking_date: "2099-01-01",
        start_time: "10:00",
        duration_h: 2,
        // Requested exactly two hours before `now` — the sample the response
        // writer must record. Derived from `now`, never hard-coded, so the
        // assertion below pins the VALUE and not merely "something was written".
        created_at: new Date(now - 2 * 3_600_000).toISOString(),
      },
    },
    waitlist: [
      { id: WAITLIST_ID, user_id: TRAVELER_ID, city: "Bangkok", category: null, status: "active" },
      { id: "ds-wl-2", user_id: TRAVELER_ID, city: "Tokyo", category: null, status: "active" },
    ],
    rpcCalls: [],
    bookingEvents: [],
    profileUpdates: [],
  };
}

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insert: null as any,
      _update: null as any,
      _upsert: null as any,
      _delete: false,
      _single: false,

      select() { return this; },
      insert(d: any) { this._insert = d; return this; },
      update(d: any) { this._update = d; return this; },
      upsert(d: any) { this._upsert = d; return this; },
      delete() { this._delete = true; return this; },
      eq(c: string, v: any) { this._filters.push(["eq", c, v]); return this; },
      neq(c: string, v: any) { this._filters.push(["neq", c, v]); return this; },
      is(c: string, v: any) { this._filters.push(["is", c, v]); return this; },
      in(c: string, v: any) { this._filters.push(["in", c, v]); return this; },
      gte() { return this; },
      lte() { return this; },
      ilike() { return this; },
      contains() { return this; },
      or() { return this; },
      limit() { return this; },
      order() { return this; },
      range() { return this; },
      maybeSingle() { this._single = true; return this; },
      single() { this._single = true; return this; },

      async then(resolve: (v: any) => void) {
        const r = await this._resolve();
        resolve(r);
        return r;
      },

      _match(rows: any[]): any[] {
        let out = rows;
        for (const [op, col, val] of this._filters) {
          if (op === "eq")  out = out.filter((r) => r[col] === val);
          if (op === "neq") out = out.filter((r) => r[col] !== val);
          if (op === "is")  out = out.filter((r) => (r[col] ?? null) === val);
          if (op === "in")  out = out.filter((r) => (val as any[]).includes(r[col]));
        }
        return out;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (t === "feature_flags") {
          return { data: { flag: "rent_buddy_enabled", enabled: true }, error: null };
        }

        if (this._delete) {
          if (t === "rent_buddy_waitlist") {
            const hits = this._match(state.waitlist);
            state.waitlist = state.waitlist.filter((r) => !hits.includes(r));
          }
          return { data: null, error: null };
        }

        if (this._update !== null) {
          if (t === "rent_buddy_waitlist") {
            for (const h of this._match(state.waitlist)) Object.assign(h, this._update);
            return { data: null, error: null };
          }
          if (t === "rent_buddy_profiles") {
            state.profileUpdates.push(this._update);
            for (const h of this._match(Object.values(state.buddyProfiles))) Object.assign(h, this._update);
            return { data: null, error: null };
          }
          if (t === "rent_buddy_bookings") {
            for (const h of this._match(Object.values(state.bookings))) Object.assign(h, this._update);
            return { data: null, error: null };
          }
          return { data: null, error: null };
        }

        if (this._insert !== null) {
          if (t === "buddy_booking_events") state.bookingEvents.push(this._insert);
          return { data: this._single ? { id: "gen-1", ...this._insert } : null, error: null };
        }

        if (this._upsert !== null) return { data: null, error: null };

        if (t === "profiles") {
          const hits = this._match(Object.values(state.profiles));
          return this._single
            ? { data: hits[0] ?? null, error: null }
            : { data: hits, count: hits.length, error: null };
        }

        if (t === "rent_buddy_profiles") {
          const hits = this._match(Object.values(state.buddyProfiles));
          return this._single
            ? { data: hits[0] ?? null, error: null }
            : { data: hits, count: hits.length, error: null };
        }

        if (t === "rent_buddy_bookings") {
          const hits = this._match(Object.values(state.bookings));
          return this._single
            ? { data: hits[0] ?? null, error: null }
            : { data: hits, count: hits.length, error: null };
        }

        if (t === "rent_buddy_waitlist") {
          const hits = this._match(state.waitlist);
          return this._single
            ? { data: hits[0] ?? null, error: null }
            : { data: hits, count: hits.length, error: null };
        }

        if (this._single) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (t: string) => fakeTable(t),
    // The atomic path the writers prefer. Recording the calls is how these tests
    // see a fire-and-forget write at all.
    rpc: async (fn: string, args: any) => {
      state.rpcCalls.push([fn, args]);
      if (fn === "rb_adjust_buddy_counter") {
        const p = state.buddyProfiles[args.p_buddy_id];
        if (p) p[args.p_column] = Math.max(0, Number(p[args.p_column] ?? 0) + args.p_delta);
      }
      if (fn === "rb_record_buddy_response") {
        const p = state.buddyProfiles[args.p_buddy_id];
        if (p) {
          const prev = p.response_time_h === null ? null : Number(p.response_time_h);
          p.response_time_h = prev === null
            ? args.p_hours
            : Math.round((prev * 0.7 + args.p_hours * 0.3) * 10) / 10;
        }
      }
      return { data: null, error: null };
    },
    auth: {
      getUser: async (token: string) => {
        const id = TOKEN_MAP[token];
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ── HTTP harness — routers mounted in routes/index.ts order ──────────────────

let server: http.Server;
let base: string;

function req(
  method: string, path: string, body?: unknown, token?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Fire-and-forget writes land a tick or two after the response. */
const settle = () => new Promise((r) => setTimeout(r, 25));

before(async () => {
  const app = express();
  app.use(express.json());
  // routes/index.ts order: rentABuddy BEFORE rentABuddyMarketplace. Preserved
  // here on purpose — reverse it and the route-shadow case stops meaning
  // anything.
  app.use("/api", rentABuddyRouter);
  app.use("/api", rentABuddyMarketplaceRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  now = Date.now();
  state = freshState();
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── response_time_h ──────────────────────────────────────────────────────────

describe("hoursSince", () => {
  it("returns the elapsed hours for an ISO timestamp", () => {
    const t = Date.now();
    assert.equal(hoursSince(new Date(t - 90 * 60_000).toISOString(), t), 1.5);
  });
  it("returns null for a future timestamp, a non-date, and null", () => {
    const t = Date.now();
    assert.equal(hoursSince(new Date(t + 60_000).toISOString(), t), null);
    assert.equal(hoursSince("not a date", t), null);
    assert.equal(hoursSince(null, t), null);
  });
});

describe("recordBuddyResponseTime — response_time_h finally has a writer", () => {
  it("seeds the column with the first sample, then blends subsequent ones", async () => {
    const client = makeClient();
    await recordBuddyResponseTime(client, BUDDY_PROF_ID, 4);
    assert.equal(state.buddyProfiles[BUDDY_PROF_ID].response_time_h, 4,
      "the first response must seed the column, not blend against NULL");

    await recordBuddyResponseTime(client, BUDDY_PROF_ID, 1);
    // alpha = 0.3: 4 * 0.7 + 1 * 0.3 = 3.1. Samples chosen so the blend is
    // exact at the column's one-decimal scale — a pair whose true blend lands
    // on a half (e.g. 4 then 0.5 -> 2.95) rounds differently in IEEE-754 than
    // in SQL numeric, and pinning that would pin the float artefact rather than
    // the weighting.
    assert.equal(state.buddyProfiles[BUDDY_PROF_ID].response_time_h, 3.1,
      "subsequent responses must move the mean toward the newer sample");
  });

  it("saturates at what numeric(4,1) can hold instead of overflowing", async () => {
    const client = makeClient();
    await recordBuddyResponseTime(client, BUDDY_PROF_ID, 10_000);
    assert.equal(state.rpcCalls[0][1].p_hours, 999.9);
  });

  it("ignores a negative, non-finite or missing sample", async () => {
    const client = makeClient();
    await recordBuddyResponseTime(client, BUDDY_PROF_ID, -1);
    await recordBuddyResponseTime(client, BUDDY_PROF_ID, Number.NaN);
    await recordBuddyResponseTime(client, BUDDY_PROF_ID, Number.POSITIVE_INFINITY);
    assert.equal(state.rpcCalls.length, 0);
    assert.equal(state.buddyProfiles[BUDDY_PROF_ID].response_time_h, null);
  });
});

describe("POST /rent-a-buddy/bookings/:id/accept — records the response latency", () => {
  it("writes the hours between the request and the answer", async () => {
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/accept`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    const call = state.rpcCalls.find(([fn]) => fn === "rb_record_buddy_response");
    assert.ok(call, "accept must record a response-time sample");
    assert.equal(call![1].p_buddy_id, BUDDY_PROF_ID);
    // The fixture set created_at to exactly two hours before `now`.
    assert.ok(Math.abs(call![1].p_hours - 2) < 0.05,
      `expected ~2h, got ${call![1].p_hours}`);
    assert.ok(Math.abs(Number(state.buddyProfiles[BUDDY_PROF_ID].response_time_h) - 2) < 0.05);
  });
});

describe("POST /rent-a-buddy/bookings/:id/decline — a decline is an answer too", () => {
  it("records the response latency", async () => {
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/decline`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    const call = state.rpcCalls.find(([fn]) => fn === "rb_record_buddy_response");
    assert.ok(call, "decline must record a response-time sample");
    assert.ok(Math.abs(call![1].p_hours - 2) < 0.05);
  });
});

// ── profile_views ────────────────────────────────────────────────────────────

describe("GET /rent-a-buddy/buddies/:buddyId — profile_views finally moves", () => {
  it("increments the counter for a traveller viewing the card", async () => {
    const r = await req("GET", `/api/rent-a-buddy/buddies/${BUDDY_PROF_ID}`, undefined, TRAVELER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    const call = state.rpcCalls.find(([fn, a]) => fn === "rb_adjust_buddy_counter" && a.p_column === "profile_views");
    assert.ok(call, "a viewed buddy card must increment profile_views");
    assert.equal(call![1].p_buddy_id, BUDDY_PROF_ID);
    assert.equal(call![1].p_delta, 1);
    assert.equal(state.buddyProfiles[BUDDY_PROF_ID].profile_views, 1);
  });

  it("counts an anonymous viewer — real traffic, no session", async () => {
    await req("GET", `/api/rent-a-buddy/buddies/${BUDDY_PROF_ID}`);
    await settle();
    assert.equal(state.buddyProfiles[BUDDY_PROF_ID].profile_views, 1);
  });

  it("does NOT count the buddy opening their own card", async () => {
    const r = await req("GET", `/api/rent-a-buddy/buddies/${BUDDY_PROF_ID}`, undefined, BUDDY_TOKEN);
    assert.equal(r.status, 200);
    await settle();
    assert.equal(
      state.rpcCalls.filter(([fn, a]) => fn === "rb_adjust_buddy_counter" && a.p_column === "profile_views").length,
      0,
      "a self-view is not a profile view",
    );
    assert.equal(state.buddyProfiles[BUDDY_PROF_ID].profile_views, 0);
  });

  it("does not count a view of a suspended profile", async () => {
    // `status` — not admin_status. admin_status is absent from
    // BUDDY_PUBLIC_COLUMNS, so a guard on it would be permanently false and this
    // test would pass against a fake that ignores the column projection.
    state.buddyProfiles[BUDDY_PROF_ID].status = "suspended";
    await req("GET", `/api/rent-a-buddy/buddies/${BUDDY_PROF_ID}`, undefined, TRAVELER_TOKEN);
    await settle();
    assert.equal(state.buddyProfiles[BUDDY_PROF_ID].profile_views, 0);
  });

  it("does not increment for a buddy id that does not exist", async () => {
    await req("GET", `/api/rent-a-buddy/buddies/no-such-buddy`, undefined, TRAVELER_TOKEN);
    await settle();
    assert.equal(state.rpcCalls.length, 0);
  });
});

// ── the shadowed waitlist route ──────────────────────────────────────────────

describe("DELETE /rent-a-buddy/waitlist/:param — the uuid form is reachable again", () => {
  it("a uuid reaches the by-id handler and cancels that entry", async () => {
    const r = await req("DELETE", `/api/rent-a-buddy/waitlist/${WAITLIST_ID}`, undefined, TRAVELER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const entry = state.waitlist.find((w) => w.id === WAITLIST_ID);
    assert.ok(entry, "the by-id handler soft-cancels; the row must still exist");
    assert.equal(entry.status, "cancelled",
      "a uuid was swallowed by the :city handler and cancelled nothing");
    // The sibling city entry is untouched.
    assert.equal(state.waitlist.find((w) => w.id === "ds-wl-2").status, "active");
  });

  it("a city name still reaches the by-city handler and removes that row", async () => {
    const r = await req("DELETE", `/api/rent-a-buddy/waitlist/Bangkok`, undefined, TRAVELER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(state.waitlist.find((w) => w.city === "Bangkok"), undefined,
      "the by-city delete must still work");
    assert.ok(state.waitlist.find((w) => w.city === "Tokyo"), "other cities untouched");
  });

  it("a url-encoded multi-word city is still treated as a city", async () => {
    state.waitlist.push({ id: "ds-wl-3", user_id: TRAVELER_ID, city: "Fort Lauderdale", status: "active" });
    const r = await req("DELETE", `/api/rent-a-buddy/waitlist/${encodeURIComponent("Fort Lauderdale")}`, undefined, TRAVELER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(state.waitlist.find((w) => w.city === "Fort Lauderdale"), undefined);
  });
});

describe("GET /rent-a-buddy/waitlist — a cancelled entry stops being listed", () => {
  it("omits cancelled rows so the soft cancel is observable", async () => {
    await req("DELETE", `/api/rent-a-buddy/waitlist/${WAITLIST_ID}`, undefined, TRAVELER_TOKEN);
    const list = await req("GET", "/api/rent-a-buddy/waitlist", undefined, TRAVELER_TOKEN);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const ids = (list.body.waitlist ?? []).map((w: any) => w.id);
    assert.ok(!ids.includes(WAITLIST_ID), "a cancelled entry must not still be listed");
    assert.ok(ids.includes("ds-wl-2"), "active entries must still be listed");
  });
});

// ── verification_status / verified / verified_at ─────────────────────────────

describe("PATCH /rent-a-buddy/admin/users/:userId/verification — the verification signal", () => {
  /**
   * `verification_status` is read as a gate in five places: the search ranker's
   * +20, the `?verified=true` search filter, the high-risk two-sided booking
   * check, and rentABuddySpec's `needsVerification` 422. The legacy boolean
   * `verified` backs a marketplace section filter. NOTHING in src/ wrote any of
   * them, so every buddy sat at the column default 'unverified' forever: the
   * +20 was never awarded to anyone, both filters returned empty, and the
   * high-risk surface refused every buddy.
   *
   * The DB trigger meant to close this (BEFORE UPDATE OF verified) fires only on
   * a write to `verified`, which also never happened.
   */
  it("an admin setting idVerified moves verification_status, verified and verified_at together", async () => {
    const r = await req(
      "PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER_ID}/verification`,
      { idVerified: true, note: "manual ID check" }, ADMIN_TOKEN,
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const p = state.buddyProfiles[BUDDY_PROF_ID];
    assert.equal(p.id_verified, true);
    assert.equal(p.verification_status, "verified",
      "the enum every gate actually reads must move with the admin decision");
    assert.equal(p.verified, true, "the legacy boolean backs a marketplace filter");
    assert.ok(typeof p.verified_at === "string" && p.verified_at.length > 0);
  });

  it("revoking it puts all three back", async () => {
    await req("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER_ID}/verification`,
      { idVerified: true }, ADMIN_TOKEN);
    await req("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER_ID}/verification`,
      { idVerified: false }, ADMIN_TOKEN);

    const p = state.buddyProfiles[BUDDY_PROF_ID];
    assert.equal(p.id_verified, false);
    assert.equal(p.verification_status, "unverified");
    assert.equal(p.verified, false);
    assert.equal(p.verified_at, null);
  });

  it("a phone-only override leaves the verification status alone", async () => {
    const r = await req("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER_ID}/verification`,
      { phoneVerified: true }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = state.buddyProfiles[BUDDY_PROF_ID];
    assert.equal(p.phone_verified, true);
    assert.equal(p.verification_status, "unverified",
      "phone verification is not identity verification");
    assert.equal(p.verified, false);
  });

  it("a buddy cannot verify themselves through this route", async () => {
    const r = await req("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER_ID}/verification`,
      { idVerified: true }, BUDDY_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    const p = state.buddyProfiles[BUDDY_PROF_ID];
    assert.equal(p.verification_status, "unverified");
    assert.equal(p.verified, false);
    assert.equal(state.profileUpdates.length, 0, "no write may precede the admin check");
  });

  it("a traveller cannot verify a buddy either", async () => {
    const r = await req("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER_ID}/verification`,
      { idVerified: true }, TRAVELER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(state.profileUpdates.length, 0);
  });
});
