/**
 * Trip-owned projections Discovery reads instead of the Trip tables:
 * the PLAN-ITEM search projection and the viewer's NEXT-TRIP projection.
 *
 * census-discovery A10 (§57.6, §57.10 Q3, §81; register D-W10S2-4). Trips spec
 * `:25`, `:488` — *"Map, Compass, Discovery … consume explicit Trip
 * projections/contracts rather than duplicating Trip semantics."* §57 found four
 * direct Trip reads left in Discovery. Two sit behind the `TripDiscoveryProjection`
 * capability already (tripDiscoveryProjection.ts). The other two had nothing to
 * move to, because Trips published no plan-item projection and no viewer-trip
 * projection. These are those two, published HERE by Trips so the Trip
 * semantics they carry are Trips'.
 *
 * Both follow tripDiscoveryProjection.ts's §19.1 envelope: `generatedAt`, a
 * `projectionSchemaVersion`, `freshness: "live"` (a projection of canonical
 * state at read time — there is no projection worker yet), and a refusal that
 * is never mistaken for an empty answer (supabase-js RESOLVES on a database
 * error, so `error` is read explicitly).
 *
 * ── 1. PLAN ITEMS ───────────────────────────────────────────────────────────
 * Which plan items match a search, with the Trip rule that a REMOVED item is
 * not a plan item (`removed_at IS NULL`). Visibility is the PARENT trip's,
 * decided by `TripDiscoveryProjection` / `tripDiscoveryAdmits`, exactly as the
 * consumer already does; this projection carries the parent's id and nothing
 * about the trip. Fields are copied into a fresh narrow object: title, trip,
 * creator, created instant — no description, cost, booking, location or note
 * column of `trip_plan_items` can reach a consumer through it.
 *
 * ── 2. THE VIEWER'S NEXT TRIP (§57.10 Q3, decided: D-W10S2-4) ───────────────
 * "Which trip is this traveller's next one" is a Trip semantic. Discovery's own
 * reader decided it with two rules Trips does not hold:
 *   • it counted `planning` and `active` but not `upcoming`, which is the
 *     storage label (`domain/trips/invariants/tripStatus.ts`) for a trip whose
 *     start is ahead of it — the most "next" a trip can be;
 *   • it counted trips the viewer OWNS, not trips they joined. An accepted
 *     member's trip is their trip for every other Trip surface
 *     (`requireTripMember`'s accepted status is what admits them to its plan,
 *     its crew and its Telegraph thread).
 * The projection answers with Trips' reading: owned OR accepted-member trips,
 * status `planning`, `upcoming` or `active`, earliest start first (a trip with
 * no start date sorts last, as PostgreSQL's ASC does for the legacy reader),
 * ties broken by trip id so two reads of one world agree. It carries the
 * destination city (what `?context=going_soon` resolves), the start date, the
 * status and the viewer's role — nothing about other members.
 */

/** Bumped when a field is renamed, removed, or changes meaning. */
export const TRIP_PLAN_ITEM_PROJECTION_SCHEMA_VERSION = 1;
export const TRIP_VIEWER_NEXT_TRIP_PROJECTION_SCHEMA_VERSION = 1;

/** Storage statuses (`trip_status`) that make a trip one the traveller is still going on. */
export const NEXT_TRIP_STATUSES = ["planning", "upcoming", "active"] as const;

export interface TripPlanItemProjection {
  projectionSchemaVersion: number;
  planItemId: string;
  tripId: string;
  title: string | null;
  creatorId: string | null;
  createdAt: string | null;
}

export type TripPlanItemProjectionResult =
  | { ok: true; generatedAt: string; freshness: "live"; items: TripPlanItemProjection[] }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE"; detail: string };

export interface TripPlanItemSearchQuery {
  /**
   * An ILIKE pattern the CONSUMER has already escaped for PostgREST (Discovery's
   * `sqlPattern`, identical to `tripDiscoveryIlikePattern`). Passed through so
   * the switch changes which rows match by nothing.
   */
  pattern: string;
  offset: number;
  limit: number;
  /** census-trips §81: the searcher. Another member's private item never matches on its (withheld) title; absent = no private item matches. */
  viewerId?: string | null;
}

/**
 * Plan items whose title matches, newest first, paged. Removed items are not
 * plan items. The parent trip's visibility is NOT decided here.
 */
