/**
 * The gates every Telegraph write into `messages` passes through.
 *
 * Extracted so every door applies the SAME checks with the same posture as the
 * ordinary send path in `routes/messaging.ts`. A second write endpoint that
 * skipped one of them would be a weaker door into the same table — and the
 * block guard is the one that matters most, because blocking deliberately does
 * not close an existing thread and is re-checked per send instead.
 *
 * SIX gates (four until the §22 burst limit joined them — it had been on the
 * text door alone, so every other door was unlimited — and five until the
 * OD-TRUST-5 restriction gate joined them):
 *   1. `disable_messaging` kill switch — fail CLOSED on a read error AND on an
 *      absent service client, the same fact (`messagingStopUnknownRefusal`).
 *   2. ACTIVE membership (`left_at IS NULL`).
 *   3. 1:1 block guard. An unreadable roster must NOT read as "this is a group
 *      thread, skip the check": that is how a fail-closed guard becomes
 *      unreachable, and `routes/messaging.ts` records the day it happened.
 *   4. E2EE refusal. An E2EE thread's promise is that the server never stores
 *      plaintext; a structured envelope IS plaintext, so it is refused by name.
 *  4b. The trip's record (census-trips §86): in a `trip` thread, a member whose
 *      access was restored to the trip's retained record only writes nothing
 *      (`retainedTripThreadRefusal`); a safety send is never refused.
 *   5. Trust restriction (OD-TRUST-5), decided by
 *      `domain/telegraph/policies/restrictionSendPolicy.ts` — the SAME function
 *      the capabilities projection reads. A `safety` send is never refused by it;
 *      an unreadable restriction state refuses as retryable, never as restricted.
 *   6. §22's adaptive send rate limit, LAST, so a send refused by 1–5 never
 *      spends the sender's allowance. See `sendRateRefusal` at the end of file.
 */
import type { SupabaseClient } from "@supabase/supabase-js"; import { sendLimiterId, type SendBucket } from "../domain/telegraph/policies/messageDoorPolicy.js";
import { getServiceClient } from "./supabase.js"; import { checkSendRateLimit, SEND_LIMITS, SEND_WINDOW_MS } from "../domain/telegraph/policies/sendRateLimit.js";
import { isKillSwitchEngaged } from "./featureFlags.js"; import { checkRateLimit } from "./rateLimit.js";
import { isBlockedBetween } from "./blockGuard.js"; import { sendError } from "./http.js"; import { readRetainedAccess, RETAINED_ACCESS_UNCHECKABLE_MESSAGE } from "./tripRetainedRecordGuard.js"; import { RETAINED_RECORD_ONLY_MESSAGE } from "./tripTrustGate.js";
import { decideRestrictedSend, readRestrictionSendFacts, RESTRICTION_SEND_SCOPE, RESTRICTION_UNKNOWN_MESSAGE } from "../domain/telegraph/policies/restrictionSendPolicy.js"; import { getRestrictionState } from "../services/trust/TrustRestrictionService.js"; import type { TelegraphReason } from "../domain/telegraph/contracts/telegraphReasonCodes.js";

export type ThreadWriteRefusal =
  | "feature_disabled"
  | "forbidden"
  | "degraded_unavailable"
  | "e2ee_thread" | "rate_limited"
  /** census-trips §86: the sender's access to the thread's trip was restored to its record only. */
  | "trip_record_read_only";

export type ThreadWriteGuard =
  | { ok: true; otherMemberIds: string[] }
  | { ok: false; code: ThreadWriteRefusal; message: string; retryAfterMs?: number; /** Set by the restriction gate only, so a door can tell "restricted" from "not a member". */ reason?: TelegraphReason };

/**
 * The refusal for a flag client we do not have.
 *
 * `if (flagSc && await isKillSwitchEngaged(...))` READS as fail-closed and is
 * not. Both operands of that `&&` are the same fact — the stop's state could not
 * be established — and only one of them was treated that way: an unreadable
 * `feature_flags` table engages the stop, while an absent service client
 * short-circuits the entire gate away and the write proceeds. That is the stop
 * disengaging at exactly the moment an operator is reaching for it.
 *
 * The upload door on `routes/telegraphVoice.ts` already refused this case with
 * `server_not_configured`; the send door did not, so a deployment missing
 * `SUPABASE_SERVICE_ROLE_KEY` could not upload a voice note but could write
 * every other typed message past a stop nobody could read.
 *
 * WHY `degraded_unavailable` AND NOT `feature_disabled`. "Messaging is
 * temporarily disabled" is a claim that an operator engaged a stop. Nobody did;
 * we could not look. The two are different sentences to the person holding the
 * phone — one is policy, the other is retryable — and this file's whole subject
 * is not collapsing sentences like that into one.
 *
 * THE COST, SAID OUT LOUD: a deployment with no service role key now refuses
 * every Telegraph typed / voice / share / coordination write instead of serving
 * them past an unreadable stop. That is a misconfiguration and not a supported
 * mode — but it is a behaviour change, and it belongs in the open rather than in
 * a changelog nobody reads.
 *
 * Exported as a predicate rather than inlined because it is a RULE, and a rule
 * that only exists inside an `if` cannot be asserted without standing up a
 * process with the environment stripped.
 */
