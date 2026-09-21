/**
 * experienceSessionStore — the I/O half of Sensing §5.4's bridge, over the
 * canonical event spine and NO table of its own (see lib/experienceSession's
 * header for the §19 mapping that decided that).
 *
 * ── WHAT IT WILL READ, AND HOW FAR BACK ──────────────────────────────────────
 * Exactly the viewer's OWN events, of the four verbs a session can produce,
 * inside ONE session lifetime (MAX_SESSION_HOURS). It cannot read further back
 * than a session can live, so there is no query here that could answer "where
 * has this person been" — that is the §5.4 "not a raw tracking history"
 * constraint expressed as the shape of the only read, not as a rule someone
 * has to remember. There is deliberately NO list, NO history and NO by-subject
 * function in this module, and the suite asserts the module exports none.
 *
 * ── WHY NOT recordEvent ──────────────────────────────────────────────────────
 * lib/canonicalEvents.recordEvent is fire-and-forget by contract — right for
 * instrumentation, wrong here: a caller opening a session must be told whether
 * it opened. So the write goes through the SAME projection and sanitiser
 * (`projectEvent`, which drops a non-canonical verb and strips raw GPS at every
 * depth) and then an insert whose error is READ and returned, never logged and
 * swallowed.
 *
 * Reads and writes only this one table. No coordinate, no second store.
 */
import { projectEvent, type CanonicalEventInput } from "./canonicalEvents.js";
import {
  MAX_SESSION_HOURS,
  SESSION_OPEN_VERB,
  isExperienceSessionEnvelope,
  foldSession,
  sessionState,
  type ExperienceSessionEnvelope,
  type SessionState,
} from "./experienceSession.js";
import { OUTCOME_VERBS } from "./intelOutcomes.js";

export const SESSION_EVENTS_TABLE = "canonical_events";

/** The verbs a session can produce: the opening one and the outcome's three. */
export const SESSION_VERBS: readonly string[] = Object.freeze([SESSION_OPEN_VERB, ...OUTCOME_VERBS]) as readonly string[];

/** Rows one read may consider. A viewer cannot have more sessions than this in one lifetime. */
export const SESSION_READ_LIMIT = 50;

export type SessionReadRefusal = "read_failed" | "not_configured";

export interface SessionReadResult {
  /** The viewer's open session, or null when there is none. */
  open: { envelope: ExperienceSessionEnvelope; state: SessionState } | null;
  /** Why we could not look. NULL means the read happened — "none" is then a fact. */
  refusal: SessionReadRefusal | null;
}

interface EventRow {
  payload: Record<string, unknown> | null;
  occurred_at: string | null;
}

function envelopesOf(rows: readonly EventRow[]): ExperienceSessionEnvelope[] {
  const out: ExperienceSessionEnvelope[] = [];
  for (const r of rows) {
    const raw = (r?.payload ?? {})["experience_session"];
    if (isExperienceSessionEnvelope(raw)) out.push(raw);
  }
  return out;
}

/** The viewer's own session events inside one session lifetime, oldest first. */
async function readWindow(sc: any, actorId: string, nowMs: number): Promise<{ rows: EventRow[] } | { refusal: SessionReadRefusal }> {
  if (!sc) return { refusal: "not_configured" };
  const since = new Date(nowMs - MAX_SESSION_HOURS * 3_600_000).toISOString();
  const { data, error } = await sc
    .from(SESSION_EVENTS_TABLE)
    .select("payload, occurred_at")
    .eq("actor_id", actorId)
    .in("verb", SESSION_VERBS)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: true })
    .limit(SESSION_READ_LIMIT);
  if (error) return { refusal: "read_failed" };
  return { rows: (data ?? []) as EventRow[] };
}

/**
 * The viewer's OPEN session, or null. A failed read is a REFUSAL, never "no
 * session": opening a second session on the strength of a failed read is
 * exactly the §20 confusion this returns a refusal to prevent.
 */
export async function readOpenSession(sc: any, actorId: string, nowMs: number): Promise<SessionReadResult> {
  const w = await readWindow(sc, actorId, nowMs);
  if ("refusal" in w) return { open: null, refusal: w.refusal };
  const envelopes = envelopesOf(w.rows);
  const closed = new Set(envelopes.filter((e) => e.phase === "closed").map((e) => e.session_id));
  // Newest first among the still-open ones; an expired session is not open.
  const candidates = envelopes
    .filter((e) => e.phase === "opened" && !closed.has(e.session_id))
    .filter((e) => sessionState(e, nowMs) === "open")
    .sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at));
  const first = candidates[0];
  return { open: first ? { envelope: first, state: "open" } : null, refusal: null };
}

export interface SessionByIdResult {
  session: { envelope: ExperienceSessionEnvelope; state: SessionState } | null;
  refusal: SessionReadRefusal | null;
}

/** ONE session of the viewer's, by id, folded over its own events. */
export async function readSessionById(sc: any, actorId: string, sessionId: string, nowMs: number): Promise<SessionByIdResult> {
  const w = await readWindow(sc, actorId, nowMs);
  if ("refusal" in w) return { session: null, refusal: w.refusal };
  return { session: foldSession(envelopesOf(w.rows), sessionId, nowMs), refusal: null };
}

export type SessionWriteRefusal = "not_configured" | "non_canonical_event" | "write_failed";

export type SessionWriteResult = { ok: true } | { ok: false; refusal: SessionWriteRefusal };

/**
 * Append one session event. The projection is the spine's own (a non-canonical
 * verb never reaches the database, and raw GPS is stripped at every depth); the
 * insert's error is returned rather than logged and swallowed, because the
 * caller must be able to say whether the session opened.
 */
export async function appendSessionEvent(sc: any, event: CanonicalEventInput): Promise<SessionWriteResult> {
  if (!sc) return { ok: false, refusal: "not_configured" };
  const row = projectEvent(event);
  if (!row) return { ok: false, refusal: "non_canonical_event" };
  const { error } = await sc.from(SESSION_EVENTS_TABLE).insert(row);
  if (error) return { ok: false, refusal: "write_failed" };
  return { ok: true };
}
