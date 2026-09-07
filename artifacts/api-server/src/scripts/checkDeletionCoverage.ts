/**
 * check:deletion-coverage — every user-keyed table has a stated deletion fate.
 *
 * Plain Node + the committed schema. No database, no network, no credentials:
 * it reads baseline/20260819_baseline_structure.sql AND src/migrations/*.sql,
 * finds every table carrying a user-identifying column, and asserts each appears
 * in exactly one bucket of src/lib/deletionDispositions.ts.
 *
 * WHAT IT ENFORCES: that a NEW user-keyed table cannot be added without someone
 * writing down what happens to it when a user deletes their account.
 *
 * WHY IT READS THE MIGRATIONS TOO — the defect this file used to have.
 * The baseline is a SNAPSHOT, not the schema. Every table created by a migration
 * after 2026-08-19 was invisible to the derivation, and was covered only if a
 * human remembered to hand-add it to POST_BASELINE_TABLES. Nobody checked that
 * they had. Migration 2311 proved it: `intel_claim_reviews` carries
 * `reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE` on a
 * table whose own COMMENT says it holds "reviewer identity and free-text
 * moderation reasons" — user-keyed, post-baseline, in no bucket, and the guard
 * was green. Twelve pre-existing post-baseline tables were hiding in the same
 * gap. A guard that reads a snapshot reports confidently about a world that has
 * moved; this one now reads both and says which source each table came from.
 *
 * TWO SOURCES, TWO SIGNALS — deliberately, not by accident:
 *   * the baseline is a schema-only pg_dump, and pg_dump emits foreign keys as
 *     separate ALTER TABLE ... ADD CONSTRAINT statements. Its CREATE TABLE
 *     blocks carry no REFERENCES at all, so a COLUMN NAME is the only signal
 *     available there. Unchanged.
 *   * migration DDL declares the reference inline, which is a strictly stronger
 *     signal — it is how `reviewer_id`, a name no list anticipated, is caught.
 * Each source is read with the strongest signal it actually carries, and the
 * baseline stays authoritative for every table it contains.
 *
 * WHAT IT DOES NOT ENFORCE — stated rather than implied:
 *   * that UNCLASSIFIED_BACKLOG entries are safe. They are not. Being on that
 *     list means the data survives deletion and nobody has decided whether it
 *     should. The count is printed on every run so the debt stays visible. The
 *     same is true of POST_BASELINE_UNTRIAGED, which is that list's closed
 *     post-baseline twin.
 *   * that ERASED_BY_CASCADE entries are actually erased. This checks the
 *     manifest against the schema, not against the service's behaviour.
 *   * a user-identifying column added to an existing table by a later
 *     ALTER TABLE ... ADD COLUMN. Only CREATE TABLE is parsed. That hole is
 *     strictly smaller than the one this file closes, and it is written down
 *     here rather than left to be discovered.
 *   * tables that exist on production but whose migrations are not in git (the
 *     journey_* family). Those still need a POST_BASELINE_TABLES entry.
 *
 * Exit 0 only if every user-keyed table in baseline + migrations is classified
 * exactly once.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_PATH } from "./parseBaselineSchema.js";
import {
  ERASED_BY_CASCADE,
  ANONYMISED_FK_NULLED,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  UNCLASSIFIED_BACKLOG,
  POST_BASELINE_UNTRIAGED,
  UNTRIAGED_HIGH_WATER,
  POST_BASELINE_TABLES,
  USER_IDENTIFYING_COLUMNS,
} from "../lib/deletionDispositions.js";

const __dir = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(__dir, "../migrations");

/**
 * The band holds hundreds of files. A read that returns fewer than this is
 * broken, not empty — see loadMigrations().
 */
export const MIN_PLAUSIBLE_MIGRATIONS = 100;

/** The date the committed baseline was captured, as a YYYYMMDD number. */
export const BASELINE_CAPTURE_DATE = 20260819;

/** First 4-digit prefix of the post-cutover canonical band (migrationPrefixRules). */
export const NEW_PREFIX_BAND_MIN = 2100;

export interface MigrationFile { name: string; sql: string }

