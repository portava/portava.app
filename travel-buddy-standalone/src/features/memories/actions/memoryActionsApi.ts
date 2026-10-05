/**
 * Client for §14 Executable Memories (census-highlights-memories H16/H107/H108/H259):
 *
 *   GET /api/memories/:id/actions           the menu — each action offered or
 *                                           refused, judged against the world now
 *   GET /api/memories/:id/actions/:action   one compile (DO_AGAIN, TAKE_ME_BACK,
 *                                           ADD_TO_TRIP, BRING_FORWARD_SAVED)
 *
 * Every function answers `{ ok: true, ... }` or `{ ok: false, kind, message }`.
 * A failed read is NEVER an empty menu: "we could not check" and "there is
 * nothing to do" are different sentences, and the action bar says the first.
 *
 * Add to Trip is a compile, not a write. The compiled payload is the CURRENT
 * place, and the write goes through the trip's own path (TripWishlistPicker →
 * POST /api/trips/:tripId/saved-places), never a second writer here.
 */
import { freshToken } from '../../../services/apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type MemoryActionName =
  | 'DO_AGAIN' | 'TAKE_ME_BACK' | 'ADD_TO_TRIP' | 'SAVE_EXPERIENCE' | 'BOOK_AGAIN'
  | 'NEW_TRIP_WITH_CREW' | 'BRING_FORWARD_SAVED' | 'USE_AS_INSPIRATION' | 'VIEW_PLACE';

export type CatalogCaution = 'TEMPORARILY_CLOSED' | 'MOVED' | 'UNVERIFIED';

export interface ActionDescriptor {
  action: MemoryActionName;
  available: boolean;
  reason: string | null;
  message: string | null;
  caution: CatalogCaution | null;
}

export interface CurrentPlace {
  id: string; name: string; category: string; address: string | null; city: string | null;
  countryCode: string | null; lat: number | null; lng: number | null; status: string;
}

export interface ActionMenu {
  engineVersion: string;
  memoryId: string;
  isOwner: boolean;
  place: CurrentPlace | null;
  actions: ActionDescriptor[];
}

/** The shape TripWishlistPicker takes (its AddToTripPayload). */
export interface AddToTripPayload {
  id: string; name: string; category: string; type: string | null;
  address: string | null; lat: number | null; lng: number | null;
}

export type NavigationTarget = {
  kind: 'catalog_place' | 'memory_location';
  placeId: string | null;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  historical: boolean;
};

export interface TripRef {
  id: string; title: string; destinationCity: string | null; destinationCountry: string | null;
  startDate: string | null; endDate: string | null; status: string;
}

export interface FreedomWindowView {
  id: string; beginsAt: string; endsAt: string; durationMinutes: number; confidence: string; certified: boolean;
}

export type FreedomLeg =
  | { consulted: true; tripId: string; decisionId: string; windows: FreedomWindowView[]; reading: string }
  | { consulted: false; tripId: string | null; info: string };

export type TripChoice =
  | { state: 'chosen'; trip: TripRef; candidates: TripRef[] }
  | { state: 'none_matching'; candidates: TripRef[] }
  | { state: 'no_trips'; candidates: TripRef[] }
  | { state: 'unreadable'; candidates: TripRef[] };

export interface FusionView {
  historical: { claim: string; as_of: string | null; establishes_current_status: false };
  current: { available: true; statement: string } | { available: false; reason: string };
  merged: false;
  may_state_current_status: boolean;
  fusion_note: string;
}

export interface DoAgainPlan {
  action: 'DO_AGAIN';
  place: CurrentPlace;
  caution: CatalogCaution | null;
  fusion: FusionView;
  tripChoice: TripChoice;
  freedom: FreedomLeg;
  addToTrip: AddToTripPayload;
  navigation: NavigationTarget;
}

export interface BroughtForward { savedAt: string | null; caution: CatalogCaution | null; addToTrip: AddToTripPayload }
export interface LeftBehind { placeName: string; reason: 'PLACE_CLOSED' | 'PLACE_NOT_IN_CATALOG' | 'ALREADY_EXPERIENCED' }

export type MemoryActionErrorKind =
  | 'not_found' | 'conflict' | 'forbidden' | 'invalid_payload' | 'unauthenticated'
  | 'degraded_unavailable' | 'db_error' | 'network_unreachable';

export type MemoryActionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: MemoryActionErrorKind; message: string; reason: string | null };

const KNOWN: readonly MemoryActionErrorKind[] = [
  'not_found', 'conflict', 'forbidden', 'invalid_payload', 'unauthenticated', 'degraded_unavailable', 'db_error', 'network_unreachable',
];

const FALLBACK: Record<MemoryActionErrorKind, string> = {
  not_found: 'This Memory is not available.',
  conflict: 'This cannot be done right now.',
  forbidden: 'You cannot do that here.',
  invalid_payload: 'That request was not valid.',
  unauthenticated: 'Please sign in again.',
  degraded_unavailable: 'This could not be checked right now. Please try again.',
  db_error: 'Something went wrong. Please try again.',
  network_unreachable: 'You appear to be offline. Check your connection and try again.',
};

