/**
 * trailHealthSnapshotProvenance.db.test.ts — census-discovery DC-17 (§75, lane P33, H-P21-3).
 *
 * `10` §5: a derived feature must retain its source event window, feature
 * version, model version and computation time. 3436 adds `feature_version` and
 * `source_window` to `trail_health_snapshots`. This suite runs on the harness
 * chain, which applies 3436 in order.
 *
 *   H1  the payload the WRITER sends (captured from TrailService through the
 *       in-memory fake, not restated here) is accepted by 3436's schema and
 *       reads back with all four facts: model_version, feature_version,
 *       source_window and captured_at = the health's computation clock
 *   H2  columns only: a 2910-shaped insert (the latch's legacy shape) is still
 *       accepted and stores both new columns NULL — "not recorded"; no row is
 *       backfilled, and every 2910 column reads back as written
 *   H3  the latch's premise, on a real server: with 3436 rolled back (inside a
 *       transaction that is itself rolled back) the provenance insert fails
 *       with SQLSTATE 42703 — the code `isMissingColumnError` keys on — and the
 *       legacy insert succeeds; 3436 re-applied over the rolled-back table and
 *       applied a second time are both clean (idempotent), and its
 *       postconditions pass
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, rows, scalar, jsonLiteral } from "./localDb.js";
import { computeTrailHealth, TRAIL_HEALTH_MODEL_VERSION, TRAIL_HEALTH_FEATURE_VERSION } from "../../lib/discoveryTrailHealth.js";
import { recordTrailHealthSnapshot, _resetTrailSnapshotProvenanceLatch } from "../../services/trails/TrailService.js";
import { makeFakeTrailsDb } from "../helpers/fakeTrailsDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3436_trail_health_snapshot_provenance.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-28-3436-trail-health-snapshot-provenance-rollback.sql");

const TRAIL = randomUUID();
const NOW_MS = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const HOUR = 3_600_000;

function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

/** What TrailService.recordTrailHealthSnapshot sends for this health, captured through the fake. */
async function writerPayload(missingColumns: string[] = []): Promise<Record<string, unknown>> {
  _resetTrailSnapshotProvenanceLatch();
  const health = computeTrailHealth({
    members: [0, 1, 2].map((i) => ({
      source_id: `s-${i}`, contributor_id: `c-${i % 2}`, confidence: 0.3 + i / 5, content_state: "just_arrived",
      created_at: new Date(NOW_MS - (i + 1) * 30 * 24 * HOUR).toISOString(),
    })),
    reportCount: 1,
    nowMs: NOW_MS,
  });
  const db = makeFakeTrailsDb({}, { missingColumns });
  assert.equal(await recordTrailHealthSnapshot(db, TRAIL, health), "written");
  _resetTrailSnapshotProvenanceLatch();
  const sent = db.inserts.filter((i) => i.table === "trail_health_snapshots");
  assert.equal(sent.length, 1);
  return sent[0]!.payload;
}

const insertOf = (p: Record<string, unknown>) =>
  `INSERT INTO public.trail_health_snapshots SELECT * FROM jsonb_populate_record(NULL::public.trail_health_snapshots, ${jsonLiteral(p)} || jsonb_build_object('id', gen_random_uuid()));`;

before(() => {
  if (!HAVE_DB) return;
  assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots' AND column_name IN ('feature_version', 'source_window');`), "2",
    "3436 must be in the harness chain");
  exec(`INSERT INTO public.trails (id, slug, title) VALUES ('${TRAIL}', 'p33-${TRAIL.slice(0, 8)}', 'p33 snapshot provenance');`);
});

after(() => {
  if (!HAVE_DB) return;
  exec(`DELETE FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}';\nDELETE FROM public.trails WHERE id = '${TRAIL}';`);
});

