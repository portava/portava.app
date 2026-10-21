/**
 * census-telegraph T397 — the Plan producer, through the notification ledger.
 *
 * Spec §30A.6: "A single Plan change must not create redundant Plan, Trip,
 * Telegraph, and Compass notifications."
 *
 * ── THE REDUNDANCY THIS CLOSES ──────────────────────────────────────────────
 * Confirming a meetup's time (POST /meetups/:id/confirm-time) pushed every
 * Going/Maybe RSVP straight through `sendPushWithRetry`: no `notifications`
 * row, so no dedupe, no preference check and nothing a later producer could
 * see. Compass Sense then reported the SAME change ("Your meetup is confirmed",
 * `compass.sense.circle_plan_change`) within its two-hour window, through the
 * ledger. One Plan change, two notifications — the case §30A.6 names.
 *
 * Now the Plan producer writes a `plan.time_confirmed` notification per RSVP
 * through NotificationService (privacy guard, dedupe, persist) and routes it
 * (preferences, push), carrying the change's causal id
 * (`PLAN:<meetupId>@confirmed:<startsAtMs>`, causalEvents.ts). Compass computes
 * the same id from the same row, so whichever of the two reaches a person
 * second is refused as `causal_duplicate`.
 *
 * The words are the push's words before this change, unchanged: the confirmer
 * (their real name only if they show it, else their @handle) and the meetup's
 * title and time. Nothing new reaches a lock screen.
 *
 * NEVER rejects: the route fires it after answering, and a failure for one
 * recipient does not stop the rest.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CreateNotificationInput, NotificationRow } from "./NotificationService.js";
import { planStatusEventId } from "./causalEvents.js";

export const PLAN_TIME_CONFIRMED_EVENT = "plan.time_confirmed" as const;
export const PLAN_NOTIFICATION_SOURCE = "meetup" as const;

export interface PlanNotifyDeps {
  create(input: CreateNotificationInput): Promise<NotificationRow | null>;
  route(row: NotificationRow): Promise<void>;
}

export interface PlanNotifyLog {
  warn(obj: object, msg: string): void;
}

async function defaultDeps(sc: SupabaseClient): Promise<PlanNotifyDeps> {
  const { NotificationService } = await import("./NotificationService.js");
  const { NotificationRouter } = await import("./NotificationRouter.js");
  const ns = new NotificationService(sc);
  const nr = new NotificationRouter(sc);
  return { create: (input) => ns.create(input), route: (row) => nr.route(row) };
}

export interface PlanTimeConfirmedInput {
  meetupId: string;
  /** The person who confirmed. Never told about their own act. */
  actorId: string;
  /** How a lock screen may name the actor (already decided by the caller's name rule). */
  actorLabel: string;
  recipientIds: readonly string[];
  meetupTitle: string;
  /** The human label of the confirmed time, as the push always showed it. */
  when: string;
  /** The row's STORED starts_at — the causal id's version. */
  storedStartsAt: unknown;
}

export interface PlanNotifyOutcome {
  /** Recipients a notification was written (and routed) for. */
  notified: string[];
  /** Recipients the pipeline refused (a duplicate of this change, the privacy guard, an insert failure) or that threw. */
  notCreated: string[];
}

/** Tell each RSVP that a Plan's time was confirmed — once per change, whoever else reports it. */
export async function notifyPlanTimeConfirmed(
  sc: SupabaseClient,
  input: PlanTimeConfirmedInput,
  opts: { deps?: PlanNotifyDeps; log?: PlanNotifyLog } = {},
): Promise<PlanNotifyOutcome> {
  const outcome: PlanNotifyOutcome = { notified: [], notCreated: [] };
  const recipients = [...new Set(input.recipientIds)].filter((id) => typeof id === "string" && id.length > 0 && id !== input.actorId);
  if (recipients.length === 0) return outcome;
  let deps: PlanNotifyDeps;
  try {
    deps = opts.deps ?? (await defaultDeps(sc));
  } catch (err) {
    opts.log?.warn({ err, meetupId: input.meetupId }, "plan notification: pipeline unavailable — nobody told (the confirmation itself was written)");
    return { notified: [], notCreated: recipients };
  }
  const causalEventId = planStatusEventId(input.meetupId, "confirmed", input.storedStartsAt);
  await Promise.all(recipients.map(async (userId) => {
    try {
      const row = await deps.create({
        userId,
        eventType: PLAN_TIME_CONFIRMED_EVENT,
        actorId: input.actorId,
        senderId: input.actorId,
        sourceType: PLAN_NOTIFICATION_SOURCE,
        sourceId: input.meetupId,
        params: { actor: input.actorLabel, meetupTitle: input.meetupTitle, when: input.when, meetupId: input.meetupId },
        ...(causalEventId ? { causalEventId } : {}),
      });
      if (!row) { outcome.notCreated.push(userId); return; }
      outcome.notified.push(userId);
      await deps.route(row);
    } catch (err) {
      outcome.notCreated.push(userId);
      opts.log?.warn({ err, meetupId: input.meetupId }, "plan notification failed for one recipient (the confirmation itself was written)");
    }
  }));
  return outcome;
}
