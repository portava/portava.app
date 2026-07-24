/**
 * countryEssentials.ts — client for travel-readiness reference data
 * (plug types, voltage, drive side, emergency numbers).
 * Fail-soft: null when the API is unconfigured or the feature flag is off, so
 * the readiness screen simply omits the section.
 *
 * IMPORTANT: always render `disclaimer` alongside emergency numbers — they are
 * safety-relevant and can vary/change.
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

export interface CountryEssentials {
  code: string;
  plugTypes: string[];
  voltage: number | null;
  frequency: number | null;
  driveSide: 'left' | 'right' | null;
  emergency: { all?: string; police?: string; ambulance?: string; fire?: string };
  confidence: string;
  source: string;
  lastVerifiedAt: string;
  disclaimer: string;
}

export interface TripEssentialsItem {
  country: string;
  essentials: CountryEssentials | null;
}

/** One country's essentials. Null when unavailable OR not covered (honest unknown). */
export async function getCountryEssentials(code: string): Promise<CountryEssentials | null> {
  if (!isSupabaseConfigured || !apiBase() || !code) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/countries/${encodeURIComponent(code)}/essentials`);
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.enabled === false) return null;
    return (body?.essentials as CountryEssentials) ?? null;
  } catch {
    return null;
  }
}

/** Essentials for every destination country on a trip. Null = feature unavailable. */
export async function getTripEssentials(tripId: string): Promise<TripEssentialsItem[] | null> {
  if (!isSupabaseConfigured || !apiBase() || !tripId) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${encodeURIComponent(tripId)}/essentials`);
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.enabled === false) return null;
    return Array.isArray(body?.items) ? (body.items as TripEssentialsItem[]) : [];
  } catch {
    return null;
  }
}
