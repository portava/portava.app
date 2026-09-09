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
 * can only name a user. Owner resolution goes through resolveContentOwnerDetailed;
 * when the reported content has no accountable user, the user-scoped row is
 * skipped rather than fabricated — see auditReportAction's doc comment.
 */

import { resolveContentOwnerDetailed, type ModerationMetadata } from "./contentOwner.js";

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
): Promise<
  | { ok: true; audit: "recorded"; id?: string; ownerUserId: string; metadata: ModerationMetadata }
  | { ok: true; audit: "skipped_no_owner"; id?: undefined; ownerUserId: null; metadata: ModerationMetadata }
  | { ok: true; audit: "skipped_owner_lookup_failed"; id?: undefined; ownerUserId: null; metadata: ModerationMetadata }
  | { ok: false; error: string }
> {
  // `id` and `ownerUserId` are returned (additively) so an adjudicated trust
  // charge can name the accountable user as its subject and record the audit
  // row it rides on — routes/admin.ts hide-content and report resolve. The
  // skipped_* branches return ownerUserId: null, and a caller must NOT charge
  // anyone in either case, for the same reason the audit row is skipped.
  //
  // ── WHY THE DETAILED RESOLVER, AND WHY A SECOND SKIP VARIANT ─────────────
  // This used to call the thin `resolveContentOwner`, which collapses four
  // distinct outcomes into `string | null`. So an unreadable `posts` table and
  // a post that genuinely no longer exists arrived here identically, and this
  // function answered `skipped_no_owner` for both — a claim that NO ACCOUNTABLE
  // OWNER EXISTS, said about a table it could not read. routes/admin.ts
  // `/reports/:id/dismiss` returns that string to a human operator as `audit`,
  // and `metadata.owner_unresolved = true` wrote the same claim into the
  // append-only audit trail as a FACT about the content.
  //
  // `lookup_failed` is not a fact about the content; it is an operations event.
  // It gets its own variant, its own metadata field (`owner_lookup_failed`, a
  // field lib/contentOwner.ts had already DECLARED and documented for exactly
  // this and which nothing set), and an ERROR-level log rather than a WARN —
  // the operator reading "no accountable owner" needs to know the difference
  // between "nobody to file this under" and "ask me again".
  //
  // ── `metadata` IS NOW RETURNED, because setting it was doing nothing ─────
  // `metadata.owner_unresolved = true` was assigned on the skip path and then
  // immediately returned past — the object is only ever passed to
  // logModerationAction on the RECORDED path, which the skip does not reach. So
  // the flag lib/contentOwner.ts describes as "recorded into the audit trail as
  // a FACT" was in truth written to a local and discarded; there was no trail
  // entry to be wrong in. The same would have been true of `owner_lookup_failed`
  // if it were only assigned here. Returning `metadata` gives both flags
  // somewhere to actually go: a caller can log or surface them (see
  // routes/adminMedia.ts), which is the point of recording a skip at all.
  //
  // ADDITIVE ON PURPOSE. `src/scripts/verifyModerationFkE2E.ts:218` asserts
  // `audit === "recorded"`, and every caller branches on `=== "recorded"`
  // (routes/admin.ts:2207, :2410) or on `ok`. The recorded path is untouched;
  // the new variant only splits what used to be one skip into two.
  const resolution = await resolveContentOwnerDetailed(sc, opts.targetType, opts.targetId);
  const ownerUserId = resolution.ownerUserId;

  const metadata: ModerationMetadata = {
    report_id: opts.reportId,
    target_type: opts.targetType,
    target_id: opts.targetId,
  };

  if (resolution.outcome === "lookup_failed") {
    metadata.owner_lookup_failed = true;
    req?.log?.error?.(
      {
        err: resolution.error,
        reportId: opts.reportId,
        targetType: opts.targetType,
        targetId: opts.targetId,
      },
      "moderation audit: the owner lookup COULD NOT RUN — the user-scoped audit row is " +
        "skipped because the database was unreadable, NOT because the content is unowned",
    );
    return { ok: true, audit: "skipped_owner_lookup_failed", ownerUserId: null, metadata };
  }

  if (!ownerUserId) {
    metadata.owner_unresolved = true;
    req?.log?.warn?.(
      { reportId: opts.reportId, targetType: opts.targetType, targetId: opts.targetId, outcome: resolution.outcome },
      "moderation audit: no accountable user for reported content — " +
        "user-scoped audit row skipped (see auditReportAction)",
    );
    return { ok: true, audit: "skipped_no_owner", ownerUserId: null, metadata };
  }

  const r = await logModerationAction(
    sc, ownerUserId, opts.adminUserId, opts.actionType, opts.reason, metadata,
  );
  if (!r.ok) return { ok: false, error: r.error ?? "unknown" };
  return { ok: true, audit: "recorded", id: r.id, ownerUserId, metadata };
}
