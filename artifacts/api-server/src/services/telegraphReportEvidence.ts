/**
 * Telegraph §22 — restricted moderation storage for reported content.
 *
 * §22, both halves, verbatim:
 *   "Evidence: store minimum necessary reported content/context under
 *    restricted policy."
 *   "Reported deleted content may remain in restricted moderation storage but
 *    must not appear in normal retrieval."
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * census T283: a report row carries reporter, target type/id and a
 * 200-character `reason_detail` and NO CONTENT SNAPSHOT. T284: "Deletion
 * redacts in place — `.update({ deleted_at: now, body: '' })` — with nothing
 * copied to moderation storage first, so reported content is DESTROYED, not
 * restricted." Both re-read against this tree and both still exactly true.
 *
 * So a person reports a message, the sender deletes it, and the moderator opens
 * a report that points at a row whose body is the empty string. The reporter is
 * then the only one who ever saw it, and the product's answer to them is a
 * shrug.
 *
 * ── THE SNAPSHOT IS TAKEN AT REPORT TIME, AND THAT IS THE WHOLE DESIGN ───────
 * Not at delete time. A delete-time hook would have to ask "was this ever
 * reported?" on every deletion — a read on the hot path that fails open by
 * default — and it would still lose the content when the delete raced the
 * report. Report time is the one moment the content is known to exist and the
 * one moment somebody has asked for it to be looked at.
 *
 * ── FAILURE IS RECORDED, NEVER SILENT, AND NEVER FATAL ───────────────────────
 * Three things can go wrong and they are three different rows, not one absence:
 *   captured        — the content was read and copied.
 *   already_deleted — the target was soft-deleted BEFORE the report was filed.
 *                     There was nothing to copy and the moderator must be able
 *                     to see that, rather than inferring it from a missing row.
 *   unreadable      — the read failed. The row still exists, so the gap is a
 *                     fact in the record instead of a silence.
 *
 * And none of the three changes the report's outcome. The report is already
 * written and already answered 201 before this runs: a person who has just
 * reported harassment must not be told "could not file report" because a
 * snapshot table was slow. Evidence capture improves a report; it does not gate
 * one.
 *
 * ── THE TABLE IS NEVER NAMED WITHOUT THE FLAG ────────────────────────────────
 * PostgREST answers a missing relation with an error, not with silence, so a
 * database without 2812 would log a 42P01 on every report. `isFlagEnabled` is
 * false-on-error, which is the right polarity: an unreadable `feature_flags`
 * leaves the report path byte-identical to what it was before 2812.
 */
import { isFlagEnabled } from "../lib/featureFlags.js";

export const REPORT_EVIDENCE_FLAG = "telegraph_report_evidence_enabled";

/** How much surrounding conversation a THREAD report may retain. */
export const THREAD_CONTEXT_MESSAGES = 20;

/** §22's "minimum necessary", as the same number the migration's CHECK uses. */
export const MAX_BODY_SNAPSHOT = 4000;

export type CaptureStatus = "captured" | "already_deleted" | "unreadable";

export interface CaptureOutcome {
  /** False when the flag is off — nothing was attempted and nothing is wrong. */
  attempted: boolean;
  status?: CaptureStatus;
  /** True when a row was written. */
  written: boolean;
}

const NOT_ATTEMPTED: CaptureOutcome = { attempted: false, written: false };

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export async function reportEvidenceEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, REPORT_EVIDENCE_FLAG);
}

/**
 * Snapshot one reported MESSAGE.
 *
 * `deleted_at` is read explicitly rather than filtered on, because "this
 * message is already deleted" is an answer worth recording and a filter would
 * turn it into "not found".
 */
