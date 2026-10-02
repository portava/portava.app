/**
 * discoveryCandidatePipelineMigrations.db.test.ts — census-discovery §85 (lane
 * W10-R3). Migrations 3480–3484 on the harness chain.
 *
 *   H1  the eight §85 flags exist, and every one is FALSE (3480–3484)
 *   H2  3484's three provenance columns exist, nullable, with no default
 *   H3  the producer's two payload shapes land on real PostgreSQL: flag OFF
 *       (2026-07-30's five columns — provenance stays NULL) and flag ON (the
 *       three columns, `source_window` as jsonb) — so W3's fake is a database
 *   H4  3484's rollback and re-apply round-trip inside one transaction that is
 *       rolled back: the columns go and come back, no row of the table is lost
 *   H5  each flag file's postcondition refuses a seed that finds its flag ON
 *   H6  each flag file's rollback removes exactly its rows and re-applies,
 *       inside a rolled-back transaction; and REFUSES while a flag is ON
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG = (f: string) => resolve(__dir, "../../migrations", f);
const RB = (f: string) => resolve(__dir, "../../../../../db/rollback", f);

const FLAGS = [
  "discovery_candidate_sources_enabled", "discovery_circle_candidates_enabled", "discovery_exploration_inventory_enabled",
  "discovery_cold_start_enabled", "discovery_integrity_stage_enabled", "discovery_outcome_learning_enabled",
  "discovery_output_kinds_enabled", "compass_city_confidence_windowed_reads_enabled",
];
const TAG = `w10r3-${randomUUID().slice(0, 8)}`;

function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

describe("§85 — migrations 3480–3484 on the harness", { skip: !HAVE_DB }, () => {
  test("H1. the eight §85 flags exist and are FALSE", () => {
    const got = rows<{ flag: string; enabled: boolean }>(`SELECT flag, enabled FROM public.feature_flags WHERE flag IN (${FLAGS.map((f) => `'${f}'`).join(",")}) ORDER BY flag`);
    assert.deepEqual(got.map((r) => r.flag), [...FLAGS].sort());
    for (const r of got) assert.equal(r.enabled, false, r.flag);
  });

  test("H2. 3484's columns: nullable, default-free, the declared types", () => {
    const cols = rows<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'compass_city_confidence' AND column_name IN ('model_version','feature_version','source_window') ORDER BY column_name");
    assert.deepEqual(cols, [
      { column_name: "feature_version", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "model_version", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "source_window", data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
  });

  test("H3. both producer payloads land; flag OFF leaves provenance NULL", () => {
    const off = `${TAG}-off`, on = `${TAG}-on`;
    const win = JSON.stringify({ kind: "unbounded_start", startMs: null, endMs: 1_790_000_000_000, truncated: false, rows: { "compass_graph_edges.visits": 3 } });
    try {
      exec(`INSERT INTO public.compass_city_confidence (city, depth_score, tier, signals, computed_at) VALUES ('${off}', 12.5, 'thin', '{"visitors":1}'::jsonb, now())
              ON CONFLICT (city) DO UPDATE SET depth_score = EXCLUDED.depth_score;
            INSERT INTO public.compass_city_confidence (city, depth_score, tier, signals, computed_at, model_version, feature_version, source_window)
              VALUES ('${on}', 40, 'moderate', '{"visitors":9}'::jsonb, now(), 'compass-city-depth-v1', 'compass-city-depth-signals-v1', '${win}'::jsonb)
              ON CONFLICT (city) DO UPDATE SET model_version = EXCLUDED.model_version;`);
      assert.equal(scalar(`SELECT count(*) FROM public.compass_city_confidence WHERE city = '${off}' AND model_version IS NULL AND feature_version IS NULL AND source_window IS NULL;`), "1");
      assert.equal(scalar(`SELECT source_window->>'kind' FROM public.compass_city_confidence WHERE city = '${on}';`), "unbounded_start");
      assert.equal(scalar(`SELECT model_version FROM public.compass_city_confidence WHERE city = '${on}';`), "compass-city-depth-v1");
    } finally {
      exec(`DELETE FROM public.compass_city_confidence WHERE city IN ('${off}', '${on}');`);
    }
  });

  test("H4. 3484 rollback → re-apply round-trips, inside a rolled-back transaction", () => {
    const keep = `${TAG}-keep`;
    const script = `BEGIN;
      INSERT INTO public.compass_city_confidence (city, depth_score, tier, signals, computed_at) VALUES ('${keep}', 1, 'thin', '{}'::jsonb, now());
      ${unwrapped(RB("2026-09-28-3484-compass-city-confidence-provenance-rollback.sql")).replace(/DELETE FROM public\.schema_migration_ledger[^;]*;/, "")}
      SELECT 'AFTER_RB ' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'compass_city_confidence' AND column_name IN ('model_version','feature_version','source_window');
      ${unwrapped(MIG("3484_compass_city_confidence_provenance.sql"))}
      SELECT 'AFTER_RE ' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'compass_city_confidence' AND column_name IN ('model_version','feature_version','source_window');
      SELECT 'KEPT ' || count(*) FROM public.compass_city_confidence WHERE city = '${keep}';
      ROLLBACK;`;
    const r = psql(script);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /AFTER_RB 0/);
    assert.match(r.stdout, /AFTER_RE 3/);
    assert.match(r.stdout, /KEPT 1/);
    assert.equal(scalar(`SELECT count(*) FROM public.compass_city_confidence WHERE city = '${keep}';`), "0", "the transaction rolled back");
  });

  test("H5. each file's postcondition refuses a seed that finds its flag ON", () => {
    for (const [file, flag] of [
      ["3480_discovery_candidate_sources_flag.sql", "discovery_candidate_sources_enabled"],
      ["3481_discovery_exploration_inventory_flag.sql", "discovery_exploration_inventory_enabled"],
      ["3482_discovery_cold_start_flag.sql", "discovery_cold_start_enabled"],
      ["3483_discovery_pipeline_stages_flags.sql", "discovery_outcome_learning_enabled"],
      ["3484_compass_city_confidence_provenance.sql", "compass_city_confidence_windowed_reads_enabled"],
    ] as const) {
      const r = psql(`BEGIN;
        UPDATE public.feature_flags SET enabled = TRUE WHERE flag = '${flag}';
        ${unwrapped(MIG(file))}
        ROLLBACK;`);
      assert.notEqual(r.status, 0, `${file} accepted an ON flag`);
      assert.match(r.stderr, /POSTCONDITION FAILED/, file);
      assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${flag}';`), "false", "nothing persisted");
    }
  });

  test("H6. each flag rollback round-trips, and refuses while its flag is ON", () => {
    for (const [num, file, rb, flags] of [
      ["3480", "3480_discovery_candidate_sources_flag.sql", "2026-09-28-3480-discovery-candidate-sources-flag-rollback.sql", ["discovery_candidate_sources_enabled", "discovery_circle_candidates_enabled"]],
      ["3481", "3481_discovery_exploration_inventory_flag.sql", "2026-09-28-3481-discovery-exploration-inventory-flag-rollback.sql", ["discovery_exploration_inventory_enabled"]],
      ["3482", "3482_discovery_cold_start_flag.sql", "2026-09-28-3482-discovery-cold-start-flag-rollback.sql", ["discovery_cold_start_enabled"]],
      ["3483", "3483_discovery_pipeline_stages_flags.sql", "2026-09-28-3483-discovery-pipeline-stages-flags-rollback.sql", ["discovery_integrity_stage_enabled", "discovery_outcome_learning_enabled", "discovery_output_kinds_enabled"]],
    ] as const) {
      const list = flags.map((f) => `'${f}'`).join(",");
      const r = psql(`BEGIN;
        ${unwrapped(RB(rb))}
        SELECT 'GONE ' || count(*) FROM public.feature_flags WHERE flag IN (${list});
        ${unwrapped(MIG(file))}
        SELECT 'BACK ' || count(*) FROM public.feature_flags WHERE flag IN (${list}) AND enabled = FALSE;
        ROLLBACK;`);
      assert.equal(r.status, 0, `${num}: ${r.stderr}`);
      assert.match(r.stdout, /GONE 0/, num);
      assert.match(r.stdout, new RegExp(`BACK ${flags.length}`), num);
      const refused = psql(`BEGIN; UPDATE public.feature_flags SET enabled = TRUE WHERE flag = '${flags[0]}'; ${unwrapped(RB(rb))} ROLLBACK;`);
      assert.notEqual(refused.status, 0, `${num} rollback deleted an ON flag`);
      assert.match(refused.stderr, /ROLLBACK REFUSED/, num);
    }
    assert.equal(scalar(`SELECT count(*) FROM public.feature_flags WHERE flag IN (${FLAGS.map((f) => `'${f}'`).join(",")}) AND enabled = FALSE;`), String(FLAGS.length), "nothing persisted");
  });
});
