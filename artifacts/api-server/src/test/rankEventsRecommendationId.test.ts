/**
 * census-discovery DV-46 / DSV2-12 — `04` §10.6: an outcome upgrade must carry
 * the exposure's `recommendation_id`, and the (recommendation_id, outcome)
 * unique index must be the idempotency arbiter for the row it writes.
 *
 * WHAT WAS MISSING
 * ----------------
 * `lib/discoveryRecommendationId.recommendationIdFor` already mints a
 * server-side token per exposure and `lib/discoveryServeLog.ts` already writes
 * it into `rank_events.features.recommendationId`. Migration
 * `2891_rank_events_recommendation_id.sql` gives that token a COLUMN and a
 * UNIQUE index over `(recommendation_id, outcome)`. What nothing did was carry
 * the token forward when `POST /rank-events/outcome` upgrades the exposure: the
 * funnel row was updated without it, and the analytics row was `.insert()`ed
 * without it — so the exposure and its outcomes shared no key, `04` §10.6 had
 * nothing to propagate, and a re-fired outcome appended a duplicate analytics
 * row instead of upgrading the one already there.
 *
 * THE MIGRATION IS NOT APPLIED ANYWHERE. That is the load-bearing constraint on
 * this design and it is tested here, not assumed: on a database WITHOUT the
 * column the route must still record the outcome, must NOT 500, and must SAY SO
 * — see suite N. A column nothing can write satisfies nothing; a route that
 * crashes when the column is absent satisfies less than nothing.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/rankEventsRecommendationId.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { recommendationIdFor } from "../lib/discoveryRecommendationId.js";
import { _resetRecommendationIdSchemaLatch } from "../routes/rankEvents.js";

const ALICE_ID   = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const ITEM_ID    = "item1111-1111-1111-1111-111111111111";
const ROW_ID     = "row00000-0000-0000-0000-000000000001";
const SESSION_ID = "5e550000-0000-0000-0000-000000000001";
const SERVED_AT  = "2026-09-01T10:00:00.000Z";
/** 22 chars of base64url — the shape migration 2891's CHECK constraint permits. */
const MINTED_ID  = "AbCdEfGhIjKlMnOpQrSt_-";

// ── Fake client ───────────────────────────────────────────────────────────────

interface Capture {
  table:    string;
  op:       "select" | "update" | "insert" | "upsert";
  payload:  any;
  opts?:    any;
  rejected?: boolean;
}

interface LogLine { ctx: any; msg: string }

const COLUMN_MISSING = {
  code: "42703",
  message: 'column rank_events.recommendation_id does not exist',
};
const SCHEMA_CACHE_MISS = {
  code: "PGRST204",
  message: "Could not find the 'recommendation_id' column of 'rank_events' in the schema cache",
};
const NO_ARBITER = {
  code: "42P10",
  message: "there is no unique or exclusion constraint matching the ON CONFLICT specification",
};

