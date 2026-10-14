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
import { moderationActionReportLinkReady, MODERATION_REPORT_TRANSITIONS, type ModerationReportStatus } from "./moderationReportSnapshots.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  //
  // Lead ruling D-MODACTION-SHAPE (2026-10-06): the originating report is also a real FK,
  // moderation_actions.report_id (3705, SET NULL with the report), written once this database
  // has it — probed, so a build carrying 3705 still writes the old row shape without it. The
  // metadata copy stays for existing readers. A LEGACY `reports` id (report_table "reports",
  // auditReportAction) never goes in that column: it REFERENCES moderation_reports (23503).
  const reportId = linkableReportId(metadata);
  const linkReport = reportId !== null && (await moderationActionReportLinkReady(sc));
  const { data, error } = await sc.from("moderation_actions").insert({
    target_user_id: targetUserId,
    action_type: actionType,
    reason: reason ?? null,
    performed_by: adminUserId,
    created_at: new Date().toISOString(),
    // metadata jsonb (0164) — the content item and the originating report.
    ...(metadata ? { metadata } : {}),
    ...(linkReport ? { report_id: reportId } : {}),
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
    // Every caller passes a LEGACY `reports` id (routes/admin.ts /admin/reports/:id/*,
    // routes/adminMedia.ts target "report"). Labelled so logModerationAction keeps it in
    // metadata only: moderation_actions.report_id (3705) references moderation_reports.
    report_table: LEGACY_REPORTS_TABLE,
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

// ─────────────────────────────────────────────────────────────────────────────
// TV-4a / D-MODACTION-SHAPE: an enforcement taken in answer to a moderation
// report NAMES that report.
//
// Before this, only POST /admin/moderation/reports/:id/review linked its own
// report_actioned / report_dismissed row to the report. The actions that answer
// a report — warn, restrict, suspend, ban, the profile restrictions, a profile
// photo's removal — took no report at all, so the enforcement a report led to
// had no link back to it, in the column or in metadata.
//
// Each of those routes now takes an optional `report_id` (a moderation_reports
// id) and checks it HERE, BEFORE anything is written:
//   - absent / null            → no link, no read: the route behaves as before;
//   - not a uuid               → 400 (a link the moderator asked for is never
//                                silently dropped);
//   - the report cannot be read → 503, retryable; nothing written;
//   - no such report           → 404; nothing written;
//   - the report is closed     → 409: a report may be cited only while the review
//     (actioned / dismissed)     route could still close it as `actioned` (open,
//                                reviewing). A closed decision is final; acting
//                                "on" it afterwards would rewrite what that
//                                decision did with no trace on the report;
//   - about someone else       → 409: the report's accountable user (the one the
//                                intake recorded, else the content's live owner,
//                                as the review route resolves it) must be the user
//                                the action is taken against — the action row's
//                                target_user_id. An owner lookup that cannot run
//                                is 503; a subject with no accountable user, 409.
// On success the link is metadata { report_id, report_table: "moderation_reports" },
// which logModerationAction writes — and, once 3705 is on this database, ALSO as
// moderation_actions.report_id. Without 3705 the row is exactly today's plus the
// metadata link. The report itself is not closed here: the moderator closes it
// with the review route, whose own row is linked too.
// ─────────────────────────────────────────────────────────────────────────────

/** The legacy report table's name, as auditReportAction labels the ids it records. */
export const LEGACY_REPORTS_TABLE = "reports";

/**
 * The id logModerationAction may put in moderation_actions.report_id: a uuid that
 * is not labelled as a legacy `reports` id. Everything else stays in metadata only.
 */
export function linkableReportId(metadata?: ModerationMetadata): string | null {
  const id = metadata?.report_id;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return metadata?.report_table === LEGACY_REPORTS_TABLE ? null : id;
}

/**
 * The report-link fields for a route that inserts its moderation_actions row by
 * hand (PATCH /admin/users/:userId/moderation-action): the same decision
 * logModerationAction makes. No metadata → no fields, so the row is as before.
 */
export async function reportLinkInsertFields(
  sc: any,
  metadata?: ModerationMetadata,
): Promise<{ metadata?: ModerationMetadata; report_id?: string }> {
  if (!metadata) return {};
  const reportId = linkableReportId(metadata);
  const linkReport = reportId !== null && (await moderationActionReportLinkReady(sc));
  return { metadata, ...(linkReport ? { report_id: reportId } : {}) };
}

export type ActionReportLink =
  | { ok: true; reportId: string; metadata: ModerationMetadata }
  | { ok: true; reportId: null; metadata: undefined }
  | {
      ok: false;
      code: "invalid_payload" | "not_found" | "conflict" | "degraded_unavailable";
      message: string;
    };

/** The report an action taken against `targetUserId` cites — checked before anything is written. */
export async function checkActionReportLink(
  sc: any,
  rawReportId: unknown,
  targetUserId: string,
): Promise<ActionReportLink> {
  if (rawReportId === undefined || rawReportId === null) return { ok: true, reportId: null, metadata: undefined };
  if (typeof rawReportId !== "string" || !UUID_RE.test(rawReportId)) {
    return { ok: false, code: "invalid_payload", message: "report_id must be the UUID of a moderation report. Nothing was changed." };
  }
  const reportId = rawReportId.toLowerCase();

  let report: any = null;
  try {
    const { data, error } = await sc
      .from("moderation_reports")
      .select("id, subject_type, subject_id, subject_user_id, status")
      .eq("id", reportId)
      .maybeSingle();
    if (error) {
      return { ok: false, code: "degraded_unavailable", message: "The report this action cites could not be read right now, so nothing was changed. Please try again." };
    }
    report = data;
  } catch {
    return { ok: false, code: "degraded_unavailable", message: "The report this action cites could not be read right now, so nothing was changed. Please try again." };
  }
  if (!report) return { ok: false, code: "not_found", message: "The report this action cites does not exist. Nothing was changed." };

  const status = String(report.status) as ModerationReportStatus;
  const next = MODERATION_REPORT_TRANSITIONS[status] ?? [];
  if (!next.includes("actioned")) {
    return { ok: false, code: "conflict", message: `The report this action cites is '${status}', and a closed report cannot be cited. Act first, then close the report. Nothing was changed.` };
  }

  let accountable: string | null = null;
  const recorded = report.subject_user_id;
  if (typeof recorded === "string" && recorded.length > 0) {
    accountable = recorded;
  } else {
    const resolution = await resolveContentOwnerDetailed(sc, String(report.subject_type), String(report.subject_id ?? ""));
    if (resolution.outcome === "lookup_failed") {
      return { ok: false, code: "degraded_unavailable", message: "The owner of the reported content could not be looked up right now, so nothing was changed. Please try again." };
    }
    accountable = resolution.ownerUserId;
  }
  if (!accountable) {
    return { ok: false, code: "conflict", message: "The report this action cites names no accountable user, so it cannot be linked to an action against one. Nothing was changed." };
  }
  if (accountable.toLowerCase() !== targetUserId.toLowerCase()) {
    return { ok: false, code: "conflict", message: "The report this action cites is about someone else. Nothing was changed." };
  }
  return { ok: true, reportId, metadata: { report_id: reportId, report_table: "moderation_reports" } };
}

/**
 * The report a CONTENT moderation cites (routes/adminMedia.ts POST
 * /admin/media/:id/moderate, targets post / post_media / hidden_gem): the same
 * rule as checkActionReportLink, against the content's OWNER — the user its
 * moderation_actions row names. The owner is resolved here, BEFORE the status
 * flip, so a refused link changes nothing. A legacy `reports` row is moderated
 * by its own id (target "report") and cannot also cite one: 400.
 */
export async function checkContentReportLink(
  sc: any,
  rawReportId: unknown,
  entityType: string,
  entityId: string,
): Promise<ActionReportLink> {
  if (rawReportId === undefined || rawReportId === null) return { ok: true, reportId: null, metadata: undefined };
  if (typeof rawReportId !== "string" || !UUID_RE.test(rawReportId)) {
    return { ok: false, code: "invalid_payload", message: "report_id must be the UUID of a moderation report. Nothing was changed." };
  }
  if (entityType === "report") {
    return { ok: false, code: "invalid_payload", message: "A legacy report is moderated by its own id and cannot cite another report. Nothing was changed." };
  }
  const owner = await resolveContentOwnerDetailed(sc, entityType as any, entityId);
  if (owner.outcome === "lookup_failed") {
    return { ok: false, code: "degraded_unavailable", message: "The content's owner could not be looked up right now, so nothing was changed. Please try again." };
  }
  if (owner.outcome === "not_found") return { ok: false, code: "not_found", message: "The content this action is taken on does not exist. Nothing was changed." };
  if (!owner.ownerUserId) {
    return { ok: false, code: "conflict", message: "This content has no accountable owner, so a report about a person cannot be cited for it. Nothing was changed." };
  }
  return checkActionReportLink(sc, rawReportId, owner.ownerUserId);
}
