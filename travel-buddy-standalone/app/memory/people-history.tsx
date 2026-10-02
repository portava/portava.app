/**
 * Your memories with one person — /memory/people-history?personId=&name= (HM-F11).
 *
 * `GET /memories/people/:personId`: §18 PeopleMemoryProjection — the viewer's
 * OWN Memories on which that person APPROVED their tag. A pending or removed
 * tag is not a shared experience, and a block ends shared history in both
 * directions (the server answers not_found).
 */
import React, { useCallback } from 'react';
import { firstParam } from '../../src/lib/routeParams.ts';
import { useLocalSearchParams } from 'expo-router';
import { MemoryRowsScreen, formatMemoryDate, placeLine, type MemoryRowsLoad } from '../../src/features/memories/social/MemoryRowsScreen.tsx';
import { getMemoryPeopleHistory } from '../../src/services/memorySocial.ts';

export default function MemoryPeopleHistoryRoute() {
  const params = useLocalSearchParams<{ personId?: string; name?: string }>();
  const personId = firstParam(params.personId);
  const name = firstParam(params.name) || 'this person';
  const load = useCallback<MemoryRowsLoad>(async () => {
    if (!personId) return { ok: false, message: 'No person was given.' };
    const res = await getMemoryPeopleHistory(personId);
    if (!res.ok) return { ok: false, message: res.kind === 'not_found' ? 'There is no shared history with this person.' : res.message };
    return {
      ok: true,
      truncated: res.truncated,
      rows: res.rows.map((r) => ({
        memoryId: r.memory_id,
        title: r.title || 'Untitled memory',
        subtitle: placeLine(r.location_city, r.location_country),
        meta: formatMemoryDate(r.occurred_at),
      })),
    };
  }, [personId]);
  return (
    <MemoryRowsScreen
      testID="memory-people-history-screen"
      title={`You and ${name}`}
      intro="Your memories where they approved being tagged. Only you can see this."
      load={load}
      emptyTitle="No shared memories yet"
      emptyBody="When someone approves a tag on one of your memories, it shows up here."
    />
  );
}
