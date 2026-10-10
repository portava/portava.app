/**
 * Telegraph §13.3 outbox drainer — the consumer 2810 deliberately did not build
 * (census-telegraph T154, T196, T376; migration 3655).
 *
 * WHAT IT CONSUMES, STATED PRECISELY so this does not become a stale claim:
 *   message.sent      → the realtime fan-out (`message.created`) the send route
 *                       used to publish after its response. With the flag ON the
 *                       route stops publishing it and nudges this drainer
 *                       instead, so the event is delivered FROM the row written
 *                       in the message's own transaction.
 *   message.edited / .unsent / .deleted
 *                     → acked `route_direct`: their routes still publish their
 *                       own events directly; the row is the durable record.
 *                       Saying so is the point of the disposition column — an
 *                       ack that claimed a projection ran when none did is the
 *                       "half-built drainer" 2810's header warned against.
 * There is no message PUSH notification anywhere in this tree (only @mention
 * notifications, which the send route still issues), so there is no push
 * consumer here: inventing one would be a product decision, not a reliability
 * mechanism (reported as an owner decision).
 *
 * THE FLAG: telegraph_outbox_fanout_enabled (3655, seeded FALSE) AND
 * telegraph_message_kernel_enabled. Both must be on — the kernel flag is what
 * makes 2810's trigger write a row. Each read false on error, so a
 * flag outage leaves the route publishing directly (the pre-3655 behaviour).
 *
 * ORDER, IDEMPOTENCY, FAILURE
 *   - claim → work → ack. A crash between work and ack redelivers; every event
 *     carries the messageId (clients dedupe on it) and the dedupe_key.
 *   - a message that is gone or retracted (deleted_at set: delete and unsend
 *     both set it) before fan-out is acked `message_absent` and announced to
 *     NOBODY — an unsend that beats the drainer is not undone by it.
 *   - an unreadable message or an unreadable audience is `fail`ed (lease
 *     released, attempts already counted at claim) and retried; at max attempts
 *     the row stays for triage, never silently acked.
 *   - the payload carries no body (2810's rule, kept here).
 *
 * CADENCE: a 5-second fallback loop plus `requestTelegraphOutboxDrain()`, which
 * the send route calls after its insert so delivery latency is one pass, not
 * one interval. The loop is the durability: a nudge lost to a crash is picked
 * up by the next tick on any instance (SKIP LOCKED keeps instances disjoint).
 *
 * HEALTH: GET /healthz/schedulers job "telegraphOutboxDrain" (lastAttemptAt /
 * lastSuccessAt / consecutiveFailures), and public.job_health row
 * "telegraphOutboxDrain" — written at most once a minute, only while the flag
 * is on (an OFF tick is not an attempt and writes nothing, the redrive rule).
 * Loop: generation counter (PR #652's pattern).
 */
import { getServiceClient } from "./supabase.js";
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
import { publishToThread, type PublishOutcome } from "./telegraphEvents.js";

export const JOB_KEY = "telegraphOutboxDrain";
export const OUTBOX_FANOUT_FLAG = "telegraph_outbox_fanout_enabled";
export const TELEGRAPH_OUTBOX_INTERVAL_MS = 5_000;
export const TELEGRAPH_OUTBOX_BATCH = 100;
export const TELEGRAPH_OUTBOX_LEASE_SECONDS = 60;
export const TELEGRAPH_OUTBOX_MAX_ATTEMPTS = 8;
const STARTUP_DELAY_MS = 30_000;
const HEALTH_PERSIST_EVERY_MS = 60_000;

/**
 * Is outbox fan-out in force? ONE read of both flags; false on any error or
 * absence — the safe direction is "the route publishes directly", which is
 * what every deployment did before 3655.
 */
export async function outboxFanoutInForce(sc: any): Promise<boolean> {
  const [fanout, kernel] = await Promise.all([
    isFlagEnabled(sc, "telegraph_outbox_fanout_enabled"),
    isFlagEnabled(sc, "telegraph_message_kernel_enabled"),
  ]);
  return fanout && kernel;
}

export interface OutboxClaimRow {
  id: string;
  event_type: string;
  conversation_id: string;
  message_id: string | null;
  sequence: number | string | null;
  actor_id: string | null;
  dedupe_key: string;
  created_at: string;
  attempts: number;
}

