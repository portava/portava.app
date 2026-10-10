/**
 * Telegraph §17.2 / §30 "Reliability" — idempotent resend, sequence resume and
 * resume backpressure (census-telegraph T231, T233, T376).
 *
 * Migration 2810 built the storage: `messages.idempotency_key` with a PARTIAL
 * unique index on (thread_id, sender_id, idempotency_key), and
 * `messages.sequence` allocated per conversation under a row lock. What it did
 * not build is any writer or reader that uses them — census T231: "W: no
 * database has the index, and `routes/messaging.ts` does not yet send a key";
 * T233: "only the CONVERSATION resumes" (by timestamp). This module is that
 * writer/reader policy, and it is the only place the two new flags are read.
 *
 * TWO FLAGS, BOTH SEEDED FALSE BY MIGRATION 3654, AND WHY THEY ARE SEPARATE
 * ======================================================================
 *   telegraph_idempotent_send_enabled  — the send route records the client's
 *       key and answers a repeated key with the ORIGINAL message. Needs only
 *       2810's column + index (3654's precondition), not the kernel flag: the
 *       index is a property of the table, not of the trigger.
 *   telegraph_sequence_resume_enabled  — GET /threads/:id/messages accepts
 *       `afterSequence` / `withSequence`. Additionally requires
 *       `telegraph_message_kernel_enabled`, because a sequence is ALLOCATED only
 *       while that flag is on; resuming over a conversation nobody is numbering
 *       would answer "nothing new" for every message written meanwhile.
 * Both are read with `isFlagEnabled` (false on error): an unreadable flag table
 * leaves every route doing exactly what it did before 3654.
 *
 * WHAT A LOOKUP CAN SEE, STATED BECAUSE IT IS THE PRIVACY ARGUMENT
 * =================================================================
 * The replay lookup is keyed (thread_id = the route's thread, sender_id = the
 * CALLER, idempotency_key). It can only ever find a message the caller wrote
 * into a thread whose active membership the route already verified. A key
 * another person used, a key used in another thread, or a key of a deleted
 * thread all find NOTHING and fall through to an ordinary send — which is also
 * what the unique index permits (it is scoped to the sender). There is no
 * answer here that distinguishes "someone else used this key" from "nobody did".
 */

import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { readBlockExclusions } from "../lib/exclusionSet.js";
import { messageKernelEnabled, parseSequenceCursor } from "./telegraphMessageKernel.js";

export const IDEMPOTENT_SEND_FLAG = "telegraph_idempotent_send_enabled";
export const SEQUENCE_RESUME_FLAG = "telegraph_sequence_resume_enabled";

// ── §17.2 idempotent resend ──────────────────────────────────────────────────

/**
 * A usable idempotency key: 8–64 characters of [A-Za-z0-9._:-]. Anything else
 * is NOT a key and the send proceeds un-keyed — refusing the send would turn a
 * malformed optional field into a lost message, which is the failure this whole
 * mechanism exists to prevent. The client's `clientId` (a uuid) qualifies.
 */
export function parseIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^[A-Za-z0-9._:-]{8,64}$/.test(s) ? s : null;
}

export async function idempotentSendEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, IDEMPOTENT_SEND_FLAG);
}

export interface ReplayRow {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string | null;
  ciphertext: string | null;
  created_at: string;
  msg_type: string | null;
  subtype: string | null;
  deleted_at: string | null;
  reply_to_id?: string | null;
}

export type ReplayLookup =
  | { kind: "none" }
  | { kind: "found"; row: ReplayRow }
  | { kind: "failed"; err: unknown };

/**
 * The caller's own earlier message with this key in this thread, if any.
 * Bound error: an unreadable `messages` is `failed`, never `none` — reading it
 * as "no earlier send" would write the duplicate this lookup exists to stop.
 */
