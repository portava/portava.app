/**
 * The seven cutover conditions for migration 2411, each evaluated independently
 * and each carrying its own verdict.
 *
 * Everything here is a file-vs-file comparison: the committed production
 * snapshot, the repository's record of what has been applied, the migration
 * text, the rollback text, and the tree's own TypeScript. No socket is opened
 * and no SQL is executed — the question "is it safe to apply" must be
 * answerable without touching the database it is about.
 *
 * WHERE THAT IS NOT ENOUGH, IT SAYS SO. The snapshot carries columns, functions,
 * enum type names and flag values. It carries no ROW COUNTS, so whether 2411
 * would actually change anything is not derivable from it — that is operational
 * data, and this file demands it as a committed measurement rather than
 * inferring it from the migration's own prose. A comment is not a measurement.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { stripComments } from "./stripComments.js";
import {
  collectCreatedObjects,
  emptyCreated,
  extractSqlObjects,
  isMutatingStatement,
  maskSqlLiterals,
  splitSqlStatements,
  stripSqlComments,
  type CreatedObjects,
  type Extraction,
} from "./layoverCutoverCore.js";
import { validatePrefixBand } from "../migrationPrefixRules.js";

// ── the subject ──────────────────────────────────────────────────────────────

export const MIGRATION_PREFIX = "2411";
export const MIGRATION_BASENAME = "2411_layover_recommendation_rec_key_backfill";
export const PREDECESSOR_BASENAME = "2410_layover_recommendation_identity";
export const TARGET_TABLE = "layover_recommendations";
export const TARGET_COLUMN = "rec_key";
import { extractDerivation, derivationChecksum } from "./layoverCutoverMeasure.js";

/**
 * How old a cutover measurement may be before it stops counting as evidence.
 *
 * Layover recommendations are generated per session and swept, so the population
 * turns over: a month-old count describes rows that may no longer exist. Thirty
 * days is deliberately generous — the point is that an unbounded artifact would
 * silently become folklore, not that any particular number is exact.
 */
export const MEASUREMENT_MAX_AGE_DAYS = 30;

export const CUTOVER_FLAG = "layover_stable_recommendation_ids_enabled";
export const KEY_FUNCTION = "recommendationKey";
export const WRITER_FILE = "services/airport/LayoverRecommendationService.ts";
export const FLAG_READER_FILE = "lib/featureFlags.ts";

/** The predicate a human runs to count rows 2411 would leave behind. */
export const LEFTOVER_PREDICATE = [
  "SELECT count(*) FILTER (WHERE rec_key IS NULL)                        AS legacy_rows,",
  "       count(*) FILTER (WHERE rec_key IS NULL AND status <> 'active') AS legacy_moderated",
  "  FROM public.layover_recommendations;",
].join("\n");

/** Run AFTER 2411 to count the rows it could not key. Same shape, post-write. */
export const RESIDUAL_PREDICATE = [
  "-- rows 2411 left unkeyed (ambiguous derivation) and what they will lose at cutover:",
  "SELECT id, session_id, rec_type, title, status",
  "  FROM public.layover_recommendations",
  " WHERE rec_key IS NULL",
  " ORDER BY status <> 'active' DESC, session_id;",
  "-- duplicate keys that would abort the migration's own postcondition:",
  "SELECT session_id, rec_key, count(*)",
  "  FROM public.layover_recommendations",
  " WHERE rec_key IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;",
].join("\n");

/**
 * Unapplied migrations that touch the same objects as 2411, and why apply order
 * does not change 2411's outcome. A co-toucher NOT listed here fails condition
 * 5: the point of the rule is that nobody gets to decide "order does not matter"
 * silently.
 */
const CO_TOUCHER_CLASSIFICATION_DEFAULT: Record<string, string> = {
  // EMPTY, AND THAT IS A RESULT RATHER THAN AN OMISSION.
  //
  // This map held one entry — 2335_layover_recommendation_write_boundary,
  // classified ORDER-INSENSITIVE because it changes only RLS policies and role
  // GRANTs on layover_recommendations while 2411 writes a column, and neither
  // touches what the other reads.
  //
  // 2335 was APPLIED to production on 2026-09-08 (version 20260908104231), so it
  // is no longer an UNAPPLIED co-toucher and the entry stopped describing
  // anything. The checker said so itself — "STALE CLASSIFICATION: … is
  // classified as a co-toucher but no longer is. Strike the entry." — which is
  // the staleness rule doing its job on the day the apply landed, rather than
  // this list quietly accumulating decisions about migrations that are already
  // in the database.
  //
  // An empty map is a legitimate GO for ORDERING_COLLISION: the condition
  // records "no unapplied migration mutates an object 2411 touches" as evidence
  // rather than passing silently. It is NOT a licence to apply 2411 — that is
  // still blocked on NON_VACUITY, because the measurement says the backfill
  // would key 30 rows and preserve nothing.
};

/**
 * The classification map the run uses. LAYOVER_CUTOVER_COTOUCHERS overrides it
 * with a JSON object, in exactly the way LAYOVER_CUTOVER_MIGRATION_DIR overrides
 * the directory — a test seam, never set by CI or by a real run.
 *
 * WHY IT EXISTS. The staleness rule below (an entry naming a migration that is
 * no longer an unapplied co-toucher must be struck) is the rule that caught
 * 2335's apply on the day it landed. Its witness in the suite worked by deleting
 * 2335 from a mirrored migration directory — which stopped proving anything the
 * moment 2335 was applied and its entry struck, because the map went empty. The
 * rule would then have had no test at all, and a rule with no test is how the
 * last five comment-blindness bugs survived.
 *
 * The alternative was to keep a classification entry alive for the sake of the
 * test. That would be a false statement in guard data — the worse of the two.
 */
export const CO_TOUCHER_CLASSIFICATION: Record<string, string> = (() => {
  const override = process.env.LAYOVER_CUTOVER_COTOUCHERS;
  if (!override) return CO_TOUCHER_CLASSIFICATION_DEFAULT;
  const parsed = JSON.parse(override) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LAYOVER_CUTOVER_COTOUCHERS must be a JSON object of { migrationName: reason }");
  }
  return parsed as Record<string, string>;
})();

export type Verdict = "GO" | "NO_GO";

export type ConditionId =
  | "DEPENDENCY"
  | "NON_VACUITY"
  | "BACKFILL_COMPLETENESS"
  | "REVERSIBILITY"
  | "ORDERING_COLLISION"
  | "WRITER_READINESS"
  | "FLAG_POSTURE";

export interface ConditionResult {
  id: ConditionId;
  title: string;
  verdict: Verdict;
  blockers: string[];
  evidence: string[];
}

export interface ScanFloor {
  migrationFilesScanned: number;
  appliedMigrationsRecorded: number;
  snapshotTables: number;
  snapshotFlags: number;
  snapshotFunctions: number;
  objectsExtracted: number;
  statementsInMigration: number;
  srcFilesScanned: number;
}

