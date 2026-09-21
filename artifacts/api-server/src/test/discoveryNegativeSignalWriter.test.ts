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
import { loadDismissedPlaceIds, withoutDismissed, DISMISSED_MAX_IDS } from "../lib/discoveryDismissed.js";

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

// ── E. THE READ SIDE — a dismissal that changes nothing is not a dismissal ────
//
// Sections A-D above pin the WRITER. They were complete and they were not
// enough: census-discovery §12.6 recorded that "the writer exists and is
// unexercised", and the half it did not say out loud is that NOTHING READ THE
// ROWS BACK either. A dismiss landed in rank_events, moved the cross-viewer
// `negative_signal_count`, and left the person who sent it looking at exactly
// the same Discovery results. The one thing "Not interested" plainly promises —
// that this place stops coming back — was the one thing it did not do.
//
// `lib/discoveryDismissed.ts` is that reader and `routes/discovery.ts` applies
// it on all four serve paths. These cases pin the reader's own contract: what it
// returns, who it returns it for, and — the part with the most weight on it —
// that it never reports a failed read as an absence of dismissals.

describe("the dismissal READ — suppression, and the failure it refuses to swallow", () => {
  /**
   * A fake postgrest chain that records the filters it was given, so a case can
   * assert the read is VIEWER-SCOPED rather than merely that it returned rows.
   * Any operator it does not model throws, so a filter silently matching
   * everything surfaces as an error instead of a pass.
   */
  function dismissClient(
    rows: Array<{ user_id: string; surface: string; outcome: string; item_id: string }>,
    opts: { unreadable?: boolean; throws?: boolean } = {},
  ) {
    const filters: Array<[string, unknown]> = [];
    let limitArg: number | null = null;
    const client = {
      from(table: string) {
        if (table !== "rank_events") throw new Error(`fake: unexpected table ${table}`);
        let out = [...rows];
        const q: any = {
          select() { return q; },
          eq(col: string, val: unknown) {
            filters.push([col, val]);
            out = out.filter((r) => (r as any)[col] === val);
            return q;
          },
          order() { return q; },
          limit(n: number) { limitArg = n; out = out.slice(0, n); return q; },
          then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
            if (opts.throws) return Promise.reject(new Error("boom")).then(resolve, reject);
            const result = opts.unreadable
              ? { data: null, error: { message: "simulated unreadable rank_events" } }
              : { data: out.map((r) => ({ item_id: r.item_id })), error: null };
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return q;
      },
    };
    return { client, filters: () => filters, limitArg: () => limitArg };
  }

  const BOB_ID = "b0b0b0b0-bbbb-bbbb-bbbb-000000000002";

  function corpus() {
    return [
      { user_id: ALICE_ID, surface: "discovery", outcome: "dismiss",    item_id: "node/1" },
      { user_id: ALICE_ID, surface: "discovery", outcome: "dismiss",    item_id: "node/2" },
      // Same person, same surface, a POSITIVE outcome — must not suppress.
      { user_id: ALICE_ID, surface: "discovery", outcome: "impression", item_id: "node/3" },
      // Same person, a dismiss on ANOTHER surface — must not suppress here.
      { user_id: ALICE_ID, surface: "pulse",     outcome: "dismiss",    item_id: "node/4" },
      // SOMEBODY ELSE's dismissal. The load-bearing row of this fixture.
      { user_id: BOB_ID,   surface: "discovery", outcome: "dismiss",    item_id: "node/5" },
    ];
  }

  it("E1. returns exactly the viewer's own discovery dismissals", async () => {
    const f = dismissClient(corpus());
    const got = await loadDismissedPlaceIds(f.client as any, ALICE_ID);
    assert.equal(got.degraded, false, "a readable table is not a degraded read");
    assert.deepEqual(
      [...got.ids].sort(), ["node/1", "node/2"],
      "the set must be this viewer's discovery-surface dismissals and nothing else",
    );
  });

  it("E2. PRIVACY — another person's dismissal never reaches this viewer's set", async () => {
    // Stated as its own case rather than left implicit in E1. A dismissal set
    // that leaked across viewers would let one person's taps shrink another
    // person's Discovery results, which is both a privacy defect and a
    // suppression primitive handed to anyone who wants one.
    const f = dismissClient(corpus());
    const got = await loadDismissedPlaceIds(f.client as any, ALICE_ID);
    assert.ok(!got.ids.has("node/5"), "BOB's dismissal must not suppress anything for ALICE");
    assert.ok(
      f.filters().some(([col, val]) => col === "user_id" && val === ALICE_ID),
      "the read must be keyed to the viewer at the QUERY, not filtered afterwards",
    );
    assert.ok(
      f.filters().some(([col, val]) => col === "surface" && val === "discovery"),
      "the read must be scoped to the discovery surface",
    );
    assert.ok(
      f.filters().some(([col, val]) => col === "outcome" && val === "dismiss"),
      "the read must select dismissals, not every outcome",
    );
  });

  it("E3. an UNREADABLE table is degraded, NOT an empty dismissal list", async () => {
    // The whole reason the flag exists. supabase-js RESOLVES on a DB error, so
    // an unreadable table and a viewer who has dismissed nothing arrive
    // identically. Reporting the first as the second would serve dismissed
    // places back with nothing on the response to say why.
    const f = dismissClient(corpus(), { unreadable: true });
    const got = await loadDismissedPlaceIds(f.client as any, ALICE_ID);
    assert.equal(got.degraded, true, "a failed read must be reported, never resolved into an emptiness");
    assert.equal(got.ids.size, 0);
  });

  it("E4. a THROWING read is degraded too", async () => {
    const f = dismissClient(corpus(), { throws: true });
    const got = await loadDismissedPlaceIds(f.client as any, ALICE_ID);
    assert.equal(got.degraded, true, "the throw arm must report, not swallow");
  });

  it("E5. VACUITY GUARD — a viewer with no dismissals is NOT degraded", async () => {
    // Without this, "reports degraded on failure" is satisfied by reporting
    // degraded always, which would put `coverage: "partial"` on every Discovery
    // response and make the word meaningless.
    const f = dismissClient([]);
    const got = await loadDismissedPlaceIds(f.client as any, ALICE_ID);
    assert.equal(got.degraded, false, "an empty-but-READ dismissal list is a complete answer");
    assert.equal(got.ids.size, 0);
  });

  it("E6. an anonymous caller reads nothing and is not degraded", async () => {
    const f = dismissClient(corpus());
    const got = await loadDismissedPlaceIds(f.client as any, null);
    assert.equal(got.degraded, false, "there is no viewer to have dismissed anything — that is complete, not failed");
    assert.equal(got.ids.size, 0);
    assert.deepEqual(f.filters(), [], "no read should have been issued at all");
  });

  it("E7. the read is bounded", async () => {
    const f = dismissClient(corpus());
    await loadDismissedPlaceIds(f.client as any, ALICE_ID);
    assert.equal(
      f.limitArg(), DISMISSED_MAX_IDS,
      "an unbounded read on rank_events is a request-time hazard on a table that only grows",
    );
  });

  it("E8. withoutDismissed removes exactly the dismissed places and keeps order", async () => {
    const page = [{ id: "node/1" }, { id: "node/3" }, { id: "node/2" }, { id: "node/9" }];
    const out = withoutDismissed(page, new Set(["node/1", "node/2"]));
    assert.deepEqual(
      out.map((p) => p.id), ["node/3", "node/9"],
      "the filter must remove the dismissed ids and disturb nothing else",
    );
  });

  it("E9. withoutDismissed with an empty set is the IDENTITY, by reference", async () => {
    // Almost every request. Returning a copy would silently re-allocate every
    // page on a route that already has four serve paths, and — more to the point
    // — a filter that rebuilds the array is a filter that could reorder it.
    const page = [{ id: "node/1" }, { id: "node/2" }];
    assert.equal(withoutDismissed(page, new Set()), page, "an empty dismissal set must not touch the page at all");
  });

  it("E10. a dismissal CANNOT resurrect itself on a window — there is none", () => {
    // `lib/discoveryPde.ts` bounds its SEEN set to 24 hours because "recently
    // shown" is a claim about recency. "Not interested" is not, and an expiring
    // dismissal would quietly bring every rejected place back on a schedule the
    // person was never told about. Read from the source rather than asserted, so
    // adding a window later turns this red instead of passing silently.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../lib/discoveryDismissed.ts"),
      "utf8",
    );
    const read = /loadDismissedPlaceIds[\s\S]*?^}/m.exec(src);
    assert.ok(read, "loadDismissedPlaceIds must be present");
    assert.ok(
      !/\bgte\(|\blte\(|served_at.*since|SEEN_WINDOW/i.test(read![0]!),
      "the dismissal read must not acquire a time window — see the module header",
    );
  });
});

// ── F. Migration 2995 — the index the read depends on ─────────────────────────

describe("migration 2995 — the dismissal read's index", () => {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, "2995_rank_events_discovery_dismissed_index.sql"), "utf8");

  it("F1. creates a PARTIAL index on the read's own predicate", () => {
    assert.match(sql, /CREATE INDEX IF NOT EXISTS rank_events_discovery_dismissed/);
    const stmt = /CREATE INDEX IF NOT EXISTS rank_events_discovery_dismissed[\s\S]*?;/.exec(sql);
    assert.ok(stmt, "the CREATE INDEX statement must be present");
    assert.match(stmt![0]!, /WHERE outcome = 'dismiss' AND surface = 'discovery'/,
      "a non-partial index would span every rank_events row and defeat the file");
    assert.match(stmt![0]!, /\(user_id, served_at DESC, item_id\)/,
      "the key must serve the viewer predicate, the ordering and the projection");
  });

  it("F2. is additive and idempotent", () => {
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
    assert.match(sql, /IF NOT EXISTS/, "re-running the file must be a no-op");
    assert.ok(
      !/(ALTER TABLE[^\n;]*DROP|DROP TABLE|DELETE FROM|UPDATE\s+rank_events)/i.test(
        sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"),
      ),
      "an index migration must not drop, delete or rewrite anything",
    );
  });

  it("F3. REFUSES to apply if 2297 has not — an index over an illegal value indexes nothing", () => {
    assert.match(sql, /PRECONDITION FAILED[\s\S]*?apply 2297 first/,
      "a predicate naming a value the CHECK forbids succeeds and silently indexes nothing");
  });

  it("F4. its postconditions are absolute and re-runnable", () => {
    // certify:migrations re-executes the postcondition block standalone, so it
    // may not depend on anything this run did — no temp tables, no before/after.
    const post = /DO \$post\$[\s\S]*?\$post\$;/.exec(sql);
    assert.ok(post, "a postcondition block must exist");
    assert.ok(
      !/CREATE TEMP|pg_temp|\bbefore_\w+|\bafter_\w+/i.test(post![0]!),
      "the postconditions must be answerable from the catalog alone",
    );
    assert.match(post![0]!, /POSTCONDITION FAILED[\s\S]*?is not partial/,
      "an index created without the WHERE clause must FAIL the file, not pass it");
    assert.match(post![0]!, /rank_events_features_gin[\s\S]*?rank_events_user_item/,
      "the three 0153 indexes must be proved still present — this file adds, it never removes");
  });
});
