/**
 * memoryProducer — the `memory` kind (Map spec §6 "Gold marker = Saved /
 * Passport / Memory", §16 "Memories" layer, off by default; §20 "Memory owns
 * personal projection and history").
 *
 * THE CANONICAL READ, AND WHY IT IS THE PASSPORT ONE
 * ==================================================
 * The memory system (migrations 2183–2197, Memory + Experience Intelligence)
 * exposes two read paths over `memory_projections`:
 *
 *   memory_retrieve(user, surface, limit)  — ranked memory for Compass /
 *                                            Discovery / Passport (2185).
 *   memory_remembers_for_user(user)        — §12 "What Portava Remembers", the
 *                                            PRIVATE, OWNER-ONLY surface, with
 *                                            the allow/deny boundary enforced
 *                                            in SQL (2213): active + unexpired
 *                                            only, `sensitivity <> 'sensitive'`,
 *                                            only policy classes marked
 *                                            user_visible, sensitive-category
 *                                            inference and user-suppressed
 *                                            (forget / hide) memory excluded.
 *
 * The map is an OWNER-ONLY surface for memory (nobody else's memories are ever
 * drawn on a viewer's map), so it reads through the same boundary the owner's
 * own Passport uses — the second function — and re-applies the same TS
 * defence-in-depth gate (`mapDerivedRow` → `derivedRowIsAllowed`,
 * `loadSuppressions` → `isSuppressed`) that compass/PassportRemembersService
 * applies. One boundary, two surfaces: a memory the owner has told Portava to
 * forget cannot reappear as a gold pin, because the forget is a durable
 * memory_feedback row that both the SQL read and this module honour and that
 * survives re-projection (2190).
 *
 * WHICH MEMORIES ARE PLACEABLE
 * ============================
 * Only `subject_type = 'place'`: `place` memory (2191 projects it from
 * saved_places, keyed on discovery_places.id) and any episodic memory keyed on
 * a place. City / country / interest / social memory has no venue coordinate
 * and is not drawn. The subject id is a `discovery_places.id`, so the venue
 * geography comes from that row — public reference geography
 * (lib/locationPurposes REFERENCE_LOCATION_TABLES), never a position of the
 * owner.
 *
 * COARSE GEOMETRY, `approximate` RUNG
 * ===================================
 * A memory pin says "this person has a history with this place". It is drawn
 * for the owner alone, and still at COARSE precision: the coordinate is snapped
 * with lib/mapTravelers.coarsenPosition at the 'area' grid (~2 km cell, a
 * deterministic per-user point inside it), and the rung is `approximate` so
 * the renderer draws §6's ring rather than a venue-precision pin. §19 of the
 * memory spec puts sensitive location under stricter access; the SQL boundary
 * already withholds `sensitivity = 'sensitive'` rows entirely, and the coarse
 * geometry is the treatment for everything that remains. lib/protectedLocations
 * lists `memory` under AMBIENT_PRESENCE_KINDS, so inside a coarsen-class
 * protected zone a memory pin is suppressed outright.
 *
 * FLAG. `memory_projection` gates the whole memory surface (the projector only
 * populates memory_projections when it is on — lib/placeIdBridge
 * MEMORY_PROJECTION_FLAG). Off ⇒ this layer refuses before it reads. Read-only
 * here; nothing flips it.
 */
import { isFlagEnabled } from "../featureFlags.js";
import { MEMORY_PROJECTION_FLAG } from "../placeIdBridge.js";
import { coarsenPosition } from "../mapTravelers.js";
import {
  isSuppressed,
  loadSuppressions,
  mapDerivedRow,
  type RememberItem,
} from "../../compass/PassportRemembersService.js";
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import type { BBox } from "../mapAggregation.js";

export const MEMORY_PRIVACY_CLASS: PrivacyClass = "approximate";

/** The coarsening rung handed to coarsenPosition: the ~2 km 'area' grid. */
export const MEMORY_COARSENING = "area";

/** Bounded: the owner-only read is capped, and the cap is reported. */
export const MAX_MEMORY_SUBJECTS = 300;

