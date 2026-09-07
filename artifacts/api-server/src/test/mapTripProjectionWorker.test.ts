/**
 * Trip Map projection worker (Trips spec §19.4) — lib/mapTripProjectionWorker.ts
 * + migration 2520.
 *
 * Pins, in this order:
 *   1. The input contract: every column 2520 reads from trip_outbox /
 *      trip_events is a 2420 column, and every 'trip.%' literal in 2420+2450
 *      is in TRIP_EVENT_TYPES (consumed as published, never extended here).
 *   2. Gated off is byte-identical: a pass makes exactly one feature_flags
 *      read and issues no RPC and no write.
 *   3. Gated on: one RPC with p_enforce_flag:true; the SQL's counters map to
 *      the result; a function-side skip is reported as disabled, not as work.
 *   4. Failure is swallowed into reason=error, never thrown (and the `.error`
 *      of a RESOLVED supabase call is checked, not read as empty).
 *   5. The scheduler arms once and stops.
 *
 * The idempotency / ordering / atomic-publish behaviour lives in SQL and is
 * proved by the CI rehearsal (transaction ending in RAISE EXCEPTION), not
 * here; here the SQL text is pinned so the rehearsed file is the shipped one.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runTripMapProjectionPass,
  startTripMapProjectionScheduler,
  stopTripMapProjectionScheduler,
  _tripMapProjectionSchedulerArmed,
  CONSUMED_TRIP_EVENT_TYPES,
  TRIP_MAP_PROJECTION_FLAG,
  TRIP_MAP_PROJECTION_DRAIN_RPC,
  TRIP_MAP_PROJECTION_BATCH_LIMIT,
} from "../lib/mapTripProjectionWorker.js";
import { TRIP_EVENT_TYPES } from "../lib/tripKernel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../migrations");
const read = (f: string) => readFileSync(path.join(migrationsDir, f), "utf8");

function makeDb(cfg: {
  enabled: boolean | "error" | "throw";
  rpcData?: unknown;
  rpcError?: { message: string } | null;
  rpcThrows?: boolean;
}) {
  const calls: Array<{ kind: "from" | "rpc"; name: string; args?: unknown }> = [];
  const db: any = {
    from(table: string) {
      calls.push({ kind: "from", name: table });
      const b: any = {
        select() { return b; },
        eq() { return b; },
        maybeSingle() {
          if (cfg.enabled === "throw") return Promise.reject(new Error("flags unreachable"));
          if (cfg.enabled === "error") return Promise.resolve({ data: null, error: { message: "relation missing" } });
          return Promise.resolve({ data: { enabled: cfg.enabled }, error: null });
        },
        // Any write would be a contract violation in this module.
        insert() { throw new Error("worker must not write through the client"); },
        update() { throw new Error("worker must not write through the client"); },
        upsert() { throw new Error("worker must not write through the client"); },
        delete() { throw new Error("worker must not write through the client"); },
      };
      return b;
    },
    rpc(name: string, args: unknown) {
      calls.push({ kind: "rpc", name, args });
      if (cfg.rpcThrows) return Promise.reject(new Error("socket hang up"));
      return Promise.resolve({ data: cfg.rpcData ?? null, error: cfg.rpcError ?? null });
    },
    _calls: calls,
  };
  return db;
}

describe("trip map projection worker — input contract (consumed, not authored)", () => {
  const sql2420 = read("2420_trip_kernel_foundation.sql");
  const sql2450 = read("2450_trip_kernel_trip_and_participant_families.sql");
  const sql2520 = read("2520_trip_map_projection_worker.sql");

  function tableColumns(sql: string, table: string): Set<string> {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(m, `CREATE TABLE ${table} not found`);
    const cols = new Set<string>();
    for (const line of m![1].split("\n")) {
      const c = line.match(/^\s+([a-z_]+)\s+(uuid|bigint|text|timestamptz|integer|jsonb)\b/);
      if (c) cols.add(c[1]);
    }
    return cols;
  }

  it("every trip_outbox / trip_events column 2520 reads exists in 2420 (2450 is optional)", () => {
    const outboxCols = tableColumns(sql2420, "trip_outbox");
    const eventCols = tableColumns(sql2420, "trip_events");
    assert.ok(outboxCols.has("published_at") && outboxCols.has("attempts"));
    const usedO = new Set([...sql2520.matchAll(/\bo\.([a-z_]+)/g)].map((m) => m[1]));
    const usedE = new Set([...sql2520.matchAll(/\be\.([a-z_]+)/g)].map((m) => m[1]));
    assert.ok(usedO.size > 0 && usedE.size > 0, "2520 must actually read the outbox and the events");
    for (const c of usedO) assert.ok(outboxCols.has(c), `2520 reads trip_outbox.${c}, not a 2420 column`);
    for (const c of usedE) assert.ok(eventCols.has(c), `2520 reads trip_events.${c}, not a 2420 column`);
    // The header comment NAMES actor_role to say it is not read; the code must not read it.
    const code2520 = sql2520.replace(/--[^\n]*/g, "");
    assert.ok(!/actor_role|->>'family'|->'family'/.test(code2520), "2520 must not depend on a 2450-only field");
  });

  it("every 'trip.%' literal the kernel SQL emits is in TRIP_EVENT_TYPES, and the worker consumes exactly that list", () => {
    const sqlVocab = new Set(
      [...(sql2420 + sql2450).matchAll(/'(trip\.[a-z_]+)'/g)].map((m) => m[1]),
    );
    assert.ok(sqlVocab.size >= 22, `expected the published vocabulary, found ${sqlVocab.size}`);
    const published = new Set<string>(TRIP_EVENT_TYPES);
    for (const t of sqlVocab) assert.ok(published.has(t), `SQL emits ${t} but TRIP_EVENT_TYPES does not publish it`);
    assert.strictEqual(CONSUMED_TRIP_EVENT_TYPES, TRIP_EVENT_TYPES, "the worker must consume the published list by identity");
    // The worker never narrows or extends the vocabulary in SQL either.
    assert.ok(!/'trip\.[a-z_]+'/.test(sql2520), "2520 must not name event types");
  });

  it("2520 seeds the flag FALSE, publishes atomically, orders by aggregate_version and is service-role only", () => {
    assert.match(sql2520, /\('trip_map_projection_worker_enabled', false,/);
    assert.match(sql2520, /ORDER BY o\.trip_id, e\.aggregate_version, o\.id/);
    assert.match(sql2520, /FOR UPDATE OF o SKIP LOCKED/);
    // published_at is written only inside the drain's sub-block / the rebuild,
    // never as a bare statement before the projection write.
    const publishes = [...sql2520.matchAll(/SET published_at = now\(\)/g)].length;
    assert.equal(publishes, 3, "one replay mark, one apply mark, one rebuild mark");
    assert.match(sql2520, /WHERE public\.trip_map_projections\.source_trip_version = EXCLUDED\.source_trip_version - 1/);
    assert.match(sql2520, /UNIQUE \(trip_id, aggregate_version\)/);
    assert.match(sql2520, /EXCEPTION WHEN OTHERS THEN/);
    assert.match(sql2520, /REVOKE ALL ON public\.trip_map_projections\s+FROM PUBLIC, anon, authenticated/);
    assert.match(sql2520, /REVOKE ALL ON public\.trip_map_projection_applied FROM PUBLIC, anon, authenticated/);
    assert.match(sql2520, /GRANT EXECUTE ON FUNCTION public\.trip_map_projection_drain\(integer, boolean\) TO service_role/);
    // No coordinates in the body (§14.4, §5.3).
    const body = sql2520.match(/FUNCTION public\.trip_map_projection_body[\s\S]*?\$fn\$;/)![0];
    assert.ok(!/'destination_lat'|'destination_lng'|'lat'|'lng'/.test(body), "body must be coordinate-free");
    assert.match(body, /'has_destination_coordinates'/);
    // Never touches canonical Trip tables or trip_events with a write.
    assert.ok(!/UPDATE public\.trips\b|INSERT INTO public\.trips\b|UPDATE public\.trip_events|INSERT INTO public\.trip_events|UPDATE public\.trip_plan_items|UPDATE public\.trip_members/.test(sql2520));
    assert.equal(TRIP_MAP_PROJECTION_FLAG, "trip_map_projection_worker_enabled");
    assert.equal(TRIP_MAP_PROJECTION_DRAIN_RPC, "trip_map_projection_drain");
  });
});

