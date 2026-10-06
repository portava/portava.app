/**
 * beta-reference-snapshot.ts — READ the reference rows the structure-only
 * baseline lacks from portava-ci, and write them to a JSON file that
 * beta-bootstrap.ts imports into portava-beta.
 *
 * READ-ONLY, THREE WAYS OVER
 * ==========================
 *   * Every query is `SET TRANSACTION READ ONLY;` + ONE SELECT, and
 *     assertReadOnlySelect() refuses to send anything else — the database
 *     itself rejects a write inside a read-only transaction.
 *   * Only tables on the allowlist are named (REFERENCE_PUBLIC_TABLES +
 *     storage.buckets); assertAllowlisted() throws for any other.
 *   * The target is asserted by the strict front door (ciSupabaseGuard.mjs):
 *     SUPABASE_URL must resolve to CI_SUPABASE_PROJECT_REF and never to
 *     production.
 *
 * NO PERSONAL DATA
 * ================
 * The allowlist holds configuration and catalogue tables only. As a belt, every
 * column that the BASELINE declares as a foreign key to public.profiles or
 * auth.users — plus the listed actor columns that hold a user id without one
 * (ACTOR_COLUMNS_WITHOUT_FK) — is selected as NULL, so no user id leaves
 * portava-ci. feature_flags.enabled is selected as 'false' on every row: the
 * beta flag state is a separate, explicit owner-policy step, and fail-closed
 * until then.
 *
 * WHAT IS SELECTED
 * ================
 * Only the columns the baseline's CREATE TABLE declares (columns later
 * migrations added are the chain's business on beta), each cast to text, the
 * whole table returned as ONE json text value so nothing numeric is parsed by
 * JavaScript on the way through. A table over REFERENCE_ROW_CAP rows is
 * refused — it is not reference data.
 *
 * USAGE
 *   pnpm --dir scripts run db:beta-reference-snapshot --out <path>
 *
 * EXIT CODES
 *   0  snapshot written
 *   1  a query failed, a table is over the cap, or a column is missing on the source
 *   2  refused: target, token, or arguments
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_PROJECT_REF,
  REFERENCE_ROW_CAP,
  SNAPSHOT_FORMAT,
  argValue,
  baselineShapeProblems,
  buildReadingRoleSql,
  buildSnapshotCountSql,
  buildSnapshotSelectSql,
  buildSourceColumnCensusSql,
  loadBaselineModel,
  managementApi,
  planReferenceTables,
  resolveProjectRef,
  textField,
  validateSnapshot,
  type ReferenceSnapshot,
  type ReferenceTablePlan,
  type SnapshotTable,
} from "./beta-db-core.js";

const RUN_DIRECTLY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function refuse(message: string): never {
  console.error(`::error::beta-reference-snapshot REFUSED: ${message}`);
  process.exit(2);
}

function fail(message: string): never {
  console.error(`::error::beta-reference-snapshot FAILED: ${message}`);
  process.exit(1);
}

/** Baseline columns a source table lacks, per table. Pure. */
export function missingSourceColumns(
  plans: readonly ReferenceTablePlan[],
  live: ReadonlyArray<{ schema: string; table: string; column: string }>,
): string[] {
  const have = new Set(live.map((c) => `${c.schema}.${c.table}.${c.column}`));
  const missing: string[] = [];
  for (const p of plans) {
    for (const c of p.columns) {
      if (!have.has(`${p.schema}.${p.table}.${c}`)) missing.push(`${p.schema}.${p.table}.${c}`);
    }
  }
  return missing;
}

