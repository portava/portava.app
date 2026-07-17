/**
 * Shared fake-client helper: simulate PostgreSQL's partial unique index on
 * stamp_generation_queue(catalog_id) WHERE status = 'queued'.
 *
 * A single UPDATE that would promote multiple rows for the same catalog_id to
 * 'queued' violates the index. PostgreSQL raises 23505 and rolls the entire
 * statement back, leaving all rows unchanged.
 *
 * Fake clients should call this before committing an UPDATE on the queue
 * table: project the in-memory state after the hypothetical update and, if it
 * would contain more than one 'queued' row for the same catalog_id, return a
 * 23505 error without touching any row.
 */
export function wouldCreateDuplicateQueued(
  rows: any[],
  matched: any[],
  updateValues: Record<string, any>,
): boolean {
  if (updateValues.status !== "queued") return false;

  // Project the table after the hypothetical update
  const matchedIds = new Set(matched.map((r) => r.id));
  const projected  = rows.map((r) =>
    matchedIds.has(r.id) ? { ...r, ...updateValues } : { ...r },
  );

  // Count queued rows per catalog_id
  const counts: Record<string, number> = {};
  for (const r of projected) {
    if (r.status === "queued" && r.catalog_id) {
      counts[r.catalog_id] = (counts[r.catalog_id] ?? 0) + 1;
      if (counts[r.catalog_id] > 1) return true;
    }
  }
  return false;
}

/** Standard 23505 error object returned when the constraint would be violated. */
export const DUPLICATE_QUEUED_ERROR = {
  code:    "23505",
  message: "duplicate key value violates unique constraint",
};
