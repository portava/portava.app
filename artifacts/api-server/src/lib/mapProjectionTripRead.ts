/**
 * The Map's trip_stop layer reader — the CONSUMER that migration 2520's
 * projection worker never had.
 *
 *   Trip Kernel event → trip_outbox → trip_map_projection_drain (2520)
 *     → trip_map_projections (+ the 2610 Map anchor)
 *     → THIS FILE → routes/mapProjection.ts → GET /api/map/projection
 *     → mobile Map
 *
 * Two branches, chosen by the capability contract, never by a bare flag:
 *
 *   projection  the read model. Requires `map_trip_projection_read_enabled`
 *               to be ON *and* `trip_map_projections` to carry every column
 *               MAP_TRIP_PROJECTION_COLUMNS names (2420 → 2520 → 2610).
 *   canonical   the path that runs today and everywhere: `trip_members` scope
 *               → `trips` → `toAuthorizedTripView`. Unchanged, and it is what
 *               a not-ready capability falls back to.
 *
 * Both branches end in the SAME `projectTrip`, over the same `TripViewLike`
 * shape, so the object served cannot drift between them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE DELIBERATE DECISIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. A NOT-READY CAPABILITY FALLS BACK; IT DOES NOT 503.
 *    `resolveCapability`, not `requireCapability`. A 503 is right for a WRITER
 *    that would otherwise lose data silently — the media case the contract was
 *    built for. This is a READER of one layer of a six-layer map, and the
 *    canonical path is fully correct: refusing the whole request would take
 *    down travelers, gems, events, circle, buddies and places to protect a
 *    trip layer that has a working alternative. The refusal is still LOUD —
 *    `resolveCapability` logs at ERROR on every flag-ON/schema-not-ready
 *    resolve — and `report.capability` puts the reason on the wire.
 *
 * 2. A PROJECTION READ FAILURE IS FAIL-CLOSED AND VISIBLE. IT DOES NOT FALL
 *    BACK TO CANONICAL.
 *    supabase-js RESOLVES on a database error, so `const { data } = await …`
 *    yields `data: null` and an unchecked `.error`; `data ?? []` then reads as
 *    an empty projection, which on a map is indistinguishable from "you have
 *    no trips". Every read here checks `.error` explicitly and returns
 *    `trips: null`, which routes/mapProjection.ts turns into "the layer is
 *    absent from `sources`" — the established contract in that file for
 *    exactly this ("a failed read must not be reported as an empty-but-
 *    successful layer"), and what tells the client to keep its own trip fetch.
 *
 *    A silent canonical fallback was considered and REJECTED. It would make a
 *    permanently broken projection invisible: the map would look right, the
 *    census row would stay closed, and nobody would learn until the canonical
 *    path was removed. That is the media-writer defect class with a new name.
 *
 * 3. A ROW BELOW THE CONTRACT VERSION REFUSES THE WHOLE LAYER, NOT JUST THAT
 *    ROW. A pre-2610 row has no anchor, so it silently drops one pin — and a
 *    trip layer missing one trip is indistinguishable from a viewer with one
 *    fewer trip. Refusing the layer is the only outcome an operator can see.
 */
import { logger } from "./logger.js";
import {
  markSchemaMissing,
  resolveCapability,
} from "./capability/schemaCapability.js";
import { isMissingSchemaError } from "./capability/schemaCapability.js";
import type { CapabilityVerdict, SchemaReadinessState } from "./capability/schemaRequirement.js";
import { toAuthorizedTripView } from "./privacy/tripSerializers.js";
import type { TripViewLike } from "./mapProjection.js";
import {
  EXPECTED_PROJECTION_SCHEMA_VERSION,
  MAP_TRIP_CONTRACT_VERSION,
  MAP_TRIP_PROJECTION_CAPABILITY,
  MAP_TRIP_PROJECTION_COLUMNS,
  foldTripProjectionRows,
  isProjectionRowMapEligible,
  projectionRowToTripView,
  type TripMapProjectionRow,
} from "./mapProjectionTripContract.js";

export const TRIP_MAP_PROJECTIONS_TABLE = "trip_map_projections";

export type TripLayerPath = "canonical" | "projection";

export type TripLayerRefusal =
  /** `trip_members` could not be read. Neither branch has a scope without it. */
  | "scope_read_failed"
  /** The canonical `trips` read failed (legacy path). */
  | "canonical_read_failed"
  /** `trip_map_projections` answered an error. NOT an empty projection. */
  | "projection_read_failed"
  /** At least one row predates 2610 / carries no Map anchor version. */
  | "projection_contract_stale"
  /** 2520's body shape is not the one this reader understands. */
  | "projection_schema_unexpected";

export interface TripLayerCapabilityReport {
  flag: CapabilityVerdict["flag"];
  reason: CapabilityVerdict["reason"];
  schema: SchemaReadinessState | null;
  missing: readonly string[];
}

