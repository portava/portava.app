/**
 * discoveryTrendExplanation — `11` §4's "trend explanation", read-only, over
 * the trend state that is ALREADY computed and stored (census-discovery §58:
 * DC-21, DV-33).
 *
 * WHAT IT SERVES, AND WHAT IT NEVER SERVES
 * ========================================
 * For each item a signed-in viewer was SERVED on Discovery, named by the
 * exposure's own `recommendationId`: the `03` §9 state and its reason — a code
 * from lib/discoveryTrendState's closed vocabulary and its fixed sentence — as
 * stored in `place_momentum` by `rebuild_place_momentum` (2892, corpus repaired
 * by 3410). `11` §4: "Never return internal raw scores". No rate, no weight, no
 * traveller count, no total leaves this module; the shape is closed and the
 * route suite pins it.
 *
 * WHY IT IS KEYED BY THE VIEWER'S OWN EXPOSURE, NOT BY A PLACE ID
 * ===============================================================
 * A state is a property of a place, but a place id is something anyone can
 * type. Keyed by place id, this would be an oracle for the activity at any
 * place, including one the viewer was never shown and one a protected-zone
 * pass withheld from them. Keyed by the exposure token, it answers only for
 * items this viewer was actually served on Discovery, where every serve-time
 * gate has already run. Another viewer's token binds nothing and reads exactly
 * like a token that does not exist (`unknown_recommendation`) — the existence
 * of someone else's exposure is not disclosed.
 *
 * THE DISCLOSURE FLOOR — AND WHY IT IS NOT A NEW NUMBER
 * =====================================================
 * `emerging` needs only TREND_MIN_RATE (3) of weighted activity: one person's
 * single save (3) plus its impression (1) makes a quiet place "emerging". A
 * published state built from one person's behaviour tells every other viewer
 * what that person did. So a state is disclosed only when BOTH windows it was
 * computed over carry at least PRIVACY_THRESHOLD_V1.minUniqueActors distinct
 * travellers — the k the live-claim path already enforces
 * (lib/liveClaimRead.ts, "the SAME one the live path enforces"), reused rather
 * than invented. Below it the item reads `insufficient_evidence`, exactly as a
 * place with no evidence does: suppression must not be distinguishable from
 * absence, or "withheld" itself discloses that someone was there. Whether a
 * trend state is an aggregate that PRIVACY_THRESHOLD_V1 governs is an owner
 * question (census §58); until it is answered the stricter reading applies.
 *
 * FRESHNESS — ALSO NOT A NEW NUMBER
 * =================================
 * The in-process trend reading is usable for MOMENTUM_CACHE_TTL_MS after it is
 * computed (lib/discoveryLocalMomentum.readLocalTrendStates returns `{}` after
 * that). A stored reading is held to the same bound: older, or dated in the
 * future, and the whole response is `stale_snapshot`. Nothing schedules the
 * rebuild (2892, 3410), so until an owner rules a cadence every response
 * degrades this way, with the reason stated.
 */
import { isMissingColumnError, isMissingSchemaError } from "./capability/schemaCapability.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import { meetsKAnonymity } from "./kAnonymity.js";
import { MOMENTUM_CACHE_TTL_MS } from "./discoveryLocalMomentum.js"; import { keysetBefore, keySortsBefore } from "./pagedRead.js";  // census-discovery §118 (SW22)
import { RECOMMENDATION_ID_SHAPE } from "./rankEventsProvenance.js";
import {
  isTrendState, trendReasonFor,
  type DiscoveryTrendState, type TrendReasonCode,
} from "./discoveryTrendState.js"; import { explainTrendReading, trendDriverCode, TREND_STATE_MODEL_VERSION_V2, applyPlaceTrendReviewsToRows, type TrendDriverCode } from "./discoveryTrendState.js"; import type { TrendDriver, TrendLifecycle } from "./discoveryTrendNormalised.js";  // §84 (W10-R1)

/** The route's gate, seeded FALSE by 3410. Read with isFlagEnabled: fail-closed. */
export const TREND_API_FLAG = "discovery_trending_api_enabled";

/** The corpus the product computes over (lib/discoveryLocalMomentum). Rows over any other are not read. */
export const TREND_SNAPSHOT_SURFACE = "discovery";

/** A stored reading is served no longer than the in-process reading lives. Reused, not ruled. */
export const TREND_SNAPSHOT_MAX_AGE_MS = MOMENTUM_CACHE_TTL_MS;

/** k for a published state: the live-claim path's own floor. Reused, not ruled. */
export const TREND_DISCLOSURE_MIN_TRAVELERS = PRIVACY_THRESHOLD_V1.minUniqueActors;

/**
 * Request bound: one GET /discovery page (routes/discovery.ts PAGE_SIZE = 20).
 * An input-size bound on a read, not a product number.
 */
export const TREND_EXPLANATIONS_MAX_IDS = 20;

/** Why an item carries no trend. Closed. */
export const TREND_UNAVAILABLE_REASONS = [
  /** The id names no Discovery exposure of THIS viewer — absent, or someone else's. */
  "unknown_recommendation",
  /** No snapshot over the product's corpus has ever been computed. */
  "no_snapshot",
  /** The newest snapshot is older than TREND_SNAPSHOT_MAX_AGE_MS, or dated in the future. */
  "stale_snapshot",
  /** Below the evidence floor, absent from the newest run, or below the disclosure floor — indistinguishable by design. */
  "insufficient_evidence",
] as const;
export type TrendUnavailableReason = (typeof TREND_UNAVAILABLE_REASONS)[number];

/** Why the whole request could not be answered. Closed; sent as a 503. */
export type TrendReadFailure = "exposure_read_failed" | "trend_store_absent" | "trend_read_failed";

export interface ExposureBinding {
  recommendationId: string;
  itemId: string;
}

