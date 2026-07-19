/**
 * Passport Stamps — total-count fallback tests
 *
 * When the head-count query for GET /me/passport/stamps errors (or returns a
 * null count) while the paginated stamps fetch succeeds, `total` must NOT be
 * silently reported as 0 alongside a non-empty stamps array. Instead the route
 * falls back to offset + stamps.length as a lower bound.
 *
 * Run: node --import tsx/esm --test src/test/passportStampsCountFallback.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportStampsRouter from "../routes/passportStamps.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "passport-count-fallback-token";
const USER_ID = "user-count-fallback-1";

function req(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
        headers: { authorization: `Bearer ${FAKE_TOKEN}` },
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
    r.end();
  });
}

// ── Fake client: count query fails / returns null; row fetches succeed ───────

interface FakeState {
  featureFlags: Record<string, boolean>;
  stamps: Record<string, any>[];
  // Behavior of the head-count query:
  //   "error"      → resolves { data: null, count: null, error: {...} }
  //   "null-count" → resolves { data: null, count: null, error: null }
  //   "throw"      → the awaited builder rejects
  //   "ok"         → normal counting behavior
  countMode: "error" | "null-count" | "throw" | "ok";
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _range: { from: number; to: number } | null = null;
    let _limit: number | null = null;
    let _head = false;
    let _count: string | null = null;
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

    const builder: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count) _count = opts.count;
        if (opts?.head) _head = true;
        return builder;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      order(col: string, opts?: { ascending?: boolean }) {
        _order = { col, ascending: opts?.ascending ?? true };
        return builder;
      },
      limit(n: number) { _limit = n; return builder; },
      range(fromIdx: number, toIdx: number) { _range = { from: fromIdx, to: toIdx }; return builder; },
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
        if (_head && _count && table === "passport_stamps") {
          switch (state.countMode) {
            case "error":
              return Promise.resolve({ data: null, count: null, error: { message: "count failed", code: "XX000" } }).then(onF, onR);
            case "null-count":
              return Promise.resolve({ data: null, count: null, error: null }).then(onF, onR);
            case "throw":
              return Promise.reject(new Error("count query blew up")).then(onF, onR);
            case "ok": {
              const filtered = allRows().filter((r) => filters.every((f) => f(r)));
              return Promise.resolve({ data: null, count: filtered.length, error: null }).then(onF, onR);
            }
          }
        }
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };

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
  };
  return client;
}

// ── Seed data ─────────────────────────────────────────────────────────────────

function makeStamp(i: number) {
  const day = String(28 - i).padStart(2, "0");
  return {
    id: `stamp-${i}`,
    user_id: USER_ID,
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

const STAMP_COUNT = 8;

let state: FakeState;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", passportStampsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  state = {
    featureFlags: { passport_stamps_enabled: true },
    stamps: Array.from({ length: STAMP_COUNT }, (_, i) => makeStamp(i)),
    countMode: "ok",
  };
  const client = makeFakeClient(state);
  _setTestClient(client, true);
  _setTestServiceClient(client);
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /me/passport/stamps — total-count fallback", () => {
  it("count query returns an error → total falls back to stamps.length, not 0", async () => {
    state.countMode = "error";
    const r = await req("/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, STAMP_COUNT, "stamps fetch still succeeds");
    assert.notEqual(r.body.total, 0, "total must not be 0 alongside a non-empty stamps array");
    assert.equal(r.body.total, STAMP_COUNT, "total falls back to the fetched page length");
  });

  it("count query returns count=null without an error → same fallback", async () => {
    state.countMode = "null-count";
    const r = await req("/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, STAMP_COUNT);
    assert.equal(r.body.total, STAMP_COUNT, "null count must not surface as total=0");
  });

  it("count query throws → same fallback", async () => {
    state.countMode = "throw";
    const r = await req("/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, STAMP_COUNT);
    assert.equal(r.body.total, STAMP_COUNT);
  });

  it("fallback accounts for offset: total = offset + page length", async () => {
    state.countMode = "error";
    const r = await req("/api/me/passport/stamps?limit=3&offset=5");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, 3);
    assert.equal(r.body.total, 8, "total = offset (5) + page length (3)");
  });

  it("count failure with an empty result set still yields total=0 (genuinely empty)", async () => {
    state.countMode = "error";
    state.stamps = [];
    const r = await req("/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, 0);
    assert.equal(r.body.total, 0, "empty page + no offset → total 0 is correct");
  });

  it("healthy count query still returns the exact total (no regression)", async () => {
    const r = await req("/api/me/passport/stamps?limit=3");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, 3);
    assert.equal(r.body.total, STAMP_COUNT, "exact count wins when the count query succeeds");
  });
});
