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
  // The queries request count:'exact', which returns the TOTAL matching rows
  // regardless of the row limit — so `count > rows.length` detects a SERVER-side
  // cap (PostgREST db-max-rows below FETCH_CAP) that the client-side length check
  // alone would miss. Silent truncation understates the funnel — the exact
  // absence-of-evidence trap this instrument must avoid.
  const { data, error, count } = await query.limit(FETCH_CAP);
  if (error) {
    console.error(`Query failed (${label}):`, error.message);
    process.exit(2);
  }
  const rows = (data as T[]) ?? [];
  if (rows.length >= FETCH_CAP || (typeof count === "number" && count > rows.length)) {
    console.error(
      `⚠ ${label}: fetched ${rows.length} row(s)` +
        (typeof count === "number" ? ` of ${count} matching` : ` (hit the ${FETCH_CAP} cap)`) +
        ` — the result is TRUNCATED (client or server row cap) and must not be quoted. Narrow the window and re-run.`,
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
  const EXACT = { count: "exact" as const };
  const obsQ = withUntil(
    sc.from("intel_observations")
      .select("actor_id, subject_id, claim_type, moderation_state, observed_at, expires_at, group_key, party_size_bucket", EXACT)
      .gte("observed_at", window.since),
    "observed_at",
    window.until,
  );
  const claimQ = withUntil(
    sc.from("intel_claims").select("subject_id, claim_type, status, observed_at", EXACT).gte("observed_at", window.since),
    "observed_at",
    window.until,
  );
  const snapQ = withUntil(
    sc.from("intel_state_snapshots").select("privacy_eligible, confidence_band, expires_at", EXACT).gte("computed_at", window.since),
    "computed_at",
    window.until,
  );
  const confQ = withUntil(
    sc.from("intel_confirmations").select("stance", EXACT).gte("created_at", window.since),
    "created_at",
    window.until,
  );
  // The FULL fresh cohort for the §5/§5b gate re-derivation — freshness-filtered
  // with NO observed_at lower bound, matching the aggregator (which counts every
  // fresh observation regardless of age). Without this, a claim whose TTL exceeds
  // the window would be re-scored over a truncated cohort and the verdict would lie.
  const freshObsQ = sc
    .from("intel_observations")
    .select("actor_id, subject_id, claim_type, expires_at, group_key, moderation_state", EXACT)
    .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`);

  const [observations, freshObservations, claims, snapshots, confirmations] = await Promise.all([
    fetchAll<ObservationRow>(obsQ, "intel_observations"),
    fetchAll<ObservationRow>(freshObsQ, "intel_observations (fresh cohort)"),
    fetchAll<ClaimRow>(claimQ, "intel_claims"),
    fetchAll<SnapshotRow>(snapQ, "intel_state_snapshots"),
    fetchAll<ConfirmationRow>(confQ, "intel_confirmations"),
  ]);

  const rows: FunnelRows = { observations, freshObservations, claims, snapshots, confirmations };
  const funnel = tallyIntelFunnel(rows, now);

  // ── Empty-data honesty, BEFORE any gate verdict ──────────────────────────────
  // The fresh cohort counts too: a long-TTL claim's contributors can be older than
  // the window yet still fresh and currently live-eligible. Declaring "no evidence"
  // while holding those would be the exact absence-of-evidence trap this guards.
  const anyWindowData =
    observations.length > 0 || claims.length > 0 || snapshots.length > 0 || confirmations.length > 0;
  if (!anyWindowData && freshObservations.length === 0) {
    console.log("── VERDICT: NOT ESTABLISHED ──");
    console.log("  No intel rows of any kind in this window, and no fresh observations at all.");
    console.log("  This script CANNOT distinguish 'capture never ran here' from 'the flags are");
    console.log("  off' from 'the data was erased'. No funnel and no density-gate verdict may be");
    console.log("  drawn from this output.");
    process.exit(0);
  }
  if (!anyWindowData) {
    console.log("── VERDICT: NO IN-WINDOW ACTIVITY (but fresh intel exists) ──");
    console.log(`  The window holds no observations/claims/snapshots/confirmations, but ${freshObservations.length}`);
    console.log("  observation(s) captured earlier are STILL FRESH (within TTL) and feed §5's");
    console.log("  gate re-derivation below. Do not read this as 'nothing captured' — widen the");
    console.log("  window (--since) to see the flow that produced them. §1–§4 will read as 0.");
    console.log("");
  }

  // ── 1. Observations ──────────────────────────────────────────────────────────
  console.log("── 1. observations submitted (by moderation state) ──");
  printEnumTally(funnel.observations.tally);
  console.log(`  claimable in the PILOT (pending + allowed) ... ${funnel.observations.pilotClaimable}   ['allowed' alone: ${funnel.observations.eligibleForClaim}]`);
  console.log(`  EXCLUDED as invalidated (restricted/blocked/removed) ... ${funnel.observations.tally.total - funnel.observations.pilotClaimable - funnel.observations.tally.unknown}`);
  if (funnel.observations.tally.total > 0 && funnel.observations.pilotClaimable === 0) {
    console.log("  ⚠ NO observation is claimable — all are moderation-invalidated");
    console.log("    (restricted/blocked/removed). Nothing can back a claim or a label; this");
    console.log("    starves every stage below. (Pilot rule: pending + allowed are claimable;");
    console.log("    promotion is deferred but invalidated content is excluded everywhere.)");
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
    const belowGroup = sup.byReason["below_group_threshold"] ?? 0;
    const invalid = sup.byReason["invalid_input"] ?? 0;
    if (belowActor > 0) {
      console.log("");
      console.log("  ▶ Some claims are DENSITY-limited: not yet k=15 distinct contributors. The");
      console.log("    group requirement does not bite until they clear the actor floor.");
    }
    if (belowGroup > 0) {
      console.log("");
      console.log("  ▶ below_group_threshold: past the k=15 floor but < 5 independent groups. See §5b");
      console.log("    for whether that is 'not enough independent parties yet' vs 'group identity");
      console.log("    unavailable' (people arriving as non-crew parties that earn no group credit).");
    }
    if (invalid > 0) {
      console.log("");
      console.log("  ⚠ invalid_input should not occur now that the aggregator always supplies finite");
      console.log("    group inputs. If it does, a claim reached the gate without them — investigate.");
    }
  }
  console.log("");

  // ── 5b. Independent-group signal (the owner's insufficient-vs-unavailable split) ─
  const gs = funnel.groupSignal;
  console.log("── 5b. independent-group signal ──");
  console.log(`  observations with a group identity . ${gs.groupEligibleObservations}  (solo or crew)`);
  console.log(`  observations without one ........... ${gs.nullGroupObservations}  (non-crew 'with others', trail, or pre-signal)`);
  console.log("  party attestation (\"who are you here with?\"):");
  if (gs.partyTally.total === 0) {
    console.log("    (no observation carried a party attestation)");
  } else {
    printEnumTally(gs.partyTally, "    ");
  }
  console.log("  among claims past k=15 but short of 5 groups:");
  console.log(`    insufficient independent groups ... ${gs.insufficientGroups}  (HAS group identity, 1–4 distinct)`);
  console.log(`    group identity UNAVAILABLE ........ ${gs.groupIdentityUnavailable}  (0 group_key — the V1 party model, not adoption)`);
  if (gs.groupIdentityUnavailable > 0 && gs.groupIdentityUnavailable >= gs.insufficientGroups) {
    console.log("  ▶ The limiter is GROUP IDENTITY, not headcount: these venues have contributors");
    console.log("    but they arrive as non-crew parties (or pre-signal). More users alone will not");
    console.log("    unblock them — a shared party/crew signal or the level-4 clustering will.");
  }
  console.log("");

  // ── 6. Density gate (never certifiable from this instrument — by design) ──────
  const weeklyObs = funnel.observations.pilotClaimable; // pilot-claimable (pending+allowed) in-window
  const assessment = assessDensityGate(funnel, { qualifyingWeeklyObservations: weeklyObs });
  console.log("── 6. §26 density gate (promotion criterion) ──");
  console.log(`  citywide contributors ... ${assessment.metrics.activeReliableContributorsCitywide} / ${DENSITY_GATE_V1.activeReliableContributorsCitywide}  (UPPER BOUND — reliability not modelled)`);
  console.log(`  qualifying obs .......... ${assessment.metrics.qualifyingWeeklyObservations} / ${DENSITY_GATE_V1.qualifyingWeeklyObservations}  (in-window pilot-claimable count vs a WEEKLY threshold — compare only on a ~7-day window; ${windowDesc})`);
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
