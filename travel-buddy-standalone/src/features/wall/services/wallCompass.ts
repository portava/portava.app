/**
 * wallCompass — the Wall → Compass handoff (Wall spec §21).
 *
 * Compass is NOT a permanent panel on the Wall; it appears as an ACTION that
 * connects social context to a useful next step. When the viewer asks Compass
 * about a place-linked (or actor-linked) Wall object, this hands the CANONICAL
 * object reference to the app's existing Compass ask surface — the AI chat tab
 * (`/(tabs)/ai`) — via a `prefillMessage`, exactly the way MediaActionRail,
 * SharedContextScreen and the Layover screen already reach Compass.
 *
 * Two invariants from §21:
 *   - The prompt is phrased as a QUESTION and never asserts any inference as a
 *     verified fact — it grounds Compass in the object, it does not tell the user
 *     what is true.
 *   - It carries no private or raw typed content: only the public place / actor
 *     labels already present on the projection. The handoff is recorded in
 *     analytics by ids + surface only (spec §32) — never the prompt text.
 */

import { router } from 'expo-router';
import { trackHandoff } from './wallAnalytics.ts';
import type { WallProjection } from '../types/wallProjection.ts';

/** The canonical Compass ask surface — the AI chat tab's prompt bar. */
export const COMPASS_ROUTE = '/(tabs)/ai';

/** A human noun for the object, used only to phrase the question naturally. */
function objectNoun(projection: WallProjection): string {
  switch (projection.objectType) {
    case 'postcard':
      return 'postcard';
    case 'video':
      return 'video';
    case 'shared_moment':
      return 'shared moment';
    default:
      return 'post';
  }
}

/**
 * Build the grounded prompt handed to Compass. References the canonical object
 * (public place name / city, else the actor's display name) so Compass can
 * ground its first reply (§21). Never asserts inference as fact — it asks.
 */
export function buildWallCompassPrompt(projection: WallProjection): string {
  const noun = objectNoun(projection);
  const place = projection.place;
  if (place?.name) {
    const where = place.city ? `${place.name} in ${place.city}` : place.name;
    return `I saw a ${noun} about ${where} on my Wall. What can you tell me about it, and would it be a good fit for me?`;
  }
  const who = projection.actor?.displayName;
  if (who) {
    return `I saw a ${noun} from ${who} on my Wall. Can you help me understand the place or experience behind it?`;
  }
  return `I saw a ${noun} on my Wall. Can you help me explore the place or experience behind it?`;
}

/**
 * Hand a Wall object to the canonical Compass ask surface (spec §21). Mirrors
 * the app's existing prefill-message handoff. Records the handoff by ids +
 * surface only, then routes; a missing route never crashes the feed (§40).
 */
export function askCompassFromWall(projection: WallProjection): void {
  trackHandoff(projection, 'compass');
  try {
    router.push({
      pathname: COMPASS_ROUTE,
      params: { prefillMessage: buildWallCompassPrompt(projection) },
    } as never);
  } catch {
    // A missing route must never crash the feed (spec §40).
  }
}
