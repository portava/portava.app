/**
 * Independent retention enforcement for sensitive Journey segment revisions.
 * Runs regardless of Journey feature-flag state.
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

export const JOURNEY_SEGMENT_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const JOURNEY_SEGMENT_PURGE_STARTUP_DELAY_MS = 60 * 1_000;
export const JOURNEY_SEGMENT_EXPIRED_ALERT_AGE_MS = 60 * 60 * 1_000;

interface JourneySegmentRetentionStatus {
  lastRunAt: string | null;
  lastDeletedCount: number | null;
  oldestExpiredAgeMs: number | null;
  failureCount: number;
  lastOutcome: "success" | "error" | "skipped" | null;
}

const status: JourneySegmentRetentionStatus = {
  lastRunAt: null,
  lastDeletedCount: null,
  oldestExpiredAgeMs: null,
  failureCount: 0,
  lastOutcome: null,
};

export function getJourneySegmentRetentionStatus(): Readonly<JourneySegmentRetentionStatus> {
  return { ...status };
}

function isMissingPurgeRpc(error: any): boolean {
  return error?.code === "42883" ||
    error?.code === "PGRST202" ||
    /purge_expired_journey_shadow_table_v1.*does not exist|could not find.*purge_expired_journey_shadow_table_v1/i.test(
      error?.message ?? "",
    );
}


export interface JourneyConsentRevocationPatch {
  location_mode?: "off" | "city_only" | "nearby" | "live_during_activity" | "trusted_circle_live";
  sharing_paused?: boolean;
  pulse_visibility?: "city_only" | "neighborhood" | "venue_tagged" | "exact_hidden" | "no_location" | null;
  discovery_visibility?: "city_only" | "neighborhood" | "venue_tagged" | "exact_hidden" | "no_location" | null;
  safe_return_enabled?: boolean;
  trusted_circle_share?: boolean;
  hotel_blur_enabled?: boolean;
  journey_observation_enabled?: boolean;
}

export function revokesJourneyConsent(
  preferences: JourneyConsentRevocationPatch,
): boolean {
  return preferences.sharing_paused === true ||
    preferences.journey_observation_enabled === false ||
    (
      preferences.location_mode !== undefined &&
      preferences.location_mode !== "live_during_activity" &&
      preferences.location_mode !== "trusted_circle_live"
    );
}

export async function revokeJourneyConsentAndDeleteSegments(
  client: any,
  userId: string,
  preferences: JourneyConsentRevocationPatch,
): Promise<number> {
  if (!revokesJourneyConsent(preferences)) {
    throw new Error(
      "Journey revocation must pause sharing or select a non-authorizing location mode",
    );
  }

  const result = await client.rpc("revoke_journey_consent_and_delete_segments", {
    p_user_id: userId,
    p_preferences: preferences,
  });
  if (!result.error) return Number(result.data ?? 0);

  // Fail closed. The atomic revocation RPC is the ONLY sanctioned path: it
  // applies the preference patch AND erases derived segments in one
  // transaction. service_role has no direct SELECT/DELETE on
  // journey_segment_revisions, so there is no safe split-write fallback that
  // could probe the table or guarantee erasure — a non-atomic preference-only
  // write could silently leave sensitive derived segments behind. Surface the
  // error (whether the RPC is missing or failed) rather than acknowledge a
  // revoke that may not have erased anything.
  throw result.error;
}

export async function purgeExpiredJourneySegments(opts?: {
  client?: any;
  now?: Date;
}): Promise<{
  deleted: number | null;
  oldestExpiredAgeMs: number | null;
  error: unknown;
  skipped: boolean;
}> {
  const client = opts?.client ?? (isServiceClientReady ? getServiceClient() : null);
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  status.lastRunAt = nowIso;

  if (!client) {
    status.lastOutcome = "skipped";
    status.lastDeletedCount = null;
    return { deleted: null, oldestExpiredAgeMs: null, error: null, skipped: true };
  }

  try {
    // service_role no longer has direct SELECT/DELETE on
    // journey_segment_revisions. Expired-row deletion + oldest-age reporting go
    // through the SECURITY DEFINER maintenance RPC, which computes oldest-before,
    // deletes expired rows, and reports oldest-after in one transaction —
    // returning aggregate-only {deletedCount, oldestBeforeAgeMs, oldestAfterAgeMs}
    // (never rows/IDs/coordinates).
    const { data, error } = await client.rpc("purge_expired_journey_shadow_table_v1", {
      p_kind: "segment",
      p_now: nowIso,
    });
    if (error) {
      // Deploy-before-migration: if the RPC itself is absent, there is nothing
      // to purge yet — skip without recording a failure. The table is guaranteed
      // to also be absent in that ordering (the RPC ships in the same migration
      // that revokes direct access), so no derived rows can be stranded.
      if (isMissingPurgeRpc(error)) {
        status.lastOutcome = "skipped";
        status.lastDeletedCount = null;
        return { deleted: null, oldestExpiredAgeMs: null, error: null, skipped: true };
      }
      throw error;
    }

    const row = (data ?? {}) as {
      deletedCount?: unknown;
      oldestBeforeAgeMs?: unknown;
      oldestAfterAgeMs?: unknown;
    };
    const deleted = Number.isFinite(Number(row.deletedCount)) ? Number(row.deletedCount) : 0;
    // Report the remaining (post-deletion) oldest age so a purge backlog stays
    // visible; a clean purge leaves this null.
    const rawAfter = Number(row.oldestAfterAgeMs);
    const oldestExpiredAgeMs = Number.isFinite(rawAfter) && rawAfter >= 0 ? rawAfter : null;

    status.lastDeletedCount = deleted;
    status.oldestExpiredAgeMs = oldestExpiredAgeMs;
    status.lastOutcome = "success";
    logger.info(
      {
        deleted,
        oldest_expired_age_ms: oldestExpiredAgeMs,
        failure_count: status.failureCount,
      },
      "journey segment retention purge completed",
    );
    if (
      oldestExpiredAgeMs != null &&
      oldestExpiredAgeMs >= JOURNEY_SEGMENT_EXPIRED_ALERT_AGE_MS
    ) {
      logger.error(
        { oldest_expired_age_ms: oldestExpiredAgeMs },
        "journey segment retention backlog exceeded alert threshold",
      );
    }
    return { deleted, oldestExpiredAgeMs, error: null, skipped: false };
  } catch (error) {
    status.failureCount += 1;
    status.lastDeletedCount = null;
    status.lastOutcome = "error";
    logger.error(
      { err: error, failure_count: status.failureCount },
      "journey segment retention purge failed",
    );
    return {
      deleted: null,
      oldestExpiredAgeMs: status.oldestExpiredAgeMs,
      error,
      skipped: false,
    };
  }
}

export async function deleteJourneySegmentsForUser(
  client: any,
  userId: string,
): Promise<number> {
  // Erasure goes ONLY through the sealed SECURITY DEFINER RPC
  // delete_journey_segments_for_user (per-user advisory lock). service_role has
  // no direct DELETE on journey_segment_revisions, so there is no table-level
  // fallback — surface any RPC error (including a missing RPC) rather than
  // silently degrade to an unauthorized/no-op path.
  if (typeof client.rpc !== "function") {
    throw new Error("Journey segment deletion requires the sealed delete_journey_segments_for_user RPC");
  }
  const rpcResult = await client.rpc("delete_journey_segments_for_user", {
    p_user_id: userId,
  });
  if (rpcResult.error) throw rpcResult.error;
  return Number(rpcResult.data ?? 0);
}

// NOTE: There is no independent segment-retention scheduler. Expired derived
// segments are purged by the unified Journey retention cycle
// (runJourneyRetentionCycle in journeyObservationPurge.ts), which calls
// purge_expired_journey_shadow_table_v1('segment') alongside observations and
// ground truth. purgeExpiredJourneySegments remains exported for that cycle and
// for tests, but this module intentionally owns no setInterval of its own.
