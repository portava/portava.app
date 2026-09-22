/**
 * §11.1 — the external event reaches real sessions, and an outage does not
 * look like an empty airport.
 *
 * node:test + node:assert (NOT vitest). Fake table-backed DB, no network.
 *
 * ── WHAT THIS FILE IS ABOUT ──────────────────────────────────────────────────
 * `layoverExternalEventConsumer` (another lane) claims a row from
 * `layover_external_events` and stamps `processed_at` on it once the port it
 * was handed reports success. `LayoverEventReplanner.handleEvent` is pure and
 * takes an airport, a set of sessions and their candidates. Nothing stood
 * between them. `LayoverExternalReplanPort` is that piece, and everything that
 * can go wrong in it is a read.
 *
 * THE STAKES ARE HIGHER THAN AN ORDINARY READ. The consumer acts on the report
 * by marking the event handled FOREVER. So a swallowed read here does not just
 * produce a wrong number — it consumes a flight-delay event, tells nobody, and
 * leaves no pending row to retry. Every case below whose name says "refuses"
 * is about that.
 *
 * ── RED FIRST, AND WHAT THE RED ACTUALLY FOUND ───────────────────────────────
 * Run 1, before `LayoverExternalReplanPort.ts` existed: 14 tests, 0 pass,
 * 14 fail (module not found).
 *
 * Run 2, against a first implementation that matched the event's airport ref
 * against `layover_sessions.airport_id` directly: 14 tests, 9 pass, 5 fail.
 * That is the defect worth recording, because it would have shipped as a
 * SILENT ZERO rather than as an error — an `airport` subject is an IATA code
 * and `airport_id` is a PROFILE ROW ID, so no production session would ever
 * have matched and every airport-wide event would have reported
 * `{ ok: true, impacted: 0 }` for the consumer to stamp `processed_at` on:
 *   - "an AIRPORT subject fans out …"                  0 !== 1
 *   - "two airports … certified against their OWN buffers"   0 !== 2
 *   - "a SESSION subject reaches that session directly"  refused, because the
 *     session's own `airport_id` was resolved as if it were an IATA code
 *   - "an unreadable plan-stop table REFUSES" and "an unreadable
 *     airport_profiles REFUSES" both reported ok — the reads they were meant
 *     to exercise were never reached, which is how a fail-closed test can pass
 *     for the wrong reason in the other direction.
 *
 * Run 3, after the ref is RESOLVED to an airport and the sessions read by every
 * identity that airport answers to: 14 tests, 14 pass, 0 fail.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverExternalReplanPort.test.ts
 */
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const MIGRATIONS_2986_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  layoverExternalReplanPort,
  replanExternalEvent,
} from "../services/airport/LayoverExternalReplanPort.js";
import { normalizeEvent } from "../services/airport/LayoverEventReplanner.js";
import type { LayoverEventEnvelope } from "../services/airport/LayoverEventReplanner.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T02:00:00.000Z");

function envelope(over: Record<string, unknown> = {}): LayoverEventEnvelope {
  const r = normalizeEvent(
    {
      eventId: "evt-1",
      eventType: "flight.departure_delayed",
      occurredAt: new Date(NOW - 5 * 60_000).toISOString(),
      source: "test.feed",
      sourceEventId: "src-1",
      subjectRefs: [{ kind: "airport", ref: "TPE" }],
      payload: { delayMinutes: 45 },
      confidence: "HIGH",
      ...over,
    },
    { receivedAtMs: NOW },
  );
  if (!r.ok) assert.fail(`envelope did not normalise: ${r.reason} ${r.detail}`);
  return r.event;
}

function sessionRow(over: Record<string, any> = {}) {
  return {
    id: "session-1",
    user_id: "user-1",
    airport_id: "airport-tpe",
    manual_iata: null,
    arrival_time: new Date(NOW - HOUR).toISOString(),
    departure_time: new Date(NOW + 8 * HOUR).toISOString(),
    boarding_time: null,
    flight_type: "international",
    immigration_required: true,
    checked_bags: false,
    wants_to_leave: true,
    status: "active",
    ...over,
  };
}

const TPE_PROFILE = {
  id: "airport-tpe", iata_code: "TPE", name: "Taoyuan", city: "Taoyuan",
  country: "Taiwan", country_code: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domestic_buffer_min: 60, domestic_buffer_max: 90,
  international_buffer_min: 120, international_buffer_max: 180,
  immigration_extra_min: 30, checked_bags_extra_min: 15, traffic_extra_min: 20,
  verified: false, terminal_info: {},
};
const NRT_PROFILE = { ...TPE_PROFILE, id: "airport-nrt", iata_code: "NRT", city: "Tokyo", timezone: "Asia/Tokyo" };

function tables(over: Record<string, any[]> = {}) {
  return {
    layover_sessions: [sessionRow()],
    airport_profiles: [{ ...TPE_PROFILE }],
    layover_plan_stops: [],
    ...over,
  };
}

