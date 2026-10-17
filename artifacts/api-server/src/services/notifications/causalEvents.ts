/**
 * census-telegraph T397 — §30A.6: "Deduplicate notifications by underlying
 * causal event. A single Plan change must not create redundant Plan, Trip,
 * Telegraph, and Compass notifications."
 *
 * NotificationDeduplicationService owns the RULE (rule 0b, `hasCausalDuplicate`)
 * and the ONE mint (`causalEventIdOf`). This file owns the NAMES: the underlying
 * events the Plan, Trip and Compass producers report, each spelled once, so two
 * producers that report the same change cannot spell it two ways. Every id here
 * is built by `causalEventIdOf` from the CHANGE — the object that changed and
 * the state the change produced — never from the producer's category, event
 * type or source.
 *
 * ── THE EVENTS ──────────────────────────────────────────────────────────────
 *   PLAN:<meetupId>@confirmed:<startsAtMs> — a Plan's time was confirmed. §3.4's
 *       PLAN is stored as a meetup (services/telegraph/shareables.ts LOADERS:
 *       PLAN and MEETUP both load `meetups`), so a meetup row is always minted
 *       as PLAN. The version is the confirmed START, read back from the row the
 *       database holds, so "confirmed for 8pm" and a later "confirmed for 9pm"
 *       are two events (§19 P1: a meetup that moves twice is two pieces of news),
 *       while an unrelated edit of the row (its title) is not a new one.
 *   PLAN:<meetupId>@cancelled             — a Plan was cancelled.
 *   PLAN:<meetupId>@<status>               — any other lifecycle status.
 *   TRIP:<tripId>@<status>                 — a trip entered a lifecycle status
 *                                            (the completion the review prompt reports).
 *   TRIP_MEMBER:<tripId>:<userId>@<state>  — a person's place on a trip changed
 *                                            (an invitation). Stated consequence:
 *                                            the same person re-invited to the same
 *                                            trip inside the causal window (a day)
 *                                            is that event again, and is told once.
 *   TRIP_JOIN_REQUEST:<requestId>@<outcome>— a join request was answered.
 *
 * Producers: routes/meetups.ts (confirm-time, through planNotifications.ts),
 * compass/CompassSenseEngine.ts and compass/CompassLiveEngine.ts
 * (circle_plan_change), routes/trips.ts (review prompt, invitation),
 * routes/trips-expansion.ts (join request approved / declined), and the
 * coordination producer (MESSAGE:<id>, services/telegraph/coordinationNotifications.ts).
 *
 * A Compass nudge that reports no change — a saved event starting soon, rain
 * today, a free afternoon, leave earlier, the next stop, a ride home — carries
 * NO id: nothing changed, so there is no underlying event another producer
 * could also be reporting, and its own dedupe key (compass_sense_nudges) is the
 * whole of its identity.
 *
 * Every function answers `undefined` (never a malformed string) when the parts
 * do not make an id `isCausalEventId` accepts, so a producer can spread the
 * answer into `CreateNotificationInput` unconditionally.
 */
import { causalEventIdOf } from "./NotificationDeduplicationService.js";

const mint = (objectType: string, objectId: string, version?: string): string | undefined =>
  causalEventIdOf({ objectType, objectId, version: version ?? null }) ?? undefined;

/** Epoch milliseconds of a stored instant, or null. Both producers normalise through this, so "+00:00" and "Z" agree. */
function instantMs(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** A Plan (a meetup row) entering `status`. For `confirmed`, pass the row's stored `starts_at`. */
export function planStatusEventId(meetupId: string, status: string, startsAt?: unknown): string | undefined {
  if (status === "confirmed") {
    const ms = instantMs(startsAt);
    return mint("PLAN", meetupId, ms === null ? "confirmed" : `confirmed:${ms}`);
  }
  return mint("PLAN", meetupId, status);
}

/** A trip entering a lifecycle `status` (trips.status). */
export function tripStatusEventId(tripId: string, status: string): string | undefined {
  return mint("TRIP", tripId, status);
}

/** A person's place on a trip changing to `state` (invited, …). */
export function tripMemberEventId(tripId: string, userId: string, state: string): string | undefined {
  return mint("TRIP_MEMBER", `${tripId}:${userId}`, state);
}

/** A trip join request answered with `outcome` (approved, declined). One request is answered once. */
export function tripJoinRequestEventId(requestId: string, outcome: string): string | undefined {
  return mint("TRIP_JOIN_REQUEST", requestId, outcome);
}
