/**
 * discoveryTraceRead — the READ-ONLY read behind report:discovery-trace-coverage
 * and report:discovery-outcomes (census-discovery §55).
 *
 * WHY psql AND A URL, NOT THE SERVICE CLIENT
 * ==========================================
 * These reports run against "a database they are given" — the local harness,
 * a rehearsal clone, or, by an operator, production. The URL is an explicit
 * argument; there is no default, so the reports can never reach a database
 * nobody named. And read-only is enforced by the DATABASE, not promised by the
 * code: every statement runs inside `BEGIN TRANSACTION READ ONLY` with
 * `default_transaction_read_only=on` in PGOPTIONS, so an INSERT/UPDATE/DELETE
 * or DDL would be refused by PostgreSQL ("cannot execute … in a read-only
 * transaction") and the transaction is rolled back regardless.
 *
 * WHAT IS READ
 * ============
 * `rank_events` on surface 'discovery':
 *   • every EXPOSURE (`event_type IS NULL`, not the analytics sentinel) served
 *     in the window;
 *   • every other row (outcome events, attention rows, ranking analytics)
 *     written in the window OR naming an exposure read above — so an outcome
 *     reported after the window closed is still attached to its exposure.
 * `public.recommendations` (3376) in the window, IF the table exists; `null`
 * otherwise, which the reports render as UNOBSERVED rather than zero.
 * No user id is selected from either table: nothing here needs to know who.
 */
import { spawnSync } from "node:child_process";
import type { TraceRankEventRow, TraceServeRequestRow } from "./discoveryTraceCoverage.js";

/** The `rank_events` read. psql variables: :'since' (ISO) and :'until' (ISO or ''). */
export const TRACE_RANK_EVENTS_SQL = `
WITH win AS (
  SELECT :'since'::timestamptz AS since, NULLIF(:'until', '')::timestamptz AS until
), exposures AS (
  SELECT r.id, r.item_id, r.item_kind, r.surface, r.outcome, r.event_type, r.recommendation_id,
         r.schema_version, r.features, r.dwell_ms, r.dwell_kind, r.position, r.served_at
    FROM public.rank_events r CROSS JOIN win
   WHERE r.surface = 'discovery' AND r.event_type IS NULL AND r.outcome <> 'analytics'
     AND r.served_at >= win.since AND (win.until IS NULL OR r.served_at <= win.until)
), exposure_ids AS (
  SELECT e.recommendation_id AS rid FROM exposures e WHERE e.recommendation_id IS NOT NULL
  UNION
  SELECT e.features->>'recommendationId' FROM exposures e WHERE e.features ? 'recommendationId'
), linked AS (
  SELECT r.id, r.item_id, r.item_kind, r.surface, r.outcome, r.event_type, r.recommendation_id,
         r.schema_version, r.features, r.dwell_ms, r.dwell_kind, r.position, r.served_at
    FROM public.rank_events r CROSS JOIN win
   WHERE r.surface = 'discovery' AND (r.event_type IS NOT NULL OR r.outcome = 'analytics')
     AND (   (r.served_at >= win.since AND (win.until IS NULL OR r.served_at <= win.until))
          OR r.recommendation_id IN (SELECT rid FROM exposure_ids)
          OR (r.features->>'recommendationId') IN (SELECT rid FROM exposure_ids))
)
SELECT COALESCE(json_agg(t ORDER BY t.served_at, t.id), '[]'::json)::text
  FROM (SELECT * FROM exposures UNION ALL SELECT * FROM linked) t;
`;

/** Does `public.recommendations` exist here? One row: t or f. */
export const TRACE_SERVE_REQUESTS_PRESENT_SQL = `SELECT to_regclass('public.recommendations') IS NOT NULL;`;

/** The `public.recommendations` read (run only when the table exists). */
export const TRACE_SERVE_REQUESTS_SQL = `
WITH win AS (
  SELECT :'since'::timestamptz AS since, NULLIF(:'until', '')::timestamptz AS until
)
SELECT COALESCE(json_agg(t ORDER BY t.served_at, t.id), '[]'::json)::text FROM (
  SELECT q.id, q.viewer_class, q.surface, q.serve_point, q.served_count, q.item_ids,
         q.model_version, q.schema_version, q.served_at
    FROM public.recommendations q CROSS JOIN win
   WHERE q.served_at >= win.since AND (win.until IS NULL OR q.served_at <= win.until)
) t;
`;

/** Statement keywords none of the reads above may contain (asserted by the suite). */
export const WRITE_KEYWORDS = /\b(insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|comment|vacuum|copy|call|do)\b/i;

export type ReadOnlyResult = { ok: true; stdout: string } | { ok: false; error: string };

/**
 * Run ONE script read-only against `dbUrl`: wrapped in a READ ONLY transaction
 * that is always rolled back, with the session defaulting to read-only too.
 */
