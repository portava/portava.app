/**
 * LayoverPlaceDwell — the Layover domain's curated per-place DWELL source.
 *
 * census-discovery A14 (§37.5 item 2, §81; register D-W10S2-3). Layover §25 —
 * *"Discovery: Only show experiences from certified action universe in Layover
 * mode"*. The universe admits a place only when BOTH time terms are stated: the
 * journey and the activity (`certifiedActionUniverse` reads `travelTimeMin` and
 * `activityTimeMin`). Until now the only activity producer was the traveller's
 * own plan stop, so Layover mode could admit nothing the traveller had not
 * already planned. §37.5 named what was missing, verbatim: *"A dwell source with
 * real provenance — a duration column, or a derived figure carrying a source
 * class and confidence in the `TravelAssumption` pattern. Not a category
 * average."*
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * One row per `discovery_places` row, in `layover_place_dwell` (migration 3466):
 * the minutes a visit takes, WHO said so (`source_class`), how sure they are
 * (`confidence`), and the evidence in words. Two source classes, both a
 * statement about THIS place by someone accountable for it:
 *
 *   venue_stated      the venue's own published figure (a tour's length, a
 *                     spa slot, a museum's suggested visit)
 *   curator_measured  a Portava curator's timed visit of this place
 *
 * and deliberately NOT a third:
 *
 *   • no category default ("museums take 90 minutes"): §37.5's prohibition,
 *     and the literal the Layover lane deleted from `LayoverRecommendationService`;
 *   • no figure derived from OTHER travellers' plan stops. That would turn one
 *     person's stated itinerary into advice to strangers — a use of their data
 *     they never agreed to — and is not decided here.
 *
 * The bounds are `layover_plan_stops.duration_min`'s own CHECK (5–720): the
 * activity term means the same thing from either producer.
 *
 * ── HOW IT IS READ ──────────────────────────────────────────────────────────
 * `lib/discoveryLayoverTiming.ts` asks `readCuratedDwell` for a page's place
 * ids AFTER the traveller's own stops: a stated plan stop supersedes a curated
 * figure, and a curated figure fills only a place the traveller has not
 * planned. Three answers, kept apart:
 *
 *   off         `layover_place_dwell_enabled` is off or absent (the seed) —
 *               nothing is read; the timing module is byte-identical to before
 *   read        a map, possibly empty
 *   unreadable  the table could not be read — the activity term is ABSENT and
 *               says `dwell_source_unreadable`, never "no stop", never a number
 *
 * The travel term is unchanged: only the routed port or the traveller's stop
 * states it. So on a deployment where the corridor provider is off, a curated
 * dwell alone admits nothing; it closes the dwell half of §37.5 and leaves the
 * travel half exactly where §37.5 item 1 left it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";

/** Seeded FALSE by migration 3465. */
export const LAYOVER_PLACE_DWELL_FLAG = "layover_place_dwell_enabled";

/** The table (migration 3466). Named so a refusal can say it. */
export const LAYOVER_PLACE_DWELL_TABLE = "layover_place_dwell";

export const DWELL_SOURCE_CLASSES = ["venue_stated", "curator_measured"] as const;
export type DwellSourceClass = (typeof DWELL_SOURCE_CLASSES)[number];

export const DWELL_CONFIDENCE = ["LOW", "MEDIUM", "HIGH"] as const;
export type DwellConfidence = (typeof DWELL_CONFIDENCE)[number];

/** `layover_plan_stops.duration_min`'s CHECK, so both producers mean the same range. */
export const DWELL_MIN_MINUTES = 5;
export const DWELL_MAX_MINUTES = 720;

export interface CuratedDwell {
  placeId: string;
  activityMin: number;
  sourceClass: DwellSourceClass;
  confidence: DwellConfidence;
  evidence: string;
}