/** The discovery_places columns this producer reads. */
export interface MemoryPlaceLike {
  id: string;
  name?: string | null;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Project one ALREADY-ALLOWED derived-memory item onto its venue, coarsened.
 * Pure. `item` must have come through `mapDerivedRow` (which applies the
 * defence-in-depth deny gate) — this function decides nothing about
 * eligibility, exactly as projectCircleMember decides nothing about consent.
 */
export function projectMemoryPin(
  item: RememberItem,
  place: MemoryPlaceLike,
  viewerId: string,
): MapObject | null {
  if (!item || item.subjectType !== "place" || !item.subjectId) return null;
  const lat = place?.lat;
  const lng = place?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  // The raw venue coordinate does not survive this call.
  const coarse = coarsenPosition(viewerId, lat, lng, MEMORY_COARSENING);

  return {
    id: `memory:${item.id}`,
    kind: "memory",
    geometry: point(coarse.lat, coarse.lng),
    title: place.name && String(place.name).trim() !== "" ? String(place.name) : "A place you remember",
    subtitle: item.title || undefined,
    // A memory is history, not an observation of current conditions: no
    // observedAt, no freshness, no confidence band (§37). `occurredAt` — when
    // the memory was last supported — travels in the payload instead.
    privacyClass: MEMORY_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.memory,
    interaction: {
      actions: ["view", "ask_compass"],
      opensSheet: true,
    },
    payload: {
      projectionId: item.id,
      memoryType: item.memoryType,
      subjectType: "place",
      subjectId: item.subjectId,
      content: item.title,
      isInferred: item.isInferred,
      occurredAt: item.occurredAt ?? null,
      city: place.city ?? null,
      precision: coarse.precision,
      // Owner-only surface: the controls are the Passport's own.
      forgetEndpoint: item.controls.forget.endpoint,
    },
  };
}

export interface MemoryReport {
  /** Rows the owner-only SQL boundary returned. */
  derived: number;
  /** Dropped by the TS defence-in-depth gate or a user suppression. */
  denied: number;
  /** Allowed rows whose subject is a place. */
  placeSubjects: number;
  /** Place subjects beyond MAX_MEMORY_SUBJECTS, not looked up. */
  capped: number;
  /** Place subjects with no discovery_places row or no coordinate. */
  unplaced: number;
  /** Placed memories whose coarse point falls outside the viewport. */
  outsideViewport: number;
}

export type MemoryReadResult =
  | { ok: true; pins: MapObject[]; report: MemoryReport }
  | { ok: false; reason: "flag_off" | "memory_read_failed" | "places_read_failed" };

/**
 * Read the VIEWER'S OWN placeable memories inside a viewport. The ONE
 * privacy-complete memory read for the map; routes/mapProjection.ts is its only
 * approved caller (src/test/gatewayBypassGuard.test.ts).
 *
 * `viewerId` MUST be the authenticated user's id — the SQL function takes it as
 * a parameter and returns that user's private memory. The route derives it
 * from the session and never from a query param (the 2182 lesson).
 */
export async function readMemoryPins(
  sc: any,
  viewerId: string,
  opts: { bbox: BBox },
): Promise<MemoryReadResult> {
  if (!(await isFlagEnabled(sc, "memory_projection"))) return { ok: false, reason: "flag_off" };

  const { data, error } = await sc.rpc("memory_remembers_for_user", { p_user_id: viewerId });
  if (error || !Array.isArray(data)) return { ok: false, reason: "memory_read_failed" };

  const report: MemoryReport = {
    derived: data.length, denied: 0, placeSubjects: 0, capped: 0, unplaced: 0, outsideViewport: 0,
  };

  const suppressions = await loadSuppressions(sc, viewerId);
  const items: RememberItem[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const item = mapDerivedRow(row);
    if (!item || isSuppressed(item, suppressions)) { report.denied += 1; continue; }
    if (item.subjectType !== "place" || !item.subjectId) continue;
    items.push(item);
  }
  report.placeSubjects = items.length;
  if (items.length === 0) return { ok: true, pins: [], report };

  const take = items.slice(0, MAX_MEMORY_SUBJECTS);
  report.capped = items.length - take.length;
  const subjectIds = [...new Set(take.map((i) => i.subjectId))];

  const { data: placeRows, error: placeErr } = await sc
    .from("discovery_places")
    .select("id, name, city, lat, lng")
    .in("id", subjectIds);
  if (placeErr || !Array.isArray(placeRows)) return { ok: false, reason: "places_read_failed" };

  const byId = new Map<string, MemoryPlaceLike>();
  for (const p of placeRows as MemoryPlaceLike[]) if (p && typeof p.id === "string") byId.set(p.id, p);

  const { bbox } = opts;
  const pins: MapObject[] = [];
  for (const item of take) {
    const place = byId.get(item.subjectId);
    const pin = place ? projectMemoryPin(item, place, viewerId) : null;
    if (!pin) { report.unplaced += 1; continue; }
    // Filter on the COARSE point — the one the client will see.
    const [lng, lat] = (pin.geometry as { coordinates: [number, number] }).coordinates;
    if (lat < bbox.south || lat > bbox.north || lng < bbox.west || lng > bbox.east) {
      report.outsideViewport += 1;
      continue;
    }
    pins.push(pin);
  }
  return { ok: true, pins, report };
}

// Compile-time pin: the flag literal above must be the memory surface's flag.
const _MEMORY_FLAG_PIN: "memory_projection" = MEMORY_PROJECTION_FLAG;
void _MEMORY_FLAG_PIN;
