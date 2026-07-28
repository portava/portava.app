/**
 * onboardingAutoFollow.test.ts
 *
 * Confirms that PATCH /me/profile with onboardingComplete: true silently
 * upserts a user_follows row (follower_id = user, following_id = portava).
 *
 * Five cases:
 *   1. onboardingComplete: true   → user_follows row is upserted
 *   2. onboardingComplete: false  → no user_follows row
 *   3. onboardingComplete absent  → no user_follows row
 *   4. onboardingComplete: true but @portava profile missing → 200, no row, no crash
 *   5. onboardingComplete: true called twice → idempotent (two upsert calls, both 200)
 *
 * Strategy: The auto-follow runs inside setImmediate (fire-and-forget). After
 * the HTTP response resolves we flush two setImmediate ticks so the async chain
 * settles before asserting on state.
 *
 * Two separate fake clients are used so each concern is isolated:
 *   - userClient   → auth token verification + profiles update (user-level ops)
 *   - serviceClient → portava profile lookup + user_follows upsert (service-role ops)
 *
 * Run: node --import tsx/esm --test src/test/onboardingAutoFollow.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const ME         = "aa000000-0000-4000-a000-000000000099";
const PORTAVA_ID = "pp000000-0000-4000-a000-000000000001";
const ME_TOK     = "tok-onboarding-autofollow";

// ── Base profile fixture (ME) ─────────────────────────────────────────────────

const baseProfile: Record<string, unknown> = {
  id:                  ME,
  username:            "new_traveler",
  name:                "New Traveler",
  handle:              "new_traveler",
  display_name:        "New Traveler",
  bio:                 null,
  avatar_url:          null,
  cover_photo_url:     null,
  home_city:           null,
  home_country:        null,
  current_city:        null,
  is_private:          false,
  passport_visibility: "public",
  account_status:      "active",
  created_at:          new Date().toISOString(),
  username_updated_at: null,
  interests:           [],
  spoken_languages:    [],
  travel_styles:       [],
  verification_status: "unverified",
  role:                "user",
  date_of_birth:       null,
  open_to_meet:        true,
};

// ── Fake state ────────────────────────────────────────────────────────────────

type FakeState = {
  upserts: { table: string; data: unknown }[];
  updates: { table: string; data: unknown }[];
};

function freshState(): FakeState {
  return { upserts: [], updates: [] };
}

// ── makeUserClient ────────────────────────────────────────────────────────────
// Handles: auth token verification + profiles update (user-level operations).

function makeUserClient(state: FakeState) {
  function profileBuilder() {
    let _row = { ...baseProfile };
    const b: any = {
      select:      () => b,
      update:      (data: any) => {
        state.updates.push({ table: "profiles", data });
        _row = { ..._row, ...(data as Record<string, unknown>) };
        return b;
      },
      eq:          () => b,
      neq:         () => b,
      limit:       () => b,
      order:       () => b,
      then:        (resolve: (v: any) => any) =>
        Promise.resolve({ data: [_row], error: null, count: 1 }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: _row, error: null }),
      single:      () => Promise.resolve({ data: _row, error: null }),
    };
    return b;
  }

  function emptyBuilder() {
    const b: any = {
      select:      () => b,
      eq:          () => b,
      neq:         () => b,
      gte:         () => b,
      limit:       () => b,
      order:       () => b,
      then:        (resolve: (v: any) => any) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single:      () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles") return profileBuilder();
      return emptyBuilder();
    },
    auth: {
      getUser: (token?: string) => {
        if (token === ME_TOK) {
          return Promise.resolve({ data: { user: { id: ME } }, error: null });
        }
        return Promise.resolve({ data: { user: null }, error: { message: "invalid token" } });
      },
    },
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload:       async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://example.com/img.jpg" } }),
        remove:       async () => ({ error: null }),
        list:         async () => ({ data: [], error: null }),
      }),
    },
  } as any;
}

// ── makeServiceClient ─────────────────────────────────────────────────────────
// Handles: portava profile lookup + user_follows upsert (service-role operations).
// When includePortava=false the portava lookup returns null → early-exit, no upsert.

function makeServiceClient(state: FakeState, includePortava: boolean) {
  // Profiles builder: tracks the last eq("username", …) filter value so the
  // maybeSingle() call returns portava only when the filter matches "portava".
  function portavaProfileBuilder() {
    let _usernameFilter: string | null = null;
    const b: any = {
      select:      () => b,
      eq:          (_col: string, val: string) => { _usernameFilter = val; return b; },
      neq:         () => b,
      limit:       () => b,
      order:       () => b,
      then:        (resolve: (v: any) => any) => {
        const rows =
          includePortava && _usernameFilter === "portava"
            ? [{ id: PORTAVA_ID, username: "portava" }]
            : [];
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve);
      },
      maybeSingle: () => {
        const row =
          includePortava && _usernameFilter === "portava"
            ? { id: PORTAVA_ID, username: "portava" }
            : null;
        return Promise.resolve({ data: row, error: null });
      },
      single: () => {
        const row =
          includePortava && _usernameFilter === "portava"
            ? { id: PORTAVA_ID, username: "portava" }
            : null;
        return Promise.resolve({ data: row, error: null });
      },
    };
    return b;
  }

  // user_follows builder: records every upsert call in state.upserts.
  function userFollowsBuilder() {
    const b: any = {
      select:      () => b,
      upsert:      (data: any) => {
        state.upserts.push({ table: "user_follows", data });
        return b;
      },
      eq:          () => b,
      limit:       () => b,
      then:        (resolve: (v: any) => any) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single:      () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }

  function emptyBuilder() {
    const b: any = {
      select: () => b, upsert: () => b, eq: () => b, neq: () => b,
      gte: () => b, limit: () => b, order: () => b,
      then: (resolve: (v: any) => any) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single:      () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles")             return portavaProfileBuilder();
      if (table === "user_follows")         return userFollowsBuilder();
      return emptyBuilder();
    },
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload:       async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://example.com/img.jpg" } }),
        remove:       async () => ({ error: null }),
        list:         async () => ({ data: [], error: null }),
      }),
    },
  } as any;
}

/** Flush two setImmediate ticks so fire-and-forget promises can settle. */
async function flushImmediate() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function makeReq(base: string) {
  return function req(
    method: string,
    path: string,
    body: unknown,
    token: string | null = ME_TOK,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url     = new URL(path, base);
      const payload = JSON.stringify(body);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;

      const r = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port),
          path:     url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      r.write(payload);
      r.end();
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite: onboarding auto-follow
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/me/profile — onboarding auto-follow", () => {
  let server: Server;
  let base: string;
  let req: ReturnType<typeof makeReq>;
  let state: FakeState;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", profileRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    req  = makeReq(base);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  beforeEach(() => {
    state = freshState();
  });

  it("onboardingComplete: true → upserts user_follows row (follower=me, following=portava)", async () => {
    _setTestClient(makeUserClient(state), true);
    _setTestServiceClient(makeServiceClient(state, /* includePortava */ true));

    const res = await req("PATCH", "/api/me/profile", { bio: "hello", onboardingComplete: true });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

    await flushImmediate();

    const followUpserts = state.upserts.filter((u) => u.table === "user_follows");
    assert.equal(
      followUpserts.length,
      1,
      `Expected exactly 1 user_follows upsert, got ${followUpserts.length}`,
    );
    const row = followUpserts[0].data as any;
    assert.equal(row.follower_id,  ME,         "follower_id must be the authed user");
    assert.equal(row.following_id, PORTAVA_ID, "following_id must be the @portava account");
  });

  it("onboardingComplete: false → does NOT create a user_follows row", async () => {
    _setTestClient(makeUserClient(state), true);
    _setTestServiceClient(makeServiceClient(state, /* includePortava */ true));

    const res = await req("PATCH", "/api/me/profile", { bio: "hi", onboardingComplete: false });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

    await flushImmediate();

    const followUpserts = state.upserts.filter((u) => u.table === "user_follows");
    assert.equal(
      followUpserts.length,
      0,
      "onboardingComplete: false must not produce a user_follows upsert",
    );
  });

  it("onboardingComplete absent → does NOT create a user_follows row", async () => {
    _setTestClient(makeUserClient(state), true);
    _setTestServiceClient(makeServiceClient(state, /* includePortava */ true));

    const res = await req("PATCH", "/api/me/profile", { bio: "no onboarding field" });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

    await flushImmediate();

    const followUpserts = state.upserts.filter((u) => u.table === "user_follows");
    assert.equal(
      followUpserts.length,
      0,
      "absent onboardingComplete must not produce a user_follows upsert",
    );
  });

  it("@portava profile absent → returns 200 and produces no user_follows row (graceful)", async () => {
    // Service client has no portava profile row — auto-follow should exit early.
    _setTestClient(makeUserClient(state), true);
    _setTestServiceClient(makeServiceClient(state, /* includePortava */ false));

    const res = await req("PATCH", "/api/me/profile", { bio: "no portava", onboardingComplete: true });
    assert.equal(
      res.status,
      200,
      `Expected 200 even when @portava is absent, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    await flushImmediate();

    const followUpserts = state.upserts.filter((u) => u.table === "user_follows");
    assert.equal(
      followUpserts.length,
      0,
      "No user_follows upsert when @portava profile row does not exist",
    );
  });

  it("onboardingComplete: true called twice → idempotent (no error on either call, correct ids both times)", async () => {
    _setTestClient(makeUserClient(state), true);
    _setTestServiceClient(makeServiceClient(state, /* includePortava */ true));

    const res1 = await req("PATCH", "/api/me/profile", { bio: "first call", onboardingComplete: true });
    assert.equal(res1.status, 200, `First PATCH should be 200, got ${res1.status}: ${JSON.stringify(res1.body)}`);
    await flushImmediate();

    const res2 = await req("PATCH", "/api/me/profile", { bio: "second call", onboardingComplete: true });
    assert.equal(res2.status, 200, `Second PATCH should be 200, got ${res2.status}: ${JSON.stringify(res2.body)}`);
    await flushImmediate();

    const followUpserts = state.upserts.filter((u) => u.table === "user_follows");
    // Both calls trigger the upsert with ignoreDuplicates=true — the DB constraint
    // prevents a duplicate row; both should carry the correct ids.
    assert.equal(
      followUpserts.length,
      2,
      `Expected 2 upsert calls (idempotent), got ${followUpserts.length}`,
    );
    for (const u of followUpserts) {
      const row = u.data as any;
      assert.equal(row.follower_id,  ME,         "follower_id must be the authed user on both calls");
      assert.equal(row.following_id, PORTAVA_ID, "following_id must be portava on both calls");
    }
  });
});
