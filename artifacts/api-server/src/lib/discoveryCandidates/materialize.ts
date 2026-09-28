/**
 * Retrieved ids → served Discovery rows, under the SAME eligibility the route's
 * own reads apply — census-discovery §85 (lane W10-R3), DC-12.
 *
 * WHY THIS IS NOT A SHORTCUT AROUND ELIGIBILITY. A §85 retrieval returns ids;
 * it decides nothing about whether a row may be served. Every rule
 * routes/discovery.ts `queryDbPlaces` and `queryCanonicalPlaces` apply to a row
 * they read is applied here to a row a retrieval named, and no other:
 *
 *   discovery_places  status = 'active'; the city prefix; demo/QA sources
 *                     excluded (DEMO_SOURCES mirrors DEMO_DISCOVERY_SOURCES);
 *                     a submitter blocked in either direction is not served
 *                     (lib/blocks submitterIsVisible — an unreadable block set
 *                     drops every authored row, fail closed); a submitter not
 *                     in good standing is not served
 *                     (lib/discoveryCacheEligibility — unreadable standing
 *                     drops every authored row, as the route reports it);
 *   places            status = 'active'; not merged; the city prefix.
 *
 * The row SHAPE is `queryDbPlaces`' / `queryCanonicalPlaces`' mapping, field
 * for field, so a generated row is indistinguishable on the wire from one the
 * route read (src/test/discoveryCandidateSources.test.ts M-series pins the
 * select lists against the route's source). §95 (W11-X3, D-W11X3-3) closed the
 * two differences §85 stated:
 *   - `distanceKm` is measured from `ctx.center` exactly as the route measures
 *     it, and is null only when no centre was handed in (as `queryDbPlaces`);
 *   - the vote/review aggregates are merged onto curated rows as the route
 *     merges them (lib/discoveryPlaceAggregates, pinned equal to the route's).
 *
 * After PDE ranks, the route's own post-rank gates — `applyFilters`, the
 * "Not interested" gate and the Layover gate — run over generated rows exactly
 * as over the pool, because they run over `outcome.ranked`.
 */
import { toCanonicalCategory } from "../placeCategories.js";
import { fetchBlockedSet, submitterIsVisible } from "../blocks.js";
import { inactiveSubmitterIds, submitterInGoodStanding } from "../discoveryCacheEligibility.js";
import { IN_LIST_CAP } from "./retrievals.js"; import { servedDistanceKm, batchFetchVoteAndRatingAggregates } from "../discoveryPlaceAggregates.js";

/** Mirrors routes/discovery.ts DEMO_DISCOVERY_SOURCES (pinned equal by test). */
export const DEMO_SOURCES: ReadonlySet<string> = new Set(["seed_script", "demo", "qa_fixture"]);

/** The select `queryDbPlaces` makes, verbatim (pinned by test). */
export const DISCOVERY_PLACES_SELECT = "id, city, name, place_type, category, primary_category, secondary_categories, neighborhood, blurb, image_url, header_image_source, image_source_type, image_accuracy_status, rating, saved_count, lat, lng, tag, verified, created_at, source, submitted_by";
/** The select `queryCanonicalPlaces` makes, verbatim (pinned by test). */
export const CANONICAL_PLACES_SELECT = "id, name, city, primary_category, latitude, longitude, neighborhood, address, image_source_type, image_accuracy_status";

/** A served Discovery row, structurally `routes/discovery.ts` `DiscoveryPlace`. */
export interface MaterialisedPlace {
  id: string;
  canonicalPlaceId?: string | null;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  lat: number | null;
  lng: number | null;
  tags: string[];
  address: string | null;
  neighborhood?: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
  savedCount?: number;
  attribution?: string | null;
  headerImageUrl?: string | null;
  headerImageSource?: string | null;
  imageSourceType?: string | null;
  accuracyStatus?: string | null;
  disclaimerRequired?: boolean | null;
  disclaimerText?: string | null; /** §95: the route's aggregates, on curated rows only. */ worthItCount?: number; avgRating?: number | null; reviewCount?: number;
}

export interface MaterialiseOutcome {
  rows: Map<string, MaterialisedPlace>;
  /** Submitter per generated row id — PDE-internal, never serialised. */
  submitterById: Map<string, string>;
  /** Reads that failed; an empty list means every read answered. */
  failedReads: string[];
  /** Rows a rule removed, by rule — so "none admitted" says why. */
  refused: Record<"blocked" | "standing" | "demo" | "category", number>;
}

