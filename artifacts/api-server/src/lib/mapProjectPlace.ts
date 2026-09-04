/**
 * mapProjectPlace — canonical `public.places` rows enter the Map projection
 * pipeline (Map spec §7, §8, §19, §24, §25, §31).
 *
 * THE GAP THIS CLOSES
 * ===================
 * §20 names Places as the system that owns "place identity and location", and
 * §17's district/street rows put "Live places" and "Individual places" on the
 * map. Yet the Map Intelligence Gateway (routes/mapProjection.ts) had NO place
 * producer: lib/mapProjection shaped travelers, gems, events, circle members,
 * buddies and trips, and `place` — the one kind every other §8/§9/§25 surface is
 * written around — was never collected. Places reached the shell only as
 * legacy `MapEntity<DiscoveryPlace>` envelopes built directly in
 * app/map/index.tsx from GET /api/discovery/places, which means every canonical
 * place on the map skipped:
 *
 *   • §24 protection   — a place standing inside a protected zone was drawn at
 *                        full precision, because the legacy path never runs
 *                        applyProtection (the audit's HIGH finding);
 *   • §31 aggregation  — a wide viewport drew hundreds of unranked pins instead
 *                        of collapsing them into area summaries (§37: "Do not
 *                        fill the screen with unranked POI pins");
 *   • §7 axes          — no place could carry activity / trend / freshness /
 *                        confidence, because enrichment only runs on objects
 *                        that pass through the projection;
 *   • §8 / §25         — a legacy envelope is not a MapObject, so tapping a
 *                        place could never open the Live Place sheet or arm the
 *                        action rail.
 *
 * This module is the place producer. Like every other projector it SHAPES:
 * rows in, MapObjects out. Unlike lib/mapProjection it also carries the READ
 * (`loadViewportPlaceRows`), because a place has no privacy-complete reader to
 * extract from — `places` holds public venue identity and no user column, so
 * the viewport read IS the whole source. The read takes an injected client (the
 * lib/placeIdBridge convention) so this file stays unit-testable without a
 * database.
 *
 * WHAT IS DERIVED HERE, AND WHAT IS DELIBERATELY NOT
 * ==================================================
 * Everything intelligence-shaped happens DOWNSTREAM, in the route's existing
 * pipeline, and this module is careful not to pre-empt it:
 *
 *   §7 axes / §9 provenance   `enrichWithLiveClaims` → `applyLiveClaims`
 *                             (deriveFreshness on the claim's observedAt /
 *                             validUntil, activity + trend from crowd.level /
 *                             crowd.trajectory, describeClaim for the Why?
 *                             lines). A place with no live claim carries NO
 *                             freshness, NO confidence and NO activity — §37,
 *                             "do not let stale claims remain visually live";
 *                             `updated_at` is row maintenance, not an
 *                             observation, and is never promoted into one.
 *   §24 protection            `applyProtection` — a canonical place inside a
 *                             suppress-class zone is withheld, inside a
 *                             coarsen-class zone it is snapped to the zone
 *                             anchor with every live signal stripped.
 *   §31 aggregation           `aggregateForViewport` — `place` is not in
 *                             NEVER_AGGREGATED_KINDS, so at world/city bands
 *                             places collapse into `activity_zone` cells and a
 *                             cell under the k floor is suppressed, not drawn.
 *   §19 last gate             `servableOnly` at the route; and `isServable` is
 *                             ALSO the last check inside `projectPlace`, so a
 *                             row that cannot be served never leaves this file
 *                             as an object (fail-closed at the producer too).
 *
 * THE ID BRIDGE, STATED ONCE SO IT IS NOT REDISCOVERED
 * ====================================================
 * Three id spaces meet at a place, and the repo has already been bitten by
 * treating them as one (lib/placeIdBridge.ts, intelCoverageProducer's
 * "demand id-space trap", mapProjection.projectGem's canonicalPlaceId):
 *
 *   public.places.id          THE LIVE-CLAIM SUBJECT. intel_state_snapshots
 *                             .subject_id → places(id) (migration 2130). The
 *                             object id is `place:<places.id>`, so
 *                             mapProjection.liveSubjectIdFor resolves straight
 *                             to it — no bridge needed on this axis.
 *   discovery_places.id       what saved_places.place_id and place memory key
 *                             on. A canonical place reaches that space only
 *                             through discovery_places.canonical_location_id
 *                             → places.id (migration 2053). NOT carried here:
 *                             a saved mark on a projected place would need
 *                             resolvePlaceIdBridge, and this unit does not
 *                             build one — it must never be approximated by
 *                             comparing places.id against saved_places.place_id.
 *   the Discovery SERVED id   `db/<places.id>` for canonical rows
 *                             (routes/discovery.ts queryCanonicalPlaces). That
 *                             is the key the client's bookmark / wishlist flow
 *                             and placeIdBridge.parseServedPlaceId accept, so
 *                             it is carried as `payload.discoveryId` — the
 *                             client saves a projected place under the SAME key
 *                             the legacy Discovery path used, rather than a bare
 *                             uuid that would split one place into two saves.
 *
 * COVERAGE, STATED HONESTLY
 * =========================
 * This reads `public.places` only. Curated `discovery_places` rows without a
 * canonical mirror and live OSM elements (`node/<id>`) are Discovery candidates,
 * not canonical places, and are not projected here. Until they are reconciled
 * into `places`, a city with no canonical rows serves no place pins through the
 * gateway. That is a data-coverage fact the route reports (`places.rows`), not
 * a reason to route around §24 by falling back to the legacy path.
 */
