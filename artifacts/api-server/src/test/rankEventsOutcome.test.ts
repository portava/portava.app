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

// ═══════════════════════════════════════════════════════════════════════════════
// §83 — POST /api/rank-events/undo-dismiss
// ═══════════════════════════════════════════════════════════════════════════════
//
// E. Happy path: the dismissal is DOWNGRADED to 'impression' (never deleted) and
//    the place is served again through the real read path.
// F. Another viewer's dismissal: 404, and the dismissal still stands.
// G. Nothing to undo: 404, nothing written.
// H. A failed read REFUSES — supabase-js resolves with `{ error }`, so a route
//    that does not inspect it reports success having written nothing.
// I. dismiss → undo → re-dismiss does NOT increment negative_signal_count twice.
//
// Every assertion is about the STATE AFTERWARDS (CONTRIBUTING.md's rule): the row
// is read back out of the fake's db, and the place's reappearance is proven by
// calling `loadDismissedPlaceIds` — the function routes/discovery.ts actually
// uses — rather than by trusting a 200.

import { loadDismissedPlaceIds } from "../lib/discoveryDismissed.js";
import { _resetRecommendationIdSchemaLatch } from "../routes/rankEvents.js";

const BOB_ID       = "b0b00000-bbbb-bbbb-bbbb-000000000002";
const DISMISS_ROW  = "d1500000-0000-0000-0000-000000000001";
const DISMISS_ROW2 = "d1500000-0000-0000-0000-000000000002";
const CLIENT_EV_1  = "c1e00000-0000-0000-0000-000000000001";
const CLIENT_EV_2  = "c1e00000-0000-0000-0000-000000000002";

/**
 * A fake with the three things these cases need and the existing `makeClient`
 * lacks: a multi-`.eq` UPDATE builder (the downgrade filters on id + user_id +
 * outcome), a `features->>key` filter (the idempotence marker is read back with
 * one), and a switch that makes a `rank_events` SELECT resolve with `{ error }`
 * the way PostgREST does.
 */