describe("H — DC-17: a Trail health snapshot keeps all four facts (3436)", { skip: !HAVE_DB }, () => {
  test("H1. the writer's own payload is stored, and reads back with window, feature version, model version and computation clock", async () => {
    const p = await writerPayload();
    assert.ok("feature_version" in p && "source_window" in p, "precondition: the writer sent 3436's columns");
    exec(insertOf(p));
    const [r] = rows<{ model_version: string; feature_version: string; source_window: Record<string, unknown>; captured_at: string; member_count: number }>(
      `SELECT model_version, feature_version, source_window, captured_at, member_count FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}' AND feature_version IS NOT NULL`);
    assert.ok(r, "the row was stored");
    assert.equal(r.model_version, TRAIL_HEALTH_MODEL_VERSION);
    assert.equal(r.feature_version, TRAIL_HEALTH_FEATURE_VERSION);
    assert.deepEqual(r.source_window, { kind: "unbounded_start", start: null, end: new Date(NOW_MS).toISOString() });
    assert.equal(Date.parse(r.captured_at), NOW_MS, "captured_at is the computation clock the health carries");
    assert.equal(r.member_count, 3);
  });

  test("H2. columns only: the legacy (latched) payload is accepted, both new columns NULL, every 2910 column as written", async () => {
    const legacy = await writerPayload(["feature_version", "source_window"]);
    assert.deepEqual(Object.keys(legacy).sort(), ["captured_at", "member_count", "metrics", "model_version", "trail_id"]);
    exec(`DELETE FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}';`);
    exec(insertOf(legacy));
    const [r] = rows<Record<string, unknown>>(`SELECT trail_id, metrics, model_version, member_count, captured_at, feature_version, source_window FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}'`);
    assert.equal(r!["feature_version"], null);
    assert.equal(r!["source_window"], null);
    assert.deepEqual(r!["metrics"], legacy["metrics"]);
    assert.equal(r!["model_version"], legacy["model_version"]);
    assert.equal(r!["member_count"], legacy["member_count"]);
    assert.equal(Date.parse(String(r!["captured_at"])), Date.parse(String(legacy["captured_at"])));
  });

  test("H3. rolled back, the provenance insert answers 42703 and the legacy one succeeds; re-applied twice, clean", async () => {
    const withCols = await writerPayload();
    const legacy = await writerPayload(["feature_version", "source_window"]);
    const direct = (p: Record<string, unknown>) => {
      const cols = Object.keys(p);
      const vals = cols.map((c) => (c === "metrics" || c === "source_window") ? jsonLiteral(p[c]) : typeof p[c] === "number" ? String(p[c]) : `'${String(p[c])}'`);
      return `INSERT INTO public.trail_health_snapshots (${cols.join(", ")}) VALUES (${vals.join(", ")})`;
    };
    const out = exec(`BEGIN;
${unwrapped(ROLLBACK)}
SELECT 'COLS' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots' AND column_name IN ('feature_version', 'source_window');
DO $d$ BEGIN
  ${direct(withCols)};
  PERFORM set_config('p33.code', 'none', true);
EXCEPTION WHEN undefined_column THEN
  PERFORM set_config('p33.code', SQLSTATE, true);
END $d$;
SELECT 'CODE' || current_setting('p33.code', true);
${direct(legacy)};
SELECT 'LEGACY' || count(*) FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}';
${unwrapped(MIGRATION)}
${unwrapped(MIGRATION)}
SELECT 'REAPPLIED' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots' AND column_name IN ('feature_version', 'source_window');
SELECT 'NULLS' || count(*) FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}' AND feature_version IS NULL AND source_window IS NULL;
ROLLBACK;`);
    const tag = (t: string) => out.find((l) => l.startsWith(t))?.slice(t.length);
    assert.equal(tag("COLS"), "0", "the rollback drops both columns");
    assert.equal(tag("CODE"), "42703", "the provenance insert fails with the SQLSTATE the writer's latch keys on");
    assert.ok(Number(tag("LEGACY")) >= 1, "the latch's legacy insert is accepted");
    assert.equal(tag("REAPPLIED"), "2", "3436 re-applied (twice) restores both columns");
    assert.ok(Number(tag("NULLS")) >= 1, "rows written without 3436 are not backfilled");
    assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots' AND column_name IN ('feature_version', 'source_window');`), "2",
      "the whole rehearsal was rolled back");
  });
});
