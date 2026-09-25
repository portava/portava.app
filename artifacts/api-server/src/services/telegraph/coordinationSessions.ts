/**
 * Telegraph §13.1 `CREATE_COORDINATION_SESSION` — the one writer.
 *
 * Spec:
 *   §13.1  `CREATE_COORDINATION_SESSION`
 *   §12    `coordination_sessions` — "Temporary active real-world coordination
 *          state."
 *   §12.1  a message envelope carries an `idempotencyKey`
 *   §17.2  "Offline resend must be idempotent."
 *   §9     PREPARING -> ASSEMBLING -> ACTIVE -> RETURNING -> COMPLETE, with
 *          DISRUPTED / CANCELLED as exits
 *
 * ── WHY THIS IS A MODULE AND NOT A HANDLER ──────────────────────────────────
 * There are TWO doors onto this command and there must be ONE writer.
 * `POST /api/threads/:id/coordination` with `kind: "COORDINATION_SESSION"` is
 * the door the coordination surface uses; `POST /api/telegraph/commands` with
 * `type: "CREATE_COORDINATION_SESSION"` is the door §13.1 names. census T168
 * scored the command N because neither existed; two handlers would score it C
 * and then drift, and the drift would be in the idempotency rule — the one
 * thing here that is easy to implement slightly differently and impossible to
 * notice going wrong.
 *
 * ── IDEMPOTENCY, AND WHY IT IS ENFORCED TWICE ───────────────────────────────
 * The key is REQUIRED. The trip kernel's endpoint states the reason and it
 * holds identically here: "a generated one would make every retry a new
 * command". A coordination session is precisely the object a person creates by
 * tapping a button on a phone with one bar of signal.
 *
 * The write-side check is a read of this conversation's own sessions for a row
 * carrying the same `(sender, key)`. That closes every SEQUENTIAL retry — the
 * offline queue draining twice, the user tapping again because nothing
 * happened, a proxy replaying a request.
 *
 * It does NOT close two genuinely concurrent retries: both read, neither sees
 * the other, both insert. This tree has no constraint that could: a session is
 * a `messages` row, `messages` has no unique index on an envelope field, and
 * adding one needs a migration no database has. So the READ collapses them as
 * well (`projectConversationSessions`), and the pair is what makes the command
 * idempotent in observable behaviour: the earlier row is the session, the later
 * one is inert, and nobody sees two evenings.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not end an existing session. Opening a second session while one is
 * running is legal and sometimes right (two plans in one crew thread), and
 * deciding otherwise is not this module's call — §9 has no such rule. The
 * coordination view shows the newest OPEN session, which is the behaviour that
 * already shipped.
 *
 * It does not write a canonical plan. A session coordinates AROUND a plan and
 * `planObjectId` is a reference; §30A.10's prohibition ("Telegraph orchestrates,
 * source domains retain truth") applies here as it does to every action.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { emitCoordinationStarted } from "../../lib/telegraphEvents.js";
import { applyHistoryWindow, withinWindow } from "../groupChatHistoryBound.js";
import {
  CoordinationSessionPayload,
  parseCoordinationEnvelope,
  projectConversationSessions,
  validateCoordinationMessage,
  type CoordinationSession,
} from "./coordination.js";

/**
 * How many recent rows the idempotency lookup reads.
 *
 * Deliberately the same bound the coordination view uses. A key found outside
 * the window the view can see would resolve to a session the caller cannot
 * then read, which is a worse answer than creating a new one.
 */
export const SESSION_IDEMPOTENCY_SCAN_LIMIT = 400;

const SESSION_COLUMNS = "id, thread_id, sender_id, created_at, deleted_at, msg_type, subtype, body";

export type CreateSessionResult =
  | { ok: true; duplicate: boolean; session: CoordinationSession; messageId: string }
  | { ok: false; code: "invalid_payload" | "db_error"; message: string };

export interface CreateSessionInput {
  threadId: string;
  actorUserId: string;
  title: string;
  planObjectId?: string | null;
  note?: string | null;
  idempotencyKey: string;
  /** §14.3's history bound for this member, or null when the bound is off. */
  visibleFrom?: string | null;
  /** §9's DERIVED state for the plan, when the caller has computed one. */
  derivedState?: Parameters<typeof projectConversationSessions>[2];
  now?: Date;
}

/**
 * Read this conversation's COORDINATION_SESSION rows, newest first.
 *
 * A PostgREST rejection RESOLVES rather than throws, so `error` is checked
 * explicitly and an unreadable thread is an ERROR and never an empty list. An
 * empty list here would be read as "no session with that key" and would mint a
 * duplicate on every retry for as long as the read stayed broken — the exact
 * shape of failure §18 catalogued across twelve routes.
 */