export type CuratedDwellRead =
  | { state: "off" }
  | { state: "read"; byPlace: Map<string, CuratedDwell> }
  | { state: "unreadable"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row as the table holds it → the figure, or null when the row is not one the CHECKs admit. */
export function curatedDwellFromRow(row: Record<string, unknown>): CuratedDwell | null {
  const placeId = row.place_id;
  const minutes = row.activity_min;
  const sourceClass = row.source_class;
  const confidence = row.confidence;
  const evidence = row.evidence;
  if (typeof placeId !== "string" || !UUID.test(placeId)) return null;
  if (typeof minutes !== "number" || !Number.isInteger(minutes)) return null;
  if (minutes < DWELL_MIN_MINUTES || minutes > DWELL_MAX_MINUTES) return null;
  if (!(DWELL_SOURCE_CLASSES as readonly unknown[]).includes(sourceClass)) return null;
  if (!(DWELL_CONFIDENCE as readonly unknown[]).includes(confidence)) return null;
  if (typeof evidence !== "string" || evidence.trim().length === 0) return null;
  return {
    placeId,
    activityMin: minutes,
    sourceClass: sourceClass as DwellSourceClass,
    confidence: confidence as DwellConfidence,
    evidence,
  };
}

/**
 * The curated dwell for a page of layover subjects (`discovery_places.id`s;
 * `null` entries — an OSM element with no subject — are skipped).
 */
export async function readCuratedDwell(
  db: SupabaseClient,
  subjects: ReadonlyArray<string | null>,
): Promise<CuratedDwellRead> {
  if (!(await isFlagEnabled(db, LAYOVER_PLACE_DWELL_FLAG))) return { state: "off" };
  const ids = [...new Set(subjects.filter((s): s is string => typeof s === "string" && UUID.test(s)))];
  if (ids.length === 0) return { state: "read", byPlace: new Map() };
  const { data, error } = await db
    .from("layover_place_dwell")
    .select("place_id, activity_min, source_class, confidence, evidence")
    .in("place_id", ids);
  if (error) {
    return { state: "unreadable", message: String((error as { message?: string }).message ?? "layover_place_dwell unreadable") };
  }
  const byPlace = new Map<string, CuratedDwell>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const d = curatedDwellFromRow(row);
    if (d) byPlace.set(d.placeId, d);
  }
  return { state: "read", byPlace };
}

export interface CuratedDwellWrite {
  activityMin: number;
  sourceClass: DwellSourceClass;
  confidence: DwellConfidence;
  evidence: string;
}

/**
 * The one writer: an administrator states (or corrects) a place's dwell. The
 * place must exist; a failed read or write is reported, never assumed.
 */
export async function upsertCuratedDwell(
  db: SupabaseClient,
  placeId: string,
  statedBy: string,
  body: CuratedDwellWrite,
): Promise<{ ok: true; dwell: CuratedDwell } | { ok: false; reason: "invalid" | "place_not_found" | "unreadable" | "write_failed"; message: string }> {
  const candidate = curatedDwellFromRow({
    place_id: placeId, activity_min: body.activityMin, source_class: body.sourceClass,
    confidence: body.confidence, evidence: body.evidence,
  });
  if (!candidate) return { ok: false, reason: "invalid", message: "a dwell needs a place uuid, 5–720 whole minutes, a source class, a confidence and evidence" };
  const place = await db.from("discovery_places").select("id").eq("id", placeId).maybeSingle();
  if (place.error) return { ok: false, reason: "unreadable", message: String(place.error.message ?? "discovery_places unreadable") };
  if (!place.data) return { ok: false, reason: "place_not_found", message: "no such discovery place" };
  const nowIso = new Date().toISOString();
  const { error } = await db.from("layover_place_dwell").upsert({
    place_id: placeId,
    activity_min: candidate.activityMin,
    source_class: candidate.sourceClass,
    confidence: candidate.confidence,
    evidence: candidate.evidence,
    stated_by: statedBy,
    stated_at: nowIso,
    updated_at: nowIso,
  }, { onConflict: "place_id" });
  if (error) return { ok: false, reason: "write_failed", message: String(error.message ?? "layover_place_dwell write failed") };
  return { ok: true, dwell: candidate };
}

/** Withdraw a place's curated dwell. Its places return to UNMEASURED on the next read. */
export async function deleteCuratedDwell(
  db: SupabaseClient,
  placeId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await db.from("layover_place_dwell").delete().eq("place_id", placeId);
  if (error) return { ok: false, message: String(error.message ?? "layover_place_dwell delete failed") };
  return { ok: true };
}
