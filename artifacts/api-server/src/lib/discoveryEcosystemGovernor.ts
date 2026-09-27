/**
 * discoveryEcosystemGovernor — the MONITOR half of `06` §8's Ecosystem Governor
 * (census-discovery DV-80, §58). Measurement only.
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/06_Recommendation_Engine.md` §8:
 *
 *   "Monitors: concentration, new-creator success, stale content, repeated
 *    recommendations, spam rate, Trail freshness, hidden-gem exposure.
 *    Governor adjusts policy bounds, not individual user outcomes directly."
 *
 * and `12` Phase 13: "Monitor: creator concentration, new creator opportunity,
 * Trail staleness, duplicate saturation, spam, repeat recommendations."
 *
 * WHAT THIS IS
 * ============
 * A PURE report over what the database already holds, in `06` §8's order, with
 * `12`'s one extra monitor (duplicate saturation) after it. Each monitor is
 * either measured — with its value, its sample and its denominator named — or
 * says why it is not:
 *
 *   unmeasured          no input exists in the tree; never 0
 *   input_absent        the input's table is not applied on this database
 *   unreadable          the read failed; never 0 and never "clear"
 *   insufficient_sample the denominator is 0; there is nothing to divide
 *
 * WHAT THIS IS NOT
 * ================
 * The ADJUST half. `06` §8's governor "adjusts policy bounds". That is new
 * ranking machinery under the 2026-08-15 hold (docs/discovery/ROADMAP.md item
 * 4) and is not built: nothing here reads a flag, writes a row, or returns a
 * bound. No threshold, no "healthy"/"unhealthy" verdict: `06` names what to
 * monitor and no number to monitor it against, and the owner has ruled none.
 *
 * REUSED, NOT RE-MEASURED
 * =======================
 *   concentration       lib/discoveryStopMeasurements.parseStopMeasurements
 *                       over 3391's discovery_stop_measurements() — P9's HHI of
 *                       Discovery exposures across creators, coverage attached.
 *   hidden-gem exposure lib/discoveryTraceCoverage's exposure definition and
 *                       servePointOf over P6's read (lib/discoveryTraceRead),
 *                       counting DiscoveryServePoint.HIDDEN_GEMS.
 * The other reads are aggregate SQL below. None selects a user id out of the
 * database; the repeat count groups by it inside the query and returns counts.
 */
import { parseStopMeasurements } from "./discoveryStopMeasurements.js";
import { featuresOf, servePointOf, traceRowKind, type TraceRankEventRow } from "./discoveryTraceCoverage.js";
import { DiscoveryServePoint } from "./discoveryServeLog.js";

// ═════════════════════════════════════════════════════════════════════════════
// The monitors, in the specification's order
// ═════════════════════════════════════════════════════════════════════════════

export interface MonitorDef {
  id: string;
  /** `06` §8's word for it, or null when only `12` Phase 13 names it. */
  spec06: string | null;
  /** `12` Phase 13's word for it, or null when only `06` §8 names it. */
  phase13: string | null;
  /** When nothing in the tree can supply it: what is missing. */
  missingInput?: string;
}

export const ECOSYSTEM_MONITORS: readonly MonitorDef[] = [
  { id: "concentration", spec06: "concentration", phase13: "creator concentration" },
  {
    id: "new_creator_success", spec06: "new-creator success", phase13: "new creator opportunity",
    missingInput:
      "neither `06` nor `12` defines 'new' (new to the platform, to the viewer, to the place) or 'success' " +
      "(which outcome); only a `db/` community place resolves to a creator (discovery_places.submitted_by, " +
      "the join 3391 does), an OSM place has none; and lib/discoveryTrailHealth's new_creator_exposure is a " +
      "Trail MEMBERSHIP share, not an outcome of anything served (census §51)",
  },
  {
    id: "stale_content", spec06: "stale content", phase13: null,
    missingInput:
      "no staleness rule exists for a served Discovery item: the only one in the tree is Trail health's " +
      "TRAIL_STALE_WINDOW_MS over Trail MEMBERS (reported under trail_freshness), and a place carries no content " +
      "age a rule could read — discovery_places.created_at is when it was submitted, not when it stopped being true",
  },
  { id: "repeated_recommendations", spec06: "repeated recommendations", phase13: "repeat recommendations" },
  { id: "spam_rate", spec06: "spam rate", phase13: "spam" },
  { id: "trail_freshness", spec06: "Trail freshness", phase13: "Trail staleness" },
  { id: "hidden_gem_exposure", spec06: "hidden-gem exposure", phase13: null },
  { id: "duplicate_saturation", spec06: null, phase13: "duplicate saturation" },
];

