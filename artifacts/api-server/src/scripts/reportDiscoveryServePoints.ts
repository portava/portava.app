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
 * 0. THE READER WAS ITSELF BLIND UNTIL 2026-08-15, AND THAT IS WHY THIS SECTION
 *    STARTS AT ZERO. This script bounded servePoint to 1..6 while Stage 0b had
 *    grown DiscoveryServePoint to 9 (FEED, SEARCH, SUGGEST), and bucketed the
 *    difference as rows that "predate Stage 0". Run against production over a
 *    window holding five real, marked, post-Stage-0b rows it printed
 *    "(no marked rows in this window)" and then "the instrumentation was not
 *    enabled during this window" — of instrumentation that was demonstrably
 *    running, since those rows exist only because it was.
 *
 *    Absence of evidence became evidence of absence INSIDE THE INSTRUMENT. The
 *    fix is in `src/lib/discoveryServePointReport.ts`, whose labels are keyed
 *    off the enum and which fails loudly rather than quietly when the enum grows
 *    past it. Read that file before trusting any number here.
 *
 * 1. NOTHING BEFORE THE FLAG. Rows exist only for serves that happened while
 *    `discovery_serve_log_enabled` was true. A window that predates the flag
 *    reports zeroes that mean "not instrumented", NOT "did not happen". The
 *    script refuses to render a verdict on an empty window for this reason —
 *    and it now distinguishes "no rows", "rows with no marker" and "rows with a
 *    marker I do not recognise", because only the second of those is evidence
 *    about when the flag was on.
 *
 * 1b. A THIN WINDOW MAY BE A BROKEN SURFACE, NOT LOW TRAFFIC — AND THIS SCRIPT
 *    CANNOT TELL THE DIFFERENCE. Established 2026-08-15: instrumentation was
 *    proven live by a bounded probe, and the same probe showed that exactly ONE
 *    of the 464 rank rows written that hour carried surface='discovery' (the
 *    rest: 270 pulse, 189 compass, 4 live_pulse), alongside CORS-blocked
 *    places-api.foursquare.com calls and a navigation bug.
 *
 *    So discovery is barely reachable in the current build. That matters more
 *    than the empty-window case it resembles, and in the opposite direction:
 *    an empty window makes this script REFUSE a verdict, but a thin non-empty
 *    window makes it RETURN one. A handful of serves that all happened to be
 *    cache hits would exit 0 and read as "cache A absorbs the traffic and
 *    personalisation rarely runs" — the packet's central claim, apparently
 *    corroborated, when what was actually measured is that almost nobody could
 *    reach discovery at all.
 *
 *    BEFORE QUOTING ANY WINDOW FROM THIS SCRIPT, establish separately that the
 *    discovery surface is reachable. The distinct-session count printed below
 *    is the closest signal available here, and it is not sufficient on its own.
 *
 * 2. AUTHENTICATED TRAFFIC ONLY. `rank_events.user_id` is NOT NULL
 *    (0153_add_rank_events.sql), so anonymous serves cannot be recorded at all.
 *    Every percentage below is a share of AUTHENTICATED serves. Anonymous
 *    discovery traffic is invisible here and is separately known to be entirely
 *    unranked (scoreWithContext at routes/discovery.ts:1423 is unreachable).
 *
 * 2b. NOT ONE POPULATION. Sections 1 and 1b cover ALL nine serve points, because
 *    the question "is discovery reachable" is about the whole surface. Sections
 *    2, 2b and 3 cover serve points 1-6 ONLY, because the D5 clause and the
 *    Stage 1 dispatch are both about GET /discovery, and feed/search/suggest
 *    contain no ranker call and pass no engineMode. The two are reported side by
 *    side and never summed into one ratio — folding 7-9 into the D5 denominator
 *    would push the ranked share down with rows that were never candidates for
 *    ranking, so the claim "cache A absorbs the traffic" would look better
 *    supported the more search traffic the app got.
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

// Read-only audit front door. Imported for its side effect and hoisted, so it
// runs before any client is constructed whatever its textual position.
// See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { getServiceClient } from "../lib/supabase.js";
import {
  ALL_SERVE_POINTS,
  CACHE_A_POINTS,
  DISCOVERY_ENDPOINT_POINTS,
  RANKED_POINTS,
  SERVE_POINT_LABEL,
  assertLabelsCoverEnum,
  countOn,
  observedPoints,
  tallyServePoints,
  unexercisedPoints,
  type ServeRow,
} from "../lib/discoveryServePointReport.js";