/** A scan that saw less than this examined nothing worth reporting on. */
export const FLOOR_MINIMUMS: ScanFloor = {
  migrationFilesScanned: 300,
  appliedMigrationsRecorded: 10,
  snapshotTables: 200,
  snapshotFlags: 100,
  snapshotFunctions: 50,
  objectsExtracted: 8,
  statementsInMigration: 3,
  srcFilesScanned: 200,
};

export interface CutoverPaths {
  migrationDirs: string[];
  snapshotPath: string;
  appliedPath: string;
  rollbackDir: string;
  srcDir: string;
  measurementPath: string;
}

export interface CutoverReport {
  conditions: ConditionResult[];
  floor: ScanFloor;
  floorProblems: string[];
  fatal: string[];
  notes: string[];
}

// ── inputs ───────────────────────────────────────────────────────────────────

interface Snapshot {
  projectRef?: string;
  capturedAt?: string;
  productionMigrationWatermark?: string;
  tables: Record<string, string[]>;
  functions: string[];
  enums: string[];
  flags: Record<string, boolean>;
}

interface Measurement {
  measuredAt?: string;
  projectRef?: string;
  /** sha256 prefix of 2411's own rec_key CASE expression, at measurement time. */
  derivationChecksum?: string;
  /** The applied-migration watermark when the count was taken. */
  schemaWatermark?: string;
  /** The cutover flag's production value when the count was taken. */
  flagState?: Record<string, unknown>;
  /** 2410's column and unique index, as observed. */
  prerequisiteState?: { recKeyColumn?: unknown; uniqueIndex?: unknown };
  legacyRows?: number;
  legacyModerated?: number;
  ambiguousDerivations?: number;
  ambiguousModerated?: number;
  collidingDerivedKeys?: number;
}

