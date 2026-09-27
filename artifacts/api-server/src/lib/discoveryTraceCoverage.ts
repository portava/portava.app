/**
 * discoveryTraceCoverage — the COVERAGE leg of DSV2-12 (census-discovery §55).
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/upgrades-v2/02-DISCOVERY-v2.md`, DSV2-12:
 *
 *   "Trace served recommendation→exposure→permitted outcome with versions and
 *    coverage; no synthetic production visits, conversions or Trust awards."
 *
 * §48 built the chain: an id on every served item, an exposure row per
 * signed-in served item, a per-request row per serve (3376), outcomes bound to
 * (caller, id), schema versions on every row. What no code did was COUNT it:
 * how much of what was served reached an exposure row, how much of what the
 * viewer did is attached to one, and under which versions. This module is that
 * count, as a PURE function over rows a caller read. It measures; it changes
 * nothing that is served, and nothing here ranks.
 *
 * WHAT A ROW IS, IN THIS REPORT
 * =============================
 *   exposure       `rank_events` row with `event_type IS NULL` — the serve
 *                  corpus (lib/discoveryServePointReport.ts's definition). Its
 *                  `outcome` is the furthest funnel rung reached, updated IN
 *                  PLACE by POST /rank-events/outcome, so a non-impression
 *                  outcome on an exposure row is bound to that exposure by
 *                  construction.
 *   outcome event  `outcome = 'analytics'` with an `event_type` the outcome
 *                  route writes (`OUTCOME_TO_ANALYTICS_EVENT`). Bound iff its
 *                  `recommendation_id` names an exposure read here.
 *   attention      `event_type = 'place_dwell'` (lib/discoveryDwell.ts). Bound
 *                  iff `features.recommendationId` names an exposure read here.
 *                  Counted by kind, never as an outcome and never as interest.
 *   other          every other row (the rankers' per-candidate analytics).
 *                  Not part of the trace; counted by event_type so nothing is
 *                  silently dropped.
 *
 * ABSENCE IS NOT ZERO
 * ===================
 * The served-item denominator lives in `public.recommendations` (3376). When the
 * caller could not read that table (unapplied, as in production today) every
 * figure that needs it is `null` with `observed: false`, never 0, and the
 * anonymous section says it was not observed. A denominator the exposures
 * themselves carry (`features.serveId` / `features.servedCount`) is reported
 * beside it, because it is observable without 3376 — but it can only see
 * requests that landed at least one exposure row, and says so.
 *
 * ANONYMOUS SERVES are counted apart: they have no `rank_events` row by design
 * (`rank_events.user_id` is NOT NULL; §48.3) and an anonymous id can never bind
 * an outcome, because the outcome route binds by (signed-in caller, id).
 */
import { ALL_SERVE_POINTS, SERVE_POINT_LABEL } from "./discoveryServePointReport.js";
import { SUPPORTED_EVENT_SCHEMA_VERSIONS } from "./discoveryRecommendationRecord.js";
import { DISCOVERY_MODEL_VERSION, DISCOVERY_PDE_MODEL_VERSION } from "./discoveryRankProvenance.js";
import { OUTCOME_TO_ANALYTICS_EVENT } from "../services/ranking/rankingAnalytics.js";
import { DISCOVERY_DWELL_EVENT_TYPE, DWELL_KINDS } from "./discoveryDwellVocabulary.js";

// ═════════════════════════════════════════════════════════════════════════════
// Row shapes, as read back (PostgREST or psql json_agg). Loose on purpose.
// ═════════════════════════════════════════════════════════════════════════════

/** One `rank_events` row. Every field optional: a reader must not trust shape. */
export interface TraceRankEventRow {
  id?:                unknown;
  user_id?:           unknown;
  item_id?:           unknown;
  item_kind?:         unknown;
  surface?:           unknown;
  outcome?:           unknown;
  event_type?:        unknown;
  recommendation_id?: unknown;
  schema_version?:    unknown;
  features?:          unknown;
  dwell_ms?:          unknown;
  dwell_kind?:        unknown;
  position?:          unknown;
  served_at?:         unknown;
}

