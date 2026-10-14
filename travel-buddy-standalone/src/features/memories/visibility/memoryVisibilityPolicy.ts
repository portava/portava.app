/**
 * memoryVisibilityPolicy — the app's half of census-highlights-memories H33
 * (§3 `memory_visibility_policies`; server: routes/memoryVisibilityPolicy.ts,
 * migration 3810).
 *
 *   GET /api/memories/:id/visibility-policy   the owner's visibility status
 *   PUT /api/memories/:id/visibility-policy   { personVisibilityCeiling }
 *
 * The ceiling caps how the people on a Memory are shown to everyone except the
 * owner and the person themself. It can only narrow.
 *
 * Four answers, never a boolean: `ok`; `unavailable` (404 feature_disabled —
 * 3810 is not applied, so there is nothing to show or set); `not_found` (not
 * the caller's Memory); `error` (anything else — never read as "no limit").
 */
import { freshToken } from '../../../services/apiToken.ts';

/** §10's person ladder, most to least visible. The server's CHECK holds the same five. */
export const PERSON_CEILINGS = ['NAMED', 'PROFILE_LINKED', 'CREW_ONLY', 'ANONYMOUS_COUNT', 'HIDDEN'] as const;
export type PersonCeiling = (typeof PERSON_CEILINGS)[number];

export function isPersonCeiling(v: unknown): v is PersonCeiling {
  return typeof v === 'string' && (PERSON_CEILINGS as readonly string[]).includes(v);
}

/** What other people see of the people on this Memory, in plain words. `null` is no limit. */
export const CEILING_LABELS: Readonly<Record<PersonCeiling | 'NONE', string>> = {
  NONE: 'No limit',
  NAMED: 'Names',
  PROFILE_LINKED: 'Profiles only',
  CREW_ONLY: 'Trip crew only',
  ANONYMOUS_COUNT: 'Just a count',
  HIDDEN: 'Nobody',
};

export const AUDIENCE_LABELS: Readonly<Record<string, string>> = {
  public: 'Everyone',
  friends_only: 'Friends',
  trip_crew: 'Trip crew',
  circle_only: 'Circle',
  only_me: 'Only you',
  custom: 'Chosen people',
};

export const PRECISION_LABELS: Readonly<Record<string, string>> = {
  exact: 'Exact spot',
  venue: 'The place',
  neighborhood: 'Neighbourhood',
  city: 'City',
  country: 'Country',
  hidden: 'Hidden',
};

export interface VisibilityStatus {
  readonly memoryId: string;
  readonly audience: { readonly visibility: string | null; readonly allowedCount: number; readonly hiddenCount: number };
  readonly locationPrecision: { readonly chosen: string; readonly enforcement: 'on' | 'off' | 'unreadable' };
  readonly personCeiling: PersonCeiling | null;
}

export type VisibilityStatusRead =
  | { state: 'ok'; status: VisibilityStatus }
  | { state: 'unavailable' }
  | { state: 'not_found' }
  | { state: 'error'; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call(memoryId: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const token = await freshToken();
  const res = await fetch(`${apiBase()}/api/memories/${encodeURIComponent(memoryId)}/visibility-policy`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

function refusal(status: number, json: Record<string, unknown> | null): VisibilityStatusRead {
  if (status === 404 && json?.error === 'feature_disabled') return { state: 'unavailable' };
  if (status === 404) return { state: 'not_found' };
  return { state: 'error', message: json && typeof json.message === 'string' ? json.message : `HTTP ${status}` };
}

/** The owner's visibility status for one Memory. */
export async function fetchVisibilityStatus(memoryId: string): Promise<VisibilityStatusRead> {
  try {
    const { status, json } = await call(memoryId, { method: 'GET' });
    if (status !== 200 || !json) return refusal(status, json);
    const audience = json.audience as Record<string, unknown> | undefined;
    const precision = json.locationPrecision as Record<string, unknown> | undefined;
    const person = json.personVisibility as Record<string, unknown> | undefined;
    const enforcement = precision?.enforcement;
    if (!audience || !precision || !person || (enforcement !== 'on' && enforcement !== 'off' && enforcement !== 'unreadable')) {
      return { state: 'error', message: 'The server answered in a shape this app does not understand.' };
    }
    const ceiling = person.ceiling;
    if (ceiling !== null && !isPersonCeiling(ceiling)) {
      return { state: 'error', message: 'The server answered in a shape this app does not understand.' };
    }
    return {
      state: 'ok',
      status: {
        memoryId,
        audience: {
          visibility: typeof audience.visibility === 'string' ? audience.visibility : null,
          allowedCount: Array.isArray(audience.allowedUserIds) ? audience.allowedUserIds.length : 0,
          hiddenCount: Array.isArray(audience.hiddenUserIds) ? audience.hiddenUserIds.length : 0,
        },
        locationPrecision: { chosen: typeof precision.chosen === 'string' ? precision.chosen : 'hidden', enforcement },
        personCeiling: ceiling,
      },
    };
  } catch (e) {
    return { state: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Set (or, with null, clear) the ceiling. Only a 200 that echoes the value is success. */
export async function setPersonCeiling(memoryId: string, ceiling: PersonCeiling | null): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { status, json } = await call(memoryId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personVisibilityCeiling: ceiling }),
    });
    if (status === 200 && json && json.personVisibilityCeiling === ceiling) return { ok: true };
    const m = json && typeof json.message === 'string' ? json.message : `HTTP ${status}`;
    return { ok: false, message: m };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
