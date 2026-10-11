/**
 * Telegraph §9 Returning — SHARED TRANSPORT (census-telegraph T107): the two
 * write-side rules a ride needs that the generic coordination insert does not
 * give it.
 *
 *   1. A JOIN is refused across a block. The shared write guard
 *      (`lib/telegraphThreadWrite.ts`) checks a pairwise block only when the
 *      thread has exactly ONE other member, so in a group a member could put
 *      themselves in a car with someone they blocked, or who blocked them. A
 *      join (CONFIRMED) is checked against the proposer AND every current
 *      rider, in either direction. Leaving (DECLINED) is never checked:
 *      getting out of a ride must always work.
 *
 *   2. A PROPOSAL is idempotent. Replaying the same `ACTION_PROPOSAL` used to
 *      mint a second identical ride. A ride proposal must carry an
 *      `idempotencyKey`; it is stored in `messages.idempotency_key`, where the
 *      partial unique index `messages_idempotency_uniq` (thread_id, sender_id,
 *      idempotency_key) makes the DATABASE refuse a second row — so N
 *      simultaneous requests carrying one identity create exactly one ride. A
 *      replay, or the loser of that race (23505), is answered with the ride
 *      that exists. Any other action proposal that carries a key gets the same
 *      treatment; one without a key is unchanged.
 *
 * Both fail CLOSED: an unreadable rider list or blocks table refuses the join
 * (503, retryable), and an unreadable replay lookup is an error rather than a
 * second ride. Nothing here decides whether one person may ride several rides
 * at once — the spec does not say, and that is an owner decision (T107).
 */
import { readBlockExclusions } from "../../lib/exclusionSet.js";
import { parseKindEnvelope } from "./messageKinds.js";
import { parseCoordinationEnvelope } from "./coordination.js";
import { SHARED_RIDE_ACTION, projectSharedRides, type RideResponseRow } from "./coordinationStages.js";

export { SHARED_RIDE_ACTION };

/**
 * How many answers to a thread's action proposals the join check reads. A
 * thread with more than this many is not silently checked against a partial
 * rider list: the read is treated as truncated and the join is refused.
 */
export const RIDE_RESPONSE_SCAN_LIMIT = 500;


const RIDE_ROW_COLUMNS = "id, sender_id, created_at, msg_type, body";

export type RideRefusal = { code: "forbidden" | "degraded_unavailable"; message: string } | null;

/** The §8.1 action a proposal row carries (either carrier), or null. */
export function proposalAction(row: { msg_type?: unknown; body?: unknown } | null | undefined): string | null {
  if (!row) return null;
  const coord = parseCoordinationEnvelope(row.msg_type as string, row.body as string);
  if (coord && coord.kind === "ACTION_PROPOSAL") {
    return typeof coord.payload?.action === "string" ? coord.payload.action : null;
  }
  const env = parseKindEnvelope(row.msg_type as string, row.body as string) as { kind?: string; payload?: any } | null;
  if (env && env.kind === "ACTION") return typeof env.payload?.action === "string" ? env.payload.action : null;
  return null;
}

/**
 * Null when `joinerId` may join the ride `proposal`; otherwise the refusal.
 *
 * `client` reads the thread's answers (the caller's own RLS view of a thread it
 * is a proven member of); `blockClient` reads `blocks` through the shared
 * fail-closed helper, exactly as the write guard does.
 */
export async function rideJoinRefusal(
  client: any,
  blockClient: any,
  input: { threadId: string; joinerId: string; proposal: { id: string; sender_id: string; created_at: string } },
): Promise<RideRefusal> {
  const unavailable: RideRefusal = {
    code: "degraded_unavailable",
    message: "We could not check who is on this ride right now. Please try again shortly.",
  };
  const { data, error } = await client
    .from("messages")
    .select(RIDE_ROW_COLUMNS)
    .eq("thread_id", input.threadId)
    .eq("msg_type", "action_response")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(RIDE_RESPONSE_SCAN_LIMIT);
  if (error) return unavailable;
  const rows = (data as any[]) ?? [];
  if (rows.length >= RIDE_RESPONSE_SCAN_LIMIT) return unavailable;

  const responses: RideResponseRow[] = [];
  for (const r of rows) {
    const env = parseCoordinationEnvelope(r.msg_type, r.body);
    if (!env || env.kind !== "ACTION_RESPONSE") continue;
    if (env.payload?.actionMessageId !== input.proposal.id) continue;
    responses.push({ id: String(r.id), sender_id: String(r.sender_id), created_at: String(r.created_at), payload: env.payload });
  }
  const [ride] = projectSharedRides(
    [{ ...input.proposal, payload: { action: SHARED_RIDE_ACTION } }],
    responses,
    null,
  );
  // The proposer is checked even after withdrawing: it is still their ride.
  const among = [...new Set([input.proposal.sender_id, ...(ride?.riders ?? [])])].filter((id) => id !== input.joinerId);
  if (among.length === 0) return null;

  const blocked = await readBlockExclusions(blockClient, input.joinerId, { among });
  if (!blocked.ok) return unavailable;
  if (among.some((id) => blocked.ids.has(id))) {
    return { code: "forbidden", message: "You cannot join this ride" };
  }
  return null;
}

export type ProposalReplay =
  /**
   * `existing` is the row holding this request identity, as read
   * (REPLAY_COLUMNS), when it is a live ACTION_PROPOSAL; `foreign` is true when
   * the identity is held by something the caller must not be handed back (a
   * different kind of message, or a proposal since deleted).
   */
  | { ok: true; existing: Record<string, unknown> | null; foreign: boolean }
  | { ok: false; message: string };

const REPLAY_COLUMNS = "id, thread_id, sender_id, created_at, msg_type, subtype, deleted_at";

/**
 * The message this sender already wrote in this thread under this request
 * identity, if any — read from `messages.idempotency_key`, the column
 * `messages_idempotency_uniq` (thread_id, sender_id, idempotency_key) holds
 * unique (2810; asserted by 3748). Scoped by construction to the caller as
 * sender: another member's identical key is their own request, never this one.
 */
export async function findReplayedProposal(
  client: any,
  input: { threadId: string; senderId: string; idempotencyKey: string },
): Promise<ProposalReplay> {
  const { data, error } = await client
    .from("messages")
    .select(REPLAY_COLUMNS)
    .eq("thread_id", input.threadId)
    .eq("sender_id", input.senderId)
    .eq("idempotency_key", input.idempotencyKey)
    .limit(1);
  if (error) return { ok: false, message: error.message ?? "proposal lookup failed" };
  const r = ((data as any[]) ?? [])[0];
  if (!r) return { ok: true, existing: null, foreign: false };
  if (String(r.sender_id) !== input.senderId || String(r.thread_id) !== input.threadId) {
    return { ok: false, message: "proposal lookup returned a row outside its scope" };
  }
  if (r.msg_type !== "action_proposal" || r.deleted_at != null) return { ok: true, existing: null, foreign: true };
  return { ok: true, existing: r as Record<string, unknown>, foreign: false };
}
