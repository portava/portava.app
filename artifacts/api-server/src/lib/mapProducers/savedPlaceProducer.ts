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
 * SOURCE: THE TWO TABLES SAVES ACTUALLY LAND IN
 * =============================================
 * This producer used to read `public.saved_places`. That table has ZERO writers
 * anywhere in the repo — no INSERT, no upsert, no RPC, no trigger — so the
 * layer was built, mounted, reachable from eight surfaces, and permanently
 * empty. supabase-js RETURNS errors rather than throwing and an empty table is
 * indistinguishable from an empty fixture, so the suite that seeded
 * `saved_places` directly stayed green while the live layer produced nothing.
 *
 * Real saves land in two OTHER tables, written by two INDEPENDENT paths that
 * never write each other's:
 *
 *   `wishlist_places`         routes/wishlist.ts POST /api/wishlist. Every save
 *                             that goes through TripWishlistPicker: the
 *                             Discovery card and detail sheet, place detail
 *                             "Save to Trip", gem detail, search/city, the
 *                             messages Discovery card, AND the Map's own
 *                             long-press `save`. `place_id` is TEXT with no FK.
 *   `discovery_place_saves`   routes/discovery.ts POST
 *                             /api/discovery/community/:id/save — the
 *                             DiscoveryWall gem/pick bookmark. `place_id` is a
 *                             `discovery_places.id` uuid. This path writes
 *                             NOTHING to wishlist_places.
 *
 * NEITHER IS A SUPERSET OF THE OTHER, so reading either one alone silently
 * under-counts. (routes/wishlist.ts also writes discovery_place_saves, but only
 * for an OSM id — a `db/<uuid>` save never reaches it.) The layer is therefore
 * the UNION of the two, deduped per VENUE rather than per row.
 *
 * FOUR ID SPACES MEET HERE
 * ========================
 *   `discovery_place_saves.place_id`  a `discovery_places.id` uuid.
 *   `wishlist_places.place_id`        whatever string the client sent:
 *     `db/<discovery_places.id>`      bridges by id
 *     `db/<places.id>`                bridges by `canonical_location_id` (2053)
 *                                     — and a canonical place with no
 *                                     discovery mirror bridges to NOTHING, so
 *                                     it is resolved against `public.places`
 *     `node|way|relation/<id>`        bridges by `osm_id` (0086), and that row
 *                                     is created LAZILY on first save
 *     a bare uuid                     a hidden gem / event / city id in an
 *                                     unnamed space. Bridges to nothing, ever.
 *
 * lib/placeIdBridge.resolvePlaceIdBridge already resolves the first three in
 * one round-trip; it is called with `noCache: true` because an OSM place's
 * discovery_places row is created on first save and a cached known-empty from
 * before that save would silently drop the new pin for up to five minutes.
 *
 * TWO TRAPS THAT LOOK LIKE THE FIX WORKING
 * ========================================
 *   DOUBLE COUNT   One OSM save writes BOTH tables (wishlist under `node/123`,
 *                  discovery_place_saves under the mirror's uuid). An un-deduped
 *                  union draws two pins on one venue and doubles `collected`.
 *   LIST STACKING  wishlist_places is UNIQUE(user_id, place_id, list_id), so a
 *                  place saved to three trips is three rows. Keying a pin on
 *                  the ROW stacks three identical gold pins on one point.
 * Both are closed by keying on the resolved VENUE, never on the row.
 *
 * COLUMN NAMES ARE NOT SHARED
 * ===========================
 * `discovery_places` names its coordinates `lat`/`lng`; `public.places` names
 * them `latitude`/`longitude` (baseline). Copying one bbox chain onto the other
 * table yields PostgREST 42703, which supabase-js RETURNS rather than throws —
 * a plausible-looking refusal and an empty layer again. The canonical read here
 * uses mapProjectPlace's own PLACE_SELECT_COLUMNS and its `status` /
 * `merged_into_place_id` filters verbatim, so a saved pin and the `place` layer
 * beside it cannot disagree about whether a venue is closed or a duplicate.
 *
 * SNAPSHOT GEOMETRY, AND WHERE IT IS REFUSED
 * ==========================================
 * A save whose id belongs to no bridgeable space (a hidden gem, an event) has
 * geometry only in the client-written `wishlist_places.place_data` snapshot.
 * Refusing those would leave the Map's own gem saves invisible, so they ARE
 * drawn — labelled `geometrySource: "snapshot"` and counted in the report, so
 * the layer's provenance is measurable rather than assumed. Two limits:
 *   • a snapshot is a fallback ONLY for an id with no authoritative table. A
 *     `dp:`/`canon:` venue whose row is missing, closed, merged or outside the
 *     viewport is UNPLACED — never redrawn from its snapshot, which would
 *     resurrect exactly the closed/duplicate rows the `place` layer hides.
 *   • a `city` save carries no exact point (app/search.tsx writes null coords)
 *     and must never become a pin.
 * The pin is the viewer's own row (`user_id = viewer`, the only scoping there
 * is — the gateway holds a service client, so RLS is off), and it still passes
 * through the §24 protection gate downstream like any other place-like kind.
 *
 * RUNG AND RANK
 * =============
 * `place_level`: a venue the viewer chose, shown to the viewer. No freshness
 * and no confidence — a save is a preference, not an observation of conditions
 * (§37); lib/mapProjection.enrichWithLiveClaims may attach live claims through
 * `payload.canonicalPlaceId`. Ranked at RENDERING_PRIORITY.saved_place: above a
 * generic POI, below social opportunity, exactly where §31 puts it.
 *
 * NOT CLOSED BY THIS FILE: compass/PassportRemembersService.ts,
 * services/intel/PresenceVerifier.ts and the SQL memory projector (migrations
 * 2191, 2193) still read the writerless `saved_places`.
 */
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import type { BBox } from "../mapAggregation.js";
import { PLACE_SELECT_COLUMNS, type PlaceRowLike } from "../mapProjectPlace.js";
import { parseServedPlaceId, resolvePlaceIdBridge } from "../placeIdBridge.js";

