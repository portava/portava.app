/**
 * rentABuddyHalfPairCoords.test.ts
 *
 * Confirms that all three rent-a-buddy endpoints that accept coordinates
 * reject a "half-pair" payload (only lat, or only lng) with 400
 * invalid_payload — the server-side defence that complements the
 * client-side cityCoordSpread guard.
 *
 * Endpoints under test:
 *   POST /api/rent-a-buddy/search        (rentABuddy router)
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
