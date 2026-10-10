/**
 * layoverEventPseudonymisation — what "pseudonymise a traveller's
 * layover_events" means, defined ONCE, and the post-session pass that applies it
 * (census-layover L163; OD-MAP-4; lead ruling PR-R-L163a, 2026-10-07).
 *
 * OD-MAP-4 (docs/ops/owner-decisions-20261004.md): "Keep a pseudonymized,
 * access-restricted audit record for up to 12 months, then delete it, unless a
 * specific local legal obligation requires a different period."
 *
 * TWO CALLERS, ONE TRANSFORM. Account deletion
 * (services/accountDeletion/AccountDeletionService.ts) pseudonymises every event
 * of a departed traveller; the post-session pass below pseudonymises the events
 * of one ENDED layover. PR-R-L163a: "30 days after a layover session ends,
 * pseudonymise that traveller's layover_events the same way account deletion
 * does". The same way is this function, not a second copy of it: the user and
 * the session are removed, one random pseudonym is written, the metadata is
 * emptied, and `retain_until` is set 365 days out, which migration 3621's CHECK
 * (`retain_until <= pseudonymised_at + 12 months`) always admits.
 *
 * ── THE POST-SESSION PASS ────────────────────────────────────────────────────
 * Run by lib/layoverAuditRetentionScheduler.ts before its delete sweep, every
 * hour. Behind `layover_events_post_session_pseudonymisation_enabled`, seeded
 * FALSE by 3622, because it is destructive: a pseudonymised row can never be
 * given its name back.
 *
 *   flag off            → "off": nothing else is read.
 *   flag unreadable     → "failed" (flag_unreadable): a destructive pass does not
 *                         act on a flag it could not read, and the failure is
 *                         counted, not mistaken for "off".
 *   no 3622 / no 3621   → "refused" (dead_letters_absent / schema_absent).
 *   a failed read       → "failed": never "nothing due".
 *
 * WHICH SESSIONS. Every named event whose session DEPARTED more than 30 days
 * ago, found by the database (an inner embed on layover_sessions, filtered on
 * `departure_time`), oldest event first. "Ends" is read as the departure
 * instant: a layover cannot still be in progress a month after its flight, and
 * a session cancelled early waits for its departure too, so nothing is
 * pseudonymised before the layover itself would have ended. The only reader of
 * a session's events is that session's own disruption ledger while it is live
 * (services/airport/layoverSafeReturnDisruption.ts readDisruptionState), so a
 * month later nothing needs the name.
 *
 * ONE PSEUDONYM PER SESSION. Account deletion writes one per deletion; here the
 * unit erased is a session, so each session's events share one pseudonym and
 * stay internally consistent as an audit trail without being joinable to the
 * traveller's other sessions.
 *
 * DEAD LETTERS (3622, layover_event_pseudonymisation_dead_letters). A session
 * whose update fails gets a letter: written on the first failure, its `letters`
 * counted up on each consecutive one, stamped `resolved_at` by the first
 * success. At LAYOVER_PSEUDONYMISATION_DEAD_LETTER_CEILING consecutive failures
 * the session is PARKED: excluded from the read, so a session that will never
 * succeed cannot occupy the batch forever and starve the rest. A parked letter
 * stays open and is counted on every pass (GET /healthz/schedulers, job
 * layoverAuditRetention); an operator who fixes the cause stamps `resolved_at`,
 * and the next failure, if any, opens a fresh letter at 1.
 */
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { readFlagState } from "./featureFlags.js";

/**
 * OD-MAP-4's ceiling is "up to 12 months"; 365 days is never longer than 12
 * calendar months from any start (a 12-month span is 365 or 366 days), so the
 * value always satisfies 3621's CHECK `retain_until <= pseudonymised_at + 12 months`.
 */
export const LAYOVER_AUDIT_RETENTION_DAYS = 365;

/** PR-R-L163a: a session's events are pseudonymised this long after its departure. */
export const LAYOVER_POST_SESSION_PSEUDONYMISE_AFTER_DAYS = 30;
/** Consecutive failures after which a session is parked rather than retried. */
export const LAYOVER_PSEUDONYMISATION_DEAD_LETTER_CEILING = 3;
/** Sessions pseudonymised per pass; the next hourly pass takes the next ones. */
export const LAYOVER_POST_SESSION_MAX_SESSIONS = 50;
/** Named events scanned per pass to find those sessions. */
const EVENT_SCAN_LIMIT = 1000;
/** Parked sessions excluded in the query itself (their ids travel in the URL). */
const PARKED_EXCLUSION_LIMIT = 100;

