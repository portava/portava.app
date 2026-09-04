/**
 * passportNav — the ONE place Passport surfaces build their routes.
 *
 * Two audit findings motivated this module:
 *
 *   F6  The identity-card availability chip pushed the legacy `/availability`
 *       editor while the Quick Links row pushed `/passport/availability` — two
 *       editors for one domain. Both call sites now go through
 *       `openAvailabilityEditor()`, so there is exactly one editor to reach.
 *
 *   §2  Trust, Journeys and Travel Identity were owner-only routes although the
 *       server already serves them for any viewer (`GET /passport/:userId/…`
 *       does the privacy projection). A viewer reaches them with `?userId=`,
 *       built here so the param name can never drift between the pusher and
 *       the route wrapper that reads it.
 *
 * Pure string builders + one router call, so every caller is testable without
 * mounting a screen.
 */
import { router } from 'expo-router';

/** The §6/§7 availability editor — the only one (F6). */
export const PASSPORT_AVAILABILITY_ROUTE = '/passport/availability';

export const PASSPORT_TRUST_ROUTE = '/passport/trust';
export const PASSPORT_JOURNEYS_ROUTE = '/passport/journeys';
export const PASSPORT_TRAVEL_IDENTITY_ROUTE = '/passport/travel-identity';
export const PASSPORT_MY_WORLD_ROUTE = '/passport/my-world';

/** Query-param name the viewer-capable route wrappers read (mirrors plans.tsx). */
export const VIEWER_USER_PARAM = 'userId';

function withParams(base: string, params: Record<string, string | null | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.length > 0) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.length > 0 ? `${base}?${parts.join('&')}` : base;
}

/**
 * Trust & Credentials for `userId` (a viewer), or the owner's own when omitted.
 * `userId` may be a UUID or an @handle — the projection endpoint resolves both.
 */
export function trustHref(userId?: string | null): string {
  return withParams(PASSPORT_TRUST_ROUTE, { [VIEWER_USER_PARAM]: userId ?? null });
}

/** Journeys for `userId`, optionally focusing one Trip (§13 stamp → Journey link). */
export function journeysHref(userId?: string | null, tripId?: string | null): string {
  return withParams(PASSPORT_JOURNEYS_ROUTE, {
    [VIEWER_USER_PARAM]: userId ?? null,
    tripId: tripId ?? null,
  });
}

/** Travel Identity for `userId`, or the owner's own when omitted. */
export function travelIdentityHref(userId?: string | null): string {
  return withParams(PASSPORT_TRAVEL_IDENTITY_ROUTE, { [VIEWER_USER_PARAM]: userId ?? null });
}

/** My World is the owner's own geographic history (§26) — no viewer variant. */
export function myWorldHref(): string {
  return PASSPORT_MY_WORLD_ROUTE;
}

/** Open the single availability editor (F6). */
export function openAvailabilityEditor(): void {
  router.push(PASSPORT_AVAILABILITY_ROUTE as never);
}

/**
 * Normalise a raw `?userId=` param: strips a leading '@' (handles are accepted)
 * and returns null for anything that is not a non-empty string.
 */
export function readViewerUserParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^@/, '');
  return v.length > 0 ? v : null;
}