/** One `public.recommendations` row (3376). */
export interface TraceServeRequestRow {
  id?:             unknown;
  user_id?:        unknown;
  viewer_class?:   unknown;
  surface?:        unknown;
  serve_point?:    unknown;
  served_count?:   unknown;
  item_ids?:       unknown;
  model_version?:  unknown;
  schema_version?: unknown;
  served_at?:      unknown;
}

// ═════════════════════════════════════════════════════════════════════════════
// Row reading — shared with lib/discoveryOutcomeReport.ts
// ═════════════════════════════════════════════════════════════════════════════

const RID = /^[A-Za-z0-9_-]{22}$/;

/** The event types the outcome route writes for an outcome (routes/rankEvents.ts). */
export const OUTCOME_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(OUTCOME_TO_ANALYTICS_EVENT).filter((v): v is NonNullable<typeof v> => typeof v === "string"),
);

/** Model versions this tree writes. Anything else on a row is UNKNOWN, and said. */
export const KNOWN_MODEL_VERSIONS: ReadonlySet<string> = new Set([DISCOVERY_MODEL_VERSION, DISCOVERY_PDE_MODEL_VERSION]);

export type TraceRowKind = "exposure" | "outcome_event" | "attention" | "other";

export function featuresOf(row: TraceRankEventRow): Record<string, unknown> {
  const f = row.features;
  return f && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : {};
}

export function traceRowKind(row: TraceRankEventRow): TraceRowKind {
  const et = row.event_type;
  if ((et === null || et === undefined) && row.outcome !== "analytics") return "exposure";
  if (et === DISCOVERY_DWELL_EVENT_TYPE) return "attention";
  if (row.outcome === "analytics" && typeof et === "string" && OUTCOME_EVENT_TYPES.has(et)) return "outcome_event";
  return "other";
}

/** An exposure's served id: 2891's column, then `features.recommendationId` (§13.3 rows). */
export function exposureIdsOf(row: TraceRankEventRow): string[] {
  const out: string[] = [];
  if (typeof row.recommendation_id === "string" && RID.test(row.recommendation_id)) out.push(row.recommendation_id);
  const f = featuresOf(row)["recommendationId"];
  if (typeof f === "string" && RID.test(f) && !out.includes(f)) out.push(f);
  return out;
}

export type ServePointKey = number | "unmarked" | "unrecognised";

/** The serve point a row names; "unmarked" and "unrecognised" are different findings. */
export function servePointOf(features: Record<string, unknown>): ServePointKey {
  const sp = features["servePoint"];
  if (sp === undefined || sp === null) return "unmarked";
  return typeof sp === "number" && ALL_SERVE_POINTS.includes(sp) ? sp : "unrecognised";
}

export function servePointLabel(sp: ServePointKey): string {
  if (sp === "unmarked") return "no servePoint marker";
  if (sp === "unrecognised") return "servePoint this build does not recognise";
  return SERVE_POINT_LABEL[sp] ?? `serve point ${sp}`;
}

/** Row schema version: the column (2890), then `features.schemaVersion`; else "unrecorded". */
export function schemaVersionOf(row: TraceRankEventRow): string {
  if (typeof row.schema_version === "number") return String(row.schema_version);
  const f = featuresOf(row)["schemaVersion"];
  return typeof f === "number" ? String(f) : "unrecorded";
}

/** Row model version: `features.modelVersion`; else "unrecorded". */
export function modelVersionOf(row: TraceRankEventRow): string {
  const m = featuresOf(row)["modelVersion"];
  return typeof m === "string" && m.length > 0 ? m : "unrecorded";
}

const bump = (m: Record<string, number>, k: string, by = 1) => { m[k] = (m[k] ?? 0) + by; };

/**
 * Is this per-request row an anonymous serve? `viewer_class` is authoritative
 * (3376's pairing CHECK ties it to `user_id IS NULL`); `user_id` decides only
 * for a row read without `viewer_class`.
 */
export function isAnonymousServeRequest(req: TraceServeRequestRow): boolean {
  if (req.viewer_class === "anonymous") return true;
  if (req.viewer_class === "signed_in") return false;
  return req.user_id === null || req.user_id === undefined;
}

