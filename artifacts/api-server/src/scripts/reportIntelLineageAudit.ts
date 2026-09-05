/**
 * Intelligence-Gathering projection LINEAGE AUDIT — READ-ONLY (SELECT only).
 *
 * WHAT THIS ANSWERS
 * =================
 * "Every model decision is reproducible from versioned features, claims,
 * policies and algorithm versions" (spec §1) and "every projection is
 * replayable" (Appendix B). Migration 2273 exists to make that true: every
 * projection appends an immutable `intel_state_snapshot_versions` row carrying
 * the exact confidence components, penalties, freshness inputs, formula version
 * and algorithm version it was computed from.
 *
 * Until this script, NOTHING replayed them. lib/intelReplay was written and
 * tested and had no non-test caller at all, so the lineage 2273 was created to
 * preserve was written and never checked: a non-deterministic formula, a
 * hand-edited row, or an algorithm change shipped without a version bump would
 * all have sat in the table indefinitely, invisible. This is the measurement
 * half of §21's "lineage and correction consistency audit nightly".
 *
 * WHAT IT CANNOT SEE — READ BEFORE QUOTING ANY NUMBER
 * ===================================================
 * 0. ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE. Zero version rows in the
 *    window means the projection was NOT EXERCISED there — not that replay is
 *    proven. The audit reports NOT ESTABLISHED and exits non-zero rather than
 *    printing a clean bill of health over an empty table.
 * 1. A VERSION-CHANGE DIVERGENCE IS NOT A DEFECT. `algorithm_version_changed`,
 *    `formula_version_changed` and `freshness_curve_changed` mean the stored row
 *    predates the running code. That is expected after a deliberate version
 *    bump; it is reported separately from the defect class below, and it is what
 *    tells you a re-projection is owed.
 * 2. `confidence_mismatch`, `band_mismatch`, `freshness_component_mismatch` and
 *    `replay_record_missing` under UNCHANGED versions are DEFECTS: same inputs,
 *    same code, different answer, or a row that cannot be replayed at all.
 * 3. NOTHING IS REPAIRED. A divergence is a finding for a human. "Fixing" the
 *    row would destroy the evidence that the row and the code disagree.
 *
 * Exit codes: 0 clean · 1 divergence found · 2 read failure or nothing to audit.
 *
 * Usage:
 *   pnpm run report:intel-lineage-audit
 *   pnpm run report:intel-lineage-audit -- --days 1 --limit 2000
 *   pnpm run report:intel-lineage-audit -- --subject <place-uuid>
 */

// Read-only audit front door — hoisted, runs before any client is constructed.
// See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { getServiceClient } from "../lib/supabase.js";
import {
  auditSnapshotReplays,
  REPLAY_AUDIT_DEFAULT_LIMIT,
  type ReplayDivergence,
} from "../lib/intelReplay.js";
import { PROJECTION_ALGORITHM_VERSION } from "../lib/intelProjection.js";
import { CONFIDENCE_FORMULA_VERSION } from "../lib/confidenceScore.js";

export {};

/** Divergences that mean "the stored row predates this build" — expected after a bump. */
const VERSION_CHANGE_REASONS: readonly ReplayDivergence[] = [
  "algorithm_version_changed",
  "formula_version_changed",
  "freshness_curve_changed",
];

/** Divergences that mean "same code, different answer" — always a defect. */
const DEFECT_REASONS: readonly ReplayDivergence[] = [
  "replay_record_missing",
  "confidence_mismatch",
  "band_mismatch",
  "freshness_component_mismatch",
];

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? String(process.argv[i + 1]) : null;
}

async function main(): Promise<void> {
  // One clock read for the whole run (split-clock guard).
  const nowMs = Date.now();

  const daysRaw = argValue("--days");
  const days = daysRaw === null ? null : Number(daysRaw);
  if (days !== null && (!Number.isFinite(days) || days <= 0)) {
    console.error("--days must be a positive number of days");
    process.exit(2);
  }
  const since = days === null ? null : new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();

  const limitRaw = argValue("--limit");
  const limit = limitRaw === null ? REPLAY_AUDIT_DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error("--limit must be a positive integer");
    process.exit(2);
  }

  const subjectId = argValue("--subject");

  const sc = getServiceClient();
  if (!sc) {
    console.error("No service client (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured).");
    process.exit(2);
  }

  const report = await auditSnapshotReplays(sc, { limit, since, subjectId });

  console.log("Intelligence Gathering — projection lineage audit (read-only)");
  console.log(`  running build: algorithm ${PROJECTION_ALGORITHM_VERSION}, confidence formula v${CONFIDENCE_FORMULA_VERSION}`);
  console.log(`  window:        ${since ?? "all time"} → now (limit ${limit}${subjectId ? `, subject ${subjectId}` : ""})`);
  console.log("");

  if (report.readError) {
    console.error(`READ FAILED: ${report.readError}`);
    console.error("Nothing was audited. This is NOT a pass.");
    process.exit(2);
  }

  console.log(`  version rows replayed: ${report.scanned}`);
  console.log(`  replayed identically:  ${report.equal}`);
  console.log(`  diverged:              ${report.diverged}`);

  if (report.scanned === 0) {
    console.log("");
    console.log("NOT ESTABLISHED — no snapshot version rows in this window.");
    console.log("The projection was not exercised here. Absence of evidence is not evidence of");
    console.log("absence: this does NOT mean replay is proven. Widen --days or seed the pilot.");
    process.exit(2);
  }

  const versionChanges = VERSION_CHANGE_REASONS.filter((r) => (report.reasons[r] ?? 0) > 0);
  const defects = DEFECT_REASONS.filter((r) => (report.reasons[r] ?? 0) > 0);

  if (versionChanges.length > 0) {
    console.log("");
    console.log("  VERSION CHANGES (expected after a deliberate bump; a re-projection is owed):");
    for (const r of versionChanges) console.log(`    ${r.padEnd(30)} ${report.reasons[r]}`);
  }
  if (defects.length > 0) {
    console.log("");
    console.log("  DEFECTS (same code, different answer — investigate before trusting any snapshot):");
    for (const r of defects) console.log(`    ${r.padEnd(30)} ${report.reasons[r]}`);
  }
  if (report.divergedVersionIds.length > 0) {
    console.log("");
    console.log(`  diverged version ids${report.divergedTruncated ? " (truncated)" : ""}:`);
    for (const id of report.divergedVersionIds) console.log(`    ${id}`);
  }

  console.log("");
  if (report.clean) {
    console.log(`CLEAN — all ${report.scanned} stored projections replay to their stored result.`);
    process.exit(0);
  }
  console.log(`DIVERGENCE — ${report.diverged} of ${report.scanned} stored projections do not replay.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
