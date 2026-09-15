/**
 * census-discovery DC-19 — `POST /api/rank-events` accepts a BATCH.
 *
 * WHAT WAS MISSING
 * ----------------
 * The route parsed exactly one `{ event_type, entity_type, entity_id }` object.
 * A client with twenty Living-Page views had to make twenty round trips, and
 * the spec asks for a batch form.
 *
 * THE TWO THINGS THIS FILE PINS
 * -----------------------------
 * 1. ADDITIVE. The single-event shape keeps working BYTE-IDENTICALLY — same
 *    request, same `{ ok: true }` body, same single-object insert, same
 *    fire-and-forget treatment of a rejected insert. Suite S.
 *
 * 2. THE PARTIAL-FAILURE SEMANTICS ARE **ALL-OR-NOTHING**, and that is a
 *    decision, not a default. The alternative — per-item results — was rejected
 *    for this endpoint: these are impression events whose only consumer is the
 *    exposure denominator, and a batch that half-lands gives that denominator a
 *    number no client can correct, because no client retries a 200. So:
 *      • every item is validated BEFORE anything is written; one bad item means
 *        NOTHING is written and the response is 400 naming the index;
 *      • the accepted items go out as ONE multi-row insert, which PostgREST
 *        executes as ONE statement — the database, not this route, is what
 *        makes it atomic;
 *      • a rejected insert is reported as a FAILURE (500), never as `ok: true`.
 *        This is where the batch deliberately DIVERGES from the single form: the
 *        single form's fire-and-forget 200 is preserved for compatibility, but a
 *        new shape does not get to inherit a defect. Suites B and F.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/rankEventsBatch.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";

interface Insert { table: string; payload: any }
interface LogLine { ctx: any; msg: string }

function makeClient(o: { inserts: Insert[]; insertError?: { code?: string; message: string } }) {
  const db: Record<string, any[]> = {
    profiles: [{ id: ALICE_ID, account_status: "active" }],
  };
  function selectBuilder(table: string) {
    let filtered = [...(db[table] ?? [])];
    const b: any = {
      eq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] === v); return b; },
      in: (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[c])); return b; },
      order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: [...filtered], error: null }),
    };
    return b;
  }
  return {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => ({
      select: () => selectBuilder(table),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      insert: (payload: any) => {
        o.inserts.push({ table, payload });
        return Promise.resolve({ data: null, error: o.insertError ?? null });
      },
      upsert: (payload: any) => {
        o.inserts.push({ table, payload });
        return Promise.resolve({ data: null, error: o.insertError ?? null });
      },
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

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

function post(url: string, body: unknown) {
  return fetch(`${url}/api/rank-events`, {
    method:  "POST",
    headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

const ONE = { event_type: "place_view", entity_type: "place", entity_id: "db/place-1" };
const TWO = { event_type: "place_view", entity_type: "place", entity_id: "db/place-2" };

// ── Suite S — the single-event form is untouched ──────────────────────────────

describe("DC-19 — the single-event form of POST /rank-events is unchanged", async () => {
  let url: string; let close: () => Promise<void>; let logs: LogLine[];
  before(async () => { logs = []; ({ url, close } = await startServer(await makeApp(logs))); });
  after(async () => { await close(); _setTestClient(null as any, false); });

  it("S1. one event → 200 { ok: true } and ONE single-object insert", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await post(url, ONE);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true }, "the legacy body carries no extra keys");

    assert.equal(inserts.length, 1, "exactly one insert");
    assert.ok(!Array.isArray(inserts[0]!.payload), "the single form inserts an OBJECT, not an array");
    assert.equal(inserts[0]!.payload.item_id, "db/place-1");
    assert.equal(inserts[0]!.payload.surface, "living_page");
    assert.equal(inserts[0]!.payload.outcome, "impression");
    assert.equal(inserts[0]!.payload.user_id, ALICE_ID);
  });

  it("S2. a rejected insert is STILL non-fatal for the single form — 200 { ok: true } + a warn", async () => {
    const inserts: Insert[] = [];
    logs.length = 0;
    _setTestClient(makeClient({ inserts, insertError: { message: "check constraint violated" } }) as any, true);

    const r = await post(url, ONE);
    assert.equal(r.status, 200, "unchanged: a missed Living-Page signal beats a broken page load");
    assert.deepEqual(await r.json(), { ok: true });
    assert.ok(logs.some((l) => /direct insert failed/i.test(l.msg)), "the rejection is still warned");
  });

  it("S3. an invalid single event still 400s", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await post(url, { event_type: "not_a_thing", entity_type: "place", entity_id: "x" });
    assert.equal(r.status, 400);
    assert.equal((await r.json() as any).error, "invalid_payload");
    assert.equal(inserts.length, 0);
  });
});

// ── Suite B — the batch form ──────────────────────────────────────────────────

describe("DC-19 — POST /rank-events accepts a batch", async () => {
  let url: string; let close: () => Promise<void>; let logs: LogLine[];
  before(async () => { logs = []; ({ url, close } = await startServer(await makeApp(logs))); });
  after(async () => { await close(); _setTestClient(null as any, false); });

  it("B1. { events: [a, b] } → 200 { ok: true, accepted: 2 } in ONE multi-row insert", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await post(url, { events: [ONE, TWO] });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { ok: true, accepted: 2 });

    assert.equal(
      inserts.length, 1,
      "one round trip: PostgREST executes a multi-row insert as ONE statement, which is what " +
      "makes all-or-nothing true at the database rather than merely intended here",
    );
    assert.ok(Array.isArray(inserts[0]!.payload), "the batch form inserts an ARRAY");
    assert.equal(inserts[0]!.payload.length, 2);
    assert.deepEqual(
      inserts[0]!.payload.map((row: any) => row.item_id),
      ["db/place-1", "db/place-2"],
      "rows are written in the order the client sent them",
    );
    for (const row of inserts[0]!.payload) {
      assert.equal(row.user_id, ALICE_ID);
      assert.equal(row.surface, "living_page");
      assert.equal(row.outcome, "impression");
      assert.equal(row.event_type, "place_view");
    }
  });

  it("B2. ONE invalid item rejects the WHOLE batch — 400 and NOTHING is written", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await post(url, { events: [ONE, { ...TWO, event_type: "not_a_thing" }] });
    assert.equal(r.status, 400, "all-or-nothing: a batch is validated before it is written");
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
    assert.match(
      String(body.message), /1/,
      "the message must locate the offending item, or a client cannot fix its batch",
    );
    assert.equal(
      inserts.length, 0,
      "the valid item must NOT be written: a half-applied batch reported as an error leaves the " +
      "exposure denominator holding rows nobody believes were written",
    );
  });

  it("B3. a REJECTED batch insert is reported as a failure, never as ok:true", async () => {
    const inserts: Insert[] = [];
    logs.length = 0;
    _setTestClient(makeClient({ inserts, insertError: { message: "check constraint violated" } }) as any, true);

    const r = await post(url, { events: [ONE, TWO] });
    assert.equal(
      r.status, 500,
      "the single form's fire-and-forget 200 is kept for compatibility; a NEW shape does not " +
      "inherit it. A batch that reports success having written nothing is exactly the " +
      "masquerade 11 §9 forbids",
    );
    const body = await r.json() as any;
    assert.equal(body.error, "db_error");
    assert.notEqual(body.ok, true);
  });

  it("B4. an empty batch is a client error, not a silent success", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await post(url, { events: [] });
    assert.equal(r.status, 400);
    assert.equal((await r.json() as any).error, "invalid_payload");
    assert.equal(inserts.length, 0);
  });

  it("B5. an oversized batch is refused rather than written", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const events = Array.from({ length: 201 }, (_, i) => ({ ...ONE, entity_id: `db/place-${i}` }));
    const r = await post(url, { events });
    assert.equal(r.status, 400, "an unbounded batch is an unbounded statement");
    assert.equal((await r.json() as any).error, "invalid_payload");
    assert.equal(inserts.length, 0);
  });

  it("B6. a batch of one is still a batch — { ok: true, accepted: 1 }, array insert", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await post(url, { events: [ONE] });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { ok: true, accepted: 1 });
    assert.ok(Array.isArray(inserts[0]!.payload));
    assert.equal(inserts[0]!.payload.length, 1);
  });

  it("B7. `events` that is not an array is a 400, not a fall-through to the single form", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await post(url, { events: "place_view" });
    assert.equal(r.status, 400);
    assert.equal((await r.json() as any).error, "invalid_payload");
    assert.equal(inserts.length, 0);
  });

  it("B8. auth is still required for the batch form", async () => {
    const inserts: Insert[] = [];
    _setTestClient(makeClient({ inserts }) as any, true);

    const r = await fetch(`${url}/api/rank-events`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ events: [ONE] }),
    });
    assert.equal(r.status, 401);
    assert.equal(inserts.length, 0);
  });
});