function kindOf(status: number, body: unknown): MemoryActionErrorKind {
  const code = (body as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && (KNOWN as readonly string[]).includes(code)) return code as MemoryActionErrorKind;
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 403) return 'forbidden';
  if (status === 401) return 'unauthenticated';
  if (status === 400) return 'invalid_payload';
  if (status === 503) return 'degraded_unavailable';
  return 'db_error';
}

// The body is untrusted JSON: each `pick` narrows it field by field.
type Body = Record<string, unknown>;
async function getJson<T extends object>(path: string, pick: (b: Body) => T | null): Promise<MemoryActionResult<T>> {
  try {
    const token = await freshToken();
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const kind = kindOf(res.status, json);
      const message = (json as { message?: unknown } | null)?.message;
      const reason = (json as { reason?: unknown } | null)?.reason;
      return { ok: false, kind, message: typeof message === 'string' && message ? message : FALLBACK[kind], reason: typeof reason === 'string' ? reason : null };
    }
    const picked = json === null || typeof json !== 'object' ? null : pick(json as Body);
    if (picked === null) return { ok: false, kind: 'db_error', message: 'The server answered in a shape this app does not understand.', reason: null };
    return { ok: true, ...picked };
  } catch (e) {
    const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const offline = m.includes('network request failed') || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed');
    const kind: MemoryActionErrorKind = offline ? 'network_unreachable' : 'db_error';
    return { ok: false, kind, message: FALLBACK[kind], reason: null };
  }
}

const enc = encodeURIComponent;

export function getMemoryActions(memoryId: string): Promise<MemoryActionResult<{ menu: ActionMenu }>> {
  return getJson(`/api/memories/${enc(memoryId)}/actions`, (b) => {
    const m = b.menu as Partial<ActionMenu> | undefined;
    return m && Array.isArray(m.actions) && typeof m.memoryId === 'string' ? { menu: m as ActionMenu } : null;
  });
}

export function compileDoAgain(memoryId: string, tripId?: string | null): Promise<MemoryActionResult<{ plan: DoAgainPlan }>> {
  const q = tripId ? `?tripId=${enc(tripId)}` : '';
  return getJson(`/api/memories/${enc(memoryId)}/actions/DO_AGAIN${q}`, (b) => {
    const c = b.compiled as Partial<DoAgainPlan> | undefined;
    return c && c.action === 'DO_AGAIN' && c.addToTrip && c.tripChoice && c.freedom && c.fusion ? { plan: c as DoAgainPlan } : null;
  });
}

export function compileAddToTrip(memoryId: string): Promise<MemoryActionResult<{ addToTrip: AddToTripPayload; caution: CatalogCaution | null }>> {
  return getJson(`/api/memories/${enc(memoryId)}/actions/ADD_TO_TRIP`, (b) => {
    const c = b.compiled as { action?: string; addToTrip?: AddToTripPayload; caution?: CatalogCaution | null } | undefined;
    return c && c.action === 'ADD_TO_TRIP' && c.addToTrip && typeof c.addToTrip.id === 'string'
      ? { addToTrip: c.addToTrip as AddToTripPayload, caution: (c.caution ?? null) as CatalogCaution | null }
      : null;
  });
}

export function compileTakeMeBack(memoryId: string): Promise<MemoryActionResult<{ navigation: NavigationTarget; caution: CatalogCaution | null }>> {
  return getJson(`/api/memories/${enc(memoryId)}/actions/TAKE_ME_BACK`, (b) => {
    const c = b.compiled as { action?: string; navigation?: NavigationTarget; caution?: CatalogCaution | null } | undefined;
    return c && c.action === 'TAKE_ME_BACK' && c.navigation ? { navigation: c.navigation as NavigationTarget, caution: (c.caution ?? null) as CatalogCaution | null } : null;
  });
}

export function compileBringForward(memoryId: string): Promise<MemoryActionResult<{ items: BroughtForward[]; leftBehind: LeftBehind[] }>> {
  return getJson(`/api/memories/${enc(memoryId)}/actions/BRING_FORWARD_SAVED`, (b) => {
    const c = b.compiled as { items?: unknown; leftBehind?: unknown } | undefined;
    return c && Array.isArray(c.items) && Array.isArray(c.leftBehind) ? { items: c.items as BroughtForward[], leftBehind: c.leftBehind as LeftBehind[] } : null;
  });
}

/** A maps URL for a navigation target. Coordinates when known; the name otherwise. */
export function directionsUrl(t: NavigationTarget): string {
  if (t.lat != null && t.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${enc([t.label, t.address].filter(Boolean).join(', '))}`;
}

export const CAUTION_TEXT: Record<CatalogCaution, string> = {
  TEMPORARILY_CLOSED: 'Temporarily closed, according to Portava\'s place information.',
  MOVED: 'This place has moved — directions go to where it is now.',
  UNVERIFIED: 'Portava has not verified this place\'s details.',
};
