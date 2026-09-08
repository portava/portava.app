/**
 * The dry run: what a deletion WOULD do to one user id, table by table, with
 * row counts, writing nothing.
 *
 * ── THE FAILURE MODE THIS IS BUILT AGAINST ──────────────────────────────────
 * supabase-js RESOLVES on a database error. `const { data, count } = await
 * sc.from(t).select("*", { count: "exact", head: true })` hands back
 * `{ data: null, count: null, error: {...} }` when the read FAILED, which is
 * one `count ?? 0` away from a dry run that cheerfully reports "nothing to
 * delete" for a table it could not read. That is the same permissive-zero this
 * repo has been pulling out of every other read path.
 *
 * So this module never coerces. A read is one of exactly three things:
 *   * a number      — the count came back;
 *   * UNREADABLE    — `error` was set, or `count` came back null/undefined with
 *                     no error at all (a client that answers neither is not
 *                     answering "zero");
 * and an unreadable table makes the whole report `ok: false`. A dry run that
 * cannot see a table cannot tell you what deleting it would do.
 *
 * It also refuses to be vacuous: a plan with no actions, or a report where
 * every single table was unreadable, is a failure and says so, because "0 rows
 * everywhere" is exactly what a broken client produces.
 *
 * NOTHING IS WRITTEN. The only verbs used here are `.select(..., { head: true })`
 * reads. There is no mutation path in this file to disable.
 */
import type { DeletionPlan, PlannedAction } from "./DeletionPlanner.js";

export interface ColumnCount {
  column: string;
  role: string;
  /** null when the read did not produce a count. Never coerced to 0. */
  rows: number | null;
  unreadable: boolean;
  error?: string;
}

export interface DryRunTableResult {
  table: string;
  fate: PlannedAction["fate"];
  mechanism: PlannedAction["mechanism"];
  counts: ColumnCount[];
  /**
   * Sum of the readable per-column counts. A row naming the user in two
   * columns is counted twice — this is a count of MATCHES, not of distinct
   * rows, and calling it anything else would overstate what was measured.
   */
  rowMatches: number;
  unreadable: boolean;
  notes: string[];
}

export interface DryRunReport {
  ok: boolean;
  userId: string;
  policyVersion: string;
  generatedAt: string;
  /** Always true: this module has no write path. */
  wroteNothing: true;
  tables: DryRunTableResult[];
  totals: {
    tablesInspected: number;
    tablesWithRows: number;
    unreadableTables: number;
    rowMatches: number;
    byFate: Record<string, number>;
    rowMatchesByFate: Record<string, number>;
  };
  /** Everything that would stop `executePlannedDeletion` from running. */
  refusalReasons: string[];
}

export interface DryRunOptions {
  /** Restrict the inspection to these tables (used by tests and by triage). */
  only?: readonly string[];
  /** Count using this column set instead of every user column (default: all). */
  includeRetained?: boolean;
}

/**
 * One count. Returns `null` rows plus `unreadable: true` for every shape that
 * is not an actual number, and never throws: a dry run that aborts on the first
 * unreadable table tells you less than one that reports all of them.
 */
export async function countRows(
  sc: any,
  table: string,
  column: string,
  userId: string,
): Promise<{ rows: number | null; unreadable: boolean; error?: string }> {
  try {
    const res = await sc.from(table).select("*", { count: "exact", head: true }).eq(column, userId);
    if (res?.error) {
      return { rows: null, unreadable: true, error: res.error.message ?? String(res.error) };
    }
    if (typeof res?.count !== "number") {
      return {
        rows: null,
        unreadable: true,
        error: "read returned no count and no error - refusing to read that as zero",
      };
    }
    return { rows: res.count, unreadable: false };
  } catch (err: any) {
    return { rows: null, unreadable: true, error: err?.message ?? String(err) };
  }
}

