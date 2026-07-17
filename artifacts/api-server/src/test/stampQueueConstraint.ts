/**
 * Shared fake-client helper: simulate PostgreSQL's partial unique index on
 * stamp_generation_queue(catalog_id) WHERE status NOT IN (terminal statuses).
 *
 * A single UPDATE that would promote multiple rows for the same catalog_id to
 * an active status violates the index. PostgreSQL raises 23505 and rolls the
 * entire statement back, leaving all rows unchanged.
 *
 * Fake clients should call the helpers below before committing an UPDATE or
 * INSERT on the queue table and return DUPLICATE_QUEUED_ERROR when they fire.
 */

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

/**
 * Returns true when `status` is an *active* queue status — one that is visible
 * to the partial unique index (i.e. NOT in QUEUE_INDEX_EXCLUDED_STATUSES).
 *
 * Use this inside fake-client helpers instead of hard-coding status strings so
 * that adding a new terminal status to QUEUE_INDEX_EXCLUDED_STATUSES
 * automatically propagates to all helpers without a manual audit.
 */
export function isActiveQueueStatus(status: string): boolean {
  return !QUEUE_INDEX_EXCLUDED_STATUSES.includes(status);
}

/**
 * UPDATE-side helper: returns true when applying `updateValues` to `matched`
 * rows would leave more than one *active* row (any status not in
 * QUEUE_INDEX_EXCLUDED_STATUSES) for the same catalog_id in the projected
 * table, violating the partial unique index.
 *
 * The real index fires whenever two rows for the same catalog_id are both
 * active, regardless of whether their statuses are equal.  This helper mirrors
 * that behavior by using isActiveQueueStatus rather than a hard-coded status
 * string.
 *
 * Fake clients should call this before committing an UPDATE on the queue table:
 * if it returns true, return a 23505 error without touching any row.
 */
export function wouldCreateDuplicateQueued(
  rows: any[],
  matched: any[],
  updateValues: Record<string, any>,
): boolean {
  // Only active (non-excluded) statuses are visible to the partial unique index.
  // If the update targets a terminal status, the index never fires.
  if (!isActiveQueueStatus(updateValues.status)) return false;

  // Project the table after the hypothetical update
  const matchedIds = new Set(matched.map((r) => r.id));
  const projected  = rows.map((r) =>
    matchedIds.has(r.id) ? { ...r, ...updateValues } : { ...r },
  );

  // Count all active-status rows per catalog_id — the real index fires on any
  // two active rows for the same catalog_id, not only same-status duplicates.
  const counts: Record<string, number> = {};
  for (const r of projected) {
    if (isActiveQueueStatus(r.status) && r.catalog_id) {
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
 * or a broader application-level guard).
 *
 * The default conflicting status is 'queued' to match the production scenario
 * where only 'queued' rows are inserted — an application that updates existing
 * rows to terminal statuses before inserting will never see an insert-side
 * conflict from non-queued active rows.  Tests that model a broader active-job
 * guard (e.g. queued + processing) can pass a custom list; when doing so,
 * prefer building the list from isActiveQueueStatus so the check stays in sync
 * with QUEUE_INDEX_EXCLUDED_STATUSES automatically.
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

/** Standard 23505 error object returned when the constraint would be violated. */
export const DUPLICATE_QUEUED_ERROR = {
  code:    "23505",
  message: "duplicate key value violates unique constraint",
};
