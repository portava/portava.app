/**
 * Trips §14.1 "stage" — where a stage goes on the map, and what is said about
 * the stages that go nowhere (census-trips wave-5 follow-up).
 *
 * THE GAP. `trip_stages` is anchored to a place OR a city, exactly one (2760's
 * `trip_stages_one_anchor`). The projection read only `place_id`, so every
 * stage TripStructureComposer issues — it anchors by canonical CITY — was on
 * the spine card and silently absent from the map layer.
 *
 * WHAT THIS DOES, AND THE ONE THING IT WILL NOT DO
 * ================================================
 *   place-anchored  the place's own coordinates, unchanged.
 *   city-anchored   the city's centre from its `canonical_locations` row — a
 *                   COARSE position, and the point says so
 *                   (`meta.precision: "city_centre"`), so no consumer can draw
 *                   it as an exact spot.
 *   anything else   NOT a map object. It is listed in `notDrawn` with its
 *                   reason, so the legend can say how many stages are missing
 *                   from the map and why, rather than letting an absent pin
 *                   read as an absent stage.
 *
 * It never fabricates a position. No centroid is computed, no city is looked up
 * by name, no neighbouring stage lends its point, and a canonical row that is
 * not a city (a country, a region, a venue) is not drawn as one: a country's
 * centre is not where the traveller is staying, and a venue's point would claim
 * a precision the anchor does not have.
 *
 * FAIL-CLOSED. `cityCentres` returns null when the read FAILED, which the route
 * turns into an `unread` layer — the same rule `placeCoords` follows. An empty
 * map means "none of these cities has a position", which is a different
 * sentence and yields `notDrawn` entries.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { coordsOf, type MapPoint } from "../../../domain/trips/projections/TripMapProjection.js";

/** The canonical kinds a city-anchored stage may be drawn at the centre of (geoResolver's CITY_KINDS). */
export const STAGE_CITY_KINDS: ReadonlySet<string> = new Set(["city", "town", "municipality"]);

export type StageNotDrawnReason =
  | "place_has_no_position"
  | "city_has_no_position"
  | "anchor_is_not_a_city"
  | "no_anchor";

/** A stage that is not on the map, and why. Served beside the layer as `stagesNotDrawn`. */
export interface StageNotDrawn {
  id: string;
  stageType: string | null;
  sequence: number | null;
  reason: StageNotDrawnReason;
}

export interface CityCentre {
  kind: string | null;
  centre: { lat: number; lng: number } | null;
}

/**
 * The canonical rows behind a set of city ids, in one read. Null when the READ
 * failed. A city id with no row is simply absent from the map (and becomes
 * `city_has_no_position`); a row with no finite pair has `centre: null`.
 */
export async function cityCentres(sc: SupabaseClient, ids: string[]): Promise<Map<string, CityCentre> | null> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const { data, error } = await sc.from("canonical_locations").select("id, kind, lat, lng").in("id", wanted);
  if (error) return null;
  const out = new Map<string, CityCentre>();
  for (const r of ((data ?? []) as Array<Record<string, unknown>>)) {
    if (typeof r.id !== "string") continue;
    out.set(r.id, { kind: typeof r.kind === "string" ? r.kind.toLowerCase() : null, centre: coordsOf(r.lat, r.lng) });
  }
  return out;
}

export interface StageRow {
  id: string;
  stage_type?: string | null;
  state?: string | null;
  sequence?: number | null;
  place_id?: string | null;
  city_id?: string | null;
}

/** The stage layer's points, and every stage that is not one, from rows whose anchors were read. */
export function stageLayerPoints(
  rows: StageRow[],
  places: Map<string, { lat: number; lng: number }>,
  cities: Map<string, CityCentre>,
): { points: MapPoint[]; notDrawn: StageNotDrawn[] } {
  const points: MapPoint[] = [];
  const notDrawn: StageNotDrawn[] = [];
  const skip = (s: StageRow, reason: StageNotDrawnReason) => notDrawn.push({
    id: s.id, stageType: s.stage_type ?? null, sequence: typeof s.sequence === "number" ? s.sequence : null, reason,
  });
  for (const s of rows) {
    if (s.place_id) {
      const c = places.get(s.place_id);
      if (!c) { skip(s, "place_has_no_position"); continue; }
      points.push({ id: s.id, kind: "stage", lat: c.lat, lng: c.lng, label: s.stage_type ?? null, meta: { state: s.state, sequence: s.sequence } });
      continue;
    }
    if (s.city_id) {
      const city = cities.get(s.city_id);
      if (!city || !city.centre) { skip(s, "city_has_no_position"); continue; }
      if (!city.kind || !STAGE_CITY_KINDS.has(city.kind)) { skip(s, "anchor_is_not_a_city"); continue; }
      points.push({
        id: s.id, kind: "stage", lat: city.centre.lat, lng: city.centre.lng, label: s.stage_type ?? null,
        meta: { state: s.state, sequence: s.sequence, anchor: "city", precision: "city_centre" },
      });
      continue;
    }
    skip(s, "no_anchor");
  }
  return { points, notDrawn };
}

/** One sentence for the response, beside `stagesNotDrawn`. */
export function stageReading(points: MapPoint[], notDrawn: StageNotDrawn[]): string {
  const coarse = points.filter((p) => p.meta?.precision === "city_centre").length;
  const parts = [`${points.length} stage(s) on the map`];
  if (coarse > 0) parts.push(`${coarse} of them at their city's centre, not an exact spot`);
  if (notDrawn.length > 0) parts.push(`${notDrawn.length} not drawn: no position is known for their anchor (listed in stagesNotDrawn)`);
  return parts.join("; ");
}
