/**
 * Compass Telegraph surface tests — GET /api/compass/telegraph
 *
 * Covers:
 *  A. Feature flag gate — flag_disabled when COMPASS_TELEGRAPH is off
 *  B. Auth guard — 401 when no token
 *  C. Invalid threadId — 400 for non-UUID
 *  D. Thread membership guard — 403 when caller is not in the thread
 *  E. Left member — 403 when caller has left_at set
 *  F. Rate limit — 429 after 5 requests
 *  G. Happy path — returns cards array (may be empty if no compass profile)
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Fake Supabase client injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/compassTelegraph.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

// ── Shared constants ──────────────────────────────────────────────────────────

const ALICE_ID    = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID      = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const THREAD_ID   = "cccccccc-1111-1111-1111-000000000003";
const RATE_USER_ID = "f6f6f6f6-ffff-ffff-ffff-000000000006";

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeState {
  users?:              Record<string, { id: string } | null>;
  featureFlags?:       Array<{ flag: string; enabled: boolean }>;
  threadMembers?:      Array<{ thread_id: string; user_id: string; left_at: null | string }>;
  threads?:            Array<Record<string, any>>;
  compassProfiles?:    Array<Record<string, any>>;
  rateLimitOverride?:  boolean;
  tokenMap?:           Record<string, string>;
}

function makeClient(state: FakeState = {}, callerUserId: string = ALICE_ID) {
  const db: Record<string, any[]> = {
    feature_flags:              state.featureFlags ?? [{ flag: "COMPASS_TELEGRAPH", enabled: true }],
    message_thread_members:     state.threadMembers ?? [
      { thread_id: THREAD_ID, user_id: callerUserId, left_at: null },
      { thread_id: THREAD_ID, user_id: BOB_ID,       left_at: null },
    ],
    message_threads:            state.threads ?? [
      { id: THREAD_ID, thread_type: "direct", trip_id: null },
    ],
    compass_profiles:           state.compassProfiles ?? [],
    profiles:                   [],
    compass_user_preferences:   [],
    compass_served_recommendations: [],
  };

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];

    const b: any = {
      select: (_cols?: string) => builder(table, filtered),
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      is: (col: string, val: any) => {
        filtered = filtered.filter((r) => {
          if (val === null) return r[col] == null;
          return r[col] === val;
        });
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      like: (col: string, pattern: string) => {
        // Convert SQL LIKE pattern to JS regex: % → .*, _ → .
        const rx = new RegExp(
          "^" + pattern.replace(/%/g, ".*").replace(/_/g, ".") + "$",
          "i",
        );
        filtered = filtered.filter((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      order:     () => b,
      limit:     () => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: [...filtered], error: null }),
    };
    return b;
  }

  return {
    auth: {
      getUser: (token?: string) => {
        if (token && state.tokenMap?.[token]) {
          return Promise.resolve({ data: { user: { id: state.tokenMap[token] } }, error: null });
        }
        const users = state.users ?? {};
        if (token && users[token]) {
          return Promise.resolve({ data: { user: users[token] }, error: null });
        }
        if (token === "alice-token") {
          return Promise.resolve({ data: { user: { id: callerUserId } }, error: null });
        }
        return Promise.resolve({ data: { user: null }, error: { message: "no token" } });
      },
    },
    from: (table: string) => {
      const rows = db[table] ?? [];
      return builder(table, rows);
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

// ── Server factory ────────────────────────────────────────────────────────────

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  return app;
}

// ── A: Feature flag gate ───────────────────────────────────────────────────────

describe("GET /api/compass/telegraph — flag gate", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: compassRouter } = await import("../routes/compass.js");
    app.use("/api", compassRouter);
    ({ url, close } = await startServer(app));

    // Flag is off
    _setTestClient(
      makeClient({ featureFlags: [{ flag: "COMPASS_TELEGRAPH", enabled: false }] }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 404 with feature_disabled when COMPASS_TELEGRAPH is off", async () => {
    const r = await fetch(`${url}/api/compass/telegraph?threadId=${THREAD_ID}`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal((body as any).error, "feature_disabled");
  });
});

// ── B: Auth guard ──────────────────────────────────────────────────────────────

describe("GET /api/compass/telegraph — auth guard", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: compassRouter } = await import("../routes/compass.js");
    app.use("/api", compassRouter);
    ({ url, close } = await startServer(app));
    _setTestClient(makeClient(), true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 401 when no Authorization header", async () => {
    const r = await fetch(`${url}/api/compass/telegraph?threadId=${THREAD_ID}`);
    assert.equal(r.status, 401);
  });
});

// ── C: Invalid threadId ────────────────────────────────────────────────────────

describe("GET /api/compass/telegraph — validation", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: compassRouter } = await import("../routes/compass.js");
    app.use("/api", compassRouter);
    ({ url, close } = await startServer(app));
    _setTestClient(makeClient(), true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 400 for non-UUID threadId", async () => {
    const r = await fetch(`${url}/api/compass/telegraph?threadId=not-a-uuid`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal((body as any).error, "invalid_payload");
  });

  it("returns 400 when threadId is missing", async () => {
    const r = await fetch(`${url}/api/compass/telegraph`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 400);
  });
});

// ── D: Thread membership guard ─────────────────────────────────────────────────

describe("GET /api/compass/telegraph — membership guard", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: compassRouter } = await import("../routes/compass.js");
    app.use("/api", compassRouter);
    ({ url, close } = await startServer(app));

    // Alice is NOT in this thread
    _setTestClient(
      makeClient({
        threadMembers: [
          { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null },
        ],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 403 forbidden when caller is not a thread member", async () => {
    const r = await fetch(`${url}/api/compass/telegraph?threadId=${THREAD_ID}`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal((body as any).error, "forbidden");
  });
});

// ── E: Left member ─────────────────────────────────────────────────────────────

describe("GET /api/compass/telegraph — left member", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: compassRouter } = await import("../routes/compass.js");
    app.use("/api", compassRouter);
    ({ url, close } = await startServer(app));

    // Alice has left_at set
    _setTestClient(
      makeClient({
        threadMembers: [
          { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: "2025-01-01T00:00:00Z" },
          { thread_id: THREAD_ID, user_id: BOB_ID,   left_at: null },
        ],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 403 when caller has left the thread", async () => {
    const r = await fetch(`${url}/api/compass/telegraph?threadId=${THREAD_ID}`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal((body as any).error, "forbidden");
  });
});

// ── F: Rate limit ──────────────────────────────────────────────────────────────

describe("GET /api/compass/telegraph — rate limit", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    _resetRateLimit("compass_telegraph", RATE_USER_ID);
    const app = makeApp();
    const { default: compassRouter } = await import("../routes/compass.js");
    app.use("/api", compassRouter);
    ({ url, close } = await startServer(app));

    _setTestClient(
      makeClient(
        {
          tokenMap: { "rate-user-token": RATE_USER_ID },
          threadMembers: [
            { thread_id: THREAD_ID, user_id: RATE_USER_ID, left_at: null },
            { thread_id: THREAD_ID, user_id: BOB_ID,       left_at: null },
          ],
        },
        RATE_USER_ID,
      ),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
    _resetRateLimit("compass_telegraph", RATE_USER_ID);
  });

  it("returns 429 after 5 requests within the same window", async () => {
    // Exhaust the 5-request allowance
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${url}/api/compass/telegraph?threadId=${THREAD_ID}`, {
        headers: { Authorization: "Bearer rate-user-token" },
      });
      assert.notEqual(r.status, 429, `Request ${i + 1} should not be rate-limited yet`);
    }
    // 6th request must be rejected
    const r6 = await fetch(`${url}/api/compass/telegraph?threadId=${THREAD_ID}`, {
      headers: { Authorization: "Bearer rate-user-token" },
    });
    assert.equal(r6.status, 429);
    const body = await r6.json();
    assert.equal((body as any).error, "rate_limited");
  });
});

// ── G: Happy path ──────────────────────────────────────────────────────────────

describe("GET /api/compass/telegraph — happy path", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: compassRouter } = await import("../routes/compass.js");
    app.use("/api", compassRouter);
    ({ url, close } = await startServer(app));
    _setTestClient(makeClient(), true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 200 with cards array and city field", async () => {
    const r = await fetch(`${url}/api/compass/telegraph?threadId=${THREAD_ID}`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.cards), "body.cards should be an array");
    assert.ok(body.cards.length <= 4, "should return at most 4 cards");
    assert.ok("city" in body, "body should have a city field");
  });
});
