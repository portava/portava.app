/**
 * tripDestinations.ts — client for trip_destinations API endpoints.
 * Requires an authenticated session; uses freshToken from apiToken.
 */
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export interface TripDestination {
  id: string;
  city: string;
  country: string | null;
  lat: number | null;
  lng: number | null;
  place_id: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  position: number;
  created_at: string;
}

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void { _testAuthToken = t; }

async function freshToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
}

export async function listDestinations(tripId: string): Promise<TripDestination[]> {
  const token = await freshToken();
  if (!token) return [];
  const res = await fetch(`${apiBase()}/api/trips/${tripId}/destinations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return (data?.destinations ?? []) as TripDestination[];
}

export async function addDestination(
  tripId: string,
  dest: {
    city: string;
    country?: string | null;
    lat?: number | null;
    lng?: number | null;
    placeId?: string | null;
    arrivalDate?: string | null;
    departureDate?: string | null;
    position?: number;
  },
): Promise<TripDestination | null> {
  const token = await freshToken();
  if (!token) return null;
  const res = await fetch(`${apiBase()}/api/trips/${tripId}/destinations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      city: dest.city,
      country: dest.country ?? null,
      lat: dest.lat ?? null,
      lng: dest.lng ?? null,
      placeId: dest.placeId ?? null,
      arrivalDate: dest.arrivalDate ?? null,
      departureDate: dest.departureDate ?? null,
      position: dest.position ?? 0,
    }),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null) as Promise<TripDestination | null>;
}

export async function reorderDestinations(tripId: string, order: string[]): Promise<boolean> {
  const token = await freshToken();
  if (!token) return false;
  const res = await fetch(`${apiBase()}/api/trips/${tripId}/destinations/reorder`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  });
  return res.ok;
}
