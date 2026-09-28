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
import { MOMENTUM_CACHE_TTL_MS } from "./discoveryLocalMomentum.js";
import { RECOMMENDATION_ID_SHAPE } from "./rankEventsProvenance.js";
import {
  isTrendState, trendReasonFor,
  type DiscoveryTrendState, type TrendReasonCode,
} from "./discoveryTrendState.js";

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
  window_unique_travelers: number | null;
}

export interface TrendExplanation {
  recommendationId: string;
  /** The served item this exposure named; null when the id bound nothing. */
  itemId: string | null;
  trend: { state: DiscoveryTrendState; reason: { code: TrendReasonCode; text: string } } | null;
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
  nowMs: number,
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
    return { recommendationId: rid, itemId, trend: { state, reason }, unavailable: null };
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
  | { ok: true; run: TrendRun | null; rows: TrendSnapshotRow[] }
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
      .select("place_id, trend_state, recent_unique_travelers, window_unique_travelers")
      .eq("source_surface", "discovery")
      .eq("computed_at", top["computed_at"])
      .in("place_id", [...new Set(itemIds)]);
    if (body?.error) return failureOf(body.error);
    return { ok: true, run, rows: Array.isArray(body?.data) ? (body.data as TrendSnapshotRow[]) : [] };
  } catch {
    // resolves-not-throws-ok: a throw is an unknown answer, stated as one.
    return { ok: false, reason: "trend_read_failed" };
  }
}