export interface TrendRun {
  /** ISO instant the rebuild ran for (`place_momentum.computed_at`). */
  computedAt: string;
  modelVersion: string; /** §75 (DC-17, H-P21-1): `place_momentum.feature_version` (3435); null when the row predates 3435 or this database lacks the column — "not recorded", never a guess. */ featureVersion: string | null;
  /** The oldest window's length in ms, from the row's own `window_ms`; null if unreadable. */
  priorMs: number | null;
}

/** The columns the snapshot read selects. The travellers are READ, never SERVED. */
export interface TrendSnapshotRow {
  place_id: string;
  trend_state: string;
  recent_unique_travelers: number | null;
  window_unique_travelers: number | null; /** §84: present on a v2 run only (3476). */ driver?: string | null; lifecycle_state?: string | null; cell_key?: string | null;
}

export interface TrendExplanation {
  recommendationId: string;
  /** The served item this exposure named; null when the id bound nothing. */
  itemId: string | null;
  trend: { state: DiscoveryTrendState; reason: { code: TrendReasonCode; text: string; driver?: TrendDriverCode }; lifecycle?: TrendLifecycle } | null;  // §84: `driver` and `lifecycle` only from a v2 run
  unavailable: TrendUnavailableReason | null;
}

export interface TrendReadingProvenance {
  computedAt: string;
  window: { start: string; end: string } | null;
  modelVersion: string; /** §75 (DC-17, H-P21-1): the run's feature version; null = not recorded (a pre-3435 row, or a database without 3435). */ featureVersion: string | null;
}

export interface TrendExplanationResponse {
  explanations: TrendExplanation[];
  /** The one run every answer above was read from; null when no run exists. */
  readingProvenance: TrendReadingProvenance | null;
}

function travelersOk(v: unknown): boolean {
  return typeof v === "number" && meetsKAnonymity(v, TREND_DISCLOSURE_MIN_TRAVELERS);
}

/**
 * May this stored row's state be published? Only a real `03` §9 claim, over
 * enough distinct travellers in BOTH windows. A row written before 3410 has no
 * traveller counts and is never disclosed (fail-closed).
 */
export function mayDiscloseTrend(row: TrendSnapshotRow): boolean {
  if (!isTrendState(row.trend_state) || row.trend_state === "unknown") return false;
  return travelersOk(row.recent_unique_travelers) && travelersOk(row.window_unique_travelers);
}

/** Is the run current at `nowMs`? Future-dated runs are not current either. */
export function isCurrentRun(run: TrendRun, nowMs: number): boolean {
  const at = Date.parse(run.computedAt);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age <= TREND_SNAPSHOT_MAX_AGE_MS;
}

function provenanceOf(run: TrendRun): Omit<TrendReadingProvenance, "featureVersion"> {
  const end = Date.parse(run.computedAt);
  const window = Number.isFinite(end) && run.priorMs !== null && run.priorMs > 0
    ? { start: new Date(end - run.priorMs).toISOString(), end: new Date(end).toISOString() }
    : null;
  return { computedAt: run.computedAt, window, modelVersion: run.modelVersion };
}

/**
 * Pure: the response, from what the two reads returned. Deterministic in its
 * inputs — the same request over the same snapshot answers byte-identically,
 * which is what makes a retry safe to repeat.
 */
export function explainExposures(
  requestedIds: readonly string[],
  bindings: readonly ExposureBinding[],
  run: TrendRun | null,
  rows: readonly TrendSnapshotRow[],
  nowMs: number, areas: readonly TrendAreaRow[] = [],  // §84: the run's Local Pulse rows, for the neighbourhood k-floor
): TrendExplanationResponse {
  const itemByRid = new Map<string, string>();
  for (const b of bindings) if (!itemByRid.has(b.recommendationId)) itemByRid.set(b.recommendationId, b.itemId);
  const rowByPlace = new Map<string, TrendSnapshotRow>();
  for (const r of rows) if (typeof r?.place_id === "string") rowByPlace.set(r.place_id, r);
  const current = run !== null && isCurrentRun(run, nowMs);

  const explanations = requestedIds.map((rid): TrendExplanation => {
    const itemId = itemByRid.get(rid) ?? null;
    const none = (unavailable: TrendUnavailableReason): TrendExplanation =>
      ({ recommendationId: rid, itemId, trend: null, unavailable });
    if (itemId === null) return none("unknown_recommendation");
    if (run === null) return none("no_snapshot");
    if (!current) return none("stale_snapshot");
    const row = rowByPlace.get(itemId);
    if (!row || !mayDiscloseTrend(row)) return none("insufficient_evidence");
    const state = row.trend_state as DiscoveryTrendState;
    const reason = trendReasonFor(state);
    if (!reason) return none("insufficient_evidence");
    return { recommendationId: rid, itemId, trend: run.modelVersion === TREND_STATE_MODEL_VERSION_V2 ? v2Trend(row, state, reason, areas) : { state, reason }, unavailable: null };
  });

  return { explanations, readingProvenance: run ? { ...provenanceOf(run), featureVersion: run.featureVersion } : null };  // §75 H-P21-1: the feature version rides after the three §58 fields
}

/**
 * Parse `recommendationIds` (comma-separated). Order kept, duplicates dropped.
 * Null when absent, empty, malformed or over the bound: every id must have
 * 2891's shape, which also guarantees none can carry a PostgREST filter
 * delimiter into the `or` expression below.
 */
export function parseRecommendationIds(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!RECOMMENDATION_ID_SHAPE.test(id)) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out.length > 0 && out.length <= TREND_EXPLANATIONS_MAX_IDS ? out : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export type ExposureRead =
  | { ok: true; bindings: ExposureBinding[] }
  | { ok: false; reason: "exposure_read_failed" };

/**
 * The viewer's OWN Discovery exposures named by these ids. The id may sit in
 * the column (2891) or, on an older row, in `features.recommendationId` — the
 * same two places lib/discoveryDwell looks.
 */
