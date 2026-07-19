/**
 * Passport Stamps — pagination contract tests
 *
 * GET /me/passport/stamps accepts ?limit= & ?offset= and returns
 * { stamps: Stamp[], total: number }.
 *
 * Covers:
 *   1. Default response shape: { stamps, total } with default page size 100
 *   2. ?limit=5&offset=0 returns at most 5 stamps
 *   3. ?offset=N returns stamps starting from the Nth row
 *   4. limit is capped at 200 even if the caller sends a larger value
 *   5. total reflects the full (unpaginated) count of the user's stamps
 *
 * Run: node --import tsx/esm --test src/test/passportStampsPagination.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportStampsRouter from "../routes/passportStamps.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "passport-pagination-token";
const USER_ID = "user-pagination-1";
const OTHER_USER_ID = "user-pagination-2";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    };
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client with real range() / head-count support ───────────────────────

interface FakeState {
  featureFlags: Record<string, boolean>;
  stamps: Record<string, any>[];
}

function makeFakeClient(state: FakeState) {
  const rangeCalls: Array<{ from: number; to: number }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _range: { from: number; to: number } | null = null;
    let _limit: number | null = null;
    let _head = false;
    let _count: string | null = null;

    const builder: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count) _count = opts.count;
        if (opts?.head) _head = true;
        return builder;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      order(col: string, opts?: { ascending?: boolean }) {
        // record ordering; applied in rows()
        _order = { col, ascending: opts?.ascending ?? true };
        return builder;
      },
      limit(n: number) { _limit = n; return builder; },
      range(fromIdx: number, toIdx: number) {
        _range = { from: fromIdx, to: toIdx };
        rangeCalls.push({ from: fromIdx, to: toIdx });
        return builder;
      },
      maybeSingle() {
        const r = rows();
        return Promise.resolve({ data: r[0] ?? null, error: null });
      },
      single() {
        const r = rows();
        return r.length
          ? Promise.resolve({ data: r[0], error: null })
          : Promise.resolve({ data: null, error: { message: "no rows", code: "PGRST116" } });
      },
      then(onF: any, onR: any) {
        if (_head && _count) {
          // head:true count query — data is null, count is the filtered total
          const filtered = allRows().filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: null, count: filtered.length, error: null }).then(onF, onR);
        }
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };

    let _order: { col: string; ascending: boolean } | null = null;

    function allRows(): any[] {
      if (table === "feature_flags") {
        return Object.entries(state.featureFlags).map(([flag, enabled]) => ({ flag, enabled }));
      }
      if (table === "passport_stamps") return state.stamps;
      return [];
    }

    function rows(): any[] {
      let r = allRows().filter((row) => filters.every((f) => f(row)));
      if (_order) {
        const { col, ascending } = _order;
        r = [...r].sort((a, b) => {
          const av = a[col] ?? "";
          const bv = b[col] ?? "";
          return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (_range) r = r.slice(_range.from, _range.to + 1);
      else if (_limit !== null) r = r.slice(0, _limit);
      return r;
    }

    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) =>
        token === FAKE_TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from,
    _rangeCalls: rangeCalls,
  };
  return client;
}

// ── Seed data: 12 stamps for USER_ID + 3 for another user ────────────────────

function makeStamp(i: number, userId: string) {
  // earned_at descending order by index: i=0 is the most recent stamp.
  const day = String(28 - i).padStart(2, "0");
  return {
    id: `stamp-${userId}-${i}`,
    user_id: userId,
    stamp_type: "city",
    country: "Japan",
    city: `City ${i}`,
    neighborhood: null,
    place_id: null,
    plan_id: null,
    trip_id: null,
    source_type: "gps",
    verification_level: "gps",
    visibility: "public",
    earned_at: `2026-02-${day}T00:00:00Z`,
    created_at: `2026-02-${day}T00:00:00Z`,
  };
}

const MY_STAMP_COUNT = 12;

function seedState(): FakeState {
  return {
    featureFlags: { passport_stamps_enabled: true },
    stamps: [
      ...Array.from({ length: MY_STAMP_COUNT }, (_, i) => makeStamp(i, USER_ID)),
      ...Array.from({ length: 3 }, (_, i) => makeStamp(i, OTHER_USER_ID)),
    ],
  };
}

let client: ReturnType<typeof makeFakeClient>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", passportStampsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;

  client = makeFakeClient(seedState());
  _setTestClient(client, true);
  _setTestServiceClient(client);
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /me/passport/stamps — pagination contract", () => {
  it("default response returns { stamps: [...], total: <number> }", async () => {
    const r = await req("GET", "/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.stamps), "stamps must be an array");
    assert.equal(typeof r.body.total, "number", "total must be a number");
    assert.equal(r.body.stamps.length, MY_STAMP_COUNT, "all 12 stamps fit in the default page");
    assert.equal(r.body.total, MY_STAMP_COUNT);
  });

  it("default page size is 100 (range 0..99)", async () => {
    client._rangeCalls.length = 0;
    const r = await req("GET", "/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.equal(client._rangeCalls.length, 1, "exactly one ranged query");
    assert.deepEqual(client._rangeCalls[0], { from: 0, to: 99 }, "default limit must be 100");
  });

  it("?limit=5&offset=0 returns at most 5 stamps", async () => {
    const r = await req("GET", "/api/me/passport/stamps?limit=5&offset=0");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, 5, "must return exactly limit stamps");
    assert.equal(r.body.total, MY_STAMP_COUNT, "total still reflects the full count");
  });

  it("?offset=N returns stamps starting from the Nth row", async () => {
    const page1 = await req("GET", "/api/me/passport/stamps?limit=5&offset=0");
    const page2 = await req("GET", "/api/me/passport/stamps?limit=5&offset=5");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.stamps.length, 5);

    // No overlap between page 1 and page 2
    const ids1 = new Set(page1.body.stamps.map((s: any) => s.id));
    for (const s of page2.body.stamps) {
      assert.ok(!ids1.has(s.id), `stamp ${s.id} must not appear on both pages`);
    }

    // page2 starts exactly at the 6th row of the ordered set (earned_at desc)
    const all = await req("GET", "/api/me/passport/stamps");
    assert.equal(page2.body.stamps[0].id, all.body.stamps[5].id, "offset=5 starts at the 6th row");

    // last (partial) page
    const page3 = await req("GET", "/api/me/passport/stamps?limit=5&offset=10");
    assert.equal(page3.body.stamps.length, 2, "final page holds the remaining 2 stamps");
    assert.equal(page3.body.total, MY_STAMP_COUNT);
  });

  it("limit is capped at 200 even if the caller sends a larger value", async () => {
    client._rangeCalls.length = 0;
    const r = await req("GET", "/api/me/passport/stamps?limit=5000");
    assert.equal(r.status, 200);
    assert.equal(client._rangeCalls.length, 1);
    assert.deepEqual(client._rangeCalls[0], { from: 0, to: 199 }, "limit must be capped at 200");
  });

  it("non-numeric / out-of-range params fall back safely", async () => {
    client._rangeCalls.length = 0;
    const r = await req("GET", "/api/me/passport/stamps?limit=abc&offset=-9");
    assert.equal(r.status, 200);
    assert.deepEqual(client._rangeCalls[0], { from: 0, to: 99 }, "bad limit → default 100, bad offset → 0");
    assert.equal(r.body.total, MY_STAMP_COUNT);
  });

  it("total matches a separate count of the user's stamps (excludes other users)", async () => {
    const r = await req("GET", "/api/me/passport/stamps?limit=1");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, 1);
    const myCount = seedState().stamps.filter((s) => s.user_id === USER_ID).length;
    assert.equal(r.body.total, myCount, "total must equal the user's full stamp count, not page size");
  });

  it("total respects filters (?country=) alongside pagination", async () => {
    // Add one stamp in another country for this user
    const extra = { ...makeStamp(0, USER_ID), id: "stamp-thailand-1", country: "Thailand", city: "Bangkok" };
    const state = seedState();
    state.stamps.push(extra);
    client = makeFakeClient(state);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/me/passport/stamps?country=Thailand&limit=5");
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1, "total must be the filtered count");
    assert.equal(r.body.stamps.length, 1);
    assert.equal(r.body.stamps[0].id, "stamp-thailand-1");
  });
});
