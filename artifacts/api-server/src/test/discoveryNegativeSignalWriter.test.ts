/**
 * The underexposure NUMERATOR — a negative verdict must be REACHABLE.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST
 * ==================================
 * `content_distribution_stats.negative_signal_count` is the numerator of the
 * underexposure classification (migration 2059):
 *
 *     IF v_impressions >= p_threshold THEN
 *       IF v_negatives::FLOAT / NULLIF(v_impressions,0) >= p_suppression_rate
 *         THEN 'normal' ELSE 'boosting' END
 *
 * It had NO WRITER. The RPC's `p_negative_signal` argument had exactly one
 * caller — recordImpressionDistributionStats — and that caller passes the
 * literal `false`, correctly, because an impression is not a negative signal.
 * Nothing else in the repository wrote the column.
 *
 * So v_negatives was 0 for every row, 0/N is never >= 0.3, and EVERY item that
 * crossed 100 eligible impressions classified 'boosting'. The classifier was
 * structurally incapable of returning 'normal' — a constant wearing the costume
 * of a measurement, read by FeedSlotAllocator and by applyModifiers, both of
 * which grant a real ranking boost off it.
 *
 * The root cause was one layer up: the outcome vocabulary was entirely positive
 * (tap / save / join / rsvp / attended). There was no negative outcome, so
 * negative user intent was not merely unwritten, it was unsendable.
 *
 * WHAT IS PINNED HERE
 * ===================
 *   A. VOCABULARY (defect 4) — 'dismiss' is accepted, applies only to a row
 *      still at 'impression', and is terminal: no later positive overwrites it.
 *   B. THE WRITER (defect 1) — a dismiss calls record_distribution_negative_
 *      signal and calls increment_distribution_stats ZERO times, so the
 *      numerator moves and the exposure DENOMINATOR does not.
 *   C. REACHABILITY (defect 1, the whole point) — 100 impressions + 30
 *      dismisses, end to end through the real route, classifies 'normal'. The
 *      same 100 impressions with no dismiss classify 'boosting'. Both verdicts
 *      are now reachable; before, only one was.
 *   D. MIGRATION 2297 — the CHECK is widened and never narrowed, the function
 *      leaves eligible_impressions alone, its grants are service_role-only, and
 *      it does not touch increment_distribution_stats (no overload set).
 *
 * The fakes model migrations 2059 and 2297 in memory, exactly as
 * src/test/distributionStatsExposure.test.ts models 2059, so section C can
 * state a STATUS and not merely a call count.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryNegativeSignalWriter.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { upgradableOutcomesFor } from "../routes/rankEvents.js";
import { recordNegativeDistributionSignal } from "../services/ranking/DiscoveryRankingService.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";

const INCREMENT_RPC = "increment_distribution_stats";
const NEGATIVE_RPC  = "record_distribution_negative_signal";

/** The DRS constants both writers must pass. Pinned — a change must be deliberate. */
const EXPECTED_THRESHOLD = 100;
const EXPECTED_RATE      = 0.3;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const MIGRATION_2297 = "2297_rank_events_dismiss_outcome.sql";

// ── In-memory model of the two RPCs ───────────────────────────────────────────

interface StatsRow {
  eligible_impressions:  number;
  negative_signal_count: number;
  underexposure_status:  "pending_evaluation" | "boosting" | "normal";
}

const blankRow = (): StatsRow => ({
  eligible_impressions: 0, negative_signal_count: 0, underexposure_status: "pending_evaluation",
});

/** Shared classification rule — 2059 and 2297 must agree, so it is written once. */
function classify(row: StatsRow, threshold: number, rate: number): void {
  if (row.eligible_impressions < threshold) return;
  row.underexposure_status =
    row.negative_signal_count / row.eligible_impressions >= rate ? "normal" : "boosting";
}

/** Migration 2059: +1 impression, +1 negative when flagged, then classify. */
function applyIncrement(stats: Map<string, StatsRow>, p: Record<string, any>): void {
  const row = stats.get(p.p_item_id) ?? blankRow();
  row.eligible_impressions += 1;
  if (p.p_negative_signal) row.negative_signal_count += 1;
  classify(row, p.p_threshold, p.p_suppression_rate);
  stats.set(p.p_item_id, row);
}

