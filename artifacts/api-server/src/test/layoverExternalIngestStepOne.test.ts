/**
 * census-layover L92 / L257 — layover round 2, lane B.
 *
 *   L92   §11.1 step 1: "Normalize and deduplicate the external/internal event."
 *   L257  §23: "Validate all external event payloads and deduplicate by stable
 *         source keys."
 *
 * Pass 10 took both rows C → W: `normalizeEvent` runs on the traveller's PATCH,
 * but `dedupeEvents` had NO caller outside tests and the external payload path
 * (POST /api/layover/events → store → drain → LayoverExternalReplanPort →
 * handleEvent) is behind `layover_event_ingest_enabled`, which 2981 seeds and
 * which is unapplied. This suite drives that whole path through the REAL router
 * and the REAL scheduler entry point (`runLayoverExternalEventDrain`, which
 * builds the real port), over the table-backed double:
 *
 *   1. PRODUCTION TODAY — the flag absent (2981 unapplied), off, unreadable, or
 *      the producer secret unset: each is a NAMED refusal, nothing is written,
 *      and the drain reads nothing past the flag.
 *   2. THE SPEC'S WORDS, flag ON in the double:
 *        - an invalid payload is refused with its reason (by name and detail);
 *        - a duplicate external payload replans once;
 *        - two sources with the same stable key are one event.
 *
 * TWO DEDUP LAYERS, TESTED APART. Production's cross-delivery guarantee is 2860's
 * UNIQUE index on `dedup_key` (and the primary key on `event_id`). fakeLayoverDb
 * models no unique index (its header says so), so the cases marked [index]
 * install a three-line model of exactly those two constraints; the cases marked
 * [no index] leave it out — the store holds two copies of one fact — and prove
 * the port's own step-1 dedup (`dedupeEvents`) still lets only one reach a
 * session.
 *
 * Run (LOOPBACK — the sandbox must allow listen):
 *   node --import tsx/esm --test src/test/layoverExternalIngestStepOne.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import layoverEventsRouter, { PRODUCER_SECRET_HEADER } from "../routes/layoverEvents.js";
import { runLayoverExternalEventDrain } from "../lib/layoverExternalEventScheduler.js";
import { drainPendingExternalEvents } from "../services/layover/layoverExternalEventConsumer.js";
import { layoverExternalReplanPort } from "../services/airport/LayoverExternalReplanPort.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const NOW = Date.parse("2026-10-18T06:00:00.000Z");
const MIN = 60_000;
const SECRET = "lane-b-producer-secret";
const INGEST = "layover_event_ingest_enabled";

let server: http.Server;
let base: string;
const realNow = Date.now;

function post(body: unknown, opts: { secret?: string | null } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/layover/events", base);
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() };
    const secret = opts.secret === undefined ? SECRET : opts.secret;
    if (secret !== null) headers[PRODUCER_SECRET_HEADER] = secret;
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST", headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
    });
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

/**
 * The world: one active traveller at TPE whose window contains NOW, and the
 * ingest flag in the state named. Every table the path can touch is recorded.
 */
function stage(ingest: "absent" | "off" | "on" | "unreadable", opts: { uniqueIndex?: boolean } = {}) {
  const flags: Array<Record<string, unknown>> = [];
  if (ingest === "on") flags.push({ flag: INGEST, enabled: true });
  if (ingest === "off") flags.push({ flag: INGEST, enabled: false });
  const tables: Record<string, any[]> = {
    feature_flags: flags,
    airport_profiles: [{ ...airportRow(), terminal_info: {} }],
    layover_sessions: [sessionRow({ arrival_time: new Date(NOW - 60 * MIN).toISOString(), departure_time: new Date(NOW + 8 * 60 * MIN).toISOString() }, { nowMs: NOW })],
    layover_plan_stops: [],
    layover_external_events: [],
  };
  const fake = makeLayoverDb(tables, { failures: ingest === "unreadable" ? { "feature_flags:select": { message: "relation unavailable" } } : {} });
  const touched: string[] = [];
  const client = {
    ...fake,
    from(table: string) {
      touched.push(table);
      const b = fake.from(table);
      if (opts.uniqueIndex && table === "layover_external_events") {
        // 2860's two uniqueness constraints, and nothing else. A 23505 RESOLVES
        // (supabase-js does not throw), naming the constraint the way PostgREST does.
        const insert = b.insert;
        b.insert = (row: Record<string, unknown>) => {
          const clash = tables.layover_external_events.some((r) => r.event_id === row.event_id)
            ? "layover_external_events_pkey"
            : tables.layover_external_events.some((r) => r.dedup_key === row.dedup_key) ? "layover_external_events_dedup_uidx" : null;
          if (clash === null) return insert.call(b, row);
          const error = { code: "23505", message: `duplicate key value violates unique constraint "${clash}"` };
          return { then: (f: any, r: any) => Promise.resolve({ data: null, error }).then(f, r) };
        };
      }
      return b;
    },
  };
  _setTestClient(client, true);
  return { tables, client, touched };
}

