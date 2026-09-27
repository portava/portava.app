/**
 * features/media — media action rail client (spec §14/§15/§15.1/§15.2/§32/§43).
 *
 * Authenticated read/mutate client for the MERGED Media v2 P6 backend (#292):
 *   - GET  /media/:id/actions                     → the eligible action set
 *   - POST /media/:id/intent  ("I Want This")      → record a want-signal
 *   - DELETE /media/:id/intent                     → undo the signal
 *   - GET  /media/experiences/:id/plan             → "Do This Experience" plan
 *
 * Follows the exact conventions of services/mediaProjection.ts:
 *   - EXPO_PUBLIC_API_BASE_URL + a fresh Supabase bearer token,
 *   - a LAZY token seam (so node:test can inject a static token without pulling
 *     react-native into the runner — the pure mappers/resolver are unit-tested),
 *   - every fetch returns a typed result and NEVER throws,
 *   - a 404 (route not deployed) degrades to an EMPTY result, not an error, so
 *     the rail simply shows no actions rather than crashing (§33 degrade rule).
 *
 * The client renders ONLY the actions the server returned (each is auth/
 * eligibility-gated server-side, §47) — it never invents or re-enables one.
 */
import type { ProjectionResult, ProjectionErrorKind } from '../types/media.ts';
import type {
  MediaAction,
  MediaActionId,
  MediaActionOutcome,
  MediaActionSet,
  MediaEntityKind,
  MediaEntityRef,
  MediaIntentKind,
  ExperiencePlanProposal,
  ExperiencePlanStop,
  CompiledExperiencePlan,
  CompiledPlanStop,
  RouteStopRef,
  LinkableEventRef,
} from '../types/mediaActions.ts';

// ── Token seam (mirrors services/mediaProjection.ts) ──────────────────────────
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
  const { freshToken: real } = await import('../../../services/apiToken.ts');
  return real();
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
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

// ── Known vocab (used to validate, never to drop server-eligible actions) ─────

export const MEDIA_ACTION_IDS: readonly MediaActionId[] = [
  'show_on_map',
  'see_nearby',
  'find_similar',
  'ask_compass',
  'create_plan',
  'save',
  'add_to_trip',
  'do_this_experience',
  'view_experience',
  'meet_here',
  'i_want_this',
  'share_telegraph',
  'report',
  'directions',
  'view_event',
  'view_passport',
  'find_quieter',
  'find_cheaper', 'find_busier',
  'contribute_gem',
  'invite_people',
  'follow_this_night',
  'save_route',
  'link_event',
];

export const MEDIA_INTENT_KINDS: readonly MediaIntentKind[] = [
  'want_to_go',
  'want_to_do',
  'want_similar',
];

const ENTITY_KINDS: readonly MediaEntityKind[] = ['media', 'place', 'trip', 'gem'];
const ACTION_OUTCOMES: readonly MediaActionOutcome[] = [
  'navigate',
  'compass',
  'plan',
  'save',
  'meet',
  'want',
  'share',
  'moderate',
  'discover',
  'contribute',
];
const HTTP_METHODS = ['GET', 'POST', 'DELETE'] as const;

// ── Pure mappers ──────────────────────────────────────────────────────────────

