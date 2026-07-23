/**
 * neighborhoods.ts — client for Neighborhood Match v1.
 * Fail-soft: null/[] when unconfigured or flag-disabled server-side.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshApiToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

export interface NeighborhoodArea {
  name: string;
  matchScore?: number;
  factors?: Array<{ key: string; label: string; contribution: number }>;
  categoryScores: Record<string, number>;
  dayNight: Record<string, string>;
  sampleSize: number;
  confidence: 'low' | 'medium' | 'high';
  caveat?: string;
}

export async function fetchCityNeighborhoods(
  city: string,
  lat: number,
  lng: number,
): Promise<{ areas: NeighborhoodArea[]; reason?: string; message?: string } | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const qs = `?city=${encodeURIComponent(city)}&lat=${lat}&lng=${lng}`;
    const res = await authedFetch(`${apiBase()}/api/cities/neighborhoods${qs}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function setTripAreaPreferences(
  tripId: string,
  prefs: { sleepVsPlay?: 'inside' | 'close' | 'away' | null; priorities?: Record<string, number> },
): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/area-preferences`, {
      method: 'PUT',
      body: JSON.stringify(prefs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchNeighborhoodMatch(tripId: string): Promise<{
  areas: NeighborhoodArea[];
  compassPick?: { name: string; why: string } | null;
  disclaimer?: string;
} | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/neighborhood-match`, {
      method: 'POST',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function runLocationCheck(
  tripId: string,
  input: { lat: number; lng: number; name?: string },
): Promise<Record<string, unknown> | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/location-check`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