export type MonitorReading =
  | { state: "measured"; value: number; sample: number; detail: Record<string, unknown> }
  | { state: "insufficient_sample"; sample: 0; detail: Record<string, unknown> }
  | { state: "unreadable"; reason: string }
  | { state: "input_absent"; reason: string }
  | { state: "unmeasured"; missingInput: string };

/** One read the script made: its JSON, or why there is none. */
export type ReadOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string }
  | { ok: false; absent: string };

export interface EcosystemInputs {
  window: { since: string; until: string };
  /** 3391's body. */
  stop: ReadOutcome;
  /** P6's trace corpus rows (only exposures are counted). */
  corpus: { ok: true; rows: readonly TraceRankEventRow[] } | { ok: false; error: string };
  repeats: ReadOutcome;
  spam: ReadOutcome;
  trails: ReadOutcome;
  pages: ReadOutcome;
}

export interface EcosystemReport {
  window: { since: string; until: string };
  monitors: Array<{ id: string; spec06: string | null; phase13: string | null; reading: MonitorReading }>;
  adjust: "not built — the governor's policy-bound half is held (census-discovery §58); this report changes nothing";
  verdict: "none — values and samples only; no threshold is ruled";
}

// ═════════════════════════════════════════════════════════════════════════════
// The reads — aggregate, read-only, every one run inside READ ONLY by the script
// psql variables: :'since' and :'until' (ISO). The window is [since, until].
// ═════════════════════════════════════════════════════════════════════════════

/** P9's producer, called as-is. It requires until > since. */
export const ECOSYSTEM_STOP_SQL = `SELECT public.discovery_stop_measurements(:'since'::timestamptz, :'until'::timestamptz)::text;`;

/**
 * Repeated recommendations: Discovery exposures to the same viewer of the same
 * item in the window. `db/<uuid>` and the bare uuid are one community place
 * (census §51.2), so the id is folded before grouping.
 */
export const ECOSYSTEM_REPEATS_SQL = `
WITH win AS (SELECT :'since'::timestamptz AS since, :'until'::timestamptz AS until),
ex AS (
  SELECT r.user_id, regexp_replace(r.item_id, '^db/', '') AS item
    FROM public.rank_events r CROSS JOIN win
   WHERE r.surface = 'discovery' AND r.event_type IS NULL AND r.outcome <> 'analytics'
     AND r.served_at >= win.since AND r.served_at <= win.until
), per AS (
  SELECT user_id, item, count(*) AS n FROM ex GROUP BY user_id, item
)
SELECT json_build_object(
  'exposures',         COALESCE((SELECT sum(n) FROM per), 0),
  'viewer_item_pairs', (SELECT count(*) FROM per),
  'repeated_pairs',    (SELECT count(*) FROM per WHERE n > 1),
  'viewers',           (SELECT count(DISTINCT user_id) FROM per),
  'max_per_pair',      COALESCE((SELECT max(n) FROM per), 0)
)::text;
`;

/**
 * Spam: REPORTED spam on the community places Discovery served. The report
 * route (routes/discovery.ts PLACE_REPORT_REASONS) takes a discovery_places
 * uuid and a reason, of which 'spam' is one.
 */
export const ECOSYSTEM_SPAM_SQL = `
WITH win AS (SELECT :'since'::timestamptz AS since, :'until'::timestamptz AS until),
served AS (
  SELECT DISTINCT dp.id
    FROM public.rank_events r CROSS JOIN win
    JOIN public.discovery_places dp ON dp.id::text = lower(regexp_replace(r.item_id, '^db/', ''))
   WHERE r.surface = 'discovery' AND r.event_type IS NULL AND r.outcome <> 'analytics'
     AND r.served_at >= win.since AND r.served_at <= win.until
)
SELECT json_build_object(
  'served_community_places',     (SELECT count(*) FROM served),
  'served_places_spam_reported', (SELECT count(*) FROM served s
                                    WHERE EXISTS (SELECT 1 FROM public.discovery_place_reports p CROSS JOIN win
                                                   WHERE p.place_id = s.id AND p.reason = 'spam' AND p.created_at <= win.until)),
  'spam_reports_in_window',      (SELECT count(*) FROM public.discovery_place_reports p CROSS JOIN win
                                    WHERE p.reason = 'spam' AND p.created_at >= win.since AND p.created_at <= win.until),
  'reports_in_window',           (SELECT count(*) FROM public.discovery_place_reports p CROSS JOIN win
                                    WHERE p.created_at >= win.since AND p.created_at <= win.until)
)::text;
`;

