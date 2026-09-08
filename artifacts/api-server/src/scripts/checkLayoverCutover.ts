/**
 * check:layover-cutover — is it safe to apply migration 2411 to PRODUCTION
 * right now, and if not, exactly what is missing?
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────────────
 * 2410 is applied: `layover_recommendations.rec_key` and the unique index
 * `layover_recs_session_key_uidx` exist in production, and
 * `layover_stable_recommendation_ids_enabled` is seeded FALSE. 2411 is written
 * and unapplied. It backfills the legacy rows' rec_key so an admin's
 * hidden/flagged status survives the moment the flag is flipped and the service
 * starts sweeping every unkeyed row.
 *
 * Whether that is safe to run TODAY is seven separate questions, and this script
 * answers each one on its own line with its own verdict:
 *
 *   1. DEPENDENCY            every object it touches exists, or is created by it,
 *                            or by a migration recorded as applied
 *   2. NON_VACUITY           it actually changes something
 *   3. BACKFILL_COMPLETENESS no row is left behind silently, and every key it
 *                            writes is one the writer would itself generate
 *   4. REVERSIBILITY         the rollback exists, is findable, reverses it, and
 *                            declares any loss it takes
 *   5. ORDERING_COLLISION    no unapplied migration makes apply order matter and
 *                            the prefix does not collide
 *   6. WRITER_READINESS      the code that uses the column is present and wired
 *   7. FLAG_POSTURE          the gate's production value, and that it fails closed
 *
 * ── TWO MODES, TWO DIFFERENT QUESTIONS ───────────────────────────────────────
 *   default (RATCHET)  Exit 0 while the seven verdicts are EXACTLY the ones this
 *                      repository has recorded and reviewed in RECORDED below.
 *                      It fails in BOTH directions: a condition that goes
 *                      GO -> NO_GO is a new hazard, and a condition that goes
 *                      NO_GO -> GO is a blocker that cleared while the record
 *                      still says otherwise. This is the mode CI runs, and it is
 *                      why a checker whose honest answer today is "blocked" can
 *                      still be green: green means "nothing changed unnoticed",
 *                      not "safe to apply".
 *   --verdict          Exit 0 ONLY if all seven are GO — the literal
 *                      "is it safe to apply right now" gate. TODAY IT EXITS 1.
 *   --report           Print everything, exit 0. No verdict.
 *
 * Exit 2 is reserved for "this checker could not do its job": a missing input,
 * or a scan that fell below the floor. A checker that examined nothing must
 * never print green — that is the trap this tree has hit repeatedly.
 *
 * ── IT APPLIES NOTHING ───────────────────────────────────────────────────────
 * No database connection, no SQL execution, no flag write. Every answer is a
 * file-vs-file comparison against the committed production snapshot and the
 * committed record of what has been applied. The one thing it CANNOT answer
 * offline is how many rows the backfill would touch; it demands that as a
 * committed measurement instead of reading the migration's own prose.
 *
 * Run: node --import tsx/esm src/scripts/checkLayoverCutover.ts [--verdict|--report]
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUTOVER_FLAG,
  MIGRATION_BASENAME,
  evaluateCutover,
  type ConditionId,
  type CutoverPaths,
  type Verdict,
} from "./lib/layoverCutoverEvaluate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const SRC = join(API_ROOT, "src");

/**
 * Test seams — the same device checkFlagSchemaPrerequisites and
 * checkProjectionConsumers use. They exist so the mutation suite can PROVE each
 * condition fires; the failure paths are otherwise unreachable while the real
 * tree is correct. NOTHING in CI sets them, and a spawn that sets any of them is
 * a fixture run, not a real-tree control.
 */
const MIGRATION_DIR = process.env.LAYOVER_CUTOVER_MIGRATION_DIR
  ? resolve(process.env.LAYOVER_CUTOVER_MIGRATION_DIR)
  : join(SRC, "migrations");
const SNAPSHOT = process.env.LAYOVER_CUTOVER_SNAPSHOT
  ? resolve(process.env.LAYOVER_CUTOVER_SNAPSHOT)
  : join(SRC, "lib", "capability", "snapshots", "20260908-production-schema.json");
const APPLIED = process.env.LAYOVER_CUTOVER_APPLIED
  ? resolve(process.env.LAYOVER_CUTOVER_APPLIED)
  : join(SRC, "lib", "capability", "production-applied-migrations.json");
const ROLLBACK_DIR = process.env.LAYOVER_CUTOVER_ROLLBACK_DIR
  ? resolve(process.env.LAYOVER_CUTOVER_ROLLBACK_DIR)
  : join(REPO_ROOT, "db", "rollback");
const SRC_DIR = process.env.LAYOVER_CUTOVER_SRC ? resolve(process.env.LAYOVER_CUTOVER_SRC) : SRC;
/**
 * The one input that is NOT in the tree today. 2411 changes rows, not shape, so
 * "does it change anything" is a COUNT against production. The migration's
 * header records one taken by hand on 2026-09-08 — but a comment is not a
 * measurement, and this checker will not grade prose. Commit the result of the
 * precondition query here and NON_VACUITY becomes answerable.
 */
const MEASUREMENT = process.env.LAYOVER_CUTOVER_MEASUREMENT
  ? resolve(process.env.LAYOVER_CUTOVER_MEASUREMENT)
  : join(SRC, "lib", "capability", "layover-cutover-measurement.json");