/** Tables in the baseline carrying at least one user-identifying column. */
export function userKeyedTablesFromBaseline(sql: string): Map<string, string[]> {
  const userCols = new Set(USER_IDENTIFYING_COLUMNS);
  const out = new Map<string, string[]>();
  const blocks = sql.matchAll(/^CREATE TABLE public\.([A-Za-z0-9_]+) \(([\s\S]*?)^\);/gm);
  for (const m of blocks) {
    const [, name, body] = m;
    const cols = new Set<string>();
    for (const c of body.matchAll(/^\s+([a-z_][a-z0-9_]*)\s+/gm)) cols.add(c[1]);
    const hit = [...cols].filter((c) => userCols.has(c)).sort();
    if (hit.length > 0) out.set(name, hit);
  }
  return out;
}

/** Every `public` table name the baseline declares, user-keyed or not. */
export function tableNamesFromBaseline(sql: string): Set<string> {
  return new Set([...sql.matchAll(/^CREATE TABLE public\.([A-Za-z0-9_]+)/gm)].map((m) => m[1]));
}

/**
 * Blank out SQL comments so a rollback note cannot be read as DDL.
 *
 * Load-bearing, not tidiness: several migrations end with a commented-out
 * `-- DROP TABLE IF EXISTS public.<name>;` rollback recipe. Parsed naively,
 * 2308 would look like it created wall_telemetry_events and then dropped it,
 * and the table would vanish from the guard's subject set — a blind spot
 * introduced by the fix for a blind spot.
 *
 * String and dollar-quoted literals are preserved verbatim, so a `--` inside a
 * function body or a text default is not mistaken for a comment.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      if (nl < 0) { out += " "; break; }
      out += " ";
      i = nl;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") { depth++; j += 2; continue; }
        if (sql.slice(j, j + 2) === "*/") { depth--; j += 2; continue; }
        j++;
      }
      out += " ";
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i, i + 64));
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close < 0 ? sql.length : close + tag.length;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * Was this migration authored AFTER the baseline was captured?
 *
 * The baseline is the schema as of 2026-08-19. A migration that precedes it can
 * contribute nothing the baseline does not already know: if its CREATE TABLE is
 * missing from the snapshot, the table was dropped, renamed or never applied.
 * 0050_rent_a_buddy.sql is the live example — it declares `buddy_profiles`,
 * production has `rent_buddy_profiles`, and reading 0050 as current would invent
 * nine tables that do not exist and demand a deletion fate for each.
 *
 * The two filename conventions are compared structurally rather than
 * lexically, for the reason migrationPrefixRules.ts documents: "20260819_..."
 * sorts BELOW "2100" under a plain string comparison.
 */
export function migrationPostDatesBaseline(filename: string): boolean {
  const m = /^(\d+)_/.exec(filename);
  if (!m) return true; // no numeric prefix: unplaceable, so scan it rather than skip it
  const digits = m[1];
  if (digits.length === 8) return Number(digits) >= BASELINE_CAPTURE_DATE;
  if (digits.length === 4) return Number(digits) >= NEW_PREFIX_BAND_MIN;
  return true;
}

/** The 4-digit/8-digit numeric prefix of a migration filename, or null. */
export function migrationPrefix(filename: string): number | null {
  const m = /^(\d+)_/.exec(filename);
  return m ? Number(m[1]) : null;
}

interface CreateEvent { pos: number; kind: "create"; name: string; cols: string[] }
interface DropEvent { pos: number; kind: "drop"; name: string }

const NON_COLUMN_KEYWORDS = new Set([
  "primary", "unique", "constraint", "foreign", "check", "exclude", "like",
]);

/** A column definition whose inline FK points at the user identity tables. */
const USER_REFERENCE_RE = /\breferences\s+(?:auth\.users|public\.profiles|profiles)\b/i;

/** `[CONSTRAINT x] FOREIGN KEY (col) REFERENCES auth.users|profiles` */
const TABLE_LEVEL_FK_RE =
  /\bforeign\s+key\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s*references\s+(?:auth\.users|public\.profiles|profiles)\b/i;

