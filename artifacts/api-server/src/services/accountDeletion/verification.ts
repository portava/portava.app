/**
 * The verification report: run AFTER an execution, it re-reads the same tables
 * the plan named and says what is still there.
 *
 * ── WHY A SECOND READ ───────────────────────────────────────────────────────
 * Because a step reporting `ok` is not evidence that rows are gone. Two shapes
 * this repo has already found prove it: a PostgREST delete that matches NO rows
 * resolves exactly like one that matched a thousand, and a range-less read that
 * silently stopped at db-max-rows left the surplus rows in place with the step
 * still reporting success. Both produce a green execution over a half-erased
 * account. The only thing that distinguishes them is asking the database again.
 *
 * ── HOW IT FAILS ────────────────────────────────────────────────────────────
 * Fail-closed, like the dry run: a table that cannot be READ is `UNVERIFIED`,
 * never "clean". `ok` is true only when every DELETE-fated table came back with
 * zero rows AND every read succeeded. A verification that cannot see the data
 * is not a passing verification.
 */
import type { DeletionPlan } from "./DeletionPlanner.js";
import { countRows } from "./DeletionDryRun.js";

export type VerificationStatus = "CLEAN" | "RESIDUAL_ROWS" | "RETAINED_AS_PLANNED" | "UNVERIFIED";

export interface VerificationTableResult {
  table: string;
  fate: string;
  status: VerificationStatus;
  columns: Array<{ column: string; rows: number | null; error?: string }>;
  residualRows: number;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  userId: string;
  policyVersion: string;
  verifiedAt: string;
  tables: VerificationTableResult[];
  totals: {
    checked: number;
    clean: number;
    residual: number;
    retained: number;
    unverified: number;
    residualRows: number;
  };
  failures: string[];
}

export interface VerifyOptions {
  only?: readonly string[];
}

export async function verifyDeletion(
  sc: any,
  plan: DeletionPlan,
  opts: VerifyOptions = {},
): Promise<VerificationReport> {
  if (plan.actions.length === 0) {
    throw new Error("verifyDeletion: the plan contains ZERO actions - there is nothing this report could verify.");
  }
  const only = opts.only ? new Set(opts.only) : null;
  const actions = plan.actions.filter((a) => (!only || only.has(a.table)) && a.keyColumns.length > 0);
  if (actions.length === 0) {
    throw new Error("verifyDeletion: no action in the plan has a user column to verify against.");
  }

  const tables: VerificationTableResult[] = [];
  for (const a of actions) {
    const columns: VerificationTableResult["columns"] = [];
    let unreadable = false;
    let residual = 0;
    for (const key of a.keyColumns) {
      const r = await countRows(sc, a.table, key.column, plan.userId);
      columns.push({ column: key.column, rows: r.rows, ...(r.error ? { error: r.error } : {}) });
      if (r.unreadable) unreadable = true;
      else residual += r.rows ?? 0;
    }

    let status: VerificationStatus;
    let detail: string | undefined;
    if (unreadable) {
      status = "UNVERIFIED";
      detail = "at least one column could not be read; this table is NOT confirmed clean";
    } else if (a.fate === "DELETE" || a.fate === "ANONYMIZE") {
      status = residual === 0 ? "CLEAN" : "RESIDUAL_ROWS";
      if (residual > 0) {
        detail =
          a.fate === "DELETE"
            ? `${residual} row(s) still name the user after a DELETE-fated action`
            : `${residual} row(s) still carry the user id after an ANONYMIZE-fated action`;
      }
    } else if (a.fate === "RETAIN") {
      status = "RETAINED_AS_PLANNED";
      detail = `${residual} row(s) retained by policy: ${a.resolution.authority}`;
    } else {
      status = "RESIDUAL_ROWS";
      detail = `${residual} row(s) survive with NO decided fate - the plan should never have been executed`;
    }

    tables.push({ table: a.table, fate: a.fate, status, columns, residualRows: residual, ...(detail ? { detail } : {}) });
  }

  const totals = {
    checked: tables.length,
    clean: tables.filter((t) => t.status === "CLEAN").length,
    residual: tables.filter((t) => t.status === "RESIDUAL_ROWS").length,
    retained: tables.filter((t) => t.status === "RETAINED_AS_PLANNED").length,
    unverified: tables.filter((t) => t.status === "UNVERIFIED").length,
    residualRows: tables.filter((t) => t.status === "RESIDUAL_ROWS").reduce((n, t) => n + t.residualRows, 0),
  };

  const failures: string[] = [];
  for (const t of tables.filter((x) => x.status === "RESIDUAL_ROWS")) failures.push(`${t.table}: ${t.detail}`);
  for (const t of tables.filter((x) => x.status === "UNVERIFIED")) failures.push(`${t.table}: ${t.detail}`);

  return {
    ok: failures.length === 0,
    userId: plan.userId,
    policyVersion: plan.policyVersion,
    verifiedAt: new Date().toISOString(),
    tables,
    totals,
    failures,
  };
}
