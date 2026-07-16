/**
 * rentABuddyHalfPairCoords.test.ts
 *
 * Confirms that all four rent-a-buddy endpoints that accept coordinates
 * reject a "half-pair" payload (only lat, or only lng) with 400
 * invalid_payload — the server-side defence that complements the
 * client-side cityCoordSpread guard.
 *
 * Endpoints under test:
 *   POST /api/rent-a-buddy/search        (rentABuddy router)
 *   POST /api/rent-a-buddy/waitlist      (rentABuddy router — v1)
 *   POST /api/rent-a-buddy/requests      (rentABuddyMarketplace router)
 *   POST /api/rent-a-buddy/waitlist/v2   (rentABuddyMarketplace router)
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyHalfPairCoords.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import rentABuddyMarketplaceRouter from "../routes/rentABuddyMarketplace.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const USER_TOKEN = "half-pair-test-token";
const USER_ID    = "half-pair-user-id-1";

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

// ── Minimal fake builder ───────────────────────────────────────────────────────
//
// The half-pair check fires before any real DB call, so the builder only
// needs to support the chaining methods used prior to that check:
//   feature_flags  → .select().eq().maybeSingle()   (requireRentBuddyEnabled)
//   auth.getUser   → requireUser
//
function makeBuilder(result: any): any {
  const b: any = {
    select: () => b,
    insert: () => b,
    upsert: () => b,
    update: () => b,
    delete: () => b,
    eq: () => b,
    neq: () => b,
    in: () => b,
    is: () => b,
    gte: () => b,
    lte: () => b,
    gt: () => b,
    lt: () => b,
    like: () => b,
    ilike: () => b,
    contains: () => b,
    overlaps: () => b,
    order: () => b,
    limit: () => b,
    range: () => b,
    single:      () => Promise.resolve({ data: result, error: null }),
    maybeSingle: () => Promise.resolve({ data: result, error: null }),
    then: (resolve: (r: any) => any) =>
      Promise.resolve({ data: result ? [result] : [], error: null }).then(resolve),
  };
  return b;
}

function makeAuthClient(userId: string) {
  return {
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({ data: { user: { id: userId } }, error: null }),
    },
    from: (table: string) => {
      if (table === "feature_flags") {
        return makeBuilder({ flag: "rent_buddy_enabled", enabled: true });
      }
      if (table === "profiles") {
        return makeBuilder({ id: userId, role: "user", is_banned: false, suspended_until: null });
      }
      return makeBuilder(null);
    },
  };
}

function makeServiceClient() {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    from: (table: string) => {
      if (table === "feature_flags") {
        return makeBuilder({ flag: "rent_buddy_enabled", enabled: true });
      }
      return makeBuilder(null);
    },
  };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(rentABuddyRouter);
  app.use(rentABuddyMarketplaceRouter);

  _setTestClient(makeAuthClient(USER_ID) as any, true);
  _setTestServiceClient(makeServiceClient() as any);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve()))
));

// ── Suite: POST /api/rent-a-buddy/search ─────────────────────────────────────

describe("POST /api/rent-a-buddy/search — half-pair coord rejection", () => {
  it("rejects lat without lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: 13.7563,
      // lng omitted
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects lng without lat", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      // lat omitted
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("accepts both lat and lng (valid pair)", async () => {
    // Should not be rejected with 400 due to the half-pair check.
    // The DB returns empty results but the coord validation passes.
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: 13.7563,
      lng: 100.5018,
    });
    // The handler returns 200 with a buddies list (possibly empty); never 400.
    assert.notEqual(res.status, 400, `unexpected invalid_payload: ${JSON.stringify(res.body)}`);
  });

  it("accepts neither lat nor lng (both omitted)", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
    });
    assert.notEqual(res.status, 400, `unexpected invalid_payload: ${JSON.stringify(res.body)}`);
  });
});

// ── Suite: POST /api/rent-a-buddy/search — non-numeric coord rejection ────────

describe("POST /api/rent-a-buddy/search — non-numeric coord rejection", () => {
  it("rejects string lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: "13.7563",
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects boolean lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: true,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects object lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: { value: 13.7563 },
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects numeric lat with string lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: 13.7563,
      lng: "100.5018",
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects both string lat and string lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: "13.7563",
      lng: "100.5018",
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });
});

// ── Suite: POST /api/rent-a-buddy/requests ───────────────────────────────────

describe("POST /api/rent-a-buddy/requests — half-pair coord rejection", () => {
  const requiredFields = { city: "Bangkok", category: "city" };

  it("rejects lat without lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: 13.7563,
      // lng omitted
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects lng without lat", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      // lat omitted
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("accepts both lat and lng (valid pair)", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: 13.7563,
      lng: 100.5018,
    });
    // 400 only means invalid_payload; a db_error or other status is fine for this test's scope.
    if (res.status === 400) {
      assert.notEqual(res.body.error, "invalid_payload",
        `coord validation incorrectly rejected a valid pair: ${JSON.stringify(res.body)}`);
    }
  });

  it("accepts neither lat nor lng (both omitted)", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
    });
    if (res.status === 400) {
      assert.notEqual(res.body.error, "invalid_payload",
        `coord validation incorrectly rejected missing coords: ${JSON.stringify(res.body)}`);
    }
  });
});

// ── Suite: POST /api/rent-a-buddy/requests — non-numeric coord rejection ──────

describe("POST /api/rent-a-buddy/requests — non-numeric coord rejection", () => {
  const requiredFields = { city: "Bangkok", category: "city" };

  it("rejects string lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: "13.7563",
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects boolean lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: true,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects object lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: { value: 13.7563 },
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects both string lat and string lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: "13.7563",
      lng: "100.5018",
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });
});

// ── Suite: POST /api/rent-a-buddy/waitlist (v1) ───────────────────────────────

describe("POST /api/rent-a-buddy/waitlist — half-pair coord rejection (v1)", () => {
  const requiredFields = { city: "Bangkok" };

  it("rejects lat without lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist", {
      ...requiredFields,
      lat: 13.7563,
      // lng omitted
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects lng without lat", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist", {
      ...requiredFields,
      // lat omitted
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("accepts both lat and lng (valid pair)", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist", {
      ...requiredFields,
      lat: 13.7563,
      lng: 100.5018,
    });
    if (res.status === 400) {
      assert.notEqual(res.body.error, "invalid_payload",
        `coord validation incorrectly rejected a valid pair: ${JSON.stringify(res.body)}`);
    }
  });

  it("accepts neither lat nor lng (both omitted)", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist", {
      ...requiredFields,
    });
    if (res.status === 400) {
      assert.notEqual(res.body.error, "invalid_payload",
        `coord validation incorrectly rejected missing coords: ${JSON.stringify(res.body)}`);
    }
  });
});

// ── Suite: POST /api/rent-a-buddy/waitlist (v1) — 201 success path ───────────
//
// A separate service client is needed here because all other suites use a
// client where every feature_flags query returns the same row (rent_buddy_enabled
// = true), which causes RENT_BUDDY_ADMIN_ONLY_MODE to also appear enabled and
// blocks the request at 403 before a 201 can be produced.
//
// This client uses a flag-aware builder that captures the flag name from the
// .eq() call so only rent_buddy_enabled resolves to true; all other flags
// return null (false).  It also supplies a public_mvp city rollout so
// checkRentBuddyAccess reaches the allowed:true branch.

function makeFlagAwareBuilder(): any {
  let capturedFlag: string | null = null;
  const b: any = {
    select: () => b,
    insert: () => b,
    upsert: () => b,
    update: () => b,
    delete: () => b,
    eq: (_col: string, val: string) => { capturedFlag = val; return b; },
    neq: () => b,
    in: () => b,
    is: () => b,
    gte: () => b,
    lte: () => b,
    gt: () => b,
    lt: () => b,
    like: () => b,
    ilike: () => b,
    contains: () => b,
    overlaps: () => b,
    order: () => b,
    limit: () => b,
    range: () => b,
    single: () => {
      const enabled = capturedFlag === "rent_buddy_enabled";
      return Promise.resolve({ data: enabled ? { enabled: true } : null, error: null });
    },
    maybeSingle: () => {
      const enabled = capturedFlag === "rent_buddy_enabled";
      return Promise.resolve({ data: enabled ? { enabled: true } : null, error: null });
    },
    then: (resolve: (r: any) => any) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return b;
}

function makeWaitlist201ServiceClient() {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    from: (table: string) => {
      if (table === "feature_flags") {
        return makeFlagAwareBuilder();
      }
      if (table === "rent_buddy_global_controls") {
        return makeBuilder({
          id: 1,
          all_bookings_paused: false,
          applications_paused: false,
          cash_balance_paused: false,
          nightlife_paused: false,
          force_full_in_app: false,
          force_public_meetup: false,
          force_delayed_posting: false,
        });
      }
      if (table === "rent_buddy_city_rollouts") {
        return makeBuilder({ id: "rollout-1", status: "public_mvp" });
      }
      return makeBuilder(null);
    },
  };
}

describe("POST /api/rent-a-buddy/waitlist — v1 returns 201 on success", () => {
  before(() => {
    _setTestServiceClient(makeWaitlist201ServiceClient() as any);
  });

  after(() => {
    // Restore the original service client for subsequent suites.
    _setTestServiceClient(makeServiceClient() as any);
  });

  it("returns 201 ok:true for a valid city-only entry", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist", { city: "Bangkok" });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
  });

  it("returns 201 ok:true for a valid city + coord pair", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist", {
      city: "Bangkok",
      lat: 13.7563,
      lng: 100.5018,
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
  });
});

// ── Suite: POST /api/rent-a-buddy/waitlist/v2 ────────────────────────────────

describe("POST /api/rent-a-buddy/waitlist/v2 — half-pair coord rejection", () => {
  const requiredFields = { city: "Bangkok" };

  it("rejects lat without lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: 13.7563,
      // lng omitted
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects lng without lat", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      // lat omitted
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("accepts both lat and lng (valid pair)", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: 13.7563,
      lng: 100.5018,
    });
    if (res.status === 400) {
      assert.notEqual(res.body.error, "invalid_payload",
        `coord validation incorrectly rejected a valid pair: ${JSON.stringify(res.body)}`);
    }
  });

  it("accepts neither lat nor lng (both omitted)", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
    });
    if (res.status === 400) {
      assert.notEqual(res.body.error, "invalid_payload",
        `coord validation incorrectly rejected missing coords: ${JSON.stringify(res.body)}`);
    }
  });
});

// ── Suite: POST /api/rent-a-buddy/waitlist/v2 — non-numeric coord rejection ───

describe("POST /api/rent-a-buddy/waitlist/v2 — non-numeric coord rejection", () => {
  const requiredFields = { city: "Bangkok" };

  it("rejects string lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: "13.7563",
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects boolean lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: true,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects object lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: { value: 13.7563 },
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects both string lat and string lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: "13.7563",
      lng: "100.5018",
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });
});

// ── Suite: POST /api/rent-a-buddy/search — NaN / Infinity coord rejection ─────
//
// NaN and Infinity are typeof "number" but not Number.isFinite, so they are
// caught by the isNonNumericCoord guard (which uses Number.isFinite).
// JSON.stringify serialises both to null, which the server receives as an
// absent (non-finite) coordinate.  When paired with a valid lng that IS
// finite, the half-pair guard fires and returns 400 invalid_payload — so the
// values are never silently stored.

describe("POST /api/rent-a-buddy/search — NaN / Infinity lat rejection", () => {
  it("rejects NaN lat with numeric lng", async () => {
    // NaN → null over the wire; server sees null lat + finite lng → half-pair guard fires
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: NaN,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects Infinity lat with numeric lng", async () => {
    // Infinity → null over the wire; server sees null lat + finite lng → half-pair guard fires
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: Infinity,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects numeric lat with NaN lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: 13.7563,
      lng: NaN,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects numeric lat with Infinity lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/search", {
      city: "Bangkok",
      lat: 13.7563,
      lng: Infinity,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });
});

// ── Suite: POST /api/rent-a-buddy/requests — NaN / Infinity coord rejection ───

describe("POST /api/rent-a-buddy/requests — NaN / Infinity lat rejection", () => {
  const requiredFields = { city: "Bangkok", category: "city" };

  it("rejects NaN lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: NaN,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects Infinity lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: Infinity,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects numeric lat with NaN lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: 13.7563,
      lng: NaN,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects numeric lat with Infinity lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/requests", {
      ...requiredFields,
      lat: 13.7563,
      lng: Infinity,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });
});

// ── Suite: POST /api/rent-a-buddy/waitlist/v2 — NaN / Infinity coord rejection

describe("POST /api/rent-a-buddy/waitlist/v2 — NaN / Infinity lat rejection", () => {
  const requiredFields = { city: "Bangkok" };

  it("rejects NaN lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: NaN,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects Infinity lat with numeric lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: Infinity,
      lng: 100.5018,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects numeric lat with NaN lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: 13.7563,
      lng: NaN,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects numeric lat with Infinity lng", async () => {
    const res = await req("POST", "/api/rent-a-buddy/waitlist/v2", {
      ...requiredFields,
      lat: 13.7563,
      lng: Infinity,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });
});