/** Split a CREATE TABLE body on its top-level commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * The user-identifying columns one CREATE TABLE body declares — by NAME (the
 * manifest's own list) or by inline REFERENCE to auth.users / public.profiles.
 */
export function userColumnsInCreateBody(body: string): string[] {
  const userCols = new Set(USER_IDENTIFYING_COLUMNS);
  const hits = new Set<string>();
  for (const part of splitTopLevel(body)) {
    const t = part.trim();
    const fk = TABLE_LEVEL_FK_RE.exec(t);
    if (fk) { hits.add(fk[1].toLowerCase()); continue; }
    const named = /^"?([a-z_][a-z0-9_]*)"?\s+/i.exec(t);
    if (!named) continue;
    const col = named[1].toLowerCase();
    if (NON_COLUMN_KEYWORDS.has(col)) continue;
    if (userCols.has(col) || USER_REFERENCE_RE.test(t)) hits.add(col);
  }
  return [...hits].sort();
}

/**
 * User-keyed tables the MIGRATIONS declare that the baseline cannot see.
 *
 * Parsed in filename order, so a table created and later dropped is not
 * outstanding, and a re-CREATE after a DROP is. Tables already present in the
 * baseline are excluded: the snapshot is the authority for those, and reading a
 * five-migration-old CREATE TABLE for a table that has since been ALTERed would
 * be a second stale source rather than a fix for the first.
 */
export function userKeyedTablesFromMigrations(
  migrations: readonly MigrationFile[],
  baselineTables: ReadonlySet<string>,
): Map<string, { columns: string[]; migration: string }> {
  const live = new Map<string, { columns: string[]; migration: string }>();
  const ordered = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const file of ordered) {
    const sql = stripSqlComments(file.sql);
    const events: Array<CreateEvent | DropEvent> = [];

    // Only a post-baseline migration can introduce a table the snapshot lacks.
    // DROPs are honoured from every file, so a post-baseline create that a later
    // migration removes does not linger.
    if (migrationPostDatesBaseline(file.name)) {
      const re = /create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([A-Za-z0-9_]+)"?\s*\(/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let end = -1;
        for (let i = open; i < sql.length; i++) {
          if (sql[i] === "(") depth++;
          else if (sql[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue; // unbalanced: not a statement this parser can rule on
        events.push({
          pos: m.index,
          kind: "create",
          name: m[1],
          cols: userColumnsInCreateBody(sql.slice(open + 1, end)),
        });
      }
    }
    for (const d of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([A-Za-z0-9_]+)"?/gi)) {
      events.push({ pos: d.index ?? 0, kind: "drop", name: d[1] });
    }

    events.sort((a, b) => a.pos - b.pos);
    for (const e of events) {
      if (e.kind === "drop") { live.delete(e.name); continue; }
      if (e.cols.length > 0) live.set(e.name, { columns: e.cols, migration: file.name });
      else live.delete(e.name);
    }
  }

  for (const name of live.keys()) if (baselineTables.has(name)) live.delete(name);
  return live;
}

export interface CoverageProblem { kind: string; table: string; detail: string }

export function computeProblems(tables: Map<string, string[]>): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const erased = new Set(ERASED_BY_CASCADE);
  const nulled = new Set(ANONYMISED_FK_NULLED);
  const flow = new Set(DELETION_FLOW_TABLES);
  const retained = new Set(RETAINED_WITH_REASON.map((r) => r.table));
  const backlog = new Set(UNCLASSIFIED_BACKLOG);
  const untriaged = new Set(POST_BASELINE_UNTRIAGED.map((u) => u.table));

  for (const [t] of tables) {
    const buckets = [
      erased.has(t) && "ERASED_BY_CASCADE",
      nulled.has(t) && "ANONYMISED_FK_NULLED",
      flow.has(t) && "DELETION_FLOW_TABLES",
      retained.has(t) && "RETAINED_WITH_REASON",
      backlog.has(t) && "UNCLASSIFIED_BACKLOG",
      untriaged.has(t) && "POST_BASELINE_UNTRIAGED",
    ].filter(Boolean) as string[];

    if (buckets.length === 0) {
      problems.push({
        kind: "UNCLASSIFIED NEW TABLE",
        table: t,
        detail:
          `carries a user-identifying column but appears in no bucket of deletionDispositions.ts. ` +
          `Decide what happens to it on account deletion: add it to ERASED_BY_CASCADE (and clear it in ` +
          `AccountDeletionService), or to RETAINED_WITH_REASON with a reason a user could be shown. ` +
          `Do NOT add it to UNCLASSIFIED_BACKLOG — that list is a dated record of pre-existing debt, not a place to put new tables. ` +
          `POST_BASELINE_UNTRIAGED is closed and will reject it too.`,
      });
    } else if (buckets.length > 1) {
      problems.push({ kind: "DOUBLE-CLASSIFIED", table: t, detail: `appears in ${buckets.join(" and ")}` });
    }
  }

  // Stale entries keep the manifest honest over time.
  for (const list of [
    { name: "ERASED_BY_CASCADE", items: ERASED_BY_CASCADE },
    { name: "ANONYMISED_FK_NULLED", items: ANONYMISED_FK_NULLED },
    { name: "DELETION_FLOW_TABLES", items: DELETION_FLOW_TABLES },
    { name: "UNCLASSIFIED_BACKLOG", items: UNCLASSIFIED_BACKLOG },
    { name: "POST_BASELINE_UNTRIAGED", items: POST_BASELINE_UNTRIAGED.map((u) => u.table) },
  ]) {
    const postBaseline = new Set(POST_BASELINE_TABLES);
    for (const t of list.items) {
      // POST_BASELINE_TABLES now means only "classified, and declared somewhere
      // this repo cannot read" — production tables whose migrations are not in
      // git, and tables declared on a branch that has not merged yet.
      if (!tables.has(t) && !postBaseline.has(t)) {
        problems.push({
          kind: "STALE ENTRY",
          table: t,
          detail: `listed in ${list.name} but is not a user-keyed table in the schema. Remove it.`,
        });
      }
    }
  }
  for (const r of RETAINED_WITH_REASON) {
    if (!r.reason || r.reason.trim() === "") {
      problems.push({ kind: "EMPTY REASON", table: r.table, detail: "RETAINED_WITH_REASON needs a written reason." });
    }
  }
  return problems;
}