const run = (t: Record<string, any[]>, opts: any = {}, ev = envelope()) =>
  replanExternalEvent(makeLayoverDb(t, opts) as any, ev, { nowMs: NOW, ...(opts.portOpts ?? {}) });

describe("§11.1 — the event reaches the sessions it names", () => {
  it("an AIRPORT subject fans out to the active sessions at that airport", async () => {
    const r = await run(tables());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.impacted, 1);
  });

  it("a SESSION subject reaches that session directly", async () => {
    const r = await run(tables(), {}, envelope({ subjectRefs: [{ kind: "session", ref: "session-1" }] }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.impacted, 1);
  });

  it("a CLOSED session is never impacted, however it is named", async () => {
    const r = await run(tables({ layover_sessions: [sessionRow({ status: "cancelled" })] }),
      {}, envelope({ subjectRefs: [{ kind: "session", ref: "session-1" }] }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.impacted, 0);
  });

  it("a session at an airport with no profile row is reached by its manual_iata", async () => {
    // The `.or()` version of this read matched nothing: the fake client models
    // `.or` as a no-op, so the filter that was supposed to widen the match
    // silently removed it. Two explicit reads is why this case can pass.
    const r = await run(tables({
      layover_sessions: [sessionRow({ airport_id: null, manual_iata: "TPE" })],
    }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.impacted, 1);
  });

  it("an event naming nothing anyone is at is a genuine ZERO, not a refusal", async () => {
    const r = await run(tables(), {}, envelope({ subjectRefs: [{ kind: "airport", ref: "SIN" }] }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.impacted, 0);
  });

  it("two airports in one event are certified against their OWN buffers", async () => {
    // `handleEvent` takes ONE airport. Certifying the Tokyo traveller against
    // Taipei's constants would report a deadline change that is an artifact of
    // the wrong airport, which is census L293's class of defect.
    const t = tables({
      layover_sessions: [
        sessionRow(),
        sessionRow({ id: "session-2", airport_id: "airport-nrt" }),
      ],
      airport_profiles: [{ ...TPE_PROFILE }, { ...NRT_PROFILE }],
    });
    const ev = envelope({
      subjectRefs: [{ kind: "airport", ref: "TPE" }, { kind: "airport", ref: "NRT" }],
    });
    const r = await run(t, {}, ev);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.impacted, 2, "both travellers must be replanned, each at their own airport");
  });
});

describe("§11.1 — a failed read is a REFUSAL, never an empty airport", () => {
  it("an unreadable sessions table REFUSES rather than reporting zero impacted", async () => {
    const r = await run(tables(), { failures: { "layover_sessions:select": { message: "boom" } } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /layover_sessions unreadable/);
  });

  it("an unreadable plan-stop table REFUSES — a lost candidate changes the diff", async () => {
    const r = await run(tables(), { failures: { "layover_plan_stops:select": { message: "boom" } } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /layover_plan_stops unreadable/);
  });

  it("an unreadable airport_profiles REFUSES rather than falling back to generic constants", async () => {
    const r = await run(tables(), { failures: { "airport_profiles:select": { message: "boom" } } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /degraded|unreadable/);
  });

  it("an airport nobody has a row or a static record for REFUSES", async () => {
    const r = await run(
      tables({ layover_sessions: [sessionRow({ airport_id: null, manual_iata: "ZZZ" })], airport_profiles: [] }),
      {},
      envelope({ subjectRefs: [{ kind: "airport", ref: "ZZZ" }] }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /no airport known/);
  });

  it("ONE unresolvable airport refuses the WHOLE event — no partial success", async () => {
    const t = tables({
      layover_sessions: [sessionRow(), sessionRow({ id: "session-2", airport_id: null, manual_iata: "ZZZ" })],
    });
    const r = await run(t, {}, envelope({
      subjectRefs: [{ kind: "airport", ref: "TPE" }, { kind: "airport", ref: "ZZZ" }],
    }));
    assert.equal(r.ok, false, "a partial replan reported as success lets the consumer stamp processed_at");
  });
});

describe("the port itself", () => {
  it("satisfies the consumer's one-method shape and forwards its clock", async () => {
    const port = layoverExternalReplanPort(makeLayoverDb(tables()) as any, { nowMs: NOW });
    assert.equal(typeof port.replan, "function");
    const r = await port.replan(envelope());
    assert.equal(r.ok, true);
  });

  it("NEVER writes layover_external_events — the stamp is the consumer's", async () => {
    const t: Record<string, any[]> = { ...tables(), layover_external_events: [] };
    const base = makeLayoverDb(t);
    const touched: string[] = [];
    const spy = { ...base, from(table: string) { touched.push(table); return (base as any).from(table); } };
    await replanExternalEvent(spy as any, envelope(), { nowMs: NOW });
    assert.equal(touched.includes("layover_external_events"), false);
    assert.equal(t.layover_external_events.length, 0);
  });

  it("reads NO clock: the same event at the same nowMs gives the same answer", async () => {
    const a = await run(tables());
    const b = await run(tables());
    assert.deepEqual(a, b);
  });
});

// ── Migration 2986 — the indexes THESE reads depend on ───────────────────────
//
// census-layover L259 asks for active sessions to be indexed by subject. The
// port above issues the only two subject reads that exist, and until 2986
// neither had an index: every pending event was a scan of every session ever
// created.
//
// WHY THIS SUITE IS WRITTEN AGAINST BOTH FILES AT ONCE, rather than asserting
// the migration's text alone. An index migration that agrees only with itself
// is the easy half. The failure that actually happens is DRIFT: someone adds a
// third read, or changes one of these two to filter on a different column, and
// the migration stays green while the new query scans. So case G3 derives the
// filtered columns from the PORT'S OWN SOURCE and requires the migration to
// index exactly that set. A new `.eq("flight_number", …)` on layover_sessions
// turns it red until an index exists for it.
//
// What it deliberately does NOT do: execute anything. There is no database
// here. The behaviour proof — that the planner CHOOSES these indexes, and what
// it does without them — was taken on a throwaway PostgreSQL and is recorded,
// with its numbers, in census-layover.md §42.1.

describe("migration 2986 — the fanout reads' indexes", () => {
  const sql = readFileSync(
    resolve(MIGRATIONS_2986_DIR, "2986_layover_sessions_fanout_indexes.sql"),
    "utf8",
  );
  const portSrc = readFileSync(
    resolve(MIGRATIONS_2986_DIR, "..", "services", "airport", "LayoverExternalReplanPort.ts"),
    "utf8",
  );

  // Comment lines first: the header names `CREATE INDEX IF NOT EXISTS` while
  // explaining idempotency, and a match over the raw file picks that prose up
  // as a third statement. Measured — it did, and the first version of G1 failed
  // 3 !== 2 on it.
  const sqlCode = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const createStmts = sqlCode.match(/CREATE INDEX IF NOT EXISTS[\s\S]*?;/g) ?? [];

  it("G1. creates exactly two PARTIAL indexes, one per read", () => {
    assert.equal(createStmts.length, 2, "two reads, two indexes");
    for (const stmt of createStmts) {
      assert.match(stmt, /WHERE status = 'active'/,
        "a non-partial index would carry every session ever created, not the active slice");
      assert.match(stmt, /IS NOT NULL/,
        "most rows populate one identity column and NULL the other; the NULLs can never be answered for");
    }
    assert.match(createStmts[0]!, /layover_sessions_airport_active_idx[\s\S]*\(airport_id\)/);
    assert.match(createStmts[1]!, /layover_sessions_manual_iata_active_idx[\s\S]*\(manual_iata\)/);
  });

  it("G2. is additive and idempotent — it must not drop, delete or rewrite anything", () => {
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
    const code = sqlCode;
    assert.match(code, /IF NOT EXISTS/, "re-running the file must be a no-op");
    assert.ok(
      !/(ALTER TABLE[^\n;]*DROP|DROP TABLE|DELETE FROM|UPDATE\s+public\.layover_sessions|UPDATE\s+layover_sessions)/i.test(code),
      "an index migration must not drop, delete or rewrite anything",
    );
  });

  it("G3. indexes EXACTLY the columns the port filters layover_sessions on", () => {
    // Every `.from("layover_sessions")` chain in the port, up to the statement
    // that ends it, and the `.eq`/`.in` column names inside it.
    const chains = portSrc.match(/\.from\("layover_sessions"\)[\s\S]*?;/g) ?? [];
    assert.ok(chains.length >= 2, "the port must still read layover_sessions");

    const filtered = new Set<string>();
    for (const chain of chains) {
      for (const m of chain.matchAll(/\.(?:eq|in)\("([a-z_]+)"/g)) filtered.add(m[1]!);
    }
    // `status` is in every predicate and is the partial WHERE, not a key. `id`
    // is the primary key, already indexed by 0127.
    filtered.delete("status");
    filtered.delete("id");

    const indexed = new Set<string>();
    for (const stmt of createStmts) {
      const key = /ON public\.layover_sessions \(([a-z_]+)\)/.exec(stmt);
      assert.ok(key, `could not read the key column of: ${stmt}`);
      indexed.add(key![1]!);
    }

    assert.deepEqual(
      [...filtered].sort(),
      [...indexed].sort(),
      "the port filters on a column 2986 does not index (or indexes one nothing filters on) — " +
        "a subject read with no index scans the whole table once per pending event",
    );
  });

  it("G4. REFUSES to apply where 'active' is not a legal status — an index over an impossible predicate indexes nothing", () => {
    assert.match(sql, /PRECONDITION FAILED[\s\S]*does not admit ''active''/);
    assert.match(sql, /PRECONDITION FAILED[\s\S]*airport_id, manual_iata and status/);
  });

  it("G5. postconditions name the three indexes 0127 created, so this file cannot be why one went missing", () => {
    for (const name of ["layover_sessions_user_status_idx",
                        "layover_sessions_departure_idx",
                        "layover_sessions_share_idx"]) {
      assert.ok(sql.includes(name), `postconditions must assert ${name} survives`);
    }
  });
});
