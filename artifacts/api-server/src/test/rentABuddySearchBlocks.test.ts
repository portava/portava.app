/**
 * POST /api/rent-a-buddy/search — the block filter.
 *
 * WHAT THIS PROVES
 * ================
 * Blocking is a safety feature, and the marketplace search is the one place a
 * blocked person is most visible: a browsable list of people to hire. Until
 * this filter existed, a buddy the viewer had blocked — or who had blocked the
 * viewer — still appeared in it.
 *
 * The route reuses lib/blocks.fetchBlockedSet, the same resolver
 * lib/buddyMapRead hands the map layer. These tests pin the three properties
 * that make that reuse worth anything:
 *
 *   1. BIDIRECTIONAL. Both "I blocked them" (blocker_id = viewer) and "they
 *      blocked me" (blocked_id = viewer) remove the buddy. Only asserting one
 *      direction would pass against a half-implemented filter.
 *   2. FAIL-CLOSED. When the `blocks` table cannot be read, the response is
 *      EMPTY — never the unfiltered list. A block filter that fails open is
 *      worse than none, because it looks like it works.
 *   3. NARROWING ONLY. With no blocks, and for an anonymous caller who has no
 *      block relationships at all, every visible buddy is still served.
 *
 * The fake client returns whole rows for `blocks` regardless of the `.or()`
 * expression, and the assertions below therefore test the ROUTE's use of the
 * resolved set rather than the fake's filtering. Bidirectionality is asserted
 * against fetchBlockedSet's real behaviour by seeding rows in each direction
 * and letting the real resolver classify them.
 *
 * Run:
 *   node --import tsx/esm --test src/test/rentABuddySearchBlocks.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import rentABuddyRouter from "../routes/rentABuddy.js";

const TOKEN = "search-blocks-test-token";
const VIEWER = "viewer-user-id";

/** Buddy A — the viewer blocks them. */
const U_A = "buddy-user-a";
/** Buddy B — they block the viewer. */
const U_B = "buddy-user-b";
/** Buddy C — no block relationship in either direction. */
const U_C = "buddy-user-c";

function buddyRow(id: string, userId: string): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    display_name: `Buddy ${id}`,
    tagline: null,
    bio: null,
    city: "Da Nang",
    country: "VN",
    status: "active",
    admin_status: "active",
    verified: true,
    verified_at: "2026-01-02T00:00:00.000Z",
    languages: ["en"],
    categories: ["food"],
    hourly_rate_usd: "20",
    review_count: 5,
    average_rating: "4.5",
    completed_count: 3,
    response_time_h: "2",
    buddy_level: "seasoned",
    meetup_base_lat: 16.06,
    meetup_base_lng: 108.21,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

const ROWS = [buddyRow("a", U_A), buddyRow("b", U_B), buddyRow("c", U_C)];

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec {
  rows?: any[];
  error?: { message: string };
}
type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  let count = rows.length;
  const err = spec.error ?? null;
  const sync = () => { count = rows.length; };
  const result = () =>
    err ? { data: null, count: null, error: err } : { data: rows, count, error: null };

  const q: any = {
    select() { return q; },
    order() { return q; },
    limit(n: number) { sync(); rows = rows.slice(0, n); return q; },
    range(from: number, to: number) { sync(); rows = rows.slice(from, to + 1); return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); sync(); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); sync(); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); sync(); return q; },
    not() { return q; },
    ilike(col: string, pattern: string) {
      const needle = String(pattern).replace(/%/g, "").toLowerCase();
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase().includes(needle));
      sync();
      return q;
    },
    contains(col: string, vals: any[]) {
      rows = rows.filter((r) => Array.isArray(r[col]) && vals.every((v) => r[col].includes(v)));
      sync();
      return q;
    },
    // fetchBlockedSet's only operator. Left unfiltered on purpose: the block
    // ROWS are the fixture, and the assertions are about what the route does
    // with the set the real resolver builds from them.
    or() { return q; },
    maybeSingle() {
      return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(specOf(state, table)),
  };
}

function state(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "rent_buddy_enabled", enabled: true }],
    rent_buddy_profiles: ROWS,
    blocks: [],
    ...over,
  };
}

// ── test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function search(body: unknown, opts: { anonymous?: boolean } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/rent-a-buddy/search", base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(opts.anonymous ? {} : { authorization: `Bearer ${TOKEN}` }),
        },
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
    r.write(payload);
    r.end();
  });
}