// ═════════════════════════════════════════════════════════════════════════════
// The report
// ═════════════════════════════════════════════════════════════════════════════

/** A figure that needs the per-request table: null when that table was not read. */
export type Observed<T> = { observed: true; value: T } | { observed: false; value: null; reason: string };

export interface TraceGroup {
  surface: string;
  servePoint: ServePointKey;
  label: string;
  exposures: {
    total: number;
    /** Carries a served id (column or features) — traceable to its response. */
    withId: number;
    withoutId: number;
    /** Carries `features.serveId` — attributable to one request. */
    withServeId: number;
  };
  /** Signed-in served items, from `public.recommendations`. */
  servedItems: Observed<{
    requests: number;
    emptyRequests: number;
    items: number;
    withExposure: number;
    withoutExposure: number;
  }>;
  /** Exposure rows whose `serveId` names no request row read here. */
  exposuresWithoutRequestRow: Observed<number>;
  /**
   * The denominator the exposures carry themselves (DV-06). Observable without
   * 3376, but blind to any request that landed NO exposure row.
   */
  claimedByExposures: { requests: number; items: number; exposures: number };
  outcomes: {
    /** Terminal outcome on the exposure row (not 'impression'): bound by construction. */
    onExposure: Record<string, number>;
    /** Outcome analytics rows bound to an exposure in this group, by event_type. */
    boundEvents: Record<string, number>;
  };
  /** Attention rows bound to an exposure in this group, by kind. Not outcomes, not interest. */
  attention: Record<string, number>;
  versions: { schema: Record<string, number>; model: Record<string, number> };
}

export interface TraceSurface {
  surface: string;
  groups: TraceGroup[];
  unbound: {
    /** Outcome analytics rows carrying no served id at all. */
    outcomeEventsNoId: number;
    /** …carrying an id that names no exposure read here (it may predate the window). */
    outcomeEventsExposureNotRead: number;
    attentionNoId: number;
    attentionExposureNotRead: number;
  };
  /** Anonymous serves: counted apart, and never bindable by design. */
  anonymous: Observed<{
    requests: number;
    items: number;
    byServePoint: Record<string, { requests: number; items: number }>;
    bindable: "never";
  }>;
  /** Rows that are not part of the trace, by event_type. */
  notTraceRows: Record<string, number>;
}

export interface TraceCoverageReport {
  surfaces: TraceSurface[];
  serveRequestsObserved: boolean;
  versions: {
    exposureSchema: Record<string, number>;
    exposureModel: Record<string, number>;
    unknownSchemaVersions: string[];
    unknownModelVersions: string[];
    /** `public.recommendations.model_version` as written (see §55: constant per writer). */
    requestRowModel: Observed<Record<string, number>>;
    requestRowSchema: Observed<Record<string, number>>;
  };
}

const NOT_READ = "public.recommendations was not read (3376 absent, or not given): the signed-in served-item denominator and every anonymous serve are unobservable, not zero";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
}

function groupKey(surface: string, sp: ServePointKey): string {
  return `${surface}|${sp}`;
}

/**
 * Build the coverage report.
 *
 * `serveRequests` is `null` when the caller could not read `public.recommendations`
 * — the difference between "not observed" and "observed, none" is the whole
 * point, so an empty array means the latter.
 */