export interface LayoverEventPseudonymPatch {
  user_id: null;
  session_id: null;
  erasure_pseudonym: string;
  pseudonymised_at: string;
  retain_until: string;
  metadata: Record<string, never>;
}

/** The ONE pseudonymisation of a layover_events row. `pseudonym` is fresh unless the caller shares one across rows. */
export function layoverEventPseudonymPatch(atIso: string, pseudonym: string = randomUUID()): LayoverEventPseudonymPatch {
  return {
    user_id: null,
    session_id: null,
    erasure_pseudonym: pseudonym,
    pseudonymised_at: atIso,
    retain_until: new Date(Date.parse(atIso) + LAYOVER_AUDIT_RETENTION_DAYS * 86_400_000).toISOString(),
    metadata: {},
  };
}

/** A database without 3621's pseudonymisation columns (Postgres 42703, PostgREST PGRST204). */
export function isMissingLayoverAuditColumn(err: any): boolean {
  const code = err?.code ?? err?.details?.code;
  return code === "42703" || code === "PGRST204";
}

/** A database without 3622's dead-letter table (Postgres 42P01, PostgREST PGRST205). */
function isMissingRelation(err: any): boolean {
  const code = err?.code ?? err?.details?.code;
  return code === "42P01" || code === "PGRST205";
}

function describeError(err: any): string {
  const code = String(err?.code ?? "unknown");
  const message = String(err?.message ?? err ?? "no message");
  return `${code}: ${message}`.slice(0, 1000);
}

export type LayoverPostSessionOutcome = "pseudonymised" | "idle" | "off" | "refused" | "failed";
export interface LayoverPostSessionResult {
  outcome: LayoverPostSessionOutcome;
  reason:
    | "flag_unreadable" | "dead_letters_absent" | "schema_absent" | "dead_letter_read_failed"
    | "read_failed" | "session_failed" | "dead_letter_write_failed" | "threw" | null;
  /** Sessions whose named events were pseudonymised by this pass. */
  sessions: number;
  /** Events pseudonymised by this pass. */
  events: number;
  /** Sessions whose update failed this pass; each was dead-lettered. */
  failedSessions: number;
  /** Open letters at the ceiling: sessions this pass did not retry. */
  parked: number;
}

/**
 * Write or count up one session's dead letter. `openLetters` is the count the
 * pass read for this session's OPEN letter (0 when it has none).
 */
async function recordDeadLetter(db: any, sessionId: string, openLetters: number, detail: string, atIso: string): Promise<boolean> {
  const res = openLetters > 0
    ? await db.from("layover_event_pseudonymisation_dead_letters")
        .update({ letters: openLetters + 1, last_failed_at: atIso, detail })
        .eq("session_id", sessionId)
        .is("resolved_at", null)
    // No open letter: a first failure, or the first after a resolved one — the
    // upsert reopens it at 1 rather than adding to a count an operator closed.
    : await db.from("layover_event_pseudonymisation_dead_letters")
        .upsert({ session_id: sessionId, detail, letters: 1, first_failed_at: atIso, last_failed_at: atIso, resolved_at: null }, { onConflict: "session_id" });
  if (res?.error) {
    logger.error({ err: res.error, sessionId }, "layover post-session pseudonymisation could not record its dead letter");
    return false;
  }
  return true;
}

