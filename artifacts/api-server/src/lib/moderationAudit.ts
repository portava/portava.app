/**
 * moderationAudit — shared writers for the moderation_actions audit trail.
 *
 * Extracted verbatim from routes/admin.ts so that every admin surface that
 * takes a moderation action writes the SAME append-only audit row the report
 * resolve/dismiss paths do. routes/adminMedia.ts's moderate endpoint reuses
 * these directly instead of re-implementing (and, until this change, mostly
 * skipping) the audit.
 *
 * `moderation_actions.target_user_id` is a NOT NULL FK to profiles(id), so a row
 * can only name a user. Owner resolution goes through resolveContentOwner; when
 * the reported content has no accountable user, the user-scoped row is skipped
 * rather than fabricated — see auditReportAction's doc comment.
 */

import { resolveContentOwner, type ModerationMetadata } from "./contentOwner.js";

export async function logModerationAction(
  sc: any,
  targetUserId: string,
  adminUserId: string,
  actionType: string,
  reason: string | null,
  metadata?: ModerationMetadata,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  // The row id is returned so an adjudicated trust charge can be keyed on it.
  // Without a stable key, a retried ban or a double-clicked Remove would charge
  // the user twice for one finding.
  const { data, error } = await sc.from("moderation_actions").insert({
    target_user_id: targetUserId,
    action_type: actionType,
    reason: reason ?? null,
    performed_by: adminUserId,
    created_at: new Date().toISOString(),
    // metadata jsonb (0164) — the only place the content item and the
    // originating report can be recorded; there are no columns for either.
    ...(metadata ? { metadata } : {}),
  }).select("id").maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as any)?.id ?? undefined };
}

/**
 * Audit a moderation action taken in response to a report.
 *
 * `moderation_actions.target_user_id` is a NOT NULL FK to profiles(id), so the
 * row can only name a user. When the reported content has no accountable user
 * — `place` is unowned by design, and a deleted row resolves to nothing — there
 * is no honest value for that column.
 *
 * The three available options were: fabricate one (the previous hide-content
 * behaviour used the acting admin's own id, which records the admin as the
 * target of their own action), refuse the moderation action entirely (which
 * would make unowned and orphaned content unmoderatable — precisely the
 * content most likely to need it), or skip the user-scoped row and say so.
 *
 * This does the third. The report row itself still records who resolved it and
 * when (`reviewed_by` / `reviewed_at` / `moderation_notes`), so the action is
 * not unrecorded — it is only absent from the user-centric trail, which has no
 * subject to file it under. The caller surfaces `audit` in its response and the
 * skip is logged. Making this fail-closed properly needs either a nullable
 * `target_user_id` or a content-target column, i.e. a migration.
 */
export async function auditReportAction(
  sc: any,
  req: any,
  opts: {
    reportId: string;
    targetType: string;
    targetId: string;
    adminUserId: string;
    actionType: string;
    reason: string | null;
  },
): Promise<{ ok: true; audit: string } | { ok: false; error: string }> {
  const ownerUserId = await resolveContentOwner(sc, opts.targetType, opts.targetId);

  const metadata: ModerationMetadata = {
    report_id: opts.reportId,
    target_type: opts.targetType,
    target_id: opts.targetId,
  };

  if (!ownerUserId) {
    metadata.owner_unresolved = true;
    req?.log?.warn?.(
      { reportId: opts.reportId, targetType: opts.targetType, targetId: opts.targetId },
      "moderation audit: no accountable user for reported content — " +
        "user-scoped audit row skipped (see auditReportAction)",
    );
    return { ok: true, audit: "skipped_no_owner" };
  }

  const r = await logModerationAction(
    sc, ownerUserId, opts.adminUserId, opts.actionType, opts.reason, metadata,
  );
  if (!r.ok) return { ok: false, error: r.error ?? "unknown" };
  return { ok: true, audit: "recorded" };
}