/** A departure delay for the staged session, from one producer. */
function delay(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "acme-delivery-1",
    eventType: "flight.departure_delayed",
    occurredAt: new Date(NOW - 5 * MIN).toISOString(),
    source: "acme-flight-feed",
    sourceEventId: "acme-777",
    subjectRefs: [{ kind: "session", ref: "session-1" }],
    payload: { delayMinutes: 45 },
    confidence: "HIGH",
    ...over,
  };
}

/** Writes anywhere but the flag table: the inert path must have none. */
const WRITTEN = ["layover_external_events", "layover_events", "layover_certified_computations", "layover_time_budgets", "layover_return_plans", "layover_recommendations"];

before(() => {
  Date.now = () => NOW;
  process.env.LAYOVER_EVENT_PRODUCER_SECRET = SECRET;
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", layoverEventsRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => {
  Date.now = realNow;
  delete process.env.LAYOVER_EVENT_PRODUCER_SECRET;
  return new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => { process.env.LAYOVER_EVENT_PRODUCER_SECRET = SECRET; });

// ── 1. production today: closed, named, and nothing written ──────────────────

describe("PRODUCTION TODAY — the external path is closed, every refusal is named, nothing is written", () => {
  for (const state of ["absent", "off", "unreadable"] as const) {
    it(`ingest flag ${state.toUpperCase()}${state === "absent" ? " (2981 unapplied)" : ""}: POST answers 503 'ingest_closed', and nothing past the flag is read or written`, async () => {
      const { tables, touched, client } = stage(state);
      const r = await post(delay());
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.reason, "ingest_closed", "a closed door says which door it is");
      assert.deepEqual([...new Set(touched)], ["feature_flags"], `the closed route touched: ${touched.join(", ")}`);
      for (const t of WRITTEN) assert.equal((tables[t] ?? []).length, 0, `${t} was written`);

      // …and the scheduler's pass over the same database does not read the event table either.
      touched.length = 0;
      const drain = await runLayoverExternalEventDrain({ client, nowMs: NOW });
      assert.equal(drain.reason, "gate_closed");
      assert.equal(drain.skipped, true);
      assert.deepEqual([...new Set(touched)], ["feature_flags"], `the closed drain touched: ${touched.join(", ")}`);
    });
  }

  it("producer secret UNSET: 503 'producer_secret_unset' before ANY table is touched — not even the flag", async () => {
    const { touched, tables } = stage("on");
    delete process.env.LAYOVER_EVENT_PRODUCER_SECRET;
    const r = await post(delay());
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "producer_secret_unset");
    assert.deepEqual(touched, []);
    assert.equal(tables.layover_external_events.length, 0);
  });

  it("a WRONG secret: 401 'producer_credential_refused', and the flag's state is not readable off the answer", async () => {
    const { touched } = stage("off");
    const r = await post(delay(), { secret: "not-it" });
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, "producer_credential_refused");
    assert.deepEqual(touched, [], "the secret is checked before the flag");
  });
});

// ── 2a. an invalid payload is refused with its reason ────────────────────────

describe("flag ON in the double — §23 'validate ALL external event payloads': an invalid payload is refused WITH ITS REASON", () => {
  it("a delay with no number is `bad_payload`, the validator's own words travel back, and nothing is stored or replanned", async () => {
    const { tables, client } = stage("on");
    const r = await post(delay({ payload: { delayMinutes: "soon" } }));
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(r.body.reason, "bad_payload", "the producer is told WHICH check refused it");
    assert.match(r.body.message, /delayMinutes must be a finite number/, "…and what was wrong with it");
    assert.equal(tables.layover_external_events.length, 0);

    const drain = await runLayoverExternalEventDrain({ client, nowMs: NOW });
    assert.equal(drain.drained, 0, "a refused event never reaches a session");
    assert.equal((tables.layover_events ?? []).length, 0);
  });

  it("a twelfth event type is `unknown_event_type`, naming the type it was sent", async () => {
    const { tables } = stage("on");
    const r = await post(delay({ eventType: "flight.teleported" }));
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, "unknown_event_type");
    assert.match(r.body.message, /flight\.teleported/);
    assert.equal(tables.layover_external_events.length, 0);
  });

  it("a future-dated event is `occurred_in_future` — judged against the instant the request arrived", async () => {
    stage("on");
    const r = await post(delay({ occurredAt: new Date(NOW + 10 * MIN).toISOString() }));
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, "occurred_in_future");
  });
});

// ── 2b. a duplicate external payload replans once ────────────────────────────

/** Drain with the SAME two calls the scheduler makes, so each event's own report is visible. */
async function drainReport(client: any) {
  return drainPendingExternalEvents(client, layoverExternalReplanPort(client, { nowMs: NOW }), { limit: 50, nowMs: NOW });
}