export const SAVED_PLACE_PRIVACY_CLASS: PrivacyClass = "place_level";

/** Bounded: each save read is capped and the cap is reported. */
export const MAX_SAVED_PLACE_ROWS = 500;

/**
 * `.in()` is serialised into the query string. At ~37 chars per uuid a 500-id
 * list crosses a typical 8KB URL limit and returns 414 — which supabase-js
 * RETURNS rather than throws, so the layer would go empty again at exactly the
 * scale where it matters most. Every list read here is chunked.
 */
const IN_CHUNK = 150;

/**
 * The bridge serialises its db uuids TWICE (`id.in.(…)` and
 * `canonical_location_id.in.(…)`) in one `.or()`, so its page is chunked harder.
 */
const BRIDGE_CHUNK = 50;

/** The `wishlist_places` columns this producer reads. */
export interface WishlistSaveRowLike {
  place_id: string;
  place_data?: unknown;
  list_id?: string | null;
  saved_at?: string | null;
}

/** The `discovery_place_saves` columns this producer reads. */
export interface DiscoverySaveRowLike {
  place_id: string;
  saved_at?: string | null;
}

/** The `discovery_places` columns this producer reads. */
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

/** Where a saved pin's coordinate came from — carried on the object, reported. */
export type SavedGeometrySource = "discovery_places" | "places" | "snapshot";

/**
 * One saved venue, resolved to something drawable. Produced by the three
 * resolvers below so `projectSavedPlace` never has to know which table won.
 */
export interface ResolvedSavedVenue {
  lat: number;
  lng: number;
  name: string | null;
  category: string | null;
  city: string | null;
  neighborhood: string | null;
  /** The id the detail sheet opens on — the SERVED id space, not a bare uuid. */
  detailId: string;
  /** The live-claim subject (`places.id`), when this venue has one. */
  canonicalPlaceId: string | null;
  geometrySource: SavedGeometrySource;
}

function joinParts(parts: (string | null | undefined)[], sep: string): string | null {
  const s = parts.filter((p) => p != null && String(p).trim() !== "").join(sep);
  return s === "" ? null : s;
}

/** A finite, in-range coordinate, from the number or numeric string PostgREST returns. */
function coordinate(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return n;
}

function inBbox(lat: number, lng: number, bbox: BBox): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

