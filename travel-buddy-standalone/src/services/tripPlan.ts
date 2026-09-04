import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import type { TripPlanItem, TripPlanCategory, TripPlanItemStatus, TripPlanSourceType, TripPlanLockType } from '../types/models.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

function planUrl(tripId: string, ...parts: string[]) {
  return `${apiBase()}/api/trips/${tripId}/plan${parts.length ? '/' + parts.join('/') : ''}`;
}

export interface CreatePlanItemPayload {
  title: string;
  category?: TripPlanCategory;
  status?: TripPlanItemStatus;
  sourceType?: TripPlanSourceType;
  sourceId?: string;
  dayDate?: string;
  startsAt?: string;
  endsAt?: string;
  locationName?: string;
  lat?: number | null;
  lng?: number | null;
  locationIsPrivate?: boolean;
  notes?: string;
  sortOrder?: number;
  lockType?: TripPlanLockType;
}

export interface UpdatePlanItemPayload {
  title?: string;
  category?: TripPlanCategory;
  status?: TripPlanItemStatus;
  dayDate?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  locationName?: string | null;
  lat?: number | null;
  lng?: number | null;
  locationIsPrivate?: boolean;
  notes?: string | null;
  sortOrder?: number;
  lockType?: TripPlanLockType;
}

export type PlanEditPermission = 'owner_only' | 'all_members' | 'specific_members';

export interface TripPlanResult {
  items: TripPlanItem[];
  canEdit: boolean;
}

export async function fetchTripPlan(tripId: string): Promise<TripPlanResult> {
  if (!isSupabaseConfigured) return { items: [], canEdit: false };
  const res = await authedFetch(planUrl(tripId));
  if (!res.ok) throw new Error(`fetchTripPlan ${res.status}`);
  const json = await res.json();
  return { items: json.items as TripPlanItem[], canEdit: json.canEdit === true };
}

export interface TripPlanPermissionResult {
  planEditPermission: PlanEditPermission;
  planEditors: string[];
  canEdit: boolean;
  isOwner: boolean;
}

export async function fetchTripPlanPermission(tripId: string): Promise<TripPlanPermissionResult> {
  const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/plan-permission`);
  if (!res.ok) throw new Error(`fetchTripPlanPermission ${res.status}`);
  return res.json();
}

export async function updateTripPlanPermission(
  tripId: string,
  planEditPermission: PlanEditPermission,
  planEditors?: string[],
): Promise<void> {
  const res = await authedFetch(`${apiBase()}/api/trips/${tripId}`, {
    method: 'PATCH',
    body: JSON.stringify({ planEditPermission, planEditors }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `updateTripPlanPermission ${res.status}`);
  }
}

export async function fetchTripPlanMap(tripId: string): Promise<TripPlanItem[]> {
  if (!isSupabaseConfigured) return [];
  const res = await authedFetch(planUrl(tripId, 'map'));
  if (!res.ok) throw new Error(`fetchTripPlanMap ${res.status}`);
  const json = await res.json();
  return json.items as TripPlanItem[];
}

export async function createPlanItem(
  tripId: string,
  payload: CreatePlanItemPayload,
): Promise<TripPlanItem> {
  const res = await authedFetch(planUrl(tripId, 'items'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `createPlanItem ${res.status}`);
  }
  return res.json();
}

export async function updatePlanItem(
  tripId: string,
  itemId: string,
  patch: UpdatePlanItemPayload,
): Promise<TripPlanItem> {
  const res = await authedFetch(planUrl(tripId, 'items', itemId), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `updatePlanItem ${res.status}`);
  }
  return res.json();
}

export async function removePlanItem(tripId: string, itemId: string): Promise<void> {
  const res = await authedFetch(planUrl(tripId, 'items', itemId, 'remove'), {
    method: 'PATCH',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `removePlanItem ${res.status}`);
  }
}

export async function deletePlanItem(tripId: string, itemId: string): Promise<void> {
  const res = await authedFetch(planUrl(tripId, 'items', itemId), {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `deletePlanItem ${res.status}`);
  }
}

export async function reorderPlanItem(
  tripId: string,
  itemId: string,
  sortOrder: number,
): Promise<void> {
  const res = await authedFetch(planUrl(tripId, 'items', itemId, 'reorder'), {
    method: 'POST',
    body: JSON.stringify({ sortOrder }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `reorderPlanItem ${res.status}`);
  }
}

/**
 * Persist a whole-day re-ordering in one owner-only write — the Trips path
 * Optimize Today (§11) acceptance goes through. `orderedItemIds` are existing
 * plan-item ids in the accepted order; the server reassigns their sort_order
 * slots (see POST /trips/:tripId/plan/reorder). Throws on any non-2xx so the
 * caller never treats an accepted proposal as saved unless it truly was.
 */
export async function reorderPlanItems(
  tripId: string,
  orderedItemIds: string[],
): Promise<void> {
  const res = await authedFetch(planUrl(tripId, 'reorder'), {
    method: 'POST',
    body: JSON.stringify({ orderedItemIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `reorderPlanItems ${res.status}`);
  }
}

// ── Editable trips ─────────────────────────────────────────────────────────────

export interface EditableTripRow {
  id: string;
  title: string;
  destinationCity: string;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  coverUrl: string | null;
}

export async function fetchPlanEditableTrips(): Promise<EditableTripRow[]> {
  if (!isSupabaseConfigured) return [];
  const res = await authedFetch(`${apiBase()}/api/me/plan-editable-trips`);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.trips ?? []) as EditableTripRow[];
}

export async function addMeetupToPlan(
  meetupId: string,
  tripId: string,
  opts: { lockType?: TripPlanLockType } = {},
): Promise<TripPlanItem> {
  const res = await authedFetch(`${apiBase()}/api/meetups/${meetupId}/add-to-trip-plan`, {
    method: 'POST',
    body: JSON.stringify({ tripId, ...opts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `addMeetupToPlan ${res.status}`);
  }
  return res.json();
}

export async function addPlaceToPlan(
  placeId: string,
  tripId: string,
  opts: { dayDate?: string; startsAt?: string; lockType?: TripPlanLockType } = {},
): Promise<TripPlanItem> {
  const res = await authedFetch(`${apiBase()}/api/places/${placeId}/add-to-trip-plan`, {
    method: 'POST',
    body: JSON.stringify({ tripId, ...opts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `addPlaceToPlan ${res.status}`);
  }
  return res.json();
}
