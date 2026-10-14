/**
 * memoryCanonical — the app's half of two canonical Memory fields
 * (census-highlights-memories H40 and H71; server: services/memory/
 * memoryCanonicalFields.ts, migrations 3803 and 3804).
 *
 *   memoryType                    §4 `MemoryType`, the owner's choice. The
 *                                 composer offers it ONLY when GET
 *                                 /api/memory-types says `enabled`: the server
 *                                 refuses a type while memory_type_enabled is
 *                                 off, and offering a refusal is not a feature.
 *   placeDisplayNameAtOccurrence  §9: the place's name as it was when the Memory
 *                                 recorded it. Sent with a place the person just
 *                                 picked; the server keeps it only for a
 *                                 provider pick (a catalog place records the
 *                                 catalog's own name) and never rewrites it.
 *
 * Both fields are ABSENT from a Memory the server does not serve them on; an
 * absent field is "not available", null is "unknown" (a legacy Memory). The
 * screens never guess one.
 */
import { freshToken } from '../../../services/apiToken.ts';

/** Spec §4, in the spec's order. The server's MEMORY_TYPES holds the same thirteen. */
export const MEMORY_TYPES = [
  'PLACE', 'PERSON', 'MOMENT', 'EPISODE', 'TRIP', 'EVENT', 'MILESTONE',
  'CREW', 'DISCOVERY', 'ROUTE', 'EXPERIENCE', 'FIRST', 'REUNION',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  PLACE: 'Place', PERSON: 'Person', MOMENT: 'Moment', EPISODE: 'Episode', TRIP: 'Trip',
  EVENT: 'Event', MILESTONE: 'Milestone', CREW: 'Crew', DISCOVERY: 'Discovery', ROUTE: 'Route',
  EXPERIENCE: 'Experience', FIRST: 'A first', REUNION: 'Reunion',
};

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);
}

export type MemoryTypesAvailability =
  | { ok: true; enabled: boolean; types: MemoryType[]; defaultType: MemoryType | null }
  | { ok: false; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * Whether the composer may offer a type. A failed read is `ok: false`, never
 * `enabled: false` — but the caller treats both the same way (no picker),
 * because offering a choice it cannot confirm is the one thing it must not do.
 */
export async function fetchMemoryTypes(): Promise<MemoryTypesAvailability> {
  try {
    const token = await freshToken();
    const res = await fetch(`${apiBase()}/api/memory-types`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json || typeof json !== 'object') {
      const m = json && typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
      return { ok: false, message: m };
    }
    if (typeof json.enabled !== 'boolean' || !Array.isArray(json.types)) {
      return { ok: false, message: 'The server answered in a shape this app does not understand.' };
    }
    const types = (json.types as unknown[]).filter(isMemoryType);
    return { ok: true, enabled: json.enabled, types, defaultType: isMemoryType(json.defaultType) ? json.defaultType : null };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** The name a person saw when they picked the place, or null. */
export function occurrenceNameOfPick(place: { name?: string | null; displayName?: string | null } | null | undefined): string | null {
  if (!place) return null;
  const n = (place.name ?? '').trim() || (place.displayName ?? '').trim();
  return n.length > 0 ? n.slice(0, 200) : null;
}

/**
 * The detail screen's place line. The occurrence-time name comes first when the
 * server served one ("Cafe A · Hanoi, Vietnam"): it is what the place was called
 * when this happened, whatever the place is called now. Without it the line is
 * the city and country, exactly as before.
 */
export function memoryPlaceLine(m: {
  placeDisplayNameAtOccurrence?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
}): string {
  const where = [m.locationCity, m.locationCountry].filter(Boolean).join(', ');
  const name = (m.placeDisplayNameAtOccurrence ?? '').trim();
  if (!name) return where;
  return where && where !== name ? `${name} · ${where}` : name;
}