function placeMustShowDisclaimer(accuracyStatus: string | null | undefined): boolean {
  return accuracyStatus === "illustrative_only" || accuracyStatus === "rejected";
}
function placeDisclaimerText(accuracyStatus: string | null | undefined): string | null {
  if (accuracyStatus === "illustrative_only") return "Illustrative image — this does not show the actual location.";
  if (accuracyStatus === "rejected") return "This image may not show the actual location.";
  return null;
}

/** `queryDbPlaces`' row mapping (center unknown ⇒ distance null). */
export function mapDiscoveryPlacesRow(row: any, center: { lat: number; lng: number } | null = null): MaterialisedPlace {
  const lat = row.lat != null ? parseFloat(String(row.lat)) : null;
  const lng = row.lng != null ? parseFloat(String(row.lng)) : null;
  const effectiveCategory: string = (row.primary_category as string | null)
    ?? toCanonicalCategory((row.category ?? "") as string, (row.place_type ?? "") as string);
  return {
    id: `db/${row.id as string}`,
    name: row.name as string,
    category: effectiveCategory,
    type: (row.place_type ?? null) as string | null,
    description: (row.blurb ?? null) as string | null,
    distanceKm: servedDistanceKm(center, lat, lng),
    lat,
    lng,
    tags: [row.category, row.tag].filter(Boolean) as string[],
    address: (row.neighborhood ?? null) as string | null, neighborhood: (row.neighborhood ?? null) as string | null,
    website: null,
    phone: null,
    openingHours: null,
    rating: row.rating != null ? parseFloat(String(row.rating)) : null,
    isOpenNow: null,
    savedCount: (row.saved_count as number) ?? 0,
    headerImageUrl: (row.image_url ?? null) as string | null,
    headerImageSource: (row.header_image_source ?? null) as string | null,
    imageSourceType: (row.image_source_type ?? null) as string | null,
    accuracyStatus: (row.image_accuracy_status ?? null) as string | null,
    disclaimerRequired: placeMustShowDisclaimer(row.image_accuracy_status as string | null),
    disclaimerText: placeDisclaimerText(row.image_accuracy_status as string | null),
    attribution: (row.source as string | null)?.startsWith("fsq") ? "Place data © Foursquare (CC BY 4.0)" : null,
  };
}

/** `queryCanonicalPlaces`' row mapping (center unknown ⇒ distance null). */
export function mapCanonicalPlacesRow(row: any, center: { lat: number; lng: number } | null = null): MaterialisedPlace {
  const lat = row.latitude != null ? parseFloat(String(row.latitude)) : null;
  const lng = row.longitude != null ? parseFloat(String(row.longitude)) : null;
  return {
    id: `db/${row.id as string}`,
    canonicalPlaceId: row.id as string,
    name: row.name as string,
    category: toCanonicalCategory(row.primary_category as string, null),
    type: (row.primary_category ?? null) as string | null,
    description: null,
    distanceKm: servedDistanceKm(center, lat, lng),
    lat,
    lng,
    tags: [row.primary_category].filter(Boolean) as string[],
    address: (row.neighborhood ?? row.address ?? null) as string | null, neighborhood: (row.neighborhood ?? null) as string | null,
    website: null,
    phone: null,
    openingHours: null,
    rating: null,
    isOpenNow: null,
    savedCount: 0,
    headerImageUrl: null,
    headerImageSource: null,
    imageSourceType: (row.image_source_type ?? null) as string | null,
    accuracyStatus: (row.image_accuracy_status ?? null) as string | null,
    disclaimerRequired: placeMustShowDisclaimer(row.image_accuracy_status as string | null),
    disclaimerText: placeDisclaimerText(row.image_accuracy_status as string | null),
    attribution: null,
  };
}

/** Does a discovery_places row belong on a tab? `null` admits every category (`for_you`). */
function admitsDiscoveryRow(row: any, admitted: ReadonlySet<string> | null): boolean {
  if (!admitted) return true;
  const effective: string = (row.primary_category as string | null)
    ?? toCanonicalCategory((row.category ?? "") as string, (row.place_type ?? "") as string);
  if (admitted.has(effective)) return true;
  const secondary: string[] = Array.isArray(row.secondary_categories) ? row.secondary_categories : [];
  return secondary.some((c) => admitted.has(c));
}

