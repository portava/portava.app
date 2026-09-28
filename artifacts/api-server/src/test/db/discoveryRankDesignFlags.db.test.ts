/**
 * census-discovery §78 (lane W10-R2) — migrations 3450–3454 on the local
 * PostgreSQL 16 harness (scripts/local-db). Harness evidence, never production.
 *
 *   R1  after the chain, the six §78 flags exist and are all FALSE; 3450's
 *       metadata is all-null surfaces and 3454's carries the four magnitudes
 *       the code reads (so turning the flag on turns all four axes on)
 *   R2  each file is idempotent: re-applied, one row per flag, still FALSE
 *   R3  each file REFUSES to certify a flag somebody turned on
 *   R4  each rollback deletes its rows while FALSE, and refuses while TRUE;
 *       re-applying after the rollback restores exactly the seeded rows
 *
 * Every mutation runs inside BEGIN … ROLLBACK, so the harness is left as the
 * chain built it.
 *
 * Run: scripts/local-db/up.sh, then scripts/local-db/run-tests.sh.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows } from "./localDb.js";
import { RANK_DESIGN_FLAGS } from "../../lib/discoveryRankFlags.js";
import { parseDiversityMagnitudes } from "../../lib/discoveryRankDiversity.js";
import { parseObjectiveOverrides } from "../../lib/discoveryRankObjectives.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG = (f: string) => resolve(__dir, "../../migrations", f);
const RB = (f: string) => resolve(__dir, "../../../../../db/rollback", f);

const FILES: Array<{ num: number; migration: string; rollback: string; flags: string[] }> = [
  { num: 3450, migration: "3450_discovery_surface_objectives_flag.sql", rollback: "2026-09-28-3450-discovery-surface-objectives-flag-rollback.sql", flags: ["discovery_surface_objectives_enabled"] },
  { num: 3451, migration: "3451_discovery_engagement_integrity_flag.sql", rollback: "2026-09-28-3451-discovery-engagement-integrity-flag-rollback.sql", flags: ["discovery_engagement_integrity_enabled"] },
  { num: 3452, migration: "3452_discovery_feature_families_flag.sql", rollback: "2026-09-28-3452-discovery-feature-families-flag-rollback.sql", flags: ["discovery_feature_families_enabled"] },
  { num: 3453, migration: "3453_discovery_intent_trip_terms_flags.sql", rollback: "2026-09-28-3453-discovery-intent-trip-terms-flags-rollback.sql", flags: ["discovery_intent_term_enabled", "discovery_trip_match_enabled"] },
  { num: 3454, migration: "3454_discovery_diversity_axes_flag.sql", rollback: "2026-09-28-3454-discovery-diversity-axes-flag-rollback.sql", flags: ["discovery_diversity_axes_enabled"] },
];

/** A file's body without its own BEGIN/COMMIT, so a test can wrap it in one it rolls back. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

const inList = (flags: string[]) => flags.map((f) => `'${f}'`).join(", ");

describe("§78 flag migrations 3450–3454 on the harness", { skip: !HAVE_DB }, () => {
  test("R1 the six flags exist, all FALSE, with the metadata the code reads", () => {
    const got = rows<{ flag: string; enabled: boolean; metadata: unknown }>(
      `SELECT flag, enabled, metadata FROM public.feature_flags WHERE flag IN (${inList([...RANK_DESIGN_FLAGS])}) ORDER BY flag`);
    assert.deepEqual(got.map((r) => r.flag), [...RANK_DESIGN_FLAGS].sort());
    assert.ok(got.every((r) => r.enabled === false), "every §78 flag ships OFF");
    const objectives = got.find((r) => r.flag === "discovery_surface_objectives_enabled")!;
    assert.deepEqual(objectives.metadata, { surfaces: { pulse: null, discovery: null, trail: null, trip_planning: null, trending: null } });
    assert.deepEqual(parseObjectiveOverrides(objectives.metadata), {}, "all-null surfaces ⇒ the code's family weights");
    const diversity = got.find((r) => r.flag === "discovery_diversity_axes_enabled")!;
    assert.deepEqual(parseDiversityMagnitudes(diversity.metadata), {
      placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15, historyMaxServes: 3, historyWindowDays: 7,
    });
  });

  test("R2 every file is idempotent", () => {
    for (const f of FILES) {
      const out = exec(`BEGIN;
${unwrapped(MIG(f.migration))}
SELECT 'N' || count(*) || ':' || bool_or(enabled) FROM public.feature_flags WHERE flag IN (${inList(f.flags)});
ROLLBACK;`).filter((l) => l.startsWith("N"));
      assert.deepEqual(out, [`N${f.flags.length}:false`], `${f.num} re-applied`);
    }
  });

  test("R3 every file refuses to certify a flag that reads TRUE", () => {
    for (const f of FILES) {
      const r = psql(`BEGIN;
UPDATE public.feature_flags SET enabled = TRUE WHERE flag = '${f.flags[0]}';
${unwrapped(MIG(f.migration))}
ROLLBACK;`);
      assert.notEqual(r.status, 0, `${f.num} must fail`);
      assert.match(r.stderr, new RegExp(`POSTCONDITION FAILED \\(${f.num}\\)`), `${f.num}: ${r.stderr.slice(0, 200)}`);
    }
  });

  test("R4 each rollback deletes while FALSE and refuses while TRUE; re-applying restores the seed", () => {
    for (const f of FILES) {
      const seeded = rows(`SELECT flag, enabled, description, metadata FROM public.feature_flags WHERE flag IN (${inList(f.flags)}) ORDER BY flag`);
      const out = exec(`BEGIN;
${unwrapped(RB(f.rollback))}
SELECT 'GONE' || count(*) FROM public.feature_flags WHERE flag IN (${inList(f.flags)});
${unwrapped(MIG(f.migration))}
SELECT 'BACK' || COALESCE(json_agg(json_build_object('flag', flag, 'enabled', enabled, 'description', description, 'metadata', metadata) ORDER BY flag), '[]'::json)::text
  FROM public.feature_flags WHERE flag IN (${inList(f.flags)});
ROLLBACK;`);
      assert.ok(out.includes("GONE0"), `${f.num} rollback removes its rows`);
      const back = JSON.parse(out.find((l) => l.startsWith("BACK"))!.slice(4));
      assert.deepEqual(back, seeded, `${f.num} re-applied after its rollback is the seed exactly`);

      const refused = psql(`BEGIN;
UPDATE public.feature_flags SET enabled = TRUE WHERE flag = '${f.flags[0]}';
${unwrapped(RB(f.rollback))}
ROLLBACK;`);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, new RegExp(`ROLLBACK REFUSED \\(${f.num}\\)`));
    }
  });
});