export function buildTraceCoverageReport(
  rankEvents: readonly TraceRankEventRow[],
  serveRequests: readonly TraceServeRequestRow[] | null,
): TraceCoverageReport {
  const observed = serveRequests !== null;
  const surfaces = new Map<string, TraceSurface>();
  const groups = new Map<string, TraceGroup>();
  const exposureById = new Map<string, { row: TraceRankEventRow; group: TraceGroup }>();
  const exposuresByServeId = new Map<string, Array<{ row: TraceRankEventRow; group: TraceGroup }>>();
  const claimed = new Map<string, Map<string, number>>();   // group → serveId → servedCount
  const versionSchema: Record<string, number> = {};
  const versionModel: Record<string, number> = {};

  const surfaceOf = (name: string): TraceSurface => {
    let s = surfaces.get(name);
    if (!s) {
      s = {
        surface: name,
        groups: [],
        unbound: { outcomeEventsNoId: 0, outcomeEventsExposureNotRead: 0, attentionNoId: 0, attentionExposureNotRead: 0 },
        anonymous: observed
          ? { observed: true, value: { requests: 0, items: 0, byServePoint: {}, bindable: "never" } }
          : { observed: false, value: null, reason: NOT_READ },
        notTraceRows: {},
      };
      surfaces.set(name, s);
    }
    return s;
  };
  const groupOf = (surface: string, sp: ServePointKey): TraceGroup => {
    const k = groupKey(surface, sp);
    let g = groups.get(k);
    if (!g) {
      g = {
        surface, servePoint: sp, label: servePointLabel(sp),
        exposures: { total: 0, withId: 0, withoutId: 0, withServeId: 0 },
        servedItems: observed
          ? { observed: true, value: { requests: 0, emptyRequests: 0, items: 0, withExposure: 0, withoutExposure: 0 } }
          : { observed: false, value: null, reason: NOT_READ },
        exposuresWithoutRequestRow: observed ? { observed: true, value: 0 } : { observed: false, value: null, reason: NOT_READ },
        claimedByExposures: { requests: 0, items: 0, exposures: 0 },
        outcomes: { onExposure: {}, boundEvents: {} },
        attention: {},
        versions: { schema: {}, model: {} },
      };
      groups.set(k, g);
      surfaceOf(surface).groups.push(g);
    }
    return g;
  };

  // ── Pass 1: exposures ─────────────────────────────────────────────────────
  for (const row of rankEvents) {
    if (traceRowKind(row) !== "exposure") continue;
    const surface = String(row.surface ?? "");
    const f = featuresOf(row);
    const g = groupOf(surface, servePointOf(f));
    g.exposures.total += 1;
    const ids = exposureIdsOf(row);
    if (ids.length > 0) g.exposures.withId += 1; else g.exposures.withoutId += 1;
    for (const id of ids) exposureById.set(id, { row, group: g });
    const serveId = typeof f["serveId"] === "string" ? (f["serveId"] as string) : null;
    if (serveId) {
      g.exposures.withServeId += 1;
      const list = exposuresByServeId.get(serveId) ?? [];
      list.push({ row, group: g });
      exposuresByServeId.set(serveId, list);
      const perGroup = claimed.get(groupKey(surface, g.servePoint)) ?? new Map<string, number>();
      const sc = num(f["servedCount"]);
      if (sc !== null) perGroup.set(serveId, Math.max(perGroup.get(serveId) ?? 0, sc));
      else if (!perGroup.has(serveId)) perGroup.set(serveId, 0);
      claimed.set(groupKey(surface, g.servePoint), perGroup);
      g.claimedByExposures.exposures += 1;
    }
    const outcome = String(row.outcome ?? "");
    if (outcome !== "impression") bump(g.outcomes.onExposure, outcome || "(none)");
    const sv = schemaVersionOf(row), mv = modelVersionOf(row);
    bump(g.versions.schema, sv); bump(g.versions.model, mv);
    bump(versionSchema, sv); bump(versionModel, mv);
  }
  for (const g of groups.values()) {
    const perGroup = claimed.get(groupKey(g.surface, g.servePoint));
    if (!perGroup) continue;
    g.claimedByExposures.requests = perGroup.size;
    g.claimedByExposures.items = [...perGroup.values()].reduce((a, b) => a + b, 0);
  }

  // ── Pass 2: outcome events, attention, other ──────────────────────────────
  for (const row of rankEvents) {
    const kind = traceRowKind(row);
    if (kind === "exposure") continue;
    const surface = String(row.surface ?? "");
    const s = surfaceOf(surface);
    if (kind === "other") { bump(s.notTraceRows, typeof row.event_type === "string" ? row.event_type : "(no event_type)"); continue; }
    if (kind === "outcome_event") {
      const rid = typeof row.recommendation_id === "string" && RID.test(row.recommendation_id) ? row.recommendation_id : null;
      if (!rid) { s.unbound.outcomeEventsNoId += 1; continue; }
      const hit = exposureById.get(rid);
      if (!hit) { s.unbound.outcomeEventsExposureNotRead += 1; continue; }
      bump(hit.group.outcomes.boundEvents, String(row.event_type));
      continue;
    }
    // attention
    const named = featuresOf(row)["recommendationId"];
    const rid = typeof named === "string" && RID.test(named) ? named : null;
    if (!rid) { s.unbound.attentionNoId += 1; continue; }
    const hit = exposureById.get(rid);
    if (!hit) { s.unbound.attentionExposureNotRead += 1; continue; }
    const dk = typeof row.dwell_kind === "string" && (DWELL_KINDS as readonly string[]).includes(row.dwell_kind) ? row.dwell_kind : "unclassified";
    bump(hit.group.attention, dk);
  }

  // ── Pass 3: the per-request rows (3376) ───────────────────────────────────
  const requestModel: Record<string, number> = {};
  const requestSchema: Record<string, number> = {};
  const requestIds = new Set<string>();
  if (serveRequests) {
    for (const req of serveRequests) {
      const surface = String(req.surface ?? "");
      const s = surfaceOf(surface);
      const spRaw = num(req.serve_point);
      const sp: ServePointKey = spRaw === null ? "unmarked" : ALL_SERVE_POINTS.includes(spRaw) ? spRaw : "unrecognised";
      const count = Math.max(0, num(req.served_count) ?? 0);
      bump(requestModel, typeof req.model_version === "string" ? req.model_version : "unrecorded");
      bump(requestSchema, num(req.schema_version) !== null ? String(num(req.schema_version)) : "unrecorded");
      if (isAnonymousServeRequest(req)) {
        if (s.anonymous.observed) {
          s.anonymous.value.requests += 1;
          s.anonymous.value.items += count;
          const slot = s.anonymous.value.byServePoint[String(sp)] ?? { requests: 0, items: 0 };
          slot.requests += 1; slot.items += count;
          s.anonymous.value.byServePoint[String(sp)] = slot;
        }
        continue;
      }
      const id = typeof req.id === "string" ? req.id : "";
      if (id) requestIds.add(id);
      const g = groupOf(surface, sp);
      if (!g.servedItems.observed) continue;
      const v = g.servedItems.value;
      v.requests += 1;
      if (count === 0) v.emptyRequests += 1;
      v.items += count;
      // A served item has an exposure iff a row of THIS request sits at its
      // served position with its id. Counted per position, so a duplicate row
      // cannot count twice and an exposure naming another item is not credit.
      const itemIds = Array.isArray(req.item_ids) ? (req.item_ids as unknown[]).map(String) : [];
      const rows = id ? exposuresByServeId.get(id) ?? [] : [];
      const covered = new Set<number>();
      for (const e of rows) {
        const p = num(e.row.position);
        if (p === null || p < 0 || p >= count) continue;
        if (itemIds.length === count && String(e.row.item_id ?? "") !== itemIds[p]) continue;
        covered.add(p);
      }
      v.withExposure += covered.size;
      v.withoutExposure += count - covered.size;
    }
    for (const [serveId, list] of exposuresByServeId) {
      if (requestIds.has(serveId)) continue;
      for (const e of list) {
        if (e.group.exposuresWithoutRequestRow.observed) e.group.exposuresWithoutRequestRow.value += 1;
      }
    }
  }

  const sortKey = (sp: ServePointKey) => (typeof sp === "number" ? sp : sp === "unmarked" ? 1000 : 1001);
  const out = [...surfaces.values()].sort((a, b) => a.surface.localeCompare(b.surface));
  for (const s of out) s.groups.sort((a, b) => sortKey(a.servePoint) - sortKey(b.servePoint));

  return {
    surfaces: out,
    serveRequestsObserved: observed,
    versions: {
      exposureSchema: versionSchema,
      exposureModel: versionModel,
      unknownSchemaVersions: Object.keys(versionSchema)
        .filter((v) => v !== "unrecorded" && !SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(Number(v))).sort(),
      unknownModelVersions: Object.keys(versionModel)
        .filter((v) => v !== "unrecorded" && !KNOWN_MODEL_VERSIONS.has(v)).sort(),
      requestRowModel: observed ? { observed: true, value: requestModel } : { observed: false, value: null, reason: NOT_READ },
      requestRowSchema: observed ? { observed: true, value: requestSchema } : { observed: false, value: null, reason: NOT_READ },
    },
  };
}

