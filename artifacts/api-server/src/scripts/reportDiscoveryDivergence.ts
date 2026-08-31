/**
 * Stage-3 report — how differently would PDE order discovery, and at what cost.
 *
 * READ-ONLY (SELECT only) over `discovery_shadow_serves`, the table shadow mode
 * (Stage 2) fills. Prints divergence + cost, segregated by serve-point class,
 * sort_by, and cohort_reason — the splits the packet says must never be summed.
 *
 *   pnpm run report:discovery-divergence [-- --days 7]
 *
 * Exit codes: 0 = ran; 2 = cannot run (no client / bad window / query error).
 * It NEVER decides anything — it prints the numbers a human reads before Stage 4.
 */

// The read-only prod-audit guard front door (see docs/ci/BOOTSTRAP.md).
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { getServiceClient } from "../lib/supabase.js";
import { resolveReportWindow, ReportWindowError } from "../lib/discoveryServePointReport.js";
import {
  aggregateDivergence,
  formatGroup,
  type ShadowServeRow,
} from "../lib/discoveryDivergenceReport.js";

export {};

async function main(): Promise<void> {
  let window;
  try {
    window = resolveReportWindow(process.argv, Date.now());
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

  console.log("Discovery PDE divergence + cost — READ-ONLY (SELECT only)");
  console.log(`Window: ${window.description}`);
  console.log("");

  let query = sc
    .from("discovery_shadow_serves")
    .select(
      "serve_point, sort_by, cohort_reason, page_size, legacy_total, pde_total, " +
        "overlap_count, displaced_count, top_changed, legacy_ms, pde_ms, pde_suppressed_writes",
    )
    .gte("observed_at", window.since);
  if (window.until !== null) query = query.lte("observed_at", window.until);

  const { data, error } = await query;
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(2);
  }

  const rows = ((data as any[]) ?? []) as ShadowServeRow[];
  if (rows.length === 0) {
    console.log("No shadow rows in this window.");
    console.log("");
    console.log("This is NOT evidence that PDE agrees with legacy — it is evidence that");
    console.log("shadow produced nothing to compare. Enable DISCOVERY_ENGINE_MODE=shadow");
    console.log("for a non-empty cohort and let cache-A traffic flow before reading a");
    console.log("verdict here. A divergence report over zero rows has measured nothing.");
    process.exit(0);
  }

  const groups = aggregateDivergence(rows);
  console.log(`── ${rows.length} shadow serve(s) across ${groups.length} group(s) ──`);
  console.log("");
  console.log("Groups are split by serve-point class, sort, and cohort and are NEVER summed:");
  console.log("  [cache_a]  = serve points 1/2/3 — legacy ran NO ranker; divergence here means");
  console.log("               PDE reached traffic legacy never ranked at all.");
  console.log("  [cold_rank]= serve point 6 — legacy DID rank; divergence here is ranker-vs-ranker.");
  console.log("");
  for (const g of groups) {
    for (const line of formatGroup(g)) console.log(line);
    console.log("");
  }

  console.log("Reading it: 'top-1 changed' is how often PDE would swap the first result;");
  console.log("'membership Δ/page' is how many places PDE would add or drop from the page;");
  console.log("'cost' is the ranking latency PDE adds. None of these is a verdict — the owner");
  console.log("weighs the divergence against the cost before Stage 4 flips pde live.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
