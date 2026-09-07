/**
 * TripDiscoveryProjection — the Trip-owned contract Discovery consumes.
 *
 * Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
 *   §1    "No Map, Compass, Telegraph, Discovery, Buddy, or UI component may
 *         independently invent canonical trip state."
 *   §1.1  Context distribution: "Stable typed projections for Compass, Map,
 *         Telegraph, Discovery, Safety, Passport, Memory."
 *   §6.3  "Public Trip content must not leak lodging detail, exact private
 *         location, future absence from home, safety state, or unconsented
 *         participant data."
 *   §18.4 "Server aggregate version is canonical. Clients may cache current
 *         version and projections."
 *   §19.1 "Every projection includes generatedAt, sourceTripVersion,
 *         projectionSchemaVersion, and freshness status. Consumers reject or
 *         visibly degrade on stale/incompatible critical projections."
 *   §25   "Map, Compass, Discovery ... consume explicit Trip projections /
 *         contracts rather than duplicating Trip semantics."
 *   Appendix B  TRIP_PROJECTION_* reason-code family.
 *
 * WHY THIS EXISTS
 * ===============
 * census-discovery.md A10 / decision D3: Discovery re-derives trip visibility
 * itself (routes/discoverySearch.ts searchTrips / searchPlans read `trips`
 * columns and re-state "public AND show_in_discovery AND status not
 * draft/cancelled/archived, or caller-owned"). That is correct today and is
 * exactly the duplication §25 forbids. A projection authored on the Discovery
 * side would itself be Discovery inventing Trip semantics, so it is published
 * HERE, by Trips, and Discovery consumes it. This module reads `trips`; a
 * consumer never does.
 *
 * WHAT THE PROJECTION IS
 * ======================
 * The non-member tier of a trip, as Trips already defines it for a viewer who
 * is not on the trip (lib/privacy/tripSerializers.toPrivateTripPreview), plus
 * the one visibility rule Discovery needs (`discoverable`), inside the §19.1
 * envelope. It is built ON TOP of toPrivateTripPreview rather than beside it,
 * so the owner's privacy toggles (show_exact_dates, show_destination_city,
 * show_header_publicly) apply to a Discovery searcher exactly as they apply to
 * any other non-member — one rule, one place. Fields are COPIED into a fresh,
 * narrow object (never a key-delete off a wider row), so a column this shape
 * does not list can never reach a consumer.
 *
 * It is a projection of CANONICAL STATE AT READ TIME, not of the event stream:
 * there is no projection worker (§19.4) and no outbox consumer (§4.4) in this
 * codebase yet. `freshness` is therefore always "live" — generated from the
 * canonical row in the same request — and `generatedAt` is that instant.
 * `sourceTripVersion` is trips.version (migration 2420). A value of 0 means the
 * row has never been written through the kernel; legacy direct writers do not
 * bump it (tripKernelWriterBaseline.ts), so 0 is "no kernel history", not
 * "never changed".
 *
 * VERSIONING
 * ==========
 * TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION is bumped when a field is renamed,
 * removed, or changes meaning. Adding a field is additive and does not bump it.
 * A consumer checks the version it can read (readers below refuse nothing on
 * its behalf — §19.1 makes rejecting/degrading the CONSUMER's duty).
 *
 * WHAT THE READERS NEED
 * =====================
 * Migration 2420 (trips.version). On a database without it every read fails
 * closed as TRIP_PROJECTION_UNAVAILABLE — supabase-js RESOLVES on a database
 * error, so `error` is read explicitly and never mistaken for an empty result.
 * Production (ajrurzioarfkagpuxfnb) does not have 2420 as of 2026-09-07;
 * Discovery must not switch to these readers there before 2334 -> 2337 -> 2420
 * are applied, or trip search would return nothing.
 *
 * WHAT DISCOVERY GIVES UP BY CONSUMING THIS (reported, not hidden)
 * ================================================================
 * Today searchTrips returns start_date, destination_city and cover_url of a
 * public trip regardless of the owner's toggles; a non-member reading the trip
 * page through toPrivateTripPreview does not see them when the toggles are off.
 * Through this projection Discovery sees what the trip page shows. Production
 * measured 2026-09-07: 12 discoverable trips, 0 with any toggle off, so the
 * difference is currently unobservable. Ordering and date-bounding still use
 * the true start_date in SQL (searchTripDiscoveryProjections), which is what
 * Discovery does today; a hidden date's position in a date-ordered list is a
 * bounded inference the owner of a public trip has accepted by opting into
 * discovery, and is recorded here rather than silently kept.
 */