export async function findIdempotentReplay(
  sc: any,
  threadId: string,
  senderId: string,
  key: string,
): Promise<ReplayLookup> {
  try {
    const { data, error } = await sc
      .from("messages")
      .select("id, thread_id, sender_id, body, ciphertext, created_at, msg_type, subtype, deleted_at, reply_to_id")
      .eq("thread_id", threadId)
      .eq("sender_id", senderId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (error) return { kind: "failed", err: error };
    if (!data) return { kind: "none" };
    return { kind: "found", row: data as ReplayRow };
  } catch (err) {
    return { kind: "failed", err };
  }
}

/** 23505 on the idempotency index: a concurrent send with the same key won the race. */
export function isIdempotencyConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; details?: unknown } | null;
  if (!e || String(e.code ?? "") !== "23505") return false;
  const text = `${String(e.message ?? "")} ${String(e.details ?? "")}`;
  return text.includes("messages_idempotency_uniq") || text.includes("idempotency_key");
}

/**
 * Is the retry the same send? A key reused for a DIFFERENT payload is a client
 * defect, and answering it with the original would silently drop the new text
 * — so it is refused (409) instead of replayed.
 */
export function sameSendPayload(
  row: ReplayRow,
  sent: { body: string | null; ciphertext: string | null; msgType: string; subtype: string | null },
): boolean {
  return (row.body ?? null) === (sent.body ?? null)
    && (row.ciphertext ?? null) === (sent.ciphertext ?? null)
    && (row.msg_type ?? "text") === sent.msgType
    && (row.subtype ?? null) === (sent.subtype ?? null);
}

/**
 * The answer to a replayed send: the ORIGINAL message, in the exact shape the
 * 201 answer has, plus `idempotentReplay: true`, with status 200. Nothing is
 * re-published, re-tagged or re-translated — those side effects belonged to the
 * first send and ran then.
 */
export function replayResponseBody(row: ReplayRow, clientId: string | null): Record<string, unknown> {
  const deleted = Boolean(row.deleted_at);
  const body = deleted ? null : row.body;
  return {
    id: row.id,
    threadId: row.thread_id,
    senderId: row.sender_id,
    body,
    deleted,
    createdAt: row.created_at,
    editedAt: null,
    displayBody: body,
    originalBody: body,
    originalLanguage: null,
    translated: false,
    translationStatus: null,
    translationLabel: null,
    canShowOriginal: false,
    msgType: row.msg_type ?? "text",
    subtype: row.subtype ?? null,
    clientId,
    replyToId: row.reply_to_id ?? null,
    idempotentReplay: true,
  };
}

// ── §17.2 sequence resume + backpressure ─────────────────────────────────────

/** Both the resume flag AND the kernel flag: no allocation, nothing to resume over. */
export async function sequenceResumeEnabled(sc: any): Promise<boolean> {
  const [resume, kernel] = await Promise.all([
    isFlagEnabled(sc, SEQUENCE_RESUME_FLAG),
    messageKernelEnabled(sc),
  ]);
  return resume && kernel;
}

/** Rows per resume page. A client pages with `nextSequence` while `hasMore`. */
export const RESUME_PAGE_MAX = 100;

/**
 * Per-person resume budget. A reconnect storm (a flapping network, an app that
 * re-renders into a loop) costs one fixed-window counter per person, and the
 * answer past it is an explicit 429 + Retry-After — never a truncated page that
 * reads as complete.
 */
export const RESUME_LIMIT_PER_WINDOW = 60;
export const RESUME_WINDOW_MS = 60_000;

/**
 * Process-wide ceiling on resume reads IN FLIGHT. Load shedding for the moment
 * every phone in a city comes back online at once: past it the answer is 429
 * with a short Retry-After, and the client falls back to its ordinary poll.
 */
export const RESUME_MAX_IN_FLIGHT = 64;
export const RESUME_SHED_RETRY_AFTER_MS = 2_000;

let _inFlight = 0;
/** Test seam. */
export function _resetResumeInFlight(): void { _inFlight = 0; }
/** Test seam: simulate a saturated process. */
export function _setResumeInFlightForTest(n: number): void { _inFlight = n; }
export function resumeInFlight(): number { return _inFlight; }