export async function dryRunDeletion(
  sc: any,
  plan: DeletionPlan,
  opts: DryRunOptions = {},
): Promise<DryRunReport> {
  if (plan.actions.length === 0) {
    throw new Error(
      "dryRunDeletion: the plan contains ZERO actions. An empty dry run would report a clean deletion " +
        "of nothing at all; refusing to produce one.",
    );
  }

  const only = opts.only ? new Set(opts.only) : null;
  const actions = plan.actions.filter((a) => !only || only.has(a.table));
  if (actions.length === 0) {
    throw new Error(`dryRunDeletion: the 'only' filter matched no action in the plan (${plan.actions.length} actions)`);
  }

  const tables: DryRunTableResult[] = [];
  for (const a of actions) {
    const counts: ColumnCount[] = [];
    for (const key of a.keyColumns) {
      const r = await countRows(sc, a.table, key.column, plan.userId);
      counts.push({ column: key.column, role: key.role, rows: r.rows, unreadable: r.unreadable, ...(r.error ? { error: r.error } : {}) });
    }
    const readable = counts.filter((c) => !c.unreadable);
    const notes: string[] = [];
    if (a.keyColumns.length === 0) notes.push("no user column: nothing to count, and nothing a scoped delete could key on");
    if (a.fate === "UNRESOLVED") notes.push(`UNRESOLVED: ${plan.unresolved.find((u) => u.table === a.table)?.reason ?? "no fate"}`);
    if (a.obstacles.length > 0) notes.push(...a.obstacles);
    tables.push({
      table: a.table,
      fate: a.fate,
      mechanism: a.mechanism,
      counts,
      rowMatches: readable.reduce((n, c) => n + (c.rows ?? 0), 0),
      unreadable: counts.length > 0 && readable.length === 0,
      notes,
    });
  }

  const unreadableTables = tables.filter((t) => t.unreadable).length;
  const inspectable = tables.filter((t) => t.counts.length > 0).length;
  const byFate: Record<string, number> = {};
  const rowMatchesByFate: Record<string, number> = {};
  for (const t of tables) {
    byFate[t.fate] = (byFate[t.fate] ?? 0) + 1;
    rowMatchesByFate[t.fate] = (rowMatchesByFate[t.fate] ?? 0) + t.rowMatches;
  }

  const refusalReasons: string[] = [];
  if (plan.unresolved.length > 0) {
    refusalReasons.push(
      `${plan.unresolved.length} table(s) have no fate; ${plan.summary.ownerRequiredUnresolved} of them are OWNER_REQUIRED in the graph. ` +
        "Executing would leave their rows in place while reporting a completed deletion.",
    );
  }
  if (plan.boundaryViolations.length > 0) refusalReasons.push(`${plan.boundaryViolations.length} legal-retention boundary violation(s)`);
  if (plan.policyProblems.length > 0) refusalReasons.push(`${plan.policyProblems.length} policy problem(s)`);
  if (plan.unmetStorageHooks.length > 0) refusalReasons.push(`${plan.unmetStorageHooks.length} table(s) planned for deletion hold storage references with no cleanup hook`);
  if (unreadableTables > 0) refusalReasons.push(`${unreadableTables} table(s) could not be read during the dry run`);
  if (inspectable > 0 && unreadableTables === inspectable) {
    refusalReasons.push("EVERY inspectable table was unreadable - the client, not the data, is what this report measured");
  }

  return {
    ok: unreadableTables === 0,
    userId: plan.userId,
    policyVersion: plan.policyVersion,
    generatedAt: new Date().toISOString(),
    wroteNothing: true,
    tables,
    totals: {
      tablesInspected: tables.length,
      tablesWithRows: tables.filter((t) => t.rowMatches > 0).length,
      unreadableTables,
      rowMatches: tables.reduce((n, t) => n + t.rowMatches, 0),
      byFate,
      rowMatchesByFate,
    },
    refusalReasons,
  };
}

/** Human-readable dry run, for an operator and for the report. */
export function formatDryRun(report: DryRunReport, opts?: { limit?: number; onlyWithRows?: boolean }): string {
  const rows = opts?.onlyWithRows ? report.tables.filter((t) => t.rowMatches > 0 || t.unreadable) : report.tables;
  const limit = opts?.limit ?? rows.length;
  const lines = [
    `DRY RUN (nothing written) for ${report.userId}`,
    `  policy ${report.policyVersion} - ok=${report.ok}`,
    `  ${report.totals.tablesInspected} table(s) inspected, ${report.totals.tablesWithRows} with rows, ` +
      `${report.totals.unreadableTables} UNREADABLE, ${report.totals.rowMatches} row match(es)`,
    `  by fate: ${Object.entries(report.totals.byFate).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    `  row matches by fate: ${Object.entries(report.totals.rowMatchesByFate).map(([k, v]) => `${k}=${v}`).join(" ")}`,
  ];
  for (const r of report.refusalReasons) lines.push(`  REFUSAL: ${r}`);
  lines.push("");
  for (const t of rows.slice(0, limit)) {
    const detail = t.counts.map((c) => `${c.column}=${c.unreadable ? "UNREADABLE" : c.rows}`).join(" ");
    lines.push(`  ${t.fate.padEnd(10)} ${t.table.padEnd(38)} ${detail}`);
  }
  if (limit < rows.length) lines.push(`  ... ${rows.length - limit} more table(s)`);
  return lines.join("\n");
}
