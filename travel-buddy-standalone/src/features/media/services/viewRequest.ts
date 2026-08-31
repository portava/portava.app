/**
 * features/media — Media v2 Phase 10 (Human Network) client (§19/§25/§46).
 *
 * Authenticated read/mutate client for the MERGED Phase-10 backend (#295):
 *   GET  /api/v1/media/places/:placeId/visual-coverage    → "Last visual update Nm ago" + staleness
 *   POST /api/v1/media/view-requests                       → request a current perspective of a place
 *   PUT  /api/v1/media/view-requests/opt-in                → the caller opts in/out as a view contributor
 *   GET  /api/v1/media/contributors/:contributorId/reputation → §25 intelligence-trust dimensions
 *
 * Follows the exact conventions of services/mediaActions.ts:
 *   - EXPO_PUBLIC_API_BASE_URL + a fresh Supabase bearer token,
 *   - a LAZY token seam (so node:test can inject a static token without pulling
 *     react-native into the runner — the pure mappers/presentation are unit-tested),
 *   - every call returns a typed result and NEVER throws,
 *   - a 404 / empty / non-JSON body degrades gracefully (§33): the affordance
 *     simply doesn't render, rather than crashing.
 *
 * The whole feature is gated OFF (`media_request_a_view_enabled`). The gate lives
 * client-side in the flag context; a request made while the flag is off is also
 * refused server-side (feature_disabled) and mapped here to a calm 'disabled'
 * reason — never an error toast.
 *
 * §25 boundary: the reputation mapper carries ONLY intelligence-trust dimensions.
 * There is no follower / like / stamp / leaderboard field anywhere in this module,
 * and the presentation strings deliberately avoid all popularity/vanity vocab
 * (asserted by test).
 */
import type { ProjectionResult, ProjectionErrorKind } from '../types/media.ts';
import type {
  VisualCoverage,
  ViewRequestOutcome,
  ViewRequestRefusalReason,
  OptInResult,
  ContributorReputation,
  ReputationDimension,
} from '../types/viewRequest.ts';

