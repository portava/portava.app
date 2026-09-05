/**
 * Rent-a-Buddy booking kill switches — both names, both call sites.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * A measured audit replaced BOTH booking kill-switch call sites with
 * `if (false)` and four Rent-a-Buddy suites stayed green: the switches were not
 * load-bearing in any test. They are the lever an operator pulls when something
 * has gone wrong with strangers meeting in person, and nothing proved they
 * still worked.
 *
 * Two names are honoured deliberately (`FL-06`: `disable_rab_bookings` was once
 * an orphan with no reader, so that admin toggle was a silent no-op). Either
 * one alone must stop bookings, so each is asserted on its own — an assertion
 * that only ever engages both would pass with one reader deleted.
 *
 * Two call sites carry them:
 *   1. `enforceBookingCreationGates(..., applyKillSwitch: true)` — the shared
 *      gate the rebook and marketplace creation paths run.
 *   2. `POST /rent-a-buddy/bookings` inline — the canonical route, which runs
 *      the pair itself and so passes `applyKillSwitch: false` later.
 * Both are covered, because a test of one is no evidence about the other.
 *
 * ── FAIL-CLOSED ─────────────────────────────────────────────────────────────
 * `isKillSwitchEngaged` returns TRUE when the flag read errors ("state unknown
 * → treat as stopped"). The error case is asserted too: a fail-closed gate that
 * silently became fail-open is the failure mode that matters.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyBookingKillSwitch.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter, { enforceBookingCreationGates } from "../routes/rentABuddy.js";
import { KYC_OVERRIDE_FLAG } from "../lib/rentBuddyKycGate.js";

const KILL_SWITCH_FLAGS = ["disable_rent_buddy_booking", "disable_rab_bookings"] as const;

const USER_TOKEN = "ks-user-token";
const USER_ID = "ks-user-1";
const BUDDY_PROF_ID = "ks-buddy-profile-1";
const BUDDY_USER_ID = "ks-buddy-user-1";

// ── Fake ─────────────────────────────────────────────────────────────────────

interface KSState {
  /** flag -> enabled. Absent means "no row", which reads as not engaged. */
  flags: Record<string, boolean>;
  /** flag -> force a DB error on this read, to exercise the fail-closed path. */
  flagErrors: Set<string>;
}

let state: KSState;

/**
 * Baseline flags: everything the canonical route needs to REACH the kill switch.
 * Deliberately explicit — a fixture that stops clearing an earlier gate would
 * make the 404 assertions pass for the wrong reason.
 */