/**
 * POST_BASELINE_UNTRIAGED is a CLOSED list, and this is what closes it.
 *
 * UNCLASSIFIED_BACKLOG is open-ended, which is exactly why the manifest warns
 * that it must never become a hiding place for a new table. Its post-baseline
 * twin cannot be one: every entry names the migration that declared it, that
 * migration must be the one the parser actually found, and its prefix must sit
 * at or below the high-water mark recorded when the list was written. A table
 * declared by a later migration — 2311's intel_claim_reviews, or anything
 * authored tomorrow — is refused here and has to be classified for real.
 */
export function untriagedParkingProblems(
  parked: ReadonlyArray<{ table: string; migration: string }>,
  declaredBy: ReadonlyMap<string, string>,
  highWater: number,
): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  for (const entry of parked) {
    const prefix = migrationPrefix(entry.migration);
    if (prefix === null || prefix > highWater) {
      problems.push({
        kind: "PARKED ABOVE THE HIGH-WATER MARK",
        table: entry.table,
        detail:
          `POST_BASELINE_UNTRIAGED is closed at migration ${highWater}; ${entry.migration} is above it. ` +
          `This list records pre-existing untriaged debt and is not a place to park a new table — ` +
          `classify it in ERASED_BY_CASCADE, ANONYMISED_FK_NULLED or RETAINED_WITH_REASON instead.`,
      });
      continue;
    }
    const actual = declaredBy.get(entry.table);
    if (actual === undefined) continue; // STALE ENTRY already covers this
    if (actual !== entry.migration) {
      problems.push({
        kind: "WRONG DECLARING MIGRATION",
        table: entry.table,
        detail: `POST_BASELINE_UNTRIAGED says ${entry.migration}, but ${actual} is what declares it.`,
      });
    }
  }
  return problems;
}

export interface Evaluation {
  tables: Map<string, string[]>;
  fromMigrations: Map<string, { columns: string[]; migration: string }>;
  problems: CoverageProblem[];
}