export interface TripLayerReport {
  /** WHICH BRANCH RAN. The measurable the whole capability design turns on. */
  path: TripLayerPath;
  capability: TripLayerCapabilityReport;
  refusal: TripLayerRefusal | null;
  /** Trips the viewer is an accepted member of — the authorization scope. */
  scoped: number;
  /** Rows the projection delivered (projection path only). */
  rows: number;
  /** Rows that cleared Map eligibility (projection path only). */
  eligible: number;
  /** Views handed to projectTrip. */
  served: number;
  staleIgnored: number;
  duplicatesIgnored: number;
  invalidRows: number;
  /** The lowest map_contract_version among folded rows, or null. */
  contractVersion: number | null;
  /** §19.1 freshness handle: the highest aggregate_version reflected. */
  maxSourceTripVersion: number | null;
}

export interface TripLayerRead {
  report: TripLayerReport;
  /**
   * null means THE LAYER WAS NOT READ. The caller must leave it out of
   * `sources` rather than serve it as an empty-but-successful layer.
   */
  trips: TripViewLike[] | null;
}

function emptyReport(path: TripLayerPath, capability: TripLayerCapabilityReport): TripLayerReport {
  return {
    path,
    capability,
    refusal: null,
    scoped: 0,
    rows: 0,
    eligible: 0,
    served: 0,
    staleIgnored: 0,
    duplicatesIgnored: 0,
    invalidRows: 0,
    contractVersion: null,
    maxSourceTripVersion: null,
  };
}

/**
 * The authorization scope, shared by both branches: trips the viewer is an
 * ACCEPTED member of. `role <> 'invited'` is the whole privacy decision — an
 * invited-but-not-accepted member must not get the authorized view — and it is
 * the same predicate GET /api/trips/me applies.
 *
 * The projection cannot supply this: `trip_map_projections` is one row per
 * TRIP, with no viewer dimension at all. Scoping is therefore the reader's
 * job on BOTH paths, and it is why a projection row for a trip the viewer has
 * no membership in can never be served.
 *
 * null = the read FAILED (not "no trips").
 */
