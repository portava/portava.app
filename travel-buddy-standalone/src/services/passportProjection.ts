/**
 * passportProjection — client bindings for the read-only Passport projection
 * endpoints that already exist on the API server:
 *
 *   GET /api/passport/:userId/journeys     → §14 grouped chronological journeys
 *   GET /api/passport/:userId/projection   → §29 aggregate (travelIdentity + the
 *                                            lean Plans/QR view)
 *
 * These endpoints do ALL privacy filtering server-side (spec §4/§21/§30): the
 * client never re-derives visibility or authorization. Payloads are already
 * coarsened to what the viewer may see (coarse dates, city/neighbourhood only —
 * never coordinates, §23 / TABLE 25), and the projection carries an explicit
 * `capabilities.actions` block the client renders verbatim. This module is a
 * thin fetch layer that re-declares the response shapes (the server types live
 * in a different package) and unwraps the envelopes for the hooks.
 *
 * Auth + fetch follow the same freshToken() pattern as passportStamps.ts.
 */
import { freshToken as freshApiToken } from './apiToken.ts';

// ── Shared scaffold ──────────────────────────────────────────────────────────

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void {
  _testAuthToken = t;
}

async function authToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
}

async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const token = await authToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

// ── Journeys (§14 / TABLE 3 / TABLE 26) ──────────────────────────────────────

/** One memory rooted to a Trip in the Journeys view. Coarse place only (§23). */
export interface JourneyMemory {
  id: string;
  title: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  photoUrl: string | null;
  earnedAt: string | null;
}

/** One stamp rooted to a Trip. Coarse place only (§23). */
export interface JourneyStamp {
  name: string | null;
  city: string | null;
  country: string | null;
  earnedAt: string | null;
}

/**
 * A person who shared this Trip. The current server projection does not yet
 * populate this (Journeys is a pure Trip/Memory/Stamp projection), so it is
 * OPTIONAL and forward-compatible: when the server begins attaching permitted
 * companions, the Featured Journey's "Who was there" section renders them.
 */
export interface JourneyPerson {
  id: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

/** One Trip projected into the Journeys view (§14). */
export interface JourneyProjection {
  tripId: string;
  title: string;
  year: number | null;
  country: string | null;
  city: string | null;
  /** Coarse or exact per server permission; may be null when not permitted. */
  startDate: string | null;
  endDate: string | null;
  durationLabel: string | null;
  status: string;
  memoryCount: number;
  stampCount: number;
  memories: JourneyMemory[];
  stamps: JourneyStamp[];
  featured: boolean;
  /** Forward-compatible people context (see JourneyPerson). */
  people?: JourneyPerson[];
}

/** Grouped chronological projection: year → country → city → Trip (TABLE 26). */
export interface JourneysProjection {
  userId: string;
  years: Array<{
    year: number | null;
    countries: Array<{
      country: string | null;
      cities: Array<{
        city: string | null;
        journeys: JourneyProjection[];
      }>;
    }>;
  }>;
  featured: JourneyProjection | null;
  totalJourneys: number;
}

/** Unwrapped journeys result plus the server's restricted/blocked signal. */
export interface JourneysResult {
  journeys: JourneysProjection;
  /** True when the viewer is blocked/unavailable and the server returned no data. */
  restricted: boolean;
}

interface JourneysEnvelope {
  journeys?: JourneysProjection;
  restricted?: boolean;
  viewerContext?: string;
}

const EMPTY_JOURNEYS: JourneysProjection = { userId: '', years: [], featured: null, totalJourneys: 0 };

export async function getPassportJourneys(userId: string): Promise<ApiResult<JourneysResult>> {
  const res = await apiGet<JourneysEnvelope>(`/passport/${encodeURIComponent(userId)}/journeys`);
  if (!res.ok) return { ok: false, message: res.message };
  return {
    ok: true,
    data: {
      journeys: res.data?.journeys ?? { ...EMPTY_JOURNEYS, userId },
      restricted: res.data?.restricted === true,
    },
  };
}

// ── Travel Identity / Travel DNA (§19 / TABLE 20) ────────────────────────────

export type TravelDnaState = 'shown' | 'hidden' | 'not_me';

/** A single explainable spectrum reading (TABLE 20). */
export interface TravelDimension {
  key: string;
  label: string;
  /** Spectrum pole labels; null for value-list dimensions (interests, languages). */
  poles: { low: string; high: string } | null;
  /** 0..1 position on the axis, or null for a value list / no signal. */
  position: number | null;
  /** Human-readable reading, e.g. "Planner", "Night owl", "EN, VI". */
  value: string;
  /** The concrete facts this reading was inferred from (explainability, §19). */
  evidence: string[];
  /** Owner-controlled visibility state. */
  state: TravelDnaState;
  /** True when the reading is a weak default with no supporting evidence. */
  inferred: boolean;
}

/** A named Travel DNA badge (Night Explorer, Hidden Gem Hunter, Food Driven…). */
export interface TravelTrait {
  key: string;
  label: string;
  description: string;
  evidence: string[];
  state: TravelDnaState;
}

export interface TravelIdentityProjection {
  userId: string;
  dimensions: TravelDimension[];
  traits: TravelTrait[];
  /** True when stored Show/Hide/Not-Me prefs were applied server-side. */
  preferencesApplied: boolean;
  /** True on the owner's own view — controls are only meaningful when editable. */
  editable: boolean;
}

interface ProjectionTravelIdentityEnvelope {
  projection?: { travelIdentity?: TravelIdentityProjection | null };
}

/** What a Travel-DNA control writes (§19). `key` is a dimension or trait key. */
export type TravelDnaKind = 'dimension' | 'trait';

export interface TravelDnaPrefInput {
  key: string;
  kind: TravelDnaKind;
  state: TravelDnaState;
}

/** The persisted preference the server echoes back on a successful write. */
export interface TravelDnaPref extends TravelDnaPrefInput {
  userId: string;
}

/**
 * Persist one owner-controlled Show/Hide/Not-Me preference (§19) via
 * `PUT /api/passport/me/travel-dna`. Owner-scoped (the server stamps the caller
 * id from the bearer token — the client never sends a user id). The screen keeps
 * the optimistic local update and reconciles/reverts on this result.
 */
export async function putTravelDna(input: TravelDnaPrefInput): Promise<ApiResult<TravelDnaPref>> {
  const token = await authToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/passport/me/travel-dna`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: input.key, kind: input.kind, state: input.state }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    const json = await res.json().catch(() => ({}));
    const pref = (json as any)?.pref ?? {};
    return {
      ok: true,
      data: {
        userId: String(pref.userId ?? pref.user_id ?? ''),
        key: typeof pref.key === 'string' ? pref.key : input.key,
        kind: (pref.kind === 'trait' || pref.kind === 'dimension' ? pref.kind : input.kind),
        state: (pref.state === 'hidden' || pref.state === 'not_me' || pref.state === 'shown'
          ? pref.state
          : input.state) as TravelDnaState,
      },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

/**
 * Fetch the §29 aggregate and return ONLY the travelIdentity slice. Returns
 * `null` (ok) when the projection carries no travel identity (e.g. the viewer
 * is not permitted to see it) so the screen can show an explicit empty state.
 */
export async function getTravelIdentity(
  userId: string,
): Promise<ApiResult<TravelIdentityProjection | null>> {
  const res = await apiGet<ProjectionTravelIdentityEnvelope>(`/passport/${encodeURIComponent(userId)}/projection`);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: res.data?.projection?.travelIdentity ?? null };
}

// ── Plans + QR projection view (§16 / §30 / TABLE 24 / TABLE 29) ──────────────

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