async function run(s: FakeState, opts: { anonymous?: boolean } = {}) {
  _setTestClient(makeClient(s) as any, true);
  const res = await search({ perPage: 100 }, opts);
  return {
    status: res.status,
    total: res.body?.total,
    ids: ((res.body?.buddies ?? []) as any[]).map((b) => String(b.id)).sort(),
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use("/api", rentABuddyRouter);
  await new Promise<void>((resolve) => {
    // Bind loopback explicitly: a host-less listen(0) binds [::] and a foreign
    // IPv4 listener can then answer the request.
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/rent-a-buddy/search — blocked buddies", () => {
  it("lists every visible buddy when there are no blocks (the baseline)", async () => {
    const { status, ids, total } = await run(state());
    assert.equal(status, 200);
    assert.deepEqual(ids, ["a", "b", "c"], "no block must remove nobody");
    assert.equal(total, 3);
  });

  it("hides a buddy the VIEWER blocked (blocker_id = viewer)", async () => {
    const { status, ids } = await run(
      state({ blocks: [{ blocker_id: VIEWER, blocked_id: U_A }] }),
    );
    assert.equal(status, 200);
    assert.deepEqual(ids, ["b", "c"], "a buddy the viewer blocked must not be listed");
  });

  it("hides a buddy who blocked the VIEWER (blocked_id = viewer) — the other direction", async () => {
    const { status, ids } = await run(
      state({ blocks: [{ blocker_id: U_B, blocked_id: VIEWER }] }),
    );
    assert.equal(status, 200);
    assert.deepEqual(
      ids,
      ["a", "c"],
      "a block is symmetric for visibility: being blocked hides them too",
    );
  });

  it("hides both directions at once and leaves the unblocked buddy", async () => {
    const { status, ids } = await run(
      state({
        blocks: [
          { blocker_id: VIEWER, blocked_id: U_A },
          { blocker_id: U_B, blocked_id: VIEWER },
        ],
      }),
    );
    assert.equal(status, 200);
    assert.deepEqual(ids, ["c"], "only the buddy with no block relationship survives");
  });

  it("does not count blocked buddies in `total`", async () => {
    const { total } = await run(
      state({
        blocks: [
          { blocker_id: VIEWER, blocked_id: U_A },
          { blocker_id: U_B, blocked_id: VIEWER },
        ],
      }),
    );
    assert.equal(total, 1, "the pagination total must not advertise buddies we refuse to serve");
  });

  it("exposes NOBODY when the block set cannot be read (fail-closed)", async () => {
    const { status, ids, total } = await run(
      state({ blocks: { error: { message: "blocks down" } } }),
    );
    assert.equal(status, 200);
    assert.deepEqual(
      ids,
      [],
      "unknown block state must mean 'expose nobody', never 'no blocks' — " +
        "a filter that fails open looks like it works and does not",
    );
    assert.equal(total, 0);
  });

  it("still filters when a proximity origin is supplied (the ranked path)", async () => {
    // With lat/lng the route takes its proximity branch: a different pagination
    // path, and the one that would geocode an un-pinned buddy's city. The block
    // filter runs before all of it.
    _setTestClient(makeClient(state({ blocks: [{ blocker_id: VIEWER, blocked_id: U_A }] })) as any, true);
    const res = await search({ perPage: 100, lat: 16.05, lng: 108.2 });
    assert.equal(res.status, 200);
    assert.deepEqual(
      ((res.body.buddies ?? []) as any[]).map((b) => String(b.id)).sort(),
      ["b", "c"],
    );
  });

  it("serves an anonymous caller normally — they have no block relationships", async () => {
    // The endpoint is public. An anonymous viewer has nothing to resolve, so
    // there is no unknown state and nothing to fail closed about; the rows they
    // see are unchanged from before the filter existed.
    const { status, ids } = await run(
      state({ blocks: [{ blocker_id: VIEWER, blocked_id: U_A }] }),
      { anonymous: true },
    );
    assert.equal(status, 200);
    assert.deepEqual(ids, ["a", "b", "c"]);
  });

  it("does not fail closed for an anonymous caller when blocks are unreadable", async () => {
    const { status, ids } = await run(
      state({ blocks: { error: { message: "blocks down" } } }),
      { anonymous: true },
    );
    assert.equal(status, 200);
    assert.deepEqual(
      ids,
      ["a", "b", "c"],
      "no viewer means no block read at all — an unrelated outage must not empty a public list",
    );
  });

  it("runs the filter AFTER payload validation, so bad coords still 400", async () => {
    // Ordering matters: resolving blocks first would turn an invalid_payload
    // into a 200-with-nothing whenever the blocks table was unhealthy.
    _setTestClient(makeClient(state({ blocks: { error: { message: "blocks down" } } })) as any, true);
    const res = await search({ lat: "16.05", lng: 108.2 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_payload");
  });
});
