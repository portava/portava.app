/**
 * Discovery serve-point distribution — READ-ONLY (SELECT only).
 *
 * WHAT THIS ANSWERS
 * =================
 * Stage 0's deliverable, and the input to the D5 revisit clause:
 *
 *   Of the discovery serves users actually received, what fraction reached a
 *   ranker at all?
 *
 * Before P1 Stage 0 this could not be asked. `surface='discovery'` held zero
 * rows because the only path that wrote one is reached on a cache miss, and
 * cache A absorbed effectively all authenticated traffic
 * (docs/algorithm/discovery-impression-gap.md).
 *
 * THE D5 REVISIT CLAUSE
 * =====================
 * Operator ruling D5=B (rank every request over a user-independent candidate
 * cache) rests on the claim that cache A's 2-hour TTL makes ranked serves rare.
 * The clause is binding: **if the measured hit rate materially contradicts the
 * TTL-implied rate, D5 implementation pauses and the numbers go to the owner.**
 * This script produces those numbers and states the verdict explicitly rather
 * than leaving it to be eyeballed.
 *
 * WHAT IT CANNOT SEE — READ BEFORE QUOTING ANY NUMBER
 * ===================================================
 * 1. NOTHING BEFORE THE FLAG. Rows exist only for serves that happened while
 *    `discovery_serve_log_enabled` was true. A window that predates the flag
 *    reports zeroes that mean "not instrumented", NOT "did not happen". The
 *    script refuses to render a verdict on an empty window for this reason.
 *
 * 2. AUTHENTICATED TRAFFIC ONLY. `rank_events.user_id` is NOT NULL
 *    (0153_add_rank_events.sql), so anonymous serves cannot be recorded at all.
 *    Every percentage below is a share of AUTHENTICATED serves. Anonymous
 *    discovery traffic is invisible here and is separately known to be entirely
 *    unranked (scoreWithContext at routes/discovery.ts:1423 is unreachable).
 *
 * 3. SERVES, NOT REQUESTS. One row per served ITEM. A request serving 20 places
 *    contributes 20 rows. Serve-point shares are therefore weighted by page
 *    size, which is uniform across serve points here (all use PAGE_SIZE), so
 *    the shares are comparable — but they are not request counts. The distinct
 *    session_id count is reported alongside as the closer proxy for requests.
 *
 * 4. IT CANNOT ATTRIBUTE A CACHE HIT TO WHAT WARMED IT. /discovery/counts warms
 *    cache A L1 with the same key (routes/discovery.ts:1542), so some serve
 *    point 1 rows are attributable to a counts request rather than to a prior
 *    /discovery serve. Nothing here separates them.
 *
 * Usage:
 *   pnpm run report:discovery-serve-points [-- --days 7]
 */
import { getServiceClient } from "../lib/supabase.js";

const SERVE_POINT_LABEL: Record<number, string> = {
  1: "Cache A — L1 hit",
  2: "Cache A — L2 fresh",
  3: "Cache A — L2 stale (SWR)",
  4: "Cache B hit (Compass replay)",
  5: "Compass fresh rank",
  6: "Cold fetch — legacy rank",
};

/** Serve points on which a ranker ran during the request itself. */
const RANKED = new Set([5, 6]);
/** Serve points served out of cache A specifically. */
const CACHE_A = new Set([1, 2, 3]);

