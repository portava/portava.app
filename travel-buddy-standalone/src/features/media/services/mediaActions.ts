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

    case 'share_telegraph':
      return { kind: 'navigate', route: '/telegraph/new' };

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
