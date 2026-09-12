/**
 * Trips spec §19.1 — the projection envelope, and the consumer rule for it.
 *
 * §19.1, verbatim:
 *
 *   Every projection includes generatedAt, sourceTripVersion,
 *   projectionSchemaVersion, and freshness status. Consumers reject or
 *   visibly degrade on stale/incompatible critical projections.
 *
 * And §22.4's invariant on the same fields:
 *
 *   Projection sourceTripVersion may never exceed canonical aggregate version.
 *
 * WHAT WAS THERE BEFORE
 * =====================
 * census-trips TR364-TR367 graded the four fields N, then §39 re-derived them
 * W: ONE projection (lib/tripDiscoveryProjection.ts) carried all four, with
 * its own schema constant and its own freshness type, and the §19.1 list
 * TR356-TR363 carried none. TR358's map projection (services/trips/
 * TripMapProjection.ts) carried two of the four. Three shapes of "envelope"
 * is how a consumer ends up checking the wrong one.
 *
 * This is the one envelope. The four field names are the spec's; the type is
 * what every §19.1 projection route spreads into its response, and
 * acceptTripProjection is what every in-process consumer calls before using
 * one. The discovery projection keeps its own schema constant (its shape has
 * its own history) but its consumer now decides through the same function.
 *
 * FRESHNESS IS A CLAIM, AND ONLY TWO VALUES ARE TRUE TODAY
 * ========================================================
 *   "live"            generated from canonical rows in the request that
 *                     served it, and attributable to a trip version.
 *   "unattributable"  generated live, but `trips.version` could not be read,
 *                     so `sourceTripVersion` is null and the projection must
 *                     not be cached, compared, or used to conclude that
 *                     nothing changed. (TripMapProjection.isAttributable is
 *                     the same rule, older.)
 *   "cached"/"stale"  DECLARED, NOT EMITTED. No projection worker exists
 *                     (§19.4, TR379); nothing in this process produces a
 *                     cached projection. They are in the type so a consumer
 *                     written today already refuses them, and so the census
 *                     can say "declared, not emitted" precisely.
 *
 * `sourceTripVersion` is `trips.version` (2420) — the kernel's aggregate
 * version — and NOTHING ELSE. A default of 0 would be a version claim, so an
 * unreadable version is null and the freshness says so.
 */
import { logger } from "../../lib/logger.js";
import { observeTripMetric } from "../../lib/tripMetrics.js";

const log = logger.child({ mod: "tripProjectionEnvelope" });

/** Bump on rename / removal / meaning change of an envelope field. Additive changes do not bump. */
export const TRIP_PROJECTION_SCHEMA_VERSION = 1 as const;

export const TRIP_PROJECTION_FRESHNESS = ["live", "cached", "stale", "unattributable"] as const;
export type TripProjectionFreshness = (typeof TRIP_PROJECTION_FRESHNESS)[number];

/** §19.1's four fields. Every §19.1 projection response spreads one of these. */
export interface TripProjectionEnvelope {
  projectionSchemaVersion: number;
  /** ISO instant the projection was generated. */
  generatedAt: string;
  /** trips.version; null when unreadable — see the header. */
  sourceTripVersion: number | null;
  freshness: TripProjectionFreshness;
}

/** The envelope for a projection generated from canonical rows in this request. */
export function liveEnvelope(sourceTripVersion: number | null, now: Date = new Date()): TripProjectionEnvelope {
  return {
    projectionSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    sourceTripVersion,
    freshness: sourceTripVersion === null ? "unattributable" : "live",
  };
}

/**
 * `trips.version`, or null when it could not be read. Read BEFORE the rows a
 * projection is assembled from, so the version names the state the rows were
 * read against rather than a state observed after them — routes/
 * tripMapProjection.ts established that order and the reason for it.
 */
