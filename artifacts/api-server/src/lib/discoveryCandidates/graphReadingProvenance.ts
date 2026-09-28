/**
 * The served graph reading's provenance — census-discovery §85 (lane W10-R3),
 * H-P21-4 (DC-17's last leg, §75.3).
 *
 * `graphReadingOf` (lib/discoveryPde.ts) copies the `CityConfidence` the
 * modifiers consumed; it carried `computedAt` and no model version, feature
 * version or window. Under `compass_city_confidence_windowed_reads_enabled`
 * (3484) the Compass producer writes those three onto `compass_city_confidence`
 * (compass/cityConfidenceWindowedReads.ts). This reads them back FOR THE SAME
 * READING — the row's `computed_at` must equal the reading's — and says, in
 * every other case, why the reading has no record:
 *
 *   recorded           all four facts, from the producer that computed the row
 *   platform_producer  CPV2-12: the platform's coverage store answered, and
 *                      Compass never writes that store or re-runs its
 *                      producer (§75.3 blocker 3) — a Compass version stamped
 *                      here would be false exactly on this path
 *   not_recorded       the row was written with the flag off (or before 3484)
 *   reading_moved      a rebuild overwrote the row between the two reads
 *   columns_absent     3484 is not applied (42703 / PGRST204)
 *   read_failed        any other failure
 *
 * Provenance only: nothing here is read back into a score or an order.
 */
import type { PdeGraphReading } from "../discoveryPde.js";

export interface GraphReadingProvenance {
  status: "recorded" | "platform_producer" | "not_recorded" | "reading_moved" | "columns_absent" | "read_failed";
  modelVersion?: string;
  featureVersion?: string;
  sourceWindow?: unknown;
  computedAt?: string;
}

function isMissingColumn(e: unknown): boolean {
  const c = (e as { code?: unknown } | null)?.code;
  return c === "42703" || c === "PGRST204";
}

export async function loadGraphReadingProvenance(sc: any, reading: PdeGraphReading): Promise<GraphReadingProvenance> {
  if (reading.source !== "compass_graph") return { status: "platform_producer" };
  if (!sc || !reading.city || !reading.computedAt) return { status: "not_recorded" };
  try {
    const { data, error } = await sc
      .from("compass_city_confidence")
      .select("city, computed_at, model_version, feature_version, source_window")
      .eq("city", reading.city)
      .maybeSingle();
    if (error) return { status: isMissingColumn(error) ? "columns_absent" : "read_failed" };
    const row = data as { computed_at?: unknown; model_version?: unknown; feature_version?: unknown; source_window?: unknown } | null;
    if (!row) return { status: "reading_moved" };
    if (Date.parse(String(row.computed_at)) !== Date.parse(reading.computedAt)) return { status: "reading_moved" };
    if (typeof row.model_version !== "string" || typeof row.feature_version !== "string" || row.source_window == null) return { status: "not_recorded" };
    return { status: "recorded", modelVersion: row.model_version, featureVersion: row.feature_version, sourceWindow: row.source_window, computedAt: reading.computedAt };
  } catch {
    return { status: "read_failed" };
  }
}
