/**
 * P0 — the Rent-a-Buddy block gate must fail CLOSED.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `enforceBookingCreationGates` (routes/rentABuddy.ts) and the shorthand alias
 * `POST /rent-a-buddy/buddies/:buddyId/request` (routes/rentABuddySpec.ts) each
 * hand-rolled the block check as two `maybeSingle()` reads and looked only at
 * `.data`:
 *
 *     const [a, b] = await Promise.all([...maybeSingle(), ...maybeSingle()]);
 *     if (a.data || b.data) return 403;
 *
 * supabase-js RESOLVES (it does not reject) when PostgREST returns an error, so
 * on ANY blocks-table failure both `.data` were null, the `if` was false, and a
 * `rent_buddy_bookings` row was INSERTED — arranging a PHYSICAL meeting between
 * two people where one may have blocked the other. Both clients here are
 * service-role, so RLS is not a backstop behind the check.
 *
 * Both sites now call the canonical fail-closed helper `isBlockedBetween`
 * (lib/blockGuard.ts), which returns TRUE on a read error.
 *
 * The decisive assertion is not the status code but the INSERT: every test that
 * expects a refusal also asserts that `rent_buddy_bookings` received nothing,
 * and a positive control proves the fixture really does reach the insert when
 * the block state reads clean. Without that control a "no insert" assertion
 * would pass on any fixture that never got near the insert.
 *
 * Run: node --import tsx/esm --test src/test/blockGateFailClosedBooking.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter, { enforceBookingCreationGates } from "../routes/rentABuddy.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";
import { KYC_OVERRIDE_FLAG } from "../lib/rentBuddyKycGate.js";

const USER_TOKEN = "bfc-user-token";
const USER_ID = "bfc-user-1";
const BUDDY_PROF_ID = "bfc-buddy-profile-1";
const BUDDY_USER_ID = "bfc-buddy-user-1";

interface BlockRow { blocker_id: string; blocked_id: string }

interface State {
  flags: Record<string, boolean>;
  /** Make every `blocks` read fail, as PostgREST does (resolved, not thrown). */
  blocksError: boolean;
  blockRows: BlockRow[];
  /** Every INSERT the route attempted, by table. */
  inserts: Array<{ table: string; row: any }>;
}

let state: State;

function baseFlags(): Record<string, boolean> {
  return {
    rent_buddy_enabled: true,
    // The KYC gate is hard-closed in every environment (no identity provider is
    // operational); without this override the routes 503 before the block gate
    // is ever consulted and the test would prove nothing.
    [KYC_OVERRIDE_FLAG]: true,
  };
}

/**
 * Minimal but HONEST PostgREST filter model for the `blocks` table: eq() chains
 * and the two `or()` shapes these call sites build. `maybeSingle()` reproduces
 * the real PGRST116 ">1 row" rejection, and `limit(n)` really truncates — so a
 * revert of either half of the fix is observable here.
 */