function pct(n: number, total: number): string {
  if (total === 0) return "  n/a";
  return `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

async function main(): Promise<void> {
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg >= 0 ? Math.max(1, parseInt(process.argv[daysArg + 1] ?? "7", 10)) : 7;

  const sc = getServiceClient();
  if (!sc) {
    console.error("No service client — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  console.log("Discovery serve-point distribution — READ-ONLY (SELECT only)");
  console.log(`Window: last ${days} day(s), served_at >= ${cutoff}`);
  console.log("");

  const { data, error } = await sc
    .from("rank_events")
    .select("features, session_id, served_at")
    .eq("surface", "discovery")
    .eq("outcome", "impression")
    .gte("served_at", cutoff);

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(2);
  }

  const rows = (data as any[]) ?? [];

  // ── Tally ──────────────────────────────────────────────────────────────────
  const byPoint = new Map<number, number>();
  const sessionsByPoint = new Map<number, Set<string>>();
  let unmarked = 0;

  for (const r of rows) {
    const sp = Number(r?.features?.servePoint);
    if (!Number.isFinite(sp) || sp < 1 || sp > 6) {
      // Rows written before Stage 0 carry no marker. See the amended invariant
      // in docs/algorithm/discovery-impression-gap.md.
      unmarked += 1;
      continue;
    }
    byPoint.set(sp, (byPoint.get(sp) ?? 0) + 1);
    if (r.session_id) {
      if (!sessionsByPoint.has(sp)) sessionsByPoint.set(sp, new Set());
      sessionsByPoint.get(sp)!.add(r.session_id as string);
    }
  }

  const marked = [...byPoint.values()].reduce((a, b) => a + b, 0);

  console.log("── 1. rows by serve point ──");
  if (marked === 0) {
    console.log("  (no marked rows in this window)");
  } else {
    for (let sp = 1; sp <= 6; sp++) {
      const n = byPoint.get(sp) ?? 0;
      const sessions = sessionsByPoint.get(sp)?.size ?? 0;
      const rankedTag = RANKED.has(sp) ? "ranked" : "      ";
      console.log(
        `  ${sp}  ${SERVE_POINT_LABEL[sp]!.padEnd(30)} ${String(n).padStart(9)}  ${pct(n, marked)}  ${rankedTag}  ${String(sessions).padStart(7)} sessions`,
      );
    }
  }
  if (unmarked > 0) {
    console.log(`\n  ${unmarked} row(s) carry no servePoint marker — these predate Stage 0.`);
    console.log("  They are EXCLUDED from every percentage below.");
  }
  console.log("");

  // ── Refuse a verdict on an empty window ────────────────────────────────────
  if (marked === 0) {
    console.log("── VERDICT: NOT ESTABLISHED ──");
    console.log("  Zero marked rows. This means the instrumentation was not enabled");
    console.log("  during this window — NOT that no serves occurred. Enable");
    console.log("  discovery_serve_log_enabled, let a representative window pass,");
    console.log("  then re-run. No D5 conclusion may be drawn from this output.");
    process.exit(0);
  }

  // ── 2. The number D5 turns on ──────────────────────────────────────────────
  const rankedRows = [...RANKED].reduce((a, sp) => a + (byPoint.get(sp) ?? 0), 0);
  const cacheARows = [...CACHE_A].reduce((a, sp) => a + (byPoint.get(sp) ?? 0), 0);
  const cacheBRows = byPoint.get(4) ?? 0;

  console.log("── 2. reached a ranker? ──");
  console.log(`  ranked in-request (5,6)   ${String(rankedRows).padStart(9)}  ${pct(rankedRows, marked)}`);
  console.log(`  served from cache (1-4)   ${String(marked - rankedRows).padStart(9)}  ${pct(marked - rankedRows, marked)}`);
  console.log(`    of which cache A (1-3)  ${String(cacheARows).padStart(9)}  ${pct(cacheARows, marked)}`);
  console.log(`    of which cache B (4)    ${String(cacheBRows).padStart(9)}  ${pct(cacheBRows, marked)}`);
  console.log("");

  // ── 3. D5 revisit clause ───────────────────────────────────────────────────
  //
  // The packet's argument is that cache A's 2h TTL makes ranked serves RARE.
  // "Materially contradicts" is given a number here so the verdict is not a
  // matter of taste: if more than a third of serves already reach a ranker,
  // the premise that ranking is starved is not what the data shows, and D5's
  // cost/benefit changes enough that the owner should see it before work
  // proceeds.
  const RANKED_SHARE_THRESHOLD = 0.33;
  const rankedShare = rankedRows / marked;

  console.log("── 3. D5 revisit clause ──");
  console.log(`  ranked share ........ ${(rankedShare * 100).toFixed(1)}%`);
  console.log(`  pause threshold ..... ${(RANKED_SHARE_THRESHOLD * 100).toFixed(0)}%`);
  console.log("");

  if (rankedShare > RANKED_SHARE_THRESHOLD) {
    console.log("  VERDICT: PAUSE D5 AND REPORT.");
    console.log("  The measured ranked share materially exceeds what the 2h TTL implies.");
    console.log("  Ranking is not as starved as the packet argued. Per the binding");
    console.log("  revisit clause, take these numbers to the owner BEFORE implementing D5.");
    process.exit(3);
  }

  console.log("  VERDICT: PROCEED WITH D5.");
  console.log("  The measured ranked share is consistent with the packet's argument:");
  console.log("  cache A absorbs the traffic and personalisation rarely runs.");
  console.log("");
  console.log("  Note this confirms the DIRECTION, not the exact figure. Caveats 1-4 in");
  console.log("  this file's header all still apply, and none of them is measured here.");
  process.exit(0);
}

main().catch((err) => {
  console.error("reportDiscoveryServePoints failed:", err);
  process.exit(2);
});
