/**
 * census-discovery DV-37 / DV-40 / DV-44 / DV-46 — `POST /rank-events`, the
 * `living_page` exposure writer, and 2891's index used as an ARBITER.
 *
 * WHY THIS ROUTE AND NOT ONLY THE SERVE LOG
 * =========================================
 * §41.1 is the section this file is built on:
 *
 *   > `watch_feed` has a live intentional writer … `living_page` likewise, from
 *   > `routes/rankEvents.ts`. So the nine is **seven**.
 *
 * DV-44 grades `04` §10.2 — *"prove at least one intentional writer per surface,
 * or retire it"* — and its own evidence cell is wrong about this surface. But a
 * writer is only half of what the clause is worth: `living_page` had rows and
 * none of them carried a `recommendation_id`, so nothing written on that surface
 * could be attributed to the ranking that produced it. A surface with telemetry
 * nothing can join is a surface that passes an audit and answers no question.
 *
 * `2891_rank_events_recommendation_id.sql` was applied to portava-ci AND to
 * production on 2026-09-14, and its own COMMENT records what was still missing:
 *
 *   > As of migration 2891 NOTHING writes this column … Supplying the column and
 *   > the onConflict clause is the code half of DV-37.
 *
 * This route now supplies both, on all three of its write paths.
 *
 * WHAT IS ASSERTED
 * ================
 *   D1  the single direct impression carries a 22-char token in the COLUMN
 *   D2  it is written as an ON CONFLICT upgrade on (recommendation_id, outcome),
 *       ignoreDuplicates FALSE — so a re-fired client event SETTLES rather than
 *       appending a second exposure to the denominator
 *   D3  the token is stable for one (user, instant, item) and DIFFERENT across
 *       items — the two properties that make the arbiter mean anything
 *   D4  42703 / PGRST204 / 42P10 ⇒ retried WITHOUT the column, said once,
 *       latched, and the request still answers 200 { ok: true }
 *   D5  after the latch the column is not sent at all — the failed round-trip is
 *       paid once per process, not once per request
 *   D6  a client object with no `.upsert` still writes the column
 *   D7  the BATCH form mints one token per item, by batch index, and degrades
 *       instead of turning a 2891-less database into a permanent 500
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/rankEventsDirectExposureProvenance.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { recommendationIdFor } from "../lib/discoveryRecommendationId.js";
import {
  RECOMMENDATION_ARBITER,
  RECOMMENDATION_ID_SHAPE,
  _resetRecommendationIdSchemaLatch,
  _resetRankEventsRejections,
} from "../lib/rankEventsProvenance.js";

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const PLACE_A  = "db/place-a";
const PLACE_B  = "db/place-b";

const COLUMN_MISSING    = { code: "42703",    message: "column rank_events.recommendation_id does not exist" };
const SCHEMA_CACHE_MISS = { code: "PGRST204", message: "Could not find the 'recommendation_id' column of 'rank_events' in the schema cache" };
const NO_ARBITER        = { code: "42P10",    message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" };

interface Write { op: "insert" | "upsert"; payload: any; opts?: any }
interface LogLine { ctx: any; msg: string }

/**
 * `failWhileColumnPresent` reproduces a database without 2891: any statement
 * naming `recommendation_id` is refused, everything else succeeds. That is the
 * shape the route has to survive, and asserting on a stub that always succeeds
 * would prove only that the happy path exists.
 */