/**
 * THE RECORDED VERDICT, measured 2026-09-08 against
 * snapshots/20260908-production-schema.json and the applied record at watermark
 * 20260908023317.
 *
 * Two conditions are NO_GO and both are honest blockers, not gaps in the check:
 *
 *   NON_VACUITY     2411 declares no schema object at all, so its whole effect
 *                   is a row count, and no committed artifact carries one. Its
 *                   header records legacy_moderated = 0 on 2026-09-08 — i.e. it
 *                   would set 30 keys and preserve ZERO moderation states — but
 *                   that is prose. Blocked on OPERATIONAL DATA (see MEASUREMENT).
 *   REVERSIBILITY   the rollback claims a scope its SQL does not implement.
 *
 * Strike an entry here in the SAME change that clears the blocker, never before.
 */
const RECORDED: Record<ConditionId, Verdict> = {
  DEPENDENCY: "GO",
  NON_VACUITY: "NO_GO",
  BACKFILL_COMPLETENESS: "GO",
  REVERSIBILITY: "NO_GO",
  ORDERING_COLLISION: "GO",
  WRITER_READINESS: "GO",
  FLAG_POSTURE: "GO",
};

const MODE_VERDICT = process.argv.includes("--verdict");
const MODE_REPORT = process.argv.includes("--report");

function main(): number {
  const paths: CutoverPaths = {
    migrationDirs: [join(API_ROOT, "migrations"), MIGRATION_DIR],
    snapshotPath: SNAPSHOT,
    appliedPath: APPLIED,
    rollbackDir: ROLLBACK_DIR,
    srcDir: SRC_DIR,
    measurementPath: MEASUREMENT,
  };

  console.log(`check:layover-cutover — ${MIGRATION_BASENAME}`);
  console.log(`  snapshot   ${SNAPSHOT}`);
  console.log(`  applied    ${APPLIED}`);
  console.log(`  rollback   ${ROLLBACK_DIR}`);
  console.log(`  measurement ${MEASUREMENT}`);
  console.log("");

  const report = evaluateCutover(paths);

  if (report.fatal.length > 0) {
    for (const f of report.fatal) console.error(`  CANNOT EVALUATE: ${f}`);
    return 2;
  }

  const f = report.floor;
  console.log(
    `  scanned: ${f.migrationFilesScanned} migration file(s), ${f.appliedMigrationsRecorded} recorded as applied, ` +
      `${f.snapshotTables} snapshot table(s), ${f.snapshotFlags} flag(s), ${f.snapshotFunctions} function(s), ` +
      `${f.srcFilesScanned} TypeScript file(s); ${MIGRATION_BASENAME} yielded ${f.objectsExtracted} object(s) ` +
      `across ${f.statementsInMigration} statement(s).`,
  );
  console.log("");

  for (const c of report.conditions) {
    console.log(`${c.verdict === "GO" ? "GO   " : "NO-GO"}  ${c.id} — ${c.title}`);
    if (MODE_REPORT || c.verdict === "NO_GO") {
      for (const e of c.evidence) for (const line of e.split("\n")) console.log(`         · ${line}`);
    }
    for (const b of c.blockers) for (const line of b.split("\n")) console.log(`         ! ${line}`);
    console.log("");
  }
  for (const n of new Set(report.notes)) console.log(`  note: ${n}`);

  if (report.floorProblems.length > 0) {
    for (const p of report.floorProblems) console.error(`  ${p}`);
    return 2;
  }

  const allGo = report.conditions.every((c) => c.verdict === "GO");
  const blocked = report.conditions.filter((c) => c.verdict === "NO_GO").map((c) => c.id);

  console.log("");
  console.log(
    allGo
      ? `VERDICT: SAFE TO APPLY ${MIGRATION_BASENAME} to production now.`
      : `VERDICT: NOT SAFE TO APPLY. Blocked by: ${blocked.join(", ")}.`,
  );
  console.log(`         (${CUTOVER_FLAG} was NOT read from, or written to, any database by this check.)`);

  if (MODE_REPORT) return 0;
  if (MODE_VERDICT) return allGo ? 0 : 1;

  // RATCHET: the verdicts must be the ones on record.
  const drift: string[] = [];
  for (const c of report.conditions) {
    const want = RECORDED[c.id];
    if (want === undefined) {
      drift.push(`${c.id}: no recorded verdict. Add one to RECORDED in checkLayoverCutover.ts.`);
    } else if (want !== c.verdict) {
      drift.push(
        `${c.id}: recorded ${want}, now ${c.verdict}. ` +
          (c.verdict === "NO_GO"
            ? `A cutover condition that used to hold has stopped holding: ${c.blockers.join(" ")}`
            : `A recorded blocker has CLEARED. Strike ${c.id} from RECORDED in the same change that cleared it — a ` +
              `record that stays full after the fix is how a stale blocker outlives the thing it described.`),
      );
    }
  }
  const seen = new Set(report.conditions.map((c) => c.id));
  for (const id of Object.keys(RECORDED) as ConditionId[]) {
    if (!seen.has(id)) drift.push(`${id}: recorded but never evaluated. The condition was dropped from the checker.`);
  }

  console.log("");
  if (drift.length === 0) {
    console.log(`RATCHET: the seven verdicts are exactly the ones on record. (Green here means NOTHING CHANGED UNNOTICED, not "safe to apply" — run --verdict for that.)`);
    return 0;
  }
  for (const d of drift) console.error(`  DRIFT: ${d}`);
  return 1;
}

process.exit(main());
