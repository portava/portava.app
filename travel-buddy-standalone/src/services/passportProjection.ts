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

/** Travel stats block (§3 "Travel stats") — coarse counts only. */
export interface PassportStatsView {
  countries: number;
  cities: number;
  stamps: number;
  trips: number;
}

/**
 * One stamp in the §3 "recent stamps" Home preview. Mirrors the server
 * StampProjection — coarse place only (§23), verification provenance verbatim
 * so a decorative stamp can never masquerade as verified (§12).
 */
export interface PassportStampView {
  source: string | null;
  name: string | null;
  city: string | null;
  country: string | null;
  earnedAt: string | null;
  rarity: string | null;
  artworkUrl: string | null;
  verification: 'verified' | 'reported' | 'decorative';
}

/** The single Featured Journey (§14) surfaced as a §3 Home preview. */
export interface PassportFeaturedJourneyView {
  tripId: string;
  title: string;
  city: string | null;
  country: string | null;
  durationLabel: string | null;
  year: number | null;
  memoryCount: number;
  stampCount: number;
}

/** One memory in the §3 "memories" Home preview. Coarse place only (§23). */
export interface PassportMemoryView {
  id: string;
  title: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  photoUrl: string | null;
  earnedAt: string | null;
  tripId: string | null;
}

/**
 * Lean shared-context summary for the §3 "YOU TWO" Home preview (§17). Never a
 * numeric match score (§18 / TABLE 18) — only the qualitative label the server
 * derived, the count of contributing facts, and whether the Compass handoff
 * (§18) is eligible. The full fact list + CTA live on SharedContextScreen.
 */
export interface PassportSharedContextSummary {
  summaryLabel: string;
  factCount: number;
  facts: Array<{ key: string; label: string; detail: string | null }>;
  handoffEligible: boolean;
}

/** §5 traveler-state kinds — the closed set the server projects. */
export type TravelerStateKind =
  | 'home'
  | 'traveling'
  | 'exploring'
  | 'open_to_plans'
  | 'at_event'
  | 'with_crew'
  | 'unavailable';

/**
 * §5 Current Traveler State — temporary, server-projected, never derived on
 * the client from the AvailabilityStore. Broad city only (§23). `expiresAt`
 * is the §31 expiry the chip must honour: a state past it is never rendered
 * as current.
 */
export interface TravelerStateView {
  state: TravelerStateKind;
  label: string;
  city: string | null;
  validFrom: string | null;
  expiresAt: string | null;
}

/** §6/§31 availability summary the projection permits this viewer to see. */
export interface PassportAvailabilityView {
  openToPlans: boolean;
  socialAvailability: 'open' | 'maybe' | 'crew_only' | 'following_only' | 'not_open';
  /** Current explicit, non-expired window (server-filtered) or null. */
  currentWindow: { status: string; expiresAt: string | null } | null;
  expiresAt: string | null;
}

/**
 * §9/§10 trust summary as the server projects it FOR THIS VIEWER. `score` is
 * only non-null where the server chose to expose the number (self view); the
 * client renders it verbatim and never derives authorization from it (§11).
 */
