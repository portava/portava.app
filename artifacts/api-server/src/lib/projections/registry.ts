/**
 * The projection registry — every STORED projection this server produces, and
 * who consumes it.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
 * DECORATIVE ARCHITECTURE: a producer that runs, a table that fills, and nothing
 * that reads it. Every piece looks correct in isolation. The worker has tests,
 * the table has a migration, the scheduler is registered — and the feature does
 * not exist, because the last hop was never built. Nothing fails; the rows just
 * sit there.
 *
 * It is the mirror of the defect `checkWriterlessReads.ts` catches (a read whose
 * table nothing writes, so it returns zero rows forever). The two together say:
 * data must be able to flow BOTH ways along every declared pipe.
 *
 * ── WHY A REGISTRY AND NOT A PURE SCAN ───────────────────────────────────────
 * A pure scan cannot tell a consumerless projection from one whose consumer it
 * simply failed to see, and this codebase has both traps:
 *
 *   * `trip_map_projections` is read through the CONSTANT
 *     `TRIP_MAP_PROJECTIONS_TABLE`, not a string literal. A literal-only scan
 *     reports "no consumer" for a fully wired chain — a false failure on the
 *     exact feature this check was written for.
 *   * It is written by the SQL function `trip_map_projection_drain`, not by
 *     `.from(...).insert(...)`. A literal-only scan does not see the producer
 *     either.
 *
 * So the registry states intent, the checker VERIFIES that intent against the
 * tree (resolving constants and RPC producers), and a separate discovery rule
 * fails on any projection-shaped writer that is not registered at all. The
 * registry cannot be used to hide a projection: leaving one out is itself a
 * failure.
 *
 * ── KINDS ────────────────────────────────────────────────────────────────────
 *   projection  must have at least one consumer OTHER than its own producer.
 *   queue       work-queue read back by its own worker; self-consumption is the
 *               point. Requires a reason.
 *   backfill    writes canonical tables that already have consumers; there is no
 *               separate storage to strand. Requires a reason.
 *   sink        deliberately write-only (audit/telemetry). Requires a reason,
 *               and the reason must say who reads it OUT OF BAND, because
 *               "nobody reads it" is the defect, not an exemption.
 */

export type ProjectionKind = "projection" | "queue" | "backfill" | "sink";

export type ProjectionEntry = {
  /** Stable key for the report. */
  key: string;
  kind: ProjectionKind;
  /** Storage table(s) the producer writes. */
  storage: readonly string[];
  /** Files that write the storage. */
  producers: readonly string[];
  /**
   * SQL functions that write the storage on the producer's behalf. A producer
   * that only calls an RPC has no visible `.insert(...)`; naming the function
   * here is what makes that producer verifiable.
   */
  producerFunctions?: readonly string[];
  /** Files that READ the storage. Must be non-empty for kind "projection". */
  consumers: readonly string[];
  /** For asynchronous producers: the entry point that starts them. */
  scheduler?: { starts: string; from: string };
  /** Required for queue / backfill / sink. */
  reason?: string;
};