function listSql(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(dir, f));
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "migrations" || e.startsWith(".")) continue;
      walkTs(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Every object created by each migration file, indexed by the file it came from. */
interface Corpus {
  files: string[];
  /** basename without .sql -> stripped sql */
  sqlByName: Map<string, string>;
  created: CreatedObjects;
  /** `rel:x` / `idx:x` / `col:t.c` / `fn:x` / `type:x` -> migration basename */
  source: Map<string, string>;
}

function buildCorpus(files: string[]): Corpus {
  const created = emptyCreated();
  const source = new Map<string, string>();
  const sqlByName = new Map<string, string>();
  for (const f of files) {
    const name = basename(f, ".sql");
    const sql = stripSqlComments(readFileSync(f, "utf8"));
    sqlByName.set(name, sql);
    const one = emptyCreated();
    collectCreatedObjects(sql, one);
    for (const t of one.tables) { created.tables.add(t); if (!source.has(`rel:${t}`)) source.set(`rel:${t}`, name); }
    for (const i of one.indexes) { created.indexes.add(i); if (!source.has(`idx:${i}`)) source.set(`idx:${i}`, name); }
    for (const fn of one.functions) { created.functions.add(fn); if (!source.has(`fn:${fn}`)) source.set(`fn:${fn}`, name); }
    for (const ty of one.types) { created.types.add(ty); if (!source.has(`type:${ty}`)) source.set(`type:${ty}`, name); }
    for (const [t, cols] of one.columns) {
      if (!created.columns.has(t)) created.columns.set(t, new Set());
      for (const c of cols) {
        created.columns.get(t)!.add(c);
        if (!source.has(`col:${t}.${c}`)) source.set(`col:${t}.${c}`, name);
      }
    }
  }
  return { files, sqlByName, created, source };
}

// ── the evaluation ───────────────────────────────────────────────────────────

export function evaluateCutover(paths: CutoverPaths): CutoverReport {
  const fatal: string[] = [];
  const notes: string[] = [];

  const allSql = paths.migrationDirs.flatMap(listSql);
  const migrationFile = allSql.find((f) => basename(f, ".sql") === MIGRATION_BASENAME);
  if (!migrationFile) {
    fatal.push(`${MIGRATION_BASENAME}.sql not found in ${paths.migrationDirs.join(", ")}`);
  }
  if (!existsSync(paths.snapshotPath)) fatal.push(`production snapshot missing: ${paths.snapshotPath}`);
  if (!existsSync(paths.appliedPath)) fatal.push(`applied-migrations record missing: ${paths.appliedPath}`);

  if (fatal.length > 0) {
    return { conditions: [], floor: zeroFloor(), floorProblems: [], fatal, notes };
  }

  const snapshot = JSON.parse(readFileSync(paths.snapshotPath, "utf8")) as Snapshot;
  const appliedRaw = JSON.parse(readFileSync(paths.appliedPath, "utf8")) as {
    migrations?: Array<{ version?: string; name?: string }>;
  };
  const appliedNames = new Set((appliedRaw.migrations ?? []).map((m) => String(m?.name ?? "")).filter(Boolean));

  const rawMigration = readFileSync(migrationFile!, "utf8");
  const migrationSql = stripSqlComments(rawMigration);

  const appliedFiles = allSql.filter((f) => appliedNames.has(basename(f, ".sql")));
  const appliedCorpus = buildCorpus(appliedFiles);
  const allCorpus = buildCorpus(allSql);

  const selfCreated = emptyCreated();
  collectCreatedObjects(migrationSql, selfCreated);

  const extraction = extractSqlObjects(migrationSql, allCorpus.created.functions);

  const srcFiles = walkTs(paths.srcDir);

  const conditions: ConditionResult[] = [
    conditionDependency(extraction, snapshot, selfCreated, appliedCorpus, notes),
    conditionNonVacuity(extraction, snapshot, selfCreated, paths.measurementPath, rawMigration),
    conditionBackfill(extraction, migrationSql, rawMigration, paths, snapshot),
    conditionReversibility(rawMigration, migrationSql, paths.rollbackDir),
    conditionOrdering(allSql, appliedNames, allCorpus, extraction, snapshot),
    conditionWriterReadiness(srcFiles, paths.srcDir, snapshot),
    conditionFlagPosture(snapshot, migrationSql, extraction, srcFiles, paths.srcDir),
  ];

  const floor: ScanFloor = {
    migrationFilesScanned: allSql.length,
    appliedMigrationsRecorded: appliedNames.size,
    snapshotTables: Object.keys(snapshot.tables ?? {}).length,
    snapshotFlags: Object.keys(snapshot.flags ?? {}).length,
    snapshotFunctions: (snapshot.functions ?? []).length,
    objectsExtracted: extraction.objects.length,
    statementsInMigration: extraction.statements.length,
    srcFilesScanned: srcFiles.length,
  };
  const floorProblems: string[] = [];
  for (const k of Object.keys(FLOOR_MINIMUMS) as Array<keyof ScanFloor>) {
    if (floor[k] < FLOOR_MINIMUMS[k]) {
      floorProblems.push(`VACUOUS SCAN: ${k} = ${floor[k]}, below the floor of ${FLOOR_MINIMUMS[k]}. A checker that examined nothing must not report a verdict.`);
    }
  }

  return { conditions, floor, floorProblems, fatal, notes };
}

function zeroFloor(): ScanFloor {
  return {
    migrationFilesScanned: 0, appliedMigrationsRecorded: 0, snapshotTables: 0, snapshotFlags: 0,
    snapshotFunctions: 0, objectsExtracted: 0, statementsInMigration: 0, srcFilesScanned: 0,
  };
}

// ── 1. DEPENDENCY ────────────────────────────────────────────────────────────

function conditionDependency(
  extraction: Extraction,
  snapshot: Snapshot,
  self: CreatedObjects,
  applied: Corpus,
  notes: string[],
): ConditionResult {
  const blockers: string[] = [];
  const evidence: string[] = [];
  const snapshotTables = snapshot.tables ?? {};
  const snapshotFns = new Set((snapshot.functions ?? []).map((f) => f.toLowerCase()));
  const snapshotEnums = new Set((snapshot.enums ?? []).map((f) => f.toLowerCase()));

  let resolved = 0;
  for (const rel of [...extraction.relations].sort()) {
    if (Object.prototype.hasOwnProperty.call(snapshotTables, rel)) {
      evidence.push(`relation ${rel} — in the production snapshot`);
      resolved += 1;
    } else if (self.tables.has(rel) || self.indexes.has(rel)) {
      evidence.push(`relation ${rel} — created by ${MIGRATION_BASENAME} itself`);
      resolved += 1;
    } else if (applied.created.tables.has(rel)) {
      evidence.push(`relation ${rel} — created by APPLIED ${applied.source.get(`rel:${rel}`)}`);
      resolved += 1;
    } else if (applied.created.indexes.has(rel)) {
      evidence.push(`index ${rel} — created by APPLIED ${applied.source.get(`idx:${rel}`)} (the snapshot records no indexes; this is the only offline proof available)`);
      resolved += 1;
    } else {
      blockers.push(
        `UNRESOLVED relation ${rel}: not in the production snapshot, not created by ${MIGRATION_BASENAME}, ` +
          `and not created by any migration recorded as applied.`,
      );
    }
  }

  for (const [table, cols] of [...extraction.columns.entries()].sort()) {
    for (const col of [...cols].sort()) {
      const inSnapshot = (snapshotTables[table] ?? []).includes(col);
      if (inSnapshot) { evidence.push(`column ${table}.${col} — in the production snapshot`); resolved += 1; continue; }
      if (self.columns.get(table)?.has(col)) { evidence.push(`column ${table}.${col} — added by ${MIGRATION_BASENAME} itself`); resolved += 1; continue; }
      if (applied.created.columns.get(table)?.has(col)) {
        evidence.push(`column ${table}.${col} — added by APPLIED ${applied.source.get(`col:${table}.${col}`)}`);
        resolved += 1;
        continue;
      }
      blockers.push(
        `UNRESOLVED column ${table}.${col}: absent from the production snapshot, not added by ${MIGRATION_BASENAME}, ` +
          `and not added by any migration recorded as applied.`,
      );
    }
  }

  for (const fn of [...extraction.calls].sort()) {
    if (snapshotFns.has(fn)) { evidence.push(`function ${fn}() — in the production snapshot`); resolved += 1; continue; }
    if (self.functions.has(fn)) { evidence.push(`function ${fn}() — created by ${MIGRATION_BASENAME} itself`); resolved += 1; continue; }
    if (applied.created.functions.has(fn)) {
      evidence.push(`function ${fn}() — created by APPLIED ${applied.source.get(`fn:${fn}`)}`);
      resolved += 1;
      continue;
    }
    blockers.push(`UNRESOLVED function ${fn}(): not in the snapshot and not created by an applied migration.`);
  }

  for (const cast of extraction.enumCasts) {
    if (!snapshotEnums.has(cast.type) && !self.types.has(cast.type) && !applied.created.types.has(cast.type)) continue; // a plain ::text cast
    evidence.push(`enum type ${cast.type} — present; label '${cast.label}' NOT verifiable (the snapshot records enum type names only, no labels)`);
    notes.push(`enum labels cannot be checked offline: snapshot.enums carries type names without labels.`);
  }

  if (resolved === 0) {
    blockers.push("VACUOUS: the migration resolved zero objects. Extraction is broken, not the migration.");
  }

  return {
    id: "DEPENDENCY",
    title: "Every object 2411 touches already exists, is created by 2411, or is created by an applied migration",
    verdict: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evidence: [`${resolved} object(s) resolved`, ...evidence],
  };
}

// ── 2. NON-VACUITY ───────────────────────────────────────────────────────────

function conditionNonVacuity(
  extraction: Extraction,
  snapshot: Snapshot,
  self: CreatedObjects,
  measurementPath: string,
  /**
   * The RAW migration text, not the comment-stripped copy: extractDerivation is
   * the same function emitLayoverCutoverSql.ts uses to build the query, and it
   * must see the same bytes, or the checksums would compare two different things.
   */
  rawMigrationSql: string,
): ConditionResult {
  const blockers: string[] = [];
  const evidence: string[] = [];
  const snapshotTables = snapshot.tables ?? {};

  if (extraction.mutatingStatements.length === 0) {
    blockers.push(`${MIGRATION_BASENAME} emits no mutating statement at all — it is a no-op by construction.`);
  } else {
    evidence.push(`${extraction.mutatingStatements.length} mutating statement(s) of ${extraction.statements.length} total`);
  }

  // Schema delta against the snapshot: what would actually be NEW?
  const newObjects: string[] = [];
  for (const t of self.tables) if (!Object.prototype.hasOwnProperty.call(snapshotTables, t)) newObjects.push(`table ${t}`);
  for (const [t, cols] of self.columns) {
    for (const c of cols) if (!(snapshotTables[t] ?? []).includes(c)) newObjects.push(`column ${t}.${c}`);
  }
  for (const i of self.indexes) newObjects.push(`index ${i}`);
  for (const f of self.functions) if (!(snapshot.functions ?? []).includes(f)) newObjects.push(`function ${f}()`);

  const declaresSchema = self.tables.size + self.columns.size + self.indexes.size + self.functions.size + self.types.size > 0;
  if (declaresSchema && newObjects.length === 0) {
    blockers.push(
      `SCHEMA NO-OP: every object ${MIGRATION_BASENAME} declares already exists in the production snapshot. ` +
        `Applying it would change no shape.`,
    );
  }
  evidence.push(
    declaresSchema
      ? `schema delta vs the snapshot: ${newObjects.length === 0 ? "none" : newObjects.join(", ")}`
      : `declares NO schema object: 2411 is a pure DATA migration (one UPDATE), so its effect is a ROW COUNT, ` +
        `which the snapshot does not carry.`,
  );

  // The row-count half. Not inferrable from any committed schema artifact.
  if (!existsSync(measurementPath)) {
    blockers.push(
      `EFFECT UNPROVEN: no cutover measurement at ${measurementPath}. 2411 changes rows, not shape, so whether it ` +
        `changes anything is operational data. The migration's header records a hand measurement, but a COMMENT IS ` +
        `NOT A MEASUREMENT — this checker will not accept prose as evidence. Run the predicate below against ` +
        `production and commit the result:\n${LEFTOVER_PREDICATE}`,
    );
  } else {
    let m: Measurement | null = null;
    try { m = JSON.parse(readFileSync(measurementPath, "utf8")) as Measurement; }
    catch (e) { blockers.push(`cutover measurement is not readable JSON: ${String(e)}`); }
    if (m) {
      evidence.push(`measurement ${measurementPath} measuredAt=${m.measuredAt} projectRef=${m.projectRef}`);
      if (m.projectRef && snapshot.projectRef && m.projectRef !== snapshot.projectRef) {
        blockers.push(`measurement projectRef ${m.projectRef} is not the snapshot's production project ${snapshot.projectRef}.`);
      }
      if (!m.measuredAt) {
        blockers.push("measurement carries no measuredAt; it cannot be aged.");
      } else if (snapshot.capturedAt && m.measuredAt < snapshot.capturedAt) {
        blockers.push(
          `STALE MEASUREMENT: measured ${m.measuredAt}, snapshot captured ${snapshot.capturedAt}. ` +
            `Production moved after the count was taken.`,
        );
      } else if (m.measuredAt) {
        // AGE. A count is evidence about the moment it was taken. Layover
        // recommendations are generated per session and swept, so a month-old
        // count describes a population that has turned over.
        const ageDays = Math.floor((Date.now() - Date.parse(`${m.measuredAt}T00:00:00Z`)) / 86_400_000);
        if (!Number.isFinite(ageDays)) {
          blockers.push(`measurement measuredAt "${m.measuredAt}" is not a parseable date.`);
        } else if (ageDays > MEASUREMENT_MAX_AGE_DAYS) {
          blockers.push(
            `STALE MEASUREMENT: taken ${ageDays} day(s) ago, past the ${MEASUREMENT_MAX_AGE_DAYS}-day threshold. ` +
              `Re-run measure:layover-cutover-sql against production and commit the result.`,
          );
        } else {
          evidence.push(`measurement is ${ageDays} day(s) old (threshold ${MEASUREMENT_MAX_AGE_DAYS})`);
        }
      }

      // DERIVATION DRIFT. Counts taken under one rec_key algorithm are not
      // evidence about another: if the CASE expression changed, every "ambiguous"
      // and "colliding" number was computed for a migration that no longer
      // exists. Lifted from 2411 itself, so the comparison cannot be fooled by a
      // retyped copy going out of date.
      const liveDerivation = extractDerivation(rawMigrationSql);
      if (!liveDerivation) {
        blockers.push("could not lift 2411's rec_key derivation, so the measurement's derivationChecksum cannot be verified.");
      } else if (!m.derivationChecksum) {
        blockers.push(
          "measurement carries no derivationChecksum. Without it a count taken under an older rec_key derivation " +
            "cannot be told from one taken under the current one.",
        );
      } else if (m.derivationChecksum !== derivationChecksum(liveDerivation)) {
        blockers.push(
          `STALE MEASUREMENT: derivationChecksum ${m.derivationChecksum} does not match 2411's current derivation ` +
            `(${derivationChecksum(liveDerivation)}). The algorithm changed after the count was taken, so the count is ` +
            `evidence about a migration that no longer exists.`,
        );
      } else {
        evidence.push(`derivationChecksum ${m.derivationChecksum} matches 2411's current rec_key derivation`);
      }

      // FLAG STATE. 2411 refuses to run once the cutover flag is TRUE, so a
      // measurement taken past the cutover describes a world the migration will
      // not run in.
      const measuredFlag = m.flagState?.[CUTOVER_FLAG];
      if (measuredFlag === undefined) {
        blockers.push(`measurement records no flagState for ${CUTOVER_FLAG}; the migration's own precondition depends on it.`);
      } else if (measuredFlag !== false) {
        blockers.push(
          `STALE MEASUREMENT: ${CUTOVER_FLAG} was ${String(measuredFlag)} when measured. 2411 raises unless it is ` +
            `FALSE, so this count describes a state the migration refuses to run in.`,
        );
      } else if (snapshot.flags && snapshot.flags[CUTOVER_FLAG] !== false) {
        blockers.push(
          `${CUTOVER_FLAG} is ${String(snapshot.flags[CUTOVER_FLAG])} in the committed snapshot but FALSE in the ` +
            `measurement. One of them is out of date.`,
        );
      } else {
        evidence.push(`${CUTOVER_FLAG} was FALSE when measured, matching the snapshot`);
      }

      // PREREQUISITE STATE. 2410's column and index must have existed, or the
      // count was taken against a shape the backfill cannot run on.
      const pre = m.prerequisiteState;
      if (!pre || pre.recKeyColumn !== true || pre.uniqueIndex !== true) {
        blockers.push(
          `measurement does not record BOTH 2410 prerequisites as present (recKeyColumn=${String(pre?.recKeyColumn)}, ` +
            `uniqueIndex=${String(pre?.uniqueIndex)}). A count taken before 2410 landed is not a count of what 2411 would do.`,
        );
      } else {
        evidence.push("measurement observed both 2410 prerequisites (rec_key column, unique index) present");
      }

      // SCHEMA WATERMARK. Recorded and compared where available; a migration
      // applied after the count is the same hazard the snapshot tripwire catches.
      if (m.schemaWatermark && snapshot.productionMigrationWatermark &&
          m.schemaWatermark < snapshot.productionMigrationWatermark) {
        blockers.push(
          `STALE MEASUREMENT: schemaWatermark ${m.schemaWatermark} is behind the snapshot's ` +
            `${snapshot.productionMigrationWatermark}; migrations landed after the count was taken.`,
        );
      }
      const legacyRows = m.legacyRows;
      const legacyModerated = m.legacyModerated;
      if (typeof legacyRows !== "number") {
        blockers.push("measurement carries no numeric legacyRows.");
      } else if (legacyRows === 0) {
        blockers.push(
          `VACUOUS: legacyRows = 0. Every row already carries a ${TARGET_COLUMN}, so the backfill would update ` +
            `nothing. A cutover step that changes no row must not report safe.`,
        );
      } else {
        evidence.push(`legacyRows = ${legacyRows} row(s) would receive a ${TARGET_COLUMN}`);
      }
      if (typeof legacyModerated !== "number") {
        blockers.push("measurement carries no numeric legacyModerated.");
      } else if (legacyModerated === 0) {
        blockers.push(
          `VACUOUS FOR ITS PURPOSE: legacyModerated = 0. 2411 exists to keep an admin's 'hidden'/'flagged' status ` +
            `alive across the cutover sweep; with zero moderated legacy rows it preserves nothing and changes no ` +
            `user-visible outcome. Applying it is not the cutover safety step it is documented to be.`,
        );
      } else {
        evidence.push(`legacyModerated = ${legacyModerated} moderated row(s) whose status the cutover would otherwise discard`);
      }
    }
  }

  return {
    id: "NON_VACUITY",
    title: "2411 actually changes something against the production shape as it stands today",
    verdict: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evidence,
  };
}

// ── 3. BACKFILL COMPLETENESS ─────────────────────────────────────────────────

function conditionBackfill(
  extraction: Extraction,
  migrationSql: string,
  rawMigration: string,
  paths: CutoverPaths,
  snapshot: Snapshot,
): ConditionResult {
  const blockers: string[] = [];
  const evidence: string[] = [];

  const writesTarget = extraction.columns.get(TARGET_TABLE)?.has(TARGET_COLUMN) ?? false;
  if (!writesTarget) {
    blockers.push(`2411 does not write ${TARGET_TABLE}.${TARGET_COLUMN}; the backfill this condition grades is absent.`);
  } else {
    evidence.push(`backfills ${TARGET_TABLE}.${TARGET_COLUMN}`);
  }

  // A NOT NULL added over an incomplete backfill is the classic abort.
  const masked = maskSqlLiterals(migrationSql);
  if (/ALTER\s+COLUMN\s+[a-z_]+\s+SET\s+NOT\s+NULL/i.test(masked)) {
    blockers.push(
      `2411 adds a NOT NULL constraint after backfilling. Any row it could not key would abort the migration ` +
        `mid-apply. Count them first:\n${LEFTOVER_PREDICATE}`,
    );
  } else {
    evidence.push(`adds no NOT NULL over ${TARGET_COLUMN}: an unkeyed row does not abort the apply`);
  }

  // Rows it cannot key unambiguously must be LEFT, not guessed.
  const backfill = extraction.statements.find((s) => isMutatingStatement(s) && /\bUPDATE\b/i.test(s)) ?? "";
  const guardsUniqueness = /count\s*\(\s*\*\s*\)/i.test(backfill) && /\b1\s*=\s*\(/.test(backfill);
  const guardsCollision = /NOT\s+EXISTS/i.test(backfill);
  if (!guardsUniqueness || !guardsCollision) {
    blockers.push(
      `AMBIGUOUS SOURCE UNGUARDED: the backfill does not restrict itself to rows whose derived key is unique in ` +
        `the session (uniqueness guard ${guardsUniqueness ? "present" : "MISSING"}) and unclaimed by an existing ` +
        `keyed row (collision guard ${guardsCollision ? "present" : "MISSING"}). Guessing which of two rows owns a ` +
        `key writes the wrong identity onto a moderated card.`,
    );
  } else {
    evidence.push("ambiguous derivations are left unkeyed rather than guessed (uniqueness + collision guards present)");
  }

  // Leftovers must be REPORTED by the migration, not discovered after the sweep.
  const reportsLeftovers = /rec_key\s+IS\s+NULL/i.test(masked) && /RAISE\s+(?:NOTICE|EXCEPTION|WARNING)/i.test(masked);
  if (!reportsLeftovers) {
    blockers.push("the migration never counts or reports the rows it left unkeyed; an operator would discover them after the cutover sweep.");
  } else {
    evidence.push("postcondition counts rows still NULL and raises, so leftovers are surfaced at apply time");
  }

  // The countable predicate must be written down where a reader will find it.
  // This asks about the PROSE, so the raw text is the correct place to look.
  const publishesPredicate = /SELECT[\s\S]{0,400}?rec_key\s+IS\s+NULL/i.test(rawMigration);
  if (!publishesPredicate) {
    blockers.push("the migration publishes no runnable predicate for counting leftover rows.");
  } else {
    evidence.push("a runnable count predicate is published in the migration header (asked of the prose deliberately)");
  }

  // The derivation must be the SERVICE's, or every key it writes is a key the
  // service will never generate — and the sweep deletes the row anyway.
  const parity = derivationParity(migrationSql, join(paths.srcDir, WRITER_FILE));
  evidence.push(...parity.evidence);
  blockers.push(...parity.blockers);

  evidence.push(`predicate for leftover rows:\n${RESIDUAL_PREDICATE}`);

  // If an operator HAS measured, the residual counts decide.
  if (existsSync(paths.measurementPath)) {
    try {
      const m = JSON.parse(readFileSync(paths.measurementPath, "utf8")) as Measurement;
      if (typeof m.collidingDerivedKeys === "number" && m.collidingDerivedKeys > 0) {
        blockers.push(
          `${m.collidingDerivedKeys} derived key(s) collide on (session_id, rec_key). 2411's own postcondition ` +
            `RAISEs on a duplicate, so the apply would abort and roll back.`,
        );
      }
      if (typeof m.ambiguousModerated === "number" && m.ambiguousModerated > 0) {
        blockers.push(
          `${m.ambiguousModerated} moderated row(s) derive an ambiguous key. 2411 leaves them NULL by design, and ` +
            `the cutover sweep then deletes them — their 'hidden'/'flagged' status is lost. That is the exact ` +
            `outcome 2411 exists to prevent, so it must be an owner decision, not a NOTICE.`,
        );
      }
      if (typeof m.ambiguousDerivations === "number") {
        evidence.push(`measured ambiguousDerivations = ${m.ambiguousDerivations}`);
      }
    } catch { /* condition 2 already reports an unreadable measurement */ }
  } else {
    evidence.push("no committed measurement: the residual row count is UNKNOWN (see NON_VACUITY)");
  }

  void snapshot;
  return {
    id: "BACKFILL_COMPLETENESS",
    title: "No row is left behind silently, and every key written is one the writer would itself generate",
    verdict: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evidence,
  };
}

/**
 * The SQL derivation and `LayoverRecommendationService.recommendationKey` must
 * agree branch for branch. If they diverge, the backfill writes keys the service
 * will never produce: at cutover the upsert misses them and the sweep deletes
 * the very rows the migration was written to protect.
 */
function derivationParity(migrationSql: string, writerPath: string): { blockers: string[]; evidence: string[] } {
  const blockers: string[] = [];
  const evidence: string[] = [];
  if (!existsSync(writerPath)) {
    return { blockers: [`writer ${writerPath} not found; derivation parity cannot be established.`], evidence };
  }
  const ts = stripComments(readFileSync(writerPath, "utf8"));
  const fnStart = ts.indexOf(`function ${KEY_FUNCTION}(`);
  if (fnStart === -1) {
    return { blockers: [`${KEY_FUNCTION} not found in ${writerPath} outside comments.`], evidence };
  }
  // The declaration runs to the next top-level one. Brace matching is wrong
  // here: `recommendationKey(c: { … }): string { … }` opens and closes a brace
  // in its own parameter list, so a naive matcher stops at the signature and
  // every content assertion below would then compare against an empty body —
  // silently passing or, worse, reporting a divergence that is its own bug.
  const after = ts.slice(fnStart + 1);
  const nextDecl = after.search(/\n(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s/);
  const fn = nextDecl === -1 ? after : after.slice(0, nextDecl);
  if (!/\breturn\b/.test(fn)) {
    return { blockers: [`${KEY_FUNCTION} body could not be isolated in ${writerPath}; parity is unverified.`], evidence };
  }

  const tsLimit = /\.slice\(\s*0\s*,\s*(\d+)\s*\)/.exec(fn)?.[1];
  const sqlLimits = [...migrationSql.matchAll(/left\s*\(\s*trim\s*\(\s*both\s*'-'[\s\S]*?,\s*(\d+)\s*\)/gi)].map((m) => m[1]);
  if (!tsLimit) blockers.push(`${KEY_FUNCTION} has no slug length limit; the SQL applies one.`);
  else if (sqlLimits.length === 0) blockers.push(`the SQL derivation applies no left(trim(...), N) slug limit; ${KEY_FUNCTION} slices to ${tsLimit}.`);
  else if (sqlLimits.some((n) => n !== tsLimit)) {
    blockers.push(`SLUG LENGTH DIVERGES: ${KEY_FUNCTION} slices to ${tsLimit}; the SQL uses ${[...new Set(sqlLimits)].join("/")}.`);
  } else {
    evidence.push(`slug length agrees: ${tsLimit} in both`);
  }

  const pairs: Array<[string, RegExp, RegExp]> = [
    ["place branch", /`place:\$\{/, /'place:'\s*\|\|/],
    ["inside branch", /`inside:\$\{/, /'inside:'\s*\|\|/],
    ["non-alphanumeric collapse", /\[\^a-z0-9\]\+/, /'\[\^a-z0-9\]\+'/],
    ["lowercasing", /toLowerCase\s*\(/, /\blower\s*\(/i],
    ["hyphen trim", /\(\^-\|-\$\)/, /trim\s*\(\s*both\s*'-'/i],
  ];
  for (const [what, tsRe, sqlRe] of pairs) {
    const inTs = tsRe.test(fn);
    const inSql = sqlRe.test(migrationSql);
    if (inTs !== inSql) {
      blockers.push(`DERIVATION DIVERGES on the ${what}: ${KEY_FUNCTION} ${inTs ? "has" : "lacks"} it, the SQL ${inSql ? "has" : "lacks"} it.`);
    }
  }

  const tsFields = ["placeId", "insideAirport", "recType", "title", "city"];
  const sqlFields = ["place_id", "inside_airport", "rec_type", "title", "city"];
  for (let i = 0; i < tsFields.length; i += 1) {
    const inTs = new RegExp(`\\b${tsFields[i]}\\b`).test(fn);
    const inSql = new RegExp(`\\b${sqlFields[i]}\\b`).test(migrationSql);
    if (inTs !== inSql) {
      blockers.push(`DERIVATION FIELD MISMATCH: ${KEY_FUNCTION} ${inTs ? "reads" : "ignores"} ${tsFields[i]}, the SQL ${inSql ? "reads" : "ignores"} ${sqlFields[i]}.`);
    }
  }
  if (blockers.length === 0) evidence.push(`derivation matches ${KEY_FUNCTION} branch for branch (place / inside / default, same slug rule and same fields)`);
  return { blockers, evidence };
}

// ── 4. REVERSIBILITY ─────────────────────────────────────────────────────────

function conditionReversibility(rawMigration: string, migrationSql: string, rollbackDir: string): ConditionResult {
  const blockers: string[] = [];
  const evidence: string[] = [];

  // "written down where a reader will find it" is a question about the prose.
  const named = /db\/rollback\/([A-Za-z0-9._-]+\.sql)/.exec(rawMigration)?.[1];
  if (!named) {
    blockers.push("2411 names no rollback file. A migration whose reverse is undocumented is one nobody can undo under pressure.");
    return { id: "REVERSIBILITY", title: "2411 has a written rollback that restores the prior shape, and any loss is declared", verdict: "NO_GO", blockers, evidence };
  }
  evidence.push(`rollback named in the header: db/rollback/${named}`);

  const rollbackPath = join(rollbackDir, named);
  if (!existsSync(rollbackPath)) {
    blockers.push(`the named rollback ${named} does not exist under ${rollbackDir}.`);
    return { id: "REVERSIBILITY", title: "2411 has a written rollback that restores the prior shape, and any loss is declared", verdict: "NO_GO", blockers, evidence };
  }

  const rawRollback = readFileSync(rollbackPath, "utf8");
  const rollbackSql = stripSqlComments(rawRollback);
  const rollbackMasked = maskSqlLiterals(rollbackSql);

  const reverses = new RegExp(`UPDATE[\\s\\S]{0,80}${TARGET_TABLE}[\\s\\S]{0,200}SET\\s+${TARGET_COLUMN}\\s*=\\s*NULL`, "i").test(rollbackMasked);
  if (!reverses) {
    blockers.push(`the rollback does not put ${TARGET_TABLE}.${TARGET_COLUMN} back to NULL; it does not reverse what 2411 wrote.`);
  } else {
    evidence.push(`reverses the write: UPDATE ${TARGET_TABLE} SET ${TARGET_COLUMN} = NULL`);
  }

  const guarded = rollbackSql.includes(CUTOVER_FLAG) && /RAISE\s+EXCEPTION/i.test(rollbackSql);
  if (!guarded) {
    blockers.push(
      `the rollback does not refuse to run while ${CUTOVER_FLAG} is TRUE. Past the cutover, nulling a live key ` +
        `makes the next regeneration sweep the row — losing its id and its moderation state.`,
    );
  } else {
    evidence.push(`refuses to run while ${CUTOVER_FLAG} is TRUE`);
  }

  // 2411 writes no provenance, so nothing on a row says "2411 wrote this key".
  const marksProvenance = /SET\s+[a-z_]*(?:backfill|migrated|provenance|source)[a-z_]*\s*=/i.test(maskSqlLiterals(migrationSql));
  const rollbackUpdate = splitSqlStatements(rollbackMasked).find((s) => /^UPDATE\b/i.test(s.trim())) ?? "";
  const predicateTerms = new Set(
    [...rollbackUpdate.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((w) => !["update", "public", "set", "where", "null", "not", "and", "or", "exists", "select", "from", "is"].includes(w)),
  );
  const discriminators = [...predicateTerms].filter(
    (t) => !["layover_recommendations", "layover_plan_stops", TARGET_COLUMN, "r", "s", "id", "recommendation_id", "1"].includes(t),
  );

  // Does the rollback CLAIM a narrowing it does not implement?
  const claimsServiceExclusion = /keyed by the SERVICE|refuses to touch/i.test(rawRollback);
  /**
   * A POSITIVE MARKER, not the absence of a phrase.
   *
   * The first version of this rule keyed only on the claim's wording, so the
   * correct fix — replacing a false scope claim with the loss it actually takes —
   * still tripped it, because an honest correction QUOTES the claim it is
   * disowning. Matching prose cannot tell "we do this" from "we used to say we
   * did this, and here is what we really do".
   *
   * So the rule now asks for something a file can only carry deliberately: an
   * explicit DECLARED LOSS. It must name the loss in the imperative — what gets
   * nulled, and whose — which is exactly what the migration gate means by "an
   * irreversible step is allowed, but must not be silent". The alternative
   * remains implementing the narrowing (a real discriminator, or provenance
   * written by the migration); either clears this.
   */
  const declaresLoss = /THIS REVERT NULLS[\s\S]{0,400}?whoever keyed it/i.test(rawRollback);
  if (claimsServiceExclusion && !declaresLoss && !marksProvenance && discriminators.length === 0) {
    blockers.push(
      `ROLLBACK SCOPE CLAIM IS NOT IMPLEMENTED. ${named} states it "refuses to touch a row that was keyed by the ` +
        `SERVICE rather than by 2411", and describes a narrowing to rows "whose session has no keyed row written ` +
        `after the backfill". Its UPDATE implements only ${TARGET_COLUMN} IS NOT NULL plus a ` +
        `layover_plan_stops NOT EXISTS; no term distinguishes a 2411-written key from a service-written one, and ` +
        `2411 writes no provenance column that would let one. So the rollback nulls service-written keys too. ` +
        `That is survivable today only because ${CUTOVER_FLAG} is FALSE and the service therefore writes no key — ` +
        `an accident of flag state, not the guarantee the file claims. A false statement about scope is worse ` +
        `than a declared loss: fix the SQL, or replace the claim with the loss it actually takes.`,
    );
  } else if (discriminators.length === 0 && !marksProvenance) {
    evidence.push(
      `LOSSY BUT DECLARED: 2411 writes no provenance, so the rollback cannot distinguish its own keys from ` +
        `service-written ones; it would null both. Allowed, because the file does not claim otherwise.`,
    );
  } else {
    evidence.push(`rollback scope narrows on: ${discriminators.join(", ") || "a provenance marker"}`);
  }

  evidence.push(
    `restores the prior shape: 2411 changes no schema, so "prior shape" is the column's NULL state, which the ` +
      `rollback restores for every row it touches.`,
  );

  return {
    id: "REVERSIBILITY",
    title: "2411 has a written rollback that restores the prior shape, and any loss is declared",
    verdict: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evidence,
  };
}

// ── 5. ORDERING / COLLISION ──────────────────────────────────────────────────

/** Is an object key (`rel:x` / `col:t.c` / `fn:x`) already in the snapshot? */
function objectInSnapshot(key: string, snapshot: Snapshot): boolean {
  const tables = snapshot.tables ?? {};
  if (key.startsWith("rel:")) return Object.prototype.hasOwnProperty.call(tables, key.slice(4));
  if (key.startsWith("fn:")) return (snapshot.functions ?? []).map((f) => f.toLowerCase()).includes(key.slice(3));
  if (key.startsWith("col:")) {
    const [t, c] = key.slice(4).split(".");
    return (tables[t!] ?? []).includes(c!);
  }
  return false;
}

function conditionOrdering(
  allSql: string[],
  appliedNames: Set<string>,
  corpus: Corpus,
  extraction: Extraction,
  snapshotForOrdering: Snapshot,
): ConditionResult {
  const blockers: string[] = [];
  const evidence: string[] = [];

  const samePrefix = allSql.filter((f) => basename(f).startsWith(`${MIGRATION_PREFIX}_`)).map((f) => basename(f));
  if (samePrefix.length !== 1) {
    blockers.push(`PREFIX COLLISION: ${samePrefix.length} migration(s) carry the prefix ${MIGRATION_PREFIX}: ${samePrefix.join(", ")}. Apply order is not derivable.`);
  } else {
    evidence.push(`prefix ${MIGRATION_PREFIX} is unique across ${allSql.length} migration file(s)`);
  }
  const band = validatePrefixBand(`${MIGRATION_BASENAME}.sql`);
  if (band) blockers.push(`PREFIX BAND: ${band.reason}`);
  else evidence.push(`prefix ${MIGRATION_PREFIX} is inside the canonical 2100-2999 band`);

  if (!appliedNames.has(PREDECESSOR_BASENAME)) {
    blockers.push(`PREDECESSOR NOT APPLIED: ${PREDECESSOR_BASENAME} is not in the applied record, and 2411's preconditions require its column and its unique index.`);
  } else {
    evidence.push(`predecessor ${PREDECESSOR_BASENAME} is recorded as applied`);
  }
  if (appliedNames.has(MIGRATION_BASENAME)) {
    blockers.push(`${MIGRATION_BASENAME} is ALREADY recorded as applied; there is no cutover left to grade.`);
  } else {
    evidence.push(`${MIGRATION_BASENAME} is not recorded as applied — this is a real decision`);
  }

  // Which other UNAPPLIED migrations mutate the same objects?
  const mine = new Set(extraction.relations);
  const coTouchers: string[] = [];
  const alreadyLanded: string[] = [];
  for (const f of allSql) {
    const name = basename(f, ".sql");
    if (name === MIGRATION_BASENAME) continue;
    if (appliedNames.has(name)) continue;
    const sql = corpus.sqlByName.get(name);
    if (!sql) continue;
    const masked = maskSqlLiterals(sql);
    let touches = false;
    for (const stmt of splitSqlStatements(masked)) {
      if (!isMutatingStatement(stmt)) continue;
      for (const rel of mine) {
        if (rel === "feature_flags") continue; // dozens of migrations seed flags; the row is what matters
        if (new RegExp(`\\b${rel}\\b`).test(stmt)) { touches = true; break; }
      }
      if (touches) break;
    }
    // The cutover flag ROW specifically: a migration that writes it changes 2411's own precondition.
    if (!touches && sql.includes(CUTOVER_FLAG) && /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) touches = true;
    if (!touches) continue;
    // The applied record is a STALENESS TRIPWIRE, NOT AN INVENTORY (see its own
    // $comment): production has no ledger, and anything applied by hand through
    // the Supabase dashboard leaves no row behind. "Absent from the record" is
    // therefore not "absent from production". A migration whose every created
    // object is already in the snapshot has plainly landed whatever the record
    // says — 0127_layover_system created layover_recommendations itself, and
    // counting it as a pending co-toucher would bury the ones that really are.
    const created = emptyCreated();
    collectCreatedObjects(sql, created);
    const declared: string[] = [
      ...[...created.tables].map((t) => `rel:${t}`),
      ...[...created.columns.entries()].flatMap(([t, cs]) => [...cs].map((c) => `col:${t}.${c}`)),
      ...[...created.functions].map((fn) => `fn:${fn}`),
    ];
    if (declared.length > 0 && declared.every((d) => objectInSnapshot(d, snapshotForOrdering))) {
      alreadyLanded.push(name);
      continue;
    }
    coTouchers.push(name);
  }

  for (const name of coTouchers.sort()) {
    const why = CO_TOUCHER_CLASSIFICATION[name];
    if (!why) {
      blockers.push(
        `UNCLASSIFIED CO-TOUCHER: unapplied migration ${name} mutates an object 2411 touches. Whether apply order ` +
          `matters has not been decided in writing — decide it in CO_TOUCHER_CLASSIFICATION rather than by ordering luck.`,
      );
    } else {
      evidence.push(`co-toucher ${name}: ${why}`);
    }
  }
  if (coTouchers.length === 0) evidence.push("no unapplied migration mutates an object 2411 touches");
  if (alreadyLanded.length > 0) {
    evidence.push(
      `co-toucher(s) absent from the applied RECORD but plainly landed — every object they create is already in ` +
        `the snapshot, so they are not pending: ${alreadyLanded.sort().join(", ")}`,
    );
  }

  // A stale classification is a lie in the other direction.
  for (const name of Object.keys(CO_TOUCHER_CLASSIFICATION)) {
    if (!coTouchers.includes(name)) {
      blockers.push(`STALE CLASSIFICATION: ${name} is classified as a co-toucher but no longer is (applied, deleted, or it stopped touching these objects). Strike the entry.`);
    }
  }

  return {
    id: "ORDERING_COLLISION",
    title: "No unapplied migration makes apply order matter, and 2411's prefix does not collide",
    verdict: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evidence,
  };
}

// ── 6. WRITER READINESS ──────────────────────────────────────────────────────

function conditionWriterReadiness(srcFiles: string[], srcDir: string, snapshot: Snapshot): ConditionResult {
  const blockers: string[] = [];
  const evidence: string[] = [];

  const isProduct = (p: string) => !p.includes(`${"/"}test${"/"}`) && !p.includes(`${"/"}scripts${"/"}`) && !p.includes("__tests__") && !p.endsWith(".test.ts");

  const payloadWriters: string[] = [];
  const flagReaders: string[] = [];
  const optionCarriers: string[] = [];
  for (const p of srcFiles) {
    if (!isProduct(p)) continue;
    let text: string;
    try { text = stripComments(readFileSync(p, "utf8")); } catch { continue; }
    const rel = p.slice(srcDir.length + 1);
    if (new RegExp(`\\b${TARGET_COLUMN}\\s*:`).test(text)) payloadWriters.push(rel);
    if (text.includes(CUTOVER_FLAG)) flagReaders.push(rel);
    // A file that DECLARES generateRecommendations is not a caller of it: the
    // writer naming its own option proves nothing about the flag reaching it.
    const declaresWriter = /function\s+generateRecommendations\s*\(/.test(text);
    if (!declaresWriter && /generateRecommendations\s*\(/.test(text) && /\bstableIds\b/.test(text)) optionCarriers.push(rel);
  }

  if (payloadWriters.length === 0) {
    blockers.push(
      `NO WRITER: nothing outside comments builds a payload carrying ${TARGET_COLUMN}. A schema-only cutover that ` +
        `no writer uses is not a shipped capability.`,
    );
  } else {
    evidence.push(`writes ${TARGET_COLUMN} into a payload: ${payloadWriters.join(", ")}`);
  }
  if (flagReaders.length === 0) {
    blockers.push(`NO READER: ${CUTOVER_FLAG} is named nowhere in product code outside comments, so nothing can turn the path on.`);
  } else {
    evidence.push(`reads ${CUTOVER_FLAG}: ${flagReaders.join(", ")}`);
  }
  if (optionCarriers.length === 0) {
    blockers.push("NOT WIRED: no product file both calls generateRecommendations() and passes stableIds, so the flag cannot reach the writer.");
  } else {
    evidence.push(`carries the option to the writer: ${optionCarriers.join(", ")}`);
  }

  const flagValue = (snapshot.flags ?? {})[CUTOVER_FLAG];
  evidence.push(
    flagValue === true
      ? `the writer is LIVE: ${CUTOVER_FLAG} is TRUE in production.`
      : `REPORTED, NOT COUNTED: the writer is present and wired but INERT — ${CUTOVER_FLAG} is ${flagValue === false ? "FALSE" : "absent"} ` +
        `in production, so the legacy delete+insert path runs and no traveller sees a card id. Applying 2411 ships ` +
        `no capability by itself; the capability is the flag flip, which is an owner decision.`,
  );

  return {
    id: "WRITER_READINESS",
    title: "The code that writes the column 2411 populates is present and reachable",
    verdict: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evidence,
  };
}

// ── 7. FLAG POSTURE ──────────────────────────────────────────────────────────

function conditionFlagPosture(
  snapshot: Snapshot,
  migrationSql: string,
  extraction: Extraction,
  srcFiles: string[],
  srcDir: string,
): ConditionResult {
  const blockers: string[] = [];
  const evidence: string[] = [];
  const flags = snapshot.flags ?? {};

  if (!Object.prototype.hasOwnProperty.call(flags, CUTOVER_FLAG)) {
    blockers.push(`${CUTOVER_FLAG} has no row in the production snapshot, so 2411's precondition query has nothing to read.`);
  } else {
    const value = flags[CUTOVER_FLAG];
    evidence.push(`production value of ${CUTOVER_FLAG}: ${value ? "TRUE" : "FALSE"} (snapshot ${snapshot.capturedAt ?? "undated"})`);
    if (value === true) {
      blockers.push(
        `${CUTOVER_FLAG} is already TRUE in production. 2411 REFUSES to run past the cutover — its own precondition ` +
          `RAISEs — because an UPDATE here would race an in-flight regeneration sweep.`,
      );
    }
  }

  // Fail-closed: the reader must return false when the state cannot be established.
  const readerPath = join(srcDir, FLAG_READER_FILE);
  if (!existsSync(readerPath)) {
    blockers.push(`flag reader ${FLAG_READER_FILE} not found; fail-closed posture cannot be established.`);
  } else {
    const src = stripComments(readFileSync(readerPath, "utf8"));
    const start = src.indexOf("export async function isFlagEnabled");
    const body = start === -1 ? "" : src.slice(start, src.indexOf("\n}", start) + 2);
    if (!body) {
      blockers.push("isFlagEnabled not found outside comments in the flag reader.");
    } else if (!/if\s*\(\s*error\s*\)\s*return\s+false/.test(body) || !/catch[\s\S]*?return\s+false/.test(body)) {
      blockers.push(
        `FAIL-OPEN READER: isFlagEnabled does not return false on both the error branch and the throw branch. ` +
          `A capability gate that survives an unreadable database is not a gate.`,
      );
    } else if (/return\s+true\b/.test(body)) {
      blockers.push("isFlagEnabled contains an unconditional `return true`; that is a kill-switch polarity, not a capability gate.");
    } else {
      evidence.push("read through isFlagEnabled, which returns false on error and on throw — fail-closed");
    }
    void srcFiles;
  }

  // 2411 must not itself move the flag.
  const writesFlags = extraction.statements.some(
    (s) => isMutatingStatement(s) && /\bfeature_flags\b/i.test(maskSqlLiterals(s)),
  );
  if (writesFlags) {
    blockers.push("2411 writes public.feature_flags. A backfill must not move the gate it is gated on.");
  } else {
    evidence.push("2411 reads feature_flags in its precondition and writes it nowhere — it flips no flag");
  }
  void migrationSql;

  return {
    id: "FLAG_POSTURE",
    title: "The gating flag's production value is known, fail-closed, and untouched by 2411",
    verdict: blockers.length === 0 ? "GO" : "NO_GO",
    blockers,
    evidence,
  };
}
