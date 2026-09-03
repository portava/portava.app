/**
 * Passport Shared Context service (§17 / §18).
 *
 * Thin client for `GET /api/passport/:userId/shared-context`, the viewer↔owner
 * overlap endpoint built server-side in the api-server
 * (services/passport/SharedContextService.ts, route routes/passport.ts).
 *
 * Shared Context is COMPUTED FOR THE VIEWER RELATIONSHIP on every request — it
 * is never a stored, permanent "match score" (§18 / TABLE 18). The server
 * returns a set of explainable facts plus a qualitative summary LABEL
 * ("Strong travel overlap"); there is deliberately no numeric compatibility
 * percentage anywhere in this payload, and the client never synthesises one.
 *
 * Types mirror the server projection so the mobile client consumes the exact
 * contract without re-deriving anything. Uses the same fetch + freshToken
 * pattern as the other passport services (passportStamps.ts).
 */
import { freshToken as freshApiToken } from './apiToken.ts';

/** Keys mirror SharedContextService.SharedContextFact (TABLE 17). */
export type SharedContextFactKey =
  | 'both_in_city'
  | 'both_free_tonight'
  | 'mutual_follows'
  | 'shared_cities'
  | 'intent_overlap'
  | 'shared_trips'
  | 'shared_moments'
  | 'both_going_to';

/** One explainable overlap fact. `detail` is coarse and viewer-permitted. */
export interface SharedContextFact {
  key: SharedContextFactKey;
  label: string;
  detail: string | null;
  /** Count where one is meaningful (e.g. mutual-follow count); never a score. */
  magnitude: number | null;
}

/** §18 candidate seed handed to Compass — no coordinates, no private history. */
export interface CompassHandoff {
  eligible: boolean;
  city: string | null;
  overlapWindow: { status: string; expiresAt: string | null } | null;
  sharedIntents: string[];
  reasons: string[];
}

/**
 * Qualitative overlap label, derived server-side purely from how many facts
 * hold. NOT a stored or numeric match score.
 */
export type SharedContextSummaryLabel =
  | 'No overlap yet'
  | 'Some overlap'
  | 'Good travel overlap'
  | 'Strong travel overlap';

export interface SharedContextProjection {
  viewerId: string;
  ownerId: string;
  facts: SharedContextFact[];
  summaryLabel: SharedContextSummaryLabel;
  compassHandoff: CompassHandoff;
}

/** Response envelope. `sharedContext` is null with reason 'self' on own passport. */
export interface SharedContextResponse {
  sharedContext: SharedContextProjection | null;
  reason?: string;
  viewerContext?: string;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void {
  _testAuthToken = t;
}

async function freshToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
}

/**
 * Fetch the viewer↔owner shared context for `userId` (the OTHER traveler).
 * Fails soft: a network/auth error becomes `{ ok: false, message }` the screen
 * surfaces with a retry affordance instead of throwing.
 */
export async function getSharedContext(
  userId: string,
): Promise<ApiResult<SharedContextResponse>> {
  if (!userId) return { ok: false, message: 'No user' };
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Sign in to see shared context' };
  try {
    const res = await fetch(
      `${apiBase()}/api/passport/${encodeURIComponent(userId)}/shared-context`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as SharedContextResponse };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}