describe("flag ON in the double — §24 'a duplicate external payload replans once'", () => {
  it("[index] the SAME delivery posted twice: the second is a success that writes nothing, and one replan runs", async () => {
    const { tables, client } = stage("on", { uniqueIndex: true });
    const a = await post(delay());
    const b = await post(delay());
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.duplicate, false);
    assert.equal(b.status, 200, "a duplicate is a success, so the producer stops retrying");
    assert.equal(b.body.duplicate, true);
    assert.equal(b.body.duplicateKind, "same_delivery");
    assert.equal(tables.layover_external_events.length, 1);

    const report = await drainReport(client);
    assert.deepEqual(report.drained.map((d) => [d.eventId, d.impacted]), [["acme-delivery-1", 1]]);
  });

  it("[no index] the same fact re-delivered under a FRESH eventId — two rows in the store — reaches the session ONCE", async () => {
    const { tables, client, touched } = stage("on");
    assert.equal((await post(delay())).status, 200);
    assert.equal((await post(delay({ eventId: "acme-delivery-2" }))).status, 200);
    assert.equal(tables.layover_external_events.length, 2, "fixture: with no index both copies are stored");
    assert.equal(tables.layover_external_events[0].dedup_key, tables.layover_external_events[1].dedup_key);

    // The production entry point: one port per pass, so the pass's dedup memory spans both events.
    touched.length = 0;
    const drain = await runLayoverExternalEventDrain({ client, nowMs: NOW });
    assert.equal(drain.reason, null);
    assert.equal(drain.drained, 2, "both rows are claimed and accounted for");
    assert.equal(drain.failedAfterClaim, 0, "a duplicate is not a failure");
    assert.equal(touched.filter((t) => t === "layover_sessions").length, 1, "the duplicate never read a session");
  });

  it("[no index] …and per event: the first replans, the copy reports `impacted: 0` — first occurrence wins", async () => {
    const { client } = stage("on");
    await post(delay());
    await post(delay({ eventId: "acme-delivery-2" }));
    const report = await drainReport(client);
    assert.deepEqual(report.drained.map((d) => [d.eventId, d.impacted]), [["acme-delivery-1", 1], ["acme-delivery-2", 0]]);
    assert.equal(report.failedAfterClaim.length, 0);
  });

  it("CONTROL: two DIFFERENT facts from the same producer are two events, and both replan", async () => {
    const { client } = stage("on");
    await post(delay());
    await post(delay({ eventId: "acme-delivery-2", sourceEventId: "acme-778", payload: { delayMinutes: 90 } }));
    const report = await drainReport(client);
    assert.deepEqual(report.drained.map((d) => d.impacted), [1, 1]);
  });
});

// ── 2c. two sources with the same stable key are one event ───────────────────

/**
 * Two producers, neither of which sends a `sourceEventId`, describing the same
 * fact: the same delay, of the same session, at the same INSTANT — which one of
 * them spells `…Z` and the other `+00:00`. The stable key is the content digest,
 * which leaves the producer's name out on purpose; it must leave the spelling of
 * the instant out too, or "the same fact described the same way" depends on a
 * formatting choice nobody agreed on.
 */
function sameFactFrom(source: string, eventId: string, occurredAt: string) {
  return delay({ eventId, source, sourceEventId: undefined, occurredAt });
}
const INSTANT = new Date(NOW - 5 * MIN);
const SPELLED_Z = INSTANT.toISOString().replace(".000Z", "Z");
const SPELLED_OFFSET = INSTANT.toISOString().replace(".000Z", "+00:00");

describe("flag ON in the double — 'two sources with the same stable key are ONE event'", () => {
  it("[index] two producers, one fact, two spellings of its instant: ONE stable key, the second is `same_fact`, one replan", async () => {
    const { tables, client } = stage("on", { uniqueIndex: true });
    const a = await post(sameFactFrom("airport-ops-feed", "ops-1", SPELLED_Z));
    const b = await post(sameFactFrom("airline-webhook", "wh-1", SPELLED_OFFSET));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(a.body.dedupKey, b.body.dedupKey, "one fact, one stable key");
    assert.equal(b.body.duplicate, true);
    assert.equal(b.body.duplicateKind, "same_fact");
    assert.equal(tables.layover_external_events.length, 1);
    const report = await drainReport(client);
    assert.deepEqual(report.drained.map((d) => [d.eventId, d.impacted]), [["ops-1", 1]]);
  });

  it("[no index] the same two producers, both stored: the port lets ONE through", async () => {
    const { tables, client } = stage("on");
    await post(sameFactFrom("airport-ops-feed", "ops-1", SPELLED_Z));
    await post(sameFactFrom("airline-webhook", "wh-1", SPELLED_OFFSET));
    assert.equal(tables.layover_external_events.length, 2);
    const report = await drainReport(client);
    assert.deepEqual(report.drained.map((d) => [d.eventId, d.impacted]), [["ops-1", 1], ["wh-1", 0]]);
  });

  it("[index] one producer's `source:sourceEventId` through two transports (two delivery ids) is one event", async () => {
    const { tables, client } = stage("on", { uniqueIndex: true });
    const a = await post(delay({ eventId: "via-webhook" }));
    const b = await post(delay({ eventId: "via-poll" }));
    assert.equal(a.body.dedupKey, "acme-flight-feed:acme-777");
    assert.equal(b.body.duplicateKind, "same_fact");
    assert.equal(tables.layover_external_events.length, 1);
    const report = await drainReport(client);
    assert.deepEqual(report.drained.map((d) => d.impacted), [1]);
  });
});
