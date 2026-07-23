/**
 * entryRequirements.ts — client for passport management + trip entry matrix.
 * Fail-soft: returns null/[] when the API is unconfigured or the feature flag
 * is off server-side, so surfaces keep their existing empty states.
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

export interface TravelerPassport {
  id: string;
  issuingCountry: string;
  label: string;
  expiryDate: string | null;
  isPrimary: boolean;
}

export interface TripEntryTraveler {
  userId: string;
  self: boolean;
  passportSelected: boolean;
  /** Present for self only. */
  passportCountry?: string | null;
  status: string;
  /** Present for self only. */
  requirement?: Record<string, unknown> | null;
  unknownReason?: string | null;
  lastVerifiedAt?: string | null;
}

export async function listMyPassports(): Promise<TravelerPassport[]> {
  if (!isSupabaseConfigured || !apiBase()) return [];
  try {
    const res = await authedFetch(`${apiBase()}/api/me/passports`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.passports ?? []) as TravelerPassport[];
  } catch {
    return [];
  }
}

export async function addPassport(input: {
  issuingCountry: string;
  label?: string;
  expiryDate?: string | null;
  isPrimary?: boolean;
}): Promise<TravelerPassport | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/me/passports`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.passport ?? null) as TravelerPassport | null;
  } catch {
    return null;
  }
}

export async function updatePassport(
  passportId: string,
  patch: { label?: string; expiryDate?: string | null; isPrimary?: boolean },
): Promise<TravelerPassport | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/me/passports/${passportId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.passport ?? null) as TravelerPassport | null;
  } catch {
    return null;
  }
}

export async function deletePassport(passportId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  try {
    const res = await authedFetch(`${apiBase()}/api/me/passports/${passportId}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function setTripPassport(tripId: string, passportId: string | null): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/travelers/me/passport`, {
      method: 'PUT',
      body: JSON.stringify({ passportId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchTripEntryRequirements(tripId: string): Promise<{
  destinationCountry: string | null;
  disclaimer: string;
  travelers: TripEntryTraveler[];
} | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/entry-requirements`);
    if (!res.ok) return null; // 404 feature_disabled → honest null
    return await res.json();
  } catch {
    return null;
  }
}