/**
 * Migration 2297: +1 negative and NOTHING ELSE, then re-classify.
 *
 * eligible_impressions is deliberately not touched here — that is the whole
 * reason this is a separate function from the one above rather than a call to
 * it with p_negative_signal=true.
 */
function applyNegative(stats: Map<string, StatsRow>, p: Record<string, any>): void {
  const row = stats.get(p.p_item_id) ?? blankRow();
  row.negative_signal_count += 1;
  classify(row, p.p_threshold, p.p_suppression_rate);
  stats.set(p.p_item_id, row);
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface RpcCall { name: string; params: Record<string, any> }

function makeClient() {
  const stats    = new Map<string, StatsRow>();
  const rpcCalls: RpcCall[] = [];
  const db: Record<string, any[]> = {
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    rank_events: [],
  };
  let rowSeq = 0;

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
      then: (res: any, rej?: any) =>
        Promise.resolve({ data: [...filtered], error: null }).then(res, rej),
    };
    return b;
  }

  const client: any = {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => ({
      select: (_cols?: string) => selectBuilder(table),
      insert: (data: any) => {
        const rows = Array.isArray(data) ? data : [data];
        for (const r of rows) (db[table] ??= []).push({ id: `row-${++rowSeq}`, ...r });
        return Promise.resolve({ data: null, error: null });
      },
      update: (patch: any) => ({
        eq: (col: string, val: any) => {
          db[table] = (db[table] ?? []).map((r) => (r[col] === val ? { ...r, ...patch } : r));
          return Promise.resolve({ data: null, error: null });
        },
      }),
    }),
    rpc: (name: string, params?: Record<string, any>) => {
      rpcCalls.push({ name, params: params ?? {} });
      if (name === INCREMENT_RPC) applyIncrement(stats, params ?? {});
      if (name === NEGATIVE_RPC)  applyNegative(stats, params ?? {});
      return Promise.resolve({ data: null, error: null });
    },
  };

  return {
    client, stats, rpcCalls,
    calls:      (name: string) => rpcCalls.filter((c) => c.name === name),
    rankEvents: () => db.rank_events!,
    /** Seed one impression row directly — the state an outcome upgrades. */
    seedImpression(itemId: string, surface = "discovery"): void {
      db.rank_events!.push({
        id: `row-${++rowSeq}`, user_id: ALICE_ID, item_id: itemId, surface,
        outcome: "impression", served_at: new Date(Date.now() + rowSeq).toISOString(),
      });
    },
    /** Model an impression the way lib/rankLog.ts does: row + denominator. */
    async serve(itemId: string): Promise<void> {
      this.seedImpression(itemId);
      await client.rpc(INCREMENT_RPC, {
        p_item_id: itemId, p_viewer_id: ALICE_ID, p_negative_signal: false,
        p_threshold: EXPECTED_THRESHOLD, p_suppression_rate: EXPECTED_RATE,
      });
    },
  };
}

// ── Server harness ────────────────────────────────────────────────────────────

async function makeApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: rankEventsRouter } = await import("../routes/rankEvents.js");
  app.use("/api", rankEventsRouter);
  return app;
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      res({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => srv.close(() => r(undefined))),
      });
    });
  });
}

/** Let the route's fire-and-forget side effects run. */
const settle = () => new Promise((r) => setImmediate(r));

// ── A / B / C: through the real outcome route ─────────────────────────────────

