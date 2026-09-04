/**
 * content_distribution_stats.eligible_impressions — the EXPOSURE denominator
 * must be written on the impression path, never by an outcome.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (00_STATUS defect 4, fact layer §4.6)
 * -----------------------------------------------------------------------
 * increment_distribution_stats (migration 2059) had exactly one caller: the
 * outcome handler in routes/rankEvents.ts. eligible_impressions therefore
 * counted CONVERSIONS — an item needed 100 taps/saves, not 100 serves, before
 * the underexposure classification ever ran, and anything normalised by the
 * column returned ≈1.0.
 *
 * The contract pinned here:
 *   A. logImpression increments once per DISTINCT served item, negative=false,
 *      with the DRS constants unchanged (threshold 100, suppression rate 0.3).
 *   B. A rejected rank_events insert moves nothing — the counter mirrors the
 *      impression rows that actually landed.
 *   C. logCompassImpression increments only the items it wrote rows for.
 *   D. logDiscoveryServe increments per served item when the flag is on, and
 *      is inert (no insert, no increment) when it is absent.
 *   E. Empty / blank ids are skipped; a batch drains through a bounded pool.
 *   F. A missing, throwing or rejecting rpc never propagates — and never
 *      stops the impression rows themselves from being written.
 *   G. N impressions + M conversions, end to end through the real route:
 *      eligible_impressions == N (not M, not N+M) and the status is classified
 *      once N reaches the threshold — with M far below it.
 *
 * The fake's rpc applies the 2059 increment rule in memory (+1 impression,
 * +1 negative when flagged, classify at threshold) so G can state the status
 * outcome, not only the call count.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/distributionStatsExposure.test.ts
 */

import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { logImpression, logCompassImpression } from "../lib/rankLog.js";
import {
  logDiscoveryServe,
  invalidateServeLogFlagCache,
  DiscoveryServePoint,
  DISCOVERY_SERVE_LOG_FLAG,
} from "../lib/discoveryServeLog.js";
import { recordImpressionDistributionStats } from "../services/ranking/DiscoveryRankingService.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const STATS_RPC = "increment_distribution_stats";

// The DRS constants passed to the RPC. Owner-held (Blocker 4): pinned so a
// change here is a deliberate one, not a side effect of the writer move.
const EXPECTED_THRESHOLD = 100;
const EXPECTED_RATE      = 0.3;

// ── In-memory model of increment_distribution_stats (2059:139-172) ────────────

interface StatsRow {
  eligible_impressions:  number;
  negative_signal_count: number;
  underexposure_status:  "pending_evaluation" | "boosting" | "normal";
}

function applyIncrement(stats: Map<string, StatsRow>, p: Record<string, any>): void {
  const row: StatsRow = stats.get(p.p_item_id) ?? {
    eligible_impressions: 0, negative_signal_count: 0, underexposure_status: "pending_evaluation",
  };
  row.eligible_impressions += 1;
  if (p.p_negative_signal) row.negative_signal_count += 1;
  if (row.eligible_impressions >= p.p_threshold) {
    row.underexposure_status =
      row.negative_signal_count / row.eligible_impressions >= p.p_suppression_rate
        ? "normal"
        : "boosting";
  }
  stats.set(p.p_item_id, row);
}

// ── Fake client ───────────────────────────────────────────────────────────────

interface RpcCall { name: string; params: Record<string, any> }

