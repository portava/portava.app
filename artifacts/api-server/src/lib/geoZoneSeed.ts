/**
 * geoZoneSeed — the ONE validator between a curated zone list and `geo_zones`.
 *
 * WHY THIS EXISTS (2026-09-07)
 * ============================
 * `geo_zones` holds ZERO rows in production. That is an independent blocker on
 * Map §10 Crowd Flow that the Map census does not record: routes/mapProjection.ts
 * refuses with `no_zone_model` when no curated zone covers the viewport, and it
 * is RIGHT to — lib/mapProjection's producer takes zone identity from the
 * caller and never falls back to a coordinate. The schema exists (0034, 2159
 * revoked every client write grant); the blocker is DATA, and populating it is
 * an ops action, not a migration. This module is what that ops action goes
 * through, whichever door it enters by:
 *
 *   POST /admin/geo-zones/import        routes/admin.ts, service role, dry-run
 *   db/seed/geo_zones_production_seed_template.sql   the owner's manual SQL,
 *                                        which re-implements the same rules in
 *                                        a DO block so the two cannot drift
 *                                        silently (src/test/geoZoneSeed.test.ts
 *                                        pins the rule set on both sides)
 *
 * WHAT A VALID ZONE IS, STATED ONCE
 * =================================
 *   1. `zoneType` is one of the LIVE CHECK constraint's values
 *      (geo_zones_zone_type_check: city | neighborhood | venue | custom |
 *      airport | hotel). Not the enum 0034 declared, not the list routes/admin.ts
 *      used to carry (`district`, `venue_area`, `safety_zone` — none of which
 *      the database accepts; they failed at INSERT with a db_error).
 *   2. Exactly ONE geometry: a circle (centerLat + centerLng + radiusMeters) or
 *      a GeoJSON Polygon whose outer ring is closed. Both, or neither, is an
 *      error — a zone with two geometries has two answers to "does it contain
 *      this point", and lib/protectedLocations.zoneCovers uses one of them.
 *   3. A zone of a FLOW type (lib/mapProjection FLOW_ZONE_TYPES: city,
 *      neighborhood) must be accepted by lib/mapProjection.parseFlowZones —
 *      i.e. be at least MIN_FLOW_ZONE_EXTENT_METERS across. That is the
 *      producer's own rule; the seed just refuses to store a zone the layer
 *      would drop on read, so "seeded but nothing happens" cannot occur.
 *   4. Names are unique, case- and whitespace-insensitively, within the batch
 *      AND against the zones already stored. lib/mapProjection rule 3: a name
 *      held by more than one zone resolves to NOTHING for the next-stop family,
 *      so importing a second "Downtown" would silently disable the first.
 *
 * Rows come out in `geo_zones` column names, `radius_meters` rounded to the
 * integer the live column is (int4 — 0034 said double precision; the live
 * schema disagrees, and the live schema wins), `is_system` / `verified`
 * defaulting to true (a seeded zone is server-curated by construction) and
 * `metadata.seed_source` carrying the file's provenance string.
 */
import { z } from "zod";
import {
  FLOW_ZONE_TYPES,
  MIN_FLOW_ZONE_EXTENT_METERS,
  normalizeAreaName,
  parseFlowZones,
} from "./mapProjection.js";

/** geo_zones_zone_type_check, as measured on portava-ci 2026-09-07. */
export const GEO_ZONE_DB_TYPES = ["city", "neighborhood", "venue", "custom", "airport", "hotel"] as const;
export type GeoZoneDbType = (typeof GEO_ZONE_DB_TYPES)[number];

export const GEO_ZONE_SAFETY_RATINGS = ["safe", "moderate", "caution", "avoid"] as const;

/** One import is one curated batch, not a bulk dump. */
export const MAX_SEED_ZONES = 500;

const Lng = z.number().min(-180).max(180);
const Lat = z.number().min(-90).max(90);
const Position = z.tuple([Lng, Lat]);

export const PolygonGeojsonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(Position).min(4)).min(1),
  })
  .strict();