/** Plain-text rendering for the report script. Numbers and sample sizes only; no verdicts. */
export function renderTraceCoverageReport(r: TraceCoverageReport): string {
  const lines: string[] = [];
  const pct = (n: number, d: number) => (d === 0 ? "n/a (0 served)" : `${((n / d) * 100).toFixed(1)}%`);
  lines.push(`per-request rows (public.recommendations): ${r.serveRequestsObserved ? "read" : "NOT READ — denominators and anonymous serves unobservable"}`);
  if (r.surfaces.length === 0) {
    lines.push("NOTHING OBSERVED: no Discovery rank_events row and no per-request row in this window. That is an absence of evidence, not 0% coverage.");
  }
  for (const s of r.surfaces) {
    lines.push("", `── surface '${s.surface}' ──`);
    for (const g of s.groups) {
      lines.push(`  [${g.servePoint}] ${g.label}`);
      lines.push(`    exposures ${g.exposures.total} (with served id ${g.exposures.withId}, without ${g.exposures.withoutId}, with serveId ${g.exposures.withServeId})`);
      if (g.servedItems.observed) {
        const v = g.servedItems.value;
        lines.push(`    signed-in served items ${v.items} over ${v.requests} request(s) (${v.emptyRequests} empty): with exposure row ${v.withExposure} (${pct(v.withExposure, v.items)}), without ${v.withoutExposure}`);
      } else {
        lines.push(`    signed-in served items: unobserved (${g.servedItems.reason})`);
      }
      lines.push(`    exposure-claimed denominator: ${g.claimedByExposures.items} item(s) over ${g.claimedByExposures.requests} request(s) that landed >=1 row`);
      if (g.exposuresWithoutRequestRow.observed) lines.push(`    exposures naming no request row: ${g.exposuresWithoutRequestRow.value}`);
      lines.push(`    outcomes on exposure rows (bound by construction): ${JSON.stringify(g.outcomes.onExposure)}`);
      lines.push(`    outcome events bound to an exposure: ${JSON.stringify(g.outcomes.boundEvents)}`);
      lines.push(`    attention rows bound (by kind; never an outcome, never interest): ${JSON.stringify(g.attention)}`);
      lines.push(`    schema_version ${JSON.stringify(g.versions.schema)} · modelVersion ${JSON.stringify(g.versions.model)}`);
    }
    lines.push(`  unbound outcome events: no id ${s.unbound.outcomeEventsNoId}, exposure not read ${s.unbound.outcomeEventsExposureNotRead}`);
    lines.push(`  unbound attention rows: no id ${s.unbound.attentionNoId}, exposure not read ${s.unbound.attentionExposureNotRead}`);
    if (s.anonymous.observed) {
      lines.push(`  anonymous serves (never bindable, by design): ${s.anonymous.value.requests} request(s), ${s.anonymous.value.items} item(s) ${JSON.stringify(s.anonymous.value.byServePoint)}`);
    } else {
      lines.push(`  anonymous serves: unobserved (${s.anonymous.reason})`);
    }
    if (Object.keys(s.notTraceRows).length > 0) lines.push(`  rows outside the trace, by event_type: ${JSON.stringify(s.notTraceRows)}`);
  }
  lines.push("", `versions: exposure schema ${JSON.stringify(r.versions.exposureSchema)} · exposure model ${JSON.stringify(r.versions.exposureModel)}`);
  if (r.versions.unknownSchemaVersions.length > 0) lines.push(`  UNKNOWN schema_version on exposures: ${r.versions.unknownSchemaVersions.join(", ")}`);
  if (r.versions.unknownModelVersions.length > 0) lines.push(`  UNKNOWN modelVersion on exposures: ${r.versions.unknownModelVersions.join(", ")}`);
  if (r.versions.requestRowModel.observed) lines.push(`  request-row model_version ${JSON.stringify(r.versions.requestRowModel.value)} · schema_version ${JSON.stringify(r.versions.requestRowSchema.value)}`);
  return lines.join("\n");
}