export async function readTripVersion(sc: any, tripId: string): Promise<number | null> {
  const { data, error } = await sc.from("trips").select("version").eq("id", tripId).maybeSingle();
  if (error) { log.warn({ err: error.message, tripId }, "trip version unreadable — projection will be unattributable"); return null; }
  const v = (data as any)?.version;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── §19.1 consumer rule ─────────────────────────────────────────────────────

export type TripProjectionRefusal =
  | "TRIP_PROJECTION_SCHEMA_MISMATCH"
  | "TRIP_PROJECTION_VERSION_AHEAD"
  | "TRIP_PROJECTION_STALE";

export interface AcceptTripProjectionOptions {
  /** The schema version THIS consumer can read. A consumer names it; it is not read off the projection. */
  acceptedSchemaVersion: number;
  /**
   * The canonical aggregate version, when the consumer knows it. §22.4: a
   * projection AHEAD of it describes a state the aggregate has not reached
   * and is refused. Omit when unknown; null means "known to be unreadable",
   * which cannot refuse anything.
   */
  canonicalVersion?: number | null;
  /** Reject a projection older than this. Omit for no age limit. */
  maxAgeSeconds?: number;
  /** For tests. Milliseconds since epoch. */
  now?: number;
  /** Label under which projection_lag_seconds is recorded, e.g. "TripCompassProjection". */
  metric?: string;
}

export type AcceptTripProjectionDecision =
  | { accepted: true; lagSeconds: number }
  | { accepted: false; reason: TripProjectionRefusal; message: string };

/**
 * §19.1: may this consumer use this projection? Three refusals, in the order
 * a consumer can actually evaluate them:
 *
 *   1. SCHEMA_MISMATCH — the envelope is not a shape this consumer reads. It
 *      is checked first because nothing after it can be trusted to be there.
 *      An unparseable `generatedAt` is the same refusal: an envelope whose
 *      instant is not an instant is not this schema.
 *   2. VERSION_AHEAD — §22.4. Only when both versions are numbers.
 *   3. STALE — the projection SAYS it is stale, or it is older than the
 *      consumer allows. "unattributable" is NOT stale: it is live and
 *      unversioned, and a consumer that needs a version reads
 *      `sourceTripVersion === null` itself.
 *
 * On acceptance, `projection_lag_seconds` is observed (§21.1) — see
 * lib/tripMetrics.ts for why the consumer records it and not the producer.
 */
export function acceptTripProjection(
  p: TripProjectionEnvelope,
  opts: AcceptTripProjectionOptions,
): AcceptTripProjectionDecision {
  const now = opts.now ?? Date.now();

  if (typeof p?.projectionSchemaVersion !== "number" || p.projectionSchemaVersion !== opts.acceptedSchemaVersion) {
    return {
      accepted: false, reason: "TRIP_PROJECTION_SCHEMA_MISMATCH",
      message: `projectionSchemaVersion ${String(p?.projectionSchemaVersion)} is not the accepted ${opts.acceptedSchemaVersion}`,
    };
  }
  const generated = Date.parse(p.generatedAt);
  if (!Number.isFinite(generated)) {
    return { accepted: false, reason: "TRIP_PROJECTION_SCHEMA_MISMATCH", message: "generatedAt is not an instant" };
  }

  if (typeof opts.canonicalVersion === "number" && typeof p.sourceTripVersion === "number"
      && p.sourceTripVersion > opts.canonicalVersion) {
    return {
      accepted: false, reason: "TRIP_PROJECTION_VERSION_AHEAD",
      message: `sourceTripVersion ${p.sourceTripVersion} exceeds the canonical aggregate version ${opts.canonicalVersion} (§22.4)`,
    };
  }

  const lagSeconds = Math.max(0, (now - generated) / 1000);
  if (p.freshness === "stale") {
    return { accepted: false, reason: "TRIP_PROJECTION_STALE", message: "the projection declares itself stale" };
  }
  if (opts.maxAgeSeconds !== undefined && lagSeconds > opts.maxAgeSeconds) {
    return {
      accepted: false, reason: "TRIP_PROJECTION_STALE",
      message: `generated ${lagSeconds.toFixed(1)}s ago; this consumer accepts at most ${opts.maxAgeSeconds}s`,
    };
  }

  observeTripMetric("projection_lag_seconds", { projection: opts.metric ?? "unknown" }, lagSeconds);
  return { accepted: true, lagSeconds };
}
