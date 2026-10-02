/**
 * Saved memories — /memory/saved (HM-F13).
 *
 * `GET /me/saved-memories`: the shelf `POST /memories/:id/save` fills. The
 * server re-judges every row at read time (§23 canReadMemory + block), so a
 * Memory whose owner narrowed its audience, or who blocked the viewer, drops
 * out rather than lingering here.
 */
import React, { useCallback } from 'react';
import { MemoryRowsScreen, formatMemoryDate, placeLine, type MemoryRowsLoad } from '../../src/features/memories/social/MemoryRowsScreen.tsx';
import { getSavedMemories } from '../../src/services/memorySocial.ts';

export default function SavedMemoriesRoute() {
  const load = useCallback<MemoryRowsLoad>(async () => {
    const res = await getSavedMemories();
    if (!res.ok) return { ok: false, message: res.message };
    return {
      ok: true,
      truncated: res.truncated,
      rows: res.memories.map((m) => ({
        memoryId: m.id,
        title: m.title || 'Untitled memory',
        subtitle: placeLine(m.locationCity, m.locationCountry),
        meta: [m.owner ? (m.owner.name || (m.owner.handle ? `@${m.owner.handle}` : null)) : null, formatMemoryDate(m.startsAt ?? m.createdAt)].filter(Boolean).join(' · ') || null,
      })),
    };
  }, []);
  return (
    <MemoryRowsScreen
      testID="memory-saved-screen"
      title="Saved memories"
      load={load}
      emptyTitle="Nothing saved yet"
      emptyBody="Tap Save on a memory to keep it here."
    />
  );
}
