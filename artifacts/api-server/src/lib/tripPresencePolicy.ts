/**
 * Trips spec §6.1 canSeePresence(actor, subject, trip) — §10.3, PURE.
 *
 * Its own module because two files need it and one imports the other:
 * lib/tripPolicy.ts re-exports it as the §6.1 name, and lib/tripCrewLocation.ts
 * calls it for the visibility fork in buildCrewCard so that the card and the
 * predicate cannot disagree. tripPolicy already imports tripCrewLocation (for
 * canSeePreciseLocation), so putting this in either of them would be a cycle.
 *
 * May this viewer see this member's presence at all? The ORDER is the whole
 * rule and it is the order buildCrewCard has always applied:
 *
 *   1. ghost mode wins over everything — an absolute "invisible" choice;
 *   2. an ACTIVE live-share grant is an affirmative, time-boxed act of sharing
 *      and overrides a `hidden` default. Expiry is checked HERE against `now`,
 *      never assumed from the grant's presence: an expired grant is no grant,
 *      and an unparseable expiry fails closed;
 *   3. otherwise the member's default visibility decides: `hidden` — or no
 *      preferences row at all — is not shared; anything else is, at its level.
 *
 * It returns a DECISION, not a card. The granularity (city, neighbourhood,
 * nearby) and the exact-coordinate question stay the card's business
 * (resolveExactCoords, census TR110).
 */

/** The subject's presence-relevant state, as lib/tripCrewLocation.ts assembles it. */
export interface PresenceSubject {
  ghostModeEnabled: boolean;
  /** `hidden` | `city_only` | `neighborhood` | `nearby` | `arrived_only`; null when no preferences row. */
  defaultVisibility: string | null;
  /** An active live-share GRANT to this viewer, with its expiry; null when none. */
  liveShareExpiresAt: string | null;
}

export type PresenceDecision =
  | { allowed: true; via: "live_share" | "default_visibility" }
  | { allowed: false; reason: "TRIP_PRESENCE_GHOST" | "TRIP_PRESENCE_HIDDEN"; message: string };

export function canSeePresence(subject: PresenceSubject, now: number = Date.now()): PresenceDecision {
  if (subject.ghostModeEnabled) {
    return { allowed: false, reason: "TRIP_PRESENCE_GHOST", message: "This member has hidden their location" };
  }
  if (subject.liveShareExpiresAt !== null) {
    const exp = Date.parse(subject.liveShareExpiresAt);
    if (Number.isFinite(exp) && exp > now) return { allowed: true, via: "live_share" };
  }
  const vis = subject.defaultVisibility ?? "hidden";
  if (vis === "hidden") {
    return { allowed: false, reason: "TRIP_PRESENCE_HIDDEN", message: "This member is not sharing their location" };
  }
  return { allowed: true, via: "default_visibility" };
}