describe("rank-events outcome — the negative signal", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => { ({ url, close } = await startServer(await makeApp())); });
  after(async () => { await close(); _setTestClient(null as any, false); });

  async function report(itemId: string, outcome: string): Promise<number> {
    const r = await fetch(`${url}/api/rank-events/outcome`, {
      method:  "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      body:    JSON.stringify({ item_id: itemId, surface: "discovery", outcome }),
    });
    await r.arrayBuffer();
    return r.status;
  }

  // ── A. Vocabulary (defect 4) ────────────────────────────────────────────────

  it("A1. 'dismiss' is an accepted outcome and lands on the impression row", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    f.seedImpression("node/1");

    assert.equal(
      await report("node/1", "dismiss"), 200,
      "the outcome vocabulary must carry a negative value — without one, negative " +
      "intent is unrecordable and the numerator can have no writer",
    );
    await settle();
    assert.equal(f.rankEvents().find((r) => r.item_id === "node/1")?.outcome, "dismiss");
  });

  it("A2. a dismissed row is never overwritten by a later positive", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    f.seedImpression("node/2");

    assert.equal(await report("node/2", "dismiss"), 200);
    await settle();

    for (const positive of ["tap", "save", "attended"]) {
      assert.equal(
        await report("node/2", positive), 404,
        `${positive} must not resurrect a dismissed row — a recorded negative is terminal`,
      );
    }
    assert.equal(f.rankEvents().find((r) => r.item_id === "node/2")?.outcome, "dismiss");
  });

  it("A3. a dismiss applies only to a row still at 'impression'", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    f.seedImpression("node/3");

    assert.equal(await report("node/3", "tap"), 200);
    await settle();
    assert.equal(
      await report("node/3", "dismiss"), 404,
      "you dismiss what you were shown, not what you already opened",
    );
  });

  it("A4. 'dismiss' is not a funnel rung and appears in no other outcome's upgradable set", () => {
    assert.deepEqual(upgradableOutcomesFor("dismiss" as any), ["impression"]);
    for (const positive of ["tap", "save", "join", "rsvp", "attended"] as const) {
      assert.ok(
        !upgradableOutcomesFor(positive).includes("dismiss"),
        `${positive} must not be able to upgrade a dismissed row`,
      );
    }
  });

  // ── B. The writer moves the numerator only (defect 1) ───────────────────────

  it("B1. a dismiss calls the numerator RPC once and the increment RPC zero times", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    f.seedImpression("node/4");

    assert.equal(await report("node/4", "dismiss"), 200);
    await settle();

    const neg = f.calls(NEGATIVE_RPC);
    assert.equal(neg.length, 1, "exactly one negative-signal write per dismiss");
    assert.equal(neg[0]!.params.p_item_id, "node/4");
    assert.equal(neg[0]!.params.p_viewer_id, ALICE_ID);
    assert.equal(neg[0]!.params.p_threshold, EXPECTED_THRESHOLD, "threshold constant must not move");
    assert.equal(neg[0]!.params.p_suppression_rate, EXPECTED_RATE, "suppression rate must not move");
    assert.ok(
      !("eligible_impressions" in neg[0]!.params) && !("p_negative_signal" in neg[0]!.params),
      "no literal counter value and no reuse of the impression RPC's argument shape",
    );

    assert.equal(
      f.calls(INCREMENT_RPC).length, 0,
      "an outcome must never move the exposure DENOMINATOR — that was 00_STATUS defect 4",
    );
  });

  it("B2. a positive outcome writes no negative signal at all", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    for (const item of ["node/5", "node/6", "node/7", "node/8", "node/9"]) f.seedImpression(item);

    const outcomes = ["tap", "save", "join", "rsvp", "attended"];
    for (let i = 0; i < outcomes.length; i++) {
      assert.equal(await report(`node/${5 + i}`, outcomes[i]!), 200);
    }
    await settle();

    assert.equal(f.calls(NEGATIVE_RPC).length, 0, "only 'dismiss' is a negative signal");
  });

  it("B3. the denominator is untouched by a dismiss", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    await f.serve("node/10");
    await f.serve("node/10");

    assert.equal(await report("node/10", "dismiss"), 200);
    await settle();

    const row = f.stats.get("node/10")!;
    assert.equal(row.eligible_impressions, 2, "two serves, and the dismiss added none");
    assert.equal(row.negative_signal_count, 1, "the dismiss moved the numerator");
  });

  // ── C. A NEGATIVE VERDICT IS REACHABLE (defect 1, the point) ────────────────

  it("C1. 100 serves + 30 dismisses classify 'normal' — a non-boosting verdict exists", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    const ITEM = "node/reachable";

    for (let i = 0; i < 100; i++) await f.serve(ITEM);
    assert.equal(
      f.stats.get(ITEM)!.underexposure_status, "boosting",
      "precondition: with no negative signal yet, 100 serves classify boosting",
    );

    // 30 dismisses through the real route. Each needs its own impression row —
    // one dismiss consumes one, exactly as production does.
    for (let i = 0; i < 30; i++) {
      assert.equal(await report(ITEM, "dismiss"), 200, `dismiss ${i + 1} must land`);
    }
    await settle();

    const row = f.stats.get(ITEM)!;
    assert.equal(row.eligible_impressions, 100, "the denominator is still the serve count");
    assert.equal(row.negative_signal_count, 30, "the numerator now has a writer");
    assert.equal(
      row.underexposure_status, "normal",
      "30/100 >= 0.3 ⇒ 'normal'. THIS IS THE WHOLE POINT: before the writer existed " +
      "the numerator was 0 for every row and this verdict was unreachable by construction",
    );

    // And the negative came from the dismiss path, not from the impression path:
    // every increment call is still p_negative_signal=false.
    for (const c of f.calls(INCREMENT_RPC)) {
      assert.equal(
        c.params.p_negative_signal, false,
        "the impression path contributes no negatives — 'normal' is reachable only via the 2297 writer",
      );
    }
  });

  it("C2. 100 serves + 0 dismisses still classify 'boosting' — the positive verdict is a measurement", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    const ITEM = "node/undisliked";

    for (let i = 0; i < 100; i++) await f.serve(ITEM);

    const row = f.stats.get(ITEM)!;
    assert.equal(row.negative_signal_count, 0);
    assert.equal(row.underexposure_status, "boosting");
  });

  it("C3. 29 dismisses over 100 serves stay 'boosting' — the threshold is a real boundary", async () => {
    const f = makeClient();
    _setTestClient(f.client, true);
    const ITEM = "node/boundary";

    for (let i = 0; i < 100; i++) await f.serve(ITEM);
    for (let i = 0; i < 29; i++) assert.equal(await report(ITEM, "dismiss"), 200);
    await settle();

    const row = f.stats.get(ITEM)!;
    assert.equal(row.negative_signal_count, 29);
    assert.equal(
      row.underexposure_status, "boosting",
      "29/100 < 0.3 — the verdict tracks the data on BOTH sides of the rate, which is " +
      "what makes it a classification rather than a constant",
    );
  });
});

