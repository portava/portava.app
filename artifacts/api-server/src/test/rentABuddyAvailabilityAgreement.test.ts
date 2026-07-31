/**
 * Confirms that GET /api/rent-buddy/launch-status?city= returns an
 * `availableNowCount` field that reflects real-time buddy availability,
 * using the same case-insensitive ilike-on-trimmed-city match as
 * GET /api/rent-a-buddy/available-now — so the Pulse card, landing banner,
 * Available Now list, and Compass Picks can never show contradictory claims.
 *
 * Key scenarios:
 *   1. City is public_mvp but nobody has available_now=true → count=0 AND
 *      available=true (these are two different facts; both must be reported).
 *   2. City is public_mvp AND one buddy has available_now=true → count=1.
 *   3. City name sent with different casing/whitespace still matches.
 *   4. available-now endpoint respects the same ilike city filter.
 *
 * Run: pnpm --filter @workspace/api-server test
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRolloutRouter, { invalidateGcCache } from "../routes/rentABuddyRollout.js";
import rentABuddyMarketplaceRouter from "../routes/rentABuddyMarketplace.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const ADMIN_TOKEN = "avail-admin-token";
const USER_TOKEN  = "avail-user-token";
const ADMIN_ID    = "avail-admin-1";
const USER_ID     = "avail-user-1";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = USER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
    };
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

// ── Fake state ────────────────────────────────────────────────────────────────

interface State {
  featureFlags:  Record<string, { flag: string; enabled: boolean }>;
  profiles:      Record<string, any>;
  buddyProfiles: Record<string, any>;
  cityRollouts:  Record<string, any>;
  betaAccess:    any[];
  globalControls: any;
}

let state: State;

function resetState(): void {
  state = {
    featureFlags: {
      rent_buddy_enabled:           { flag: "rent_buddy_enabled",           enabled: true  },
      RENT_BUDDY_MVP_MODE:          { flag: "RENT_BUDDY_MVP_MODE",          enabled: false },
      RENT_BUDDY_ADMIN_ONLY_MODE:   { flag: "RENT_BUDDY_ADMIN_ONLY_MODE",   enabled: false },
      RENT_BUDDY_BETA_ONLY_MODE:    { flag: "RENT_BUDDY_BETA_ONLY_MODE",    enabled: false },
      RENT_BUDDY_NIGHTLIFE_ENABLED: { flag: "RENT_BUDDY_NIGHTLIFE_ENABLED", enabled: true  },
    },
    profiles: {
      [ADMIN_ID]: { id: ADMIN_ID, role: "admin" },
      [USER_ID]:  { id: USER_ID,  role: "user"  },
    },
    buddyProfiles: {},
    cityRollouts: {
      "cebu-rollout": {
        id: "cebu-rollout", city: "Cebu", country: "PH",
        status: "public_mvp", target_launch_date: null, buddy_cap: null, notes: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        status_changed_at: new Date().toISOString(), status_changed_by: ADMIN_ID,
      },
    },
    betaAccess: [],
    globalControls: {
      id: 1, all_bookings_paused: false, applications_paused: false,
      cash_balance_paused: false, nightlife_paused: false,
      force_full_in_app: false, force_public_meetup: false, force_delayed_posting: false,
    },
  };
}

function makeClient(userId: string) {
  return {
    auth: {
      async getUser(token: string) {
        let uid = userId;
        if (token === ADMIN_TOKEN) uid = ADMIN_ID;
        if (token === USER_TOKEN)  uid = USER_ID;
        return { data: { user: { id: uid } }, error: null };
      },
    },
    from(table: string) {
      return fakeTable(table);
    },
  };

  function fakeTable(table: string) {
    return {
      _table:   table,
      _filters: [] as Array<[string, string, any]>,
      _count:   false,
      _head:    false,
      _maybeSingle: false,
      _limit:   1000,

      select(cols?: string, opts?: any) {
        if (opts?.count) this._count = true;
        if (opts?.head)  this._head  = true;
        return this;
      },
      insert(data: any) { return this; },
      update(data: any) { return this; },
      upsert(data: any, _o?: any) { return this; },
      delete() { return this; },
      eq(col: string, val: any)       { this._filters.push(["eq",    col, val]);                        return this; },
      neq(col: string, val: any)      { this._filters.push(["neq",   col, val]);                        return this; },
      not(col: string, _op: string, val: any) { this._filters.push(["neq", col, val]);                  return this; },
      ilike(col: string, val: any)    { this._filters.push(["ilike", col, (val as string).trim()]);     return this; },
      // .not(col, op, val) negates the given filter.  The route uses
      // .not("city", "ilike", trimmedCity) to exclude the viewer's city when
      // looking for nearby-city suggestions.
      not(col: string, op: string, val: any) {
        this._filters.push([`not_${op}`, col, typeof val === "string" ? val.trim() : val]);
        return this;
      },
      gte(col: string, val: any)      { return this; },
      lte(col: string, val: any)      { return this; },
      contains(col: string, val: any) { return this; },
      is(col: string, val: any)       { this._filters.push(["is", col, val]); return this; },
      or()                            { return this; },
      limit(n: number)                { this._limit = n; return this; },
      range()                         { return this; },
      order()                         { return this; },
      maybeSingle()                   { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (t === "feature_flags") {
          const eqFlag = this._filters.find(([op, col]) => op === "eq" && col === "flag");
          if (eqFlag && this._maybeSingle)
            return { data: state.featureFlags[eqFlag[2]] ?? null, error: null };
          return { data: Object.values(state.featureFlags), error: null };
        }

        if (t === "profiles") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId && this._maybeSingle)
            return { data: state.profiles[eqId[2]] ?? null, error: null };
          return { data: Object.values(state.profiles), error: null };
        }

        if (t === "rent_buddy_global_controls") {
          if (this._maybeSingle)
            return { data: state.globalControls, error: null };
          return { data: [state.globalControls], count: 1, error: null };
        }

        if (t === "rent_buddy_city_rollouts") {
          let rolls = Object.values(state.cityRollouts) as any[];
          const ilikeCity    = this._filters.find(([op, col]) => op === "ilike"     && col === "city");
          const notIlikeCity = this._filters.find(([op, col]) => op === "not_ilike" && col === "city");
          const eqId         = this._filters.find(([op, col]) => op === "eq"        && col === "id");
          const eqStatus     = this._filters.find(([op, col]) => op === "eq"        && col === "status");
          if (eqId && this._maybeSingle)
            return { data: state.cityRollouts[eqId[2]] ?? null, error: null };
          if (ilikeCity && this._maybeSingle) {
            const v = (ilikeCity[2] as string).toLowerCase();
            const match = rolls.find((r: any) => r.city?.toLowerCase() === v);
            return { data: match ?? null, error: null };
          }
          if (eqStatus)
            rolls = rolls.filter((r: any) => r.status === eqStatus[2]);
          if (notIlikeCity) {
            const v = (notIlikeCity[2] as string).toLowerCase();
            rolls = rolls.filter((r: any) => r.city?.toLowerCase() !== v);
          }
          if (ilikeCity) {
            const v = (ilikeCity[2] as string).toLowerCase();
            rolls = rolls.filter((r: any) => r.city?.toLowerCase() === v);
          }
          return { data: rolls, count: rolls.length, error: null };
        }

        if (t === "rent_buddy_profiles") {
          let rows = Object.values(state.buddyProfiles) as any[];

          for (const [op, col, val] of this._filters) {
            if (op === "ilike" && col === "city") {
              const v = (val as string).toLowerCase();
              rows = rows.filter((r: any) => r.city?.toLowerCase() === v);
            }
            if (op === "eq") {
              rows = rows.filter((r: any) => r[col] === val);
            }
          }

          if (this._head) {
            // HEAD count — only return the count, no data rows
            return { data: null, count: rows.length, error: null };
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          rows = rows.slice(0, this._limit);
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_beta_access") {
          return { data: state.betaAccess, count: 0, error: null };
        }

        return { data: [], count: 0, error: null };
      },
    };
  }
}

function setupClient(userId: string): void {
  const c = makeClient(userId) as any;
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  // Minimal shim so the marketplace router's requireUser doesn't blow up
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", rentABuddyRolloutRouter);
  app.use("/api", rentABuddyMarketplaceRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetState();
  invalidateGcCache();
  setupClient(USER_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite A: launch-status availableNowCount accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe("launch-status availableNowCount — zero-online city", () => {
  it("returns availableNowCount:0 for a public_mvp city with no available_now buddies (Cebu)", async () => {
    // City is rolled out (public_mvp) but nobody has available_now=true.
    // The `available` flag should be true (city is live), and availableNowCount
    // should be 0 — two separate facts that must not be conflated in the UI.
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Cebu");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.available,         true,  "city is rolled out (public_mvp)");
    assert.equal(r.body.availableNowCount, 0,     "zero buddies online right now");
    assert.equal(r.body.status,            "public_mvp");
  });

  it("confirms available=true does NOT imply availableNowCount>0", async () => {
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Cebu");
    assert.equal(r.status, 200);
    // available=true only means the city was rolled out to the public.
    // A green "live" banner based on `available` alone is the bug we fixed.
    assert.equal(r.body.available,         true);
    assert.equal(r.body.availableNowCount, 0,    "available flag ≠ someone is online");
  });
});

describe("launch-status availableNowCount — buddies-online city", () => {
  beforeEach(() => {
    // Seed one active buddy with available_now=true in Cebu
    state.buddyProfiles["buddy-cebu-1"] = {
      id:           "buddy-cebu-1",
      user_id:      "user-cebu-1",
      city:         "Cebu",
      status:       "active",
      admin_status: "active",
      available_now: true,
      categories:   ["city"],
    };
  });

  it("returns availableNowCount:1 when one buddy is available_now in Cebu", async () => {
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Cebu");
    assert.equal(r.status, 200);
    assert.equal(r.body.available,         true);
    assert.equal(r.body.availableNowCount, 1, "one buddy online");
  });

  it("does NOT count buddies whose available_now=false", async () => {
    // Add a second buddy who is active but NOT available_now
    state.buddyProfiles["buddy-cebu-2"] = {
      id:           "buddy-cebu-2",
      user_id:      "user-cebu-2",
      city:         "Cebu",
      status:       "active",
      admin_status: "active",
      available_now: false,
      categories:   ["language"],
    };
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Cebu");
    assert.equal(r.status, 200);
    assert.equal(r.body.availableNowCount, 1, "only the available_now=true buddy is counted");
  });

  it("does NOT count buddies from a different city", async () => {
    state.buddyProfiles["buddy-manila-1"] = {
      id:           "buddy-manila-1",
      user_id:      "user-manila-1",
      city:         "Manila",
      status:       "active",
      admin_status: "active",
      available_now: true,
      categories:   ["city"],
    };
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Cebu");
    assert.equal(r.status, 200);
    assert.equal(r.body.availableNowCount, 1, "Manila buddy not counted for Cebu query");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite B: city-name normalization parity
// ─────────────────────────────────────────────────────────────────────────────

describe("launch-status city matching — ilike normalization", () => {
  beforeEach(() => {
    state.buddyProfiles["buddy-cebu-norm"] = {
      id:           "buddy-cebu-norm",
      user_id:      "user-cebu-norm",
      city:         "Cebu",   // stored with canonical casing in DB
      status:       "active",
      admin_status: "active",
      available_now: true,
      categories:   ["arrival"],
    };
  });

  it("counts the buddy when city is queried in lowercase (cebu)", async () => {
    const r = await req("GET", "/api/rent-buddy/launch-status?city=cebu");
    assert.equal(r.status, 200);
    assert.equal(r.body.availableNowCount, 1, "lowercase city name still matches");
  });

  it("counts the buddy when city is queried with leading/trailing whitespace", async () => {
    const r = await req("GET", "/api/rent-buddy/launch-status?city=%20Cebu%20");
    assert.equal(r.status, 200);
    assert.equal(r.body.availableNowCount, 1, "whitespace-padded city name still matches");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite C: available-now endpoint uses same city filter
// ─────────────────────────────────────────────────────────────────────────────

describe("available-now endpoint city filter parity", () => {
  beforeEach(() => {
    state.buddyProfiles["buddy-av-1"] = {
      id:           "buddy-av-1",
      user_id:      "user-av-1",
      city:         "Cebu",
      status:       "active",
      admin_status: "active",
      available_now: true,
      categories:   ["city"],
      cover_photo_url: null,
      tagline: null,
      bio: null,
      languages: ["English"],
      verified: true,
      hourly_rate_usd: 20,
      average_rating: 4.5,
      review_count: 3,
      response_time_h: 1,
      buddy_level: null,
      meetup_base_lat: null,
      meetup_base_lng: null,
    };
  });

  it("returns the buddy for Cebu — list length agrees with launch-status availableNowCount", async () => {
    const statusR = await req("GET", "/api/rent-buddy/launch-status?city=Cebu");
    assert.equal(statusR.status, 200);
    const count = statusR.body.availableNowCount as number;

    const listR = await req("GET", "/api/rent-a-buddy/available-now?city=Cebu", undefined, USER_TOKEN);
    assert.equal(listR.status, 200, `available-now failed: ${JSON.stringify(listR.body)}`);
    assert.equal(
      listR.body.buddies.length,
      count,
      `available-now list length (${listR.body.buddies.length}) must equal launch-status availableNowCount (${count})`,
    );
  });

  it("returns empty list for a different city — agrees with launch-status count 0", async () => {
    const statusR = await req("GET", "/api/rent-buddy/launch-status?city=Manila");
    // Manila has no rollout entry → status=disabled, availableNowCount=0
    assert.equal(statusR.body.availableNowCount, 0);

    const listR = await req("GET", "/api/rent-a-buddy/available-now?city=Manila", undefined, USER_TOKEN);
    assert.equal(listR.status, 200);
    assert.equal(listR.body.buddies.length, 0, "Manila list is empty — agrees with count=0");
  });
});