import {
  KIND_DEFAULT_PRIORITY,
  isServable,
  point,
  type MapObject,
  type PrivacyClass,
} from "./mapObjects.js";
import type { BBox } from "./mapAggregation.js";
import { logger } from "./logger.js";

/**
 * Structural DB reader — the subset of the Supabase client this module uses.
 * Typed loosely (the codebase convention, cf. lib/placeIdBridge) so the real
 * client's thenable query builder is assignable without fighting its generics.
 */
type DbLike = { from: (table: string) => any };

// ── The contract a canonical place is projected at ───────────────────────────

/**
 * A canonical place sits at its OWN coordinate: it is a public venue, not a
 * person, and its location is the fact it exists to publish. `place_level` is
 * therefore the honest rung — never `precise_temporary` (that rung is for a
 * consented temporary share, §23) and never a coarser rung that the renderer
 * would then draw as a ring around a building everyone can look up.
 *
 * §24 can still narrow it: applyProtection folds this through
 * narrowestPrivacyClass, so a place inside a coarsen-class zone leaves the
 * server at `approximate`, and one inside a suppress-class zone does not leave
 * at all.
 */
export const PLACE_PRIVACY_CLASS: PrivacyClass = "place_level";

/**
 * EXACTLY the columns `projectPlace` reads, and exactly what the viewport read
 * selects. ONE string, so the two cannot drift: src/test/mapProjectPlace.test.ts
 * parses `row.<column>` reads out of `projectPlace` and fails if any of them is
 * absent here — the guard that would have caught `g.thumbnail_url`
 * (mapProjection.projectGem's founding defect: a field the fixture invented,
 * the projector read, and the query never returned).
 *
 * Every name is a column `public.places` declares in the baseline
 * (baseline/20260819_baseline_structure.sql): note `country_code`, NOT
 * `country` — the founding defect of check:schema-references, hit three times
 * on this very table.
 */
export const PLACE_SELECT_COLUMNS =
  "id, name, primary_category, city, neighborhood, country_code, latitude, longitude, status, merged_into_place_id";

/**
 * The most rows one viewport read returns. The same bound
 * routes/mapProjection.ts already uses for its flow-zone place index
 * (MAX_INDEXED_PLACES), and REPORTED rather than silent: `loadViewportPlaceRows`
 * says when it hit the cap, and the route surfaces that as
 * `places.truncated`, because a capped read that reads as "that is every place
 * here" is the silent-truncation failure this codebase treats as a defect.
 */
export const MAX_PLACE_ROWS = 1_000;

/** The row shape `projectPlace` accepts — PLACE_SELECT_COLUMNS, structurally. */
export interface PlaceRowLike {
  id: string;
  name?: string | null;
  primary_category?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  country_code?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  status?: string | null;
  merged_into_place_id?: string | null;
}

/** The Discovery-served id for a canonical row — see the ID BRIDGE note above. */
export function discoveryServedIdFor(placeId: string): string {
  return `db/${placeId}`;
}

/** The app route a canonical place opens at: the living page + Quick Signal. */
export function placeDetailRoute(placeId: string): string {
  return `/place/${encodeURIComponent(placeId)}`;
}

// ── The projector ─────────────────────────────────────────────────────────────

/**
 * Project ONE canonical place row. Pure; returns null for anything that must
 * not become an object:
 *
 *   • no usable coordinate — a place with nothing to put on the map;
 *   • `status` other than 'active' — closed / duplicate / unverified rows are
 *     not canonical facts about the world right now (the read already filters
 *     these, and the projector re-checks so a caller cannot hand it a row the
 *     read would have refused);
 *   • merged into another place — the survivor is the canonical row;
 *   • anything `isServable` rejects (an empty name, a broken geometry).
 *
 * NOTHING INTELLIGENCE-SHAPED IS ASSERTED. No freshness, no confidence, no
 * activity, no trend, no provenance: a place row is identity + location, and
 * the only source of those fields is a live claim attached later by
 * `enrichWithLiveClaims`. Spec §37, twice: "Do not make predictions look like
 * observations" and "Do not let stale claims remain visually live".
 */
