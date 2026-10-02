/**
 * TRIP-F22 — §20 post-trip on the client (WP-10): the viewer's memory
 * candidates (GET /trips/:tripId/memory-candidates, TripMemoryProjection) and
 * what the trip adds to their Passport (GET /trips/:tripId/passport-projection,
 * TripPassportProjection). census-trips TR382, TR388.
 *
 * Both are projections: the server decided every candidate from a row the
 * reader can open (an outcome, a plan status, a checkpoint, the crew, a
 * stamp) and names the inputs it could not read. This client re-derives
 * nothing. "Keep as memory" hands the candidate's own `memoryDraft` to the
 * Memories domain's POST /memories as a DRAFT the viewer can open and publish
 * (WP10-D6): a trip's history becomes a memory only when its traveller says
 * so, and it is not published to anyone on the strength of a projection. The
 * operation id is the candidate's own id, so keeping it twice is one intent.
 */
import { readTripJson, type ApiRead } from '../shared/tripApi.ts';

export interface MemoryDraft {
  tripId: string; title: string; placeId: string | null;
  startsAt: string | null; endsAt: string | null;
  locationCity: string | null; locationCountry: string | null;
}
export interface MemoryCandidate {
  id: string;
  kind: string;
  title: string;
  occurredAt: string | null;
  evidence: { source: string; ids: string[] };
  memoryDraft: MemoryDraft | null;
  realized: { memoryId: string; mediaCount: number } | null;
  peopleUserIds?: string[];
}
export interface TripMemoryProjection {
  tripId: string;
  candidates: MemoryCandidate[];
  realizedCount: number;
  media: { memories: number; items: number } | null;
  unrecordedDonePlanIds: string[];
  unread: string[];
  reading: string;
}
export interface TripPassportProjection {
  tripId: string;
  completed: boolean;
  countries: string[];
  cities: string[];
  /** null = stamps were not read — never "no stamps". */
  stamps: { id: string; slug: string | null; name: string | null; earnedAt: string | null }[] | null;
  unread: string[];
  reading: string;
}

export function fetchMemoryCandidates(tripId: string): Promise<ApiRead<TripMemoryProjection>> {
  return readTripJson<TripMemoryProjection>(
    `/api/trips/${tripId}/memory-candidates`,
    (b) => Array.isArray(b?.candidates) && Array.isArray(b?.unread) && b.candidates.every((c: any) => c && typeof c.id === 'string' && typeof c.title === 'string'),
  );
}

export function fetchPassportPreview(tripId: string): Promise<ApiRead<TripPassportProjection>> {
  return readTripJson<TripPassportProjection>(
    `/api/trips/${tripId}/passport-projection`,
    (b) => typeof b?.completed === 'boolean' && Array.isArray(b?.countries) && Array.isArray(b?.cities) && Array.isArray(b?.unread),
  );
}

/** kept: a memory already answers it · keepable: it carries a draft · tag: people or a stamp, not a memory of its own. */
export function candidateStatus(c: MemoryCandidate): 'kept' | 'keepable' | 'tag' {
  if (c.realized) return 'kept';
  return c.memoryDraft ? 'keepable' : 'tag';
}

export function unreadLine(unread: readonly string[]): string | null {
  if (unread.length === 0) return null;
  return `${unread.length} input${unread.length === 1 ? '' : 's'} could not be read, so some candidates may be missing`;
}

export interface KeepMemoryInput {
  title: string; tripId: string; placeId: string | null; startsAt: string | null; endsAt: string | null;
  locationCity: string | null; locationCountry: string | null;
  visibility: 'friends_only'; state: 'draft'; operationId: string;
}

/** The createMemory input for a keepable candidate, or null when it has no draft. */
export function draftToMemoryInput(c: MemoryCandidate): KeepMemoryInput | null {
  const d = c.memoryDraft;
  if (!d) return null;
  return {
    title: d.title, tripId: d.tripId, placeId: d.placeId, startsAt: d.startsAt, endsAt: d.endsAt,
    locationCity: d.locationCity, locationCountry: d.locationCountry,
    visibility: 'friends_only', state: 'draft', operationId: `trip-memory:${d.tripId}:${c.id}`,
  };
}

export function passportLine(p: Pick<TripPassportProjection, 'completed' | 'countries' | 'cities' | 'stamps'>): string {
  if (!p.completed) return 'Nothing is added to your Passport until the trip is completed';
  const n = (k: number, w: string, ws: string) => `${k} ${k === 1 ? w : ws}`;
  const head = `Adds ${n(p.countries.length, 'country', 'countries')} and ${n(p.cities.length, 'city', 'cities')}`;
  const stamps = p.stamps === null ? 'stamps could not be read' : n(p.stamps.length, 'stamp', 'stamps');
  return `${head} · ${stamps}`;
}