// ── Token seam (mirrors services/mediaActions.ts) ─────────────────────────────
let _testToken: string | null = null;
/** Inject a static token for node:test runs. Bypasses Supabase entirely. */
export function _setTestFreshToken(token: string): void {
  _testToken = token;
}
/** Remove the injected token. Always call in afterEach. */
export function _clearTestFreshToken(): void {
  _testToken = null;
}
async function freshToken(): Promise<string | null> {
  if (_testToken !== null) return _testToken;
  // Lazy seam so pure node:test suites never pull react-native. Fail-soft: if the
  // token module can't load or resolve (e.g. a jest VM without dynamic import),
  // return null — the caller then degrades to an auth error and the affordance
  // simply stays hidden, rather than throwing into a render.
  try {
    const { freshToken: real } = await import('../../../services/apiToken.ts');
    return await real();
  } catch {
    return null;
  }
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

// ── Coercion helpers (defensive; never throw) ─────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asBool(v: unknown): boolean {
  return v === true;
}
/** Finite number or null (NaN/Infinity/non-number ⇒ null). */
function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function clamp01(x: unknown): number {
  const n = asNum(x);
  if (n === null) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ── Pure mappers ──────────────────────────────────────────────────────────────

/**
 * Map GET /visual-coverage. The server returns `{ coverage: {...} }`; tolerate a
 * bare object too. Missing/garbage ⇒ a coverage void (stale + noCoverage) so the
 * caller treats it as "a gap to fill", never a fabricated fresh label.
 */
export function mapVisualCoverage(raw: unknown): VisualCoverage {
  const wrapped = isObj(raw) && 'coverage' in raw ? (raw as Record<string, unknown>).coverage : raw;
  const o = isObj(wrapped) ? wrapped : {};
  const lastObservedAt = asString(o.lastObservedAt);
  const noCoverage = 'noCoverage' in o ? asBool(o.noCoverage) : lastObservedAt === null;
  return {
    lastObservedAt,
    ageMinutes: asNum(o.ageMinutes),
    lastUpdateLabel: asString(o.lastUpdateLabel),
    // A missing/garbage payload is treated as stale (a gap), never as fresh.
    stale: 'stale' in o ? asBool(o.stale) : true,
    noCoverage,
  };
}

/**
 * Map GET /reputation. The server returns `{ reputation: {...} }`; tolerate a
 * bare object. `basis` is PINNED to 'intelligence_trust' — a mutated payload
 * claiming another basis cannot make the client render popularity as trust. All
 * three dimensions are clamped to 0..1; missing ⇒ 0 (unproven, not "trusted").
 */
export function mapContributorReputation(raw: unknown): ContributorReputation {
  const wrapped = isObj(raw) && 'reputation' in raw ? (raw as Record<string, unknown>).reputation : raw;
  const o = isObj(wrapped) ? wrapped : {};
  const contributorReliability = clamp01(o.contributorReliability);
  const placeExpertise = clamp01(o.placeExpertise);
  const liveAccuracy = clamp01(o.liveAccuracy);
  // Empty when the server said so, or when there is no signal at all. Pinned
  // so a UI never shows a hollow "0% trust" row for a contributor with no data.
  const isEmpty =
    'isEmpty' in o
      ? asBool(o.isEmpty)
      : contributorReliability === 0 && placeExpertise === 0 && liveAccuracy === 0;
  return {
    contributorReliability,
    placeExpertise,
    liveAccuracy,
    basis: 'intelligence_trust',
    isEmpty,
  };
}

// ── §25 presentation — intelligence-trust, NEVER popularity ───────────────────
//
// The labels/descriptions below are the ONLY human-facing trust vocabulary in
// the feature. They are deliberately about EVIDENCE (accepted observations,
// corroboration, place experience) — there is no "followers", "likes", "fans",
// "popular", "trending", "top", "rank", or "leaderboard" anywhere, and a test
// pins that so the boundary can't drift.

export const REPUTATION_TRUST_CAPTION = 'Intelligence trust · not popularity';

const DIMENSION_META: {
  key: ReputationDimension['key'];
  label: string;
  description: string;
}[] = [
  {
    key: 'contributorReliability',
    label: 'Contributor reliability',
    description: 'How often this contributor’s observations hold up',
  },
  {
    key: 'placeExpertise',
    label: 'Place expertise',
    description: 'Evidence-backed experience at this place',
  },
  {
    key: 'liveAccuracy',
    label: 'Live accuracy',
    description: 'How often current reads are independently corroborated',
  },
];

/** "82%" — a calm evidence indicator, never a rank or a raw count. */
export function percentLabel(value01: number): string {
  const v = clamp01(value01);
  return `${Math.round(v * 100)}%`;
}

/**
 * Turn a reputation into the ordered §25 dimensions to render as trust context.
 * Returns [] for an empty reputation (pre-launch / no signal) so the caller
 * renders nothing extra rather than three hollow 0% rows.
 */
export function reputationDisplayDimensions(rep: ContributorReputation | null): ReputationDimension[] {
  if (!rep || rep.isEmpty || rep.basis !== 'intelligence_trust') return [];
  return DIMENSION_META.map((m) => {
    const value = clamp01(rep[m.key]);
    return { key: m.key, label: m.label, description: m.description, value, percentLabel: percentLabel(value) };
  });
}

// ── Request-a-View gate + refusal messaging ───────────────────────────────────

/**
 * PURE render decision for the Request-a-View affordance (§19). The affordance
 * shows ONLY when the flag is on AND the place is a coverage gap (stale or no
 * coverage). Fail-soft: flag off / unknown, or coverage null ⇒ hidden. This is
 * the single source of the "dormant by default" rule, so it is unit-tested.
 */
export function shouldShowRequestPrompt(
  coverage: VisualCoverage | null,
  flagEnabled: boolean,
): boolean {
  if (!flagEnabled) return false;
  if (!coverage) return false;
  return coverage.stale || coverage.noCoverage;
}

/**
 * PURE: contributor opt-in optimistic-commit rule. Given the value we
 * optimistically painted, the value BEFORE the tap, and whether the server
 * accepted it, return the value to commit — keep the new value on success,
 * revert to the prior value on failure. Mirrors the §15.1 optimistic pattern so
 * the opt-in toggle's degrade rule is unit-tested and can't drift.
 */
export function resolveOptInAfterRequest(next: boolean, prior: boolean, ok: boolean): boolean {
  return ok ? next : prior;
}

/** Calm, human message for each refusal reason (§19/§46 — never an error storm). */
export function refusalMessage(reason: ViewRequestRefusalReason): string {
  switch (reason) {
    case 'disabled':
      return 'Requesting a view isn’t available here right now.';
    case 'rate_limited':
      return 'Plenty of interest already — give it a little while before asking again.';
    case 'duplicate':
      return 'Someone already asked for a fresh view here — hang tight.';
    case 'protected_location':
      return 'This place is kept quiet, so live views can’t be requested.';
    case 'invalid':
      return 'That request couldn’t be sent. Please try again.';
    case 'server':
    default:
      return 'Couldn’t ask right now — please try again in a moment.';
  }
}

/**
 * PURE: map an HTTP status + optional error code (from the server's
 * `{ error, message }` body) to a client refusal reason. Kept pure so the whole
 * mapping is unit-tested against the real STATUS table.
 */
export function refusalFromResponse(status: number, errorCode: string | null): ViewRequestRefusalReason {
  if (errorCode === 'feature_disabled') return 'disabled';
  switch (status) {
    case 400:
      return 'invalid';
    case 403:
      return 'protected_location';
    case 404:
      // feature_disabled is 404 too; any other 404 (route absent) is "disabled"
      // from the UI's point of view — the affordance simply can't be used.
      return 'disabled';
    case 409:
      return 'duplicate';
    case 429:
      return 'rate_limited';
    default:
      return 'server';
  }
}

// ── Transport ─────────────────────────────────────────────────────────────────

function classifyFetchError(err: unknown): ProjectionErrorKind {
  if (err instanceof Error && err.name === 'AbortError') return 'network';
  const msg = (err instanceof Error ? err.message : 'Unknown error').toLowerCase();
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')) return 'network';
  return 'unknown';
}

async function getJson<T>(
  path: string,
  map: (raw: unknown) => T,
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'auth', message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts?.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, data: null, errorKind: 'auth', message: 'Unauthorized' };
    }
    if (res.status === 404) {
      return { ok: false, data: null, errorKind: 'empty', message: 'Not available' };
    }
    if (!res.ok) {
      return { ok: false, data: null, errorKind: 'server', message: `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, data: null, errorKind: 'empty', message: 'Empty response' };
    }
    return { ok: true, data: map(body) };
  } catch (err) {
    return {
      ok: false,
      data: null,
      errorKind: classifyFetchError(err),
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * GET /visual-coverage — "Last visual update Nm ago" + staleness (§19). A 404 /
 * empty / non-JSON body degrades to `errorKind: 'empty'` so the caller hides the
 * affordance. A protected place returns 403 → 'auth'-classed here (hidden too).
 * Never throws.
 */
export function fetchVisualCoverage(
  placeId: string,
  args?: { claimFamily?: string; city?: string | null; signal?: AbortSignal },
): Promise<ProjectionResult<VisualCoverage>> {
  const qs = new URLSearchParams();
  if (args?.claimFamily) qs.set('claimFamily', args.claimFamily);
  if (args?.city) qs.set('city', args.city);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return getJson(
    `/api/v1/media/places/${encodeURIComponent(placeId)}/visual-coverage${suffix}`,
    mapVisualCoverage,
    { signal: args?.signal },
  );
}

/**
 * GET /reputation — a contributor's §25 intelligence-trust dimensions. A 404 /
 * empty body degrades to `errorKind: 'empty'`; the caller then renders no trust
 * context. Never throws. subjectId scopes the Place-Expertise dimension.
 */
export function fetchContributorReputation(
  contributorId: string,
  args?: { subjectId?: string | null; signal?: AbortSignal },
): Promise<ProjectionResult<ContributorReputation>> {
  const qs = new URLSearchParams();
  if (args?.subjectId) qs.set('subjectId', args.subjectId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return getJson(
    `/api/v1/media/contributors/${encodeURIComponent(contributorId)}/reputation${suffix}`,
    mapContributorReputation,
    { signal: args?.signal },
  );
}

export interface RequestViewInput {
  /** canonical places.id (mapped to the backend's subjectId). */
  placeId: string;
  /** e.g. "Is the entrance still busy?" */
  question: string;
  /** e.g. "crowd.level". Defaults to crowd.level. */
  claimFamily?: string;
  city?: string | null;
  zoneId?: string | null;
  /** Coverage-gap score (0..1) that motivated the request. */
  coverageScore?: number | null;
}

/**
 * POST /view-requests (§19). Sends a calm PROMPT for a fresh perspective. Every
 * backend gate (flag / throttle / dedupe / safety) returns a structured refusal
 * that this maps to a calm reason + message — NEVER an error toast storm. Never
 * throws. Identity is taken from the token server-side; the body never carries a
 * requester id. No precise-location field is ever sent by the UI.
 */
export async function requestView(input: RequestViewInput): Promise<ViewRequestOutcome> {
  const token = await freshToken();
  if (!token) return { ok: false, reason: 'disabled', message: refusalMessage('disabled') };
  const body = {
    subjectId: input.placeId,
    claimFamily: input.claimFamily ?? 'crowd.level',
    question: input.question,
    city: input.city ?? null,
    zoneId: input.zoneId ?? null,
    coverageScore: input.coverageScore ?? null,
  };
  try {
    const res = await fetch(`${apiBase()}/api/v1/media/view-requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      let payload: unknown = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      const o = isObj(payload) ? payload : {};
      return {
        ok: true,
        requestId: asString(o.requestId),
        missionCandidateId: asString(o.missionCandidateId),
        recipientCount: asNum(o.recipientCount) ?? 0,
      };
    }
    // Non-2xx → read the server error code when present, map to a calm reason.
    let errorCode: string | null = null;
    try {
      const errBody = await res.json();
      if (isObj(errBody)) errorCode = asString(errBody.error);
    } catch {
      errorCode = null;
    }
    const reason = refusalFromResponse(res.status, errorCode);
    return { ok: false, reason, message: refusalMessage(reason) };
  } catch {
    return { ok: false, reason: 'server', message: refusalMessage('server') };
  }
}

/**
 * PUT /view-requests/opt-in (§19). The caller opts IN/OUT of being asked to
 * contribute a view. Clear + revocable; off by default. Identity comes from the
 * token — the body only ever carries the caller's OWN choice. Never throws.
 */
export async function setContributorViewOptIn(
  optedIn: boolean,
  city?: string | null,
): Promise<OptInResult> {
  const token = await freshToken();
  if (!token) return { ok: false, optedIn, errorKind: 'auth' };
  try {
    const res = await fetch(`${apiBase()}/api/v1/media/view-requests/opt-in`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optedIn, city: city ?? null }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, optedIn, errorKind: 'auth' };
    if (!res.ok) return { ok: false, optedIn, errorKind: 'server' };
    let confirmed = optedIn;
    try {
      const payload = await res.json();
      if (isObj(payload) && typeof payload.optedIn === 'boolean') confirmed = payload.optedIn;
    } catch {
      confirmed = optedIn;
    }
    return { ok: true, optedIn: confirmed };
  } catch (err) {
    return { ok: false, optedIn, errorKind: classifyFetchError(err) === 'network' ? 'network' : 'unknown' };
  }
}