import { toPrivateTripPreview } from "./privacy/tripSerializers.js";

/** Bump on rename / removal / meaning change of a field. Additive changes do not bump. */
export const TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION = 1 as const;

/**
 * The lifecycle states a trip is never surfaced in. `trip_status` labels only
 * (draft | planning | upcoming | active | completed | cancelled | archived);
 * routes/discoverySearch.ts learned the hard way that a non-label makes
 * Postgres reject the whole query (22P02) rather than match nothing.
 */
export const TRIP_DISCOVERY_EXCLUDED_STATUSES = ["draft", "cancelled", "archived"] as const;

/** "live": generated from the canonical row in the same request. No other value exists yet (no projection worker). */
export type TripDiscoveryFreshness = "live";

export interface TripDiscoveryProjection {
  // ── §19.1 envelope ──
  projectionSchemaVersion: typeof TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION;
  /** ISO instant the projection was generated. */
  generatedAt: string;
  /** trips.version (2420). 0 = no kernel history; see header. */
  sourceTripVersion: number;
  freshness: TripDiscoveryFreshness;

  // ── identity ──
  tripId: string;
  /** Needed by the consumer for ITS OWN rules (block list, age restriction, owner status) — never displayed. */
  ownerId: string;

  // ── the visibility rule, decided here ──
  /**
   * visibility = 'public' AND show_in_discovery AND status not in
   * TRIP_DISCOVERY_EXCLUDED_STATUSES. This is the whole rule; a consumer does
   * not re-derive it from `status` or any other field.
   */
  discoverable: boolean;