export async function readViewerExposures(sc: any, viewerId: string, ids: readonly string[]): Promise<ExposureRead> {
  if (ids.length === 0) return { ok: true, bindings: [] };
  const list = ids.join(",");
  try {
    const { data, error } = await sc.from("rank_events").select("item_id, recommendation_id, features")
      .eq("user_id", viewerId)
      .eq("surface", "discovery")
      .or(`recommendation_id.in.(${list}),features->>recommendationId.in.(${list})`)
      .is("event_type", null)
      .neq("outcome", "analytics");
    if (error || !Array.isArray(data)) return { ok: false, reason: "exposure_read_failed" };
    const wanted = new Set(ids);
    const bindings: ExposureBinding[] = [];
    for (const r of data as Array<Record<string, unknown>>) {
      const itemId = typeof r?.["item_id"] === "string" ? (r["item_id"] as string) : null;
      if (!itemId) continue;
      const col = r["recommendation_id"];
      const feat = (r["features"] && typeof r["features"] === "object") ? (r["features"] as Record<string, unknown>)["recommendationId"] : undefined;
      for (const rid of [col, feat]) {
        if (typeof rid === "string" && wanted.has(rid)) bindings.push({ recommendationId: rid, itemId });
      }
    }
    return { ok: true, bindings };
  } catch {
    // resolves-not-throws-ok: a throw is reported as the same stated failure.
    return { ok: false, reason: "exposure_read_failed" };
  }
}

export type SnapshotRead =
  | { ok: true; run: TrendRun | null; rows: TrendSnapshotRow[]; areas?: TrendAreaRow[] }  // §84: `areas` on a v2 run only
  | { ok: false; reason: "trend_store_absent" | "trend_read_failed" };

function failureOf(error: unknown): { ok: false; reason: "trend_store_absent" | "trend_read_failed" } {
  // 2892 unapplied (no table) or 3410 unapplied (no source_surface column): the
  // store this reads does not exist here, which is a fact about the deployment,
  // not an unknown answer. Anything else is an unknown answer.
  return { ok: false, reason: isMissingSchemaError(error) ? "trend_store_absent" : "trend_read_failed" };
}

/**
 * The newest run over the product's corpus, and its rows for these items. Two
 * reads, both on 2892's indexes (QP-22). One run for the whole response, so
 * every answer in it describes the same instant.
 */
