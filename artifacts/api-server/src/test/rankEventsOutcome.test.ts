/**
 * POST /api/rank-events/outcome — node:test
 *
 * Covers:
 *  A. Valid tap on an existing impression row → 200, outcome + outcome_at updated.
 *  B. No prior impression row → 404, no phantom rows created.
 *  C. An outcome NEVER touches content_distribution_stats — the exposure
 *     denominator is written on the impression path (00_STATUS defect 4).
 *  D. Funnel-rung upgrades: a stronger outcome upgrades a row already holding
 *     a weaker one; a weaker or equal outcome never downgrades (404).
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Fake Supabase client injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/rankEventsOutcome.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID   = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const ITEM_ID    = "item1111-1111-1111-1111-111111111111";
const ROW_ID     = "row00000-0000-0000-0000-000000000001";
const SESSION_ID = "5e550000-0000-0000-0000-000000000001";

// ── Fake client factory ───────────────────────────────────────────────────────

interface UpdateCapture {
  table: string;
  patch: Record<string, any>;
  filterCol: string;
  filterVal: any;
}

interface RpcCapture { name: string; params: Record<string, any> }

function makeClient(opts: {
  rankEventsRows?: Array<Record<string, any>>;
  updateCaptures?: UpdateCapture[];
  rpcCaptures?: RpcCapture[];
} = {}) {
  const rankEventsRows = opts.rankEventsRows ?? [];
  const updateCaptures = opts.updateCaptures ?? [];
  const rpcCaptures    = opts.rpcCaptures    ?? [];

  const db: Record<string, any[]> = {
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    rank_events: rankEventsRows,
  };

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];

    const b: any = {
      select: (_cols?: string) => builder(table, rows),
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      // Real ordering + limit, so "most recent row wins" is proven rather than
      // an accident of fixture array order.
      order: (col: string, opts?: { ascending?: boolean }) => {
        const dir = (opts?.ascending ?? true) ? 1 : -1;
        filtered = [...filtered].sort((x, y) =>
          x[col] < y[col] ? -dir : x[col] > y[col] ? dir : 0,
        );
        return b;
      },
      limit: (n: number) => {
        filtered = filtered.slice(0, n);
        return b;
      },
      maybeSingle: () =>
        Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () =>
        Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) =>
        resolve({ data: [...filtered], error: null }),
    };
    return b;
  }

  function updateBuilder(table: string, patch: Record<string, any>) {
    let filterCol = "";
    let filterVal: any;

    const u: any = {
      eq: (col: string, val: any) => {
        filterCol = col;
        filterVal = val;
        // Execute: record the update capture and apply to db rows
        const updated = (db[table] ?? []).map((r) =>
          r[filterCol] === filterVal ? { ...r, ...patch } : r,
        );
        db[table] = updated;
        updateCaptures.push({ table, patch, filterCol, filterVal });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return u;
  }

  return {
    auth: {
      getUser: (token?: string) => {
        if (token === "alice-token") {
          return Promise.resolve({
            data: { user: { id: ALICE_ID } },
            error: null,
          });
        }
        return Promise.resolve({
          data: { user: null },
          error: { message: "no token" },
        });
      },
    },
    from: (table: string) => {
      const rows = db[table] ?? [];
      return {
        select: (_cols?: string) => builder(table, rows),
        update: (patch: Record<string, any>) => updateBuilder(table, patch),
        insert: (_data: any) =>
          Promise.resolve({ data: null, error: null }),
      };
    },
    rpc: (name: string, params?: any) => {
      rpcCaptures.push({ name, params: params ?? {} });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

// ── Server helpers ────────────────────────────────────────────────────────────

async function startServer(
  app: Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

async function makeApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: rankEventsRouter } = await import("../routes/rankEvents.js");
  app.use("/api", rankEventsRouter);
  return app;
}

// ── A: Impression row exists — outcome is upgraded ────────────────────────────

describe("POST /api/rank-events/outcome — A: existing impression row", async () => {
  let url: string;
  let close: () => Promise<void>;
  let updateCaptures: UpdateCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));

    updateCaptures = [];
    _setTestClient(
      makeClient({
        rankEventsRows: [
          {
            id:         ROW_ID,
            user_id:    ALICE_ID,
            item_id:    ITEM_ID,
            item_kind:  "post",
            surface:    "pulse",
            outcome:    "impression",
            position:   0,
            features:   {},
            served_at:  new Date().toISOString(),
            session_id: SESSION_ID,
            outcome_at: null,
          },
        ],
        updateCaptures,
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 200 and upgrades outcome + sets outcome_at", async () => {
    const r = await fetch(`${url}/api/rank-events/outcome`, {
      method:  "POST",
      headers: {
        Authorization:  "Bearer alice-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item_id:    ITEM_ID,
        surface:    "pulse",
        outcome:    "tap",
        session_id: SESSION_ID,
      }),
    });

    assert.equal(r.status, 200, "expected 200 OK");
    const body = await r.json() as any;
    assert.equal(body.ok, true, "response body should be { ok: true }");

    // Verify exactly one update was recorded
    assert.equal(updateCaptures.length, 1, "expected exactly one DB update");
    const cap = updateCaptures[0]!;
    assert.equal(cap.table,     "rank_events", "update must target rank_events");
    assert.equal(cap.patch.outcome, "tap",     "outcome must be set to tap");
    assert.ok(
      typeof cap.patch.outcome_at === "string" && cap.patch.outcome_at.length > 0,
      "outcome_at must be a non-empty ISO string",
    );
    assert.equal(cap.filterCol, "id",          "update must be filtered by id");
    assert.equal(cap.filterVal, ROW_ID,        "must update the correct row");
  });
});

// ── C: An outcome never moves the exposure denominator ────────────────────────
//
// content_distribution_stats.eligible_impressions is the EXPOSURE denominator.
// This route used to be its only writer ("an outcome confirms the impression
// was real"), which made the column count conversions — 00_STATUS defect 4 /
// fact layer §4.6. The counter is now incremented on the impression path
// (lib/rankLog.ts, lib/discoveryServeLog.ts; pinned in
// distributionStatsExposure.test.ts). Two outcomes here must therefore produce
// ZERO increment_distribution_stats calls — and, as before, never a literal
// upsert that would reset the counters (the fake has no `upsert`, so one would
// throw and fail the request).

describe("POST /api/rank-events/outcome — C: an outcome never touches the exposure denominator", async () => {
  let url: string;
  let close: () => Promise<void>;
  let rpcCaptures: RpcCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));

    rpcCaptures = [];
    _setTestClient(
      makeClient({
        rankEventsRows: [
          {
            id:         ROW_ID,
            user_id:    ALICE_ID,
            item_id:    ITEM_ID,
            item_kind:  "post",
            surface:    "pulse",
            outcome:    "impression",
            position:   0,
            features:   {},
            served_at:  new Date().toISOString(),
            session_id: SESSION_ID,
            outcome_at: null,
          },
          // Second impression row so the second request also finds a row
          {
            id:         "row00000-0000-0000-0000-000000000002",
            user_id:    ALICE_ID,
            item_id:    ITEM_ID,
            item_kind:  "post",
            surface:    "pulse",
            outcome:    "impression",
            position:   1,
            features:   {},
            served_at:  new Date().toISOString(),
            session_id: SESSION_ID,
            outcome_at: null,
          },
        ],
        rpcCaptures,
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("records both outcomes and calls increment_distribution_stats ZERO times — outcomes are numerator events", async () => {
    const postOutcome = () =>
      fetch(`${url}/api/rank-events/outcome`, {
        method:  "POST",
        headers: {
          Authorization:  "Bearer alice-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          item_id:    ITEM_ID,
          surface:    "pulse",
          outcome:    "tap",
          session_id: SESSION_ID,
        }),
      });

    // Fire two outcomes for the same item
    const [r1, r2] = await Promise.all([postOutcome(), postOutcome()]);
    assert.equal(r1.status, 200, "first outcome must return 200");
    assert.equal(r2.status, 200, "second outcome must return 200");

    // Let any fire-and-forget work settle before counting.
    await new Promise((r) => setImmediate(r));

    const statsRpcs = rpcCaptures.filter(
      (c) => c.name === "increment_distribution_stats",
    );
    assert.equal(
      statsRpcs.length,
      0,
      "an outcome must NOT increment eligible_impressions — that made the exposure " +
      "denominator a count of conversions (00_STATUS defect 4); the impression " +
      "path owns the counter now",
    );
  });
});

// ── D: Funnel-rung upgrades ───────────────────────────────────────────────────
//
// rank_events is a mutable-state table: an outcome UPDATES the impression row.
// The row can hold one outcome, so it must be the furthest rung reached. A
// 'tap' (discovery: card opened) followed by a 'save' (from inside the detail
// sheet) must land as 'save'; previously the tap consumed the row and the save
// 404'd — the strongest discovery signal was lost.

function impressionRow(id: string, outcome: string, servedAt: string) {
  return {
    id,
    user_id:    ALICE_ID,
    item_id:    ITEM_ID,
    item_kind:  "place",
    surface:    "discovery",
    outcome,
    position:   0,
    features:   {},
    served_at:  servedAt,
    session_id: SESSION_ID,
    outcome_at: outcome === "impression" ? null : servedAt,
  };
}

async function postDiscoveryOutcome(url: string, outcome: string) {
  return fetch(`${url}/api/rank-events/outcome`, {
    method:  "POST",
    headers: {
      Authorization:  "Bearer alice-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ item_id: ITEM_ID, surface: "discovery", outcome }),
  });
}

describe("POST /api/rank-events/outcome — D: a stronger outcome upgrades a weaker row", async () => {
  let url: string;
  let close: () => Promise<void>;
  let updateCaptures: UpdateCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("'save' after 'tap' on the same impression upgrades the row to 'save' (200)", async () => {
    updateCaptures = [];
    _setTestClient(
      makeClient({
        rankEventsRows: [impressionRow(ROW_ID, "impression", new Date().toISOString())],
        updateCaptures,
      }),
      true,
    );

    const tap = await postDiscoveryOutcome(url, "tap");
    assert.equal(tap.status, 200, "the tap must land on the impression row");
    assert.equal(updateCaptures[0]?.patch.outcome, "tap");

    const save = await postDiscoveryOutcome(url, "save");
    assert.equal(save.status, 200, "the save must upgrade the tapped row, not 404");
    assert.equal(updateCaptures.length, 2, "exactly one update per outcome");
    assert.equal(updateCaptures[1]!.filterVal, ROW_ID, "the SAME row is upgraded");
    assert.equal(updateCaptures[1]!.patch.outcome, "save", "the row now holds the furthest rung");
  });

  it("'attended' upgrades a row already at 'rsvp' (200)", async () => {
    updateCaptures = [];
    _setTestClient(
      makeClient({
        rankEventsRows: [impressionRow(ROW_ID, "rsvp", new Date().toISOString())],
        updateCaptures,
      }),
      true,
    );

    const r = await postDiscoveryOutcome(url, "attended");
    assert.equal(r.status, 200);
    assert.equal(updateCaptures[0]?.patch.outcome, "attended");
  });

  it("'tap' after 'save' NEVER downgrades — 404, no update", async () => {
    updateCaptures = [];
    _setTestClient(
      makeClient({
        rankEventsRows: [impressionRow(ROW_ID, "save", new Date().toISOString())],
        updateCaptures,
      }),
      true,
    );

    const r = await postDiscoveryOutcome(url, "tap");
    assert.equal(r.status, 404, "a weaker outcome finds no upgradable row");
    assert.equal(updateCaptures.length, 0, "no update may be written");
  });

  it("an equal rung ('join' after 'rsvp') does not rewrite the row — 404, no update", async () => {
    updateCaptures = [];
    _setTestClient(
      makeClient({
        rankEventsRows: [impressionRow(ROW_ID, "rsvp", new Date().toISOString())],
        updateCaptures,
      }),
      true,
    );

    const r = await postDiscoveryOutcome(url, "join");
    assert.equal(r.status, 404);
    assert.equal(updateCaptures.length, 0);
  });

  it("prefers the most recent upgradable row: a fresh impression wins over an older tapped row", async () => {
    updateCaptures = [];
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    _setTestClient(
      makeClient({
        rankEventsRows: [
          // Older row FIRST in fixture order: the fake sorts on .order(), so
          // only the served_at DESC ordering can pick the newer row.
          impressionRow("row00000-0000-0000-0000-00000000000a", "tap", older),
          impressionRow("row00000-0000-0000-0000-00000000000b", "impression", newer),
        ],
        updateCaptures,
      }),
      true,
    );

    const r = await postDiscoveryOutcome(url, "save");
    assert.equal(r.status, 200);
    assert.equal(updateCaptures[0]!.filterVal, "row00000-0000-0000-0000-00000000000b");
  });
});

// ── B: No impression row — 404, no phantom rows ───────────────────────────────

describe("POST /api/rank-events/outcome — B: no impression row returns 404", async () => {
  let url: string;
  let close: () => Promise<void>;
  let updateCaptures: UpdateCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));

    updateCaptures = [];
    // Empty rank_events — no impression row exists
    _setTestClient(
      makeClient({
        rankEventsRows: [],
        updateCaptures,
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 404 and creates no phantom rows", async () => {
    const r = await fetch(`${url}/api/rank-events/outcome`, {
      method:  "POST",
      headers: {
        Authorization:  "Bearer alice-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item_id: ITEM_ID,
        surface: "pulse",
        outcome: "tap",
      }),
    });

    assert.equal(r.status, 404, "expected 404 when no impression row exists");
    const body = await r.json() as any;
    assert.equal(body.error, "not_found", "error code must be not_found");

    // No DB update should have been triggered
    assert.equal(
      updateCaptures.length,
      0,
      "no update must be performed when impression row is absent",
    );
  });
});
