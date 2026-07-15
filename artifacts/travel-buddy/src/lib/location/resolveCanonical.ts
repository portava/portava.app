/**
 * resolveCanonical — client half of the universal location service.
 *
 * On every picker selection we POST the chosen Place to
 * /api/locations/resolve, which finds-or-creates its canonical registry row
 * and returns the place merged with normalized fields + canonicalId.
 *
 * Design rules:
 *  - NEVER blocks the UX for long: hard timeout (default 1.3 s), and any
 *    failure returns the original place unresolved.
 *  - Unauthenticated users simply get the unresolved place back.
 *  - Successful resolutions are cached per place id for the session.
 */
import { supabase } from '../supabase';
import type { Place } from './placeTypes';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const cache = new Map<string, Place>();

async function freshToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function resolveCanonicalPlace(
  place: Place,
  opts: { timeoutMs?: number } = {},
): Promise<Place> {
  const timeoutMs = opts.timeoutMs ?? 1300;

  // Already resolved (registry rows echoed back from popular/recents)
  if (place.canonicalId) return place;

  const cached = cache.get(place.id);
  if (cached) return cached;

  try {
    const token = await freshToken();
    if (!token) return place; // signed-out: selection proceeds unresolved

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${apiBase()}/api/locations/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ place }),
        signal: ctrl.signal,
      });
      if (!res.ok) return place;
      const body = await res.json();
      const resolved: Place | undefined = body?.place;
      if (!resolved || typeof resolved !== 'object' || !resolved.id) return place;
      if (body.canonicalId) cache.set(place.id, resolved);
      return resolved;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return place; // timeout / offline — selection must never fail
  }
}