/** Do 2910's Trail tables exist here? One row: t or f. */
export const ECOSYSTEM_TRAILS_PRESENT_SQL =
  `SELECT to_regclass('public.trails') IS NOT NULL AND to_regclass('public.trail_health_snapshots') IS NOT NULL;`;

/** Trail freshness: each live Trail's newest health snapshot at or before `until`. */
export const ECOSYSTEM_TRAILS_SQL = `
WITH win AS (SELECT :'until'::timestamptz AS until),
live AS (
  SELECT t.id FROM public.trails t CROSS JOIN win
   WHERE t.lifecycle_status <> 'archived' AND t.created_at <= win.until
), latest AS (
  SELECT DISTINCT ON (s.trail_id) s.trail_id, s.metrics, s.captured_at
    FROM public.trail_health_snapshots s JOIN live l ON l.id = s.trail_id CROSS JOIN win
   WHERE s.captured_at <= win.until
   ORDER BY s.trail_id, s.captured_at DESC
)
SELECT json_build_object(
  'trails',        (SELECT count(*) FROM live),
  'with_snapshot', (SELECT count(*) FROM latest),
  'snapshots',     COALESCE((SELECT json_agg(json_build_object(
                     'captured_at',        captured_at,
                     'content_freshness',  metrics->'content_freshness',
                     'stale_object_ratio', metrics->'stale_object_ratio',
                     'duplicate_density',  metrics->'duplicate_density') ORDER BY trail_id) FROM latest), '[]'::json)
)::text;
`;

/** Does 3376's per-request table exist here? One row: t or f. */
export const ECOSYSTEM_PAGES_PRESENT_SQL = `SELECT to_regclass('public.recommendations') IS NOT NULL;`;

/** Duplicate saturation on Discovery pages: one place under two ids on one served page. */
export const ECOSYSTEM_PAGES_SQL = `
WITH win AS (SELECT :'since'::timestamptz AS since, :'until'::timestamptz AS until),
pages AS (
  SELECT cardinality(q.item_ids) AS n,
         (SELECT count(DISTINCT regexp_replace(x, '^db/', '')) FROM unnest(q.item_ids) AS x) AS distinct_n
    FROM public.recommendations q CROSS JOIN win
   WHERE q.served_at >= win.since AND q.served_at <= win.until AND q.served_count > 0
)
SELECT json_build_object(
  'pages',                 (SELECT count(*) FROM pages),
  'pages_with_duplicates', (SELECT count(*) FROM pages WHERE distinct_n < n),
  'served_items',          COALESCE((SELECT sum(n) FROM pages), 0),
  'duplicate_items',       COALESCE((SELECT sum(n - distinct_n) FROM pages), 0)
)::text;
`;

/** Every read above, for the suite's no-write assertion. */
export const ECOSYSTEM_READS: readonly string[] = [
  ECOSYSTEM_STOP_SQL, ECOSYSTEM_REPEATS_SQL, ECOSYSTEM_SPAM_SQL, ECOSYSTEM_TRAILS_PRESENT_SQL,
  ECOSYSTEM_TRAILS_SQL, ECOSYSTEM_PAGES_PRESENT_SQL, ECOSYSTEM_PAGES_SQL,
];

// ═════════════════════════════════════════════════════════════════════════════
// Parsing — every figure checked, nothing defaulted
// ═════════════════════════════════════════════════════════════════════════════

function count(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && Math.floor(n) === n ? n : null;
}

