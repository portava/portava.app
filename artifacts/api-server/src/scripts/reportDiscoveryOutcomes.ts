/**
 * Discovery outcomes by arm — READ-ONLY (census-discovery DV-19, §55).
 *
 * `01` §12 lists what PDE's success is measured ON. This prints, per arm (the
 * serve row's own `features.modelVersion`: the PDE ranker vs everything else)
 * and per serve point, every §12 item whose input exists in the tree, with its
 * sample size — and names every item with no input as UNMEASURED. An arm with
 * no exposures is "insufficient sample", never 0 %. After the numbers it prints
 * the §82 judgement (register D-W10-O-10), kept apart from them.
 *
 * The arithmetic is lib/discoveryOutcomeReport.ts (pure, tested on fixtures).
 * The read is lib/discoveryTraceRead.ts: psql against the URL you GIVE it, in a
 * READ ONLY transaction that is rolled back. There is no default database.
 *
 * Usage:
 *   pnpm run report:discovery-outcomes -- --db-url postgres://… [--days 7] [--json]
 *   pnpm run report:discovery-outcomes -- --db-url postgres://… --since … [--until …]
 *   (REPORT_DB_URL may stand in for --db-url.)
 *
 * Exit codes: 0 report printed · 1 the read failed · 2 bad arguments.
 */
import { resolveReportWindow, ReportWindowError } from "../lib/discoveryServePointReport.js";
import { buildOutcomeReport, renderOutcomeReport, readOutcomeEnrichment, judgeOutcomeImprovement, renderOutcomeJudgement } from "../lib/discoveryOutcomeReport.js";
import { dbUrlFrom, readTraceCorpus } from "../lib/discoveryTraceRead.js";

const argv = process.argv.slice(2);
const dbUrl = dbUrlFrom(argv, process.env);
if (!dbUrl) {
  console.error("report:discovery-outcomes: give the database explicitly (--db-url <url> or REPORT_DB_URL). There is no default.");
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
  console.error(`report:discovery-outcomes: ${read.error}`);
  console.error("Refusing to report a partial corpus as outcomes.");
  process.exit(1);
}
// §82 (W10-O): the enrichment (creator, reports, later dismissals). A failed read leaves the four items UNOBSERVED, said, never 0.
const enr = readOutcomeEnrichment(dbUrl, window);
if (!enr.ok) console.error(`report:discovery-outcomes: ${enr.error} — regret, report rate, creator diversity and new-creator discovery are UNOBSERVED`);
const report = buildOutcomeReport(read.corpus.rankEvents, read.corpus.serveRequests, enr.ok ? enr.enrichment : null);
const judgement = judgeOutcomeImprovement(report);
if (argv.includes("--json")) {
  console.log(JSON.stringify({ window, rowsRead: read.corpus.rankEvents.length, report, judgement }, null, 2));
} else {
  console.log(`Discovery outcomes by arm — ${window.description} — ${read.corpus.rankEvents.length} rank_events row(s) read, read-only`);
  console.log(renderOutcomeReport(report));
  console.log("");
  console.log(renderOutcomeJudgement(judgement));
}
