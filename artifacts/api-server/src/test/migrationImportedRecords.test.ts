/**
 * Imported records: the seven migrations that RAN BEFORE THIS REPOSITORY SAW THEM.
 *
 * ── WHAT THESE SEVEN FILES ARE ──────────────────────────────────────────────
 * An out-of-band writer applied seven migrations to production and to CI through
 * the Supabase CLI, under filenames this repository never carried. That path
 * writes `supabase_migrations.schema_migrations` and NOT
 * `public.schema_migration_ledger`, so the absence of a ledger row was never
 * evidence they had not run — and reading the live schemas showed they had.
 *
 * They were then imported: renumbered into the canonical 2100-2999 band and given
 * a provenance header. The DDL was deliberately NOT re-executed against either
 * database. The ledger row for each records the ORIGINAL execution — its real
 * timestamp and the supabase_migrations version it ran as — rather than
 * manufacturing a new one.
 *
 * ── WHAT THIS FILE PROTECTS ─────────────────────────────────────────────────
 * The whole arrangement rests on one property: THE RUNNER MUST SKIP THEM. If it
 * ever classified one as pending, a fresh apply would re-execute DDL that already
 * ran, against a database that already has it. These migrations are written
 * idempotently so that would survive — but "it would probably survive" is not the
 * guarantee anyone should be relying on, and the four `ALTER TABLE ... ADD
 * COLUMN` / `CREATE POLICY` shapes among them are exactly where a replay stops
 * being free.
 *
 * So this asserts the skip against the REAL files on disk, using the runner's own
 * planApply, plus the three ways the arrangement could silently rot:
 *
 *   - a checksum recorded and then the file edited        -> must DRIFT, not skip
 *   - the row downgraded to a 2254-style backfill row     -> must be UNPROVEN
 *   - the provenance header stripped from the file        -> caught here
 *
 * The middle one matters most. `backfill` is the tempting value for "it was
 * already there", and it is the WRONG one: a backfill row asserts only that the
 * filename existed, so the runner would treat the file as never-applied. That is
 * the same false positive that hid 2202_map_telemetry.sql's absence from
 * production for as long as it did.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const APPLIER = resolve(__dir, "../../../../scripts/src/apply-migrations.ts");
const MIGRATIONS_DIR = resolve(__dir, "../migrations");

const mod = await import(APPLIER);
const { planApply, checksumOf } = mod as typeof import("../../../../scripts/src/apply-migrations.js");

/**
 * filename -> the supabase_migrations version it actually ran as.
 * Production and CI ran them seconds apart under different version stamps; the
 * header records both, and this table carries production's.
 */
const IMPORTED: ReadonlyArray<readonly [string, string]> = [
  ["2951_media_processing_lifecycle.sql", "20260916120414"],
  ["2952_media_asset_deletion_lifecycle.sql", "20260916120416"],
  ["2953_media_processing_retention.sql", "20260916120418"],
  ["2954_media_lifecycle_rls.sql", "20260916120421"],
  ["2956_privacy_safe_sensing_credentials.sql", "20260916075630"],
  ["2957_presence_cleanup_flag.sql", "20260916075633"],
  ["2958_coverage_state.sql", "20260916075635"],
];

const sqlOf = (f: string) => readFileSync(resolve(MIGRATIONS_DIR, f), "utf8");
const onDisk = () => IMPORTED.map(([filename]) => ({ filename, sql: sqlOf(filename) }));

/** The ledger row shape the importer wrote: proven, carrying the disk checksum. */
const importedRow = (filename: string) => ({
  filename,
  checksum: checksumOf(sqlOf(filename)),
  applied_by: "manual" as const,
});

describe("imported records — the runner must skip what already ran", () => {
  test("all seven are SKIPPED, none pending, none drifted", () => {
    const plan = planApply(onDisk(), IMPORTED.map(([f]) => importedRow(f)));

    for (const [filename] of IMPORTED) {
      assert.ok(
        plan.skipped.includes(filename),
        `${filename} must be SKIPPED — it already ran. Got: ` +
          (plan.pending.includes(filename)
            ? "PENDING (the runner would RE-EXECUTE it)"
            : plan.unproven.includes(filename)
              ? "UNPROVEN (its ledger row does not prove an apply)"
              : plan.drifted.some((d) => d.filename === filename)
                ? "DRIFTED (recorded checksum no longer matches the file)"
                : "absent from the plan entirely"),
      );
    }
    assert.equal(plan.pending.length, 0, "nothing may be pending");
    assert.equal(plan.drifted.length, 0, "nothing may have drifted");
    assert.equal(plan.orphaned.length, 0, "no ledger row may name a missing file");
  });

  test("editing a file after its checksum was recorded DRIFTS rather than silently re-applying", () => {
    const [filename] = IMPORTED[0]!;
    const stale = { ...importedRow(filename), checksum: "0".repeat(64) };
    const plan = planApply(onDisk(), [stale]);

    assert.ok(
      plan.drifted.some((d) => d.filename === filename),
      "a recorded checksum that no longer matches the file must be reported as drift",
    );
    assert.ok(!plan.skipped.includes(filename), "drift must not be skipped over");
    assert.ok(!plan.pending.includes(filename), "drift must not be silently re-applied either");
  });

  test("a backfill row is NOT proof — downgrading one would make the runner re-execute it", () => {
    const [filename] = IMPORTED[0]!;
    // 2254's backfill shape: the literal 'backfill', asserting only that the
    // filename existed on disk when 2254 ran.
    const backfilled = { filename, checksum: "backfill", applied_by: "backfill" as const };
    const plan = planApply(onDisk(), [backfilled]);

    assert.ok(
      plan.unproven.includes(filename),
      "a backfill row must be UNPROVEN: it says a filename existed, never that the file ran",
    );
    assert.ok(!plan.skipped.includes(filename), "a backfill row must never be mistaken for proof");
  });

  test("each file still carries the supabase_migrations version it actually ran as", () => {
    for (const [filename, version] of IMPORTED) {
      const sql = sqlOf(filename);
      assert.ok(
        sql.includes(version),
        `${filename} must name its original supabase_migrations version ${version}. ` +
          "That string is the only link between this file and the execution it records; " +
          "without it the ledger row asserts an apply nobody can trace.",
      );
      assert.ok(
        /IMPORTED from an out-of-band writer/.test(sql),
        `${filename} must keep its provenance header saying it was imported, not authored here`,
      );
    }
  });

  test("the imported files are idempotent in shape — a fresh database must be able to replay them", () => {
    // The CI kernel job replays the ENTIRE chain onto an empty Postgres, where
    // these seven genuinely do need to run. Guarding the shape here because the
    // skip above means no other test ever executes them.
    for (const [filename] of IMPORTED) {
      const sql = sqlOf(filename);
      const creates = sql.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? [];
      assert.equal(
        creates.length,
        0,
        `${filename} has a bare CREATE TABLE; it must be CREATE TABLE IF NOT EXISTS so a replay is safe`,
      );
      const addCols = sql.match(/ADD COLUMN(?! IF NOT EXISTS)/gi) ?? [];
      assert.equal(
        addCols.length,
        0,
        `${filename} has a bare ADD COLUMN; it must be ADD COLUMN IF NOT EXISTS`,
      );
    }
  });
});
