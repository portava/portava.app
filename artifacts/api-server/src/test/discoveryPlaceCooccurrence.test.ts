/**
 * discoveryPlaceCooccurrence.test.ts — census-discovery DV-72 (§95, lane
 * W11-X3; register D-W11X3-1): the reader and the rebuild tick for the
 * Trail-derived `place_cooccurrence` (3495), both behind
 * `discovery_place_cooccurrence_enabled` (3496, seeded FALSE).
 *
 *   C1  flag OFF: `disabled`, and the only read is the flag row
 *   C2  flag unreadable: `disabled` (fail closed)
 *   C3  flag ON: both halves merged, most shared Trails first, then id; the
 *       `db/` prefix is accepted; lineage carried
 *   C4  one half unreadable: `unreadable`, never an empty list
 *   C5  a non-uuid place: `invalid_place`, no table read
 *   C6  a row of another basis is never served
 *   T1  tick OFF: nothing called; ON: the rebuild at the hour; a failed rebuild is `failed`
 *   M1  3495's constants equal this module's; 3495 admits only basis 'shared_trail'
 *   M2  3495's executable SQL reads no person: no user, owner, author or itinerary column/table
 *   M3  3496 seeds both flags FALSE
 *
 * Controlled data only; nothing here is production evidence.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPlaceCooccurrence, runPlaceCooccurrenceRebuildTick, _setTestClient, cooccurrenceRebuildInstant,
  PLACE_COOCCURRENCE_MODEL_VERSION, PLACE_COOCCURRENCE_FEATURE_VERSION, PLACE_COOCCURRENCE_MAX_TRAIL_PLACES,
} from "../lib/discoveryPlaceCooccurrence.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const M3495 = readFileSync(resolve(__dir, "../migrations/3495_place_cooccurrence_trail_projection.sql"), "utf8");
const M3496 = readFileSync(resolve(__dir, "../migrations/3496_discovery_w11x3_flags.sql"), "utf8");

const P = "11111111-1111-4111-8111-111111111111";
const A = "0aaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

interface Call { table: string; filters: Array<[string, unknown]>; orders: string[]; limit?: number }

function row(a: string, b: string, n: number, basis = "shared_trail") {
  return {
    place_a: a, place_b: b, basis, shared_trail_count: n,
    source_window_start: "2026-09-01T00:00:00+00:00", source_window_end: "2026-09-20T00:00:00+00:00",
    feature_version: PLACE_COOCCURRENCE_FEATURE_VERSION, model_version: PLACE_COOCCURRENCE_MODEL_VERSION,
    computed_at: "2026-09-28T10:00:00+00:00",
  };
}

function fake(opts: {
  flag?: boolean | "error";
  rows?: Array<ReturnType<typeof row>>;
  failHalf?: "place_a" | "place_b";
  rpc?: { data?: unknown; error?: unknown };
}) {
  const calls: Call[] = [];
  const rpcs: Array<{ fn: string; args: unknown }> = [];
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [], orders: [] };
      calls.push(call);
      const q: any = {
        select() { return q; },
        eq(col: string, v: unknown) { call.filters.push([col, v]); return q; },
        order(col: string) { call.orders.push(col); return q; },
        limit(n: number) { call.limit = n; return q; },
        maybeSingle() {
          if (table !== "feature_flags") throw new Error("unexpected maybeSingle");
          if (opts.flag === "error") return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: opts.flag === undefined ? null : { enabled: opts.flag }, error: null });
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          const col = call.filters[0]?.[0] as string;
          const val = call.filters[0]?.[1];
          if (opts.failHalf === col) return Promise.resolve({ data: null, error: { code: "42P01" } }).then(res, rej);
          const data = (opts.rows ?? []).filter((r) => (r as Record<string, unknown>)[col] === val);
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return q;
    },
    rpc(fn: string, args: unknown) { rpcs.push({ fn, args }); return Promise.resolve(opts.rpc ?? { data: 7, error: null }); },
  };
  return { client, calls, rpcs };
}

describe("C — the reader", () => {
  it("C1 flag OFF: disabled, and the only read is the flag row", async () => {
    const f = fake({ flag: false, rows: [row(P, A, 2)] });
    assert.deepEqual(await readPlaceCooccurrence(f.client, P), { status: "disabled" });
    assert.deepEqual(f.calls.map((c) => c.table), ["feature_flags"]);
    const absent = fake({ rows: [row(P, A, 2)] });
    assert.deepEqual(await readPlaceCooccurrence(absent.client, P), { status: "disabled" });
    assert.deepEqual(absent.calls.map((c) => c.table), ["feature_flags"]);
  });

  it("C2 flag unreadable: disabled (fail closed)", async () => {
    const f = fake({ flag: "error", rows: [row(P, A, 2)] });
    assert.deepEqual(await readPlaceCooccurrence(f.client, P), { status: "disabled" });
    assert.deepEqual(f.calls.map((c) => c.table), ["feature_flags"]);
  });

  it("C3 flag ON: both halves merged, most shared Trails first, then id; `db/` accepted; lineage carried", async () => {
    const f = fake({ flag: true, rows: [row(P, C, 1), row(P, B, 3), row(A, P, 3), row(A, B, 9)] });
    const got = await readPlaceCooccurrence(f.client, `db/${P.toUpperCase()}`);
    assert.equal(got.status, "ok");
    if (got.status !== "ok") return;
    assert.deepEqual(got.neighbours.map((n) => [n.placeId, n.sharedTrails]), [[A, 3], [B, 3], [C, 1]]);
    assert.deepEqual(got.neighbours[0]!.provenance, {
      basis: "shared_trail",
      sourceWindow: { start: "2026-09-01T00:00:00+00:00", end: "2026-09-20T00:00:00+00:00" },
      featureVersion: PLACE_COOCCURRENCE_FEATURE_VERSION, modelVersion: PLACE_COOCCURRENCE_MODEL_VERSION,
      computedAt: "2026-09-28T10:00:00+00:00",
    });
    const tableCalls = f.calls.filter((c) => c.table === "place_cooccurrence");
    assert.deepEqual(tableCalls.map((c) => c.filters), [[["place_a", P]], [["place_b", P]]]);
    assert.deepEqual(tableCalls.map((c) => c.orders), [["shared_trail_count", "place_b"], ["shared_trail_count", "place_a"]]);
    const two = await readPlaceCooccurrence(f.client, P, { limit: 2 });
    assert.equal(two.status === "ok" ? two.neighbours.length : -1, 2);
  });

  it("C4 one half unreadable: `unreadable`, never an empty list", async () => {
    for (const half of ["place_a", "place_b"] as const) {
      const f = fake({ flag: true, rows: [row(P, B, 3)], failHalf: half });
      assert.deepEqual(await readPlaceCooccurrence(f.client, P), { status: "unreadable", failedRead: `place_cooccurrence.${half}` });
    }
  });

  it("C5 a non-uuid place: invalid_place, and the table is not read", async () => {
    const f = fake({ flag: true, rows: [row(P, B, 3)] });
    assert.deepEqual(await readPlaceCooccurrence(f.client, "osm/node/123"), { status: "invalid_place" });
    assert.deepEqual(f.calls.map((c) => c.table), ["feature_flags"]);
  });

  it("C6 a row of another basis is never served", async () => {
    const f = fake({ flag: true, rows: [row(P, B, 3, "itinerary"), row(P, C, 1)] });
    const got = await readPlaceCooccurrence(f.client, P);
    assert.deepEqual(got.status === "ok" ? got.neighbours.map((n) => n.placeId) : null, [C]);
  });
});

describe("T — the rebuild tick", () => {
  afterEach(() => _setTestClient(null));
  beforeEach(() => _setTestClient(null));

  it("T1 OFF: nothing is called; ON: the rebuild at the hour; a failed rebuild is `failed`", async () => {
    const now = Date.parse("2026-09-28T10:37:12.000Z");
    const off = fake({ flag: false });
    _setTestClient(off.client);
    assert.deepEqual(await runPlaceCooccurrenceRebuildTick(now), { status: "skipped", reason: "disabled" });
    assert.equal(off.rpcs.length, 0);

    const on = fake({ flag: true });
    _setTestClient(on.client);
    assert.deepEqual(await runPlaceCooccurrenceRebuildTick(now), { status: "ran", pNow: "2026-09-28T10:00:00.000Z", written: 7 });
    assert.deepEqual(on.rpcs, [{ fn: "rebuild_place_cooccurrence", args: { p_now: "2026-09-28T10:00:00.000Z" } }]);
    assert.equal(cooccurrenceRebuildInstant(now), "2026-09-28T10:00:00.000Z");

    const bad = fake({ flag: true, rpc: { data: null, error: { code: "42883" } } });
    _setTestClient(bad.client);
    assert.deepEqual(await runPlaceCooccurrenceRebuildTick(now), { status: "failed", reason: "42883", pNow: "2026-09-28T10:00:00.000Z" });
  });
});

describe("M — the migrations say what this module says", () => {
  it("M1 3495's constants equal this module's; only basis 'shared_trail' is admitted", () => {
    assert.match(M3495, new RegExp(`c_feature\\s+CONSTANT text\\s+:= '${PLACE_COOCCURRENCE_FEATURE_VERSION}';`));
    assert.match(M3495, new RegExp(`c_model\\s+CONSTANT text\\s+:= '${PLACE_COOCCURRENCE_MODEL_VERSION}';`));
    assert.match(M3495, new RegExp(`c_max_trail_places CONSTANT integer := ${PLACE_COOCCURRENCE_MAX_TRAIL_PLACES};`));
    assert.match(M3495, /CONSTRAINT place_cooccurrence_basis_trail_only CHECK \(basis = 'shared_trail'\)/);
  });

  it("M2 3495's executable SQL reads no person: no user, owner, author, trip or itinerary column or table", () => {
    // Comments and string literals out; dollar-quoted bodies (the rebuild) kept.
    const code = M3495.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
    for (const word of ["user_id", "owner_id", "author_id", "tagger_id", "submitted_by", "trips", "trip_members", "itinerar", "memories", "rank_events", "passport_stamps", "checkins"]) {
      assert.ok(!code.includes(word), `3495 names ${word}`);
    }
    assert.match(code, /FROM public\.content_trails AS ct/);
  });

  it("M3 3496 seeds both flags FALSE", () => {
    for (const flag of ["discovery_place_cooccurrence_enabled", "discovery_trend_post_convergence_enabled"]) {
      assert.match(M3496, new RegExp(`'${flag}',\\s*\\n\\s*false,`));
    }
  });
});
