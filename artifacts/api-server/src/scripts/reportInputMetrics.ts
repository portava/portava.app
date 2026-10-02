/**
 * reportInputMetrics — §57's nine Product Success Metrics, read off the §44
 * serve log.
 *
 * ── WHY THIS IS A SCRIPT AND NOT A PARAGRAPH ─────────────────────────────────
 *
 * `census-input-intelligence.md` §57 says of all nine metrics: "None of the nine
 * is instrumented. There is no metric emitter, no analytics transport, and no
 * store any of these could be computed from." The emitter and the transport now
 * exist and the store is migration 2950. A metric definition that nothing can
 * RUN is still not a metric, so this is the reader: one command, the real table,
 * the same computation the tests assert to exact values.
 *
 * ── IT WILL REPORT NOTHING TODAY, AND IT SAYS SO ─────────────────────────────
 *
 * Migration 2950 is unapplied to production AND to portava-ci
 * (`checkProductionDrift.ts:615`). Against a database without the table this
 * exits with the PostgREST error rather than printing nine nulls that could be
 * mistaken for "we measured and found nothing". Against an applied-but-empty
 * table it prints `rows read: 0` above every metric, in those words.
 *
 * The distinction is the whole point. `docs/map/device-measurement-protocol.md`
 * keeps its ledger rows at NOT RUN because no physical handset exists in any
 * session; the equivalent here is that a harness is not a number, and this
 * script's output is the only thing that can turn §57 into numbers.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   node --import tsx/esm src/scripts/reportInputMetrics.ts
 *   node --import tsx/esm src/scripts/reportInputMetrics.ts --days 7 --json
 *   node --import tsx/esm src/scripts/reportInputMetrics.ts --context global_search
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the deployment to measure.
 * READ-ONLY: it issues SELECTs and nothing else.
 */
import { getServiceClient } from "../lib/supabase.js";
import { TELEMETRY_TABLE } from "../lib/inputAssistance/telemetry.js";
import {
  computeInputSuccessMetrics,
  type MetricRow,
  type Metric,
  type LatencyMetric,
} from "../lib/inputAssistance/metrics.js";

const PAGE = 1000;
/** Bound one run. A metrics report that OOMs is not a metrics report. */
const MAX_PAGES = 200;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmtMetric(label: string, m: Metric, asPercent: boolean): string {
  if (m.blocked) return `  ${label.padEnd(34)} NOT MEASURABLE — ${m.blocked}`;
  if (m.value === null) return `  ${label.padEnd(34)} no data (n=0)`;
  const v = asPercent ? `${(m.value * 100).toFixed(1)}%` : String(m.value);
  return `  ${label.padEnd(34)} ${v}  (n=${m.n})`;
}

function fmtLatency(label: string, m: LatencyMetric): string {
  if (m.blocked) return `  ${label.padEnd(34)} NOT MEASURABLE — ${m.blocked}`;
  if (m.p50 === null) return `  ${label.padEnd(34)} no data (n=0)`;
  return `  ${label.padEnd(34)} P50 ${m.p50} ms · P95 ${m.p95} ms  (n=${m.n})`;
}

async function main(): Promise<void> {
  const days = Number(arg("days") ?? 30);
  const context = arg("context");
  const json = process.argv.includes("--json");

  const db = getServiceClient();
  if (!db) {
    console.error(
      "reportInputMetrics: no service client. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY " +
        "for the deployment you want to measure.",
    );
    process.exit(1);
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows: MetricRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let q = db
      .from(TELEMETRY_TABLE)
      .select("session_id,event_name,context,field_id,occurred_at,props")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (context) q = q.eq("context", context);
    const { data, error } = await q;
    if (error) {
      // The state every deployment is in today: the table does not exist. Say
      // what happened rather than printing an empty report.
      console.error(
        `reportInputMetrics: cannot read ${TELEMETRY_TABLE} — ${error.message}\n` +
          "If this is 'relation does not exist', migration 2950 is not applied to this database. " +
          "No §57 metric can be reported until it is.",
      );
      process.exit(2);
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as MetricRow[]));
    if (data.length < PAGE) break;
  }

  const m = computeInputSuccessMetrics(rows, context ? { contexts: [context] } : {});

  if (json) {
    console.log(JSON.stringify({ since, days, context: context ?? null, metrics: m }, null, 2));
    return;
  }

  console.log(`\n§57 Product Success Metrics — ${TELEMETRY_TABLE}`);
  console.log(`  window: last ${days} day(s), since ${since}`);
  console.log(`  context: ${context ?? "(all)"}`);
  console.log(`  rows read: ${m.rowsRead}`);
  if (m.rowsRead === 0) {
    console.log(
      "\n  THE TABLE IS EMPTY FOR THIS WINDOW. Every number below is absent, not zero.\n",
    );
  }
  console.log("");
  console.log(fmtLatency("G365 time to valid selection", m.timeToValidSelectionMs));
  console.log(fmtMetric("G366 valid entity resolution rate", m.validEntityResolutionRate, true));
  console.log(fmtMetric("G367 manual fallback rate", m.manualFallbackRate, true));
  console.log(fmtMetric("G368 wrong-selection reversal", m.wrongSelectionReversalRate, true));
  console.log(fmtMetric("G369 duplicate creation prevented", m.duplicateCreationPrevented, false));
  console.log(fmtMetric("G370 downstream task completion", m.downstreamTaskCompletionRate, true));
  console.log(fmtMetric("G371 privacy incident count", m.privacyIncidents, false));
  console.log(fmtLatency("G372 suggest latency (server)", m.suggestLatencyServerMs));
  console.log(fmtLatency("G372 suggest latency (client)", m.suggestLatencyClientMs));
  console.log(fmtMetric("G373 offline completion rate", m.offlineCompletionRate, true));
  console.log("");
}

void main();