// ── B4: the writer helper itself ──────────────────────────────────────────────

describe("recordNegativeDistributionSignal — the numerator writer", () => {
  it("B4. never throws, skips blank ids, and never calls the impression RPC", async () => {
    const f = makeClient();

    await recordNegativeDistributionSignal(f.client, "", ALICE_ID);
    assert.equal(f.rpcCalls.length, 0, "a blank id is not a signal");

    await recordNegativeDistributionSignal(null, "node/x", ALICE_ID);
    assert.equal(f.rpcCalls.length, 0, "a missing client is a no-op");

    await recordNegativeDistributionSignal(f.client as any, "node/x", ALICE_ID);
    assert.equal(f.calls(NEGATIVE_RPC).length, 1);
    assert.equal(f.calls(INCREMENT_RPC).length, 0);

    // A throwing / rejecting rpc must not propagate — this runs on the response
    // path of an outcome write that has already succeeded.
    const boom: any = { rpc: () => { throw new Error("rpc exploded"); } };
    await assert.doesNotReject(() => recordNegativeDistributionSignal(boom, "node/y", ALICE_ID));
    const rejects: any = { rpc: () => Promise.reject(new Error("rpc rejected")) };
    await assert.doesNotReject(() => recordNegativeDistributionSignal(rejects, "node/y", ALICE_ID));
    const errs: any = { rpc: () => Promise.resolve({ data: null, error: { message: "denied" } }) };
    await assert.doesNotReject(() => recordNegativeDistributionSignal(errs, "node/y", ALICE_ID));
  });
});