/**
 * The guard's whole decision, extracted so a test can drive it.
 *
 * It lives here rather than inline in main() because this function is where the
 * baseline and the migrations are COMBINED, and a unit test of either parser
 * cannot see a guard that never calls one of them. That is precisely how the
 * snapshot-only read survived: `userKeyedTablesFromBaseline` was correct, well
 * tested, and answering a question about 2026-08-19.
 */
export function evaluate(baselineSql: string, migrations: readonly MigrationFile[]): Evaluation {
  const baselineTables = userKeyedTablesFromBaseline(baselineSql);
  const fromMigrations = userKeyedTablesFromMigrations(migrations, tableNamesFromBaseline(baselineSql));

  const tables = new Map(baselineTables);
  for (const [name, info] of fromMigrations) tables.set(name, info.columns);

  const declaredBy = new Map([...fromMigrations].map(([name, info]) => [name, info.migration]));
  const problems = [
    ...computeProblems(tables),
    ...untriagedParkingProblems(POST_BASELINE_UNTRIAGED, declaredBy, UNTRIAGED_HIGH_WATER),
  ];
  return { tables, fromMigrations, problems };
}

/** Thrown when the migrations directory read is implausible. See loadMigrations. */
export class VacuousMigrationReadError extends Error {}

/**
 * Read src/migrations, and REFUSE if the read looks broken.
 *
 * An empty or truncated read would silently restore snapshot-only behaviour:
 * the guard would still run, still print a total, and still pass — on a subject
 * set missing every post-baseline table. That is the defect this change exists
 * to remove, wearing a hat. A directory this guard cannot read is not a
 * directory with no migrations in it.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  } catch (err) {
    throw new VacuousMigrationReadError(
      `check-deletion-coverage: cannot read ${dir} (${(err as Error).message}). ` +
      "This read is broken, not empty. Refusing to evaluate deletion coverage against the baseline alone.",
    );
  }
  if (files.length < MIN_PLAUSIBLE_MIGRATIONS) {
    throw new VacuousMigrationReadError(
      `check-deletion-coverage: found only ${files.length} migration file(s) in ${dir}. ` +
      `The chain holds hundreds; this read is broken, not empty. ` +
      "Refusing to evaluate deletion coverage against the baseline alone.",
    );
  }
  return files.sort().map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

function main(): void {
  let migrations: MigrationFile[];
  try {
    migrations = loadMigrations();
  } catch (err) {
    if (err instanceof VacuousMigrationReadError) {
      console.error(`✖ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const { tables, fromMigrations, problems } = evaluate(readFileSync(BASELINE_PATH, "utf8"), migrations);
  if (tables.size === 0) {
    console.error("✖ check-deletion-coverage: zero user-keyed tables parsed — the scan has no subject.");
    process.exit(1);
  }

  console.log(
    `\ncheck-deletion-coverage: ${tables.size} user-keyed table(s) in the schema ` +
      `(${tables.size - fromMigrations.size} from the baseline, ${fromMigrations.size} from ${migrations.length} migrations)\n` +
      `   ${ERASED_BY_CASCADE.length} erased by the cascade\n` +
      `   ${ANONYMISED_FK_NULLED.length} anonymised in place (FK identifier NULLed, row kept)\n` +
      `   ${DELETION_FLOW_TABLES.length} deletion-flow tables (not user content)\n` +
      `   ${RETAINED_WITH_REASON.length} retained with a written reason\n` +
      `   ${UNCLASSIFIED_BACKLOG.length} UNCLASSIFIED — survive deletion, undecided (owner decision D6)\n` +
      `   ${POST_BASELINE_UNTRIAGED.length} POST-BASELINE UNTRIAGED — survive deletion, undecided, closed at migration ${UNTRIAGED_HIGH_WATER}\n`,
  );

  if (problems.length > 0) {
    console.error(`✖ check-deletion-coverage FAILED — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  • ${p.kind}: "${p.table}" ${p.detail}`);
    process.exit(1);
  }
  console.log("✓ every user-keyed table in the baseline and the migrations has a stated deletion fate.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