function drawable(lat: number | null, lng: number | null): boolean {
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── the three resolvers ───────────────────────────────────────────────────────

/** A `discovery_places` row — the space both save tables can reach. */
export function resolveDiscoveryVenue(row: SavedPlaceVenueLike | null | undefined): ResolvedSavedVenue | null {
  if (!row || typeof row.id !== "string" || row.id === "") return null;
  const lat = coordinate(row.lat);
  const lng = coordinate(row.lng);
  if (!drawable(lat, lng)) return null;
  return {
    lat: lat as number,
    lng: lng as number,
    name: row.name ?? null,
    category: row.primary_category ?? null,
    city: row.city ?? null,
    neighborhood: row.neighborhood ?? null,
    detailId: `db/${row.id}`,
    canonicalPlaceId: row.canonical_location_id ?? null,
    geometrySource: "discovery_places",
  };
}

/**
 * A `public.places` row — the canonical venue a `db/<places.id>` save names when
 * no discovery mirror exists. Re-checks the read's own row-state filters so a
 * closed or merged venue cannot be drawn even if a caller hands one over.
 */
export function resolveCanonicalVenue(row: PlaceRowLike | null | undefined): ResolvedSavedVenue | null {
  if (!row || typeof row.id !== "string" || row.id === "") return null;
  if (row.status != null && row.status !== "active") return null;
  if (row.merged_into_place_id != null) return null;
  const lat = coordinate(row.latitude);
  const lng = coordinate(row.longitude);
  if (!drawable(lat, lng)) return null;
  return {
    lat: lat as number,
    lng: lng as number,
    name: row.name ?? null,
    category: row.primary_category ?? null,
    city: row.city ?? null,
    neighborhood: row.neighborhood ?? null,
    detailId: `db/${row.id}`,
    // A canonical place IS the live-claim subject; no bridge hop needed.
    canonicalPlaceId: row.id,
    geometrySource: "places",
  };
}

/**
 * The client-written `place_data` snapshot — the ONLY geometry an unbridgeable
 * save (a hidden gem, an event) has. A `city` save carries no exact point and
 * is refused rather than pinned.
 */
export function resolveSnapshotVenue(placeId: string, placeData: unknown): ResolvedSavedVenue | null {
  if (typeof placeId !== "string" || placeId === "") return null;
  if (!placeData || typeof placeData !== "object" || Array.isArray(placeData)) return null;
  const d = placeData as Record<string, unknown>;
  const category = typeof d["category"] === "string" ? (d["category"] as string) : null;
  const type = typeof d["type"] === "string" ? (d["type"] as string) : null;
  if (category === "city" || type === "city") return null;
  const lat = typeof d["lat"] === "number" ? coordinate(d["lat"]) : null;
  const lng = typeof d["lng"] === "number" ? coordinate(d["lng"]) : null;
  if (!drawable(lat, lng)) return null;
  return {
    lat: lat as number,
    lng: lng as number,
    name: typeof d["name"] === "string" ? (d["name"] as string) : null,
    category: category,
    city: null,
    neighborhood: null,
    detailId: placeId,
    // No bridge reached a canonical place, so there is no live-claim subject.
    canonicalPlaceId: null,
    geometrySource: "snapshot",
  };
}

// ── the projector ─────────────────────────────────────────────────────────────

/** The venue-identity key a pin is drawn under. See the dedup note in the header. */
export interface SavedVenueKeyLike {
  /** `dp:<uuid>` | `canon:<uuid>` | `raw:<place_id>` — one per saved VENUE. */
  key: string;
  savedAt?: string | null;
}

/** Project one of the viewer's saved venues. Pure. */
export function projectSavedPlace(
  saved: SavedVenueKeyLike,
  venue: ResolvedSavedVenue | null | undefined,
): MapObject | null {
  if (!saved || typeof saved.key !== "string" || saved.key === "") return null;
  if (!venue) return null;
  const { lat, lng } = venue;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  return {
    // Keyed on the VENUE, never on a save row: one gold pin per place however
    // many lists or paths saved it.
    id: `saved:${saved.key}`,
    kind: "saved_place",
    geometry: point(lat, lng),
    title: venue.name && String(venue.name).trim() !== "" ? String(venue.name) : "Saved place",
    subtitle: joinParts([venue.category, venue.neighborhood ?? venue.city], " · ") ?? undefined,
    privacyClass: SAVED_PLACE_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.saved_place,
    interaction: {
      actions: ["view", "navigate", "add_to_trip", "ask_compass", "meet_here", "share"],
      detailRoute: `/place/${encodeURIComponent(venue.detailId)}`,
      opensSheet: true,
      contributable: true,
    },
    payload: {
      savedKey: saved.key,
      placeId: venue.detailId,
      // The live-claim subject (places.id), when this venue has been reconciled.
      canonicalPlaceId: venue.canonicalPlaceId,
      savedAt: saved.savedAt ?? null,
      category: venue.category ?? null,
      city: venue.city ?? null,
      neighborhood: venue.neighborhood ?? null,
      // Which table drew this pin — so "the layer works" can be measured
      // per-provenance instead of assumed from a non-zero count.
      geometrySource: venue.geometrySource,
    },
  };
}

export interface SavedPlaceReport {
  /** Distinct saved VENUES after dedup — what `collected` should agree with. */
  saved: number;
  /** wishlist_places rows read (capped). */
  wishlist: number;
  /** discovery_place_saves rows read (capped). */
  discoverySaves: number;
  /** Rows collapsed into an already-seen venue (one OSM save writes both tables). */
  deduped: number;
  capped: boolean;
  /** Venues with no row, no coordinate, or outside the viewport. */
  unplaced: number;
  /** Venues drawn from the client `place_data` snapshot rather than a table. */
  fromSnapshot: number;
}

export type SavedPlaceReadResult =
  | { ok: true; pins: MapObject[]; report: SavedPlaceReport }
  | { ok: false; reason: "saved_read_failed" | "wishlist_read_failed" | "places_read_failed" };

interface SavedVenueEntry {
  key: string;
  savedAt: string | null;
  /** The wishlist snapshot, kept only for a key no table can resolve. */
  snapshotId: string | null;
  snapshotData: unknown;
}

/**
 * Read the VIEWER'S saved places inside a viewport, as the union of the two
 * tables saves actually land in. The ONE privacy-complete saved-place read for
 * the map; routes/mapProjection.ts is its only approved caller
 * (src/test/gatewayBypassGuard.test.ts).
 */
export async function readSavedPlacePins(
  sc: any,
  viewerId: string,
  opts: { bbox: BBox },
): Promise<SavedPlaceReadResult> {
  const { bbox } = opts;

  // ── 1. the two save tables, each scoped to the viewer's own rows ────────────
  const { data: wishRaw, error: wishErr } = await sc
    .from("wishlist_places")
    .select("place_id, place_data, list_id, saved_at")
    .eq("user_id", viewerId)
    .order("saved_at", { ascending: false })
    .limit(MAX_SAVED_PLACE_ROWS);
  if (wishErr || !Array.isArray(wishRaw)) return { ok: false, reason: "wishlist_read_failed" };

  const { data: dpsRaw, error: dpsErr } = await sc
    .from("discovery_place_saves")
    .select("place_id, saved_at")
    .eq("user_id", viewerId)
    .order("saved_at", { ascending: false })
    .limit(MAX_SAVED_PLACE_ROWS);
  if (dpsErr || !Array.isArray(dpsRaw)) return { ok: false, reason: "saved_read_failed" };

  const wishlist = (wishRaw as WishlistSaveRowLike[]).filter(
    (r) => r && typeof r.place_id === "string" && r.place_id !== "",
  );
  const discoverySaves = (dpsRaw as DiscoverySaveRowLike[]).filter(
    (r) => r && typeof r.place_id === "string" && r.place_id !== "",
  );

  const report: SavedPlaceReport = {
    saved: 0,
    wishlist: wishlist.length,
    discoverySaves: discoverySaves.length,
    deduped: 0,
    capped:
      wishlist.length >= MAX_SAVED_PLACE_ROWS || discoverySaves.length >= MAX_SAVED_PLACE_ROWS,
    unplaced: 0,
    fromSnapshot: 0,
  };
  if (wishlist.length === 0 && discoverySaves.length === 0) return { ok: true, pins: [], report };

  // ── 2. bridge the wishlist's TEXT id space into discovery_places ───────────
  // noCache: an OSM place's discovery_places row is created lazily on first
  // save, so a cached known-empty from before that save would drop the new pin.
  const servedIds = [...new Set(wishlist.map((r) => r.place_id))];
  const bridged = new Map<string, Set<string>>();
  for (const page of chunk(servedIds, BRIDGE_CHUNK)) {
    const { toCanonical } = await resolvePlaceIdBridge(sc, page, { noCache: true });
    for (const [served, dpIds] of toCanonical) bridged.set(served, dpIds);
  }

  // ── 3. collapse both tables onto ONE key per saved venue ───────────────────
  const entries = new Map<string, SavedVenueEntry>();
  const note = (key: string, savedAt: string | null, snapshotId: string | null, snapshotData: unknown): void => {
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { key, savedAt, snapshotId, snapshotData });
      return;
    }
    report.deduped += 1;
    // Keep the most recent save moment for the venue.
    if (savedAt && (!existing.savedAt || savedAt > existing.savedAt)) existing.savedAt = savedAt;
    if (existing.snapshotId === null && snapshotId !== null) {
      existing.snapshotId = snapshotId;
      existing.snapshotData = snapshotData;
    }
  };

  for (const row of discoverySaves) {
    note(`dp:${row.place_id}`, row.saved_at ?? null, null, null);
  }
  for (const row of wishlist) {
    const dpIds = bridged.get(row.place_id);
    if (dpIds && dpIds.size > 0) {
      // Deterministic when a served id maps to more than one mirror.
      const chosen = [...dpIds].sort()[0] as string;
      note(`dp:${chosen}`, row.saved_at ?? null, null, null);
      continue;
    }
    const parsed = parseServedPlaceId(row.place_id);
    if (parsed.kind === "db") {
      // `db/<uuid>` that reached no discovery mirror — a canonical public.places
      // row served straight from the canonical table.
      note(`canon:${parsed.uuid}`, row.saved_at ?? null, row.place_id, row.place_data);
      continue;
    }
    note(`raw:${row.place_id}`, row.saved_at ?? null, row.place_id, row.place_data);
  }

  report.saved = entries.size;

  // ── 4. resolve geometry, authoritative tables first ────────────────────────
  const dpIds = [...entries.keys()].filter((k) => k.startsWith("dp:")).map((k) => k.slice(3));
  const canonIds = [...entries.keys()].filter((k) => k.startsWith("canon:")).map((k) => k.slice(6));

  const dpRows = new Map<string, SavedPlaceVenueLike>();
  for (const page of chunk(dpIds, IN_CHUNK)) {
    const { data, error } = await sc
      .from("discovery_places")
      .select("id, name, city, neighborhood, primary_category, lat, lng, canonical_location_id")
      .in("id", page)
      .gte("lat", bbox.south)
      .lte("lat", bbox.north)
      .gte("lng", bbox.west)
      .lte("lng", bbox.east);
    if (error || !Array.isArray(data)) return { ok: false, reason: "places_read_failed" };
    for (const v of data as SavedPlaceVenueLike[]) if (v && typeof v.id === "string") dpRows.set(v.id, v);
  }

  const canonRows = new Map<string, PlaceRowLike>();
  for (const page of chunk(canonIds, IN_CHUNK)) {
    // `public.places` names its coordinates latitude/longitude, and hides
    // closed / merged rows — the same filters the `place` layer applies.
    const { data, error } = await sc
      .from("places")
      .select(PLACE_SELECT_COLUMNS)
      .in("id", page)
      .eq("status", "active")
      .is("merged_into_place_id", null)
      .gte("latitude", bbox.south)
      .lte("latitude", bbox.north)
      .gte("longitude", bbox.west)
      .lte("longitude", bbox.east);
    if (error || !Array.isArray(data)) return { ok: false, reason: "places_read_failed" };
    for (const v of data as PlaceRowLike[]) if (v && typeof v.id === "string") canonRows.set(v.id, v);
  }

  // ── 5. project ─────────────────────────────────────────────────────────────
  const pins: MapObject[] = [];
  for (const entry of entries.values()) {
    let venue: ResolvedSavedVenue | null = null;
    if (entry.key.startsWith("dp:")) {
      venue = resolveDiscoveryVenue(dpRows.get(entry.key.slice(3)));
    } else if (entry.key.startsWith("canon:")) {
      venue = resolveCanonicalVenue(canonRows.get(entry.key.slice(6)));
    } else if (entry.snapshotId !== null) {
      // ONLY an id with no authoritative table falls back to the snapshot. A
      // dp:/canon: venue the table refused stays unplaced — redrawing it here
      // would resurrect the closed, merged and out-of-viewport rows the reads
      // above deliberately excluded.
      const snap = resolveSnapshotVenue(entry.snapshotId, entry.snapshotData);
      if (snap && inBbox(snap.lat, snap.lng, bbox)) venue = snap;
    }
    const pin = projectSavedPlace(entry, venue);
    if (!pin) { report.unplaced += 1; continue; }
    if (venue && venue.geometrySource === "snapshot") report.fromSnapshot += 1;
    pins.push(pin);
  }

  // Deterministic order — most recent save first, key as the tie-break — so a
  // capped viewport keeps returning the same pins across polls.
  pins.sort((a, b) => {
    const sa = (a.payload as { savedAt?: string | null })?.savedAt ?? "";
    const sb = (b.payload as { savedAt?: string | null })?.savedAt ?? "";
    if (sa !== sb) return sa < sb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { ok: true, pins, report };
}