export async function loadViewerTripScope(sc: any, viewerId: string): Promise<string[] | null> {
  const { data, error } = await sc
    .from("trip_members")
    .select("trip_id, role")
    .eq("user_id", viewerId)
    .neq("role", "invited");
  if (error) return null;
  return ((data ?? []) as any[])
    .map((r) => r?.trip_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * THE LEGACY PATH, moved here verbatim from routes/mapProjection.ts so both
 * branches sit behind one entry point. Not one predicate, column or DTO call
 * changed: the scope select, the `.not("status","is",null)` filter and the
 * `toAuthorizedTripView` map are the same reads in the same order.
 *
 * null on failure so the caller can leave the layer OUT of `sources` rather
 * than claim an empty trips layer it never successfully read.
 */
export async function loadViewerTripsCanonical(
  sc: any,
  viewerId: string,
  scope?: string[] | null,
): Promise<{ trips: TripViewLike[] | null; scoped: number; refusal: TripLayerRefusal | null }> {
  const tripIds = scope === undefined ? await loadViewerTripScope(sc, viewerId) : scope;
  if (tripIds === null) return { trips: null, scoped: 0, refusal: "scope_read_failed" };
  if (tripIds.length === 0) return { trips: [], scoped: 0, refusal: null };

  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("*")
    .in("id", tripIds)
    .not("status", "is", null);
  if (tripsErr) return { trips: null, scoped: tripIds.length, refusal: "canonical_read_failed" };

  return {
    trips: ((trips ?? []) as any[]).map(toAuthorizedTripView) as unknown as TripViewLike[],
    scoped: tripIds.length,
    refusal: null,
  };
}

/**
 * THE PROJECTION PATH. Scope first, then the read model, then the fold, then
 * eligibility. Every step that can fail returns `trips: null` with a named
 * refusal; none of them returns an empty list for a failure.
 */
async function readFromProjection(
  sc: any,
  viewerId: string,
  capability: TripLayerCapabilityReport,
): Promise<TripLayerRead> {
  const report = emptyReport("projection", capability);

  const tripIds = await loadViewerTripScope(sc, viewerId);
  if (tripIds === null) {
    report.refusal = "scope_read_failed";
    return { report, trips: null };
  }
  report.scoped = tripIds.length;
  if (tripIds.length === 0) return { report, trips: [] };

  // `.in(trip_id, scope)` is the authorization boundary: a projection row for
  // a trip outside the viewer's accepted membership is never fetched, let
  // alone served.
  const { data, error } = await sc
    .from(TRIP_MAP_PROJECTIONS_TABLE)
    .select(MAP_TRIP_PROJECTION_COLUMNS.join(", "))
    .in("trip_id", tripIds);

  // supabase-js RESOLVES on a database error. Reading `data ?? []` here and
  // skipping `error` is the whole defect: an empty projection and a broken
  // one look identical on a map.
  if (error) {
    // PostgREST's schema cache can lag a DDL, so a rejection AFTER the probe
    // passed is evidence the probe is stale. Feed it back so the next request
    // takes the canonical branch instead of failing again.
    if (isMissingSchemaError(error)) {
      markSchemaMissing(sc, MAP_TRIP_PROJECTION_CAPABILITY, error);
    }
    logger.error(
      { err: error, viewerId, capability: MAP_TRIP_PROJECTION_CAPABILITY.flag },
      "map trip projection: the projection read FAILED — the trip layer is refused, not served empty",
    );
    report.refusal = "projection_read_failed";
    return { report, trips: null };
  }

  const rows = Array.isArray(data) ? (data as TripMapProjectionRow[]) : [];
  report.rows = rows.length;

  const fold = foldTripProjectionRows(rows);
  report.staleIgnored = fold.counts.staleIgnored;
  report.duplicatesIgnored = fold.counts.duplicatesIgnored;
  report.invalidRows = fold.counts.invalid;
  report.maxSourceTripVersion = fold.maxSourceTripVersion;
  report.contractVersion = fold.minMapContractVersion;

  if (fold.minProjectionSchemaVersion !== null
      && fold.minProjectionSchemaVersion !== EXPECTED_PROJECTION_SCHEMA_VERSION) {
    logger.error(
      {
        capability: MAP_TRIP_PROJECTION_CAPABILITY.flag,
        found: fold.minProjectionSchemaVersion,
        expected: EXPECTED_PROJECTION_SCHEMA_VERSION,
      },
      "map trip projection: projection_schema_version is not the body shape this reader understands — layer refused",
    );
    report.refusal = "projection_schema_unexpected";
    return { report, trips: null };
  }

  if (fold.minMapContractVersion !== null && fold.minMapContractVersion < MAP_TRIP_CONTRACT_VERSION) {
    logger.error(
      {
        capability: MAP_TRIP_PROJECTION_CAPABILITY.flag,
        found: fold.minMapContractVersion,
        expected: MAP_TRIP_CONTRACT_VERSION,
        providedBy: MAP_TRIP_PROJECTION_CAPABILITY.providedBy,
      },
      "map trip projection: a projection row predates the Map anchor (2610) — the whole layer is refused rather than drawn with a pin missing",
    );
    report.refusal = "projection_contract_stale";
    return { report, trips: null };
  }

  const trips: TripViewLike[] = [];
  for (const row of fold.rows.values()) {
    if (!isProjectionRowMapEligible(row)) continue;
    report.eligible += 1;
    const view = projectionRowToTripView(row);
    if (view) trips.push(view);
  }
  report.served = trips.length;
  return { report, trips };
}

/**
 * THE ENTRY POINT routes/mapProjection.ts calls for the `trip_stop` layer.
 *
 * Never throws: a thrown client is caught and reported as a refusal on the
 * branch that was attempted, because a map layer must not be able to take the
 * whole gateway down.
 */
export async function readTripStopLayer(sc: any, viewerId: string): Promise<TripLayerRead> {
  let verdict: CapabilityVerdict;
  try {
    verdict = await resolveCapability(sc, MAP_TRIP_PROJECTION_CAPABILITY);
  } catch (err) {
    // resolveCapability is documented never to throw; if it ever does, that is
    // an unknown state and unknown is not ready.
    logger.error({ err }, "map trip projection: capability resolve threw — falling back to canonical");
    verdict = {
      capability: MAP_TRIP_PROJECTION_CAPABILITY.flag,
      enabled: false,
      flag: "unreadable",
      schema: null,
      reason: "flag_unreadable",
    };
  }

  const capability: TripLayerCapabilityReport = {
    flag: verdict.flag,
    reason: verdict.reason,
    schema: verdict.schema?.state ?? null,
    missing: verdict.schema?.missing ?? [],
  };

  if (verdict.enabled) {
    try {
      return await readFromProjection(sc, viewerId, capability);
    } catch (err) {
      logger.error({ err, viewerId }, "map trip projection: projection read threw — layer refused");
      const report = emptyReport("projection", capability);
      report.refusal = "projection_read_failed";
      return { report, trips: null };
    }
  }

  // ── The not-ready branch: exactly what ran before this file existed. ──────
  const report = emptyReport("canonical", capability);
  try {
    const legacy = await loadViewerTripsCanonical(sc, viewerId);
    report.scoped = legacy.scoped;
    report.refusal = legacy.refusal;
    report.served = legacy.trips?.length ?? 0;
    return { report, trips: legacy.trips };
  } catch (err) {
    logger.warn({ err, viewerId }, "map trip projection: canonical trip read threw");
    report.refusal = "canonical_read_failed";
    return { report, trips: null };
  }
}