function body(o: ReadOutcome): Record<string, unknown> | null {
  if (!o.ok) return null;
  const v = typeof o.value === "string" ? safeJson(o.value) : o.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function failed(o: ReadOutcome): MonitorReading | null {
  if (o.ok) return null;
  if ("absent" in o) return { state: "input_absent", reason: o.absent };
  return { state: "unreadable", reason: o.error };
}

const MALFORMED: MonitorReading = { state: "unreadable", reason: "malformed_response" };

/** A share, or insufficient_sample when there is nothing to divide. */
function share(num: number, den: number, detail: Record<string, unknown>): MonitorReading {
  if (den === 0) return { state: "insufficient_sample", sample: 0, detail };
  return { state: "measured", value: num / den, sample: den, detail };
}

export function readConcentration(o: ReadOutcome, atMs: number): MonitorReading {
  const f = failed(o);
  if (f) return f;
  const cc = parseStopMeasurements(body(o), atMs).creator_concentration;
  if (cc.state === "measured") {
    const detail = (cc.detail ?? {}) as Record<string, unknown>;
    // Nothing resolved to a creator is NOT concentration 0: there is no distribution.
    if (cc.value === null) return { state: "insufficient_sample", sample: 0, detail };
    return { state: "measured", value: cc.value, sample: cc.sample, detail: { measure: "Herfindahl index over creators of served db/ places", ...detail } };
  }
  const reason = (cc.detail as Record<string, unknown> | undefined)?.["reason"];
  return { state: "unreadable", reason: typeof reason === "string" ? reason : cc.state };
}

export function readRepeats(o: ReadOutcome): MonitorReading {
  const f = failed(o);
  if (f) return f;
  const b = body(o);
  const exposures = count(b?.["exposures"]), pairs = count(b?.["viewer_item_pairs"]);
  const repeated = count(b?.["repeated_pairs"]), viewers = count(b?.["viewers"]), max = count(b?.["max_per_pair"]);
  if (exposures === null || pairs === null || repeated === null || viewers === null || max === null || pairs > exposures) return MALFORMED;
  // The value is the share of exposures that re-served an item the same viewer
  // had already been served in the window.
  return share(exposures - pairs, exposures, {
    measure: "exposures that repeat an earlier (viewer, item) exposure in the window, per exposure",
    exposures, viewerItemPairs: pairs, repeatedPairs: repeated, viewers, maxServesOfOneItemToOneViewer: max,
  });
}

export function readSpam(o: ReadOutcome): MonitorReading {
  const f = failed(o);
  if (f) return f;
  const b = body(o);
  const served = count(b?.["served_community_places"]), flagged = count(b?.["served_places_spam_reported"]);
  const spamReports = count(b?.["spam_reports_in_window"]), reports = count(b?.["reports_in_window"]);
  if (served === null || flagged === null || spamReports === null || reports === null || flagged > served || spamReports > reports) return MALFORMED;
  return share(flagged, served, {
    measure: "served community places carrying a 'spam' report by the end of the window, per served community place",
    servedCommunityPlaces: served, servedPlacesSpamReported: flagged,
    spamReportsInWindow: spamReports, reportsInWindow: reports,
    limit: "REPORTED spam only: no spam classifier exists on Discovery, and an OSM place cannot be reported (the route takes a discovery_places uuid)",
  });
}

interface TrailStat { n: number; mean: number | null; min: number | null; max: number | null; unmeasured: number }

function statOf(values: unknown[]): TrailStat {
  const xs: number[] = [];
  let unmeasured = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) xs.push(v); else unmeasured += 1;
  }
  if (xs.length === 0) return { n: 0, mean: null, min: null, max: null, unmeasured };
  return { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs), unmeasured };
}

function trailSnapshots(o: ReadOutcome): { trails: number; withSnapshot: number; snaps: Array<Record<string, unknown>> } | null {
  const b = body(o);
  const trails = count(b?.["trails"]), withSnapshot = count(b?.["with_snapshot"]);
  const snaps = b?.["snapshots"];
  if (trails === null || withSnapshot === null || !Array.isArray(snaps) || snaps.length !== withSnapshot || withSnapshot > trails) return null;
  return { trails, withSnapshot, snaps: snaps.filter((s): s is Record<string, unknown> => !!s && typeof s === "object") };
}

export function readTrailFreshness(o: ReadOutcome, untilMs: number): MonitorReading {
  const f = failed(o);
  if (f) return f;
  const t = trailSnapshots(o);
  if (!t) return MALFORMED;
  const fresh = statOf(t.snaps.map((s) => s["content_freshness"]));
  const stale = statOf(t.snaps.map((s) => s["stale_object_ratio"]));
  const ages = t.snaps.map((s) => untilMs - Date.parse(String(s["captured_at"]))).filter((a) => Number.isFinite(a) && a >= 0);
  const detail = {
    measure: "mean content_freshness (02 §11) over each live Trail's newest health snapshot",
    trails: t.trails, trailsWithSnapshot: t.withSnapshot, trailsWithoutSnapshot: t.trails - t.withSnapshot,
    contentFreshness: fresh, staleObjectRatio: stale,
    snapshotAgeMs: ages.length ? { newest: Math.min(...ages), oldest: Math.max(...ages) } : null,
  };
  if (fresh.n === 0 || fresh.mean === null) return { state: "insufficient_sample", sample: 0, detail };
  return { state: "measured", value: fresh.mean, sample: fresh.n, detail };
}

