/**
 * POST /api/rank-events/outcome — node:test
 *
 * Covers:
 *  A. Valid tap on an existing impression row → 200, outcome + outcome_at updated.
 *  B. No prior impression row → 404, no phantom rows created.
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
      order: (_col: string, _opts?: any) => b,
      limit: (_n: number) => b,
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

// ── C: Repeated outcomes on the same item — counters must only increase ────────
//
// Regression test for the counter-reset bug where a hardcoded-value upsert
// (eligible_impressions: 1) reset accumulated counts back to 1 on every call.
// The correct path uses only the RPC, which increments atomically.

describe("POST /api/rank-events/outcome — C: repeated outcomes never reset distribution counters", async () => {
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

  it("calls increment_distribution_stats RPC for each outcome — never a destructive upsert with hardcoded 1 values", async () => {
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

    // Both should have triggered the RPC
    const statsRpcs = rpcCaptures.filter(
      (c) => c.name === "increment_distribution_stats",
    );
    assert.equal(
      statsRpcs.length,
      2,
      "increment_distribution_stats RPC must be called once per outcome",
    );

    // Neither call should carry a hardcoded eligible_impressions=1 that would
    // reset accumulated counters — the RPC owns all increments.
    for (const rpc of statsRpcs) {
      assert.ok(
        !("eligible_impressions" in rpc.params),
        "RPC params must NOT contain eligible_impressions — counter resets are forbidden",
      );
    }
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
