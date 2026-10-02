/**
 * Your memory timeline — /memory/timeline (HM-F11).
 *
 * `GET /memories/timeline`: §18 MemoryTimelineProjection, OWNER-PRIVATE. The
 * server derives the owner from the session; this route takes no owner param,
 * so it can only ever show the viewer's own timeline.
 */
import React, { useCallback } from 'react';
import { MemoryRowsScreen, formatMemoryDate, placeLine, type MemoryRowsLoad } from '../../src/features/memories/social/MemoryRowsScreen.tsx';
import { getMemoryTimeline } from '../../src/services/memorySocial.ts';

export default function MemoryTimelineRoute() {
  const load = useCallback<MemoryRowsLoad>(async () => {
    const res = await getMemoryTimeline();
    if (!res.ok) return { ok: false, message: res.message };
    return {
      ok: true,
      truncated: res.truncated,
      rows: res.rows.map((r) => {
        const people = r.people?.length ?? 0;
        const photos = r.media_count ?? 0;
        const bits = [formatMemoryDate(r.occurred_at), photos ? `${photos} photo${photos === 1 ? '' : 's'}` : null, people ? `with ${people} ${people === 1 ? 'person' : 'people'}` : null];
        return { memoryId: r.memory_id, title: r.title || 'Untitled memory', subtitle: placeLine(r.location_city, r.location_country), meta: bits.filter(Boolean).join(' · ') || null };
      }),
    };
  }, []);
  return (
    <MemoryRowsScreen
      testID="memory-timeline-screen"
      title="Your timeline"
      intro="Only you can see this."
      load={load}
      emptyTitle="No memories yet"
      emptyBody="Memories you make from your trips and places will line up here."
    />
  );
}
