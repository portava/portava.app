/**
 * Stamp Catalog Reconciliation Script
 *
 * Reads every distinct (stamp_type, country, city) combination from both
 * `passport_stamps` and `user_stamps`, resolves to canonical catalog entries,
 * and updates ownership rows with catalog_id.
 *
 * Idempotent — safe to re-run.
 *
 * Auditability: every execution writes exactly ONE run-summary row to
 * `stamp_reconciliation_log` (source_table = "reconciliation_run",
 * needs_admin_review = false, counts JSON in review_reason) — including
 * zero-work runs, and best-effort on fatal errors — so "did it run" is
 * answerable from the table. Admin-review queries filter
 * needs_admin_review = true and are unaffected.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx src/scripts/reconcileStampCatalog.ts
 *
 * The reconciliation logic lives in src/lib/stamps/reconcileStampCatalog.ts
 * and is also exposed via POST /admin/stamps/reconcile for automated triggers.
 * This module re-exports the shared symbols for backward compatibility.
 */

import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { runReconciliation } from "../lib/stamps/reconcileStampCatalog.js";

export {
  runReconciliation,
  RUN_SUMMARY_SOURCE_TABLE,
  type ReconcileStats,
} from "../lib/stamps/reconcileStampCatalog.js";

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }

  const sc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const stats = await runReconciliation(sc);
  console.log("[reconcile] Complete:", stats);
  console.log(`  Resolved:  ${stats.resolved}`);
  console.log(`  Flagged:   ${stats.flagged}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Enqueued:  ${stats.enqueued}`);
}

// Only run when executed directly as a script — never on import (tests).
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((e) => {
    console.error("[reconcile] Fatal error:", e);
    process.exit(1);
  });
}