function matchesOrFilter(row: BlockRow, expr: string): boolean {
  const terms: string[] = [];
  let depth = 0, cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { terms.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) terms.push(cur);

  const evalLeaf = (leaf: string): boolean => {
    const m = /^([a-z_]+)\.eq\.(.+)$/.exec(leaf.trim());
    if (!m) return false;
    return String((row as any)[m[1]]) === m[2];
  };

  return terms.some((t) => {
    const trimmed = t.trim();
    const and = /^and\((.*)\)$/.exec(trimmed);
    if (and) return and[1].split(",").every(evalLeaf);
    return evalLeaf(trimmed);
  });
}

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, any]>,
      _or: null as string | null,
      _limit: null as number | null,
      _single: false,
      select() { return this; },
      insert(row: any) { state.inserts.push({ table: this._table, row }); return this; },
      update() { return this; },
      upsert() { return this; },
      delete() { return this; },
      eq(c: string, v: any) { this._filters.push([c, v]); return this; },
      neq() { return this; }, is() { return this; }, in() { return this; },
      gte() { return this; }, lte() { return this; }, lt() { return this; }, gt() { return this; },
      not() { return this; },
      ilike() { return this; }, contains() { return this; },
      or(expr: string) { this._or = expr; return this; },
      limit(n: number) { this._limit = n; return this; },
      order() { return this; },
      maybeSingle() { this._single = true; return this; },
      single() { this._single = true; return this; },
      async then(resolve: (v: any) => void) { const r = await this._resolve(); resolve(r); return r; },
      async _resolve(): Promise<any> {
        if (this._table === "blocks") {
          if (state.blocksError) {
            return { data: null, error: { code: "57014", message: "simulated blocks read failure" } };
          }
          let rows = state.blockRows.filter((r) =>
            this._filters.every(([c, v]) => String((r as any)[c]) === String(v)),
          );
          if (this._or) rows = rows.filter((r) => matchesOrFilter(r, this._or!));
          if (this._limit != null) rows = rows.slice(0, this._limit);
          if (this._single) {
            // Real PostgREST behaviour: maybeSingle() REJECTS on >1 row.
            if (rows.length > 1) {
              return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple rows returned" } };
            }
            return { data: rows[0] ?? null, error: null };
          }
          return { data: rows, error: null };
        }
        if (this._table === "feature_flags") {
          const flag = this._filters.find(([c]) => c === "flag")?.[1] as string;
          const enabled = state.flags[flag];
          return { data: enabled === undefined ? null : { flag, enabled }, error: null };
        }
        if (this._table === "profiles") {
          const id = this._filters.find(([c]) => c === "id")?.[1];
          return {
            data: id ? { id, role: "user", date_of_birth: "1990-01-01", id_verified: true, phone_verified: true } : null,
            error: null,
          };
        }
        if (this._table === "rent_buddy_profiles") {
          // Filter-aware: the traveler must NOT have a buddy profile of their
          // own, or the self-booking guard fires before the block gate.
          const wantUser = this._filters.find(([c]) => c === "user_id")?.[1];
          const wantId = this._filters.find(([c]) => c === "id")?.[1];
          const buddy = {
            id: BUDDY_PROF_ID, user_id: BUDDY_USER_ID, status: "active", admin_status: "active",
            verified: true, categories: ["city"], city: "Bangkok", country: "Thailand",
            hourly_rate_usd: 30, buddy_level: "new", verification_status: "verified",
            id_verified: true, phone_verified: true, category_approvals: { city: true },
          };
          const hit =
            (wantUser !== undefined && wantUser !== BUDDY_USER_ID) ? null :
            (wantId !== undefined && wantId !== BUDDY_PROF_ID) ? null :
            buddy;
          return this._single
            ? { data: hit, error: null }
            : { data: hit ? [hit] : [], count: hit ? 1 : 0, error: null };
        }
        if (this._table === "rent_buddy_city_rollouts") {
          // "public_mvp" is the only status that lets a booking through; without
          // it the routes stop at `city_not_available` long before the block gate.
          return this._single
            ? { data: { id: "bfc-rollout-1", status: "public_mvp" }, error: null }
            : { data: [], error: null };
        }
        if (this._table === "rent_buddy_bookings" && state.inserts.some((i) => i.table === "rent_buddy_bookings")) {
          // insert(...).select().single() — hand back a plausible created row.
          return { data: { id: "bfc-booking-1", status: "pending" }, error: null };
        }
        if (this._single) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }
  return {
    from: (t: string) => fakeTable(t),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async (token: string) =>
        token === USER_TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

function fakeRes() {
  const rec: { status: number | null; body: any } = { status: null, body: null };
  const res: any = {
    status(code: number) { rec.status = code; return res; },
    json(payload: any) { rec.body = payload; return res; },
  };
  return { res, rec };
}

// ── HTTP harness ─────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${USER_TOKEN}` },
      },
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
    r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddyRouter);
  app.use("/api", rentABuddySpecRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = { flags: baseFlags(), blocksError: false, blockRows: [], inserts: [] };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

const bookingsInserted = () => state.inserts.filter((i) => i.table === "rent_buddy_bookings");

const gateOpts = (sc: any, res: any) => ({
  sc, res,
  userId: USER_ID,
  buddyProfile: {
    id: BUDDY_PROF_ID, user_id: BUDDY_USER_ID, country: "Thailand",
    verification_status: "verified", id_verified: true, phone_verified: true,
    category_approvals: { city: true },
  },
  city: "Bangkok",
  countryCode: "Thailand",
  category: "city",
  applyKillSwitch: false,
});

// ── 1. The shared creation gate ──────────────────────────────────────────────

describe("enforceBookingCreationGates — block check fails closed", () => {
  it("refuses the booking when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const client = makeClient();
    const { res, rec } = fakeRes();

    const ok = await enforceBookingCreationGates(gateOpts(client, res) as any);

    assert.equal(ok, false, "an unreadable blocks table must refuse the booking");
    assert.equal(rec.status, 403, JSON.stringify(rec.body));
    assert.equal(rec.body.error, "blocked");
  });

  it("refuses the booking when a real block row exists", async () => {
    state.blockRows = [{ blocker_id: BUDDY_USER_ID, blocked_id: USER_ID }];
    const client = makeClient();
    const { res, rec } = fakeRes();

    const ok = await enforceBookingCreationGates(gateOpts(client, res) as any);

    assert.equal(ok, false);
    assert.equal(rec.body.error, "blocked");
  });

  it("refuses the booking on a MUTUAL block (two rows)", async () => {
    // The strongest block state. It must not read as "not blocked" — the shape
    // that made maybeSingle() raise PGRST116 at other call sites.
    state.blockRows = [
      { blocker_id: BUDDY_USER_ID, blocked_id: USER_ID },
      { blocker_id: USER_ID, blocked_id: BUDDY_USER_ID },
    ];
    const client = makeClient();
    const { res, rec } = fakeRes();

    const ok = await enforceBookingCreationGates(gateOpts(client, res) as any);

    assert.equal(ok, false, "a mutual block must refuse the booking");
    assert.equal(rec.body.error, "blocked");
  });

  it("does NOT answer 'blocked' when the blocks table reads clean and empty", async () => {
    // Negative control: the three assertions above must be attributable to the
    // block gate, not to some other gate that refuses everything.
    const client = makeClient();
    const { res, rec } = fakeRes();

    await enforceBookingCreationGates(gateOpts(client, res) as any);

    assert.notEqual(rec.body?.error, "blocked",
      `with no blocks the gate must not answer 'blocked' (got ${rec.status} ${JSON.stringify(rec.body)})`);
  });
});