/** One post-session pass. Deterministic in its instant: `now` decides the cutoff and every timestamp written. */
export async function runLayoverPostSessionPseudonymisation(
  db: any,
  now: Date,
  opts: { maxSessions?: number } = {},
): Promise<LayoverPostSessionResult> {
  const none = { sessions: 0, events: 0, failedSessions: 0, parked: 0 };
  const flag = await readFlagState(db, "layover_events_post_session_pseudonymisation_enabled");
  if (flag === "off") return { outcome: "off", reason: null, ...none };
  if (flag !== "on") return { outcome: "failed", reason: "flag_unreadable", ...none };

  const letterRead = await db
    .from("layover_event_pseudonymisation_dead_letters")
    .select("session_id, letters")
    .is("resolved_at", null)
    .order("last_failed_at", { ascending: true })
    .limit(1000);
  if (letterRead?.error) {
    if (isMissingRelation(letterRead.error)) return { outcome: "refused", reason: "dead_letters_absent", ...none };
    logger.warn({ err: letterRead.error }, "layover post-session pseudonymisation could not read its dead letters — not acting blind");
    return { outcome: "failed", reason: "dead_letter_read_failed", ...none };
  }
  const open = new Map<string, number>();
  for (const r of (letterRead?.data ?? []) as Array<{ session_id: unknown; letters: unknown }>) {
    if (typeof r.session_id === "string" && r.session_id.length > 0) open.set(r.session_id, Math.max(1, Number(r.letters) || 1));
  }
  const parkedIds = [...open].filter(([, n]) => n >= LAYOVER_PSEUDONYMISATION_DEAD_LETTER_CEILING).map(([id]) => id);
  const parked = new Set(parkedIds);

  const cutoff = new Date(now.getTime() - LAYOVER_POST_SESSION_PSEUDONYMISE_AFTER_DAYS * 86_400_000).toISOString();
  let query = db
    .from("layover_events")
    .select("session_id, layover_sessions!inner(departure_time)")
    .is("pseudonymised_at", null)
    .not("session_id", "is", null)
    .lt("layover_sessions.departure_time", cutoff);
  const excluded = parkedIds.slice(0, PARKED_EXCLUSION_LIMIT);
  if (excluded.length > 0) query = query.not("session_id", "in", `(${excluded.join(",")})`);
  const read = await query.order("created_at", { ascending: true }).limit(EVENT_SCAN_LIMIT);
  if (read?.error) {
    if (isMissingLayoverAuditColumn(read.error)) return { outcome: "refused", reason: "schema_absent", ...none, parked: parked.size };
    logger.warn({ err: read.error }, "layover post-session pseudonymisation could not read named events — 0 due is not a measurement here");
    return { outcome: "failed", reason: "read_failed", ...none, parked: parked.size };
  }

  const max = opts.maxSessions ?? LAYOVER_POST_SESSION_MAX_SESSIONS;
  const due: string[] = [];
  for (const r of (read?.data ?? []) as Array<{ session_id: unknown }>) {
    const sid = r.session_id;
    if (typeof sid !== "string" || sid.length === 0 || parked.has(sid) || due.includes(sid)) continue;
    due.push(sid);
    if (due.length >= max) break;
  }
  if (due.length === 0) return { outcome: "idle", reason: null, ...none, parked: parked.size };

  const atIso = now.toISOString();
  let sessions = 0;
  let events = 0;
  let failedSessions = 0;
  let letterFailed = false;
  for (const sid of due) {
    // Still-named rows of THIS session only; one pseudonym for all of them. The
    // keys are spelled at the call site (check:write-path-columns resolves a
    // literal payload, not a call); every value is the one definition's.
    const p = layoverEventPseudonymPatch(atIso);
    const res = await db
      .from("layover_events")
      .update({ user_id: p.user_id, session_id: p.session_id, erasure_pseudonym: p.erasure_pseudonym, pseudonymised_at: p.pseudonymised_at, retain_until: p.retain_until, metadata: p.metadata })
      .eq("session_id", sid)
      .is("pseudonymised_at", null)
      .select("id");
    if (res?.error) {
      failedSessions += 1;
      if (!(await recordDeadLetter(db, sid, open.get(sid) ?? 0, describeError(res.error), atIso))) letterFailed = true;
      continue;
    }
    sessions += 1;
    events += Array.isArray(res?.data) ? res.data.length : 0;
    if (open.has(sid)) {
      const resolved = await db
        .from("layover_event_pseudonymisation_dead_letters")
        .update({ resolved_at: atIso })
        .eq("session_id", sid)
        .is("resolved_at", null);
      if (resolved?.error) {
        logger.error({ err: resolved.error, sessionId: sid }, "layover post-session pseudonymisation succeeded but could not resolve the session's dead letter");
        letterFailed = true;
      }
    }
  }
  const counts = { sessions, events, failedSessions, parked: parked.size };
  if (letterFailed) return { outcome: "failed", reason: "dead_letter_write_failed", ...counts };
  if (failedSessions > 0) return { outcome: "failed", reason: "session_failed", ...counts };
  logger.info(counts, "layover post-session pseudonymisation pass");
  return { outcome: "pseudonymised", reason: null, ...counts };
}