export function messagingStopUnknownRefusal(
  flagSc: unknown,
): { ok: false; code: Extract<ThreadWriteRefusal, "degraded_unavailable">; message: string } | null {
  if (flagSc) return null;
  return {
    ok: false,
    code: "degraded_unavailable",
    message: "We could not check whether messaging is available right now. Please try again shortly.",
  };
}

export async function guardTelegraphThreadWrite(
  client: SupabaseClient,
  threadId: string,
  userId: string,
  opts: {
    sendBucket?: SendBucket;
    /**
     * A send safety needs (the §6.2 SAFETY kind, the NEED_HELP quick state). The
     * restriction gate never refuses it and does not even read the restriction.
     * Defaults to true exactly when the send is counted in the safety bucket.
     */
    safety?: boolean;
  } = {},
): Promise<ThreadWriteGuard> {
  const flagSc = getServiceClient();
  const stopUnknown = messagingStopUnknownRefusal(flagSc);
  if (stopUnknown) return stopUnknown;
  if (await isKillSwitchEngaged(flagSc, "disable_messaging")) {
    return { ok: false, code: "feature_disabled", message: "Messaging is temporarily disabled" };
  }

  const { data: membership, error: mErr } = await client
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .is("left_at", null)
    .maybeSingle();
  if (mErr) {
    return {
      ok: false,
      code: "degraded_unavailable",
      message: "We could not verify this conversation right now. Please try again shortly.",
    };
  }
  if (!membership) return { ok: false, code: "forbidden", message: "Not a member of this thread" };

  const { data: others, error: oErr } = await client
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .is("left_at", null)
    .neq("user_id", userId);
  if (oErr) {
    return {
      ok: false,
      code: "degraded_unavailable",
      message: "We could not verify this conversation right now. Please try again shortly.",
    };
  }
  const otherMemberIds = ((others as any[]) ?? []).map((m) => m.user_id as string).filter(Boolean);
  if (otherMemberIds.length === 1 && otherMemberIds[0]) {
    const blockSc = getServiceClient() ?? client;
    if (await isBlockedBetween(blockSc, userId, otherMemberIds[0])) {
      return { ok: false, code: "forbidden", message: "You cannot message this user" };
    }
  }

  const { data: meta, error: metaErr } = await client
    .from("message_threads")
    .select("is_e2ee, thread_type, trip_id")
    .eq("id", threadId)
    .maybeSingle();
  if (metaErr) {
    return {
      ok: false,
      code: "degraded_unavailable",
      message: "We could not verify this conversation right now. Please try again shortly.",
    };
  }
  if ((meta as any)?.is_e2ee === true) {
    return {
      ok: false,
      code: "e2ee_thread",
      message: "This conversation is end-to-end encrypted; structured messages cannot be sent into it yet",
    };
  }

  // 4b. The trip's record (census-trips §86): a member whose access to the
  // thread's trip was restored to its retained record only reads the thread and
  // writes nothing into it — but a safety send is never refused.
  const retained = await retainedTripThreadRefusal(flagSc ?? client, userId, meta as { thread_type?: unknown; trip_id?: unknown } | null, {
    safety: opts.safety ?? opts.sendBucket === "safety",
  });
  if (retained) return retained;

  // 5. Trust restriction (OD-TRUST-5). One decision, shared with the projection.
  const restrictionVerdict = decideRestrictedSend(
    await readRestrictionSendFacts(flagSc ?? client, {
      threadId,
      senderId: userId,
      threadType: ((meta as { thread_type?: unknown } | null)?.thread_type as string | undefined) ?? null,
      otherMemberIds,
      safety: opts.safety ?? opts.sendBucket === "safety",
    }),
    { safety: opts.safety ?? opts.sendBucket === "safety" },
  );
  if (!restrictionVerdict.allowed) {
    return {
      ok: false,
      code: restrictionVerdict.refusal === "unknown" ? "degraded_unavailable" : "forbidden",
      message: restrictionVerdict.message,
      reason: restrictionVerdict.reason,
    };
  }

  // 6. The burst limit, last. Everything above is a reason this sender may not
  // write HERE; this is a reason they may not write YET, and a send that was
  // never going to be admitted must not cost them one they are entitled to.
  const rate = await sendRateRefusal(flagSc ?? client, userId, opts.sendBucket ?? "ordinary");
  if (rate) return rate;

  return { ok: true, otherMemberIds };
}