// ── 2. The shorthand alias — the INSERT assertion ────────────────────────────

describe("POST /rent-a-buddy/buddies/:buddyId/request — no booking row on unknown block state", () => {
  const body = {
    bookingDate: "2099-01-01", durationH: 2, city: "Bangkok",
    category: "city", groupSize: 1, paymentMode: "full_in_app",
  };

  it("POSITIVE CONTROL: inserts a rent_buddy_bookings row when blocks read clean", async () => {
    // Without this, "no row was inserted" below would pass on a fixture that
    // never reaches the insert at all.
    const r = await post(`/api/rent-a-buddy/buddies/${BUDDY_PROF_ID}/request`, body);
    assert.equal(bookingsInserted().length, 1,
      `fixture must reach the INSERT on the happy path (got ${r.status} ${JSON.stringify(r.body)})`);
  });

  it("refuses AND inserts nothing when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await post(`/api/rent-a-buddy/buddies/${BUDDY_PROF_ID}/request`, body);

    assert.ok(r.status >= 400, `expected a 4xx/5xx refusal, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "blocked");
    assert.equal(bookingsInserted().length, 0,
      "NO rent_buddy_bookings row may be inserted while block state is unknown");
  });

  it("refuses AND inserts nothing on a MUTUAL block", async () => {
    state.blockRows = [
      { blocker_id: BUDDY_USER_ID, blocked_id: USER_ID },
      { blocker_id: USER_ID, blocked_id: BUDDY_USER_ID },
    ];
    const r = await post(`/api/rent-a-buddy/buddies/${BUDDY_PROF_ID}/request`, body);

    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, "blocked");
    assert.equal(bookingsInserted().length, 0);
  });
});

// ── 3. The canonical route ───────────────────────────────────────────────────

describe("POST /rent-a-buddy/bookings — block check fails closed", () => {
  const body = {
    buddyId: BUDDY_PROF_ID, city: "Bangkok", category: "city",
    bookingDate: "2099-01-01", durationH: 2, groupSize: 1,
  };

  it("returns 403 blocked and inserts nothing when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await post("/api/rent-a-buddy/bookings", body);

    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, "blocked");
    assert.equal(bookingsInserted().length, 0,
      "NO rent_buddy_bookings row may be inserted while block state is unknown");
  });

  it("does not answer 'blocked' when the blocks table reads clean", async () => {
    const r = await post("/api/rent-a-buddy/bookings", body);
    assert.notEqual(r.body?.error, "blocked",
      `negative control (got ${r.status} ${JSON.stringify(r.body)})`);
  });
});
