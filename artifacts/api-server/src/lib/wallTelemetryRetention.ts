/**
 * Wall telemetry retention — deletes `wall_telemetry_events` rows once their
 * `expires_at` has passed.
 *
 * WHY. 2308_wall_telemetry_events.sql stamps every row with a viewer id and an
 * `expires_at` (90 days), and until this sweep nothing ever deleted a row past
 * it: the column was a promise with nothing keeping it — the same defect 2960
 * fixed for Map telemetry. OD-INPUT-2 keeps per-user behavioural data 30 days and
 * then deletes it (Q11(a) agrees, as the analogue); migration 3702 moves the default to 30 days and
 * shortens rows already stamped later, and this is the delete.
 *
 * FLAGLESS, as runInputOutcomeRetentionSweep is: a retention control shipped
 * switched off declares a promise and does not keep it. Whether the Wall
 * COLLECTS telemetry is `wall_enabled`'s business; it must never decide whether
 * expired rows are deleted, or switching collection off would strand exactly the
 * rows someone just decided they did not want kept.
 *
 * service_role holds DELETE on the table (2308) and
 * wall_telemetry_events_expiry_idx exists for this predicate, so no purge
 * function is needed. A count is logged and nothing else: WHICH viewers' events
 * expired is not a log fact.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import type { SweepResult } from "./intelRetentionScheduler.js";

export const WALL_TELEMETRY_RETENTION_DAYS = 30;

export async function runWallTelemetryRetentionSweep(
  opts: { client?: unknown; now?: Date } = {},
): Promise<SweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  const db = ("client" in opts && opts.client !== undefined ? opts.client : getServiceClient()) as SupabaseClient | null;
  if (!db) return { purged: 0, skipped: true, reason: "no_client" };
  const nowIso = (opts.now ?? new Date()).toISOString();
  try {
    const { error, count } = await db
      .from("wall_telemetry_events")
      .delete({ count: "exact" })
      .lte("expires_at", nowIso);
    if (error) {
      // An absent table (3702/2308 unapplied) or a failed delete is a FAILED
      // sweep — never "nothing had expired".
      logger.warn({ err: error }, "wall telemetry retention sweep failed");
      return { purged: 0, skipped: true, reason: "error" };
    }
    const purged = Number(count) || 0;
    if (purged > 0) logger.info({ purged }, "wall telemetry retention removed expired rows");
    return { purged, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "wall telemetry retention sweep threw");
    return { purged: 0, skipped: true, reason: "error" };
  }
}
