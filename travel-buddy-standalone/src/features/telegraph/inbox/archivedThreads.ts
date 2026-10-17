/**
 * Owner ruling 2026-10-17 — the inbox keeps archived conversations out of the
 * main list and shows them in an Archived section, each with Unarchive.
 *
 * `archivedAt` is the viewer's OWN (GET /me/threads; archive is per member).
 *
 * `unarchived` is what this screen unarchived and the server CONFIRMED, keyed
 * by conversation id → the archivedAt it carried at the time. It moves the
 * conversation back to the main list at once, and holds only while the
 * server's copy still shows that same archive: once a reload shows null (the
 * server's copy caught up) or a DIFFERENT archivedAt (archived again since),
 * the server's copy is what is drawn.
 *
 * Order is the server's (most recent activity first) within each list.
 */
export function splitArchived<T extends { id: string; archivedAt: string | null }>(
  threads: readonly T[],
  unarchived: ReadonlyMap<string, string>,
): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const th of threads) {
    if (th.archivedAt == null) active.push(th);
    else if (unarchived.get(th.id) === th.archivedAt) active.push({ ...th, archivedAt: null });
    else archived.push(th);
  }
  return { active, archived };
}