function makeClient(opts: {
  flags?:       Record<string, boolean>;
  insertError?: unknown;
  rpc?:         "ok" | "throws" | "rejects" | "missing";
} = {}) {
  const stats    = new Map<string, StatsRow>();
  const rpcCalls: RpcCall[] = [];
  const inserts:  Array<{ table: string; rows: any[] }> = [];
  const updates:  Array<{ patch: any; id: any }> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const db: Record<string, any[]> = {
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    rank_events: [],
  };

  function selectBuilder(table: string) {
    let filtered = [...(db[table] ?? [])];
    const b: any = {
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      order: (col: string, o?: { ascending?: boolean }) => {
        const dir = (o?.ascending ?? true) ? 1 : -1;
        filtered = [...filtered].sort((x, y) => (x[col] < y[col] ? -dir : x[col] > y[col] ? dir : 0));
        return b;
      },
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any, reject?: any) =>
        Promise.resolve({ data: [...filtered], error: null }).then(resolve, reject),
    };
    return b;
  }

  function flagBuilder() {
    let flag: string | undefined;
    const fb: any = {
      select: () => fb,
      eq: (_col: string, val: string) => { flag = val; return fb; },
      maybeSingle: () => Promise.resolve({
        data: flag !== undefined && opts.flags?.[flag] !== undefined ? { enabled: opts.flags[flag] } : null,
        error: null,
      }),
    };
    return fb;
  }

  const client: any = {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => {
      if (table === "feature_flags") return flagBuilder();
      return {
        select: (_cols?: string) => selectBuilder(table),
        insert: (data: any) => {
          const rows = Array.isArray(data) ? data : [data];
          inserts.push({ table, rows });
          if (opts.insertError) return Promise.resolve({ data: null, error: opts.insertError });
          if (table === "rank_events") {
            for (const r of rows) db.rank_events!.push({ id: `row-${db.rank_events!.length + 1}`, ...r });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update: (patch: any) => ({
          eq: (col: string, val: any) => {
            db[table] = (db[table] ?? []).map((r) => (r[col] === val ? { ...r, ...patch } : r));
            updates.push({ patch, id: val });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
    },
  };

  if (opts.rpc !== "missing") {
    client.rpc = (name: string, params?: Record<string, any>) => {
      rpcCalls.push({ name, params: params ?? {} });
      if (opts.rpc === "throws")  throw new Error("rpc exploded");
      if (opts.rpc === "rejects") return Promise.reject(new Error("rpc rejected"));
      if (name === STATS_RPC) applyIncrement(stats, params ?? {});
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) =>
        setImmediate(() => { inFlight -= 1; resolve({ data: null, error: null }); }),
      );
    };
  }

  return {
    client, stats, rpcCalls, inserts, updates,
    statsCalls: () => rpcCalls.filter((c) => c.name === STATS_RPC),
    maxInFlight: () => maxInFlight,
    rankEvents: () => db.rank_events!,
  };
}

function scored(...ids: string[]) {
  return ids.map((id) => ({
    candidate: { id, kind: "place" as const },
    score: 1,
    features: { distance: 0.5 },
  })) as any;
}

// ── A–F: the impression writers ───────────────────────────────────────────────

describe("exposure denominator — written on the impression path", () => {
  beforeEach(() => invalidateServeLogFlagCache());
  afterEach(() => _setTestServiceClient(null as any));

  it("A. logImpression increments once per DISTINCT served item, negative=false, DRS constants intact", async () => {
    const f = makeClient();
    _setTestServiceClient(f.client);

    await logImpression(scored("node/1", "db/2", "node/1"), ALICE_ID, "discovery");

    const calls = f.statsCalls();
    assert.deepEqual(
      calls.map((c) => c.params.p_item_id).sort(),
      ["db/2", "node/1"],
      "one increment per distinct item — a duplicate in the batch is one exposure",
    );
    for (const c of calls) {
      assert.equal(c.params.p_negative_signal,  false,              "an impression is never a negative signal");
      assert.equal(c.params.p_viewer_id,        ALICE_ID);
      assert.equal(c.params.p_threshold,        EXPECTED_THRESHOLD, "threshold constant must not move");
      assert.equal(c.params.p_suppression_rate, EXPECTED_RATE,      "suppression rate constant must not move");
      assert.ok(!("eligible_impressions" in c.params), "never a literal counter value — the RPC owns the increment");
    }
    assert.equal(f.stats.get("node/1")?.eligible_impressions, 1);
    assert.equal(f.stats.get("db/2")?.eligible_impressions, 1);
  });

  it("B. a rejected rank_events insert moves the counter by nothing", async () => {
    const f = makeClient({ insertError: { message: "new row violates check constraint" } });
    _setTestServiceClient(f.client);

    await logImpression(scored("node/1", "db/2"), ALICE_ID, "pulse");

    assert.equal(f.inserts.length, 1, "the insert was attempted");
    assert.equal(f.statsCalls().length, 0, "no impression row landed, so no exposure is counted");
  });

  it("C. logCompassImpression increments exactly the items it wrote rows for", async () => {
    const f = makeClient();
    _setTestServiceClient(f.client);

    await logCompassImpression(
      [{ id: "evt-1", type: "event" }, { id: "tip-1", type: "safety_tip" }, { id: "gem-1", type: "gem" }],
      ALICE_ID,
    );

    assert.deepEqual(
      f.statsCalls().map((c) => c.params.p_item_id).sort(),
      ["evt-1", "gem-1"],
      "the static safety_tip never got a row, so it never gets an exposure either",
    );
  });

  it("D. logDiscoveryServe increments per served item with the flag ON, and is inert with it absent", async () => {
    const on = makeClient({ flags: { [DISCOVERY_SERVE_LOG_FLAG]: true } });
    await logDiscoveryServe(on.client, {
      userId: ALICE_ID,
      servePoint: DiscoveryServePoint.CACHE_A_L1,
      items: [{ id: "node/10" }, { id: "db/11" }],
    });
    assert.equal(on.inserts.length, 1);
    assert.deepEqual(on.statsCalls().map((c) => c.params.p_item_id).sort(), ["db/11", "node/10"]);

    invalidateServeLogFlagCache();
    const off = makeClient();
    await logDiscoveryServe(off.client, {
      userId: ALICE_ID,
      servePoint: DiscoveryServePoint.SEARCH,
      items: [{ id: "node/10" }],
    });
    assert.equal(off.inserts.length, 0, "flag absent ⇒ no insert (behaviour-preserving, as the module promises)");
    assert.equal(off.statsCalls().length, 0, "…and therefore no increment");
  });

  it("E. blank ids are skipped, an empty batch is a no-op, and a large batch drains through a bounded pool", async () => {
    const f = makeClient();

    await recordImpressionDistributionStats(f.client, [], ALICE_ID);
    await recordImpressionDistributionStats(f.client, ["", "ok-1", ""], ALICE_ID);
    assert.deepEqual(f.statsCalls().map((c) => c.params.p_item_id), ["ok-1"]);

    const many = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    await recordImpressionDistributionStats(f.client, many, ALICE_ID);
    assert.equal(f.statsCalls().length, 21, "every distinct item is counted");
    assert.ok(
      f.maxInFlight() <= 6,
      `at most 6 increments may be in flight at once (saw ${f.maxInFlight()}) — pulse logs ~60 ranked candidates per load`,
    );
  });

  it("F. a missing, throwing or rejecting rpc never propagates — and the impression rows still land", async () => {
    for (const mode of ["missing", "throws", "rejects"] as const) {
      const f = makeClient({ rpc: mode });
      _setTestServiceClient(f.client);

      await assert.doesNotReject(
        () => recordImpressionDistributionStats(f.client, ["x"], ALICE_ID),
        `rpc=${mode} must not reject`,
      );
      await assert.doesNotReject(
        () => logImpression(scored("node/1"), ALICE_ID, "events"),
        `rpc=${mode} must not surface through logImpression`,
      );
      assert.equal(f.inserts.filter((i) => i.table === "rank_events").length, 1,
        `rpc=${mode}: the impression row is written regardless of the stats side-effect`);
    }
  });
});

// ── G: N impressions / M conversions, through the real route ──────────────────

async function makeApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: rankEventsRouter } = await import("../routes/rankEvents.js");
  app.use("/api", rankEventsRouter);
  return app;
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

describe("exposure denominator — N impressions / M conversions", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    ({ url, close } = await startServer(await makeApp()));
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("G. 100 serves + 5 taps ⇒ eligible_impressions = 100 and the item is classified; 99 serves stay pending", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    const ITEM = "node/777";
    const NEAR = "node/778";

    // N = 100 serves of ITEM (one impression row each), 99 of NEAR.
    for (let i = 0; i < 100; i++) await logImpression(scored(ITEM), ALICE_ID, "discovery");
    for (let i = 0; i < 99;  i++) await logImpression(scored(NEAR), ALICE_ID, "discovery");

    assert.equal(f.rankEvents().filter((r) => r.item_id === ITEM && r.outcome === "impression").length, 100);

    // M = 5 conversions through the real outcome route. Each upgrades the most
    // recent still-upgradable impression row, exactly as production would.
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${url}/api/rank-events/outcome`, {
        method:  "POST",
        headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
        body:    JSON.stringify({ item_id: ITEM, surface: "discovery", outcome: "tap" }),
      });
      assert.equal(r.status, 200, `conversion ${i + 1} must land on an impression row`);
    }
    await new Promise((r) => setImmediate(r));

    assert.equal(f.updates.length, 5, "five impression rows were upgraded to tap");
    assert.equal(f.rankEvents().filter((r) => r.item_id === ITEM && r.outcome === "tap").length, 5);

    const item = f.stats.get(ITEM)!;
    assert.equal(item.eligible_impressions, 100,
      "the denominator is the number of SERVES — not 5 (the old conversion count) and not 105");
    assert.equal(item.underexposure_status, "boosting",
      "100 exposures with no negative signal crosses the threshold ⇒ classified");

    const near = f.stats.get(NEAR)!;
    assert.equal(near.eligible_impressions, 99);
    assert.equal(near.underexposure_status, "pending_evaluation",
      "one serve short of the threshold ⇒ not yet classified");

    assert.equal(f.statsCalls().length, 199, "199 serves ⇒ 199 increments; the 5 conversions added none");
  });
});
