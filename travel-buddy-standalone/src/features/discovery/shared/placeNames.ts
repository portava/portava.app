/**
 * A place's display name for a Trail member or a trending row, read through
 * the canonical place endpoint (`/api/places/canonical/:id`).
 *
 * WHY NOT `getCanonicalPlace` (services/places.ts): it answers `null` for a
 * failed read AND for a missing place, and a row cannot then say which. Here a
 * place that could not be read is `unavailable` (the row says so and still
 * links), and one the server does not know is `missing`.
 */
import { useEffect, useState } from 'react';
import { readDiscoveryJson, type ApiRead } from './discoveryApi.ts';

export interface PlaceName { name: string; category: string | null }

export async function fetchPlaceName(id: string): Promise<ApiRead<PlaceName> | { state: 'missing' }> {
  const r = await readDiscoveryJson<{ place: { name: string; category?: unknown } }>(
    `/api/places/canonical/${encodeURIComponent(id)}`,
    (b) => !!b?.place && typeof b.place.name === 'string' && b.place.name.length > 0,
  );
  if (r.state === 'unavailable' && r.status === 404) return { state: 'missing' };
  if (r.state !== 'ok') return r;
  return { state: 'ok', data: { name: r.data.place.name, category: typeof r.data.place.category === 'string' ? r.data.place.category : null } };
}

export type PlaceNameState = { state: 'loading' } | Awaited<ReturnType<typeof fetchPlaceName>>;

/** The row's label for a place: its name, or a sentence that is honest about why not. */
export function placeLabel(s: PlaceNameState): string {
  switch (s.state) {
    case 'ok': return s.data.name;
    case 'loading': return 'Loading place…';
    case 'missing': return 'A place that is no longer listed';
    case 'off': return 'Place';
    default: return 'Place (name unavailable)';
  }
}

export function usePlaceName(id: string, load: typeof fetchPlaceName = fetchPlaceName): PlaceNameState {
  const [s, setS] = useState<PlaceNameState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void load(id).then((r) => { if (live) setS(r); });
    return () => { live = false; };
  }, [id, load]);
  return s;
}
