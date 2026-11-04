/**
 * graphBehaviorObservations.db.test.ts — census-discovery §133 (DV-51):
 * migration 3921's view on real PostgreSQL, against its TypeScript mirror
 * (`graphBehaviorObservationsOf`, compass/CompassGraphEngine.ts) that every
 * graph test fake serves.
 *
 *   G1  parity: for a seeded world (several outcomes per pair, two viewers, rows
 *       either side of a UTC midnight, an item_kind tie broken by id) the view's
 *       rows equal the mirror's, column for column, in obs_key order
 *       (rank_events.served_at is NOT NULL, so no NULL case exists to mirror)
 *   G2  one row per (user, item, outcome), however many raw rows: 1,500 rows
 *       collapse to one with observations = 1,500
 *   G3  the posture: anon and authenticated cannot read it; service_role can
 *   G4  3921 re-applied is a no-op (CREATE OR REPLACE to the same definition)
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HAVE_DB, exec, rows, scalar, seedUser, deleteUser, psql } from "./localDb.js";
import { graphBehaviorObservationsOf } from "../../compass/CompassGraphEngine.js";

const norm = (r: Record<string, unknown>) => ({
  user_id: String(r.user_id), item_id: String(r.item_id), outcome: String(r.outcome),
  item_kind: r.item_kind ?? null,
  observations: Number(r.observations),
  first_at: r.first_at == null ? null : new Date(String(r.first_at)).toISOString(),
  last_at: r.last_at == null ? null : new Date(String(r.last_at)).toISOString(),
  days: Array.isArray(r.days) ? r.days.map(String) : String(r.days ?? "{}").replace(/[{}]/g, "").split(",").filter(Boolean),
  obs_key: String(r.obs_key),
});

describe("3921 graph_behavior_observations — the view equals its TypeScript mirror", { skip: !HAVE_DB }, () => {
  let u1 = "", u2 = "";
  const raw: Array<Record<string, unknown>> = [];

  before(() => {
    u1 = seedUser("gbo1"); u2 = seedUser("gbo2");
    const add = (id: string, user: string, item: string, kind: string, outcome: string, at: string) => {
      raw.push({ id, user_id: user, item_id: item, item_kind: kind, outcome, served_at: at });
      exec(`INSERT INTO public.rank_events (id, user_id, item_id, item_kind, outcome, surface, served_at)
            VALUES ('${id}', '${user}', '${item}', '${kind}', '${outcome}', 'discovery', '${at}');`);
    };
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    add(uuid(1), u1, "db/p-1", "place", "tap", "2026-09-01T23:30:00Z");
    add(uuid(2), u1, "db/p-1", "place", "tap", "2026-09-02T00:30:00Z");
    add(uuid(3), u1, "db/p-1", "gem", "tap", "2026-09-01T23:30:00Z");        // same instant as uuid(1): the id breaks the tie
    add(uuid(4), u1, "db/p-1", "place", "save", "2026-09-05T10:00:00Z");
    add(uuid(5), u1, "db/p-1", "place", "impression", "2026-09-05T10:00:00Z");
    add(uuid(6), u2, "db/p-1", "place", "tap", "2026-10-01T08:00:00Z");
    add(uuid(7), u2, "node/77", "place", "dismiss", "2026-10-02T23:59:59Z");
    add(uuid(8), u2, "node/77", "place", "dismiss", "2026-10-03T12:00:00Z");
  });

  after(() => {
    exec(`DELETE FROM public.rank_events WHERE user_id IN ('${u1}', '${u2}');`);
    deleteUser(u1); deleteUser(u2);
  });

  test("G1 parity: every row and column equals the mirror's, in obs_key order", () => {
    const db = rows<Record<string, unknown>>(`SELECT * FROM public.graph_behavior_observations WHERE user_id IN ('${u1}', '${u2}') ORDER BY obs_key`).map(norm);
    const ts = graphBehaviorObservationsOf(raw as any).map(norm);
    assert.equal(db.length, 5, JSON.stringify(db));
    assert.deepEqual(db, ts);
    const tap = db.find((r) => r.user_id === u1 && r.outcome === "tap")!;
    assert.equal(tap.observations, 3);
    assert.equal(tap.item_kind, "place", "the earliest row, ties broken by id");
    assert.deepEqual(tap.days, ["2026-09-01", "2026-09-02"], "UTC days");
    const nul = db.find((r) => r.outcome === "dismiss")!;
    assert.equal(nul.observations, 2);
    assert.deepEqual(nul.days, ["2026-10-02", "2026-10-03"]);
  });

  test("G2 one row per (user, item, outcome), however many raw rows", () => {
    exec(`INSERT INTO public.rank_events (user_id, item_id, item_kind, outcome, surface, served_at)
          SELECT '${u2}', 'db/bulk', 'place', 'tap', 'discovery', '2026-10-05T00:00:00Z'::timestamptz + (g || ' minutes')::interval FROM generate_series(1, 1500) g;`);
    const r = rows<Record<string, unknown>>(`SELECT * FROM public.graph_behavior_observations WHERE user_id = '${u2}' AND item_id = 'db/bulk'`).map(norm);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.observations, 1500);
    assert.deepEqual(r[0]!.days, ["2026-10-05", "2026-10-06"]);
  });

  test("G3 posture: no client role reads it; service_role does", () => {
    assert.equal(scalar(`SELECT has_table_privilege('anon', 'public.graph_behavior_observations', 'SELECT')`), "f");
    assert.equal(scalar(`SELECT has_table_privilege('authenticated', 'public.graph_behavior_observations', 'SELECT')`), "f");
    assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.graph_behavior_observations', 'SELECT')`), "t");
  });

  test("G4 3921 re-applied is a no-op", () => {
    const before = scalar(`SELECT md5(pg_get_viewdef('public.graph_behavior_observations'::regclass))`);
    const sql = readFileSync(new URL("../../migrations/3921_graph_behavior_observations.sql", import.meta.url), "utf8");
    const r = psql(sql);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(scalar(`SELECT md5(pg_get_viewdef('public.graph_behavior_observations'::regclass))`), before);
  });
});