async function readSessionRows(
  client: SupabaseClient,
  threadId: string,
  visibleFrom: string | null,
  viewerId: string,
): Promise<{ ok: true; rows: any[] } | { ok: false; message: string }> {
  let q = client
    .from("messages")
    .select(SESSION_COLUMNS)
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(SESSION_IDEMPOTENCY_SCAN_LIMIT);
  // Q6 in the QUERY: `SESSION_IDEMPOTENCY_SCAN_LIMIT` caps this read, so the
  // plain `.gte` decides it in PostgREST. This lookup is what makes a retry
  // idempotent, and the session a rejoined member is retrying is one THEY
  // opened — the very rows a plain `.gte` throws away. Left unrelaxed, a retry
  // would mint a duplicate session. It must stay exactly as tight for anyone
  // else's rows, and `sender_id.eq.<caller>` is the whole of what it adds.
  q = applyHistoryWindow(q, visibleFrom, viewerId);
  const { data, error } = await q;
  if (error) return { ok: false, message: error.message ?? "session read failed" };
  return { ok: true, rows: ((data as any[]) ?? []).filter((r) =>
    withinWindow(r.created_at, visibleFrom, { senderId: r.sender_id, viewerId })) };
}

function toInput(row: any, payload: unknown) {
  return {
    id: String(row.id),
    sender_id: String(row.sender_id),
    created_at: String(row.created_at),
    payload,
  };
}

/** Split parsed rows into sessions and transitions. */
function partition(rows: any[]) {
  const sessions: Array<ReturnType<typeof toInput>> = [];
  const transitions: Array<ReturnType<typeof toInput>> = [];
  for (const r of rows) {
    const env = parseCoordinationEnvelope(r.msg_type, r.body);
    if (!env) continue;
    if (env.kind === "COORDINATION_SESSION") sessions.push(toInput(r, env.payload));
    else if (env.kind === "COORDINATION_TRANSITION") transitions.push(toInput(r, env.payload));
  }
  return { sessions, transitions };
}

/**
 * §13.1 `CREATE_COORDINATION_SESSION`.
 *
 * The caller has ALREADY established that the actor may write to this thread —
 * `guardTelegraphThreadWrite` on the coordination route, active membership on
 * the command route. This function does not re-authorize, and says so here
 * rather than leaving a reader to assume either way.
 */
export async function createCoordinationSession(
  client: SupabaseClient,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (key.length === 0 || key.length > 200) {
    return {
      ok: false,
      code: "invalid_payload",
      message:
        "idempotencyKey is required (1-200 chars). A generated one would make every retry a new " +
        "coordination session, which is the failure §17.2 exists to prevent.",
    };
  }

  const parsed = CoordinationSessionPayload.safeParse({
    title: input.title,
    planObjectId: input.planObjectId ?? null,
    note: input.note ?? null,
    idempotencyKey: key,
  });
  if (!parsed.success) {
    return { ok: false, code: "invalid_payload", message: parsed.error.issues[0]?.message ?? "Invalid session" };
  }

  const visibleFrom = input.visibleFrom ?? null;
  const existing = await readSessionRows(client, input.threadId, visibleFrom, input.actorUserId);
  if (!existing.ok) return { ok: false, code: "db_error", message: existing.message };

  const before = partition(existing.rows);
  const projectedBefore = projectConversationSessions(before.sessions, before.transitions, input.derivedState ?? null);
  const match = projectedBefore.sessions.find(
    (s) => s.idempotencyKey === key && s.startedBy === input.actorUserId,
  );
  if (match) {
    // 200 and `duplicate: true`, not 201 and not an error. The caller asked for
    // a session with this key to exist; it does. Reporting a conflict would make
    // a correct client's retry look like a bug in the client.
    return { ok: true, duplicate: true, session: match, messageId: match.sessionId };
  }

  const validated = validateCoordinationMessage("COORDINATION_SESSION", parsed.data);
  if (!validated.ok) return { ok: false, code: "invalid_payload", message: validated.error };

  const nowIso = (input.now ?? new Date()).toISOString();
  const { data: msg, error: insErr } = await client
    .from("messages")
    .insert({
      thread_id: input.threadId,
      sender_id: input.actorUserId,
      body: JSON.stringify(validated.envelope),
      created_at: nowIso,
      msg_type: validated.msgType,
      subtype: validated.subtype,
    })
    .select("id, thread_id, sender_id, created_at, msg_type, subtype")
    .single();
  if (insErr || !msg) {
    return { ok: false, code: "db_error", message: insErr?.message ?? "Failed to open the session" };
  }

  const row = msg as any;
  const opened = projectConversationSessions(
    [toInput(row, parsed.data)],
    before.transitions,
    input.derivedState ?? null,
  );
  const session = opened.sessions[0];
  if (!session) {
    // Unreachable by construction — the row was just written and parsed from
    // the same payload this function validated. Returning an error rather than
    // asserting keeps a projection change from crashing a write path.
    return { ok: false, code: "db_error", message: "The session was written but could not be projected" };
  }

  // The thread bump is the caller's job: the two doors bump it differently (the
  // coordination route already does it for every kind) and doing it here would
  // double-write on one of them.

  void emitCoordinationStarted(client, input.threadId, {
    sessionId: session.sessionId,
    startedBy: session.startedBy,
    startedAt: session.startedAt,
    planObjectId: session.planObjectId,
  });

  return { ok: true, duplicate: false, session, messageId: String(row.id) };
}
