/**
 * Intelligence-Gathering funnel + density-gate readout — READ-ONLY (SELECT only).
 *
 * WHAT THIS ANSWERS
 * =================
 * The IG pilot's operating question: of what capture produces, how much survives
 * each stage to a servable Live label, and — when little does — WHY. It reads the
 * intel tables into the density-gate inputs that lib/intelLiveScope and
 * lib/intelPilotMetrics were built to evaluate but that nothing has ever fed.
 *
 *   observations ─▶ (moderation) ─▶ claims ─▶ (live-eligible) ─▶ snapshots
 *        │                                                          │
 *        └── contributor concentration          privacy-eligible ◀──┤
 *                                                servable Live ◀─────┘
 *
 * WHAT IT CANNOT SEE — READ BEFORE QUOTING ANY NUMBER
 * ===================================================
 * 0. ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE. Empty intel tables mean the
 *    pipeline was not exercised in this window — NOT that it works and found
 *    nothing, and NOT that any gate is satisfied. When there is no data this
 *    script says NOT ESTABLISHED and renders no gate verdict.
 *
 * 1. THE DENSITY GATE CANNOT BE CERTIFIED FROM HERE, BY DESIGN. Several gate
 *    inputs have no data source yet (per-cluster contributors, per-venue-night
 *    independent sources, outcome confirmations, calibration accuracy, expiry
 *    correctness) and one (citywide reliable contributors) can only be
 *    over-counted (reliability is not modelled). Uninstrumented inputs are forced
 *    to their fail-closed values and an over-counted one is never trusted to
 *    clear. So the gate here is always NOT CERTIFIABLE — that is the correct
 *    fail-closed state, not a defect. Promotion stays a human decision
 *    (intelLiveScope header) made only once these inputs are truly instrumented.
 *
 * 2. THE SUPPRESSION REASONS ARE RE-DERIVED, NOT READ. Snapshots store
 *    privacy_eligible but not the gate's reason, so this script re-runs the real
 *    privacy gate read-only over live-eligible claims (see lib/intelFunnelReport).
 *    The reason distinguishes "still below the k=15 actor floor"
 *    (below_actor_threshold) from "at the floor but missing the group signal"
 *    (invalid_input) — the single most useful signal for deciding whether the
 *    blocker is still density or has become the owner's group-independence
 *    decision. It reflects CURRENT observations, which may differ from what the
 *    last projection pass persisted; the two are shown side by side.
 *
 * Usage:
 *   pnpm run report:intel-funnel [-- --days 7]
 *   pnpm run report:intel-funnel -- --since 2026-08-26T00:00:00Z --until 2026-08-26T12:00:00Z
 */

// Read-only audit front door — hoisted, runs before any client is constructed.
// See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { getServiceClient } from "../lib/supabase.js";
import { resolveReportWindow, ReportWindowError } from "../lib/discoveryServePointReport.js";
import { DENSITY_GATE_V1 } from "../lib/intelLiveScope.js";
import {
  assessDensityGate,
  tallyIntelFunnel,
  type ClaimRow,
  type ConfirmationRow,
  type EnumTally,
  type FunnelRows,
  type ObservationRow,
  type SnapshotRow,
} from "../lib/intelFunnelReport.js";

export {};

// A defensive fetch cap: silent truncation would UNDERSTATE the funnel, which is
// the very "absence of evidence" trap this report exists to avoid. If a set hits
// the cap the script warns loudly rather than quoting a truncated count.
const FETCH_CAP = 200_000;