function mapEntityRef(raw: unknown): MediaEntityRef | null {
  if (!isObj(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    kind: oneOf<MediaEntityKind>(raw.kind, ENTITY_KINDS, 'media'),
    id,
    label: asString(raw.label),
  };
}

function mapAction(raw: unknown): MediaAction | null {
  if (!isObj(raw)) return null;
  const id = asString(raw.id);
  const label = asString(raw.label);
  if (!id || !label) return null;
  const targetRaw = isObj(raw.target) ? raw.target : null;
  if (!targetRaw) return null;
  const endpoint = asString(targetRaw.endpoint);
  if (!endpoint) return null;
  return {
    // Preserve the server id verbatim (typed as MediaActionId when known); an
    // unrecognised future id stays a string and is simply not rendered.
    id: id as MediaActionId,
    label,
    outcome: oneOf<MediaActionOutcome>(raw.outcome, ACTION_OUTCOMES, 'navigate'),
    target: {
      method: oneOf(targetRaw.method, HTTP_METHODS, 'GET'),
      endpoint,
      params: isObj(targetRaw.params) ? targetRaw.params : {},
    },
  };
}

/**
 * Map GET /media/:id/actions. Safe on `{}` / null / garbage — every collection
 * degrades to []. Renders exactly the actions the server returned (each already
 * eligibility-gated); malformed entries are dropped, never fabricated.
 */
export function mapMediaActionSet(raw: unknown): MediaActionSet {
  const o = isObj(raw) ? raw : {};
  return {
    mediaId: asString(o.mediaId) ?? '',
    entityRefs: asArray(o.entityRefs)
      .map(mapEntityRef)
      .filter((r): r is MediaEntityRef => r !== null),
    actions: asArray(o.actions)
      .map(mapAction)
      .filter((a): a is MediaAction => a !== null),
    generatedAt: asString(o.generatedAt),
  };
}

function mapStop(raw: unknown): ExperiencePlanStop | null {
  if (!isObj(raw)) return null;
  const sourceId = asString(raw.sourceId);
  if (!sourceId) return null;
  return {
    sourceType: oneOf<ExperiencePlanStop['sourceType']>(
      raw.sourceType,
      ['place', 'media', 'trip'],
      'place',
    ),
    sourceId,
    title: asString(raw.title) ?? 'Stop',
    category: asString(raw.category) ?? 'activity',
  };
}

/**
 * Map GET /media/experiences/:id/plan. Returns null when the payload carries no
 * usable experience id (unavailable / 404 / garbage) so the caller degrades to
 * "no plan" rather than routing into an empty flow.
 */
export function mapExperiencePlan(raw: unknown): ExperiencePlanProposal | null {
  if (!isObj(raw)) return null;
  const experienceId = asString(raw.experienceId);
  if (!experienceId) return null;
  return {
    experienceId,
    kind: oneOf<ExperiencePlanProposal['kind']>(raw.kind, ['event', 'trip'], 'trip'),
    targetEndpoint: asString(raw.targetEndpoint) ?? '/api/trips/:tripId/plan/items',
    method: 'POST',
    stops: asArray(raw.stops)
      .map(mapStop)
      .filter((s): s is ExperiencePlanStop => s !== null),
    eligibleTripIds: asArray(raw.eligibleTripIds)
      .map((id) => asString(id))
      .filter((id): id is string => id !== null),
    generatedAt: asString(raw.generatedAt),
  };
}

// ── Pure action resolver — maps a server action to a CLIENT destination ───────
//
// The server tells the client WHICH actions are eligible and WHAT canonical
// endpoint each targets; this resolver maps each one to the EXISTING client
// navigation / affordance (never a re-implementation). It is pure so the whole
// dispatch table is unit-testable. An unrecognised id resolves to 'unsupported'
// so the rail can hide it — guaranteeing no dead/disabled rows.

/** A lightweight PlanPicker source descriptor (avoids importing the RN module). */
export interface PlanPickerSourceLite {
  id: string;
  type: 'place' | 'media' | 'experience';
  title: string;
  category?: string;
}

export type MediaActionExecution =
  | { kind: 'navigate'; route: string }
  | { kind: 'compass'; mediaId: string; prompt: string }
  | { kind: 'intent' }
  | { kind: 'experience_plan'; experienceId: string }
  | { kind: 'plan_picker'; source: PlanPickerSourceLite }
  | { kind: 'save' }
  | { kind: 'report' }
  // census-media §21
  | { kind: 'directions'; placeId: string }
  | { kind: 'telegraph_share'; objectType: 'POST'; objectId: string }
  | { kind: 'compiled_plan'; experienceId: string; source: 'experience' | 'trail' }
  | { kind: 'save_route'; title: string; stops: RouteStopRef[]; mediaId: string | null }
  | { kind: 'invite'; momentId: string; mediaId: string | null }
  | { kind: 'contribute_gem'; gemId: string; mediaId: string | null }
  | { kind: 'link_event'; mediaId: string; candidates: LinkableEventRef[] }
  | { kind: 'unsupported' };

/** Default prompts seeded into Compass when opened from the media context (§32). */
export const ASK_COMPASS_DEFAULT_PROMPT = 'Tell me about this place and what I can do here.';
export const CREATE_PLAN_DEFAULT_PROMPT = 'Build a plan around this.';

function paramStr(action: MediaAction, key: string): string | null {
  return asString(action.target.params?.[key]);
}
function refId(entityRefs: MediaEntityRef[], kind: MediaEntityKind): string | null {
  return entityRefs.find((r) => r.kind === kind)?.id ?? null;
}
function refLabel(entityRefs: MediaEntityRef[], kind: MediaEntityKind): string | null {
  return entityRefs.find((r) => r.kind === kind)?.label ?? null;
}

export function resolveMediaActionExecution(
  action: MediaAction,
  entityRefs: MediaEntityRef[],
): MediaActionExecution {
  switch (action.id) {
    case 'show_on_map': {
      const placeId = paramStr(action, 'placeId') ?? refId(entityRefs, 'place');
      return placeId
        ? { kind: 'navigate', route: `/place/${encodeURIComponent(placeId)}` }
        : { kind: 'unsupported' };
    }
    case 'see_nearby':
    case 'find_similar':
      // The city media map / world lens buckets live in the World shell.
      return { kind: 'navigate', route: '/media-world' };

    case 'ask_compass': {
      const mediaId = paramStr(action, 'mediaId') ?? refId(entityRefs, 'media');
      if (!mediaId) return { kind: 'unsupported' };
      return {
        kind: 'compass',
        mediaId,
        prompt: paramStr(action, 'prompt') ?? ASK_COMPASS_DEFAULT_PROMPT,
      };
    }
    case 'create_plan': {
      const mediaId = paramStr(action, 'mediaId') ?? refId(entityRefs, 'media');
      if (!mediaId) return { kind: 'unsupported' };
      return {
        kind: 'compass',
        mediaId,
        prompt: paramStr(action, 'prompt') ?? CREATE_PLAN_DEFAULT_PROMPT,
      };
    }

    case 'i_want_this':
      return { kind: 'intent' };

    case 'save':
      return { kind: 'save' };

    case 'report':
      return { kind: 'report' };

    case 'add_to_trip': {
      const sourceId = paramStr(action, 'sourceId') ?? refId(entityRefs, 'place');
      if (!sourceId) return { kind: 'unsupported' };
      const sType = paramStr(action, 'sourceType');
      return {
        kind: 'plan_picker',
        source: {
          id: sourceId,
          type: sType === 'place' ? 'place' : 'media',
          title: paramStr(action, 'title') ?? refLabel(entityRefs, 'place') ?? 'Saved place',
          category: paramStr(action, 'category') ?? 'activity',
        },
      };
    }

    case 'do_this_experience': {
      // §15.2 — a server that compiles (census-media §21) says so with
      // `compile: true`; the plan it serves is the executable, timed one.
      if (action.target.params?.compile === true) {
        const id = paramStr(action, 'experienceId') ?? paramStr(action, 'sourceExperienceId');
        const source = paramStr(action, 'source') === 'trail' ? 'trail' : 'experience';
        return id ? { kind: 'compiled_plan', experienceId: id, source } : { kind: 'unsupported' };
      }
      const experienceId = paramStr(action, 'sourceExperienceId') ?? refId(entityRefs, 'trip');
      return experienceId ? { kind: 'experience_plan', experienceId } : { kind: 'unsupported' };
    }

    case 'view_experience': {
      const experienceId = paramStr(action, 'experienceId') ?? refId(entityRefs, 'trip');
      return experienceId
        ? { kind: 'navigate', route: `/trip/${encodeURIComponent(experienceId)}` }
        : { kind: 'unsupported' };
    }

    case 'meet_here':
      return { kind: 'navigate', route: '/meetups' };

    case 'share_telegraph': {
      // Telegraph §5's own share contract: a revocable REFERENCE to the post,
      // written into a thread the user picks. An older server that sends no
      // object reference keeps the old hand-off.
      const objectId = paramStr(action, 'objectId');
      if (paramStr(action, 'objectType') === 'POST' && objectId) {
        return { kind: 'telegraph_share', objectType: 'POST', objectId };
      }
      return { kind: 'navigate', route: '/telegraph/new' };
    }

    // ── census-media §21 ────────────────────────────────────────────────────
    case 'directions': {
      const placeId = paramStr(action, 'placeId') ?? refId(entityRefs, 'place');
      return placeId ? { kind: 'directions', placeId } : { kind: 'unsupported' };
    }
    case 'view_event': {
      const eventId = paramStr(action, 'experienceId');
      return eventId ? { kind: 'navigate', route: `/event/${encodeURIComponent(eventId)}` } : { kind: 'unsupported' };
    }
    case 'view_passport': {
      // §29: the Passport view of a media item IS its Postcard.
      const postId = paramStr(action, 'id') ?? refId(entityRefs, 'media');
      return postId ? { kind: 'navigate', route: `/postcard/${encodeURIComponent(postId)}` } : { kind: 'unsupported' };
    }
    case 'find_quieter':
    case 'find_cheaper': case 'find_busier': {
      const mediaId = paramStr(action, 'mediaId') ?? refId(entityRefs, 'media');
      const prompt = paramStr(action, 'prompt');
      return mediaId && prompt ? { kind: 'compass', mediaId, prompt } : { kind: 'unsupported' };
    }
    case 'follow_this_night': {
      const experienceId = paramStr(action, 'experienceId');
      return experienceId
        ? { kind: 'navigate', route: `/trip/${encodeURIComponent(experienceId)}` }
        : { kind: 'unsupported' };
    }
    case 'save_route': {
      const stops = asArray(action.target.params?.stops)
        .map((raw): RouteStopRef | null => {
          if (!isObj(raw)) return null;
          const sourceId = asString(raw.sourceId);
          if (!sourceId || raw.sourceType !== 'place') return null;
          return { sourceType: 'place', sourceId, title: asString(raw.title) ?? 'Stop' };
        })
        .filter((x): x is RouteStopRef => x !== null);
      // The route endpoint requires two stops; a rail row that cannot succeed is hidden.
      if (stops.length < 2) return { kind: 'unsupported' };
      return {
        kind: 'save_route',
        title: paramStr(action, 'title') ?? 'Saved route',
        stops,
        mediaId: refId(entityRefs, 'media'),
      };
    }
    case 'invite_people': {
      const momentId = paramStr(action, 'id');
      return momentId ? { kind: 'invite', momentId, mediaId: refId(entityRefs, 'media') } : { kind: 'unsupported' };
    }
    case 'link_event': {
      // The author's own post → an event they took part in. Only the events the
      // server offered (its predicate is the endpoint's); none → no row.
      const mediaId = paramStr(action, 'id') ?? refId(entityRefs, 'media');
      const candidates = asArray(action.target.params?.candidates)
        .map((raw): LinkableEventRef | null => {
          if (!isObj(raw)) return null;
          const eventId = asString(raw.eventId);
          return eventId ? { eventId, title: asString(raw.title), startsAt: asString(raw.startsAt) } : null;
        })
        .filter((x): x is LinkableEventRef => x !== null);
      return mediaId && candidates.length > 0 ? { kind: 'link_event', mediaId, candidates } : { kind: 'unsupported' };
    }
    case 'contribute_gem': {
      const gemId = paramStr(action, 'id');
      return gemId
        ? { kind: 'contribute_gem', gemId, mediaId: paramStr(action, 'originMediaId') ?? refId(entityRefs, 'media') }
        : { kind: 'unsupported' };
    }

    default:
      // An unrecognised (future) server action — hidden, never rendered dead.
      return { kind: 'unsupported' };
  }
}

/**
 * Optimistic "I Want This" toggle + degrade resolution (§15.1). Given the value
 * we optimistically painted, the value BEFORE the tap, and whether the request
 * succeeded, return the value to commit: keep the optimistic value on success,
 * revert to the prior value on failure. Pure — the hook's single source of the
 * toggle+degrade rule, so it is unit-tested directly.
 */
export function resolveWantedAfterRequest(
  optimistic: boolean,
  prior: boolean,
  ok: boolean,
): boolean {
  return ok ? optimistic : prior;
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
      // Item not visible to this viewer, or route not deployed → treat as empty.
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
 * GET /media/:id/actions — the eligible action set. A 404 / empty / non-JSON
 * body degrades to `errorKind: 'empty'` so the caller shows no rail. Never throws.
 */
export function fetchMediaActions(
  mediaId: string,
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<MediaActionSet>> {
  return getJson(
    `/api/media/${encodeURIComponent(mediaId)}/actions`,
    (b) => {
      // The server returns the set bare ({ mediaId, entityRefs, actions,
      // generatedAt }); tolerate a defensive { result: {...} } wrapper too.
      const inner = isObj(b) && !('actions' in b) && 'result' in b
        ? (b as Record<string, unknown>).result
        : b;
      return mapMediaActionSet(inner);
    },
    opts,
  );
}

/**
 * GET /media/experiences/:id/plan — the "Do This Experience" proposal (§15.2).
 * A 404 / empty payload degrades to `ok:true, data:null` (no plan) so the caller
 * routes nowhere rather than into an empty flow. Never throws.
 */
export async function fetchExperiencePlan(
  experienceId: string,
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<ExperiencePlanProposal | null>> {
  const r = await getJson(
    `/api/media/experiences/${encodeURIComponent(experienceId)}/plan`,
    (b) => {
      const inner = isObj(b) && 'plan' in b ? (b as Record<string, unknown>).plan : b;
      return mapExperiencePlan(inner);
    },
    opts,
  );
  // A 404 for a plan is "no plan for this viewer" — an ok/empty, not an error.
  if (!r.ok && r.errorKind === 'empty') return { ok: true, data: null };
  return r;
}

export interface IntentMutationResult {
  ok: boolean;
  errorKind?: ProjectionErrorKind;
}

/**
 * POST /media/:id/intent ("I Want This", §15.1). Records a want-SIGNAL — never a
 * like/save. The server resolves the keyed entity; the body carries only the
 * optional intent kind. Never throws.
 */
export async function postMediaIntent(
  mediaId: string,
  intent: MediaIntentKind = 'want_to_go',
): Promise<IntentMutationResult> {
  const token = await freshToken();
  if (!token) return { ok: false, errorKind: 'auth' };
  try {
    const res = await fetch(`${apiBase()}/api/media/${encodeURIComponent(mediaId)}/intent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, errorKind: 'auth' };
    if (!res.ok) return { ok: false, errorKind: 'server' };
    return { ok: true };
  } catch (err) {
    return { ok: false, errorKind: classifyFetchError(err) };
  }
}

/** DELETE /media/:id/intent — undo the "I Want This" signal. Never throws. */
export async function deleteMediaIntent(mediaId: string): Promise<IntentMutationResult> {
  const token = await freshToken();
  if (!token) return { ok: false, errorKind: 'auth' };
  try {
    const res = await fetch(`${apiBase()}/api/media/${encodeURIComponent(mediaId)}/intent`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, errorKind: 'auth' };
    if (!res.ok) return { ok: false, errorKind: 'server' };
    return { ok: true };
  } catch (err) {
    return { ok: false, errorKind: classifyFetchError(err) };
  }
}

// ── census-media §21 — Go There, the executable plan, Save Route ─────────────

export interface DirectionsUrls {
  appleMaps: string;
  googleMaps: string;
  waze: string;
}

/**
 * The Places page's `directionsUrl` for this platform: Apple Maps on iOS,
 * Google Maps elsewhere. Null when the place has no directions (no coordinates
 * on its canonical record) — the rail then says so instead of opening nothing.
 */
export function pickDirectionsUrl(urls: DirectionsUrls | null | undefined, platform: string): string | null {
  if (!urls) return null;
  const url = platform === 'ios' ? urls.appleMaps : urls.googleMaps;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

export type DirectionsOutcome = 'opened' | 'no_directions' | 'failed';

/**
 * Go There (§15, MD94). Reads the place's directions through the Places page,
 * opens the maps app, and ONLY THEN calls `onOpened` — which is where the rail
 * records Directions started (§44) and Media → Route (§45). A place without
 * directions, a failed read, or a maps app that refused to open records
 * nothing: a tap is not a start. Never throws.
 */
export async function openDirectionsForPlace(
  placeId: string,
  deps: {
    platform: string;
    loadDirections: (placeId: string) => Promise<DirectionsUrls | null | undefined>;
    openUrl: (url: string) => Promise<unknown>;
    onOpened: () => void;
  },
): Promise<DirectionsOutcome> {
  let urls: DirectionsUrls | null | undefined;
  try {
    urls = await deps.loadDirections(placeId);
  } catch {
    return 'failed';
  }
  const url = pickDirectionsUrl(urls, deps.platform);
  if (!url) return 'no_directions';
  try {
    await deps.openUrl(url);
  } catch {
    return 'failed';
  }
  try {
    deps.onOpened();
  } catch {
    // telemetry never breaks the action
  }
  return 'opened';
}

function mapCompiledStop(raw: unknown): CompiledPlanStop | null {
  const base = mapStop(raw);
  if (!base || !isObj(raw)) return null;
  const startsAt = asString(raw.startsAt);
  const endsAt = asString(raw.endsAt);
  if (!startsAt || !endsAt) return null;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    ...base,
    order: num(raw.order, 0),
    startsAt,
    endsAt,
    dwellMinutes: num(raw.dwellMinutes, 0),
    transitMinutesBefore: num(raw.transitMinutesBefore, 0),
    transitBasis: raw.transitBasis === 'default' ? 'default' : 'none',
  };
}

/** Map `{ compiled }` from GET /media/experiences/:id/plan?compile=1. Null on garbage. */
export function mapCompiledPlan(raw: unknown): CompiledExperiencePlan | null {
  const o = isObj(raw) && isObj(raw.compiled) ? raw.compiled : raw;
  if (!isObj(o) || !isObj(o.source)) return null;
  const id = asString(o.source.id);
  const day = asString(o.day);
  if (!id || !day) return null;
  const stops = asArray(o.stops).map(mapCompiledStop).filter((x): x is CompiledPlanStop => x !== null);
  if (stops.length === 0) return null;
  return {
    source: { kind: o.source.kind === 'trail' ? 'trail' : 'experience', id, title: asString(o.source.title) },
    day,
    startsAt: asString(o.startsAt) ?? stops[0].startsAt,
    stops,
    eligibleTripIds: asArray(o.eligibleTripIds).map(asString).filter((x): x is string => x !== null),
    feasibility: asString(o.feasibility) ?? 'not_verified',
  };
}

/** GET /media/experiences/:id/plan?compile=1 — the executable plan. 404 ⇒ no plan. Never throws. */
export async function fetchCompiledExperiencePlan(
  experienceId: string,
  opts: { source: 'experience' | 'trail'; day?: string; signal?: AbortSignal },
): Promise<ProjectionResult<CompiledExperiencePlan | null>> {
  const q = `compile=1&source=${opts.source}${opts.day ? `&day=${encodeURIComponent(opts.day)}` : ''}`;
  const r = await getJson(
    `/api/media/experiences/${encodeURIComponent(experienceId)}/plan?${q}`,
    mapCompiledPlan,
    { signal: opts.signal },
  );
  if (!r.ok && r.errorKind === 'empty') return { ok: true, data: null };
  return r;
}

/** One plan item as POST /trips/:tripId/plan/items takes it (tripPlan.CreatePlanItemPayload). */
export interface PlanItemDraft {
  title: string;
  category: 'activity';
  status: 'tentative';
  sourceType: 'place' | 'manual';
  sourceId?: string;
  dayDate: string;
  startsAt: string;
  endsAt: string;
  sortOrder: number;
  lockType: 'flexible';
}

/**
 * The compiled plan as the trip-plan endpoint takes it: one TENTATIVE item per
 * stop, in order, with the compiled times — a proposal the crew can move, not a
 * booking. Place stops keep their canonical id; anything else is 'manual'.
 */
export function planItemsFromCompiledPlan(plan: CompiledExperiencePlan): PlanItemDraft[] {
  return [...plan.stops]
    .sort((a, b) => a.order - b.order)
    .map((s, i): PlanItemDraft => ({
      title: s.title,
      category: 'activity',
      status: 'tentative',
      sourceType: s.sourceType === 'place' ? 'place' : 'manual',
      ...(s.sourceType === 'place' ? { sourceId: s.sourceId } : {}),
      dayDate: plan.day,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      sortOrder: i,
      lockType: 'flexible',
    }));
}

/**
 * Write the compiled plan into ONE trip the user chose, stop by stop through
 * the existing plan-item endpoint (injected, so this stays testable). Only a
 * trip the server named as eligible; a duplicate or failed stop does not abort
 * the rest, and the counts say what landed.
 */
export async function applyCompiledPlan(
  plan: CompiledExperiencePlan,
  tripId: string,
  createItem: (tripId: string, item: PlanItemDraft) => Promise<unknown>,
): Promise<{ created: number; failed: number }> {
  if (!plan.eligibleTripIds.includes(tripId)) return { created: 0, failed: plan.stops.length };
  let created = 0;
  let failed = 0;
  for (const item of planItemsFromCompiledPlan(plan)) {
    try {
      await createItem(tripId, item);
      created += 1;
    } catch {
      failed += 1;
    }
  }
  return { created, failed };
}

export type SaveMediaRouteResult =
  | { ok: true; routeId: string }
  | { ok: false; reason: 'too_few_stops' | 'unresolved_stops' | 'create_failed' };

export interface MediaRouteStopPayload {
  title: string;
  lat: number;
  lng: number;
  sourceType: 'place';
  sourceId: string;
}

/**
 * §23.1 Save Route. The rail is coordinate-free by construction, so each stop
 * is completed through the canonical place record (injected resolver) before
 * POST /route-plans, which requires lat/lng and at least two stops. A stop that
 * cannot be resolved is dropped; fewer than two resolvable stops is a refusal,
 * never a one-stop "route". `originMediaId` lets the server record Media →
 * Route keyed by the plan id.
 */
export async function saveMediaRoute(
  input: { title: string; stops: RouteStopRef[]; mediaId: string | null },
  deps: {
    resolveCoords: (placeId: string) => Promise<{ lat: number; lng: number } | null>;
    createRoute: (payload: {
      title: string;
      routeStyle: 'custom';
      stops: MediaRouteStopPayload[];
      originMediaId?: string;
    }) => Promise<{ plan?: { id?: string } | null } | null>;
  },
): Promise<SaveMediaRouteResult> {
  if (input.stops.length < 2) return { ok: false, reason: 'too_few_stops' };
  const resolved: MediaRouteStopPayload[] = [];
  for (const st of input.stops.slice(0, 20)) {
    const c = await deps.resolveCoords(st.sourceId).catch(() => null);
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      resolved.push({ title: st.title, lat: c.lat, lng: c.lng, sourceType: 'place', sourceId: st.sourceId });
    }
  }
  if (resolved.length < 2) return { ok: false, reason: 'unresolved_stops' };
  try {
    const full = await deps.createRoute({
      title: input.title,
      routeStyle: 'custom',
      stops: resolved,
      ...(input.mediaId ? { originMediaId: input.mediaId } : {}),
    });
    // POST /route-plans answers { plan, stops, legs } (routePlan.FullRoutePlan).
    const id = full?.plan?.id;
    return typeof id === 'string' && id.length > 0 ? { ok: true, routeId: id } : { ok: false, reason: 'create_failed' };
  } catch {
    return { ok: false, reason: 'create_failed' };
  }
}

/**
 * POST /media/:id/event-link — the author links their own post to an event
 * (census-media §21, MD103). The server re-checks the same predicate that
 * offered the action; a refusal is reported, never swallowed. Never throws.
 */
export async function linkMediaToEvent(
  mediaId: string,
  eventId: string,
): Promise<{ ok: true } | { ok: false; errorKind: 'auth' | 'refused' | 'server' | ProjectionErrorKind }> {
  const token = await freshToken();
  if (!token) return { ok: false, errorKind: 'auth' };
  try {
    const res = await fetch(`${apiBase()}/api/media/${encodeURIComponent(mediaId)}/event-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId }),
    });
    if (res.status === 401) return { ok: false, errorKind: 'auth' };
    if (res.status === 403 || res.status === 404) return { ok: false, errorKind: 'refused' };
    if (!res.ok) return { ok: false, errorKind: 'server' };
    return { ok: true };
  } catch (err) {
    return { ok: false, errorKind: classifyFetchError(err) };
  }
}