export const PROJECTIONS: readonly ProjectionEntry[] = [
  {
    key: "TRIP_MAP_PROJECTION",
    kind: "projection",
    storage: ["trip_map_projections"],
    producers: ["lib/mapTripProjectionWorker.ts"],
    producerFunctions: ["trip_map_projection_drain", "trip_map_projection_rebuild"],
    consumers: ["lib/mapProjectionTripRead.ts"],
    scheduler: { starts: "startTripMapProjectionScheduler", from: "index.ts" },
  },
  {
    key: "INTEL_STATE_SNAPSHOTS",
    kind: "projection",
    storage: ["intel_state_snapshots"],
    producers: ["lib/intelProjection.ts", "lib/intelProjectionScheduler.ts"],
    consumers: [
      "lib/liveClaimRead.ts",
      "routes/intelReadModels.ts",
      "lib/mapProducers/safetyNoticeProducer.ts",
    ],
    scheduler: { starts: "startIntelProjectionScheduler", from: "index.ts" },
  },
  {
    key: "INTEL_SNAPSHOT_VERSIONS",
    kind: "projection",
    storage: ["intel_state_snapshot_versions"],
    producers: ["lib/intelProjection.ts"],
    consumers: ["lib/intelReplay.ts", "routes/mapProjectionTemporal.ts"],
  },
  {
    key: "MEDIA_DEDUP_GROUPS",
    kind: "projection",
    storage: ["media_dedup_groups"],
    producers: ["lib/media/mediaDedupWorker.ts"],
    consumers: ["routes/placeLiving.ts", "routes/places.ts"],
  },
  {
    key: "MEDIA_DEDUP_MEMBERSHIPS",
    kind: "queue",
    storage: ["media_dedup_memberships"],
    producers: ["lib/media/mediaDedupWorker.ts"],
    consumers: ["lib/media/mediaDedupWorker.ts"],
    reason:
      "Membership rows are the worker's own bookkeeping: it reads them back to decide whether an " +
      "asset already belongs to a group before creating another. The GROUP table (MEDIA_DEDUP_GROUPS) " +
      "is the externally consumed half. Self-consumption here is the design, not a stranded projection.",
  },
  {
    key: "PLACE_COLLECTIONS",
    kind: "projection",
    storage: ["place_best_of", "place_living_cache", "place_top_contributors"],
    producers: ["lib/places/placeCollectionsWorker.ts"],
    consumers: ["lib/places/placeCollections.ts", "routes/placeLiving.ts"],
  },
  {
    key: "PLACE_CACHE_INVALIDATION",
    kind: "queue",
    storage: ["place_cache_invalidation_queue"],
    producers: ["lib/places/placeCollectionsWorker.ts"],
    consumers: ["lib/places/placeCollectionsWorker.ts"],
    reason:
      "A work queue: the worker enqueues invalidations and drains them on the next pass. Read back " +
      "only by its own worker by construction.",
  },
  {
    key: "STAMP_ARTWORK",
    kind: "projection",
    storage: ["universal_stamp_catalog", "stamp_artwork_versions"],
    producers: ["lib/stamps/generationWorker.ts"],
    consumers: ["routes/stampCatalog.ts", "routes/passport.ts", "lib/stamps/StampCatalogService.ts"],
  },
  {
    key: "STAMP_GENERATION_QUEUE",
    kind: "queue",
    storage: ["stamp_generation_queue"],
    producers: ["lib/stamps/generationWorker.ts"],
    consumers: ["lib/stamps/generationWorker.ts", "routes/stampCatalog.ts"],
    reason:
      "Generation work queue. The worker drains it; routes/stampCatalog.ts additionally exposes queue " +
      "depth, so it is not even purely self-consuming.",
  },
  {
    key: "GENERATED_VISUALS",
    kind: "projection",
    storage: ["generated_visuals"],
    producers: ["lib/visuals/generationWorker.ts"],
    consumers: ["lib/visuals/service.ts", "lib/mediaAccess.ts", "routes/visuals.ts"],
  },
  {
    key: "POST_PLACE_BACKFILL",
    kind: "backfill",
    storage: ["posts"],
    producers: ["lib/places/postPlaceBackfillWorker.ts"],
    consumers: ["routes/posts.ts"],
    reason:
      "Not a projection: it backfills place_id onto the CANONICAL posts table, which already has " +
      "dozens of readers. There is no separate storage that could be stranded, so the " +
      "consumerless-projection defect cannot apply.",
  },
  {
    key: "MEDIA_POST_DEDUP_WRITEBACK",
    kind: "backfill",
    storage: ["post_media"],
    producers: ["lib/media/mediaDedupWorker.ts"],
    consumers: ["lib/postMediaResolve.ts", "routes/posts.ts"],
    reason:
      "Writes dedup results back onto the canonical post_media rows rather than into a projection of " +
      "its own. post_media has many readers; nothing is stranded.",
  },
];

export function projectionFor(table: string): ProjectionEntry | null {
  return PROJECTIONS.find((p) => p.storage.includes(table)) ?? null;
}