function pct(n: number, total: number): string {
  if (total === 0) return "  n/a";
  return `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

/** Print an enum tally, always showing every known key (0s included), then the reader-defect bucket. */
function printEnumTally(t: EnumTally, indent = "  "): void {
  for (const [k, n] of Object.entries(t.byKey)) {
    console.log(`${indent}${k.padEnd(24)} ${String(n).padStart(9)}  ${pct(n, t.total)}`);
  }
  if (t.unknown > 0) {
    console.log(
      `${indent}⚠ ${t.unknown} row(s) carry a value THIS BUILD DOES NOT RECOGNISE: ${t.unknownValues.sort().join(", ")}`,
    );
    console.log(`${indent}  That is a defect in THIS SCRIPT, not the data — the enum grew past it. Fix the`);
    console.log(`${indent}  known-key list in src/lib/intelFunnelReport.ts before quoting these counts.`);
  }
}

async function fetchAll<T>(query: any, label: string): Promise<T[]> {
  const { data, error } = await query.limit(FETCH_CAP);
  if (error) {
    console.error(`Query failed (${label}):`, error.message);
    process.exit(2);
  }
  const rows = (data as T[]) ?? [];
  if (rows.length >= FETCH_CAP) {
    console.error(
      `⚠ ${label}: fetch hit the ${FETCH_CAP} row cap — counts below are TRUNCATED and must not be quoted. ` +
        `Narrow the window and re-run.`,
    );
    process.exit(2);
  }
  return rows;
}

async function main(): Promise<void> {
  // One clock read for the whole run — resolveReportWindow and the freshness/
  // expiry checks must not disagree about "now" (split-clock guard).
  const nowMs = Date.now();
  let window;
  try {
    window = resolveReportWindow(process.argv, nowMs);
  } catch (err) {
    if (err instanceof ReportWindowError) {
      console.error(`Refusing to run: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const sc = getServiceClient();
  if (!sc) {
    console.error("No service client — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }

  const now = new Date(nowMs);
  const windowDesc =
    window.until === null
      ? `${window.since} → now (open at the top)`
      : `${window.since} → ${window.until}`;

  console.log("Intelligence-Gathering funnel + density gate — READ-ONLY (SELECT only)");
  console.log(`Window: ${windowDesc}`);
  console.log("");

  // ── Fetch (read-only). Each set windowed by its own natural timestamp. ───────
  const obsQ = withUntil(
    sc.from("intel_observations")
      .select("actor_id, subject_id, claim_type, moderation_state, observed_at, expires_at")
      .gte("observed_at", window.since),
    "observed_at",
    window.until,
  );
  const claimQ = withUntil(
    sc.from("intel_claims").select("subject_id, claim_type, status, observed_at").gte("observed_at", window.since),
    "observed_at",
    window.until,
  );
  const snapQ = withUntil(
    sc.from("intel_state_snapshots").select("privacy_eligible, confidence_band, expires_at").gte("computed_at", window.since),
    "computed_at",
    window.until,
  );
  const confQ = withUntil(
    sc.from("intel_confirmations").select("stance").gte("created_at", window.since),
    "created_at",
    window.until,
  );

  const [observations, claims, snapshots, confirmations] = await Promise.all([
    fetchAll<ObservationRow>(obsQ, "intel_observations"),
    fetchAll<ClaimRow>(claimQ, "intel_claims"),
    fetchAll<SnapshotRow>(snapQ, "intel_state_snapshots"),
    fetchAll<ConfirmationRow>(confQ, "intel_confirmations"),
  ]);

  const rows: FunnelRows = { observations, claims, snapshots, confirmations };
  const funnel = tallyIntelFunnel(rows, now);

  // ── Empty-data honesty, BEFORE any gate verdict ──────────────────────────────
  const anyData =
    observations.length > 0 || claims.length > 0 || snapshots.length > 0 || confirmations.length > 0;
  if (!anyData) {
    console.log("── VERDICT: NOT ESTABLISHED ──");
    console.log("  No intel rows of any kind in this window. This script CANNOT distinguish");
    console.log("  'capture never ran here' from 'the flags are off' from 'the data was erased'.");
    console.log("  No funnel and no density-gate verdict may be drawn from this output.");
    process.exit(0);
  }

  // ── 1. Observations ──────────────────────────────────────────────────────────
  console.log("── 1. observations submitted (by moderation state) ──");
  printEnumTally(funnel.observations.tally);
  console.log(`  eligible to back a claim ('allowed') ... ${funnel.observations.eligibleForClaim}`);
  if (funnel.observations.tally.total > 0 && funnel.observations.eligibleForClaim === 0) {
    console.log("  ⚠ No observation is 'allowed'. moderation_state defaults to 'pending' and no");
    console.log("    worker promotes it, so no claim can be backed. This starves every stage below.");
  }
  console.log("");

  // ── 2. Claims ────────────────────────────────────────────────────────────────
  console.log("── 2. claims (by status) ──");
  printEnumTally(funnel.claims.tally);
  console.log(`  live-eligible (active + conflicting) ... ${funnel.claims.liveEligible}`);
  console.log("");

  // ── 3. Snapshots ─────────────────────────────────────────────────────────────
  console.log("── 3. projected snapshots ──");
  console.log(`  total ............... ${funnel.snapshots.total}`);
  console.log(`  privacy-eligible .... ${funnel.snapshots.eligible}  ${pct(funnel.snapshots.eligible, funnel.snapshots.total)}`);
  console.log(`  suppressed .......... ${funnel.snapshots.suppressed}  ${pct(funnel.snapshots.suppressed, funnel.snapshots.total)}`);
  console.log(`  expired ............. ${funnel.snapshots.expired}`);
  console.log(`  SERVABLE LIVE now ... ${funnel.snapshots.servableLive}   (eligible ∧ band ≥ likely_current ∧ unexpired)`);
  console.log("  by confidence band:");
  printEnumTally(funnel.snapshots.bandTally, "    ");
  if (funnel.snapshots.total > 0 && funnel.snapshots.eligible === 0) {
    console.log("  ⚠ Snapshots exist but NONE are privacy-eligible. See §5 for the gate's reason.");
  }
  console.log("");

  // ── 4. Confirmations + contributor concentration ─────────────────────────────
  console.log("── 4. confirmations & contributor concentration ──");
  console.log(`  agree ${funnel.confirmations.agree}   disagree ${funnel.confirmations.disagree}   unsure ${funnel.confirmations.unsure}`);
  if (funnel.confirmations.tally.unknown > 0) {
    console.log(`  ⚠ ${funnel.confirmations.tally.unknown} confirmation(s) with an unrecognised stance: ${funnel.confirmations.tally.unknownValues.join(", ")}`);
  }
  console.log(`  distinct contributors ... ${funnel.contributor.distinctActors}`);
  console.log(`  busiest single actor .... ${funnel.contributor.topActorObservations} obs  (${(funnel.contributor.topActorShare * 100).toFixed(1)}% of all observations)`);
  console.log("");

  // ── 5. Suppression reasons (RE-DERIVED read-only over live-eligible claims) ───
  console.log("── 5. why claims are not publishable (re-derived from the real gate) ──");
  const sup = funnel.suppression;
  console.log(`  live-eligible claims evaluated ... ${sup.evaluatedClaims}`);
  console.log(`  would publish now ............... ${sup.publishable}`);
  if (sup.evaluatedClaims === 0) {
    console.log("  (no active/conflicting claim to evaluate — nothing to suppress or publish)");
  } else {
    for (const [reason, n] of Object.entries(sup.byReason)) {
      if (n > 0) console.log(`  ${reason.padEnd(30)} ${String(n).padStart(6)}  ${pct(n, sup.evaluatedClaims)}`);
    }
    const belowActor = sup.byReason["below_actor_threshold"] ?? 0;
    const invalid = sup.byReason["invalid_input"] ?? 0;
    if (invalid > 0) {
      console.log("");
      console.log("  ▶ invalid_input here means the claim CLEARED the k=15 actor floor but the gate");
      console.log("    then refused for a MISSING GROUP SIGNAL (distinctGroups/maxGroupShare). Capture");
      console.log("    collects no independent-group signal, so these cannot publish until the owner");
      console.log("    decides what an 'independent group' is. This is the pilot's blocking decision.");
    } else if (belowActor > 0) {
      console.log("");
      console.log("  ▶ The blocker is still DENSITY: these claims have not yet reached k=15 distinct");
      console.log("    contributors. The group-signal decision does not bite until they do.");
    }
  }
  console.log("");

  // ── 6. Density gate (never certifiable from this instrument — by design) ──────
  const weeklyObs = funnel.observations.eligibleForClaim; // 'allowed' observations in-window
  const assessment = assessDensityGate(funnel, { qualifyingWeeklyObservations: weeklyObs });
  console.log("── 6. §26 density gate (promotion criterion) ──");
  console.log(`  citywide contributors ... ${assessment.metrics.activeReliableContributorsCitywide} / ${DENSITY_GATE_V1.activeReliableContributorsCitywide}  (UPPER BOUND — reliability not modelled)`);
  console.log(`  qualifying weekly obs ... ${assessment.metrics.qualifyingWeeklyObservations} / ${DENSITY_GATE_V1.qualifyingWeeklyObservations}  (MEASURED, this window)`);
  console.log(`  per-cluster / per-venue / outcomes / calibration / expiry ... UNINSTRUMENTED (forced fail-closed)`);
  console.log(`  gate arithmetic .......... ${assessment.gate.met ? "met" : "NOT met"}  ${assessment.gate.failures.length ? `[${assessment.gate.failures.join(", ")}]` : ""}`);
  console.log("");
  if (assessment.certifiable) {
    // Defensive: this cannot happen while inputs are uninstrumented. If it ever
    // does, it is a measurement bug, and we refuse rather than emit a green.
    console.log("  ⚠ Gate reports met AND all inputs instrumented — verify the instrumentation");
    console.log("    changes before treating this as a promotion signal.");
  } else {
    console.log("  VERDICT: NOT CERTIFIABLE.");
    console.log(`  Uninstrumented inputs: ${assessment.uninstrumented.join(", ") || "(none)"}`);
    console.log(`  Upper-bound inputs (not proven cleared): ${assessment.upperBound.join(", ") || "(none)"}`);
    console.log("  Promotion to public Live remains a human decision, and this instrument does");
    console.log("  not yet measure enough to inform it. It DOES show whether real capture is");
    console.log("  flowing and where it stalls — read §1–§5, not this line, for that.");
  }

  process.exit(0);
}

/** Apply an inclusive upper bound only when the window has one. */
function withUntil(query: any, column: string, until: string | null): any {
  return until === null ? query : query.lte(column, until);
}

main().catch((err) => {
  console.error("reportIntelFunnel failed:", err);
  process.exit(2);
});