export interface PassportTrustView {
  label: string;
  publicLevel: string;
  score: number | null;
  confidence: 'low' | 'medium' | 'high';
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

/**
 * Client view of the §29 aggregate covering the §3 Passport Home previews plus
 * the Plans/QR fields. Every array is already privacy-filtered server-side
 * (§4/§21/§30) — the client only renders what the projection returned and never
 * re-derives visibility.
 */
export interface PassportProjectionView {
  userId: string;
  identity: PassportProjectionIdentity;
  viewerContext: PassportViewerContext;
  /** §5 current traveler state — null when none / not permitted (short-lived, §31). */
  travelerState: TravelerStateView | null;
  /** §6 availability summary — null when not permitted for this viewer (short-lived, §31). */
  availability: PassportAvailabilityView | null;
  /** §9 trust summary for this viewer — null when not permitted (short-lived, §31). */
  trust: PassportTrustView | null;
  /** True when the server attached a travelIdentity slice this viewer may open. */
  hasTravelIdentity: boolean;
  stats: PassportStatsView;
  /** §3 recent-stamps preview (already coarsened + verification-tagged). */
  recentStamps: PassportStampView[];
  /** §14 Featured Journey preview, or null when none is permitted. */
  featuredJourney: PassportFeaturedJourneyView | null;
  upcomingPlans: PlanProjection[];
  /** §3 memories preview — permitted memories only (per-item privacy, §15). */
  memories: PassportMemoryView[];
  /** §3/§17 "YOU TWO" summary — null on self / when not permitted. */
  sharedContext: PassportSharedContextSummary | null;
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

function toNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function mapStats(r: any): PassportStatsView {
  const s = r ?? {};
  return {
    countries: toNumber(s.countries),
    cities: toNumber(s.cities),
    stamps: toNumber(s.stamps),
    trips: toNumber(s.trips),
  };
}

function mapStamp(r: any): PassportStampView {
  const v = asString(r?.verification);
  return {
    source: asString(r?.source),
    name: asString(r?.name),
    city: asString(r?.city),
    country: asString(r?.country),
    earnedAt: asString(r?.earnedAt ?? r?.earned_at),
    rarity: asString(r?.rarity),
    artworkUrl: asString(r?.artworkUrl ?? r?.artwork_url),
    // Trust the server's provenance verbatim; only fall back to 'verified' when
    // the field is genuinely absent (older payload). Never invent a stronger
    // tier than the server sent (§12).
    verification: v === 'reported' || v === 'decorative' || v === 'verified' ? v : 'verified',
  };
}

function mapFeaturedJourney(r: any): PassportFeaturedJourneyView | null {
  if (!r || typeof r !== 'object') return null;
  const tripId = String(r.tripId ?? r.trip_id ?? '');
  if (!tripId) return null;
  return {
    tripId,
    title: asString(r.title) ?? 'Journey',
    city: asString(r.city),
    country: asString(r.country),
    durationLabel: asString(r.durationLabel ?? r.duration_label),
    year: typeof r.year === 'number' ? r.year : null,
    memoryCount: toNumber(r.memoryCount ?? r.memory_count),
    stampCount: toNumber(r.stampCount ?? r.stamp_count),
  };
}

function mapMemory(r: any): PassportMemoryView {
  return {
    id: String(r?.id ?? ''),
    title: asString(r?.title),
    city: asString(r?.city),
    country: asString(r?.country),
    category: asString(r?.category),
    photoUrl: asString(r?.photoUrl ?? r?.photo_url),
    earnedAt: asString(r?.earnedAt ?? r?.earned_at),
    tripId: asString(r?.tripId ?? r?.trip_id),
  };
}

const TRAVELER_STATE_KINDS: ReadonlySet<string> = new Set([
  'home', 'traveling', 'exploring', 'open_to_plans', 'at_event', 'with_crew', 'unavailable',
]);

function mapTravelerState(r: any): TravelerStateView | null {
  if (!r || typeof r !== 'object') return null;
  const state = asString(r.state);
  if (!state || !TRAVELER_STATE_KINDS.has(state)) return null;
  return {
    state: state as TravelerStateKind,
    label: asString(r.label) ?? state.replace(/_/g, ' '),
    city: asString(r.city),
    validFrom: asString(r.validFrom ?? r.valid_from),
    expiresAt: asString(r.expiresAt ?? r.expires_at),
  };
}

const SOCIAL_AVAILABILITY: ReadonlySet<string> = new Set([
  'open', 'maybe', 'crew_only', 'following_only', 'not_open',
]);

function mapAvailability(r: any): PassportAvailabilityView | null {
  if (!r || typeof r !== 'object') return null;
  const social = asString(r.socialAvailability ?? r.social_availability);
  const cw = r.currentWindow ?? r.current_window;
  return {
    openToPlans: (r.openToPlans ?? r.open_to_plans) === true,
    socialAvailability: (social && SOCIAL_AVAILABILITY.has(social)
      ? social
      : 'not_open') as PassportAvailabilityView['socialAvailability'],
    currentWindow: cw && typeof cw === 'object'
      ? { status: asString(cw.status) ?? 'open', expiresAt: asString(cw.expiresAt ?? cw.expires_at) }
      : null,
    expiresAt: asString(r.expiresAt ?? r.expires_at),
  };
}

function mapTrust(r: any): PassportTrustView | null {
  if (!r || typeof r !== 'object') return null;
  const conf = asString(r.confidence);
  return {
    label: asString(r.label) ?? 'Trust',
    publicLevel: asString(r.publicLevel ?? r.public_level) ?? '',
    score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null,
    confidence: (conf === 'low' || conf === 'medium' || conf === 'high' ? conf : 'low'),
  };
}

function mapSharedContext(r: any): PassportSharedContextSummary | null {
  if (!r || typeof r !== 'object') return null;
  const rawFacts: unknown[] = Array.isArray(r.facts) ? r.facts : [];
  const facts = rawFacts.map((f: any) => ({
    key: String(f?.key ?? ''),
    label: asString(f?.label) ?? '',
    detail: asString(f?.detail),
  }));
  return {
    summaryLabel: asString(r.summaryLabel ?? r.summary_label) ?? 'Some overlap',
    factCount: facts.length,
    facts,
    handoffEligible: (r.compassHandoff ?? r.compass_handoff)?.eligible === true,
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
  const stamps: unknown[] = Array.isArray(p.stamps) ? p.stamps : [];
  const memories: unknown[] = Array.isArray(p.memories) ? p.memories : [];
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
    travelerState: mapTravelerState(p.travelerState ?? p.traveler_state),
    availability: mapAvailability(p.availability),
    trust: mapTrust(p.trust),
    hasTravelIdentity: p.travelIdentity != null && typeof p.travelIdentity === 'object',
    stats: mapStats(p.stats),
    recentStamps: stamps.map(mapStamp),
    featuredJourney: mapFeaturedJourney(p.featuredJourney ?? p.featured_journey),
    upcomingPlans: plans.map(mapPlan).filter((pl) => pl.tripId.length > 0),
    memories: memories.map(mapMemory).filter((m) => m.id.length > 0),
    sharedContext: mapSharedContext(p.sharedContext ?? p.shared_context),
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