export async function captureMessageEvidence(
  sc: any,
  params: { reportId: string | null; messageId: string; log: Logger },
): Promise<CaptureOutcome> {
  const { reportId, messageId, log } = params;
  if (!reportId) return NOT_ATTEMPTED;
  if (!(await reportEvidenceEnabled(sc))) return NOT_ATTEMPTED;

  let status: CaptureStatus = "captured";
  let row: Record<string, unknown> = {
    report_id: reportId,
    target_type: "message",
    target_id: messageId,
  };

  const { data: msg, error } = await sc
    .from("messages")
    .select("id, thread_id, sender_id, body, media_url, msg_type, subtype, created_at, deleted_at")
    .eq("id", messageId)
    .maybeSingle();

  if (error) {
    // The read failed. Record the gap; do not guess at the content.
    status = "unreadable";
    log.warn({ err: error, messageId }, "report evidence: message read failed — recording the gap");
  } else if (!msg) {
    status = "already_deleted";
  } else if ((msg as any).deleted_at) {
    // Soft-deleted before the report was filed: `body` has already been blanked
    // in place, so there is nothing here to keep. Say so.
    status = "already_deleted";
    row = {
      ...row,
      thread_id: (msg as any).thread_id ?? null,
      author_id: (msg as any).sender_id ?? null,
      content_created_at: (msg as any).created_at ?? null,
    };
  } else {
    const body = typeof (msg as any).body === "string" ? (msg as any).body : null;
    row = {
      ...row,
      thread_id: (msg as any).thread_id ?? null,
      author_id: (msg as any).sender_id ?? null,
      body_snapshot: body ? body.slice(0, MAX_BODY_SNAPSHOT) : null,
      media_url_snapshot: (msg as any).media_url ?? null,
      msg_type: (msg as any).msg_type ?? null,
      subtype: (msg as any).subtype ?? null,
      content_created_at: (msg as any).created_at ?? null,
    };
  }

  return writeEvidence(sc, { ...row, capture_status: status }, status, log);
}

/**
 * Snapshot a reported THREAD.
 *
 * A thread report does not name a message, so the evidence is a BOUNDED window:
 * the most recent `THREAD_CONTEXT_MESSAGES` non-deleted messages, ids, authors,
 * timestamps and bodies, in one `context` blob the migration caps at 16 KB.
 *
 * Bounded is the operative word. Copying a whole conversation because somebody
 * reported it would retain far more than was reported — including messages from
 * people who are not party to the complaint — and §22 says "minimum necessary",
 * not "everything that might help".
 */
export async function captureThreadEvidence(
  sc: any,
  params: { reportId: string | null; threadId: string; log: Logger },
): Promise<CaptureOutcome> {
  const { reportId, threadId, log } = params;
  if (!reportId) return NOT_ATTEMPTED;
  if (!(await reportEvidenceEnabled(sc))) return NOT_ATTEMPTED;

  let status: CaptureStatus = "captured";
  let context: unknown = null;

  const { data: msgs, error } = await sc
    .from("messages")
    .select("id, sender_id, body, msg_type, subtype, created_at")
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(THREAD_CONTEXT_MESSAGES);

  if (error) {
    status = "unreadable";
    log.warn({ err: error, threadId }, "report evidence: thread window read failed — recording the gap");
  } else {
    const rows = ((msgs as any[]) ?? []).map((m) => ({
      id: m.id,
      authorId: m.sender_id ?? null,
      body: typeof m.body === "string" ? m.body.slice(0, 500) : null,
      msgType: m.msg_type ?? null,
      subtype: m.subtype ?? null,
      createdAt: m.created_at ?? null,
    }));
    if (rows.length === 0) status = "already_deleted";
    context = { window: "most_recent", limit: THREAD_CONTEXT_MESSAGES, messages: rows };
  }

  return writeEvidence(
    sc,
    {
      report_id: reportId,
      target_type: "thread",
      target_id: threadId,
      thread_id: threadId,
      context,
      capture_status: status,
    },
    status,
    log,
  );
}

/**
 * One write, error-checked.
 *
 * `UNIQUE (report_id, target_type, target_id)` makes a retry idempotent, so a
 * 23505 is success rather than a failure — the evidence for this report is
 * already there and a second copy would be a second retention of the same
 * content.
 */
async function writeEvidence(
  sc: any,
  row: Record<string, unknown>,
  status: CaptureStatus,
  log: Logger,
): Promise<CaptureOutcome> {
  const { error } = await sc.from("telegraph_report_evidence").insert(row);
  if (error) {
    if ((error as any)?.code === "23505") return { attempted: true, status, written: true };
    // A failed evidence write must not fail the report; it must not be silent
    // either. This is the one place a moderator's record can quietly not exist.
    log.error({ err: error, targetType: row.target_type, targetId: row.target_id },
      "report evidence: write failed — the report stands but has no attached content");
    return { attempted: true, status, written: false };
  }
  return { attempted: true, status, written: true };
}