export async function searchTripPlanItemProjections(sc: any, q: TripPlanItemSearchQuery): Promise<TripPlanItemProjectionResult> {
  const generatedAt = new Date().toISOString();
  try {
    const { data, error } = await sc
      .from("trip_plan_items")
      .select("id, title, trip_id, creator_id, created_at, location_is_private")
      .ilike("title", q.pattern)
      .is("removed_at", null)
      .order("created_at", { ascending: false })
      .range(q.offset, q.offset + q.limit - 1);
    if (error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: String(error.message ?? error) };
    // census-trips §81: a private item's title is its owner's — it is not searchable by anyone else (grants
    // give sight on the trip's own surfaces, not a search index).
    const rows: any[] = (Array.isArray(data) ? data : []).filter((r: any) => r.location_is_private === false || (typeof q.viewerId === "string" && r.creator_id === q.viewerId));
    return {
      ok: true, generatedAt, freshness: "live",
      items: rows.map((r): TripPlanItemProjection => ({
        projectionSchemaVersion: TRIP_PLAN_ITEM_PROJECTION_SCHEMA_VERSION,
        planItemId: String(r.id),
        tripId: String(r.trip_id),
        title: typeof r.title === "string" ? r.title : null,
        creatorId: typeof r.creator_id === "string" ? r.creator_id : null,
        createdAt: typeof r.created_at === "string" ? r.created_at : null,
      })),
    };
  } catch (e) {
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: (e as Error)?.message ?? String(e) };
  }
}

export interface TripViewerNextTripProjection {
  projectionSchemaVersion: number;
  tripId: string;
  destinationCity: string | null;
  startDate: string | null;
  status: (typeof NEXT_TRIP_STATUSES)[number];
  /** "owner" for the trip's owner; the member's `trip_members.role` otherwise. */
  viewerRole: string;
}

export type TripViewerNextTripResult =
  | { ok: true; generatedAt: string; freshness: "live"; trip: TripViewerNextTripProjection | null }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE"; detail: string };

/** How many candidate trips each of the two reads considers. A traveller's live trips are few. */
const NEXT_TRIP_READ_CAP = 50;

/**
 * The viewer's next trip by Trips' definition, or `trip: null` when they have
 * none. A failed read of either source is a REFUSAL, never "no trip".
 */
export async function readViewerNextTrip(sc: any, viewerId: string): Promise<TripViewerNextTripResult> {
  const generatedAt = new Date().toISOString();
  try {
    const owned = await sc
      .from("trips")
      .select("id, destination_city, start_date, status")
      .eq("owner_id", viewerId)
      .in("status", [...NEXT_TRIP_STATUSES])
      .limit(NEXT_TRIP_READ_CAP);
    if (owned.error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: String(owned.error.message ?? owned.error) };

    const memberships = await sc
      .from("trip_members")
      .select("trip_id, role")
      .eq("user_id", viewerId)
      .eq("status", "accepted")
      .limit(NEXT_TRIP_READ_CAP);
    if (memberships.error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: String(memberships.error.message ?? memberships.error) };

    const roleOf = new Map<string, string>();
    for (const m of (memberships.data ?? []) as any[]) {
      if (typeof m.trip_id === "string") roleOf.set(m.trip_id, typeof m.role === "string" ? m.role : "member");
    }
    const ownedRows = (owned.data ?? []) as any[];
    const ownedIds = new Set(ownedRows.map((r) => String(r.id)));
    const joinedIds = [...roleOf.keys()].filter((id) => !ownedIds.has(id));

    let joinedRows: any[] = [];
    if (joinedIds.length > 0) {
      const joined = await sc
        .from("trips")
        .select("id, destination_city, start_date, status")
        .in("id", joinedIds)
        .in("status", [...NEXT_TRIP_STATUSES]);
      if (joined.error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: String(joined.error.message ?? joined.error) };
      joinedRows = (joined.data ?? []) as any[];
    }

    const candidates = [
      ...ownedRows.map((r) => ({ r, role: "owner" })),
      ...joinedRows.map((r) => ({ r, role: roleOf.get(String(r.id)) ?? "member" })),
    ].filter(({ r }) => (NEXT_TRIP_STATUSES as readonly string[]).includes(String(r.status)));

    candidates.sort((a, b) => {
      const sa = typeof a.r.start_date === "string" ? a.r.start_date : null;
      const sb = typeof b.r.start_date === "string" ? b.r.start_date : null;
      if (sa !== sb) {
        if (sa === null) return 1;          // no start date sorts LAST, as ORDER BY … ASC does
        if (sb === null) return -1;
        return sa < sb ? -1 : 1;
      }
      return String(a.r.id) < String(b.r.id) ? -1 : String(a.r.id) > String(b.r.id) ? 1 : 0;
    });

    const first = candidates[0];
    return {
      ok: true, generatedAt, freshness: "live",
      trip: first
        ? {
            projectionSchemaVersion: TRIP_VIEWER_NEXT_TRIP_PROJECTION_SCHEMA_VERSION,
            tripId: String(first.r.id),
            destinationCity: typeof first.r.destination_city === "string" ? first.r.destination_city : null,
            startDate: typeof first.r.start_date === "string" ? first.r.start_date : null,
            status: first.r.status as TripViewerNextTripProjection["status"],
            viewerRole: first.role,
          }
        : null,
    };
  } catch (e) {
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: (e as Error)?.message ?? String(e) };
  }
}