// ── D. Migration 2297, read as text ───────────────────────────────────────────

describe("migration 2297 — dismiss outcome + numerator-only RPC", () => {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_2297), "utf8");

  it("D1. widens the outcome CHECK to admit 'dismiss' and keeps every prior value", () => {
    const m = /ADD CONSTRAINT rank_events_outcome_check\s*\n?\s*CHECK \(outcome IN \(([^)]*)\)\)/m.exec(sql);
    assert.ok(m, "the migration must ADD a named outcome CHECK");
    const values = m![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
    for (const prior of ["impression", "tap", "save", "join", "rsvp", "attended", "analytics"]) {
      assert.ok(values.includes(prior), `additive only — '${prior}' must survive`);
    }
    assert.ok(values.includes("dismiss"), "'dismiss' must be admitted");
  });

  it("D2. is transactional and idempotent", () => {
    assert.match(sql, /^BEGIN;/m, "the DROP/ADD pair must not be able to half-apply");
    assert.match(sql, /^COMMIT;/m);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS rank_events_outcome_check/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION record_distribution_negative_signal/);
  });

  it("D3. the numerator RPC never moves eligible_impressions", () => {
    const fn = /CREATE OR REPLACE FUNCTION record_distribution_negative_signal[\s\S]*?\n\$\$;/.exec(sql);
    assert.ok(fn, "the function body must be present");
    const body = fn![0]!;
    const upsert = /ON CONFLICT \(item_id\) DO UPDATE SET([\s\S]*?)RETURNING/.exec(body);
    assert.ok(upsert, "the numerator write must be an upsert, not a literal overwrite");
    assert.ok(
      !/eligible_impressions\s*=/.test(upsert![1]!),
      "an outcome must never move the exposure denominator (00_STATUS defect 4)",
    );
    assert.match(upsert![1]!, /negative_signal_count\s*=\s*content_distribution_stats\.negative_signal_count \+ 1/);
    assert.match(body, /underexposure_status\s*=/, "it must RE-classify — a dismiss usually arrives after the threshold");
  });

  it("D4. grants EXECUTE to service_role only", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      assert.ok(
        sql.includes(`REVOKE ALL ON FUNCTION record_distribution_negative_signal(TEXT, TEXT, INTEGER, FLOAT) FROM ${role};`),
        `a SECURITY DEFINER ranking writer must not be callable by ${role}`,
      );
    }
    assert.ok(
      sql.includes("GRANT EXECUTE ON FUNCTION record_distribution_negative_signal(TEXT, TEXT, INTEGER, FLOAT) TO service_role;"),
    );
  });

  it("D5. the grant postconditions FILTER BY GRANTEE", () => {
    // A postcondition that counts grants without a grantee filter counts the
    // table owner's implicit grants and can never fail. Both grant checks here
    // must name the grantee they are asking about.
    const checks = sql.match(/FROM information_schema\.routine_privileges[\s\S]*?;/g) ?? [];
    assert.ok(checks.length >= 2, "both the positive and the negative grant check must exist");
    for (const c of checks) {
      assert.match(c, /grantee\s+(=|IN)/, "every grant postcondition must filter by grantee");
    }
    assert.ok(checks.some((c) => /grantee\s*=\s*'service_role'/.test(c)));
    assert.ok(checks.some((c) => /'anon'/.test(c) && /'authenticated'/.test(c)));
  });

  it("D6. does not touch increment_distribution_stats — no overload set is created", () => {
    // An overload of that name makes db.rpc("increment_distribution_stats", …)
    // resolve ambiguously and fail at runtime. This migration adds a DIFFERENTLY
    // NAMED function precisely so that cannot happen.
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    assert.ok(
      !/(CREATE|DROP|ALTER)\s+(OR REPLACE\s+)?FUNCTION[^\n;]*increment_distribution_stats/i.test(statements),
      "2059's 5-argument increment_distribution_stats must be left exactly as it is",
    );
    assert.match(
      sql,
      /expected exactly 1 record_distribution_negative_signal/,
      "a postcondition must prove the new name is not itself an overload set",
    );
  });
});
