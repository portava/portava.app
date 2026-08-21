import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { classifyJourneyObservationTrust } from "../location/LocationSafetyService.js";
import {
  scoreObservationQuality,
} from "./JourneyObservationQuality.js";

export const JOURNEY_MASTER_FLAG = "COMPASS_JOURNEY_ENGINE_ENABLED";
export const JOURNEY_INGEST_FLAG = "COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED";
export const JOURNEY_SHADOW_FLAG = "COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED";
export const GLOBAL_LOCATION_STOP_FLAG = "disable_location_sharing";

/**
 * The implementation performs an uncached DB read per batch, so its actual
 * bound is one DB round trip. This exported ceiling makes the privacy contract
 * explicit and testable.
 */
export const JOURNEY_CONTROL_MAX_PROPAGATION_MS = 5_000;
export const JOURNEY_RAW_TTL_MS = 24 * 60 * 60 * 1_000;
export const JOURNEY_MAX_BATCH_SIZE = 25;

const worldRefSchema = z
  .object({
    countryCode: z.string().trim().min(2).max(3).nullable().optional(),
    regionId: z.string().trim().min(1).max(128).nullable().optional(),
    cityId: z.string().trim().min(1).max(128).nullable().optional(),
    districtId: z.string().trim().min(1).max(128).nullable().optional(),
    placeId: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict()
  .refine(
    (world) => Object.values(world).some((value) => typeof value === "string" && value.length > 0),
    "At least one coarse world reference is required",
  );

const commonSchema = {
  version: z.literal(1),
  locationSessionId: z.string().uuid(),
  observedAt: z.string().datetime({ offset: true }),
  consentScope: z.literal("journey_observation_v1"),
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
};

const gpsObservationSchema = z
  .object({
    ...commonSchema,
    source: z.enum(["foreground_gps", "background_gps"]),
    exact: z
      .object({
        lat: z.number().finite().min(-90).max(90),
        lng: z.number().finite().min(-180).max(180),
        accuracyM: z.number().finite().positive().max(10_000),
        speedMps: z.number().finite().min(0).max(350).nullable().optional(),
        headingDeg: z.number().finite().min(0).lt(360).nullable().optional(),
      })
      .strict(),
  })
  .strict();

const coarseObservationSchema = z
  .object({
    ...commonSchema,
    source: z.enum(["plan_checkin", "manual"]),
    world: worldRefSchema,
  })
  .strict();

export const journeyObservationSchema = z.discriminatedUnion("source", [
  gpsObservationSchema,
  coarseObservationSchema,
]);

export type JourneyObservationInput = z.infer<typeof journeyObservationSchema>;

export type JourneyObservationResult =
  | { index: number; status: "accepted" }
  | { index: number; status: "deduplicated" }
  | {
      index: number;
      status: "rejected";
      code:
        | "invalid_observation"
        | "feature_disabled"
        | "not_authorized"
        | "temporarily_unavailable";
    };

type IndexedObservation = { index: number; observation: JourneyObservationInput };

interface JourneyControls {
  enabled: boolean;
  available: boolean;
}

/**
 * Direct, uncached read. The 30-second cache in compass/flags.ts is never used
 * for this authorization decision.
 */
export async function readJourneyIngestionControls(
  db: SupabaseClient,
): Promise<JourneyControls> {
  try {
    const { data, error } = await db
      .from("feature_flags")
      .select("flag, enabled")
      .in("flag", [
        JOURNEY_MASTER_FLAG,
        JOURNEY_INGEST_FLAG,
        "COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED",
        GLOBAL_LOCATION_STOP_FLAG,
      ]);

    if (error) return { enabled: false, available: false };
    const flags = new Map(
      ((data as Array<{ flag: string; enabled: boolean }> | null) ?? []).map((row) => [
        row.flag,
        row.enabled === true,
      ]),
    );
    if (
      !flags.has(JOURNEY_MASTER_FLAG)
      || !flags.has(JOURNEY_INGEST_FLAG)
      || !flags.has("COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED")
      || !flags.has(GLOBAL_LOCATION_STOP_FLAG)
    ) {
      return { enabled: false, available: false };
    }
    return {
      available: true,
      enabled:
        flags.get(JOURNEY_MASTER_FLAG) === true
        && flags.get(JOURNEY_INGEST_FLAG) === true
        && flags.get("COMPASS_JOURNEY_SEGMENTATION_SHADOW_ENABLED") === true
        && flags.get(GLOBAL_LOCATION_STOP_FLAG) !== true,
    };
  } catch {
    return { enabled: false, available: false };
  }
}

async function insertObservation(
  db: SupabaseClient,
  userId: string,
  item: IndexedObservation,
  receivedAt: Date,
): Promise<JourneyObservationResult> {
  const { observation, index } = item;
  const gps =
    observation.source === "foreground_gps" || observation.source === "background_gps"
      ? observation.exact
      : null;
  const trustClass = classifyJourneyObservationTrust(
    gps?.accuracyM ?? null,
    gps?.speedMps ?? null,
  );
  const quality = scoreObservationQuality(
    {
      observedAt: observation.observedAt,
      source: observation.source,
      accuracyM: gps?.accuracyM ?? null,
      speedMps: gps?.speedMps ?? null,
    },
    receivedAt,
  );

  try {
    const { data, error } = await db.rpc("ingest_journey_observation_v2", {
      p_user_id: userId,
      p_location_session_id: observation.locationSessionId,
      p_event_version: observation.version,
      p_observed_at: observation.observedAt,
      p_source: observation.source,
      p_lat: gps?.lat ?? null,
      p_lng: gps?.lng ?? null,
      p_accuracy_m: gps?.accuracyM ?? null,
      p_speed_mps: gps?.speedMps ?? null,
      p_heading_deg: gps?.headingDeg ?? null,
      p_world_ref:
        observation.source === "plan_checkin" || observation.source === "manual"
          ? observation.world
          : null,
      p_consent_scope: observation.consentScope,
      p_idempotency_key: observation.idempotencyKey,
      p_trust_class: trustClass,
      p_quality_version: quality.version,
      p_quality_score: quality.score,
      p_quality_class: quality.qualityClass,
      p_quality_reasons: quality.reasons,
    });

    if (error) {
      return { index, status: "rejected", code: "temporarily_unavailable" };
    }
    if (data === "accepted") return { index, status: "accepted" };
    if (data === "deduplicated") return { index, status: "deduplicated" };
    if (data === "feature_disabled") {
      return { index, status: "rejected", code: "feature_disabled" };
    }
    if (data === "not_authorized") {
      return { index, status: "rejected", code: "not_authorized" };
    }
    if (data === "temporarily_unavailable") {
      return { index, status: "rejected", code: "temporarily_unavailable" };
    }
    return { index, status: "rejected", code: "temporarily_unavailable" };
  } catch {
    return { index, status: "rejected", code: "temporarily_unavailable" };
  }
}

export async function ingestJourneyObservationBatch(
  db: SupabaseClient,
  userId: string,
  items: IndexedObservation[],
  receivedAt = new Date(),
): Promise<JourneyObservationResult[]> {
  if (items.length === 0) return [];

  const controls = await readJourneyIngestionControls(db);
  if (!controls.enabled) {
    const code = controls.available ? "feature_disabled" : "temporarily_unavailable";
    return items.map(({ index }) => ({ index, status: "rejected", code }));
  }

  const results: JourneyObservationResult[] = [];
  for (const item of items) {
    results.push(await insertObservation(db, userId, item, receivedAt));
  }
  return results;
}