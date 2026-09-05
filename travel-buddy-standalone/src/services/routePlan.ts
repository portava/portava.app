/**
 * Route Plan service — typed wrappers for the route plan API.
 * Follows the freshToken + apiBase + authedFetch pattern from tripPlan.ts.
 */
import { supabase } from '../lib/supabase.ts';
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

// ── Types ──────────────────────────────────────────────────────────────────────

export type RouteStyle = 'nightlife' | 'scenic' | 'foodie' | 'low_walking' | 'custom';
export type CheckpointStatus = 'pending' | 'arrived' | 'skipped' | 'cancelled';
export type TransportMode = 'walk' | 'rideshare' | 'transit' | 'bike' | 'drive';
export type RoutePlanStatus = 'draft' | 'active' | 'completed' | 'cancelled';

export interface StopLocation {
  label: string;
  lat: number;
  lng: number;
  address?: string;
}

export interface RouteStop {
  id: string;
  routePlanId: string;
  sourceType: string;
  sourceId: string | null;
  title: string;
  structuredLocation: StopLocation;
  orderIndex: number;
  plannedArrivalTime: string | null;
  plannedDepartureTime: string | null;
  checkpointStatus: CheckpointStatus;
  arrivedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouteLeg {
  id: string;
  routePlanId: string;
  fromStopId: string;
  toStopId: string;
  distanceMeters: number;
  durationSeconds: number;
  mode: TransportMode;
  provider: string | null;
  isApproximated: boolean;
  safetyNotes: string | null;
}

export interface RoutePlan {
  id: string;
  ownerUserId: string;
  tripId: string | null;
  title: string;
  startLocation: StopLocation | null;
  endLocation: StopLocation | null;
  /** Hotel/stay location from trip_plan_items (accommodation), populated by GET when trip_id is set */
  tripAccommodationLocation?: { lat: number; lng: number; label?: string } | null;
  routeStyle: RouteStyle;
  status: RoutePlanStatus;
  compassExplanation: string | null;
  isApproximated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FullRoutePlan {
  plan: RoutePlan;
  stops: RouteStop[];
  legs: RouteLeg[];
  warnings?: string[];
  totalDistanceMeters?: number;
  totalDurationSeconds?: number;
}

export interface CandidateStopInput {
  title: string;
  lat: number;
  lng: number;
  sourceType?: string;
  sourceId?: string;
  openingHoursNote?: string | null;
  category?: string | null;
}

export interface CreateRoutePlanPayload {
  title?: string;
  tripId?: string | null;
  routeStyle?: RouteStyle;
  startLocation?: { label?: string; lat: number; lng: number } | null;
  endLocation?: { label?: string; lat: number; lng: number } | null;
  stops: CandidateStopInput[];
}

// ── API calls ──────────────────────────────────────────────────────────────────

export async function createRoutePlan(payload: CreateRoutePlanPayload): Promise<FullRoutePlan> {
  const res = await authedFetch(`${apiBase()}/api/route-plans`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `createRoutePlan ${res.status}`);
  }
  return res.json();
}

export async function fetchRoutePlan(id: string): Promise<FullRoutePlan> {
  const res = await authedFetch(`${apiBase()}/api/route-plans/${id}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `fetchRoutePlan ${res.status}`);
  }
  return res.json();
}

/**
 * The viewer's own route plan for a trip (active first, else most recent), or
 * null when there is none. This is how the Trip Map (§11) feeds its route line
 * without a plan id — see GET /route-plans/for-trip/:tripId. Returns null rather
 * than throwing on a not-found or an unreadable response so a missing route
 * never blanks the map.
 */
export async function fetchTripRoutePlan(tripId: string): Promise<FullRoutePlan | null> {
  try {
    const res = await authedFetch(`${apiBase()}/api/route-plans/for-trip/${tripId}`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as FullRoutePlan | null;
    return body && body.plan ? body : null;
  } catch {
    return null;
  }
}

export interface PatchStopPayload {
  checkpointStatus?: CheckpointStatus;
  orderIndex?: number;
  arrivedAt?: string | null;
}

export async function patchRoutePlanStop(
  planId: string,
  stopId: string,
  payload: PatchStopPayload,
): Promise<RouteStop> {
  const res = await authedFetch(`${apiBase()}/api/route-plans/${planId}/stops/${stopId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `patchRoutePlanStop ${res.status}`);
  }
  return res.json();
}

export async function deleteRoutePlan(id: string): Promise<void> {
  const res = await authedFetch(`${apiBase()}/api/route-plans/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `deleteRoutePlan ${res.status}`);
  }
}

// ── Group member progress ──────────────────────────────────────────────────────

export interface RoutePlanMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  isOwner: boolean;
  arrivedCount: number;
  totalCount: number;
}

export interface RoutePlanMembersResult {
  members: RoutePlanMember[];
  totalStops: number;
  arrivedCount: number;
}

export async function fetchRoutePlanMembers(planId: string): Promise<RoutePlanMembersResult> {
  const res = await authedFetch(`${apiBase()}/api/route-plans/${planId}/members`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `fetchRoutePlanMembers ${res.status}`);
  }
  return res.json();
}

export async function joinRoutePlan(planId: string): Promise<void> {
  const res = await authedFetch(`${apiBase()}/api/route-plans/${planId}/members`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 201) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `joinRoutePlan ${res.status}`);
  }
}

export async function leaveRoutePlan(planId: string): Promise<void> {
  const res = await authedFetch(`${apiBase()}/api/route-plans/${planId}/members`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `leaveRoutePlan ${res.status}`);
  }
}
