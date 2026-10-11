/**
 * Telegraph §13.1 — ONE writer for an envelope message, whichever door it came
 * through.
 *
 * §13.1 names `CREATE_DECISION`, `SET_COORDINATION_STATUS` and `SHARE_LOCATION`
 * as commands. Their behaviour already shipped on two routes — the coordination
 * route (`kind: DECISION`, `kind: COORDINATION`) and the typed-message route
 * (§6.2 LOCATION with an expiry) — and census-telegraph §13.9 held T166, T169
 * and T170 at W because the §13.1 command bus did not issue them. T168
 * (`CREATE_COORDINATION_SESSION`) set the precedent for closing that: two doors,
 * ONE writer, so the bus cannot drift from the route on any rule.
 *
 * This module is that writer for the three. Both doors validate with the same
 * validator, run the same shared write guard BEFORE calling here (the guard is
 * the caller's job, as it is for `coordinationSessions.ts`; the door suite checks
 * the callers), and then this module writes the row, bumps the thread and
 * publishes `message.created` — and, for a scoped location share, §13.2's
 * `location.started`. Neither door has an insert of its own any more.
 *
 * `checkLocationShareWindow` is the expiry rule both doors apply before the
 * guard (a refusal for an impossible expiry must not spend the sender's burst
 * allowance), moved here unchanged from `routes/telegraphKinds.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitLocationStarted, publishToThread } from "../../lib/telegraphEvents.js"; import { publishMessageCreated } from "../../lib/telegraphOutboxDrainScheduler.js"; // census-telegraph T154 (V-TR F1)
import { MAX_LOCATION_SHARE_HOURS, validateKindMessage } from "./messageKinds.js";
import { validateCoordinationMessage } from "./coordination.js";

export interface LocationShareWindow {
  expiresAt: string;
  precision: string;
  purpose: string | null;
}

export type LocationShareCheck =
  | { ok: true; share: LocationShareWindow | null }
  | { ok: false; message: string };

/**
 * §12 `location_shares` — an EXPIRY that is a real bound.
 *
 * Two refusals and they are different mistakes. An expiry already in the past
 * is a share that was never live: the sweep's window would never contain it, so
 * `location.started` would be emitted for a capability that ends before anybody
 * sees it and `location.expired` would never follow — a live chip nothing ever
 * takes down. An expiry beyond the ceiling is an unbounded share wearing a
 * timestamp, which is the thing §15.1 exists to refuse. A LOCATION payload with
 * no expiry is a pin — somebody sending an address — and has no window at all.
 */
export function checkLocationShareWindow(
  kind: string,
  payload: { expiresAt?: string | null; precision?: string; purpose?: string | null } | null | undefined,
  nowMs: number,
): LocationShareCheck {
  if (kind !== "LOCATION") return { ok: true, share: null };
  const lp = payload ?? {};
  if (typeof lp.expiresAt !== "string" || lp.expiresAt.length === 0) return { ok: true, share: null };
  const endsMs = Date.parse(lp.expiresAt);
  if (!Number.isFinite(endsMs)) return { ok: false, message: "expiresAt must be an ISO timestamp" };
  if (endsMs <= nowMs) {
    return {
      ok: false,
      message:
        "expiresAt is already past. A share that has expired before it is posted is never live, " +
        "so nothing would ever take it down.",
    };
  }
  if (endsMs > nowMs + MAX_LOCATION_SHARE_HOURS * 3600_000) {
    return {
      ok: false,
      message:
        `A scoped location share may run for at most ${MAX_LOCATION_SHARE_HOURS} hours (§15.1). ` +
        "A longer one is an unbounded capability with a timestamp on it.",
    };
  }
  return {
    ok: true,
    share: { expiresAt: lp.expiresAt, precision: String(lp.precision ?? "area"), purpose: lp.purpose ?? null },
  };
}

export interface ThreadEnvelopeWrite {
  threadId: string;
  /** The actor, from the verified token. Never from a body. */
  senderId: string;
  /** The validated envelope, written as the message body. */
  envelope: unknown;
  msgType: string;
  subtype: string | null;
  /** ONE clock read per request, supplied by the caller (`splitClockGuard`). */
  nowMs: number;
  /** Present for a scoped LOCATION share: emits §13.2 `location.started` after the write. */
  locationShare?: LocationShareWindow | null;
}

export interface WrittenEnvelopeRow {
  id: string;
  thread_id: string;
  sender_id: string;
  created_at: string;
  msg_type: string;
  subtype: string | null;
}

export type ThreadEnvelopeWriteResult =
  | { ok: true; row: WrittenEnvelopeRow }
  | { ok: false; message: string };