function baseFlags(): Record<string, boolean> {
  return {
    rent_buddy_enabled: true,
    // The KYC gate sits immediately BEFORE the kill switch on POST /bookings and
    // is hard-closed in every environment (no identity provider is operational).
    // Without this override the route would 503 before the switch was consulted
    // and the test would prove nothing.
    [KYC_OVERRIDE_FLAG]: true,
  };
}

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, any]>,
      _single: false,
      select() { return this; },
      insert() { return this; },
      update() { return this; },
      upsert() { return this; },
      eq(c: string, v: any) { this._filters.push([c, v]); return this; },
      neq() { return this; }, is() { return this; }, in() { return this; },
      gte() { return this; }, lte() { return this; }, lt() { return this; },
      ilike() { return this; }, contains() { return this; }, or() { return this; },
      limit() { return this; }, order() { return this; },
      maybeSingle() { this._single = true; return this; },
      single() { this._single = true; return this; },
      async then(resolve: (v: any) => void) { const r = await this._resolve(); resolve(r); return r; },
      async _resolve(): Promise<any> {
        if (this._table === "feature_flags") {
          const flag = this._filters.find(([c]) => c === "flag")?.[1] as string;
          if (state.flagErrors.has(flag)) return { data: null, error: { message: "simulated flag read failure" } };
          const enabled = state.flags[flag];
          return { data: enabled === undefined ? null : { flag, enabled }, error: null };
        }
        if (this._table === "profiles") {
          const id = this._filters.find(([c]) => c === "id")?.[1];
          return { data: id ? { id, role: "user", date_of_birth: "1990-01-01" } : null, error: null };
        }
        if (this._table === "rent_buddy_profiles") {
          return this._single
            ? { data: { id: BUDDY_PROF_ID, user_id: BUDDY_USER_ID, status: "active", admin_status: "active", city: "Bangkok", country: "Thailand", hourly_rate_usd: 30, buddy_level: "new" }, error: null }
            : { data: [], count: 0, error: null };
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

/** Minimal Express `res` recorder for the direct-gate tests. */
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
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${USER_TOKEN}` } },
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
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = { flags: baseFlags(), flagErrors: new Set() };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

const gateOpts = (sc: any, res: any) => ({
  sc, res,
  userId: USER_ID,
  buddyProfile: { id: BUDDY_PROF_ID, user_id: BUDDY_USER_ID, country: "Thailand" },
  city: "Bangkok",
  countryCode: "Thailand",
  category: "city",
  applyKillSwitch: true,
});

// ── Call site 1: the shared creation gate ────────────────────────────────────

describe("enforceBookingCreationGates — applyKillSwitch", () => {
  for (const flag of KILL_SWITCH_FLAGS) {
    it(`refuses the booking when ${flag} is engaged`, async () => {
      state.flags[flag] = true;
      const client = makeClient();
      const { res, rec } = fakeRes();

      const ok = await enforceBookingCreationGates(gateOpts(client, res) as any);

      assert.equal(ok, false, `${flag} must stop the gate`);
      assert.equal(rec.status, 404);
      assert.equal(rec.body.error, "feature_disabled");
    });

    it(`refuses the booking when the ${flag} read FAILS (fail-closed)`, async () => {
      state.flagErrors.add(flag);
      const client = makeClient();
      const { res, rec } = fakeRes();

      const ok = await enforceBookingCreationGates(gateOpts(client, res) as any);

      assert.equal(ok, false, "an unreadable kill switch must read as engaged");
      assert.equal(rec.status, 404);
    });
  }

  it("does NOT stop at the kill switch when neither flag is engaged", async () => {
    // Negative control. The gate may well refuse further down (launch controls,
    // blocks, KYC) — what must not happen is a 404 feature_disabled, which would
    // mean these assertions pass whatever the switches say.
    const client = makeClient();
    const { res, rec } = fakeRes();

    await enforceBookingCreationGates(gateOpts(client, res) as any);

    assert.notEqual(rec.body?.error, "feature_disabled",
      "with both switches off the booking must not be refused as feature_disabled");
  });

  it("does not consult the switches when applyKillSwitch is false", async () => {
    // The canonical route runs them itself and passes false; if the shared gate
    // still 404'd here, that route would be gated twice and the inline copy's
    // own coverage below would be meaningless.
    state.flags["disable_rent_buddy_booking"] = true;
    const client = makeClient();
    const { res, rec } = fakeRes();

    await enforceBookingCreationGates({ ...gateOpts(client, res), applyKillSwitch: false } as any);

    assert.notEqual(rec.body?.error, "feature_disabled");
  });
});

// ── Call site 2: the canonical route's inline pair ───────────────────────────

describe("POST /rent-a-buddy/bookings — inline kill switches", () => {
  const body = {
    buddyId: BUDDY_PROF_ID, city: "Bangkok", category: "city",
    bookingDate: "2099-01-01", durationH: 2, groupSize: 1,
  };

  for (const flag of KILL_SWITCH_FLAGS) {
    it(`returns 404 feature_disabled when ${flag} is engaged`, async () => {
      state.flags[flag] = true;
      const r = await post("/api/rent-a-buddy/bookings", body);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, "feature_disabled");
    });

    it(`returns 404 when the ${flag} read FAILS (fail-closed)`, async () => {
      state.flagErrors.add(flag);
      const r = await post("/api/rent-a-buddy/bookings", body);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, "feature_disabled");
    });
  }

  it("reaches past the kill switch when neither flag is engaged", async () => {
    // Negative control for the two cases above: the request gets further and is
    // refused by a LATER gate, so the 404s are attributable to the switches.
    const r = await post("/api/rent-a-buddy/bookings", body);
    assert.notEqual(r.body?.error, "feature_disabled",
      `with both switches off the route must not answer feature_disabled (got ${r.status} ${JSON.stringify(r.body)})`);
  });

  it("still 403s when the master flag is off, before any of this", async () => {
    state.flags["rent_buddy_enabled"] = false;
    const r = await post("/api/rent-a-buddy/bookings", body);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });
});