/* ───────────────────────────── the §22 rate gate ─────────────────────────────
 *
 * `domain/telegraph/policies/sendRateLimit.ts` is the limiter and
 * `routes/messaging.ts` was its only caller: the TEXT door. census T279 graded
 * §22's adaptive limit C on that one call, and it was true of that one door. The
 * media door in the same file, and the four doors behind the guard above — typed
 * kinds, voice, share, coordination — had no limit at all, so the burst the
 * limiter was written to stop ("a compromised account fanning a scam across a
 * hundred threads, a script") only had to choose a different endpoint.
 *
 * ONE BUCKET, NOT ONE PER DOOR. Every ordinary door counts against the id the
 * text door already uses. A bucket per door would have multiplied the allowance
 * by the number of doors, which is the same defect with a limit on it.
 */

export type SendRateRefusal = { ok: false; code: "rate_limited"; message: string; retryAfterMs: number };

/** The words the text door has always used, so one refusal reads the same at every door. */
const SEND_RATE_MESSAGE = "You are sending messages very quickly. Please wait a moment.";

/**
 * The strictest tier's bucket, decided without reading anything.
 *
 * `checkSendRateLimit` already falls to this tier when an input RESOLVES with an
 * error. This is the same answer for the case it cannot see: a read that THROWS.
 */
export function strictestSendRate(userId: string, bucket: SendBucket): { allowed: boolean; retryAfterMs: number } {
  return checkRateLimit(sendLimiterId(bucket, "stranger"), userId, SEND_LIMITS.stranger, SEND_WINDOW_MS);
}

/**
 * Count one send against the sender's burst allowance; a refusal if it is spent.
 *
 * NEVER FAILS OPEN, AND NEVER FAILS SHUT. A throwing tier read is not "no
 * limit" — that would switch the abuse control off during exactly the minutes
 * an attacker would like it off — and it is not a refusal either, because the
 * strictest tier is still twenty messages in ten minutes: a pause, not a wall.
 */
export async function sendRateRefusal(
  sc: SupabaseClient,
  userId: string,
  bucket: SendBucket = "ordinary",
): Promise<SendRateRefusal | null> {
  let verdict: { allowed: boolean; retryAfterMs: number };
  try {
    verdict = await checkSendRateLimit(sc, userId, undefined, bucket);
  } catch {
    // The tier could not be established at all. Strictest tier, same bucket.
    verdict = strictestSendRate(userId, bucket);
  }
  if (verdict.allowed) return null;
  return { ok: false, code: "rate_limited", message: SEND_RATE_MESSAGE, retryAfterMs: verdict.retryAfterMs };
}

/**
 * Write a guard refusal to the response.
 *
 * Exists for one header. A 429 without `Retry-After` tells a client it was
 * refused and not when to come back, and a client that does not know retries
 * at once — which is the burst again. Every other refusal is `sendError` exactly
 * as each door called it before.
 */
export function sendThreadWriteRefusal(
  res: Parameters<typeof sendError>[0],
  refusal: { code: ThreadWriteRefusal; message: string; retryAfterMs?: number },
): void {
  if (refusal.code === "rate_limited") {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((refusal.retryAfterMs ?? 0) / 1000))));
  }
  if (refusal.code === "trip_record_read_only") {
    res.status(403).json({ error: "trip_record_read_only", message: refusal.message });
    return;
  }
  sendError(res, refusal.code, refusal.message);
}

/**
 * census-trips §86 (wave 5 item 5). The owner's ruling (2026-10-04): "if a trip
 * has ended, restore access to its retained record only." 3974 stamps such a
 * membership `trip_members.permissions.access = 'retained_record_only'`, and
 * groupChatSync keeps that person in the trip's thread (they are an accepted
 * member) — so they can read it, and until this gate could also write into it.
 * Refuses every write into a `trip` thread by such a member with
 * `trip_record_read_only`; a safety send is never refused and reads nothing.
 * The thread row the caller already read is passed in; an unreadable access row
 * refuses as "try again" (degraded_unavailable), never as a pass.
 */
