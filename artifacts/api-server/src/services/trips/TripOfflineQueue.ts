/**
 * Trips spec §18.2 — the offline operation queue's CONTRACT and the rule
 * that decides what a reconnecting client may replay (census-trips TR343,
 * TR349, TR451; the §23 "offline member for 6h" scenario, TR421).
 *
 *   QueuedTripOperation { operationId tripId expectedTripVersion? type
 *                         payload clientOccurredAt idempotencyKey }
 *
 * "Offline-safe operations include join/leave plan, ready/presence changes,
 * complete activity, save idea, and selected low-risk edits. Sensitive or
 * high-conflict mutations may require revalidation after reconnect."
 *
 * THE THREE DECISIONS, and why each is what it is
 * ==============================================
 *   replay      an offline-safe type. Issued to the kernel in clientOccurredAt
 *               order with the operation's own idempotencyKey, so a queue
 *               replayed twice produces one transition (§22.4, TR417) and its
 *               expectedTripVersion, so a stale edit meets TRIP_VERSION_CONFLICT
 *               rather than overwriting (§18.3 — never destructive last-write-
 *               wins; §18.4 — the server's version is canonical).
 *   revalidate  a sensitive or high-conflict type whose expectedTripVersion is
 *               not the trip's CURRENT version. The client has been away; the
 *               world may have moved; it must look again before this lands.
 *               TRIP_OFFLINE_REVALIDATION_REQUIRED, with the current version
 *               so the client can. A sensitive operation the client already
 *               revalidated (expectedTripVersion === current) replays.
 *   reject      cannot be replayed at all: a type the kernel does not have or
 *               this endpoint does not issue (a cutover-gated plan write has
 *               its own route), or a clientOccurredAt the server cannot
 *               believe — in the future, or older than the queue horizon.
 *               TRIP_OFFLINE_QUEUE_REJECTED, with the reason in words.
 *
 * PURE. The route reads the current version and issues; this file decides.
 */
import { z } from "zod";

export const QUEUE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** Clock skew a client is allowed before "occurred in the future" is refused. */
export const QUEUE_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const QUEUE_MAX_OPERATIONS = 50;

const ISO_DATETIME = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 datetime");

/** §18.2's contract, as the wire accepts it. Unknown keys are refused: a client that sends actor fields is broken, not redundant. */
export const QueuedTripOperationSchema = z.object({
  operationId: z.string().uuid(),
  tripId: z.string().uuid(),
  expectedTripVersion: z.number().int().nonnegative().nullable().optional(),
  type: z.string().min(1).max(64),
  payload: z.record(z.unknown()).default({}),
  clientOccurredAt: ISO_DATETIME,
  idempotencyKey: z.string().min(1).max(200),
}).strict();
export type QueuedTripOperation = z.infer<typeof QueuedTripOperationSchema>;

/**
 * §18.2's offline-safe list, in the kernel's vocabulary: join/leave plan,
 * attendance, presence, start/skip a plan, a vote. "Complete activity" is
 * COMPLETE_ACTIVITY, which has a legacy writer and a cutover flag and is
 * issued by its own route — a queue naming it is told so, not silently
 * dropped. "Save idea" is not a kernel command (trip_saved_places is a
 * direct write, TR350) and is told the same.
 */
export const OFFLINE_SAFE_TYPES: readonly string[] = [
  "JOIN_PLAN", "LEAVE_PLAN", "SET_PLAN_ATTENDANCE",
  "SET_PRESENCE", "CLEAR_PRESENCE",
  "START_PLAN", "SKIP_PLAN",
  "VOTE_ON_PROPOSAL",
] as const;

/**
 * §18.3 "saved ideas / reactions merge as set operations with idempotency"
 * (census-trips TR350): "save idea" is not a kernel command — trip_saved_places
 * is a set keyed (trip_id, user_id, place_id) — so the queue replays it as a
 * SET operation: SAVE_IDEA is union, UNSAVE_IDEA is difference, and applying
 * either twice yields the same set. The route performs them directly and
 * says whether the element was already present / already absent.
 */
export const SET_OPERATION_TYPES: readonly string[] = ["SAVE_IDEA", "UNSAVE_IDEA"] as const;
export const SaveIdeaPayloadSchema = z.object({
  placeId: z.string().min(1).max(300),
  placeName: z.string().min(1).max(300),
  placeType: z.string().max(100).optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  notes: z.string().max(500).optional(),
}).strict();
export const UnsaveIdeaPayloadSchema = z.object({ placeId: z.string().min(1).max(300) }).strict();

