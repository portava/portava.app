/**
 * Your history at a place — /memory/place-history?placeId=&label= (HM-F11).
 *
 * `GET /memories/places/:placeId`: §18 PlaceMemoryProjection, OWNER-PRIVATE —
 * the viewer's own Memories at that place, oldest visit first. The place id is
 * the only input; the owner is the session.
 */
import React, { useCallback } from 'react';
import { firstParam } from '../../src/lib/routeParams.ts';
import { useLocalSearchParams } from 'expo-router';
import { MemoryRowsScreen, formatMemoryDate, placeLine, type MemoryRowsLoad } from '../../src/features/memories/social/MemoryRowsScreen.tsx';
import { getMemoryPlaceHistory } from '../../src/services/memorySocial.ts';

export default function MemoryPlaceHistoryRoute() {
  const params = useLocalSearchParams<{ placeId?: string; label?: string }>();
  const placeId = firstParam(params.placeId);
  const label = firstParam(params.label) || 'this place';
  const load = useCallback<MemoryRowsLoad>(async () => {
    if (!placeId) return { ok: false, message: 'No place was given.' };
    const res = await getMemoryPlaceHistory(placeId);
    if (!res.ok) return { ok: false, message: res.message };
    return {
      ok: true,
      truncated: res.truncated,
      rows: res.rows.map((r) => ({
        memoryId: r.memory_id,
        title: r.title || 'Untitled memory',
        subtitle: placeLine(r.location_city, r.location_country),
        meta: [r.visit_index ? `Visit ${r.visit_index}` : null, formatMemoryDate(r.occurred_at)].filter(Boolean).join(' · ') || null,
      })),
    };
  }, [placeId]);
  return (
    <MemoryRowsScreen
      testID="memory-place-history-screen"
      title={`Your history at ${label}`}
      intro="Only you can see this."
      load={load}
      emptyTitle="No memories here yet"
      emptyBody="Memories you make at this place will show up here."
    />
  );
}