export async function retainedTripThreadRefusal(
  sc: SupabaseClient,
  senderId: string,
  thread: { thread_type?: unknown; trip_id?: unknown } | null,
  opts: { safety: boolean },
): Promise<{ ok: false; code: ThreadWriteRefusal; message: string } | null> {
  if (opts.safety) return null;
  if (thread?.thread_type !== "trip" || typeof thread.trip_id !== "string" || thread.trip_id === "") return null;
  const access = await readRetainedAccess(sc, thread.trip_id, senderId);
  if (access === "unread") return { ok: false, code: "degraded_unavailable", message: RETAINED_ACCESS_UNCHECKABLE_MESSAGE };
  if (access === "retained_record_only") return { ok: false, code: "trip_record_read_only", message: RETAINED_RECORD_ONLY_MESSAGE };
  return null;
}

/**
 * The same gate for the two doors in `routes/messaging.ts` that carry their own
 * copies of the others (text, media). Reads the thread row itself. True when it
 * has ANSWERED the request.
 */
export async function refuseRetainedTripThreadSend(
  res: Parameters<typeof sendError>[0],
  sc: SupabaseClient,
  threadId: string,
  senderId: string,
): Promise<boolean> {
  const { data: thread, error } = await sc.from("message_threads").select("thread_type, trip_id").eq("id", threadId).maybeSingle();
  if (error) {
    sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
    return true;
  }
  const refusal = await retainedTripThreadRefusal(sc, senderId, (thread ?? null) as { thread_type?: unknown; trip_id?: unknown } | null, { safety: false });
  if (!refusal) return false;
  sendThreadWriteRefusal(res, refusal);
  return true;
}

/**
 * The rate gate for a door that carries its own copies of the other four — the
 * media door in `routes/messaging.ts`. Returns true when it has ANSWERED the
 * request, so the caller's whole use of it is `if (await …) return;`.
 */
export async function refuseSendOverRate(
  req: { log?: { warn: (...args: any[]) => unknown } },
  res: Parameters<typeof sendError>[0],
  sc: SupabaseClient,
  userId: string,
  threadId: string,
  bucket: SendBucket = "ordinary",
): Promise<boolean> {
  const refusal = await sendRateRefusal(sc, userId, bucket);
  if (!refusal) return false;
  req.log?.warn({ userId, threadId, bucket }, "telegraph send rate limit reached");
  sendThreadWriteRefusal(res, refusal);
  return true;
}

/** Re-exported so the text door takes its whole door policy from one module. */
export { resolveClientDiscriminator } from "../domain/telegraph/policies/messageDoorPolicy.js";

/* ─────────────────────── the restriction gate, for the inline doors ───────────────────────
 *
 * The text and media doors in `routes/messaging.ts` carry their own copies of
 * the other gates (they accept ciphertext, which the shared guard refuses), so
 * they take this one as a call, like `refuseSendOverRate`. It is the SAME
 * decision the shared guard and the capabilities projection take
 * (`decideRestrictedSend` over `readRestrictionSendFacts`); only the reads are
 * ordered for a door that has not loaded the thread: the restriction state
 * first, and the thread's shape only when a restriction could apply to it.
 * A person with no restriction pays one read.
 *
 * Returns true when it has ANSWERED the request.
 */
export async function refuseRestrictedSend(
  req: { log?: { warn: (...args: any[]) => unknown } },
  res: Parameters<typeof sendError>[0],
  sc: SupabaseClient,
  threadId: string,
  senderId: string,
): Promise<boolean> {
  const restriction = await getRestrictionState(sc, senderId);
  const mayApply =
    restriction.degradedReason === "fail_closed" ||
    restriction.activeRestrictions.some((t) => RESTRICTION_SEND_SCOPE[t] !== "none");
  if (!mayApply) return false;

  const [{ data: thread, error: threadErr }, { data: others, error: othersErr }] = await Promise.all([
    sc.from("message_threads").select("thread_type").eq("id", threadId).maybeSingle(),
    sc.from("message_thread_members").select("user_id").eq("thread_id", threadId).is("left_at", null).neq("user_id", senderId),
  ]);
  if (threadErr || othersErr) {
    sendError(res, "degraded_unavailable", RESTRICTION_UNKNOWN_MESSAGE);
    return true;
  }
  const verdict = decideRestrictedSend(
    await readRestrictionSendFacts(sc, {
      threadId,
      senderId,
      threadType: ((thread as { thread_type?: unknown } | null)?.thread_type as string | undefined) ?? null,
      otherMemberIds: ((others as Array<{ user_id?: unknown }>) ?? []).map((m) => String(m.user_id)),
      safety: false,
      restriction,
    }),
    { safety: false },
  );
  if (verdict.allowed) return false;
  req.log?.warn({ senderId, threadId, refusal: verdict.refusal }, "telegraph send refused by the restriction gate");
  sendError(res, verdict.refusal === "unknown" ? "degraded_unavailable" : "forbidden", verdict.message);
  return true;
}
