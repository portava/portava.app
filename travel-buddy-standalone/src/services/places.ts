/**
 * Canonical Place service client
 *
 * Wraps GET /api/places/canonical/:id.
 *
 * The server route is gated behind the `external_places_enabled` feature flag.
 * When the flag is OFF the server returns 403; this client returns null so
 * callers never need to handle the flag explicitly.
 *
 * All failures (flag off, 404, network error, parse error) resolve to null —
 * this function never throws.
 */
import { freshToken as freshApiToken } from './apiToken.ts';
import type { CanonicalPlace } from '../types/canonicalPlace.ts';

// Inline the supabase-configured check so this module does NOT import supabase.ts.
// supabase.ts → secureStore.ts → expo-secure-store pulls in React Native, which
// breaks the esbuild-based standalone test runner.
function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.EXPO_PUBLIC_SUPABASE_URL &&
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  );
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

/**
 * Fetch the canonical place envelope for the given place ID.
 *
 * Server route: GET /api/places/canonical/:id
 * Flag:         `external_places_enabled` must be ON.
 *
 * @returns Parsed CanonicalPlace on success, null otherwise.
 *          Null cases: flag OFF (403), not found (404), network error,
 *          parse failure, unauthenticated, or API not configured.
 */
export async function getCanonicalPlace(id: string): Promise<CanonicalPlace | null> {
  if (!isSupabaseConfigured() || !apiBase()) return null;

  const token = await freshToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `${apiBase()}/api/places/canonical/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    // Server returns { place: CanonicalPlace } envelope — extract the nested object.
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') return null;
    const place = (json as any).place;
    return isValidCanonicalPlace(place) ? place : null;
  } catch {
    return null;
  }
}

// ── Runtime shape validator ───────────────────────────────────────────────────

/** Allowed values for the PlaceStatus enum — validated at runtime. */
const VALID_PLACE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'closed',
  'temporarily_closed',
  'moved',
]);

/**
 * Returns true when `v` satisfies the minimum required shape of a CanonicalPlace.
 * Any missing or wrong-typed required field returns false → caller returns null.
 *
 * Required fields: id (string), name (string), category (string),
 * coordinates.lat/lng (finite numbers), status (PlaceStatus enum member),
 * detailRoute (string), attribution (string[]), sources (array),
 * fieldFreshness (object).
 */
function isValidCanonicalPlace(v: unknown): v is CanonicalPlace {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;

  if (typeof p.id !== 'string' || !p.id) return false;
  if (typeof p.name !== 'string' || !p.name) return false;
  if (typeof p.category !== 'string' || !p.category) return false;
  // status must be one of the known PlaceStatus values — prevents unknown enum
  // values from reaching PlaceCard where they would produce undefined badge colors.
  if (typeof p.status !== 'string' || !VALID_PLACE_STATUSES.has(p.status)) return false;
  if (typeof p.detailRoute !== 'string' || !p.detailRoute) return false;
  // attribution must be an array where every entry is a string.
  if (!Array.isArray(p.attribution)) return false;
  if ((p.attribution as unknown[]).some((a) => typeof a !== 'string')) return false;
  if (!Array.isArray(p.sources)) return false;
  if (!p.fieldFreshness || typeof p.fieldFreshness !== 'object') return false;

  // coordinates must be a plain object with finite lat/lng numbers.
  const coords = p.coordinates as Record<string, unknown> | null | undefined;
  if (!coords || typeof coords !== 'object') return false;
  if (typeof coords.lat !== 'number' || !Number.isFinite(coords.lat)) return false;
  if (typeof coords.lng !== 'number' || !Number.isFinite(coords.lng)) return false;

  return true;
}
