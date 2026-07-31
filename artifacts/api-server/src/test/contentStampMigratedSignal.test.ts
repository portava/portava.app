/**
 * contentStampMigratedSignal.test.ts
 *
 * Verifies that the Compass "liked" outcome signal is NOT fired when a user
 * stamps an entity whose content_stamps row was already inserted by the
 * 2049_content_stamps migration (i.e. migrated_from IS NOT NULL).
 *
 * Without this guard the intelligence graph would double-count the signal:
 * once from the original /posts/:id/like endpoint and once from the new stamp
 * route, inflating affinity scores for early-adopter content.
 *
 * Also verifies the positive case: a genuinely new stamp (no prior row) DOES
 * produce an outcome event when a served recommendation exists.
 *
 * Suite overview:
 *   A — Migrated row (migrated_from = 'posts_likes'):
 *       POST /stamps → 200, compass_outcome_events stays empty
 *   B — Re-stamp of existing non-migrated row:
 *       POST /stamps → 200, compass_outcome_events stays empty
 *   C — New stamp with a recommendation in the window:
 *       POST /stamps → 200, compass_outcome_events gets one row
 *
 * Runtime: node:test + node:assert/strict, fake Supabase client.
 * Run: node --import tsx/esm --test src/test/contentStampMigratedSignal.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

// ── Fixed test IDs ────────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-1111-4000-8000-000000000001";
const BOB_ID    = "bbbbbbbb-1111-4000-8000-000000000001";
const POST_ID   = "cccccccc-1111-4000-8000-000000000001";
const REC_ID    = "dddddddd-1111-4000-8000-000000000001";

// ── Test infrastructure ───────────────────────────────────────────────────────

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port as number;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function makeApp(router: any): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", router);
  return app;
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
//
// Supports the tables used by contentStamps.ts and CompassOutcomeEngine.ts:
//   posts, blocks, content_stamps, compass_served_recommendations,
//   compass_outcome_events, compass_user_preferences.
//
// Unknown tables return empty arrays so fire-and-forget calls never throw.

type DB = Record<string, any[]>;

function makeClient(initial: DB = {}) {
  const db: DB = {
    posts:                         [],
    blocks:                        [],
    content_stamps:                [],
    compass_served_recommendations: [],
    compass_outcome_events:        [],
    compass_user_preferences:      [],
    ...initial,
  };

  function from(table: string) {
    const eqFilters: Array<(r: any) => boolean> = [];
    let _select   = false;
    let _isCount  = false;
    let _isHead   = false;
    let _insert: any  = null;
    let _upsert: any  = null;
    let _isDelete = false;
    let _limit: number | null = null;

    const tbl = () => {
      if (!db[table]) db[table] = [];
      return db[table]!;
    };
    const rows = () => tbl().filter((r) => eqFilters.every((f) => f(r)));

    const b: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        _select = true;
        if (opts?.count === "exact") _isCount = true;
        if (opts?.head) _isHead = true;
        return b;
      },
      insert(data: any) {
        _insert = Array.isArray(data) ? data : [data];
        return b;
      },
      upsert(data: any, _opts?: any) {
        _upsert = Array.isArray(data) ? data : [data];
        return b;
      },
      delete()  { _isDelete = true; return b; },
      eq(col: string, val: any) { eqFilters.push((r) => r[col] === val); return b; },
      neq()     { return b; },
      in(col: string, vals: any[]) {
        eqFilters.push((r) => vals.includes(r[col]));
        return b;
      },
      or()      { return b; },
      gte()     { return b; },
      lte()     { return b; },
      order()   { return b; },
      not()     { return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    async function resolveSingle(maybe: boolean) {
      if (_isDelete) {
        tbl().splice(0, tbl().length, ...tbl().filter((r) => !eqFilters.every((f) => f(r))));
        return { data: null, error: null };
      }
      if (_upsert) {
        for (const row of _upsert) tbl().push({ id: `id-${Math.random()}`, ...row });
        return { data: null, error: null };
      }
      if (_insert) {
        for (const row of (_insert as any[])) tbl().push({ id: `id-${Math.random()}`, ...row });
        return { data: _insert[0], error: null };
      }
      const matched = rows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (_isDelete) {
        tbl().splice(0, tbl().length, ...tbl().filter((r) => !eqFilters.every((f) => f(r))));
        return { data: [], count: 0, error: null };
      }
      if (_upsert) {
        for (const row of _upsert) tbl().push({ id: `id-${Math.random()}`, ...row });
        return { data: null, count: 0, error: null };
      }
      if (_insert) {
        for (const row of (_insert as any[])) tbl().push({ id: `id-${Math.random()}`, ...row });
        return { data: _insert, count: _insert.length, error: null };
      }
      let matched = rows();
      if (_limit !== null) matched = matched.slice(0, _limit);
      if (_isCount) return { data: null, count: matched.length, error: null };
      return { data: matched, count: matched.length, error: null };
    }

    return b;
  }

  return {
    db,
    client: {
      from,
      auth: {
        getUser: async (token: string) =>
          token === "alice-tok"
            ? { data: { user: { id: ALICE_ID } }, error: null }
            : { data: { user: null }, error: { message: "invalid token" } },
      },
    },
  };
}

// =============================================================================
// A — Migrated row: POST /stamps must NOT fire an outcome signal
// =============================================================================

describe("A — migrated stamp row suppresses outcome signal", () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DB;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");

    const fake = makeClient({
      posts: [
        { id: POST_ID, author_id: BOB_ID, visibility: "public", trip_id: null, status: "active" },
      ],
      blocks: [],
      // Pre-seeded migrated stamp — marks that this like came from posts_likes.
      content_stamps: [
        {
          id: "existing-stamp-id",
          user_id: ALICE_ID,
          entity_type: "post",
          entity_id: POST_ID,
          migrated_from: "posts_likes",
        },
      ],
      // A served recommendation exists so the signal WOULD succeed if called.
      compass_served_recommendations: [
        {
          recommendation_id: REC_ID,
          user_id: ALICE_ID,
          item_id: POST_ID,
          item_type: "post",
          ranking_factors: { compassMatch: 72 },
          created_at: new Date().toISOString(),
        },
      ],
      compass_outcome_events: [],
    });

    db = fake.db;
    _setTestClient(fake.client as any, true);

    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("returns 200 with isStamped:true", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: POST_ID }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.isStamped, true);
  });

  it("does NOT write a compass_outcome_events row", async () => {
    // linkOutcomeSignal is fire-and-forget (void). Give any in-flight async
    // work a chance to settle before asserting the table is still empty.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      db["compass_outcome_events"]!.length,
      0,
      "migrated stamp must not produce a second outcome signal",
    );
  });
});

// =============================================================================
// B — Re-stamp (existing non-migrated row): no duplicate signal
// =============================================================================

describe("B — re-stamp of existing non-migrated row suppresses outcome signal", () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DB;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");

    const fake = makeClient({
      posts: [
        { id: POST_ID, author_id: BOB_ID, visibility: "public", trip_id: null, status: "active" },
      ],
      blocks: [],
      // Pre-existing stamp created via the new endpoint (no migrated_from).
      content_stamps: [
        {
          id: "existing-stamp-id",
          user_id: ALICE_ID,
          entity_type: "post",
          entity_id: POST_ID,
          migrated_from: null,
        },
      ],
      compass_served_recommendations: [
        {
          recommendation_id: REC_ID,
          user_id: ALICE_ID,
          item_id: POST_ID,
          item_type: "post",
          ranking_factors: { compassMatch: 72 },
          created_at: new Date().toISOString(),
        },
      ],
      compass_outcome_events: [],
    });

    db = fake.db;
    _setTestClient(fake.client as any, true);

    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("returns 200", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: POST_ID }),
    });
    assert.equal(r.status, 200);
  });

  it("does NOT write a compass_outcome_events row for a re-stamp", async () => {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      db["compass_outcome_events"]!.length,
      0,
      "re-stamp of existing row must not produce a duplicate outcome signal",
    );
  });
});

// =============================================================================
// C — New stamp: outcome signal IS fired when no prior row exists
// =============================================================================

describe("C — new stamp fires an outcome signal", () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DB;

  before(async () => {
    const { default: router } = await import("../routes/contentStamps.js");

    const fake = makeClient({
      posts: [
        { id: POST_ID, author_id: BOB_ID, visibility: "public", trip_id: null, status: "active" },
      ],
      blocks: [],
      content_stamps: [], // no prior stamp — this is a fresh interaction
      compass_served_recommendations: [
        {
          recommendation_id: REC_ID,
          user_id: ALICE_ID,
          item_id: POST_ID,
          item_type: "post",
          ranking_factors: { compassMatch: 72 },
          created_at: new Date().toISOString(),
        },
      ],
      compass_outcome_events: [],
    });

    db = fake.db;
    _setTestClient(fake.client as any, true);

    const srv = await startServer(makeApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(() => close());

  it("returns 200 with isStamped:true", async () => {
    const r = await fetch(`${url}/api/stamps`, {
      method: "POST",
      headers: bearer("alice-tok"),
      body: JSON.stringify({ entityType: "post", entityId: POST_ID }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.isStamped, true);
  });

  it("writes exactly one compass_outcome_events row", async () => {
    // linkOutcomeSignal is fire-and-forget; allow the event loop to drain.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      db["compass_outcome_events"]!.length,
      1,
      "a new stamp must produce exactly one outcome signal",
    );
    const evt = db["compass_outcome_events"]![0]!;
    assert.equal(evt["user_id"],  ALICE_ID, "event user_id matches stamper");
    assert.equal(evt["item_id"],  POST_ID,  "event item_id matches stamped entity");
    assert.equal(evt["stage"],    "liked",  "outcome stage is 'liked'");
  });
});