export async function readTrendSnapshot(sc: any, itemIds: readonly string[]): Promise<SnapshotRead> {
  try {
    let head = await sc.from("place_momentum").select("computed_at, model_version, window_ms, feature_version")
      .eq("source_surface", "discovery")
      .order("computed_at", { ascending: false })
      .limit(1);
    if (head?.error && isMissingColumnError(head.error)) {
      // §75 (DC-17, H-P21-1): 3435 must deploy before this column is read, and a
      // deployment without it must not turn a missing PROVENANCE column into a
      // failed trend read. Re-read the §58 columns alone: if THAT fails too
      // (3410's source_surface absent, or anything else) it is classified
      // exactly as before, and if it succeeds the run is served with
      // `featureVersion: null` — "not recorded", which is what it is.
      head = await sc.from("place_momentum").select("computed_at, model_version, window_ms")
        .eq("source_surface", "discovery")
        .order("computed_at", { ascending: false })
        .limit(1);
    }
    if (head?.error) return failureOf(head.error);
    const top = Array.isArray(head?.data) ? (head.data[0] as Record<string, unknown> | undefined) : undefined;
    if (!top || typeof top["computed_at"] !== "string") return { ok: true, run: null, rows: [] };
    const windowMs = top["window_ms"] as Record<string, unknown> | null | undefined;
    const prior = Number(windowMs?.["prior_ms"]);
    const run: TrendRun = {
      computedAt: new Date(Date.parse(top["computed_at"] as string)).toISOString(),
      modelVersion: String(top["model_version"] ?? ""),
      featureVersion: typeof top["feature_version"] === "string" && top["feature_version"] !== "" ? (top["feature_version"] as string) : null,
      priorMs: Number.isFinite(prior) && prior > 0 ? prior : null,
    };
    if (itemIds.length === 0) return { ok: true, run, rows: [] };

    const body = await sc.from("place_momentum")
      .select(run.modelVersion === TREND_STATE_MODEL_VERSION_V2 ? `${SNAPSHOT_COLUMNS}, driver, lifecycle_state, cell_key` : SNAPSHOT_COLUMNS)
      .eq("source_surface", "discovery")
      .eq("computed_at", top["computed_at"])
      .in("place_id", [...new Set(itemIds)]);
    if (body?.error) return failureOf(body.error);
    const snapRows = await applyPlaceTrendReviewsToRows(sc, Array.isArray(body?.data) ? (body.data as TrendSnapshotRow[]) : []);  /* §93 (H-W10T-1): a suppressed place reads `unknown`; an unread review drops the row */ if (run.modelVersion === TREND_STATE_MODEL_VERSION_V2) return { ok: true, run, rows: snapRows, areas: await readAreaRows(sc, top["computed_at"] as string, snapRows) }; return { ok: true, run, rows: snapRows };
  } catch {
    // resolves-not-throws-ok: a throw is an unknown answer, stated as one.
    return { ok: false, reason: "trend_read_failed" };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// census-discovery §84 (lane W10-R1): v2 reasons, the neighbourhood floor, and
// `11` §4's three list actions plus Local Pulse (DC-21, DV-29, DV-33)
// ═════════════════════════════════════════════════════════════════════════════
import { fetchBlockedSet, submitterIsVisible } from "./blocks.js";
import { inactiveSubmitterIds, submitterInGoodStanding } from "./discoveryCacheEligibility.js";
import { loadActiveProtectedZones } from "./protectedZoneStore.js";
import { applyProtection, type ProtectedZone } from "./protectedLocations.js";
import { toCanonicalCategory } from "./placeCategories.js";
import { normaliseCategoryAffinities } from "./discoveryPde.js";
import { trailTrendStatesFromRankEvents } from "./discoveryTrailAffinity.js";
import { MOMENTUM_BASELINE_WINDOW_MS, MOMENTUM_PAGE_SIZE, MOMENTUM_ROW_LIMIT } from "./discoveryLocalMomentum.js"; import { trendingObjectiveOrder } from "./discoverySurfaceObjectiveRank.js";  // §93 (W11-X1, DV-09)
import type { TrendRowV2 } from "./discoveryTrendNormalised.js";
import type { MapObject } from "./mapObjects.js";

/** The §58 columns every run has. */
const SNAPSHOT_COLUMNS = "place_id, trend_state, recent_unique_travelers, window_unique_travelers";

/** A Local Pulse row as the explanation reads it. Travellers are READ, never served. */
export interface TrendAreaRow {
  cell_key: string;
  cell_label: string | null;
  trend_state: string;
  driver: string | null;
  recent_unique_travelers: number | null;
  window_unique_travelers: number | null;
  velocity?: number | null;
}

/**
 * B-3, decided (D-W10-R1-10): a public reason names a neighbourhood only when
 * the neighbourhood is a NAMED one (never a grid square, whose key is a
 * coordinate) and its own Local Pulse reading carries at least
 * TREND_DISCLOSURE_MIN_TRAVELERS distinct travellers in BOTH windows — the
 * k-floor §58.2 already applies to a place's state, applied to the area the
 * sentence names. Below it the sentence is the place's own, with no location.
 */
export function mayNameNeighbourhood(area: TrendAreaRow | undefined): area is TrendAreaRow & { cell_label: string } {
  return !!area && typeof area.cell_label === "string" && area.cell_label !== "" && area.cell_key.startsWith("n:")
    && travelersOk(area.recent_unique_travelers) && travelersOk(area.window_unique_travelers);
}

const DRIVERS = new Set(["trip_adds", "saves", "independent_groups"]);
const LIFECYCLES = new Set(["unknown", "emerging", "growing", "peak", "cooling", "evergreen", "rediscovered", "inactive"]);

/** A v2 row's served trend: the driver-led sentence, its driver code, the lifecycle. Still no number. */
function v2Trend(
  row: TrendSnapshotRow, state: DiscoveryTrendState, reason: { code: TrendReasonCode; text: string }, areas: readonly TrendAreaRow[],
): NonNullable<TrendExplanation["trend"]> {
  const driver = typeof row.driver === "string" && DRIVERS.has(row.driver) ? (row.driver as TrendDriver) : null;
  const area = typeof row.cell_key === "string" ? areas.find((a) => a.cell_key === row.cell_key) : undefined;
  const text = explainTrendReading(state, driver, mayNameNeighbourhood(area) ? area.cell_label : null) ?? reason.text;
  const code = trendDriverCode(driver);
  const lifecycle = typeof row.lifecycle_state === "string" && LIFECYCLES.has(row.lifecycle_state) ? (row.lifecycle_state as TrendLifecycle) : undefined;
  return { state, reason: code ? { code: reason.code, text, driver: code } : { code: reason.code, text }, ...(lifecycle ? { lifecycle } : {}) };
}

/** The run's Local Pulse rows for these places' cells. A failed read names no neighbourhood (the safe direction). */
async function readAreaRows(sc: any, computedAt: string, rows: readonly TrendSnapshotRow[]): Promise<TrendAreaRow[]> {
  const cells = [...new Set(rows.map((r) => r.cell_key).filter((c): c is string => typeof c === "string" && c.startsWith("n:")))];
  if (cells.length === 0) return [];
  try {
    const { data, error } = await sc.from("area_momentum")
      .select("cell_key, cell_label, trend_state, driver, recent_unique_travelers, window_unique_travelers")
      .eq("source_surface", "discovery").eq("computed_at", computedAt).in("cell_key", cells);
    return error || !Array.isArray(data) ? [] : (data as TrendAreaRow[]);
  } catch {
    // resolves-not-throws-ok: no neighbourhood is named, which is the safe direction.
    return [];
  }
}

// ── The lists ────────────────────────────────────────────────────────────────

/** The lists' gate, seeded FALSE by 3475; the route also requires TREND_API_FLAG. */
export const TREND_LISTS_FLAG = "discovery_trend_lists_enabled";
/** One Discovery page, the explanation bound's own number. */
export const TREND_LIST_MAX = TREND_EXPLANATIONS_MAX_IDS;
/**
 * `03` §1: "What is gaining meaningful travel relevance now?" The states that
 * claim a gain, in the order a list shows them (D-W10-R1-13). `established`
 * and `cooling` are not gains; `unknown` is not a claim.
 */
export const TREND_LIST_STATES: readonly DiscoveryTrendState[] = ["trending", "emerging", "rediscovered"];

export type TrendListUnavailable = "no_snapshot" | "stale_snapshot" | "not_located";

export interface TrendListItem {
  placeId: string;
  state: DiscoveryTrendState;
  reason: { code: TrendReasonCode; text: string; driver?: TrendDriverCode };
  lifecycle?: TrendLifecycle;
}
export interface TrendAreaItem {
  area: string;
  state: DiscoveryTrendState;
  reason: { code: TrendReasonCode; text: string; driver?: TrendDriverCode };
}
export interface TrendTrailItem {
  trailId: string;
  state: "emerging";
  reason: { code: TrendReasonCode; text: string; driver?: TrendDriverCode };
}
export interface TrendListResponse {
  destination: string;
  items: TrendListItem[];
  unavailable: TrendListUnavailable | null;
  readingProvenance: TrendReadingProvenance | null;
}

/** A destination: the city string as discovery_places stores it, lower-cased and trimmed. Null when absent or malformed. */
export function parseDestination(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/^ +| +$/g, "").toLowerCase();
  return d.length >= 1 && d.length <= 80 && /^[\p{L}\p{N} .'-]+$/u.test(d) ? d : null;
}

interface LocatedRow extends TrendSnapshotRow { velocity: number | null }

export type LocatedRead =
  | { ok: true; run: TrendRun | null; unavailable: TrendListUnavailable | null; rows: LocatedRow[] }
  | { ok: false; reason: "trend_store_absent" | "trend_read_failed" };

/**
 * The newest run's rows for one destination's places, in the claim states.
 * Only a v2 run knows where a place is (3476's `city`); a v1 run reads
 * `not_located`, stated, never an empty list that looks like a quiet city.
 */
export async function readLocatedRun(sc: any, destination: string, states: readonly string[], nowMs: number): Promise<LocatedRead> {
  const head = await readTrendSnapshot(sc, []);
  if (!head.ok) return head;
  if (head.run === null) return { ok: true, run: null, unavailable: "no_snapshot", rows: [] };
  if (!isCurrentRun(head.run, nowMs)) return { ok: true, run: head.run, unavailable: "stale_snapshot", rows: [] };
  if (head.run.modelVersion !== TREND_STATE_MODEL_VERSION_V2) return { ok: true, run: head.run, unavailable: "not_located", rows: [] };
  try {
    const { data, error } = await sc.from("place_momentum")
      .select(`${SNAPSHOT_COLUMNS}, driver, lifecycle_state, cell_key, velocity`)
      .eq("source_surface", "discovery").eq("computed_at", head.run.computedAt).eq("city", destination).in("trend_state", [...states]);
    if (error) return failureOf(error);
    return { ok: true, run: head.run, unavailable: null, rows: await applyPlaceTrendReviewsToRows(sc, Array.isArray(data) ? (data as LocatedRow[]) : []) };  // §93 (H-W10T-1)
  } catch {
    // resolves-not-throws-ok: a throw is an unknown answer, stated as one.
    return { ok: false, reason: "trend_read_failed" };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const placeKey = (placeId: string) => placeId.replace(/^db\//, "").toLowerCase();

interface EligiblePlace { id: string; category: string | null; place_type: string | null }

/**
 * What a list may name, for THIS viewer: an active community place whose
 * submitter the viewer has not blocked (either way) and is in good standing
 * (lib/blocks, lib/discoveryCacheEligibility — the rules GET /discovery applies),
 * and which no protected zone suppresses or coarsens (lib/protectedLocations;
 * an unreadable zone policy withholds every positioned place). Null when a
 * read failed: a list is never served with a rule it could not apply.
 */
export async function eligibleListPlaces(sc: any, viewerId: string, placeIds: readonly string[]): Promise<Map<string, EligiblePlace> | null> {
  const ids = [...new Set(placeIds.map(placeKey).filter((k) => UUID.test(k)))];
  const out = new Map<string, EligiblePlace>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await sc.from("discovery_places")
      .select("id, name, status, submitted_by, lat, lng, category, place_type").in("id", ids).eq("status", "active");
    if (error || !Array.isArray(data)) return null;
    const blocked = await fetchBlockedSet(sc, viewerId);
    const inactive = await inactiveSubmitterIds(sc, (data as Array<{ submitted_by?: unknown }>).map((r) => r.submitted_by));
    if (blocked === null || inactive === null) return null;
    const zones = await loadActiveProtectedZones(sc);
    for (const r of data as Array<Record<string, unknown>>) {
      if (!submitterIsVisible(r["submitted_by"], blocked) || !submitterInGoodStanding(r["submitted_by"], inactive)) continue;
      // THE zone decision, unchanged in behaviour and no longer inline:
      // zoneAllowsPosition (declared below, beside the two Q12 legs that now
      // share it — forward references are this file's existing style, cf.
      // SNAPSHOT_COLUMNS). Suppressed or coarsened, or an unreadable policy
      // over a positioned row, is not named in a list. It is deliberately NOT
      // hoisted above this function: the census cites lines in this file by
      // number (docs/architecture/census-discovery.md, guarded by
      // check:doc-citations), and moving code down the file breaks citations
      // that a branch other than this one owns.
      if (!zoneAllowsPosition(String(r["id"]), String(r["name"] ?? r["id"]), r["lat"], r["lng"], zones)) continue;
      out.set(String(r["id"]).toLowerCase(), { id: String(r["id"]), category: (r["category"] as string | null) ?? null, place_type: (r["place_type"] as string | null) ?? null });
    }
    return out;
  } catch {
    // resolves-not-throws-ok: an unapplied rule is reported as a failure.
    return null;
  }
}

const statePriority = (s: string) => TREND_LIST_STATES.indexOf(s as DiscoveryTrendState);
const byTrend = (a: LocatedRow, b: LocatedRow) =>
  (statePriority(a.trend_state) - statePriority(b.trend_state))
  || ((b.velocity ?? -1) - (a.velocity ?? -1))
  || (a.place_id < b.place_id ? -1 : a.place_id > b.place_id ? 1 : 0);

function listItem(row: LocatedRow): TrendListItem | null {
  const state = row.trend_state as DiscoveryTrendState;
  const reason = trendReasonFor(state);
  if (!reason) return null;
  const t = v2Trend(row, state, reason, []);
  return { placeId: row.place_id, state, reason: t.reason, ...(t.lifecycle ? { lifecycle: t.lifecycle } : {}) };
}

/**
 * The ORDER (D-W10-R1-13): the gain the state claims (trending, then emerging,
 * then rediscovered), then v2's normalised velocity — the number the state was
 * decided on, never served — then the id, so equal readings order the same on
 * every request.
 */
export function orderLocated(rows: readonly LocatedRow[], eligible: ReadonlyMap<string, unknown>, states: readonly string[] = TREND_LIST_STATES): LocatedRow[] {
  return rows.filter((r) => states.includes(r.trend_state) && mayDiscloseTrend(r) && eligible.has(placeKey(r.place_id))).sort(byTrend);
}

export type ListResult = { ok: true; body: TrendListResponse } | { ok: false; reason: "trend_store_absent" | "trend_read_failed" | "eligibility_read_failed" };

/** `11` §4 "trending by location". */
export async function trendingByLocation(sc: any, viewerId: string, destination: string, nowMs: number): Promise<ListResult> {
  const read = await readLocatedRun(sc, destination, TREND_LIST_STATES, nowMs);
  if (!read.ok) return read;
  const prov = read.run ? { ...provenanceOf(read.run), featureVersion: read.run.featureVersion } : null;
  if (read.unavailable) return { ok: true, body: { destination, items: [], unavailable: read.unavailable, readingProvenance: prov } };
  const eligible = await eligibleListPlaces(sc, viewerId, read.rows.map((r) => r.place_id));
  if (eligible === null) return { ok: false, reason: "eligibility_read_failed" };
  const items = (await trendingObjectiveOrder(sc, orderLocated(read.rows, eligible), nowMs)).map(listItem).filter((x): x is TrendListItem => x !== null).slice(0, TREND_LIST_MAX);  // §93 (DV-09): the Trending objective inside each state, only with 3500's Trending flag and 3450 on; else the same array
  return { ok: true, body: { destination, items, unavailable: null, readingProvenance: prov } };
}

/**
 * `11` §4 "personalized trending" (D-W10-R1-13): the same disclosed claims,
 * ordered first by the viewer's own category affinity (compass
 * category_weights, normalised exactly as the PDE ranker normalises them),
 * then as trending by location. `basis: "none"` says the viewer has no
 * affinities yet — the order is then the location order, and says so.
 */
export async function personalizedTrending(sc: any, viewerId: string, destination: string, nowMs: number): Promise<ListResult & { basis?: "affinity" | "none" }> {
  const read = await readLocatedRun(sc, destination, TREND_LIST_STATES, nowMs);
  if (!read.ok) return read;
  const prov = read.run ? { ...provenanceOf(read.run), featureVersion: read.run.featureVersion } : null;
  if (read.unavailable) return { ok: true, basis: "none", body: { destination, items: [], unavailable: read.unavailable, readingProvenance: prov } };
  const eligible = await eligibleListPlaces(sc, viewerId, read.rows.map((r) => r.place_id));
  if (eligible === null) return { ok: false, reason: "eligibility_read_failed" };
  let affinities: Record<string, number> | undefined;
  try {
    const { data, error } = await sc.from("compass_user_preferences").select("category_weights").eq("user_id", viewerId).maybeSingle();
    if (error) return { ok: false, reason: "trend_read_failed" };
    affinities = normaliseCategoryAffinities((data as Record<string, unknown> | null)?.["category_weights"]);
  } catch {
    // resolves-not-throws-ok: an unread preference is an unknown answer, stated as one.
    return { ok: false, reason: "trend_read_failed" };
  }
  const affinityOf = (r: LocatedRow): number => {
    const p = eligible.get(placeKey(r.place_id));
    if (!p || !affinities) return 0;
    const canon = toCanonicalCategory(p.category, p.place_type);
    return affinities[canon] ?? affinities[(p.category ?? "").toLowerCase()] ?? 0;
  };
  const ordered = orderLocated(read.rows, eligible).sort((a, b) => (affinityOf(b) - affinityOf(a)) || byTrend(a, b));
  const items = ordered.map(listItem).filter((x): x is TrendListItem => x !== null).slice(0, TREND_LIST_MAX);
  return { ok: true, basis: affinities ? "affinity" : "none", body: { destination, items, unavailable: null, readingProvenance: prov } };
}

/**
 * THE protected-zone decision of this module. Q12 (owner, 2026-10-04) —
 * "suppress contributions inside protected zones" — makes three legs ask it
 * (the place lists, Local Pulse, the emerging-Trails fold), and all three must
 * get the SAME answer. A second copy is exactly the drift lib/protectedZoneStore's
 * header warns about for this policy, and the copy that drifts LOOSE is the one
 * nobody notices. So the decision is here, once, and the legs call it.
 *
 * FALSE — withhold — when:
 *   • the policy could not be read (`zones === null`). protectedZoneStore rule 1:
 *     an unreadable policy is not an absent policy. `[]` means "asked, no
 *     zones" and permits publishing; null means "could not ask" and must not.
 *   • applyProtection does not hand the probe back unchanged — the position was
 *     SUPPRESSED, or COARSENED, or coarsened below the servable line. These
 *     wires name a thing at full precision or not at all; there is no coarse
 *     rung on a trend list or a pulse, so a coarsen decision withholds here too.
 *
 * TRUE for a row with no usable position: no zone can say where an unpositioned
 * row stands. Whether an unpositioned row may be named at all is not this
 * gate's question — the caller's own read already answered it.
 */
export function zoneAllowsPosition(
  id: string, title: string, lat: unknown, lng: unknown, zones: readonly ProtectedZone[] | null,
): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return true;
  if (zones === null) return false;
  if (zones.length === 0) return true;
  const probe: MapObject = { id, kind: "place", geometry: { type: "Point", coordinates: [lng, lat] },
    title, privacyClass: "place_level", renderingPriority: 0 };
  return applyProtection([probe], zones).objects[0] === probe;
}

/**
 * Q12 (owner, 2026-10-04), the Local Pulse half: which of these cells may be
 * published for THIS run — a cell no protected zone fed. Null when a read
 * failed; the caller then STATES a failure and serves no pulse.
 *
 * WHY A CELL IS WITHHELD WHEN *ANY* PLACE BEHIND IT IS
 * ====================================================
 * A cell's reading is a sum the database already took: 3477/3497 write one
 * `area_momentum` row per cell from every place in that cell, and nothing on
 * the read side can subtract one place's contribution back out of it. So the
 * only question this gate can answer honestly is whether the sum counted
 * something a protected zone withholds — and if it did, the sum is not
 * publishable. That is the rule the emerging-Trails fold below already states
 * for members a viewer is not served: a number must not count what it
 * withholds.
 *
 * This over-suppresses, and visibly: ONE designated home inside a named
 * neighbourhood takes that whole neighbourhood's pulse off the wire. That is
 * the direction lib/protectedLocations chooses on purpose — "a silently-skipped
 * shelter row is a privacy incident while an over-suppressing one is a visible,
 * recoverable outage". The precise fix is contribution-side, in the rebuild
 * that writes the aggregate; it does not exist yet (none of 2892, 3410, 3417,
 * 3435, 3475-3477, 3497 reads protected_zones), so until it does, a stored
 * Local Pulse row cannot be shown to exclude a protected zone and is withheld.
 *
 * A cell no place of this run accounts for is withheld too: an unattributable
 * cell is one this gate cannot clear, not one it may wave through. Both tables
 * are written by the same function from the same context in one statement pair,
 * so in a real run every cell with a reading has places behind it.
 */
async function zoneClearCells(
  sc: any, computedAt: string, destination: string, cellKeys: readonly string[],
): Promise<Set<string> | null> {
  const wanted = new Set(cellKeys);
  if (wanted.size === 0) return new Set<string>();
  try {
    // No cell key goes into a filter: a key is `n:<city>:<neighbourhood>` built
    // from free text, and a comma or a quote in it would carry a PostgREST
    // filter delimiter into the expression. The run and the (validated)
    // destination bound the read; the cells are matched in process.
    const { data, error } = await sc.from("place_momentum").select("place_id, cell_key")
      .eq("source_surface", "discovery").eq("computed_at", computedAt).eq("city", destination);
    if (error || !Array.isArray(data)) return null;
    const cellsOf = new Map<string, string[]>();   // place key → the wanted cells it fed
    for (const r of data as Array<Record<string, unknown>>) {
      const cell = r["cell_key"], pid = r["place_id"];
      if (typeof cell !== "string" || !wanted.has(cell) || typeof pid !== "string") continue;
      const key = placeKey(pid);
      if (!UUID.test(key)) continue;
      const seen = cellsOf.get(key);
      if (seen) seen.push(cell); else cellsOf.set(key, [cell]);
    }
    const accounted = new Set<string>([...cellsOf.values()].flat());
    const ids = [...cellsOf.keys()];
    if (ids.length === 0) return new Set<string>();   // nothing accounted for: nothing cleared
    const places = await sc.from("discovery_places").select("id, lat, lng, name").in("id", ids);
    if (places?.error || !Array.isArray(places?.data)) return null;
    const zones = await loadActiveProtectedZones(sc);
    // An unreadable policy is a failed read, stated as one. The place lists
    // drop positioned places silently because a list of places can be short;
    // a pulse of cells cannot say "this one is missing", so it says 503.
    if (zones === null) return null;
    const withheld = new Set<string>();
    for (const r of places.data as Array<Record<string, unknown>>) {
      if (zoneAllowsPosition(String(r["id"]), String(r["name"] ?? r["id"]), r["lat"], r["lng"], zones)) continue;
      for (const c of cellsOf.get(String(r["id"]).toLowerCase()) ?? []) withheld.add(c);
    }
    return new Set([...accounted].filter((c) => !withheld.has(c)));
  } catch {
    // resolves-not-throws-ok: a throw is a rule that could not be applied.
    return null;
  }
}

/**
 * DV-29 Local Pulse, served: the destination's NAMED neighbourhoods whose
 * area reading is a gain, carries ≥ k travellers in both windows, and which no
 * protected zone fed (Q12; zoneClearCells). A grid square is never listed —
 * its key is a coordinate and it has no public name.
 */
export async function localPulse(sc: any, destination: string, nowMs: number): Promise<
  { ok: true; body: { destination: string; areas: TrendAreaItem[]; unavailable: TrendListUnavailable | null } } | { ok: false; reason: "trend_store_absent" | "trend_read_failed" | "eligibility_read_failed" }> {
  const head = await readTrendSnapshot(sc, []);
  if (!head.ok) return head;
  const none = (u: TrendListUnavailable) => ({ ok: true as const, body: { destination, areas: [], unavailable: u } });
  if (head.run === null) return none("no_snapshot");
  if (!isCurrentRun(head.run, nowMs)) return none("stale_snapshot");
  if (head.run.modelVersion !== TREND_STATE_MODEL_VERSION_V2) return none("not_located");
  try {
    const { data, error } = await sc.from("area_momentum")
      .select("cell_key, cell_label, trend_state, driver, recent_unique_travelers, window_unique_travelers, velocity")
      .eq("source_surface", "discovery").eq("computed_at", head.run.computedAt).eq("city", destination).in("trend_state", [...TREND_LIST_STATES]);
    if (error) return failureOf(error);
    const named = ((Array.isArray(data) ? data : []) as TrendAreaRow[]).filter((a) => mayNameNeighbourhood(a));
    // Q12 (owner, 2026-10-04): "suppress contributions inside protected
    // zones". A cell a protected zone fed is not published, and a zone policy
    // that could not be read is a stated 503 — never a quiet, empty pulse.
    const clear = await zoneClearCells(sc, head.run.computedAt, destination, named.map((a) => a.cell_key));
    if (clear === null) return { ok: false, reason: "eligibility_read_failed" };
    const areas = named
      .filter((a) => clear.has(a.cell_key))
      .sort((a, b) => (statePriority(a.trend_state) - statePriority(b.trend_state)) || ((b.velocity ?? -1) - (a.velocity ?? -1)) || (a.cell_key < b.cell_key ? -1 : 1))
      .slice(0, TREND_LIST_MAX)
      .flatMap((a): TrendAreaItem[] => {
        const state = a.trend_state as DiscoveryTrendState;
        const reason = trendReasonFor(state);
        const driver = typeof a.driver === "string" && DRIVERS.has(a.driver) ? (a.driver as TrendDriver) : null;
        const text = explainTrendReading(state, driver, a.cell_label);
        const code = trendDriverCode(driver);
        return reason && text ? [{ area: a.cell_label as string, state, reason: code ? { code: reason.code, text, driver: code } : { code: reason.code, text } }] : [];
      });
    return { ok: true, body: { destination, areas, unavailable: null } };
  } catch {
    // resolves-not-throws-ok: a throw is an unknown answer, stated as one.
    return { ok: false, reason: "trend_read_failed" };
  }
}

/**
 * `11` §4 "emerging places/Trails". Places: the disclosed `emerging` rows of
 * the destination. Trails: the destination's ACTIVE Trails, each classified by
 * the v2 model over its PLACE members' Discovery rows (lib/discoveryTrailAffinity
 * trailTrendStatesFromRankEvents), listed when `emerging` over ≥ k travellers in
 * both windows. Only place members are folded, and only the ones this viewer may
 * be served: a post, event or route plan member may be one this viewer is not
 * served (census §64), a place member may be inactive, by a withheld author, or
 * standing inside a protected zone (Q12, owner 2026-10-04) — and a number must
 * not count what it withholds. A database without 2910 lists no Trails and says so.
 */
export async function emergingPlacesAndTrails(sc: any, viewerId: string, destination: string, nowMs: number): Promise<
  { ok: true; body: TrendListResponse & { trails: TrendTrailItem[]; trailsUnavailable: "trails_unavailable" | "trail_read_failed" | null } }
  | { ok: false; reason: "trend_store_absent" | "trend_read_failed" | "eligibility_read_failed" }> {
  const read = await readLocatedRun(sc, destination, ["emerging"], nowMs);
  if (!read.ok) return read;
  const prov = read.run ? { ...provenanceOf(read.run), featureVersion: read.run.featureVersion } : null;
  let items: TrendListItem[] = [];
  if (!read.unavailable) {
    const eligible = await eligibleListPlaces(sc, viewerId, read.rows.map((r) => r.place_id));
    if (eligible === null) return { ok: false, reason: "eligibility_read_failed" };
    items = orderLocated(read.rows, eligible, ["emerging"]).map(listItem).filter((x): x is TrendListItem => x !== null).slice(0, TREND_LIST_MAX);
  }
  const t = await emergingTrails(sc, viewerId, destination, nowMs);
  return { ok: true, body: { destination, items, unavailable: read.unavailable, readingProvenance: prov, trails: t.trails, trailsUnavailable: t.unavailable } };
}

async function emergingTrails(sc: any, viewerId: string, destination: string, nowMs: number): Promise<{ trails: TrendTrailItem[]; unavailable: "trails_unavailable" | "trail_read_failed" | null }> {
  try {
    const tr = await sc.from("trails").select("id").eq("destination", destination).eq("lifecycle_status", "active");
    if (tr?.error) return { trails: [], unavailable: isMissingSchemaError(tr.error) ? "trails_unavailable" : "trail_read_failed" };
    const trailIds = ((tr?.data ?? []) as Array<{ id: string }>).map((t) => t.id);
    if (trailIds.length === 0) return { trails: [], unavailable: null };
    const ct = await sc.from("content_trails").select("trail_id, source_id").eq("source_type", "place").in("trail_id", trailIds);
    if (ct?.error || !Array.isArray(ct?.data)) return { trails: [], unavailable: "trail_read_failed" };
    const allMembers = ct.data as Array<{ trail_id: string; source_id: string }>;
    // Q12 (owner, 2026-10-04), and the rule the header above already states:
    // "a number must not count what it withholds". A place member inside a
    // protected zone is withheld from this viewer, so its activity must not be
    // folded into a Trail's reading either — a Trail listed on that evidence
    // publishes the zone it came from. The SAME gate the places leg of this
    // very response applies (eligibleListPlaces: active, author policy, the one
    // zone decision), not a second copy of it. Null = a rule could not be
    // applied, and the Trails half says so rather than listing.
    const eligible = await eligibleListPlaces(sc, viewerId, allMembers.map((m) => m.source_id));
    if (eligible === null) return { trails: [], unavailable: "trail_read_failed" };
    const members = allMembers.filter((m) => eligible.has(placeKey(m.source_id)));
    const served = [...new Set(members.flatMap((m) => [m.source_id, `db/${m.source_id}`]))];
    if (served.length === 0) return { trails: [], unavailable: null };
    const since = new Date(nowMs - MOMENTUM_BASELINE_WINDOW_MS).toISOString();
    const rows: TrendRowV2[] = []; let lastRow: Record<string, unknown> | null = null;  // census-discovery §118 (DV-83 round 21, SW22): the keyset cursor
    for (let offset = 0; offset < MOMENTUM_ROW_LIMIT; offset += MOMENTUM_PAGE_SIZE) {
      const { data, error }: { data: any[] | null; error: unknown } = await keysetBefore(sc.from("rank_events").select("id, item_id, outcome, served_at, outcome_at, user_id")
        .eq("surface", "discovery").neq("outcome", "analytics").in("item_id", served).gte("served_at", since), ["served_at", "id"], lastRow)
        .order("served_at", { ascending: false }).order("id", { ascending: false })
        .range(0, Math.min(MOMENTUM_PAGE_SIZE, MOMENTUM_ROW_LIMIT - offset) - 1);  // §118 (SW22): by key, never at an offset a serve logged meanwhile shifts
      if (error || !Array.isArray(data) || (lastRow !== null && data.length > 0 && !keySortsBefore(data[0], lastRow, ["served_at", "id"]))) return { trails: [], unavailable: "trail_read_failed" }; if (data.length > 0) lastRow = data[data.length - 1];  // §118 (SW22): a page that repeats a row is a failed read
      rows.push(...(data as TrendRowV2[]).map((r) => ({ ...r, item_id: r.item_id.replace(/^db\//, "") })));
      if (data.length < MOMENTUM_PAGE_SIZE) break;
    }
    const readings = trailTrendStatesFromRankEvents(rows, members, nowMs);
    const trails = Object.entries(readings)
      .filter(([, r]) => r.state === "emerging" && travelersOk(r.evidence.recentTravelers) && travelersOk(r.evidence.windowTravelers))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, TREND_LIST_MAX)
      .flatMap(([trailId, r]): TrendTrailItem[] => {
        const reason = trendReasonFor("emerging");
        const text = explainTrendReading("emerging", r.driver);
        const code = trendDriverCode(r.driver);
        return reason && text ? [{ trailId, state: "emerging", reason: code ? { code: reason.code, text, driver: code } : { code: reason.code, text } }] : [];
      });
    return { trails, unavailable: null };
  } catch {
    // resolves-not-throws-ok: a throw is a failed read, stated as one.
    return { trails: [], unavailable: "trail_read_failed" };
  }
}
