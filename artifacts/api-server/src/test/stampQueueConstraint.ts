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

/**
 * INSERT-side counterpart: given the current table rows and the row(s) being
 * inserted, return true when the insert would create a second row in the set
 * of conflicting statuses for the same catalog_id (violating the unique index
 * or a broader application-level guard). The default conflicting status is
 * 'queued' to match the partial unique index on
 * stamp_generation_queue(catalog_id) WHERE status = 'queued'. Tests that model
 * a broader active-job guard (e.g. queued + processing) can pass a custom list.
 *
 * Fake clients should call this before pushing inserted rows for
 * stamp_generation_queue and return DUPLICATE_QUEUED_ERROR without inserting
 * anything.
 */
export function insertWouldViolateQueuedUnique(
  rows: any[],
  inserted: any | any[],
  conflictingStatuses: string[] = ["queued"],
): boolean {
  const newRows = Array.isArray(inserted) ? inserted : [inserted];
  const isConflicting = (status: string) => conflictingStatuses.includes(status);

  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (isConflicting(r.status) && r.catalog_id) {
      counts[r.catalog_id] = (counts[r.catalog_id] ?? 0) + 1;
    }
  }
  for (const r of newRows) {
    if (isConflicting(r.status) && r.catalog_id) {
      counts[r.catalog_id] = (counts[r.catalog_id] ?? 0) + 1;
      if (counts[r.catalog_id] > 1) return true;
    }
  }
  return false;
}

/**
 * The statuses that the production partial unique index treats as *terminal*
 * (excluded from the index via WHERE status NOT IN (...)).  Rows with these
 * statuses are invisible to the constraint, so a new job can be enqueued for
 * the same catalog_id even when one of these rows exists.
 *
 * Source: migration 0136_stamp_queue_requeue_cap.sql — uix_queue_catalog_active
 * WHERE status NOT IN ('archived', 'retryable_failed', 'permanently_failed')
 *
 * ⚠ KEEP IN SYNC: if the WHERE clause in that migration ever changes, update
 * this list to match and update the schema-audit test in
 * stampQueueConstraintSync.test.ts.
 */
export const QUEUE_INDEX_EXCLUDED_STATUSES: readonly string[] = [
  "archived",
  "retryable_failed",
  "permanently_failed",
];

/** Standard 23505 error object returned when the constraint would be violated. */
export const DUPLICATE_QUEUED_ERROR = {
  code:    "23505",
  message: "duplicate key value violates unique constraint",
};