export interface EnvelopeWriteLog {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Write one envelope message, bump the thread, publish what happened.
 *
 * Does NOT authorize: the caller has run `guardTelegraphThreadWrite`. A failed
 * insert is a failure the caller answers as one; a failed thread bump is logged
 * and does not undo a message that was written.
 */
export async function writeThreadEnvelope(
  client: SupabaseClient,
  input: ThreadEnvelopeWrite,
  log: EnvelopeWriteLog,
): Promise<ThreadEnvelopeWriteResult> {
  const now = new Date(input.nowMs).toISOString();
  const { data: msg, error: msgErr } = await client
    .from("messages")
    .insert({
      thread_id: input.threadId,
      sender_id: input.senderId,
      body: JSON.stringify(input.envelope),
      created_at: now,
      msg_type: input.msgType,
      subtype: input.subtype,
    })
    .select("id, thread_id, sender_id, created_at, msg_type, subtype")
    .single();
  if (msgErr || !msg) return { ok: false, message: msgErr?.message ?? "Failed to write the message" };

  const { error: bumpErr } = await client
    .from("message_threads")
    .update({ last_message_at: now, updated_at: now })
    .eq("id", input.threadId);
  if (bumpErr) log.warn({ err: bumpErr, threadId: input.threadId }, "thread bump after envelope write failed (message was written)");

  const m = msg as unknown as WrittenEnvelopeRow;
  void publishMessageCreated(client, input.threadId, { // T154 (V-TR F1): the drainer owns message.created when fan-out is in force
    type: "message.created",
    payload: { messageId: m.id, senderId: m.sender_id, msgType: m.msg_type, subtype: m.subtype, createdAt: m.created_at },
  });

  // §13.2 `location.started`. Only for a share with an expiry: the payload
  // carries the precision and the window and NEVER a coordinate.
  if (input.locationShare) {
    void emitLocationStarted(client, input.threadId, {
      shareId: String(m.id),
      ownerUserId: String(m.sender_id),
      precision: input.locationShare.precision,
      purpose: input.locationShare.purpose,
      startedAt: String(m.created_at),
      expiresAt: input.locationShare.expiresAt,
    });
  }
  return { ok: true, row: m };
}

// ── the §13.1 bus's three envelope commands ─────────────────────────────────

/**
 * §13.1 commands whose canonical write is an envelope message, and the kind
 * each one writes. The kind is the SAME one the route door accepts, validated
 * by the SAME validator — the bus cannot accept a payload the route refuses.
 */
export const ENVELOPE_COMMAND_KINDS = {
  CREATE_DECISION: "DECISION",
  SET_COORDINATION_STATUS: "COORDINATION",
  SHARE_LOCATION: "LOCATION",
} as const;
export type EnvelopeCommand = keyof typeof ENVELOPE_COMMAND_KINDS;

export function isEnvelopeCommand(type: string): type is EnvelopeCommand {
  return Object.prototype.hasOwnProperty.call(ENVELOPE_COMMAND_KINDS, type);
}

export type EnvelopeCommandPlan =
  | {
      ok: true;
      kind: string;
      envelope: unknown;
      msgType: string;
      subtype: string | null;
      locationShare: LocationShareWindow | null;
    }
  | { ok: false; message: string };

/**
 * Validate one envelope command's params into the row the shared writer will
 * write, or refuse. Pure: no client, no clock but the one passed in.
 *
 * SHARE_LOCATION is §13.1's SHARE, not a pin: params without an `expiresAt`
 * are refused here, because a LOCATION with no window is somebody sending an
 * address — it has no lifecycle, nothing ends it, and §13.2's
 * `location.started` would be meaningless about it. A pin is still sent with
 * POST /threads/:id/typed-messages.
 */
export function planEnvelopeCommand(
  type: EnvelopeCommand,
  params: Record<string, unknown>,
  nowMs: number,
): EnvelopeCommandPlan {
  const kind = ENVELOPE_COMMAND_KINDS[type];
  if (kind === "LOCATION") {
    const v = validateKindMessage("LOCATION", params);
    if (!v.ok) return { ok: false, message: v.error };
    const payload = (v.envelope as { payload?: { expiresAt?: string | null; precision?: string; purpose?: string | null } }).payload;
    const window = checkLocationShareWindow("LOCATION", payload, nowMs);
    if (!window.ok) return { ok: false, message: window.message };
    if (!window.share) {
      return {
        ok: false,
        message:
          "SHARE_LOCATION needs an expiresAt: a location with no window is a pin, not a share. " +
          "Send a pin with POST /threads/:threadId/typed-messages.",
      };
    }
    return { ok: true, kind, envelope: v.envelope, msgType: v.msgType, subtype: v.subtype, locationShare: window.share };
  }
  const v = validateCoordinationMessage(kind, params);
  if (!v.ok) return { ok: false, message: v.error };
  return { ok: true, kind, envelope: v.envelope, msgType: v.msgType, subtype: v.subtype, locationShare: null };
}