export const GeoZoneSeedRowSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    zoneType: z.enum(GEO_ZONE_DB_TYPES),
    city: z.string().trim().min(1).max(120).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/, "countryCode must be ISO 3166-1 alpha-2, upper case").optional(),
    centerLat: Lat.optional(),
    centerLng: Lng.optional(),
    radiusMeters: z.number().positive().max(100_000).optional(),
    polygonGeojson: PolygonGeojsonSchema.optional(),
    safetyRating: z.enum(GEO_ZONE_SAFETY_RATINGS).optional(),
    isSystem: z.boolean().default(true),
    verified: z.boolean().default(true),
    featured: z.boolean().default(false),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const GeoZoneSeedFileSchema = z
  .object({
    version: z.literal(1),
    /** Provenance. Where these shapes came from and who curated them. */
    source: z.string().trim().min(1).max(500),
    zones: z.array(GeoZoneSeedRowSchema).min(1).max(MAX_SEED_ZONES),
  })
  .strict();

export type GeoZoneSeedRow = z.infer<typeof GeoZoneSeedRowSchema>;
export type GeoZoneSeedFile = z.infer<typeof GeoZoneSeedFileSchema>;

/** A `geo_zones` row, in column names, ready for the service-role insert. */
export interface GeoZoneInsertRow {
  name: string;
  zone_type: GeoZoneDbType;
  center_lat: number | null;
  center_lng: number | null;
  radius_meters: number | null;
  polygon_geojson: { type: "Polygon"; coordinates: number[][][] } | null;
  country_code: string | null;
  city: string | null;
  is_system: boolean;
  verified: boolean;
  featured: boolean;
  safety_rating: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
}

export type GeoZoneSeedIssueCode =
  | "schema"
  | "geometry"
  | "flow_ineligible"
  | "ambiguous_name"
  | "name_collision";

export interface GeoZoneSeedIssue {
  /** Index into `zones`, or null for a file-level issue. */
  index: number | null;
  name: string | null;
  code: GeoZoneSeedIssueCode;
  message: string;
}

export interface GeoZoneSeedReport {
  total: number;
  /** Zones the Crowd Flow loader will accept (flow type AND parseable). */
  flowEligible: number;
  byType: Record<string, number>;
}

export type GeoZoneSeedValidation =
  | { ok: true; rows: GeoZoneInsertRow[]; report: GeoZoneSeedReport }
  | { ok: false; issues: GeoZoneSeedIssue[] };

export interface ValidateGeoZoneSeedOptions {
  /** Names already in `geo_zones`; compared through normalizeAreaName. */
  existingNames?: readonly string[];
  /** Stamped on created_by. The service role has no auth.uid(); pass the admin. */
  createdBy?: string | null;
}

function hasCircle(z: GeoZoneSeedRow): boolean {
  return z.centerLat !== undefined || z.centerLng !== undefined || z.radiusMeters !== undefined;
}

function completeCircle(z: GeoZoneSeedRow): boolean {
  return z.centerLat !== undefined && z.centerLng !== undefined && z.radiusMeters !== undefined;
}

function ringClosed(ring: readonly (readonly number[])[]): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return !!first && !!last && first[0] === last[0] && first[1] === last[1];
}

/** The row shape lib/mapProjection.parseFlowZones reads. */
function toLoaderShape(row: GeoZoneInsertRow, id: string) {
  return {
    id,
    name: row.name,
    zone_type: row.zone_type,
    center_lat: row.center_lat,
    center_lng: row.center_lng,
    radius_meters: row.radius_meters,
    polygon_geojson: row.polygon_geojson,
  };
}

function toInsertRow(z: GeoZoneSeedRow, source: string, createdBy: string | null): GeoZoneInsertRow {
  const circle = completeCircle(z);
  return {
    name: z.name,
    zone_type: z.zoneType,
    center_lat: circle ? (z.centerLat as number) : null,
    center_lng: circle ? (z.centerLng as number) : null,
    radius_meters: circle ? Math.round(z.radiusMeters as number) : null,
    polygon_geojson: z.polygonGeojson ?? null,
    country_code: z.countryCode ?? null,
    city: z.city ?? null,
    is_system: z.isSystem,
    verified: z.verified,
    featured: z.featured,
    safety_rating: z.safetyRating ?? null,
    metadata: { ...(z.metadata ?? {}), seed_source: source },
    created_by: createdBy,
  };
}

