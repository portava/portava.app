/**
 * passportProjection — client for the ONE privacy-aware Passport projection
 * surface (spec §4/§21/§29/§30): GET /api/passport/:userId/projection.
 *
 * The server owns ALL privacy and authorization: it returns only the plans this
 * viewer may see (per-plan visibility, §16/TABLE 24) and an explicit
 * `capabilities.actions` block (§30 — the client renders those flags and never
 * re-derives policy such as "if trust > 60 show Connect"). This client keeps a
 * LEAN view of that aggregate — only the fields the Plans surface + QR share
 * sheet consume — mapped from the server's snake/camel response defensively.
 *
 * `:userId` accepts a UUID or an @handle; passing the viewer's own id returns
 * the `self` context (all of their own plans, with dates).
 */
import { freshToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Test seam — non-null bypasses Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void {
  _testAuthToken = t;
}
async function authToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshToken();
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

export type PassportViewerContext =
  | 'self'
  | 'public'
  | 'follower'
  | 'following'
  | 'trip_crew'
  | 'trip_host'
  | 'buddy_customer'
  | 'buddy_provider'
  | 'event_group';

/** One upcoming plan the viewer is permitted to see (§16). */
export interface PlanProjection {
  tripId: string;
  title: string;
  destinationCity: string | null;
  destinationCountry: string | null;
  /** ISO date or null when the owner hides exact dates from this viewer. */
  startDate: string | null;
  endDate: string | null;
  /** Raw trip visibility: 'public' | 'buddies' | 'private' | 'invite'. */
  visibility: string;
}

/** Per-viewer action flags (TABLE 29) — server-projected, never re-derived. */
export interface PassportViewerActions {
  can_follow: boolean;
  can_message: boolean;
  can_make_plan: boolean;
  can_invite_trip: boolean;
  can_view_availability: boolean;
  can_view_trust: boolean;
}

/** Minimal identity slice the client needs (Plans header + QR projection). */
export interface PassportProjectionIdentity {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  verified: boolean;
  verificationLevel: string | null;
  homeCountry: string | null;
}

/** Lean client view of the §29 aggregate — only the Plans/QR fields. */
export interface PassportProjectionView {
  userId: string;
  identity: PassportProjectionIdentity;
  viewerContext: PassportViewerContext;
  upcomingPlans: PlanProjection[];
  actions: PassportViewerActions;
  /** Interests the server permitted into the projection (travel identity). */
  interests: string[];
  /** True when the server reduced the projection for privacy/blocking. */
  restricted: boolean;
}

const DEFAULT_ACTIONS: PassportViewerActions = {
  can_follow: false,
  can_message: false,
  can_make_plan: false,
  can_invite_trip: false,
  can_view_availability: false,
  can_view_trust: false,
};

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function mapPlan(r: any): PlanProjection {
  return {
    tripId: String(r?.tripId ?? r?.trip_id ?? ''),
    title: asString(r?.title) ?? 'Trip',
    destinationCity: asString(r?.destinationCity ?? r?.destination_city),
    destinationCountry: asString(r?.destinationCountry ?? r?.destination_country),
    startDate: asString(r?.startDate ?? r?.start_date),
    endDate: asString(r?.endDate ?? r?.end_date),
    visibility: asString(r?.visibility) ?? 'private',
  };
}

/** Map the raw server projection into the lean client view. Defensive to shape. */
export function mapProjection(raw: any): PassportProjectionView {
  const p = raw?.projection ?? raw ?? {};
  const identity = p.identity ?? {};
  const actions = p.capabilities?.actions ?? {};
  const interests: string[] = Array.isArray(p.travelIdentity?.interests)
    ? p.travelIdentity.interests.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  const plans: unknown[] = Array.isArray(p.upcomingPlans) ? p.upcomingPlans : [];
  return {
    userId: String(p.userId ?? identity.userId ?? ''),
    identity: {
      userId: String(identity.userId ?? p.userId ?? ''),
      name: asString(identity.name),
      handle: asString(identity.handle),
      avatarUrl: asString(identity.avatarUrl ?? identity.avatar_url),
      verified: identity.verified === true,
      verificationLevel: asString(identity.verificationLevel ?? identity.verification_level),
      homeCountry: asString(identity.homeCountry ?? identity.home_country),
    },
    viewerContext: (p.viewerContext ?? 'public') as PassportViewerContext,
    upcomingPlans: plans.map(mapPlan).filter((pl) => pl.tripId.length > 0),
    actions: { ...DEFAULT_ACTIONS, ...actions },
    interests,
    restricted: Boolean(p.restricted),
  };
}

/** Fetch the passport projection for `userId` (UUID or @handle) as this viewer. */
export async function getPassportProjection(userId: string): Promise<ApiResult<PassportProjectionView>> {
  const token = await authToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/passport/${encodeURIComponent(userId)}/projection`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, data: mapProjection(json) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}
