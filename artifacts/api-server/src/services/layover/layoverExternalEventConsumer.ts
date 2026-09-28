/**
 * The consume half of §11: claim pending external events and replan them.
 *
 * Spec §11.1 steps 2-8 are the replan itself and live in
 * `services/airport/LayoverEventReplanner.ts`. This file is the LOOP around
 * them — read the pending set, take ownership of one event at a time, hand it
 * to a replanner, and report honestly what happened to each.
 *
 * Census-layover L92 ("normalise and deduplicate the external/internal event"),
 * L194 and L263 are about the ingest side; this is what makes the ingest mean
 * something. An event stored and never claimed changes no traveller's plan, and
 * an ingest without a consumer is a table that fills up while looking like
 * working software.
 *
 * ── THE REPLANNER IS A PORT, NOT AN IMPORT ───────────────────────────────────
 * `handleEvent` needs an airport, the active sessions, their candidates, their
 * held recommendations and their live conditions. Assembling those is a
 * different job from draining a queue, and wiring it in here would make this
 * loop untestable without a database and six services.
 *
 * So the replanner arrives as a `ReplanPort`. The loop's own behaviour — the
 * compare-and-swap, the ordering, what happens when a replan fails — is then
 * testable against a port that does nothing, which is the only way to test a
 * concurrency property at all.
 *
 * ── CLAIM BEFORE REPLAN, AND WHAT THAT COSTS ─────────────────────────────────
 * `claimExternalEvent` stamps `processed_at` with a conditional UPDATE, so two
 * workers reading the same pending page cannot both own the same event. The
 * stamp happens BEFORE the replan, deliberately:
 *
 *   * claim-then-replan, interrupted → the event is marked processed and was
 *     not replanned. One traveller's plan is stale until the next event.
 *   * replan-then-claim, interrupted → the event is replanned twice. The
 *     traveller is notified twice for one gate change.
 *
 * §24's guarantee is about duplicates, so the failure this trades toward is the
 * one the specification names. It is NOT free, and this file does not pretend
 * it is: a replan that fails after the claim is reported in
 * `DrainReport.failedAfterClaim`, by event id, so the gap is visible as a gap.
 *
 * ── WHY THE STUCK ROW IS NOT SILENTLY RETRIED ────────────────────────────────
 * The tempting fix is to un-stamp `processed_at` when a replan fails, so the
 * next drain picks it up. That is only safe if the failed replan is known to
 * have sent nothing, and it is not: a replan can fail after its notification
 * and before its return. Un-stamping on every failure would convert a visible
 * stale plan into an invisible double notification.
 *
 * So recovery is explicit — `releaseExternalEventClaim`, below — and carries
 * its own warning rather than happening by default. A sibling consumer in this
 * repository was recently found treating a permanently stuck row as a transient
 * outage and retrying it to the attempt ceiling; the lesson taken from that is
 * that a stuck row must be REPORTED, not that it must be retried.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import type { LayoverEventEnvelope } from "../airport/LayoverEventReplanner.js";
import {
  claimExternalEvent,
  readPendingExternalEvents,
} from "./LayoverExternalEventService.js";

const logger = rootLogger.child({ service: "layoverExternalEventConsumer" });

/** What a replan reports back. A failure names itself rather than throwing. */
export type ReplanReport =
  | { ok: true; impacted: number; notifications: number }
  | { ok: false; reason: string };

/**
 * The replanner, as this loop needs it.
 *
 * One method, taking an envelope this loop has already claimed. Implementations
 * assemble the airport, sessions and candidates and call
 * `handleEvent`; this file neither knows nor cares how.
 */
export interface ReplanPort {
  replan(event: LayoverEventEnvelope): Promise<ReplanReport>;
}

export interface DrainedEvent {
  eventId: string;
  eventType: string;
  impacted: number;
  notifications: number;
}

export interface DrainReport {
  /** Events this worker claimed AND replanned successfully. */
  drained: DrainedEvent[];
  /**
   * Events another worker claimed first. Not a failure and not an error: it is
   * the compare-and-swap working. Counted so a drain that does nothing can be
   * told apart from a drain with nothing to do.
   */
  claimedByAnother: number;
  /**
   * Events this worker claimed and then FAILED to replan. `processed_at` is
   * stamped and no replan happened, so each of these is a session whose plan is
   * stale until the next event for it. Reported by id so the gap is visible;
   * see `releaseExternalEventClaim` before deciding to retry one.
   */
  failedAfterClaim: Array<{ eventId: string; reason: string }>;
  /** Rows the pending read could not rebuild into an envelope. */
  unreadable: number;
  /**
   * Set when the PENDING READ itself failed. The drain did nothing and does not
   * know whether there was anything to do. Distinguished from an empty drain,
   * because a consumer that reports an outage as a quiet day is worse than one
   * that reports nothing at all.
   */
  readFailed: string | null;
}

