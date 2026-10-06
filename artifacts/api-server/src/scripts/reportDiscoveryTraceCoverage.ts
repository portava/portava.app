/**
 * Discovery trace coverage — READ-ONLY (census-discovery DSV2-12, §55).
 *
 * `02-DISCOVERY-v2.md` DSV2-12: "Trace served recommendation→exposure→permitted
 * outcome with versions and coverage." Per surface and serve point: how many
 * signed-in served items have an exposure row, how many outcomes are bound to
 * an exposure and how many are not, under which schema_version and model
 * version — with anonymous serves counted apart (they can never bind).
 *
 * The arithmetic is lib/discoveryTraceCoverage.ts (pure, tested on fixtures).
 * The read is lib/discoveryTraceRead.ts: psql against the URL you GIVE it, in a
 * READ ONLY transaction that is rolled back. There is no default database.
 *
 * Usage:
 *   pnpm run report:discovery-trace-coverage -- --db-url postgres://… [--days 7]
 *   pnpm run report:discovery-trace-coverage -- --db-url postgres://… \
 *     --since 2026-09-01T00:00:00Z --until 2026-09-27T00:00:00Z [--json]
 *   (REPORT_DB_URL may stand in for --db-url.)
 *
 * Exit codes: 0 report printed · 1 the read failed · 2 bad arguments.
 */
import { resolveReportWindow, ReportWindowError } from "../lib/discoveryServePointReport.js";
import { buildTraceCoverageReport, renderTraceCoverageReport } from "../lib/discoveryTraceCoverage.js";
import { dbUrlFrom, readTraceCorpus } from "../lib/discoveryTraceRead.js";

const argv = process.argv.slice(2);
const dbUrl = dbUrlFrom(argv, process.env);
if (!dbUrl) {
  console.error("report:discovery-trace-coverage: give the database explicitly (--db-url <url> or REPORT_DB_URL). There is no default.");
  process.exit(2);
}
let window;
try {
  window = resolveReportWindow(argv, Date.now());
} catch (err) {
  if (err instanceof ReportWindowError) { console.error(err.message); process.exit(2); }
  throw err;
}

const read = readTraceCorpus(dbUrl, window);
if (!read.ok) {
  console.error(`report:discovery-trace-coverage: ${read.error}`);
  console.error("Refusing to report a partial corpus as coverage.");
  process.exit(1);
}
// census-discovery §120: a window reaching past 3501's retention horizon reads the per-request rows as UNOBSERVED; say why.
if (read.corpus.serveRequestsUnobserved) console.error(`report:discovery-trace-coverage: per-request rows UNOBSERVED — ${read.corpus.serveRequestsUnobserved}`);
const report = buildTraceCoverageReport(read.corpus.rankEvents, read.corpus.serveRequests);
if (argv.includes("--json")) {
  console.log(JSON.stringify({ window, rowsRead: read.corpus.rankEvents.length, report }, null, 2));
} else {
  console.log(`Discovery trace coverage — ${window.description} — ${read.corpus.rankEvents.length} rank_events row(s) read, read-only`);
  console.log(renderTraceCoverageReport(report));
}