  // ── non-member tier (toPrivateTripPreview), narrowed to what a search card shows ──
  title: string;
  /** null when the owner has hidden the city (show_destination_city = false). */
  destinationCity: string | null;
  destinationCountry: string | null;
  /** Placeholder URL when the owner has hidden the header (show_header_publicly = false). */
  coverUrl: string | null;
  /** null when the owner has hidden exact dates (show_exact_dates = false). */
  startDate: string | null;
  endDate: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Explicit select list — the only `trips` columns this contract ever reads. */
export const TRIP_DISCOVERY_SOURCE_COLUMNS =
  "id, owner_id, title, destination_city, destination_country, cover_url, start_date, end_date, " +
  "status, visibility, show_in_discovery, show_exact_dates, show_destination_city, show_header_publicly, " +
  "precise_location_visible, trip_type, open_to_meet, created_at, updated_at, version";

/** The discoverability rule as a pure function of the row; the SQL predicate in searchTripDiscoveryProjections says the same thing. */
export function isTripDiscoverable(row: {
  visibility?: string | null;
  show_in_discovery?: boolean | null;
  status?: string | null;
}): boolean {
  return (
    row.visibility === "public" &&
    row.show_in_discovery === true &&
    !(TRIP_DISCOVERY_EXCLUDED_STATUSES as readonly string[]).includes(String(row.status))
  );
}

/**
 * Build one projection from a `trips` row. Pure; `generatedAt` is injectable so
 * a test can pin it. The row must carry TRIP_DISCOVERY_SOURCE_COLUMNS.
 */
export function projectTripForDiscovery(row: Record<string, any>, generatedAt: string = new Date().toISOString()): TripDiscoveryProjection {
  // The non-member tier, as Trips defines it for every other non-member surface.
  const tier = toPrivateTripPreview(row, null);
  const version = Number(row.version);
  return {
    projectionSchemaVersion: TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION,
    generatedAt,
    sourceTripVersion: Number.isFinite(version) && version >= 0 ? version : 0,
    freshness: "live",
    tripId: tier.id,
    ownerId: String(row.owner_id),
    discoverable: isTripDiscoverable(row),
    title: tier.title,
    destinationCity: tier.destinationCity,
    destinationCountry: tier.destinationCountry,
    coverUrl: tier.coverUrl,
    startDate: tier.startDate,
    endDate: tier.endDate,
    status: tier.status,
    createdAt: tier.createdAt,
    updatedAt: tier.updatedAt,
  };
}

/**
 * May `viewerId` be shown this trip (or its plan items) on a discovery
 * surface? The rule Discovery's searchPlans states today, owned here: a
 * discoverable trip, or the viewer's own trip — and never a trip in an
 * excluded lifecycle state, whoever is asking.
 */
export function tripDiscoveryAdmits(p: Pick<TripDiscoveryProjection, "discoverable" | "ownerId" | "status">, viewerId: string | null): boolean {
  if ((TRIP_DISCOVERY_EXCLUDED_STATUSES as readonly string[]).includes(p.status)) return false;
  return p.discoverable || (viewerId !== null && p.ownerId === viewerId);
}

// ── Readers ───────────────────────────────────────────────────────────────────

export type TripDiscoveryProjectionResult =
  | { ok: true; projections: TripDiscoveryProjection[]; generatedAt: string }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE"; detail: string };

export interface TripDiscoverySearchQuery {
  /** Free text; matched with ILIKE against title, destination_city, destination_country. */
  text: string;
  /** ISO instant or YYYY-MM-DD; trips starting on/after this date. */
  startsAfter?: string | null;
  /** ISO instant or YYYY-MM-DD; trips starting strictly before this date. */
  startsBefore?: string | null;
  offset: number;
  limit: number;
}

/**
 * ILIKE pattern for a PostgREST `.or("col.ilike.<pat>,...")` clause. `,` `(`
 * `)` are structure in that grammar and carry no search meaning, so they are
 * stripped; LIKE wildcards are escaped. Same rule Discovery applies today, so
 * the switch changes which rows match by nothing.
 */
export function tripDiscoveryIlikePattern(text: string): string {
  return `%${text.replace(/[,()]/g, "").replace(/[%_]/g, "\\$&")}%`;
}

/**
 * Discoverable trips matching a free-text query, ordered by start_date, paged.
 * The discoverability predicate runs in SQL so pagination is over admitted
 * rows only. Every returned projection has discoverable = true.
 */
export async function searchTripDiscoveryProjections(sc: any, q: TripDiscoverySearchQuery): Promise<TripDiscoveryProjectionResult> {
  const generatedAt = new Date().toISOString();
  try {
    const pat = tripDiscoveryIlikePattern(q.text);
    let query: any = sc
      .from("trips")
      .select(TRIP_DISCOVERY_SOURCE_COLUMNS)
      .or(`title.ilike.${pat},destination_city.ilike.${pat},destination_country.ilike.${pat}`)
      .eq("visibility", "public")
      .eq("show_in_discovery", true)
      .not("status", "in", `(${TRIP_DISCOVERY_EXCLUDED_STATUSES.map((s) => `"${s}"`).join(",")})`)
      .order("start_date", { ascending: true });
    if (q.startsAfter) query = query.gte("start_date", q.startsAfter.slice(0, 10));
    if (q.startsBefore) query = query.lt("start_date", q.startsBefore.slice(0, 10));
    const { data, error } = await query.range(q.offset, q.offset + q.limit - 1);
    if (error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: String(error.message ?? error) };
    const rows: any[] = Array.isArray(data) ? data : [];
    return { ok: true, generatedAt, projections: rows.map((r) => projectTripForDiscovery(r, generatedAt)) };
  } catch (e) {
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: (e as Error)?.message ?? String(e) };
  }
}

/**
 * Projections for specific trips, discoverable or not (the consumer applies
 * tripDiscoveryAdmits per viewer). Ids that do not exist are simply absent.
 */
export async function readTripDiscoveryProjections(sc: any, tripIds: readonly string[]): Promise<TripDiscoveryProjectionResult> {
  const generatedAt = new Date().toISOString();
  const ids = [...new Set(tripIds)].filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return { ok: true, generatedAt, projections: [] };
  try {
    const { data, error } = await sc.from("trips").select(TRIP_DISCOVERY_SOURCE_COLUMNS).in("id", ids);
    if (error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: String(error.message ?? error) };
    const rows: any[] = Array.isArray(data) ? data : [];
    return { ok: true, generatedAt, projections: rows.map((r) => projectTripForDiscovery(r, generatedAt)) };
  } catch (e) {
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: (e as Error)?.message ?? String(e) };
  }
}