export {};

// Refuse to run at all if DiscoveryServePoint has grown past the label map.
// The previous version of this script hard-coded 1..6 while the enum grew to 9,
// and reported the difference as rows that "predate Stage 0".
assertLabelsCoverEnum();

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
  const tally = tallyServePoints(rows as ServeRow[]);
  const { marked, byPoint, sessionsByPoint, noMarker, unknownMarker, unknownValues } = tally;

  console.log("── 1. rows by serve point ──");
  if (marked === 0) {
    console.log("  (no marked rows in this window)");
  } else {
    for (const sp of ALL_SERVE_POINTS) {
      const n = byPoint.get(sp) ?? 0;
      const sessions = sessionsByPoint.get(sp)?.size ?? 0;
      const rankedTag = RANKED_POINTS.has(sp) ? "ranked" : "      ";
      const scope = DISCOVERY_ENDPOINT_POINTS.has(sp) ? "GET /discovery" : "other surface";
      console.log(
        `  ${sp}  ${SERVE_POINT_LABEL[sp]!.padEnd(30)} ${String(n).padStart(9)}  ${pct(n, marked)}  ${rankedTag}  ${String(sessions).padStart(7)} sessions  ${scope}`,
      );
    }
  }

  // The two "not counted" reasons are DIFFERENT FINDINGS and are never merged.
  if (noMarker > 0) {
    console.log(`\n  ${noMarker} row(s) carry NO servePoint key — these predate Stage 0.`);
    console.log("  They are EXCLUDED from every percentage below.");
  }
  if (unknownMarker > 0) {
    console.log(
      `\n  ⚠ ${unknownMarker} row(s) carry a servePoint value THIS BUILD DOES NOT RECOGNISE: ` +
        `${[...unknownValues].sort().join(", ")}`,
    );
    console.log("  That is a defect in THIS SCRIPT, not a fact about the data: the writer");
    console.log("  emits a serve point the reader has never heard of, so this report is");
    console.log("  stale. Add it to DiscoveryServePoint's label map in");
    console.log("  src/lib/discoveryServePointReport.ts and decide whether it belongs in");
    console.log("  DISCOVERY_ENDPOINT_POINTS before quoting any number below.");
  }
  console.log("");

  // ── Reachability, reported BEFORE any ratio ────────────────────────────────
  //
  // Phase B's exit criterion is discovery rows at MULTIPLE serve points, and it
  // is the thing this file's header warns is not visible in a ratio. So it is
  // stated plainly and first, rather than left to be reconstructed from the
  // table above.
  const seen = observedPoints(tally);
  const unexercised = unexercisedPoints(tally);
  console.log("── 1b. reachability ──");
  console.log(`  serve points with rows ..... ${seen.length}/${ALL_SERVE_POINTS.length}  ${seen.length ? `[${seen.join(", ")}]` : "(none)"}`);
  if (unexercised.length > 0) {
    console.log(`  UNEXERCISED ................ [${unexercised.join(", ")}]`);
    console.log("  Unexercised is NOT the same as unreachable: nothing here can tell a");
    console.log("  surface nobody visited from one nobody could reach. Say which, or");
    console.log("  say neither.");
  }
  if (marked > 0 && seen.length === 1) {
    console.log(`\n  ⚠ ONE serve point only (${seen[0]}). Phase B's exit criterion is rows at`);
    console.log("    MULTIPLE serve points; one does not meet it, however many rows it has.");
  }
  console.log("");

  // ── Refuse a verdict on an empty window ────────────────────────────────────
  //
  // WHAT THIS BLOCK MAY AND MAY NOT ASSERT.
  //
  // The previous version printed "the instrumentation was not enabled during
  // this window" whenever `marked === 0`. It reached that state on a window
  // holding five real, marked, post-Stage-0b rows — because it only recognised
  // serve points 1-6 — and so reported live instrumentation as absent
  // instrumentation. Absence of evidence became evidence of absence inside the
  // instrument itself.
  //
  // Zero marked rows is now split into the cases that are actually different,
  // and the one claim this script cannot support on its own is never made.
  if (marked === 0) {
    console.log("── VERDICT: NOT ESTABLISHED ──");
    if (rows.length === 0) {
      console.log("  No surface='discovery' impression rows at all in this window.");
      console.log("  This script CANNOT distinguish 'the flag was off' from 'the surface");
      console.log("  was unreachable' from 'nobody visited'. Check");
      console.log("  discovery_serve_log_enabled before reading anything into it.");
    } else if (unknownMarker > 0) {
      console.log(`  ${rows.length} row(s) present, ${unknownMarker} of them carrying a servePoint`);
      console.log("  this build does not recognise. The instrumentation IS running. This");
      console.log("  report is stale — fix it (see the warning above) and re-run before");
      console.log("  drawing any conclusion.");
    } else {
      console.log(`  ${rows.length} row(s) present, all of them predating Stage 0 (no servePoint`);
      console.log("  key). Serve-point instrumentation was not running when these were");
      console.log("  written. Nothing here says whether it is running NOW.");
    }
    console.log("  No D5 conclusion may be drawn from this output.");
    process.exit(0);
  }

  // ── 2. The number D5 turns on ──────────────────────────────────────────────
  //
  // COMPUTED OVER SERVE POINTS 1-6 ONLY, and that is deliberate.
  //
  // The D5 revisit clause asks what fraction of discovery serves reached a
  // ranker, and the packet claim it tests is about GET /discovery: cache A's
  // 2-hour TTL starving the ranker. Serve points 7-9 are feed, search and
  // suggest, which contain no ranker call at all — a row from them is not a
  // serve that could have been ranked and lost.
  //
  // Including them would push the ranked share DOWN with rows that were never
  // candidates, making "cache A absorbs the traffic" look better supported the
  // more search traffic the app gets. That is a self-confirming measurement
  // error, and widening section 1 to 1-9 without ring-fencing this section
  // would have introduced it while fixing the blindness above.
  const endpointRows = countOn(tally, DISCOVERY_ENDPOINT_POINTS);
  const rankedRows   = countOn(tally, RANKED_POINTS);
  const cacheARows   = countOn(tally, CACHE_A_POINTS);
  const cacheBRows   = byPoint.get(4) ?? 0;
  const otherRows    = marked - endpointRows;

  console.log("── 2. reached a ranker? (GET /discovery only — serve points 1-6) ──");
  console.log(`  GET /discovery serves     ${String(endpointRows).padStart(9)}  ${pct(endpointRows, marked)} of all marked rows`);
  if (otherRows > 0) {
    console.log(`  other discovery surfaces  ${String(otherRows).padStart(9)}  ${pct(otherRows, marked)} — feed/search/suggest, EXCLUDED below`);
  }
  console.log("");
  if (endpointRows === 0) {
    console.log("  No GET /discovery serves in this window. Section 3 is skipped: a ranked");
    console.log("  share over zero serves is not a small number, it is not a number.");
  } else {
    console.log(`  ranked in-request (5,6)   ${String(rankedRows).padStart(9)}  ${pct(rankedRows, endpointRows)}`);
    console.log(`  served from cache (1-4)   ${String(endpointRows - rankedRows).padStart(9)}  ${pct(endpointRows - rankedRows, endpointRows)}`);
    console.log(`    of which cache A (1-3)  ${String(cacheARows).padStart(9)}  ${pct(cacheARows, endpointRows)}`);
    console.log(`    of which cache B (4)    ${String(cacheBRows).padStart(9)}  ${pct(cacheBRows, endpointRows)}`);
  }
  console.log("");

  // ── 2b. Stage 1 exit criterion ─────────────────────────────────────────────
  //
  // Stage 1 put the DISCOVERY_ENGINE_MODE dispatch above the cache fork and
  // claimed it is a no-op. That claim is checkable in the same window rather
  // than needing one of its own: every row should carry engineMode 'legacy'.
  //
  // `modeReason` matters as much as `engineMode`. "legacy because the flag says
  // legacy" and "legacy because the flag was unreadable" are different facts,
  // and a dispatch that silently fell back for a week would otherwise look
  // exactly like one that resolved correctly.
  //
  // POPULATION: serve points 1-6, and for a reason rather than for lack of
  // sight. The dispatch sits above GET /discovery's cache fork, and serve points
  // 7-9 pass no engineMode at all (routes/discoverySearch.ts:1457, :1688,
  // routes/discovery.ts:1737 — their context objects carry no such key). Every
  // percentage below is therefore over GET /discovery serves, not over all
  // marked rows; using `marked` here would dilute the mode shares with rows the
  // dispatch never touched.
  const byMode   = new Map<string, number>();
  const byReason = new Map<string, number>();
  for (const r of rows as ServeRow[]) {
    const sp = Number(r?.features?.servePoint);
    if (!Number.isFinite(sp) || !DISCOVERY_ENDPOINT_POINTS.has(sp)) continue;
    const m  = String(r?.features?.engineMode ?? "(unrecorded)");
    const rs = String(r?.features?.modeReason ?? "(unrecorded)");
    byMode.set(m, (byMode.get(m) ?? 0) + 1);
    byReason.set(rs, (byReason.get(rs) ?? 0) + 1);
  }

  console.log("── 2b. engine mode (Stage 1 exit criterion — GET /discovery serves) ──");
  if (endpointRows === 0) console.log("  (no GET /discovery serves in this window)");
  for (const [m, n] of [...byMode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m.padEnd(14)} ${String(n).padStart(9)}  ${pct(n, endpointRows)}`);
  }
  console.log("  reasons:");
  for (const [rs, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${rs.padEnd(20)} ${String(n).padStart(9)}  ${pct(n, endpointRows)}`);
  }

  const nonLegacy   = endpointRows - (byMode.get("legacy") ?? 0);
  const unrecorded  = byMode.get("(unrecorded)") ?? 0;
  const fellBack    = (byReason.get("flag_unreadable") ?? 0)
                    + (byReason.get("no_client") ?? 0)
                    + (byReason.get("mode_invalid") ?? 0)
                    + (byReason.get("kill_switch_engaged") ?? 0);

  if (endpointRows > 0 && unrecorded === endpointRows) {
    console.log("\n  Stage 1 NOT YET OBSERVED — no row carries engineMode.");
    console.log("  These rows predate the Stage 1 dispatch. Not a failure.");
  } else if (endpointRows > 0 && nonLegacy > 0) {
    console.log(`\n  ⚠ ${nonLegacy} row(s) were served under a NON-LEGACY mode.`);
    console.log("  Stage 1's exit criterion is that every request resolves to legacy.");
    console.log("  If a later stage has advanced the mode deliberately, this is expected;");
    console.log("  if not, the dispatch is live earlier than intended.");
  } else if (endpointRows > 0) {
    console.log("\n  Stage 1 exit criterion HOLDS: every GET /discovery serve resolved to legacy.");
  } else {
    console.log("\n  Stage 1 NOT OBSERVED in this window — no GET /discovery serve to observe.");
    console.log("  That is not the criterion holding. It is the criterion untested.");
  }
  if (fellBack > 0) {
    console.log(`\n  ⚠ ${fellBack} resolution(s) reached legacy by FALLBACK, not by configuration`);
    console.log("    (flag_unreadable / no_client / mode_invalid / kill_switch_engaged).");
    console.log("    Behaviour was correct, but something is wrong with the flag path and");
    console.log("    would stay invisible without this line.");
  }
  console.log("");

  // ── 3. D5 revisit clause ───────────────────────────────────────────────────
  //
  // The packet's argument is that cache A's 2h TTL makes ranked serves RARE.
  // "Materially contradicts" is given a number here so the verdict is not a
  // matter of taste: if more than a third of serves already reach a ranker,
  // the premise that ranking is starved is not what the data shows, and D5's
  // cost/benefit changes enough that the owner should see it before work
  // proceeds.
  //
  // THE DIVISION THAT MUST NOT HAPPEN.
  //
  // This share was `rankedRows / marked`. With a window holding only feed,
  // search or suggest rows — which is exactly what production held on
  // 2026-08-15 — `marked` is non-zero, `rankedRows` is zero, and the share
  // comes out a clean 0.0%: below the threshold, so "PROCEED WITH D5",
  // stated confidently, from a window containing not one serve the clause is
  // about. And with no marked rows at all it divides by zero, and `NaN > 0.33`
  // is false, so the same verdict prints off a NaN.
  //
  // Both are refusals now. A ranked share over zero GET /discovery serves is
  // not a small number; it is not a number.
  const RANKED_SHARE_THRESHOLD = 0.33;

  console.log("── 3. D5 revisit clause ──");
  if (endpointRows === 0) {
    console.log("  VERDICT: NOT ESTABLISHED — no GET /discovery serves in this window.");
    console.log(`  ${marked} marked row(s) present, all on other discovery surfaces`);
    console.log("  (feed/search/suggest), none of which contains a ranker call. There is");
    console.log("  no ranked share to compute, and the absence of one is NOT evidence that");
    console.log("  ranking is starved — it is evidence that this window says nothing about");
    console.log("  it either way. Re-run over a window in which GET /discovery was served.");
    process.exit(0);
  }
  const rankedShare = rankedRows / endpointRows;

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