function makeClient(o: {
  rankEventsRows?: any[];
  captures?: Capture[];
  /** Simulates a database on which migration 2891 has NOT been applied. */
  columnMissing?: boolean;
}) {
  const captures = o.captures ?? [];
  const missing  = o.columnMissing === true;
  const db: Record<string, any[]> = {
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    rank_events: o.rankEventsRows ?? [],
  };

  function selectBuilder(table: string, cols: string) {
    let filtered = [...(db[table] ?? [])];
    const fail = missing && /recommendation_id/.test(cols);
    captures.push({ table, op: "select", payload: cols, rejected: fail });
    const settle = () =>
      fail ? { data: null, error: COLUMN_MISSING } : { data: [...filtered], error: null };
    const one = () =>
      fail ? { data: null, error: COLUMN_MISSING } : { data: filtered[0] ?? null, error: null };
    const b: any = {
      eq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] === v); return b; },
      in: (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[c])); return b; },
      order: (c: string, opt?: { ascending?: boolean }) => {
        const d = (opt?.ascending ?? true) ? 1 : -1;
        filtered = [...filtered].sort((x, y) => (x[c] < y[c] ? -d : x[c] > y[c] ? d : 0));
        return b;
      },
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve(one()),
      single:      () => Promise.resolve(one()),
      then: (resolve: any) => resolve(settle()),
    };
    return b;
  }

  function updateBuilder(table: string, patch: Record<string, any>) {
    const fail = missing && Object.prototype.hasOwnProperty.call(patch, "recommendation_id");
    return {
      eq: (c: string, v: any) => {
        captures.push({ table, op: "update", payload: patch, rejected: fail });
        if (fail) return Promise.resolve({ data: null, error: SCHEMA_CACHE_MISS });
        db[table] = (db[table] ?? []).map((r) => (r[c] === v ? { ...r, ...patch } : r));
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  return {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => ({
      select: (cols?: string) => selectBuilder(table, cols ?? "*"),
      update: (patch: Record<string, any>) => updateBuilder(table, patch),
      insert: (payload: any) => {
        captures.push({ table, op: "insert", payload });
        return Promise.resolve({ data: null, error: null });
      },
      upsert: (payload: any, opts?: any) => {
        captures.push({ table, op: "upsert", payload, opts, rejected: missing });
        return Promise.resolve(missing ? { data: null, error: NO_ARBITER } : { data: null, error: null });
      },
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

async function makeApp(logs: LogLine[]): Promise<Express> {
  const app = express();
  app.use(express.json());
  // pino-http is not mounted in tests; the route reads req.log, so supply one.
  app.use((req: any, _res, next) => {
    req.log = {
      warn:  (ctx: any, msg?: string) => logs.push({ ctx, msg: msg ?? String(ctx) }),
      error: (ctx: any, msg?: string) => logs.push({ ctx, msg: msg ?? String(ctx) }),
      info:  () => {},
    };
    next();
  });
  const { default: rankEventsRouter } = await import("../routes/rankEvents.js");
  app.use("/api", rankEventsRouter);
  return app;
}

function impressionRow(extra: Record<string, any> = {}) {
  return {
    id:                ROW_ID,
    user_id:           ALICE_ID,
    item_id:           ITEM_ID,
    item_kind:         "place",
    surface:           "discovery",
    outcome:           "impression",
    position:          3,
    features:          {},
    served_at:         SERVED_AT,
    session_id:        SESSION_ID,
    outcome_at:        null,
    recommendation_id: null,
    ...extra,
  };
}

function postOutcome(url: string, body: Record<string, unknown>) {
  return fetch(`${url}/api/rank-events/outcome`, {
    method:  "POST",
    headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

// ── Suite P — the token is carried ────────────────────────────────────────────

describe("DV-46 — an outcome upgrade carries the exposure's recommendation_id", async () => {
  let url: string; let close: () => Promise<void>;
  before(async () => { ({ url, close } = await startServer(await makeApp([]))); });
  after(async () => { await close(); _setTestClient(null as any, false); });

  it("P1. the minted id already on the exposure row is written onto the upgraded row", async () => {
    _resetRecommendationIdSchemaLatch();
    const captures: Capture[] = [];
    _setTestClient(makeClient({
      captures,
      rankEventsRows: [impressionRow({ recommendation_id: MINTED_ID })],
    }) as any, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "tap" });
    assert.equal(r.status, 200, await r.text());

    const upd = captures.filter((c) => c.op === "update" && c.table === "rank_events");
    assert.equal(upd.length, 1, "exactly one funnel-row update");
    assert.equal(upd[0]!.payload.outcome, "tap", "the outcome must still be upgraded");
    assert.equal(
      upd[0]!.payload.recommendation_id, MINTED_ID,
      "04 §10.6: the outcome row must carry the SAME exposure token as the impression, " +
      "or the exposure and its outcomes share no key and nothing propagates",
    );
  });

  it("P2. an id in features.recommendationId (what discoveryServeLog writes today) is used", async () => {
    _resetRecommendationIdSchemaLatch();
    const captures: Capture[] = [];
    _setTestClient(makeClient({
      captures,
      rankEventsRows: [impressionRow({ features: { recommendationId: MINTED_ID } })],
    }) as any, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "save" });
    assert.equal(r.status, 200, await r.text());

    const upd = captures.find((c) => c.op === "update")!;
    assert.equal(
      upd.payload.recommendation_id, MINTED_ID,
      "lib/discoveryServeLog.ts writes the token into features.recommendationId and the " +
      "column is empty until 2891 is applied AND that writer threads it — the route must " +
      "read the jsonb copy rather than invent a second identity for the same exposure",
    );
  });

  it("P3. with no stored id, the token is DERIVED from the exposure's own coordinates", async () => {
    _resetRecommendationIdSchemaLatch();
    const captures: Capture[] = [];
    _setTestClient(makeClient({ captures, rankEventsRows: [impressionRow()] }) as any, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "tap" });
    assert.equal(r.status, 200, await r.text());

    const expected = recommendationIdFor({
      userId: ALICE_ID, sessionId: SESSION_ID, servedAt: SERVED_AT,
      surface: "discovery", position: 3, itemId: ITEM_ID,
    });
    const upd = captures.find((c) => c.op === "update")!;
    assert.equal(
      upd.payload.recommendation_id, expected,
      "recommendationIdFor is pure and total over (userId, sessionId, servedAt, surface, " +
      "position, itemId) — every one of which is a column on the row just read, so the " +
      "route can reproduce the writer's token exactly rather than minting a rival one",
    );
  });
});

// ── Suite A — the unique index is the arbiter ─────────────────────────────────

describe("DV-46 — the analytics row upgrades through the (recommendation_id, outcome) arbiter", async () => {
  let url: string; let close: () => Promise<void>;
  before(async () => { ({ url, close } = await startServer(await makeApp([]))); });
  after(async () => { await close(); _setTestClient(null as any, false); });

  it("A1. writes the analytics row as an ON CONFLICT upgrade, not a duplicate insert", async () => {
    _resetRecommendationIdSchemaLatch();
    const captures: Capture[] = [];
    _setTestClient(makeClient({
      captures,
      rankEventsRows: [impressionRow({ recommendation_id: MINTED_ID })],
    }) as any, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "tap" });
    assert.equal(r.status, 200, await r.text());
    await new Promise((res) => setImmediate(res));

    const plainInserts = captures.filter((c) => c.op === "insert" && c.table === "rank_events");
    assert.equal(
      plainInserts.length, 0,
      "a bare .insert() appends a second analytics row for the same exposure on every repeat; " +
      "2891 exists so that write can be arbitrated instead",
    );

    const ups = captures.filter((c) => c.op === "upsert" && c.table === "rank_events");
    assert.equal(ups.length, 1, "exactly one analytics write");
    assert.equal(
      ups[0]!.opts?.onConflict, "recommendation_id,outcome",
      "the arbiter must name BOTH key columns in index order — migration 2891 records that a " +
      "bare onConflict: 'recommendation_id' raises 42P10 against this index",
    );
    assert.equal(
      ups[0]!.payload.recommendation_id, MINTED_ID,
      "the analytics row must carry the same exposure token",
    );
    assert.equal(ups[0]!.payload.outcome, "analytics", "analytics sentinel outcome preserved");
    assert.notEqual(
      ups[0]!.opts?.ignoreDuplicates, true,
      "ignoreDuplicates would make a repeat a NO-OP; the requirement is an UPGRADE, so the " +
      "later event_type must win",
    );
  });
});

// ── Suite N — a database WITHOUT migration 2891 ───────────────────────────────

describe("DV-46 — degrades safely and observably when rank_events.recommendation_id is absent", async () => {
  let url: string; let close: () => Promise<void>; let logs: LogLine[];
  before(async () => { logs = []; ({ url, close } = await startServer(await makeApp(logs))); });
  after(async () => { await close(); _setTestClient(null as any, false); });

  it("N1. still records the outcome (200), re-reading and re-writing without the column", async () => {
    _resetRecommendationIdSchemaLatch();
    logs.length = 0;
    const captures: Capture[] = [];
    _setTestClient(makeClient({
      captures,
      columnMissing: true,
      rankEventsRows: [impressionRow()],
    }) as any, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "tap" });
    assert.equal(r.status, 200, "a column that does not exist must not turn an outcome into a 500");
    assert.deepEqual(await r.json(), { ok: true });

    const accepted = captures.filter((c) => c.op === "update" && !c.rejected);
    assert.equal(accepted.length, 1, "the funnel row must still be upgraded exactly once");
    assert.equal(accepted[0]!.payload.outcome, "tap", "the outcome must not be dropped");
    assert.equal(
      Object.prototype.hasOwnProperty.call(accepted[0]!.payload, "recommendation_id"), false,
      "the retry must omit the column entirely rather than send null — sending it again is the " +
      "same failure a second time",
    );
  });

  it("N2. SAYS SO — the missing column is reported, not silently absorbed", async () => {
    const hit = logs.find((l) => /recommendation_id/i.test(l.msg) || /recommendation_id/i.test(JSON.stringify(l.ctx ?? {})));
    assert.ok(
      hit,
      "a database missing 2891 must be distinguishable from one that has it; otherwise the " +
      "route degrades permanently and nobody ever learns the migration was never applied. " +
      `log lines seen: ${JSON.stringify(logs.map((l) => l.msg))}`,
    );
  });

  it("N3. the analytics row is still written, through a plain insert", async () => {
    logs.length = 0;
    const captures: Capture[] = [];
    _setTestClient(makeClient({
      captures,
      columnMissing: true,
      rankEventsRows: [impressionRow()],
    }) as any, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "tap" });
    assert.equal(r.status, 200, await r.text());
    await new Promise((res) => setImmediate(res));

    const ins = captures.filter((c) => c.op === "insert" && c.table === "rank_events");
    assert.equal(ins.length, 1, "the analytics signal must not be lost with the arbiter");
    assert.equal(
      Object.prototype.hasOwnProperty.call(ins[0]!.payload, "recommendation_id"), false,
      "no recommendation_id on a table that has no such column",
    );
    assert.equal(ins[0]!.payload.outcome, "analytics");
  });

  it("N5. a schema-cache miss on the WRITE alone is retried without the column, not 500'd", async () => {
    _resetRecommendationIdSchemaLatch();
    logs.length = 0;
    const captures: Capture[] = [];
    // PostgREST's schema cache and the catalogue drift independently: the SELECT
    // can see the column while a write still 404s it. The outcome must survive.
    const client: any = makeClient({
      captures,
      rankEventsRows: [impressionRow({ recommendation_id: MINTED_ID })],
    });
    const realFrom = client.from;
    let updates = 0;
    client.from = (table: string) => {
      const t = realFrom(table);
      if (table !== "rank_events") return t;
      return {
        ...t,
        update: (patch: Record<string, any>) => ({
          eq: (c: string, v: any) => {
            updates += 1;
            captures.push({ table, op: "update", payload: patch });
            if (Object.prototype.hasOwnProperty.call(patch, "recommendation_id")) {
              return Promise.resolve({ data: null, error: SCHEMA_CACHE_MISS });
            }
            void c; void v;
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
    };
    _setTestClient(client, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "tap" });
    assert.equal(r.status, 200, "a PGRST204 on the write must not lose the outcome");
    assert.equal(updates, 2, "one attempt with the column, one retry without it");

    const accepted = captures.filter(
      (c) => c.op === "update" && !Object.prototype.hasOwnProperty.call(c.payload, "recommendation_id"),
    );
    assert.equal(accepted.length, 1, "the retry omits the column");
    assert.equal(accepted[0]!.payload.outcome, "tap");
    assert.ok(
      logs.some((l) => /recommendation_id/i.test(l.msg) || /recommendation_id/i.test(JSON.stringify(l.ctx ?? {}))),
      "the degradation is reported",
    );
  });

  it("N4. a genuine database error is STILL a 500 — the fallback is not a catch-all", async () => {
    _resetRecommendationIdSchemaLatch();
    logs.length = 0;
    const captures: Capture[] = [];
    const client: any = makeClient({ captures, rankEventsRows: [impressionRow()] });
    const realFrom = client.from;
    client.from = (table: string) => {
      const t = realFrom(table);
      if (table !== "rank_events") return t;
      return {
        ...t,
        update: () => ({
          eq: () => Promise.resolve({
            data: null,
            error: { code: "57014", message: "canceling statement due to statement timeout" },
          }),
        }),
      };
    };
    _setTestClient(client, true);

    const r = await postOutcome(url, { item_id: ITEM_ID, surface: "discovery", outcome: "tap" });
    assert.equal(
      r.status, 500,
      "a statement timeout is not a missing column; degrading on it would hide real outages",
    );
  });
});