describe("trip map projection worker — pass", () => {
  it("no client → no_client, nothing called", async () => {
    const r = await runTripMapProjectionPass({ client: null });
    assert.equal(r.reason, "no_client");
    assert.equal(r.skipped, true);
    assert.equal(r.applied, 0);
  });

  it("flag FALSE → exactly one feature_flags read, zero RPCs, zero writes (gated-off is inert)", async () => {
    const db = makeDb({ enabled: false });
    const r = await runTripMapProjectionPass({ client: db });
    assert.equal(r.reason, "disabled");
    assert.equal(r.skipped, true);
    assert.deepEqual(db._calls, [{ kind: "from", name: "feature_flags" }]);
  });

  it("flag unreadable (error) or thrown → fail-closed: disabled, no RPC", async () => {
    for (const enabled of ["error", "throw"] as const) {
      const db = makeDb({ enabled });
      const r = await runTripMapProjectionPass({ client: db });
      assert.equal(r.reason, "disabled", enabled);
      assert.deepEqual(db._calls.filter((c: { kind: string }) => c.kind === "rpc"), [], enabled);
    }
  });

  it("flag TRUE → one drain RPC with p_enforce_flag:true and the default batch limit; counters map through", async () => {
    const db = makeDb({
      enabled: true,
      rpcData: { ok: true, skipped: false, scanned: 5, applied: 3, replayed: 1, deferred_gap: 1, refused: 0, failed: 0, last_error: "gap: x" },
    });
    const r = await runTripMapProjectionPass({ client: db });
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
    assert.deepEqual(
      db._calls,
      [
        { kind: "from", name: "feature_flags" },
        { kind: "rpc", name: TRIP_MAP_PROJECTION_DRAIN_RPC, args: { p_limit: TRIP_MAP_PROJECTION_BATCH_LIMIT, p_enforce_flag: true } },
      ],
    );
    assert.equal(r.scanned, 5);
    assert.equal(r.applied, 3);
    assert.equal(r.replayed, 1);
    assert.equal(r.deferredGap, 1);
    assert.equal(r.refused, 0);
    assert.equal(r.failed, 0);
    assert.equal(r.lastError, "gap: x");
  });

  it("limit is clamped to [1, 1000] and never bypasses the function-side flag", async () => {
    const big = makeDb({ enabled: true, rpcData: { skipped: false } });
    await runTripMapProjectionPass({ client: big, limit: 99999 });
    assert.deepEqual((big._calls[1] as any).args, { p_limit: 1000, p_enforce_flag: true });
    const small = makeDb({ enabled: true, rpcData: { skipped: false } });
    await runTripMapProjectionPass({ client: small, limit: 0 });
    assert.deepEqual((small._calls[1] as any).args, { p_limit: 1, p_enforce_flag: true });
  });

  it("function-side skip (flag flipped between reads) is reported as disabled, not as work", async () => {
    const db = makeDb({ enabled: true, rpcData: { ok: true, skipped: true, reason: "disabled", applied: 0 } });
    const r = await runTripMapProjectionPass({ client: db });
    assert.equal(r.reason, "disabled");
    assert.equal(r.skipped, true);
    assert.equal(r.applied, 0);
  });

  it("RPC resolves with .error → reason=error (supabase-js resolves on a DB error; an unchecked .error would read as an empty pass)", async () => {
    const db = makeDb({ enabled: true, rpcData: null, rpcError: { message: "function trip_map_projection_drain does not exist" } });
    const r = await runTripMapProjectionPass({ client: db });
    assert.equal(r.reason, "error");
    assert.equal(r.skipped, true);
    assert.equal(r.applied, 0);
  });

  it("RPC throws → reason=error, does not throw", async () => {
    const db = makeDb({ enabled: true, rpcThrows: true });
    const r = await runTripMapProjectionPass({ client: db });
    assert.equal(r.reason, "error");
  });
});

describe("trip map projection worker — scheduler", () => {
  afterEach(() => stopTripMapProjectionScheduler());

  it("arms once, is idempotent on a second start, and stop disarms", () => {
    assert.equal(_tripMapProjectionSchedulerArmed(), false);
    startTripMapProjectionScheduler();
    assert.equal(_tripMapProjectionSchedulerArmed(), true);
    startTripMapProjectionScheduler();
    assert.equal(_tripMapProjectionSchedulerArmed(), true);
    stopTripMapProjectionScheduler();
    assert.equal(_tripMapProjectionSchedulerArmed(), false);
  });
});
