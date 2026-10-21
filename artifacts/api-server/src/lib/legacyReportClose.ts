/**
 * legacyReportClose — move a legacy `reports` row the one way every admin route
 * now moves it: CLAIM the row first, then AUDIT it, and UNDO the claim when the
 * audit row cannot be written.
 *
 * ── WHAT WAS WRONG (census-trust, wave 5, 2026-10-18) ──────────────────────
 * Two shapes, both on routes that close a report:
 *   1. POST /admin/reports/:id/resolve and /dismiss, and adminMedia's moderate
 *      on a report, wrote the moderation_actions row BEFORE the status-guarded
 *      update. A report someone else closed between the read and the write was
 *      a 409 that had already written an audit row for an action that did not
 *      happen (the 409's own message said so).
 *   2. POST /admin/trips/:tripId/report-resolve and the event moderate route's
 *      report close (hide / cancel / remove) closed reports with no audit row at
 *      all, and without `reviewed_by` / `reviewed_at`: the report said it was
 *      closed and nothing said who closed it.
 *
 * ── THE ORDER, AS POST /admin/moderation/reports/:id/review DOES IT ─────────
 *   1. CLAIM: a status-guarded update that moves the row out of the status this
 *      request READ, stamping reviewed_by / reviewed_at / moderation_notes. It
 *      must move exactly this row. Zero rows means someone else moved it first:
 *      a conflict, and NOTHING has been written.
 *   2. AUDIT: auditReportAction — the same row the resolve routes always wrote
 *      (the content owner as target, the legacy report id in metadata). Its two
 *      skip outcomes (no accountable owner; owner lookup failed) are not
 *      failures: the report row itself names who closed it, and the outcome is
 *      handed back for the route to say.
 *   3. UNDO, only when the audit row could not be written: the row goes back to
 *      the status and reviewer fields it held when read, guarded on the status
 *      AND the reviewed_at this request stamped, so a later decision by someone
 *      else is never undone. If the undo fails too, the outcome says THAT: the
 *      report reads closed with no audit row, and a human must fix it.
 *
 * NEVER REJECTS: a thrown read or write is an outcome, like a returned error.
 */
import { auditReportAction } from "./moderationAudit.js";
import { UNRESOLVED_REPORT_STATUSES } from "./moderationCounts.js";

/** What a caller reads before a move: the claim guard and the undo both need the row as it was. */
export const LEGACY_REPORT_CLOSE_READ = "id, target_type, target_id, status, reviewed_by, reviewed_at, moderation_notes";

export interface LegacyReportRow {
  id: string;
  target_type: string;
  target_id: string;
  status: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  moderation_notes?: string | null;
}

/** Where a report may be moved to: closed (resolved / dismissed) or acted on but not closed (in_review). */
export type LegacyReportMoveTo = "resolved" | "dismissed" | "in_review";
export type LegacyReportAudit = "recorded" | "skipped_no_owner" | "skipped_owner_lookup_failed";

export interface LegacyReportMoveOptions {
  to: LegacyReportMoveTo;
  adminUserId: string;
  notes: string | null;
  /** moderation_actions.action_type for the audit row (report_resolved, report_dismissed, …). */
  actionType: string;
  /** The reviewed_at / updated_at stamp; one per request. */
  now?: string;
}

export type LegacyReportMoveOutcome =
  | {
      outcome: "moved";
      report: { id: string; status: string; reviewed_at: string | null };
      audit: LegacyReportAudit;
      auditId: string | null;
      ownerUserId: string | null;
    }
  /** The claim moved no row: the report changed (or vanished) since it was read. Nothing was written. */
  | { outcome: "conflict"; message: string }
  /**
   * `nothing_written` — the claim failed; the report is as it was.
   * `unknown` — the claim threw or answered no rows to count: whether it moved is not known.
   * `restored` — the audit row failed, and the claim was undone.
   * `unrestored` — the audit row failed AND the undo failed: the report reads moved with no audit row.
   */
  | { outcome: "failed"; state: "nothing_written" | "unknown" | "restored" | "unrestored"; message: string };

function messageOf(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown } | null;
  return String(e?.message ?? e?.code ?? err ?? "unknown error");
}