export type ResumeOpen =
  | { ok: true; afterSequence: number | null; release: () => void }
  | { ok: false; code: "invalid_payload" | "rate_limited"; message: string; retryAfterMs: number | null };

/**
 * Open a sequence read for this request. Returns null when the capability is
 * off — the caller then behaves byte-identically to a request without the
 * parameters. `afterSequence` null = `withSequence` only (no cursor, normal page).
 */
export async function openSequenceRead(
  sc: any,
  userId: string,
  query: { afterSequence?: unknown; withSequence?: unknown },
): Promise<ResumeOpen | null> {
  const wantsResume = query.afterSequence !== undefined;
  const wantsSequence = query.withSequence === "1" || query.withSequence === "true";
  if (!wantsResume && !wantsSequence) return null;
  if (!(await sequenceResumeEnabled(sc))) return null;

  let after: number | null = null;
  if (wantsResume) {
    after = parseSequenceCursor(query.afterSequence);
    // A malformed cursor is refused, never read as 0: "start from the beginning"
    // would page a whole conversation down a reconnect, and "start from wherever
    // it parses" would skip. The client's answer to 400 is its ordinary poll.
    if (after === null) {
      return { ok: false, code: "invalid_payload", message: "afterSequence must be a non-negative integer", retryAfterMs: null };
    }
    const budget = checkRateLimit("telegraph_resume", userId, RESUME_LIMIT_PER_WINDOW, RESUME_WINDOW_MS);
    if (!budget.allowed) {
      return { ok: false, code: "rate_limited", message: "Too many catch-up requests. Please wait a moment.", retryAfterMs: budget.retryAfterMs };
    }
    if (_inFlight >= RESUME_MAX_IN_FLIGHT) {
      return { ok: false, code: "rate_limited", message: "Catch-up is busy right now. Please retry shortly.", retryAfterMs: RESUME_SHED_RETRY_AFTER_MS };
    }
    _inFlight += 1;
    let released = false;
    return { ok: true, afterSequence: after, release: () => { if (!released) { released = true; _inFlight -= 1; } } };
  }
  return { ok: true, afterSequence: null, release: () => {} };
}

/**
 * Resume NEVER carries a message across a block, in either direction (§15.3,
 * the lead's T-REL brief). The ordinary page keeps P-T5's reading (id stays,
 * identity withheld); a resume is a catch-up feed and drops the row entirely.
 * Unreadable block state is `failed` — the caller refuses (503), it does not
 * serve the page unfiltered.
 */
export async function dropBlockedSenders<T extends { sender_id?: unknown }>(
  sc: any,
  viewerId: string,
  rows: T[],
): Promise<{ ok: true; rows: T[]; dropped: number } | { ok: false }> {
  const others = [...new Set(rows.map((r) => String(r.sender_id ?? "")).filter((id) => id && id !== viewerId))];
  if (others.length === 0) return { ok: true, rows, dropped: 0 };
  const ex = await readBlockExclusions(sc, viewerId, { among: others });
  if (!ex.ok) return { ok: false };
  const kept = rows.filter((r) => !ex.ids.has(String(r.sender_id ?? "")));
  return { ok: true, rows: kept, dropped: rows.length - kept.length };
}

/**
 * The page's resume summary, computed on the RAW read (before any window or
 * block filter), as telegraphStream's resume does: `hasMore` is whether the
 * limit was hit, and `nextSequence` advances past every row SCANNED — a row the
 * caller may not see must not pin the cursor, or the next page re-reads it
 * forever.
 */
export function resumeSummary(
  raw: Array<{ sequence?: unknown }>,
  afterSequence: number,
  pageMax: number,
): { scanned: number; hasMore: boolean; nextSequence: number } {
  const hasMore = raw.length > pageMax;
  const scanned = raw.slice(0, pageMax);
  let next = afterSequence;
  for (const r of scanned) {
    const n = typeof r.sequence === "number" ? r.sequence : Number(r.sequence);
    if (Number.isSafeInteger(n) && n > next) next = n;
  }
  return { scanned: scanned.length, hasMore, nextSequence: next };
}
