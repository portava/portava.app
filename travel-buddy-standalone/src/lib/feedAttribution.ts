/**
 * feedAttribution — carries the feed session id across navigation.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * The ranker needs to answer "of the impressions served in session X, which
 * led to a join?". Today it cannot: `rank_events` records the serving side
 * with a `session_id`, but no outcome table carries anything that points back
 * to it (docs/algorithm/signal-audit.md §3a). The join has no key.
 *
 * `useCityPulse` already returns the `sessionId` the server stamped on the
 * impression batch, and `PulseFeedCard` already threads it down to
 * `SaveButton`. The gap is navigation: a user taps an event card, lands on
 * the event screen, RSVPs — and by then the session is gone, so the outcome
 * records with `sessionId: null` and is only attributable heuristically.
 *
 * This module closes that gap by putting the session in the route, which is
 * the one thing that survives the screen transition.
 *
 * WHY A ROUTE PARAM RATHER THAN MODULE STATE
 * ------------------------------------------
 * A module-level "current feed session" would be less code and would be
 * wrong. It would attribute an outcome to whatever feed happened to load
 * last, so an event opened from a deep link, a notification, or search would
 * silently inherit an unrelated session. That is worse than a null: a null is
 * honestly unattributed, a wrong session is bad data that looks fine.
 *
 * A route param is explicit, travels with exactly the navigation that caused
 * it, and is absent when the event was not reached from a feed.
 *
 * USAGE
 * -----
 *   // navigating away from a feed:
 *   router.push(eventHref(ev.id, sessionId));
 *
 *   // on the destination screen:
 *   const { id, [FEED_SESSION_PARAM]: sessionId } =
 *     useLocalSearchParams<{ id: string; sessionId?: string }>();
 *
 * Passing `undefined` omits the param entirely rather than serialising the
 * string "undefined" — a distinction that matters, because `?sessionId=undefined`
 * would be read back as a truthy string and reported as a real session.
 */

/** Query-param name carrying the feed session id. Keep in one place. */
export const FEED_SESSION_PARAM = 'sessionId';

/**
 * Build the href for an event screen, attaching the feed session when there
 * is one.
 *
 * @param eventId    The event's id.
 * @param sessionId  Feed session that served this impression. Omit (or pass
 *                   null/undefined) when the event was not reached from a
 *                   feed — deep link, notification, search. The outcome still
 *                   records; it is simply unattributed rather than wrongly
 *                   attributed.
 */
export function eventHref(eventId: string, sessionId?: string | null): string {
  const base = `/event/${eventId}`;
  if (!sessionId) return base;
  return `${base}?${FEED_SESSION_PARAM}=${encodeURIComponent(sessionId)}`;
}

/**
 * Normalise the param as read back from the router.
 *
 * expo-router types a param as `string | string[] | undefined`: a repeated
 * query key arrives as an array. Take the first entry and treat an empty
 * string as absent, so callers get a clean `string | null` and never report
 * an empty session.
 */
export function readFeedSession(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value : null;
}