function makeUndoClient(opts: {
  rows: Array<Record<string, any>>;
  rpcCaptures?: RpcCapture[];
  updateCaptures?: UpdateCapture[];
  failRankEventsSelect?: boolean;
}) {
  const rpcCaptures    = opts.rpcCaptures    ?? [];
  const updateCaptures = opts.updateCaptures ?? [];
  const db: Record<string, any[]> = {
    profiles: [
      { id: ALICE_ID, account_status: "active" },
      { id: BOB_ID,   account_status: "active" },
    ],
    rank_events: opts.rows,
    rank_event_outcome_receipts: [],
  };

  /** `features->>key` as PostgREST resolves it: the jsonb value rendered as text. */
  function fieldOf(row: Record<string, any>, col: string): any {
    const at = col.indexOf("->>");
    if (at < 0) return row[col];
    const obj = row[col.slice(0, at)];
    const v = obj && typeof obj === "object" ? obj[col.slice(at + 3)] : undefined;
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  function selectBuilder(table: string) {
    let filtered = [...(db[table] ?? [])];
    const failed = table === "rank_events" && opts.failRankEventsSelect === true;
    const settle = () =>
      failed
        ? { data: null, error: { code: "42501", message: "permission denied for table rank_events" } }
        : { data: [...filtered], error: null };
    const b: any = {
      eq:    (c: string, v: any) => { filtered = filtered.filter((r) => fieldOf(r, c) === v); return b; },
      neq:   (c: string, v: any) => { filtered = filtered.filter((r) => fieldOf(r, c) !== v); return b; },
      in:    (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(fieldOf(r, c))); return b; },
      order: (c: string, o?: { ascending?: boolean }) => {
        const dir = (o?.ascending ?? true) ? 1 : -1;
        filtered = [...filtered].sort((x, y) => (x[c] < y[c] ? -dir : x[c] > y[c] ? dir : 0));
        return b;
      },
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve(failed ? settle() : { data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve(failed ? settle() : { data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve(settle()),
    };
    return b;
  }

  function updateBuilder(table: string, patch: Record<string, any>) {
    const filters: Array<[string, any]> = [];
    const ins: Array<[string, any[]]> = [];
    const apply = () => {
      const moved: any[] = [];
      db[table] = (db[table] ?? []).map((r) => {
        const hit = filters.every(([c, v]) => fieldOf(r, c) === v)
                 && ins.every(([c, vs]) => vs.includes(fieldOf(r, c)));
        if (!hit) return r;
        const next = { ...r, ...patch };
        moved.push({ id: next.id });
        return next;
      });
      updateCaptures.push({
        table, patch,
        filterCol: filters[0]?.[0] ?? "",
        filterVal: filters[0]?.[1],
      });
      return { data: moved, error: null };
    };
    const u: any = {
      eq:     (c: string, v: any)   => { filters.push([c, v]); return u; },
      in:     (c: string, vs: any[]) => { ins.push([c, vs]);    return u; },
      select: (_c?: string)          => u,
      then:   (resolve: any)         => resolve(apply()),
    };
    return u;
  }

  return {
    db,
    auth: {
      getUser: (token?: string) => {
        if (token === "alice-token") return Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null });
        if (token === "bob-token")   return Promise.resolve({ data: { user: { id: BOB_ID } },   error: null });
        return Promise.resolve({ data: { user: null }, error: { message: "no token" } });
      },
    },
    from: (table: string) => ({
      select: (_cols?: string) => selectBuilder(table),
      update: (patch: Record<string, any>) => updateBuilder(table, patch),
      insert: (_d: any) => Promise.resolve({ data: null, error: null }),
    }),
    rpc: (name: string, params?: any) => {
      rpcCaptures.push({ name, params: params ?? {} });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

/** One dismissed discovery exposure belonging to `userId`. */
function dismissedRow(id: string, userId: string, servedAt: string, extra: Record<string, any> = {}) {
  return {
    id,
    user_id:    userId,
    item_id:    ITEM_ID,
    item_kind:  "place",
    surface:    "discovery",
    outcome:    "dismiss",
    position:   0,
    features:   {},
    served_at:  servedAt,
    session_id: SESSION_ID,
    outcome_at: servedAt,
    ...extra,
  };
}

async function postUndo(url: string, token: string, body: Record<string, any>) {
  return fetch(`${url}/api/rank-events/undo-dismiss`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

// ── E: the dismissal is downgraded, and the place is served again ──────────────

describe("POST /api/rank-events/undo-dismiss — E: downgrade, not delete", async () => {
  let url: string;
  let close: () => Promise<void>;
  let client: any;
  let updateCaptures: UpdateCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));
    _resetRecommendationIdSchemaLatch();
    updateCaptures = [];
    client = makeUndoClient({
      rows: [dismissedRow(DISMISS_ROW, ALICE_ID, "2026-10-01T00:00:00.000Z")],
      updateCaptures,
    });
    _setTestClient(client, true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("the place is filtered out BEFORE the undo (the premise of the test)", async () => {
    const before = await loadDismissedPlaceIds(client, ALICE_ID);
    assert.equal(before.degraded, false, "the dismissal read must have completed");
    assert.ok(before.ids.has(ITEM_ID), "the dismissed place must start out suppressed");
  });

  it("downgrades outcome to impression, clears outcome_at, and KEEPS the row", async () => {
    const r = await postUndo(url, "alice-token", { item_id: ITEM_ID, surface: "discovery" });
    assert.equal(r.status, 200, "expected 200 OK");

    // STATE, not the return value: read the row back.
    const rows = client.db.rank_events.filter((x: any) => x.id === DISMISS_ROW);
    assert.equal(rows.length, 1, "the exposure row must still EXIST — a delete would destroy the denominator");
    assert.equal(rows[0].outcome, "impression", "outcome must be downgraded to impression");
    assert.equal(rows[0].outcome_at, null, "outcome_at must be cleared");
    assert.equal(rows[0].served_at, "2026-10-01T00:00:00.000Z", "served_at — the exposure fact — must be untouched");
    assert.equal(rows[0].user_id, ALICE_ID, "the row must still belong to its viewer");
  });

  it("the place is served again through the REAL read path", async () => {
    const after = await loadDismissedPlaceIds(client, ALICE_ID);
    assert.equal(after.degraded, false, "the dismissal read must have completed");
    assert.equal(after.ids.has(ITEM_ID), false, "the undone place must no longer be suppressed");
  });

  it("the downgrade banks the idempotence marker on the row", async () => {
    const row = client.db.rank_events.find((x: any) => x.id === DISMISS_ROW);
    assert.equal(row.features?.negativeSignalCounted, true,
      "the undo must record that this viewer's negative signal is already banked");
  });
});

// ── F: a viewer may undo only their OWN dismissal ─────────────────────────────

describe("POST /api/rank-events/undo-dismiss — F: another viewer's dismissal", async () => {
  let url: string;
  let close: () => Promise<void>;
  let client: any;
  let updateCaptures: UpdateCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));
    _resetRecommendationIdSchemaLatch();
    updateCaptures = [];
    client = makeUndoClient({
      rows: [dismissedRow(DISMISS_ROW, ALICE_ID, "2026-10-01T00:00:00.000Z")],
      updateCaptures,
    });
    _setTestClient(client, true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("Bob cannot undo Alice's dismissal, and Alice's dismissal still STANDS", async () => {
    const r = await postUndo(url, "bob-token", { item_id: ITEM_ID, surface: "discovery" });
    assert.equal(r.status, 404, "another viewer's dismissal must not be found");
    const body = await r.json() as any;
    assert.equal(body.error, "not_found", "the refusal must not say whose dismissal it is");

    // The state: Alice's row is untouched and she is still suppressed.
    const row = client.db.rank_events.find((x: any) => x.id === DISMISS_ROW);
    assert.equal(row.outcome, "dismiss", "Alice's dismissal must be unchanged");
    assert.equal(row.outcome_at, "2026-10-01T00:00:00.000Z", "Alice's outcome_at must be unchanged");
    assert.equal(updateCaptures.length, 0, "no update may be issued for another viewer's row");

    const still = await loadDismissedPlaceIds(client, ALICE_ID);
    assert.ok(still.ids.has(ITEM_ID), "Alice's place must still be suppressed for Alice");
  });
});

// ── G: nothing to undo ────────────────────────────────────────────────────────

describe("POST /api/rank-events/undo-dismiss — G: no dismissal to undo", async () => {
  let url: string;
  let close: () => Promise<void>;
  let client: any;
  let updateCaptures: UpdateCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));
    _resetRecommendationIdSchemaLatch();
    updateCaptures = [];
    client = makeUndoClient({
      rows: [{ ...dismissedRow(DISMISS_ROW, ALICE_ID, "2026-10-01T00:00:00.000Z"), outcome: "impression", outcome_at: null }],
      updateCaptures,
    });
    _setTestClient(client, true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("404s and writes nothing when the item was never dismissed", async () => {
    const r = await postUndo(url, "alice-token", { item_id: ITEM_ID, surface: "discovery" });
    assert.equal(r.status, 404, "expected 404 when there is no dismissal");
    const body = await r.json() as any;
    assert.equal(body.error, "not_found", "error code must be not_found");
    assert.equal(updateCaptures.length, 0, "no phantom write may be issued");

    const row = client.db.rank_events.find((x: any) => x.id === DISMISS_ROW);
    assert.equal(row.outcome, "impression", "the impression row must be untouched");
    assert.equal(row.features?.negativeSignalCounted, undefined,
      "no idempotence marker may be banked when nothing was undone");
  });
});

// ── H: a read that cannot establish its result must REFUSE ───────────────────

describe("POST /api/rank-events/undo-dismiss — H: a failed read refuses", async () => {
  let url: string;
  let close: () => Promise<void>;
  let client: any;
  let updateCaptures: UpdateCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));
    _resetRecommendationIdSchemaLatch();
    updateCaptures = [];
    client = makeUndoClient({
      rows: [dismissedRow(DISMISS_ROW, ALICE_ID, "2026-10-01T00:00:00.000Z")],
      updateCaptures,
      failRankEventsSelect: true,
    });
    _setTestClient(client, true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("answers db_error — never { ok: true } — when the dismissal read resolves with { error }", async () => {
    const r = await postUndo(url, "alice-token", { item_id: ITEM_ID, surface: "discovery" });
    assert.equal(r.status, 500, "an unestablished read must refuse, not report success");
    const body = await r.json() as any;
    assert.equal(body.error, "db_error", "error code must be db_error");
    assert.notEqual(body.ok, true, "the response must never claim success");
    assert.equal(updateCaptures.length, 0, "nothing may be written when the read failed");
    const row = client.db.rank_events.find((x: any) => x.id === DISMISS_ROW);
    assert.equal(row.outcome, "dismiss", "the dismissal must still stand after a refused undo");
  });
});

// ── I: dismiss → undo → re-dismiss does not inflate the cross-viewer counter ──
//
// The loop that matters. `negative_signal_count` (2297) is increment-only and
// carries no per-viewer attribution, so a +1 cannot be taken back; a free loop
// would let one viewer move a global ranking statistic arbitrarily far. The
// re-dismiss here lands on a DIFFERENT, NEWER impression row than the one that
// was undone — which is the real sequence, because an undone place becomes
// servable again — so the guard is proven through its read of the marker, not
// through the row the dismiss happens to pick.

describe("POST /api/rank-events — I: dismiss → undo → re-dismiss banks ONE negative signal", async () => {
  let url: string;
  let close: () => Promise<void>;
  let client: any;
  let rpcCaptures: RpcCapture[];

  before(async () => {
    const app = await makeApp();
    ({ url, close } = await startServer(app));
    _resetRecommendationIdSchemaLatch();
    rpcCaptures = [];
    client = makeUndoClient({
      rows: [{ ...dismissedRow(DISMISS_ROW, ALICE_ID, "2026-10-01T00:00:00.000Z"), outcome: "impression", outcome_at: null }],
      rpcCaptures,
    });
    _setTestClient(client, true);
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  const negatives = () => rpcCaptures.filter((c) => c.name === "record_distribution_negative_signal").length;

  it("the first dismiss increments the counter exactly once", async () => {
    const r = await fetch(`${url}/api/rank-events/outcome`, {
      method:  "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      body:    JSON.stringify({ item_id: ITEM_ID, surface: "discovery", outcome: "dismiss", client_event_id: CLIENT_EV_1 }),
    });
    assert.equal(r.status, 200, "the dismiss must be recorded");
    assert.equal(client.db.rank_events.find((x: any) => x.id === DISMISS_ROW).outcome, "dismiss",
      "the row must now hold the dismissal");
    assert.equal(negatives(), 1, "the first dismiss banks one negative signal");
  });

  it("the undo restores the place without decrementing the counter", async () => {
    const r = await postUndo(url, "alice-token", { item_id: ITEM_ID, surface: "discovery" });
    assert.equal(r.status, 200, "the undo must succeed");
    assert.equal(negatives(), 1,
      "the undo must not call the RPC again — and there is no decrement to call (2297 is increment-only)");
    const after = await loadDismissedPlaceIds(client, ALICE_ID);
    assert.equal(after.ids.has(ITEM_ID), false, "the place must be served again");
  });

  it("a RE-DISMISS on a newer exposure does NOT increment the counter a second time", async () => {
    // The place is servable again, so it is served again: a new impression row,
    // newer than the one the undo downgraded, and carrying no marker of its own.
    client.db.rank_events.push({
      ...dismissedRow(DISMISS_ROW2, ALICE_ID, "2026-10-02T00:00:00.000Z"),
      outcome: "impression", outcome_at: null, position: 3, features: {},
    });

    const r = await fetch(`${url}/api/rank-events/outcome`, {
      method:  "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      // A NEW user action, so the client mints a NEW key: §62's receipt guard
      // cannot see this as a replay, which is exactly why the marker exists.
      body:    JSON.stringify({ item_id: ITEM_ID, surface: "discovery", outcome: "dismiss", client_event_id: CLIENT_EV_2 }),
    });
    assert.equal(r.status, 200, "the re-dismiss must still be RECORDED — only the counter is withheld");

    // The viewer's own state did change: the newer exposure holds the dismissal
    // and the place is suppressed again.
    const picked = client.db.rank_events.find((x: any) => x.id === DISMISS_ROW2);
    assert.equal(picked.outcome, "dismiss", "the re-dismiss must land on the newer exposure");
    const again = await loadDismissedPlaceIds(client, ALICE_ID);
    assert.ok(again.ids.has(ITEM_ID), "the re-dismissed place must be suppressed again");

    // The cross-viewer statistic did NOT move a second time.
    assert.equal(negatives(), 1,
      "dismiss → undo → re-dismiss must bank ONE negative signal, not two — the counter is increment-only");
  });
});