export function readHiddenGemExposure(corpus: EcosystemInputs["corpus"]): MonitorReading {
  if (!corpus.ok) return { state: "unreadable", reason: corpus.error };
  let exposures = 0, gems = 0;
  for (const row of corpus.rows) {
    if (traceRowKind(row) !== "exposure") continue;
    exposures += 1;
    if (servePointOf(featuresOf(row)) === DiscoveryServePoint.HIDDEN_GEMS) gems += 1;
  }
  return share(gems, exposures, {
    measure: "Discovery exposures served by the hidden-gems surface (serve point HIDDEN_GEMS), per Discovery exposure",
    exposures, hiddenGemExposures: gems,
    limit: "exposure OF hidden-gem-qualifying items on other surfaces is not measured: no served row carries an item-level hidden-gem label",
  });
}

export function readDuplicateSaturation(pages: ReadOutcome, trails: ReadOutcome): MonitorReading {
  const f = failed(pages);
  if (f) return f;
  const b = body(pages);
  const n = count(b?.["pages"]), dupPages = count(b?.["pages_with_duplicates"]);
  const items = count(b?.["served_items"]), dupItems = count(b?.["duplicate_items"]);
  if (n === null || dupPages === null || items === null || dupItems === null || dupPages > n || dupItems > items) return MALFORMED;
  const t = trails.ok ? trailSnapshots(trails) : null;
  return share(dupItems, items, {
    measure: "served items that repeat a place already on the same served page (db/<uuid> and bare uuid folded), per served item",
    pages: n, pagesWithDuplicates: dupPages, servedItems: items, duplicateItems: dupItems,
    trailDuplicateDensity: t ? statOf(t.snaps.map((s) => s["duplicate_density"])) : null,
    limit: "a lower bound: only the same place under two ids is detectable; no near-duplicate detector exists",
  });
}

/** Build the report. Pure. */
export function buildEcosystemReport(input: EcosystemInputs): EcosystemReport {
  const untilMs = Date.parse(input.window.until);
  const readings: Record<string, MonitorReading> = {
    concentration: readConcentration(input.stop, untilMs),
    repeated_recommendations: readRepeats(input.repeats),
    spam_rate: readSpam(input.spam),
    trail_freshness: readTrailFreshness(input.trails, untilMs),
    hidden_gem_exposure: readHiddenGemExposure(input.corpus),
    duplicate_saturation: readDuplicateSaturation(input.pages, input.trails),
  };
  return {
    window: input.window,
    monitors: ECOSYSTEM_MONITORS.map((m) => ({
      id: m.id, spec06: m.spec06, phase13: m.phase13,
      reading: m.missingInput !== undefined
        ? { state: "unmeasured", missingInput: m.missingInput }
        : readings[m.id] ?? { state: "unreadable", reason: "no reader for this monitor" },
    })),
    adjust: "not built — the governor's policy-bound half is held (census-discovery §58); this report changes nothing",
    verdict: "none — values and samples only; no threshold is ruled",
  };
}

/** Plain text for the report script. */
export function renderEcosystemReport(r: EcosystemReport): string {
  const lines: string[] = [];
  lines.push(`window: ${r.window.since} .. ${r.window.until}`);
  lines.push(`verdict: ${r.verdict}`);
  lines.push(`adjust: ${r.adjust}`, "");
  for (const m of r.monitors) {
    const name = [m.spec06 ? `06 §8 "${m.spec06}"` : null, m.phase13 ? `12 Phase 13 "${m.phase13}"` : null].filter(Boolean).join(" / ");
    const x = m.reading;
    let text: string;
    switch (x.state) {
      case "measured": text = `${x.value.toFixed(4)} over a sample of ${x.sample}`; break;
      case "insufficient_sample": text = "insufficient sample (denominator 0) — not 0"; break;
      case "unreadable": text = `UNREADABLE (${x.reason}) — not 0, not clear`; break;
      case "input_absent": text = `INPUT ABSENT on this database (${x.reason}) — not 0`; break;
      case "unmeasured": text = `UNMEASURED — ${x.missingInput}`; break;
    }
    lines.push(`${m.id} [${name}]: ${text}`);
    if ((x.state === "measured" || x.state === "insufficient_sample") && x.detail) lines.push(`  ${JSON.stringify(x.detail)}`);
  }
  return lines.join("\n");
}