/**
 * One pass over the pending set.
 *
 * NOT a loop-until-empty. A single bounded pass, called by whatever schedules
 * it, so a producer flood cannot hold one worker inside this function
 * indefinitely while its own health checks time out.
 *
 * `nowMs` is passed in rather than read here so the stamp is the caller's
 * instant and the whole path stays deterministic under test.
 */
export async function drainPendingExternalEvents(
  db: SupabaseClient,
  port: ReplanPort,
  opts: { limit: number; nowMs: number },
): Promise<DrainReport> {
  const report: DrainReport = {
    drained: [],
    claimedByAnother: 0,
    failedAfterClaim: [],
    unreadable: 0,
    readFailed: null,
  };

  const pending = await readPendingExternalEvents(db, opts.limit);
  if (!pending.ok) {
    report.readFailed = pending.message;
    return report;
  }
  report.unreadable = pending.unreadable;

  for (const event of pending.events) {
    const claim = await claimExternalEvent(db, event.eventId, opts.nowMs);
    if (!claim.ok) {
      // The claim itself errored, so we do NOT know whether the stamp landed.
      // Treated as failed-after-claim rather than as available: assuming it did
      // not land would let this worker and the next one both replan it, which
      // is the duplicate §24 forbids. The pessimistic reading is the safe one.
      report.failedAfterClaim.push({ eventId: event.eventId, reason: `claim_failed: ${claim.message}` });
      continue;
    }
    if (!claim.claimed) {
      report.claimedByAnother += 1;
      continue;
    }

    let outcome: ReplanReport;
    try {
      outcome = await port.replan(event);
    } catch (err) {
      // A thrown replanner is a bug, not an outcome, and it is caught here for
      // one reason only: so the remaining claimed events in this pass still get
      // their turn. It is recorded as a failure, never swallowed into success.
      outcome = { ok: false, reason: `replan threw: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!outcome.ok) {
      logger.warn(
        { eventId: event.eventId, eventType: event.eventType, reason: outcome.reason },
        "external event claimed but replan failed — processed_at is stamped and no replan happened",
      );
      report.failedAfterClaim.push({ eventId: event.eventId, reason: outcome.reason });
      continue;
    }

    report.drained.push({
      eventId: event.eventId,
      eventType: event.eventType,
      impacted: outcome.impacted,
      notifications: outcome.notifications,
    });
  }

  return report;
}

export type ReleaseResult =
  | { ok: true; released: boolean }
  | { ok: false; reason: "release_failed"; message: string };

/**
 * Put a claimed event back into the pending set by clearing `processed_at`.
 *
 * ── READ THIS BEFORE CALLING IT ──────────────────────────────────────────────
 * THIS CAN CAUSE A DUPLICATE NOTIFICATION. A replan that failed may have failed
 * AFTER sending, and this function cannot tell. Releasing such an event means
 * the traveller is notified twice for one change, which is exactly what §24's
 * dedup key exists to prevent — the key stops a duplicate ARRIVING, not a
 * duplicate being replayed on purpose.
 *
 * It is therefore never called from `drainPendingExternalEvents`. It exists for
 * a recovery path that has established, for a specific event, that nothing was
 * sent — for example because the failure was `claim_failed` and the stamp is
 * known to have landed with no replan attempted at all.
 *
 * The guard is a narrow one and stated rather than enforced: this function
 * cannot verify the caller's reasoning, so `reason` is required and logged, and
 * the caller owns the claim that nothing was sent.
 */
export async function releaseExternalEventClaim(
  db: SupabaseClient,
  eventId: string,
  reason: string,
): Promise<ReleaseResult> {
  const { data, error } = await db
    .from("layover_external_events")
    .update({ processed_at: null })
    .eq("event_id", eventId)
    .not("processed_at", "is", null)
    .select("event_id");

  if (error) {
    logger.warn({ err: error.message, eventId, reason }, "external event claim release failed");
    return { ok: false, reason: "release_failed", message: error.message };
  }
  const released = (data ?? []).length === 1;
  logger.warn(
    { eventId, reason, released },
    "external event claim RELEASED — this event will be replanned again, and if the failed replan had already notified, the traveller is notified twice",
  );
  return { ok: true, released };
}
