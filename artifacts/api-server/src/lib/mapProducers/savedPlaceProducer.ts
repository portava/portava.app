/**
 * savedPlaceProducer — the `saved_place` kind (Map spec §16 "Saved" layer, on
 * by default; §6 "Gold marker = Saved / Passport / Memory"; §31 "Saved Place"
 * tier; §28 "Cache saved places"; §27 "Saved items").
 *
 * WHY A KIND OF ITS OWN
 * =====================
 * §18's thirteen kinds mapped §16's Saved layer to nothing: `memory` is the
 * Memories layer, which §16 lists separately and defaults OFF while Saved
 * defaults ON, and `place` is the generic POI the Saved layer exists to lift a
 * chosen venue above. The §31 ladder already had a `saved_place` tier with no
 * kind on it. So the contract was extended — on the server and on the app
 * mirror, through src/test/mapObjectsContract.test.ts — with `saved_place`,
 * and this is its producer.
 *
 * SOURCE
 * ======
 * `saved_places` (0074): the viewer's own wishlist, `place_id →
 * discovery_places(id)`. The venue geography is `discovery_places.lat/lng` —
 * public reference geography (lib/locationPurposes REFERENCE_LOCATION_TABLES),
 * never a position of the viewer. The read is scoped to `user_id = viewer`,
 * which is the same row set saved_places' own RLS ("Users can manage their own
 * saved places") lets the viewer read through PostgREST; nothing is widened.
 *
 * RUNG AND RANK
 * =============
 * `place_level`: a venue the viewer chose, shown to the viewer. No freshness
 * and no confidence — a save is a preference, not an observation of conditions
 * (§37); lib/mapProjection.enrichWithLiveClaims may attach live claims through
 * `payload.canonicalPlaceId`, which bridges discovery_places →
 * places via `canonical_location_id` (migration 2053), the same bridge
 * lib/placeIdBridge documents. Ranked at RENDERING_PRIORITY.saved_place: above
 * a generic POI, below social opportunity, exactly where §31 puts it.
 *
 * Not a presence kind: the pin says "you saved this", to you. Inside a
 * coarsen-class protected zone it is coarsened like a place; inside a
 * suppress-class zone it is withheld like everything else.
 */
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import type { BBox } from "../mapAggregation.js";

export const SAVED_PLACE_PRIVACY_CLASS: PrivacyClass = "place_level";

/** Bounded: the wishlist read is capped and the cap is reported. */
export const MAX_SAVED_PLACE_ROWS = 500;

/** The saved_places columns this producer reads. */
export interface SavedPlaceRowLike {
  id: string;
  place_id: string;
  saved_at?: string | null;
}

/** The discovery_places columns this producer reads. */
export interface SavedPlaceVenueLike {
  id: string;
  name?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  primary_category?: string | null;
  lat?: number | null;
  lng?: number | null;
  canonical_location_id?: string | null;
}

function joinParts(parts: (string | null | undefined)[], sep: string): string | null {
  const s = parts.filter((p) => p != null && String(p).trim() !== "").join(sep);
  return s === "" ? null : s;
}

/** Project one of the viewer's saved places onto its venue. Pure. */
export function projectSavedPlace(saved: SavedPlaceRowLike, venue: SavedPlaceVenueLike): MapObject | null {
  if (!saved || typeof saved.id !== "string" || saved.id === "") return null;
  if (!venue || venue.id !== saved.place_id) return null;
  const lat = venue.lat;
  const lng = venue.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  return {
    id: `saved:${saved.id}`,
    kind: "saved_place",
    geometry: point(lat, lng),
    title: venue.name && String(venue.name).trim() !== "" ? String(venue.name) : "Saved place",
    subtitle: joinParts([venue.primary_category, venue.neighborhood ?? venue.city], " · ") ?? undefined,
    privacyClass: SAVED_PLACE_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.saved_place,
    interaction: {
      actions: ["view", "navigate", "add_to_trip", "ask_compass", "meet_here", "share"],
      detailRoute: `/place/${encodeURIComponent(`db/${venue.id}`)}`,
      opensSheet: true,
      contributable: true,
    },
    payload: {
      savedId: saved.id,
      placeId: venue.id,
      // The live-claim subject (places.id), when this venue has been reconciled.
      canonicalPlaceId: venue.canonical_location_id ?? null,
      savedAt: saved.saved_at ?? null,
      category: venue.primary_category ?? null,
      city: venue.city ?? null,
      neighborhood: venue.neighborhood ?? null,
    },
  };
}

export interface SavedPlaceReport {
  /** Wishlist rows read (capped). */
  saved: number;
  capped: boolean;
  /** Saved rows whose venue is missing, has no coordinate, or is outside the viewport. */
  unplaced: number;
}

export type SavedPlaceReadResult =
  | { ok: true; pins: MapObject[]; report: SavedPlaceReport }
  | { ok: false; reason: "saved_read_failed" | "places_read_failed" };

/**
 * Read the VIEWER'S saved places inside a viewport. The ONE privacy-complete
 * saved-place read for the map; routes/mapProjection.ts is its only approved
 * caller (src/test/gatewayBypassGuard.test.ts).
 */
export async function readSavedPlacePins(
  sc: any,
  viewerId: string,
  opts: { bbox: BBox },
): Promise<SavedPlaceReadResult> {
  const { data, error } = await sc
    .from("saved_places")
    .select("id, place_id, saved_at")
    .eq("user_id", viewerId)
    .order("saved_at", { ascending: false })
    .limit(MAX_SAVED_PLACE_ROWS);
  if (error || !Array.isArray(data)) return { ok: false, reason: "saved_read_failed" };

  const saved = (data as SavedPlaceRowLike[]).filter((r) => r && typeof r.place_id === "string");
  const report: SavedPlaceReport = { saved: saved.length, capped: saved.length >= MAX_SAVED_PLACE_ROWS, unplaced: 0 };
  if (saved.length === 0) return { ok: true, pins: [], report };

  const { bbox } = opts;
  const placeIds = [...new Set(saved.map((r) => r.place_id))];
  const { data: venues, error: venueErr } = await sc
    .from("discovery_places")
    .select("id, name, city, neighborhood, primary_category, lat, lng, canonical_location_id")
    .in("id", placeIds)
    .gte("lat", bbox.south)
    .lte("lat", bbox.north)
    .gte("lng", bbox.west)
    .lte("lng", bbox.east);
  if (venueErr || !Array.isArray(venues)) return { ok: false, reason: "places_read_failed" };

  const byId = new Map<string, SavedPlaceVenueLike>();
  for (const v of venues as SavedPlaceVenueLike[]) if (v && typeof v.id === "string") byId.set(v.id, v);

  const pins: MapObject[] = [];
  for (const row of saved) {
    const venue = byId.get(row.place_id);
    const pin = venue ? projectSavedPlace(row, venue) : null;
    if (!pin) { report.unplaced += 1; continue; }
    pins.push(pin);
  }
  return { ok: true, pins, report };
}