export function projectPlace(row: PlaceRowLike | null | undefined): MapObject | null {
  if (!row || typeof row !== "object") return null;
  if (typeof row.id !== "string" || row.id === "") return null;

  const lat = coordinate(row.latitude);
  const lng = coordinate(row.longitude);
  if (lat === null || lng === null) return null;

  if (row.status != null && row.status !== "active") return null;
  if (row.merged_into_place_id != null) return null;

  const name = typeof row.name === "string" ? row.name.trim() : "";
  const category = typeof row.primary_category === "string" ? row.primary_category : null;

  const obj: MapObject = {
    id: `place:${row.id}`,
    kind: "place",
    geometry: point(lat, lng),
    title: name,
    subtitle:
      joinParts([humanizeCategory(category), row.neighborhood ?? row.city], " · ") ?? undefined,
    privacyClass: PLACE_PRIVACY_CLASS,
    // §31's "Relevant Place" tier — the contract's default for the kind on both
    // mirrors. A place with qualifying live evidence is promoted to the
    // high-confidence live-zone tier by applyLiveClaims; nothing here ranks.
    renderingPriority: KIND_DEFAULT_PRIORITY.place,
    interaction: {
      // §8 ACTIONS: Go · Save · Ask Compass · Add to Trip · Meet Here · Share.
      // `report` on a contributable object is "report what is here" — the §22
      // observation sheet, which is exactly what a place accepts.
      actions: [
        "view",
        "save",
        "share",
        "navigate",
        "add_to_trip",
        "ask_compass",
        "meet_here",
        "report",
      ],
      detailRoute: placeDetailRoute(row.id),
      opensSheet: true,
      contributable: true,
    },
    payload: {
      category,
      city: row.city ?? null,
      neighborhood: row.neighborhood ?? null,
      countryCode: row.country_code ?? null,
      // THE LIVE-CLAIM SUBJECT. For a canonical place it is the row's own id —
      // carried explicitly, under the same name projectGem uses, so a card or a
      // sheet asks one question ("what is this object's canonical place?") of
      // every kind and never has to know that gems bridge and places do not.
      canonicalPlaceId: row.id,
      // The Discovery-served id — the bookmark / wishlist key. See the ID
      // BRIDGE note in the header.
      discoveryId: discoveryServedIdFor(row.id),
    },
  };

  // The last gate, applied at the producer as well as at the route boundary.
  return isServable(obj) ? obj : null;
}

// ── The read ──────────────────────────────────────────────────────────────────

export interface ViewportPlaceRead {
  rows: PlaceRowLike[];
  /** True when the viewport held more rows than `max` — the read is a SAMPLE. */
  truncated: boolean;
}

/**
 * Canonical places inside a viewport: active, unmerged, with a coordinate.
 *
 * Null means "the read FAILED", which the route must keep distinct from "no
 * places here": it leaves `places` out of `sources` rather than claiming an
 * empty layer it never obtained (the same contract every other layer in
 * routes/mapProjection.ts keeps). The PostgREST error is logged, not swallowed —
 * a select-list mistake on this table has already gone unnoticed for months
 * once (silentSchemaErrorCatches.test.ts), and this read must not be the site
 * where it happens again.
 *
 * Bounded at `max` (MAX_PLACE_ROWS by default) and ordered deterministically —
 * most recently maintained rows first, id as the tie-break — so paging across
 * polls is stable and a truncated viewport keeps returning the same sample
 * rather than a different thousand each time. One extra row is requested so
 * truncation can be REPORTED instead of inferred.
 */
export async function loadViewportPlaceRows(
  sc: DbLike | null | undefined,
  bbox: BBox,
  opts: { max?: number } = {},
): Promise<ViewportPlaceRead | null> {
  if (!sc) return null;
  const max = Math.max(1, Math.floor(opts.max ?? MAX_PLACE_ROWS));

  const { data, error } = await sc
    .from("places")
    .select(PLACE_SELECT_COLUMNS)
    .eq("status", "active")
    .is("merged_into_place_id", null)
    .gte("latitude", bbox.south)
    .lte("latitude", bbox.north)
    .gte("longitude", bbox.west)
    .lte("longitude", bbox.east)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(max + 1);

  if (error || !Array.isArray(data)) {
    logger.warn({ err: error ?? null }, "mapProjectPlace: viewport place read failed");
    return null;
  }

  const rows = data as PlaceRowLike[];
  return {
    rows: rows.length > max ? rows.slice(0, max) : rows,
    truncated: rows.length > max,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** A finite, in-range coordinate, from the number or numeric string PostgREST returns. */
function coordinate(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * `primary_category` is a vocabulary value ('night_market', 'other'). The
 * subtitle shows it as words; 'other' says nothing and is omitted rather than
 * rendered as a label.
 */
function humanizeCategory(category: string | null): string | null {
  if (!category || category === "other") return null;
  return category.replace(/_/g, " ");
}

function joinParts(parts: (string | null | undefined)[], sep: string): string | null {
  const s = parts.filter((p) => p != null && String(p).trim() !== "").join(sep);
  return s === "" ? null : s;
}
