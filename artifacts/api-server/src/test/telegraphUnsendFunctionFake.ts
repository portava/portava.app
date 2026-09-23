/**
 * A MODEL of `public.telegraph_unsend_message_before_seen`
 * (migrations 2325 + 3000), for tests that drive a route through a fake
 * supabase client.
 *
 * ── WHAT A MODEL PROVES, AND WHAT IT DOES NOT ───────────────────────────────
 * It reproduces the function's DECISION: the order of the checks, which fields
 * each outcome carries, and the row the successful branch writes. That is what
 * a route test needs, because a route test is about whether the route maps
 * every outcome to the right answer.
 *
 * It does NOT reproduce the LOCKS, and cannot: there is no concurrency in a
 * single-threaded fake to serialise. The locking is the entire reason the
 * function exists, and it is exercised where SQL can be — the
 * `api-server · kernel SQL executed on a throwaway database` CI job applies the
 * migration for real.
 *
 * ── KEEPING IT HONEST ───────────────────────────────────────────────────────
 * Two copies of one rule drift. This module exists so there is one copy across
 * the route suites, and `telegraphUnsendFunctionFake.test.ts` pins its outcome
 * order against the SQL text of migration 3000 itself, so a change to the
 * function that this model does not follow turns red rather than passing under
 * a model that still describes the old behaviour.
 */

export interface UnsendFakeRow {
  id: string;
  thread_id: string;
  sender_id: string;
  created_at: string;
  deleted_at?: string | null;
  unsent_at?: string | null;
  lifecycle_state?: string | null;
  body?: string | null;
}

export interface UnsendFakeMember {
  thread_id: string;
  user_id: string;
  left_at?: string | null;
  last_read_at?: string | null;
}

export interface UnsendFakeOptions {
  /** The whole call fails, the way a dropped connection or a missing function does. */
  rpcError?: boolean;
  /**
   * An error that arrives WITH a plausible success payload.
   *
   * `rpcError` alone cannot show that the caller reads `error`: it answers
   * `data: null`, which the shape check rejects anyway, so a caller that never
   * looked at `error` would still refuse and the test would pass for the wrong
   * reason. This is the injection that separates the two — the same trap PR
   * #472 recorded when its own M4 mutation survived for exactly this reason.
   */
  errorWithSuccessPayload?: boolean;
  /** An outcome no build of the route has heard of. */
  unknownOutcome?: boolean;
  /** An answer that is not an object at all. */
  shapeless?: boolean;
  /** The call throws rather than resolving. */
  throws?: boolean;
  /**
   * Pin the timestamp the successful branch writes.
   *
   * A FUNCTION, not just a string, because a pinned constant hides re-stamping:
   * a model that rewrote `unsent_at` on the already-unsent path would write the
   * same value, and an assertion that the timestamp did not move would pass
   * under it. This was measured — the retry test was green under exactly that
   * mutation until a caller could hand over a sequence.
   */
  unsentAt?: string | (() => string);
  /** Called with the message id whenever the write branch runs. */
  onWrite?: (messageId: string, unsentAt: string) => void;
}

/**
 * Build the `rpc` member of a fake client.
 *
 * `tables()` is read on every call rather than captured, so a test that mutates
 * its fixture between calls gets the mutation — the same way the real function
 * reads the table as it is when it takes the lock.
 */
export function makeUnsendFunctionFake(
  tables: () => { messages: UnsendFakeRow[]; message_thread_members: UnsendFakeMember[] },
  options: UnsendFakeOptions = {},
) {
  return async function rpc(fn: string, args: Record<string, unknown>) {
    if (fn !== "telegraph_unsend_message_before_seen") {
      return { data: null, error: { message: `rpc ${fn} is not modelled` } };
    }
    if (options.throws) throw new Error("unsend function threw");
    if (options.rpcError) return { data: null, error: { message: "unsend function blew up" } };
    if (options.errorWithSuccessPayload) {
      return {
        data: { outcome: "unsent", unsentAt: "2026-05-04T00:00:00.000Z", seenBy: 0, recipientCount: 1 },
        error: { message: "the statement failed after producing a row" },
      };
    }
    if (options.unknownOutcome) return { data: { outcome: "sideways" }, error: null };
    if (options.shapeless) return { data: "yes", error: null };

    const db = tables();
    const messageId = String(args["p_message_id"] ?? "");
    const actorId = String(args["p_actor_id"] ?? "");
    const threadId = String(args["p_thread_id"] ?? "");

    const msg = db.messages.find((m) => m.id === messageId && m.thread_id === threadId);
    if (!msg) return { data: { outcome: "not_found" }, error: null };

    // Counted once, inside the lock, and returned with every outcome below.
    const recipients = db.message_thread_members.filter(
      (m) => m.thread_id === threadId && m.user_id !== actorId && m.left_at == null,
    );
    const recipientCount = recipients.length;

    if (msg.sender_id !== actorId) {
      return { data: { outcome: "not_sender", recipientCount }, error: null };
    }

    // unsent BEFORE deleted: the write sets both, so an already-unsent row
    // carries both, and testing deleted first would call every repeat unsend a
    // delete.
    if (msg.unsent_at != null) {
      return { data: { outcome: "already_unsent", unsentAt: msg.unsent_at, recipientCount }, error: null };
    }
    if (msg.deleted_at != null) {
      return { data: { outcome: "already_deleted", recipientCount }, error: null };
    }

    const actorActive = db.message_thread_members.some(
      (m) => m.thread_id === threadId && m.user_id === actorId && m.left_at == null,
    );
    if (!actorActive) return { data: { outcome: "not_member", recipientCount }, error: null };

    const createdMs = Date.parse(String(msg.created_at));
    const seenBy = recipients.filter((m) => {
      if (!m.last_read_at) return false;
      const lr = Date.parse(String(m.last_read_at));
      return Number.isFinite(lr) && Number.isFinite(createdMs) && lr >= createdMs;
    }).length;
    if (seenBy > 0) return { data: { outcome: "seen", seenBy, recipientCount }, error: null };

    const now =
      typeof options.unsentAt === "function"
        ? options.unsentAt()
        : options.unsentAt ?? new Date().toISOString();
    msg.unsent_at = now;
    msg.deleted_at = now;
    msg.lifecycle_state = "unsent";
    msg.body = "";
    options.onWrite?.(messageId, now);
    return { data: { outcome: "unsent", unsentAt: now, seenBy: 0, recipientCount }, error: null };
  };
}

/**
 * The outcomes, in the order the function decides them.
 *
 * Pinned here so one test can check this list against the SQL rather than every
 * suite trusting the model's word for it.
 */
export const MODELLED_OUTCOME_ORDER = [
  "not_found",
  "not_sender",
  "already_unsent",
  "already_deleted",
  "not_member",
  "seen",
  "unsent",
] as const;