export const QUEUE_DECISIONS = ["replay", "revalidate", "reject"] as const;
export type QueueDecision = (typeof QUEUE_DECISIONS)[number];

export interface QueueClassification {
  operation: QueuedTripOperation;
  decision: QueueDecision;
  /** How a replay is performed: through the kernel, or as a §18.3 set operation. */
  via: "kernel" | "set" | null;
  reasonCode: "TRIP_OFFLINE_REVALIDATION_REQUIRED" | "TRIP_OFFLINE_QUEUE_REJECTED" | null;
  detail: string;
}

export interface QueueContext {
  /** trips.version as read at replay time — §18.4's canonical version. */
  currentTripVersion: number;
  now: number;
  /** The types the commands endpoint issues (routes/tripCommands.ts COMMANDS_ENDPOINT_TYPES). */
  issuable: ReadonlySet<string>;
  /** Cutover-gated types with their own route (routes/tripCommands.ts CUTOVER_GATED_TYPES). */
  gated: ReadonlySet<string>;
}

export function classifyQueuedOperation(op: QueuedTripOperation, ctx: QueueContext): QueueClassification {
  const reject = (detail: string): QueueClassification => ({ operation: op, decision: "reject", via: null, reasonCode: "TRIP_OFFLINE_QUEUE_REJECTED", detail });
  const occurred = Date.parse(op.clientOccurredAt);
  if (!Number.isFinite(occurred)) return reject("clientOccurredAt is not a datetime");
  if (occurred > ctx.now + QUEUE_FUTURE_SKEW_MS) return reject(`clientOccurredAt ${op.clientOccurredAt} is in the future`);
  if (ctx.now - occurred > QUEUE_HORIZON_MS) return reject(`clientOccurredAt ${op.clientOccurredAt} is older than the ${QUEUE_HORIZON_MS / 86_400_000}-day queue horizon; look at the trip again`);
  if (SET_OPERATION_TYPES.includes(op.type)) {
    const parsed = (op.type === "SAVE_IDEA" ? SaveIdeaPayloadSchema : UnsaveIdeaPayloadSchema).safeParse(op.payload);
    if (!parsed.success) return reject(`${op.type}: ${parsed.error.issues[0]?.message ?? "malformed payload"}`);
    return { operation: op, decision: "replay", via: "set", reasonCode: null, detail: `${op.type} is a §18.3 set operation; applied by identity (trip, member, place) — idempotent by construction` };
  }
  if (ctx.gated.has(op.type)) return reject(`${op.type} has a legacy writer and a flag-gated cutover; it is issued by its own route, not replayed from a queue`);
  if (!ctx.issuable.has(op.type)) return reject(`${op.type} is not a command this endpoint issues`);
  if (OFFLINE_SAFE_TYPES.includes(op.type)) {
    return { operation: op, decision: "replay", via: "kernel", reasonCode: null, detail: `${op.type} is offline-safe (§18.2); replayed with its own idempotency key${op.expectedTripVersion != null ? ` at expected version ${op.expectedTripVersion}` : ""}` };
  }
  if (op.expectedTripVersion === ctx.currentTripVersion) {
    return { operation: op, decision: "replay", via: "kernel", reasonCode: null, detail: `${op.type} is sensitive and was revalidated against the current version ${ctx.currentTripVersion}` };
  }
  return {
    operation: op, decision: "revalidate", via: null, reasonCode: "TRIP_OFFLINE_REVALIDATION_REQUIRED",
    detail: `${op.type} is a sensitive or high-conflict mutation (§18.2); the trip is at version ${ctx.currentTripVersion}${op.expectedTripVersion == null ? " and the operation names none" : ` and the operation expected ${op.expectedTripVersion}`} — look at the trip again and resend with expectedTripVersion ${ctx.currentTripVersion}`,
  };
}

/** clientOccurredAt ascending, then operationId — the order the traveller acted in, stable. */
export function orderQueuedOperations<T extends { clientOccurredAt: string; operationId: string }>(ops: readonly T[]): T[] {
  return [...ops].sort((a, b) => (Date.parse(a.clientOccurredAt) - Date.parse(b.clientOccurredAt)) || a.operationId.localeCompare(b.operationId));
}

export function classifyQueuedOperations(ops: readonly QueuedTripOperation[], ctx: QueueContext): QueueClassification[] {
  return orderQueuedOperations(ops).map((op) => classifyQueuedOperation(op, ctx));
}