function makeClient(o: {
  writes?: Write[];
  failWhileColumnPresent?: unknown;
  withUpsert?: boolean;
}) {
  const writes = o.writes ?? [];
  const namesColumn = (payload: any) => {
    const rows = Array.isArray(payload) ? payload : [payload];
    return rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, "recommendation_id"));
  };
  const settle = (payload: any) =>
    o.failWhileColumnPresent !== undefined && namesColumn(payload)
      ? { data: null, error: o.failWhileColumnPresent }
      : { data: null, error: null };

  const rel: any = {
    insert: (payload: any) => { writes.push({ op: "insert", payload }); return Promise.resolve(settle(payload)); },
  };
  if (o.withUpsert !== false) {
    rel.upsert = (payload: any, opts?: any) => {
      writes.push({ op: "upsert", payload, opts });
      return Promise.resolve(settle(payload));
    };
  }

  return {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => {
      if (table === "rank_events") return rel;
      const b: any = {
        select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
        maybeSingle: () => Promise.resolve({ data: { id: ALICE_ID, account_status: "active" }, error: null }),
        single:      () => Promise.resolve({ data: { id: ALICE_ID, account_status: "active" }, error: null }),
        then:   (resolve: any) => resolve({ data: [{ id: ALICE_ID, account_status: "active" }], error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        upsert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
      return b;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

async function makeApp(logs: LogLine[]): Promise<Express> {
  const app = express();
  app.use(express.json());
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

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
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

function post(url: string, body: unknown) {
  return fetch(`${url}/api/rank-events`, {
    method:  "POST",
    headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

const ONE = (id: string) => ({ event_type: "place_view", entity_type: "place", entity_id: id });

/** Every payload row across all captured statements. */
function rowsOf(writes: Write[]): any[] {
  return writes.flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload]));
}

describe("DV-40 / DV-44 — the living_page writer carries 2891's token", () => {
  let url: string; let close: () => Promise<void>; let logs: LogLine[];
  before(async () => { logs = []; ({ url, close } = await startServer(await makeApp(logs))); });
  after(async () => { await close(); _setTestClient(null as any, false); });
  beforeEach(() => { _resetRecommendationIdSchemaLatch(); _resetRankEventsRejections(); logs.length = 0; });

  it("D1. the direct impression carries a 22-char token in the COLUMN", async () => {
    const writes: Write[] = [];
    _setTestClient(makeClient({ writes }) as any, true);

    const r = await post(url, ONE(PLACE_A));
    const body = await r.text();
    assert.equal(r.status, 200, body);
    assert.deepEqual(JSON.parse(body), { ok: true }, "the response body is unchanged");

    const rows = rowsOf(writes);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.surface, "living_page");
    assert.match(
      rows[0]!.recommendation_id, RECOMMENDATION_ID_SHAPE,
      "§41.1 proves this surface HAS a writer; a writer whose rows carry no join key still " +
      "leaves every living_page row unattributable to the ranking that produced it",
    );
  });

  it("D2. it is an ON CONFLICT upgrade on (recommendation_id, outcome)", async () => {
    const writes: Write[] = [];
    _setTestClient(makeClient({ writes }) as any, true);
    await post(url, ONE(PLACE_A));

    assert.equal(writes.length, 1);
    assert.equal(
      writes[0]!.op, "upsert",
      "2891's COMMENT says it verbatim: 'Supplying the column and the onConflict clause is " +
      "the code half of DV-37.' A plain insert supplies half",
    );
    // The LITERAL, not the constant. Asserting `opts.onConflict === RECOMMENDATION_ARBITER`
    // passed against a mutant that changed the constant to "recommendation_id" — both
    // sides moved together, so the assertion proved only that the route uses the export.
    // The string that has to be right is the one 2891 created the index over.
    assert.equal(
      writes[0]!.opts?.onConflict, "recommendation_id,outcome",
      "recommendation_id ALONE raises 42P10 against 2891's two-column index, and 2891's own " +
      "COMMENT says why the outcome is in the key: an exposure and each of its outcomes are " +
      "separate rows sharing one token, so a single-column key rejects every tap and save",
    );
    assert.equal(
      RECOMMENDATION_ARBITER, "recommendation_id,outcome",
      "and the shared constant is that same string — one definition, checked against the " +
      "migration rather than against itself",
    );
    assert.equal(
      writes[0]!.opts?.ignoreDuplicates, false,
      "DO NOTHING would make a re-fired client event a silent no-op; the requirement is that " +
      "the row ends up correct, not that the second attempt is discarded",
    );
  });

  it("D3. the token is a function of the exposure, and differs per item", async () => {
    const writes: Write[] = [];
    _setTestClient(makeClient({ writes }) as any, true);
    await post(url, ONE(PLACE_A));
    await post(url, ONE(PLACE_B));

    const [a, b] = rowsOf(writes);
    assert.equal(
      a!.recommendation_id,
      recommendationIdFor({
        userId: ALICE_ID, sessionId: "", servedAt: a!.served_at,
        surface: "living_page", position: 0, itemId: PLACE_A,
      }),
      "REPRODUCIBLE from the row's own columns — that is what lets the outcome route derive " +
      "the same token for a row written before 2891 instead of minting a rival identity",
    );
    assert.notEqual(
      a!.recommendation_id, b!.recommendation_id,
      "two different places are two different exposures; one token for both would make the " +
      "arbiter collapse them and under-count the denominator",
    );
  });

  for (const [name, err] of [
    ["42703 (no column)", COLUMN_MISSING],
    ["PGRST204 (schema cache)", SCHEMA_CACHE_MISS],
    ["42P10 (no arbiter)", NO_ARBITER],
  ] as const) {
    it(`D4. ${name} ⇒ retried without the column, still 200, and said`, async () => {
      const writes: Write[] = [];
      _resetRecommendationIdSchemaLatch();
      logs.length = 0;
      _setTestClient(makeClient({ writes, failWhileColumnPresent: err }) as any, true);

      const r = await post(url, ONE(PLACE_A));
      assert.equal(
        r.status, 200,
        "a column this database does not have must not turn a Living Page view into a 500",
      );
      assert.deepEqual(await r.json(), { ok: true });
      assert.equal(writes.length, 2, "one attempt with the column, one retry without it");
      assert.equal(
        Object.prototype.hasOwnProperty.call(writes[1]!.payload, "recommendation_id"), false,
        "the retry OMITS the column rather than sending null — sending it again is the same " +
        "failure a second time",
      );
      assert.equal(writes[1]!.payload.outcome, "impression", "the signal is not dropped");
      assert.ok(
        logs.some((l) => /2891|recommendation_id/i.test(l.msg + JSON.stringify(l.ctx ?? {}))),
        `a database without 2891 must be distinguishable from one with it. logs: ${JSON.stringify(logs.map((l) => l.msg))}`,
      );
    });
  }

  it("D5. after the latch the column is not sent at all", async () => {
    const writes: Write[] = [];
    _resetRecommendationIdSchemaLatch();
    _setTestClient(makeClient({ writes, failWhileColumnPresent: COLUMN_MISSING }) as any, true);
    await post(url, ONE(PLACE_A));
    const afterFirst = writes.length;

    await post(url, ONE(PLACE_B));
    assert.equal(
      writes.length - afterFirst, 1,
      "the second request must cost ONE statement: re-sending a column the database has " +
      "already refused would pay the failed round-trip on every Living Page view forever",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(writes[afterFirst]!.payload, "recommendation_id"), false,
    );
  });

  it("D6. a client object with no .upsert still writes the column", async () => {
    const writes: Write[] = [];
    _setTestClient(makeClient({ writes, withUpsert: false }) as any, true);
    await post(url, ONE(PLACE_A));

    assert.equal(writes[0]!.op, "insert");
    assert.match(
      writes[0]!.payload.recommendation_id, RECOMMENDATION_ID_SHAPE,
      "not having the upsert METHOD says nothing about the database's schema; dropping the " +
      "join key here would lose it for a reason that is not about the column",
    );
  });
});

describe("DC-19 / DV-40 — the batch form mints a token per item", () => {
  let url: string; let close: () => Promise<void>; let logs: LogLine[];
  before(async () => { logs = []; ({ url, close } = await startServer(await makeApp(logs))); });
  after(async () => { await close(); _setTestClient(null as any, false); });
  beforeEach(() => { _resetRecommendationIdSchemaLatch(); _resetRankEventsRejections(); logs.length = 0; });

  const BATCH = { events: [ONE(PLACE_A), ONE(PLACE_B), ONE(PLACE_A)] };

  it("D7. one token per item, keyed by batch INDEX so a repeat cannot collide", async () => {
    const writes: Write[] = [];
    _setTestClient(makeClient({ writes }) as any, true);

    const r = await post(url, BATCH);
    const body = await r.text();
    assert.equal(r.status, 200, body);
    assert.deepEqual(JSON.parse(body), { ok: true, accepted: 3 });

    const rows = rowsOf(writes);
    assert.equal(rows.length, 3);
    const ids = rows.map((x) => x.recommendation_id);
    assert.ok(ids.every((id) => RECOMMENDATION_ID_SHAPE.test(id)), "every batched row is joinable");
    assert.equal(
      new Set(ids).size, 3,
      "the same place twice in one batch is TWO exposures. Keying on the item alone would " +
      "make 2891's index touch one row twice in a single statement — a 21000 on an " +
      "all-or-nothing batch, which means every row lost",
    );
    assert.equal(
      ids[0],
      recommendationIdFor({
        userId: ALICE_ID, sessionId: "", servedAt: rows[0]!.served_at,
        surface: "living_page", position: 0, itemId: PLACE_A,
      }),
    );
  });

  it("D7b. a 2891-less database does not turn the batch into a permanent 500", async () => {
    const writes: Write[] = [];
    _resetRecommendationIdSchemaLatch();
    _setTestClient(makeClient({ writes, failWhileColumnPresent: SCHEMA_CACHE_MISS }) as any, true);

    const r = await post(url, BATCH);
    assert.equal(
      r.status, 200,
      "the batch is the one shape in this route that ANSWERS a rejection rather than " +
      "swallowing it, so a missing column here would be a hard failure rather than a quiet " +
      "one — the degrade matters MORE on this path, not less",
    );
    assert.deepEqual(await r.json(), { ok: true, accepted: 3 });
    assert.equal(writes.length, 2, "one attempt with the column, one retry without it");
    assert.ok(
      rowsOf([writes[1]!]).every((x) => !Object.prototype.hasOwnProperty.call(x, "recommendation_id")),
      "the retry omits the column",
    );
  });
});
