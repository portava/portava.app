/**
 * Discovery ecosystem monitors — READ-ONLY (census-discovery DV-80, §58).
 *
 * `06` §8's Ecosystem Governor monitors, measured over a window: concentration,
 * new-creator success, stale content, repeated recommendations, spam rate,
 * Trail freshness, hidden-gem exposure — and `12` Phase 13's duplicate
 * saturation. Each is measured with its sample, or named UNMEASURED /
 * INPUT ABSENT / UNREADABLE. Never 0 for a missing input, and no threshold.
 *
 * The governor's other half — adjusting policy bounds — is NOT here and is not
 * built anywhere: it is held (census §58).
 *
 * The arithmetic is lib/discoveryEcosystemGovernor.ts (pure, tested). Every read
 * runs through lib/discoveryTraceRead.runReadOnly: psql against the URL you
 * GIVE it, inside BEGIN TRANSACTION READ ONLY with default_transaction_read_only
 * on, rolled back. There is no default database.
 *
 * Usage:
 *   pnpm run report:discovery-ecosystem -- --db-url postgres://… [--days 7] [--json]
 *   pnpm run report:discovery-ecosystem -- --db-url postgres://… --since … [--until …]
 *   (REPORT_DB_URL may stand in for --db-url.)
 *
 * Exit codes: 0 report printed · 1 every read failed · 2 bad arguments.
 */
import { resolveReportWindow, ReportWindowError } from "../lib/discoveryServePointReport.js";
import { dbUrlFrom, readTraceCorpus, runReadOnly } from "../lib/discoveryTraceRead.js";
import {
  buildEcosystemReport, renderEcosystemReport,
  ECOSYSTEM_STOP_SQL, ECOSYSTEM_REPEATS_SQL, ECOSYSTEM_SPAM_SQL,
  ECOSYSTEM_TRAILS_PRESENT_SQL, ECOSYSTEM_TRAILS_SQL, ECOSYSTEM_PAGES_PRESENT_SQL, ECOSYSTEM_PAGES_SQL,
  type ReadOutcome,
} from "../lib/discoveryEcosystemGovernor.js";

const argv = process.argv.slice(2);
const dbUrl = dbUrlFrom(argv, process.env);
if (!dbUrl) {
  console.error("report:discovery-ecosystem: give the database explicitly (--db-url <url> or REPORT_DB_URL). There is no default.");
  process.exit(2);
}
const nowMs = Date.now();
let resolved;
try {
  resolved = resolveReportWindow(argv, nowMs);
} catch (err) {
  if (err instanceof ReportWindowError) { console.error(err.message); process.exit(2); }
  throw err;
}
// Every read here takes a CLOSED window; an open top is closed at the moment
// the report ran, and the corpus read is given the same bound.
const window = { since: resolved.since, until: resolved.until ?? new Date(nowMs).toISOString() };
const vars = { since: window.since, until: window.until };

function read(sql: string): ReadOutcome {
  const r = runReadOnly(dbUrl!, sql, vars);
  return r.ok ? { ok: true, value: r.stdout } : { ok: false, error: r.error };
}
function readIfPresent(probe: string, sql: string, absent: string): ReadOutcome {
  const p = runReadOnly(dbUrl!, probe);
  if (!p.ok) return { ok: false, error: p.error };
  return p.stdout === "t" ? read(sql) : { ok: false, absent };
}

const corpusRead = readTraceCorpus(dbUrl, window);
const input = {
  window,
  stop: read(ECOSYSTEM_STOP_SQL),
  corpus: corpusRead.ok ? { ok: true as const, rows: corpusRead.corpus.rankEvents } : { ok: false as const, error: corpusRead.error },
  repeats: read(ECOSYSTEM_REPEATS_SQL),
  spam: read(ECOSYSTEM_SPAM_SQL),
  trails: readIfPresent(ECOSYSTEM_TRAILS_PRESENT_SQL, ECOSYSTEM_TRAILS_SQL, "2910 unapplied: no trails / trail_health_snapshots"),
  pages: readIfPresent(ECOSYSTEM_PAGES_PRESENT_SQL, ECOSYSTEM_PAGES_SQL, "3376 unapplied: no recommendations"),
};
const report = buildEcosystemReport(input);

if (argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Discovery ecosystem monitors — ${resolved.description} — read-only`);
  console.log(renderEcosystemReport(report));
}
const anyRead = [input.stop, input.repeats, input.spam, input.trails, input.pages].some((o) => o.ok) || input.corpus.ok;
if (!anyRead) {
  console.error("report:discovery-ecosystem: every read failed — nothing above is a measurement.");
  process.exit(1);
}