async function main(): Promise<never> {
  const out = argValue(process.argv.slice(2), "--out");
  if (!out) refuse("--out <path> is required.");

  const ref = resolveProjectRef(process.env.SUPABASE_URL);
  if (ref === null) refuse("SUPABASE_URL is not https://<ref>.supabase.co.");
  if (ref === PRODUCTION_PROJECT_REF) refuse("SUPABASE_URL names PRODUCTION. Never.");
  const token = process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) refuse("no Management API token (SUPABASE_PROJECT_TOKEN or SUPABASE_ACCESS_TOKEN).");

  const model = loadBaselineModel();
  const shape = baselineShapeProblems(model);
  if (shape.length > 0) refuse(`the baseline's measured shape changed:\n  ${shape.join("\n  ")}`);
  let plans: ReferenceTablePlan[];
  try {
    plans = planReferenceTables(model);
  } catch (err) {
    refuse((err as Error).message);
  }

  console.log(`beta-reference-snapshot: source ${ref} (read-only), ${plans.length} allowlisted table(s).`);
  const api = managementApi(ref, token);

  try {
    // 0. The reading role must see every row (storage.buckets is RLS-enabled).
    const [role] = await api.query(buildReadingRoleSql());
    const roleName = textField(role, "role_name");
    if (textField(role, "sees_all_rows") !== "true") {
      fail(
        `the Management API reads as ${roleName}, which is neither superuser nor BYPASSRLS, so RLS on ` +
          "storage.buckets could hide rows and the snapshot would be silently short.",
      );
    }
    console.log(`  reading as ${roleName} (sees every row).`);

    // 1. Every baseline column must exist on the source.
    const live = (await api.query(buildSourceColumnCensusSql(plans))).map((r) => ({
      schema: textField(r, "schema_name"),
      table: textField(r, "table_name"),
      column: textField(r, "column_name"),
    }));
    const missing = missingSourceColumns(plans, live);
    if (missing.length > 0) {
      fail(`the source lacks column(s) the baseline declares: ${missing.join(", ")}`);
    }

    // 2. Row counts, all of them, before any row is read.
    const counts = new Map<string, number>();
    for (const p of plans) {
      const [row] = await api.query(buildSnapshotCountSql(p));
      counts.set(`${p.schema}.${p.table}`, Number(textField(row, "n")));
    }
    const over = [...counts].filter(([, n]) => n > REFERENCE_ROW_CAP);
    for (const [t, n] of counts) console.log(`  ${t.padEnd(34)} ${String(n).padStart(6)} row(s)`);
    if (over.length > 0) {
      fail(`over the ${REFERENCE_ROW_CAP}-row cap, so not reference data: ${over.map(([t, n]) => `${t}=${n}`).join(", ")}`);
    }

    // 3. The rows.
    const tables: SnapshotTable[] = [];
    for (const p of plans) {
      const [row] = await api.query(buildSnapshotSelectSql(p));
      const parsed: unknown = JSON.parse(textField(row, "rows_json"));
      if (!Array.isArray(parsed)) fail(`${p.schema}.${p.table}: the rows did not come back as a JSON array`);
      tables.push({ ...p, rowCount: parsed.length, rows: parsed });
    }

    const snapshot: ReferenceSnapshot = {
      format: SNAPSHOT_FORMAT,
      takenAt: new Date().toISOString(),
      sourceProjectRef: ref,
      baselineSha256: model.sha256,
      rowCap: REFERENCE_ROW_CAP,
      tables,
    };
    // The bootstrap's validator, run here too: a snapshot this script writes
    // is one the bootstrap will accept, or nothing is written.
    validateSnapshot(JSON.parse(JSON.stringify(snapshot)), plans, model.sha256);
    for (const t of tables) {
      const counted = counts.get(`${t.schema}.${t.table}`);
      if (counted !== t.rowCount) {
        fail(`${t.schema}.${t.table}: counted ${counted} row(s) but read ${t.rowCount}; the source changed mid-snapshot.`);
      }
    }

    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`\nbeta-reference-snapshot PASSED — ${tables.reduce((n, t) => n + t.rowCount, 0)} row(s) written to ${resolve(out)}.`);
    for (const t of tables) {
      const nulled = Object.keys(t.nulledColumns);
      const forced = Object.entries(t.forcedValues).map(([c, v]) => `${c}=${v}`);
      if (nulled.length || forced.length) {
        console.log(`  ${t.schema}.${t.table}:${nulled.length ? ` nulled ${nulled.join(", ")}` : ""}${forced.length ? ` forced ${forced.join(", ")}` : ""}`);
      }
    }
    process.exit(0);
  } catch (err) {
    fail((err as Error).message);
  }
}

if (RUN_DIRECTLY) {
  // THE TARGET GUARD, first, before any client or query.
  await import("../../artifacts/api-server/src/lib/ciSupabaseGuard.mjs");
  await main();
}