export interface TelegraphOutboxDrainResult {
  outcome: "drained" | "idle" | "off" | "failed";
  reason: "no_client" | "claim_failed" | "ack_failed" | "threw" | null;
  claimed: number;
  fannedOut: number;
  routeDirect: number;
  absent: number;
  failed: number;
}

const empty = (outcome: TelegraphOutboxDrainResult["outcome"], reason: TelegraphOutboxDrainResult["reason"] = null): TelegraphOutboxDrainResult =>
  ({ outcome, reason, claimed: 0, fannedOut: 0, routeDirect: 0, absent: 0, failed: 0 });

type Disposition = "fanned_out" | "route_direct" | "message_absent";

/** Fan one message.sent row out. Returns the disposition, or a failure class to record. */
async function consumeMessageSent(
  db: any,
  row: OutboxClaimRow,
  publish: typeof publishToThread,
): Promise<{ ack: Disposition } | { fail: string }> {
  if (!row.message_id) return { ack: "message_absent" };
  const { data: msg, error } = await db
    .from("messages")
    .select("id, thread_id, sender_id, msg_type, subtype, created_at, client_message_id, deleted_at")
    .eq("id", row.message_id)
    .maybeSingle();
  if (error) return { fail: "message_unreadable" };
  if (!msg || (msg as any).deleted_at) return { ack: "message_absent" };
  const m = msg as Record<string, any>;
  if (m.thread_id !== row.conversation_id) return { fail: "conversation_mismatch" };
  const outcome: PublishOutcome = await publish(
    db,
    row.conversation_id,
    {
      type: "message.created",
      payload: {
        messageId: m.id,
        senderId: m.sender_id,
        msgType: m.msg_type ?? "text",
        subtype: m.subtype ?? null,
        createdAt: m.created_at,
        clientId: m.client_message_id ?? null,
        sequence: row.sequence === null || row.sequence === undefined ? null : Number(row.sequence),
        dedupeKey: row.dedupe_key,
      },
    },
    { excludeUserId: m.sender_id ?? row.actor_id ?? undefined },
  );
  if (outcome === "audience_unreadable") return { fail: "audience_unreadable" };
  return { ack: "fanned_out" };
}

/** One drain pass. Never throws. */
export async function runTelegraphOutboxDrainPass(
  opts: { client?: any; limit?: number; publish?: typeof publishToThread } = {},
): Promise<TelegraphOutboxDrainResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return empty("failed", "no_client");
  try {
    if (!(await outboxFanoutInForce(db))) return empty("off");
    const { data, error } = await db.rpc("telegraph_outbox_claim", {
      p_limit: opts.limit ?? TELEGRAPH_OUTBOX_BATCH,
      p_lease_seconds: TELEGRAPH_OUTBOX_LEASE_SECONDS,
      p_max_attempts: TELEGRAPH_OUTBOX_MAX_ATTEMPTS,
    });
    if (error || !Array.isArray(data)) {
      logger.warn({ err: error }, "telegraph outbox drain: claim FAILED — nothing consumed, not 'nothing to consume'");
      return empty("failed", "claim_failed");
    }
    const rows = data as OutboxClaimRow[];
    if (rows.length === 0) return empty("idle");

    const result: TelegraphOutboxDrainResult = { ...empty("drained"), claimed: rows.length };
    const acks: Record<Disposition, string[]> = { fanned_out: [], route_direct: [], message_absent: [] };
    const publish = opts.publish ?? publishToThread;
    for (const row of rows) {
      let decision: { ack: Disposition } | { fail: string };
      try {
        decision = row.event_type === "message.sent"
          ? await consumeMessageSent(db, row, publish)
          : { ack: "route_direct" };
      } catch {
        decision = { fail: "consumer_threw" };
      }
      if ("fail" in decision) {
        result.failed += 1;
        const { error: failErr } = await db.rpc("telegraph_outbox_fail", { p_id: row.id, p_error: decision.fail });
        if (failErr) logger.warn({ err: failErr, outboxId: row.id }, "telegraph outbox drain: could not record a failure (the lease expires instead)");
        continue;
      }
      acks[decision.ack].push(row.id);
    }
    for (const disposition of Object.keys(acks) as Disposition[]) {
      const ids = acks[disposition];
      if (ids.length === 0) continue;
      const { data: n, error: ackErr } = await db.rpc("telegraph_outbox_ack", { p_ids: ids, p_disposition: disposition });
      if (ackErr) {
        logger.warn({ err: ackErr, disposition, count: ids.length }, "telegraph outbox drain: ack FAILED — rows will be redelivered after the lease");
        return { ...result, outcome: "failed", reason: "ack_failed" };
      }
      const acked = typeof n === "number" ? n : 0;
      if (disposition === "fanned_out") result.fannedOut += acked;
      else if (disposition === "route_direct") result.routeDirect += acked;
      else result.absent += acked;
    }
    if (result.failed > 0) result.outcome = "failed";
    return result;
  } catch (err) {
    logger.warn({ err }, "telegraph outbox drain pass threw");
    return empty("failed", "threw");
  }
}

export interface TelegraphOutboxDrainStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastResult: TelegraphOutboxDrainResult | null;
}

const _status: TelegraphOutboxDrainStatus = { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null };
let _lastPersistMs = 0;

export function getTelegraphOutboxDrainStatus(): Readonly<TelegraphOutboxDrainStatus> {
  return { ..._status };
}

/** Test seam. */
export function _resetTelegraphOutboxDrainStatus(): void {
  Object.assign(_status, { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null });
  _lastPersistMs = 0;
}

/** One tick: the pass, its status, and (flag on, throttled) the job_health row. Never throws. */
export async function runTelegraphOutboxDrainTick(
  opts: { client?: any; now?: Date; publish?: typeof publishToThread } = {},
): Promise<TelegraphOutboxDrainResult> {
  const now = opts.now ?? new Date();
  const result = await runTelegraphOutboxDrainPass(opts);
  _status.lastResult = result;
  if (result.outcome === "off") return result; // OFF is not an attempt (3655 seeds it FALSE)
  _status.lastAttemptAt = now.toISOString();
  const succeeded = result.outcome === "drained" || result.outcome === "idle";
  if (succeeded) {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = now.toISOString();
  } else {
    _status.consecutiveFailures += 1;
    const log = _status.consecutiveFailures >= 3 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ job: JOB_KEY, reason: result.reason, failed: result.failed, consecutiveFailures: _status.consecutiveFailures }, "telegraph outbox drain did NOT succeed — message.created may be late");
  }
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (db && (!succeeded || now.getTime() - _lastPersistMs >= HEALTH_PERSIST_EVERY_MS)) {
    _lastPersistMs = now.getTime();
    try {
      const row: Record<string, unknown> = { job: JOB_KEY, last_run_at: now.toISOString() };
      if (succeeded) row.last_success_at = now.toISOString();
      const { error } = await db.from("job_health").upsert(row, { onConflict: "job" });
      if (error) logger.warn({ job: JOB_KEY, err: error }, "telegraph outbox drain: could not persist job health");
    } catch (err) {
      logger.warn({ job: JOB_KEY, err }, "telegraph outbox drain: could not persist job health");
    }
  }
  return result;
}

let _timer: ReturnType<typeof setTimeout> | null = null; let _generation = 0; // a pass re-arms only if no stop() came after its own start() (PR #652's pattern)
let _running = false;
let _again = false;

/**
 * Ask for a pass NOW (the send route calls this after its insert when fan-out
 * is in force). Coalesced: a request while a pass is running schedules exactly
 * one more pass after it, so a burst of sends costs a bounded number of passes.
 */
export function requestTelegraphOutboxDrain(): void {
  if (_running) { _again = true; return; }
  _running = true;
  void (async () => {
    try {
      do {
        _again = false;
        await runTelegraphOutboxDrainTick();
      } while (_again);
    } finally {
      _running = false;
    }
  })();
}

export function startTelegraphOutboxDrainScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { intervalMs: TELEGRAPH_OUTBOX_INTERVAL_MS, gate: `${OUTBOX_FANOUT_FLAG} + telegraph_message_kernel_enabled (3655 seeds the first FALSE)` },
    "TelegraphOutboxDrainScheduler scheduled (claims nothing until both flags are on)",
  );
  const generation = ++_generation; _timer = setTimeout(function tick() {
    void runTelegraphOutboxDrainTick().finally(() => {
      if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, TELEGRAPH_OUTBOX_INTERVAL_MS); _timer.unref?.(); }
    });
  }, STARTUP_DELAY_MS);
  _timer.unref?.();
}

export function stopTelegraphOutboxDrainScheduler(): void {
  _generation += 1; if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