/** Claim one legacy report, then audit it; undo the claim when the audit cannot be written. */
export async function moveLegacyReport(sc: any, req: any, row: LegacyReportRow, opts: LegacyReportMoveOptions): Promise<LegacyReportMoveOutcome> {
  const from = String(row.status);
  if (!(UNRESOLVED_REPORT_STATUSES as readonly string[]).includes(from)) {
    return { outcome: "conflict", message: `The report is already ${from}; a closed report is never moved again. Nothing was recorded.` };
  }
  const now = opts.now ?? new Date().toISOString();
  // What the undo restores, copied BEFORE anything is written: the caller's row object may be the very one a write updates.
  const prior = { status: from, reviewed_by: row.reviewed_by ?? null, reviewed_at: row.reviewed_at ?? null, moderation_notes: row.moderation_notes ?? null };

  // 1. Claim: out of the status this request read, and only that.
  let claimed: unknown;
  try {
    const res = await sc
      .from("reports")
      .update({ status: opts.to, reviewed_by: opts.adminUserId, reviewed_at: now, moderation_notes: opts.notes, updated_at: now })
      .eq("id", row.id)
      .eq("status", from)
      .select("id, status, reviewed_at");
    if (res?.error) {
      return { outcome: "failed", state: "nothing_written", message: `The report could not be updated: ${messageOf(res.error)}. Nothing was recorded.` };
    }
    claimed = res?.data;
  } catch (err) {
    return { outcome: "failed", state: "unknown", message: `The report update did not answer (${messageOf(err)}); whether it moved is unknown. Re-read the report before retrying.` };
  }
  if (!Array.isArray(claimed)) {
    return { outcome: "failed", state: "unknown", message: "The report update answered no rows to count; whether it moved is unknown. Re-read the report before retrying." };
  }
  if (claimed.length === 0) {
    return { outcome: "conflict", message: "The report changed while this request ran (someone else moved or closed it). Nothing was recorded." };
  }
  const moved = claimed[0] as { id: string; status: string; reviewed_at: string | null };

  // 2. Audit.
  let auditR: Awaited<ReturnType<typeof auditReportAction>>;
  try {
    auditR = await auditReportAction(sc, req, {
      reportId: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      adminUserId: opts.adminUserId,
      actionType: opts.actionType,
      reason: opts.notes,
    });
  } catch (err) {
    auditR = { ok: false, error: messageOf(err) };
  }
  if (auditR.ok) {
    return { outcome: "moved", report: { id: moved.id, status: moved.status, reviewed_at: moved.reviewed_at ?? null }, audit: auditR.audit, auditId: auditR.id ?? null, ownerUserId: auditR.ownerUserId };
  }

  // 3. Undo: back to what the row held when read — and only if it still holds what this request wrote.
  let undone = false;
  let undoError = "no row";
  try {
    const undo = await sc
      .from("reports")
      .update({ ...prior, updated_at: now })
      .eq("id", row.id)
      .eq("status", opts.to)
      .eq("reviewed_at", now)
      .select("id");
    if (undo?.error) undoError = messageOf(undo.error);
    undone = !undo?.error && Array.isArray(undo?.data) && undo.data.length === 1;
  } catch (err) {
    undoError = messageOf(err);
  }
  if (undone) {
    return { outcome: "failed", state: "restored", message: `Audit write failed, so the report was restored to '${from}'. Nothing was recorded. (${auditR.error})` };
  }
  req?.log?.error?.({ reportId: row.id, auditError: auditR.error, undoError }, "legacy report move: audit write failed AND the claim could not be reversed");
  return { outcome: "failed", state: "unrestored", message: `Audit write failed and the report could not be restored: it now reads '${opts.to}' with no audit row. Fix by hand. (${auditR.error}; undo: ${undoError})` };
}

export interface LegacyReportBulkResult {
  /** Moved AND audited (or audit skipped by auditReportAction's own rule), in order. */
  moved: Array<Extract<LegacyReportMoveOutcome, { outcome: "moved" }>>;
  /** Ids someone else moved between the read and the claim: not this request's, not counted. */
  conflicts: string[];
  /** The first report that failed; the rows after it were not attempted. */
  failure: { reportId: string; state: Extract<LegacyReportMoveOutcome, { outcome: "failed" }>["state"]; message: string } | null;
  notAttempted: string[];
}

/** Move every row, one at a time, stopping at the first failure — so the answer can say exactly what moved. */
export async function moveLegacyReports(sc: any, req: any, rows: LegacyReportRow[], opts: LegacyReportMoveOptions): Promise<LegacyReportBulkResult> {
  const now = opts.now ?? new Date().toISOString();
  const out: LegacyReportBulkResult = { moved: [], conflicts: [], failure: null, notAttempted: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = await moveLegacyReport(sc, req, rows[i]!, { ...opts, now });
    if (r.outcome === "moved") out.moved.push(r);
    else if (r.outcome === "conflict") out.conflicts.push(rows[i]!.id);
    else {
      out.failure = { reportId: rows[i]!.id, state: r.state, message: r.message };
      out.notAttempted = rows.slice(i + 1).map((x) => x.id);
      break;
    }
  }
  return out;
}

/** One sentence an operator can act on, for a bulk move that did not complete. */
export function describeLegacyBulkFailure(r: LegacyReportBulkResult, what: string): string {
  const f = r.failure!;
  const done = r.moved.length > 0 ? `${r.moved.length} report(s) were closed and audited (${r.moved.map((m) => m.report.id).join(", ")}). ` : "No report was closed. ";
  const rest = r.notAttempted.length > 0 ? ` ${r.notAttempted.length} more were not attempted and stay open.` : "";
  const unknown = f.state === "unknown" ? ` So how many reports it closed is unknown: re-read ${what}'s reports before retrying.` : "";
  return `${done}Report ${f.reportId}: ${f.message}${unknown}${rest}`;
}