/**
 * Materialise `db/<uuid>` ids in the request's city. Non-`db/` ids are never
 * materialised: an OSM row exists only in Overpass's answer, which PDE does not
 * fetch (D5=B), so such an id can only claim a row already in the pool.
 */
export async function materialiseCandidates(
  sc: any,
  ids: readonly string[],
  ctx: { viewerId: string; cityPrefix: string; admitted: ReadonlySet<string> | null; /** §95: the request's reference point, as the route passes it to queryDbPlaces. */ center?: { lat: number; lng: number } | null },
): Promise<MaterialiseOutcome> {
  const out: MaterialiseOutcome = { rows: new Map(), submitterById: new Map(), failedReads: [], refused: { blocked: 0, standing: 0, demo: 0, category: 0 } };
  const uuids = [...new Set(ids.filter((i) => i.startsWith("db/")).map((i) => i.slice(3)))].slice(0, IN_LIST_CAP);
  if (!sc || uuids.length === 0) return out;

  let dp: any[] = [];
  try {
    const { data, error } = await sc
      .from("discovery_places")
      .select(DISCOVERY_PLACES_SELECT)
      .in("id", uuids)
      .ilike("city", `${ctx.cityPrefix}%`)
      .eq("status", "active")
      .order("id", { ascending: true });
    if (error) out.failedReads.push("discovery_places"); else dp = Array.isArray(data) ? data : [];
  } catch { out.failedReads.push("discovery_places"); }

  const authored = dp.map((r) => r.submitted_by).filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
  let blocked: Set<string> | null = new Set();
  let inactive: Set<string> | null = new Set();
  if (authored.length > 0) {
    blocked = await fetchBlockedSet(sc, ctx.viewerId);
    inactive = await inactiveSubmitterIds(sc, authored);
    if (blocked === null) out.failedReads.push("blocks");
    if (inactive === null) out.failedReads.push("profiles.standing");
  }
  const found = new Set<string>();
  for (const row of dp) {
    found.add(String(row.id));
    if (DEMO_SOURCES.has(row.source as string)) { out.refused.demo++; continue; }
    if (!submitterIsVisible(row.submitted_by, blocked)) { out.refused.blocked++; continue; }
    if (!submitterInGoodStanding(row.submitted_by, inactive)) { out.refused.standing++; continue; }
    if (!admitsDiscoveryRow(row, ctx.admitted)) { out.refused.category++; continue; }
    const mapped = mapDiscoveryPlacesRow(row, ctx.center ?? null);
    out.rows.set(mapped.id, mapped);
    if (typeof row.submitted_by === "string" && row.submitted_by) out.submitterById.set(mapped.id, row.submitted_by);
  }

  await mergeRouteAggregates(sc, out);
  const rest = uuids.filter((u) => !found.has(u));
  if (rest.length === 0 || out.failedReads.includes("discovery_places")) return out;
  try {
    const { data, error } = await sc
      .from("places")
      .select(CANONICAL_PLACES_SELECT)
      .in("id", rest)
      .ilike("city", `${ctx.cityPrefix}%`)
      .eq("status", "active")
      .is("merged_into_place_id", null)
      .order("id", { ascending: true });
    if (error) { out.failedReads.push("places"); return out; }
    for (const row of (Array.isArray(data) ? data : [])) {
      const mapped = mapCanonicalPlacesRow(row, ctx.center ?? null);
      if (ctx.admitted && !ctx.admitted.has(mapped.category)) { out.refused.category++; continue; }
      out.rows.set(mapped.id, mapped);
    }
  } catch { out.failedReads.push("places"); }
  return out;
}

/**
 * §95 (D-W11X3-3): `queryDbPlaces`' aggregate step, over the curated rows
 * admitted so far — the same helper, the same merge (`{ ...p, worthItCount,
 * avgRating, reviewCount }` only where the helper has an entry). Canonical
 * rows get none, as in the route. A failed read merges nothing, as in the route.
 */
async function mergeRouteAggregates(sc: any, out: MaterialiseOutcome): Promise<void> {
  const ids = [...out.rows.keys()].map((id) => id.slice(3));
  if (ids.length === 0) return;
  const agg = await batchFetchVoteAndRatingAggregates(sc, ids, "place");
  if (agg.size === 0) return;
  for (const [id, p] of out.rows) {
    const a = agg.get(id.slice(3));
    if (a) out.rows.set(id, { ...p, worthItCount: a.worthItCount, avgRating: a.avgRating, reviewCount: a.reviewCount });
  }
}
