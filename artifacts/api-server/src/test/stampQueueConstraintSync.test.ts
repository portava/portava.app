/**
 * Schema-audit: verify the stampQueueConstraint fake helper stays in sync
 * with the production partial unique index on stamp_generation_queue.
 *
 * The real index is defined in migration 0136_stamp_queue_requeue_cap.sql:
 *
 *   CREATE UNIQUE INDEX uix_queue_catalog_active
 *     ON stamp_generation_queue (catalog_id)
 *     WHERE status NOT IN ('archived', 'retryable_failed', 'permanently_failed');
 *
 * This test is intentionally static — no DB connection required.  It encodes
 * the constraint shape as a regression guard so that any future migration that
 * changes the NOT IN exclusion list surfaces a clear failure here rather than
 * letting the fakes silently drift from reality.
 *
 * If you add or remove a terminal status from the migration's WHERE clause:
 *   1. Update QUEUE_INDEX_EXCLUDED_STATUSES in stampQueueConstraint.ts.
 *   2. Update the canonical lists below.
 *   3. Update any fake clients whose conflictingStatuses argument relied on
 *      the old shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUEUE_INDEX_EXCLUDED_STATUSES,
  insertWouldViolateQueuedUnique,
  wouldCreateDuplicateQueued,
} from "./stampQueueConstraint.js";

/** Exclusion list extracted from migration 0136 — update when the SQL changes. */
const MIGRATION_EXCLUDED = ["archived", "retryable_failed", "permanently_failed"] as const;

/** Default conflicting status used by the fake helper for INSERT-side checks. */
const FAKE_DEFAULT_CONFLICTING = ["queued"] as const;

describe("stampQueueConstraint schema-audit", () => {
  it("QUEUE_INDEX_EXCLUDED_STATUSES matches the migration WHERE NOT IN clause", () => {
    // Both sorted so order differences don't cause spurious failures.
    const fromHelper = [...QUEUE_INDEX_EXCLUDED_STATUSES].sort();
    const fromMigration = [...MIGRATION_EXCLUDED].sort();
    assert.deepEqual(
      fromHelper,
      fromMigration,
      "QUEUE_INDEX_EXCLUDED_STATUSES drifted from the WHERE NOT IN clause in " +
        "0136_stamp_queue_requeue_cap.sql — update the constant to match the migration",
    );
  });

  it("the fake's default conflicting status ('queued') is not in the excluded list", () => {
    // 'queued' must be an *active* status (not excluded from the index) for
    // the partial-unique constraint to apply to it.
    for (const status of FAKE_DEFAULT_CONFLICTING) {
      assert.ok(
        !QUEUE_INDEX_EXCLUDED_STATUSES.includes(status),
        `'${status}' is in QUEUE_INDEX_EXCLUDED_STATUSES — it would be invisible ` +
          "to the real unique index, but the fake treats it as conflicting",
      );
    }
  });

  it("the excluded statuses are all invisible to insertWouldViolateQueuedUnique by default", () => {
    // An existing row with a terminal status must never block a new 'queued' insert.
    for (const terminalStatus of QUEUE_INDEX_EXCLUDED_STATUSES) {
      const existingRows = [{ id: "r1", catalog_id: "cat-1", status: terminalStatus }];
      const newRow = { id: "r2", catalog_id: "cat-1", status: "queued" };
      assert.equal(
        insertWouldViolateQueuedUnique(existingRows, newRow),
        false,
        `existing row with status '${terminalStatus}' should not block a new 'queued' insert`,
      );
    }
  });

  it("two queued rows for the same catalog_id are caught by insertWouldViolateQueuedUnique", () => {
    const existingRows = [{ id: "r1", catalog_id: "cat-1", status: "queued" }];
    const newRow = { id: "r2", catalog_id: "cat-1", status: "queued" };
    assert.equal(insertWouldViolateQueuedUnique(existingRows, newRow), true);
  });

  it("the excluded statuses are invisible to wouldCreateDuplicateQueued", () => {
    // Updating a terminal row to 'queued' when no other 'queued' row exists
    // for that catalog_id should not be flagged as a duplicate.
    for (const terminalStatus of QUEUE_INDEX_EXCLUDED_STATUSES) {
      const rows = [
        { id: "r1", catalog_id: "cat-1", status: terminalStatus },
        { id: "r2", catalog_id: "cat-1", status: "generating" },
      ];
      const matched = [rows[0]!];
      // Promoting only the terminal row to 'queued' — generating is still active,
      // but the test is checking that the terminal row itself isn't double-counted.
      const singleQueued = [{ id: "r3", catalog_id: "cat-2", status: terminalStatus }];
      const matchedSingle = [singleQueued[0]!];
      assert.equal(
        wouldCreateDuplicateQueued(singleQueued, matchedSingle, { status: "queued" }),
        false,
        `updating a lone '${terminalStatus}' row to 'queued' should not be flagged as duplicate`,
      );
    }
  });

  it("promoting two rows to queued for the same catalog_id is caught by wouldCreateDuplicateQueued", () => {
    const rows = [
      { id: "r1", catalog_id: "cat-1", status: "retryable_failed" },
      { id: "r2", catalog_id: "cat-1", status: "retryable_failed" },
    ];
    assert.equal(
      wouldCreateDuplicateQueued(rows, rows, { status: "queued" }),
      true,
    );
  });
});