/**
 * Validate a seed file. Every issue is collected — an operator fixing a
 * 40-zone file should not learn about them one at a time — and NOTHING is
 * returned for insertion unless there are none.
 */
export function validateGeoZoneSeed(
  input: unknown,
  opts: ValidateGeoZoneSeedOptions = {},
): GeoZoneSeedValidation {
  const parsed = GeoZoneSeedFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => {
        const idx = i.path[0] === "zones" && typeof i.path[1] === "number" ? i.path[1] : null;
        return {
          index: idx,
          name: null,
          code: "schema",
          message: `${i.path.join(".") || "(root)"}: ${i.message}`,
        };
      }),
    };
  }
  const file = parsed.data;
  const issues: GeoZoneSeedIssue[] = [];
  const rows: GeoZoneInsertRow[] = [];
  const createdBy = opts.createdBy ?? null;

  // Rule 2: exactly one geometry, and a polygon's outer ring is closed.
  file.zones.forEach((z, index) => {
    const circleAny = hasCircle(z);
    const circleAll = completeCircle(z);
    const polygon = z.polygonGeojson !== undefined;
    if (circleAny && !circleAll) {
      issues.push({ index, name: z.name, code: "geometry", message: "a circle needs centerLat, centerLng AND radiusMeters" });
    }
    if (circleAll && polygon) {
      issues.push({ index, name: z.name, code: "geometry", message: "give a circle OR a polygon, not both" });
    }
    if (!circleAny && !polygon) {
      issues.push({ index, name: z.name, code: "geometry", message: "a zone needs a circle (centerLat/centerLng/radiusMeters) or a polygonGeojson" });
    }
    if (polygon && !ringClosed(z.polygonGeojson!.coordinates[0])) {
      issues.push({ index, name: z.name, code: "geometry", message: "polygonGeojson outer ring must be closed (first position repeated last)" });
    }
  });

  // Rule 4: unique names, normalized, within the batch and against the store.
  const seen = new Map<string, number[]>();
  file.zones.forEach((z, index) => {
    const key = normalizeAreaName(z.name);
    if (!key) {
      issues.push({ index, name: z.name, code: "schema", message: "name normalizes to nothing" });
      return;
    }
    seen.set(key, [...(seen.get(key) ?? []), index]);
  });
  for (const [key, idxs] of seen) {
    if (idxs.length > 1) {
      for (const index of idxs) {
        issues.push({
          index,
          name: file.zones[index].name,
          code: "ambiguous_name",
          message: `name "${key}" appears ${idxs.length} times in this batch; an ambiguous name resolves to NO zone (lib/mapProjection rule 3)`,
        });
      }
    }
  }
  const existing = new Set((opts.existingNames ?? []).map(normalizeAreaName).filter((k): k is string => !!k));
  file.zones.forEach((z, index) => {
    const key = normalizeAreaName(z.name);
    if (key && existing.has(key)) {
      issues.push({
        index,
        name: z.name,
        code: "name_collision",
        message: `a zone named "${key}" already exists; importing another would make BOTH unresolvable by name (lib/mapProjection rule 3)`,
      });
    }
  });

  // Rule 3: a flow-type zone must survive the loader's own parser.
  let flowEligible = 0;
  const byType: Record<string, number> = {};
  file.zones.forEach((z, index) => {
    byType[z.zoneType] = (byType[z.zoneType] ?? 0) + 1;
    const row = toInsertRow(z, file.source, createdBy);
    rows.push(row);
    if (!FLOW_ZONE_TYPES.includes(z.zoneType)) return;
    if (issues.some((i) => i.index === index && i.code === "geometry")) return; // already reported
    const accepted = parseFlowZones([toLoaderShape(row, `seed-${index}`)]);
    if (accepted.length === 1) {
      flowEligible += 1;
    } else {
      issues.push({
        index,
        name: z.name,
        code: "flow_ineligible",
        message:
          `a ${z.zoneType} zone must be at least ${MIN_FLOW_ZONE_EXTENT_METERS} m across ` +
          `(circle diameter or polygon bounding box) or Crowd Flow drops it on read`,
      });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, rows, report: { total: rows.length, flowEligible, byType } };
}