export function runReadOnly(dbUrl: string, sql: string, vars: Record<string, string> = {}): ReadOnlyResult {
  if (!dbUrl) return { ok: false, error: "no database URL was given" };
  const args = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  args.push(dbUrl);
  const r = spawnSync("psql", args, {
    input: `BEGIN TRANSACTION READ ONLY;\n${sql}\nROLLBACK;\n`,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PGOPTIONS: `${process.env["PGOPTIONS"] ?? ""} -c default_transaction_read_only=on`.trim() },
  });
  if (r.error) return { ok: false, error: String(r.error.message ?? r.error) };
  if ((r.status ?? 1) !== 0) return { ok: false, error: (r.stderr ?? "").trim() || `psql exited ${r.status}` };
  return { ok: true, stdout: (r.stdout ?? "").trim() };
}

export interface TraceCorpus {
  rankEvents: TraceRankEventRow[];
  /**
   * null ⇔ `public.recommendations` does not exist on this database, OR (§120) the
   * window reaches before 3501's retention horizon, when `serveRequestsUnobserved`
   * says so. Either way the per-request figures are UNOBSERVED, never short.
   */
  serveRequests: TraceServeRequestRow[] | null;
  /** Why `serveRequests` is null although the table exists; null otherwise. */
  serveRequestsUnobserved?: string | null;
}

/** Read the corpus for a window. Never writes; returns an error rather than a partial corpus. */
export function readTraceCorpus(
  dbUrl: string,
  window: { since: string; until: string | null },
): { ok: true; corpus: TraceCorpus } | { ok: false; error: string } {
  const vars = { since: window.since, until: window.until ?? "" };
  const ev = runReadOnly(dbUrl, TRACE_RANK_EVENTS_SQL, vars);
  if (!ev.ok) return { ok: false, error: `rank_events read failed: ${ev.error}` };
  const present = runReadOnly(dbUrl, TRACE_SERVE_REQUESTS_PRESENT_SQL);
  if (!present.ok) return { ok: false, error: `recommendations probe failed: ${present.error}` };
  let serveRequests: TraceServeRequestRow[] | null = null;
  let serveRequestsUnobserved: string | null = null;
  if (present.stdout === "t") {
    const horizon = retentionHorizonBreach(dbUrl, vars);
    if (!horizon.ok) return { ok: false, error: horizon.error };
    if (horizon.breach) {
      serveRequestsUnobserved =
        `the window starts before the per-request retention horizon (${horizon.horizon}; 3501, the owner's 30-day TESTING retention) — ` +
        "request rows older than it may have been purged, so request counts, empty serves, anonymous serves and exposures naming no request row are unobservable for this window";
    } else {
      const rq = runReadOnly(dbUrl, TRACE_SERVE_REQUESTS_SQL, vars);
      if (!rq.ok) return { ok: false, error: `recommendations read failed: ${rq.error}` };
      serveRequests = JSON.parse(rq.stdout || "[]") as TraceServeRequestRow[];
    }
  }
  return { ok: true, corpus: { rankEvents: JSON.parse(ev.stdout || "[]") as TraceRankEventRow[], serveRequests, serveRequestsUnobserved } };
}

/** §120: does this window reach before 3501's retention horizon? No 3501 here ⇒ no horizon. */
function retentionHorizonBreach(
  dbUrl: string,
  vars: Record<string, string>,
): { ok: true; breach: boolean; horizon: string } | { ok: false; error: string } {
  const present = runReadOnly(dbUrl, TRACE_RETENTION_PRESENT_SQL);
  if (!present.ok) return { ok: false, error: `retention horizon probe failed: ${present.error}` };
  if (present.stdout !== "t") return { ok: true, breach: false, horizon: "" };
  const r = runReadOnly(dbUrl, TRACE_RETENTION_SQL, vars);
  if (!r.ok) return { ok: false, error: `retention horizon read failed: ${r.error}` };
  const [breach, horizon] = r.stdout.split("|");
  if (breach !== "true" && breach !== "false") return { ok: false, error: `retention horizon read answered ${JSON.stringify(r.stdout)}` };
  return { ok: true, breach: breach === "true", horizon: horizon ?? "" };
}

/** `--db-url <url>`, else REPORT_DB_URL. Never a default. */
export function dbUrlFrom(argv: readonly string[], env: Record<string, string | undefined>): string | null {
  const i = argv.indexOf("--db-url");
  if (i >= 0) {
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : null;
  }
  const e = (env["REPORT_DB_URL"] ?? "").trim();
  return e === "" ? null : e;
}

/**
 * census-discovery §120 — 3501's retention horizon. `public.recommendations` rows
 * whose created_at is before it may have been PURGED (the owner's 30-day testing
 * retention), so a window reaching before it cannot be read as a complete
 * per-request record: its request counts would be short and every exposure whose
 * request row was purged would read as "naming no request row" — a defect the
 * data does not have. Probed first because a database without 3501 has no
 * horizon and keeps every row.
 */
export const TRACE_RETENTION_PRESENT_SQL = `SELECT to_regprocedure('public.discovery_recommendations_retention_cutoff()') IS NOT NULL;`;

/** One row `t|<horizon>` when the window starts before the horizon, `f|<horizon or ''>` otherwise. */
export const TRACE_RETENTION_SQL = `
SELECT (h IS NOT NULL AND h > :'since'::timestamptz)::text || '|' || COALESCE(h::text, '')
  FROM (SELECT public.discovery_recommendations_retention_cutoff() AS h) x;
`;
