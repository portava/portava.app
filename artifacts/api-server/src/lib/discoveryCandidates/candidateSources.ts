/**
 * `06` §2's eleven candidate sources, and DV-49's graph retrieval, as one
 * registry — census-discovery §85 (lane W10-R3), DC-12 and DV-49.
 *
 * Before §85 the tree said of itself that Discovery's serve path had "exactly
 * two retrievals plus the case where neither claimed the row"
 * (lib/discoveryRankProvenance.ts, `DiscoveryCandidateSource`). Those two stay
 * where they are — the route's OSM directory read and its curated/canonical
 * read — and reach PDE as the caller's pool. §85 adds the per-viewer
 * retrievals below, in lib/discoveryCandidates/retrievals.ts, behind
 * `discovery_candidate_sources_enabled` (3480, seeded FALSE).
 *
 * `status` is what the tree does, not what the spec wants:
 *   caller_retrieval   run by routes/discovery.ts before PDE; the rows arrive
 *                      as the pool and are attributed `caller_pool` by PDE,
 *                      because the pool does not say which of the two reads
 *                      returned a row (the Compass path's candidateSourceMap
 *                      does, and is unchanged)
 *   built              a §85 retrieval over a real table, behind 3480
 *   built_awaits_owner a §85 retrieval that the lane may not switch on because
 *                      it is a consent question (D-W10-R3-4), behind its own
 *                      flag, seeded FALSE
 *
 * No source is recorded as "no data source": every one of the eleven has a
 * table the tree already writes or reads. Two of them read a table nothing in
 * production populates today (`place_momentum`: nothing calls the rebuild,
 * DC-07), which is a fact about the data, recorded here, not a missing source.
 */

export type GeneratedCandidateSource =
  | "followed_creators"
  | "current_trail"
  | "related_trails"
  | "trip_destination"
  | "saved_similar"
  | "trending_local"
  | "emerging_discoveries"
  | "social_circle"
  | "exploration_pool"
  | "graph_related";

/** A candidate's attribution on the PDE path: the caller's pool, or a §85 retrieval. */
export type PdeCandidateSource = "caller_pool" | GeneratedCandidateSource;

export interface CandidateSourceDeclaration {
  /** `06` §2's own words, or the `05` graph for DV-49. */
  spec: string;
  status: "caller_retrieval" | "built" | "built_awaits_owner";
  /** The read, by table. */
  dataSource: string;
  /** The id this source carries on a PDE row: `caller_pool` for the route's reads. */
  attribution: PdeCandidateSource;
  /** Register entry, when the source carried a decision. */
  decision?: string;
  /** What the source can return today, stated where it is limited. */
  limit?: string;
}

export const DISCOVERY_CANDIDATE_SOURCES: Readonly<Record<string, CandidateSourceDeclaration>> = {
  followed_creators: {
    spec: "followed creators", status: "built", attribution: "followed_creators",
    dataSource: "user_follows (the viewer's follow set, already loaded) → discovery_places.submitted_by",
  },
  nearby_places: {
    spec: "nearby places", status: "caller_retrieval", attribution: "caller_pool",
    dataSource: "routes/discovery.ts queryOverpassDeduped (osm_directory)",
  },
  current_trail: {
    spec: "current Trail", status: "built", attribution: "current_trail",
    dataSource: "trail_follows → trails (not archived) → content_trails place members",
    decision: "D-W10-R3-2",
    limit: "2910 is applied in production with 0 Trails",
  },
  related_trails: {
    spec: "related Trails", status: "built", attribution: "related_trails",
    dataSource: "trail_follows → trail_edges (both directions) → trails (not archived) → content_trails place members",
    decision: "D-W10-R3-2",
  },
  trip_destination: {
    spec: "trip destination", status: "built", attribution: "trip_destination",
    dataSource: "trip_saved_places (the viewer's own saved ideas), city-matched at materialisation",
    decision: "D-W10-R3-3",
  },
  saved_similar: {
    spec: "saved-similar", status: "built", attribution: "saved_similar",
    dataSource: "saved_places → the saved rows' categories → discovery_places in the city",
  },
  trending_local: {
    spec: "trending local", status: "built", attribution: "trending_local",
    dataSource: "place_momentum, latest run, trend_state = 'trending'",
    limit: "nothing calls rebuild_place_momentum in production (DC-07), so the table is empty there",
  },
  emerging_discoveries: {
    spec: "emerging discoveries", status: "built", attribution: "emerging_discoveries",
    dataSource: "place_momentum, latest run, trend_state IN ('emerging','rediscovered')",
    limit: "as trending_local",
  },
  social_circle: {
    spec: "social/circle context", status: "built_awaits_owner", attribution: "social_circle",
    dataSource: "circle_memberships → compass_graph_edges (public experiences only) → at_place",
    decision: "D-W10-R3-4 (APPROVAL REQUIRED: consent)",
  },
  editorial_curated: {
    spec: "editorial/curated", status: "caller_retrieval", attribution: "caller_pool",
    dataSource: "routes/discovery.ts loadCuratedAndCanonicalPlaces (curated_db)",
  },
  exploration_pool: {
    spec: "exploration pool", status: "built", attribution: "exploration_pool",
    dataSource: "discovery_places in the city first submitted within EXPLORATION_POOL_WINDOW_MS",
  },
  graph_related: {
    spec: "05 place graph (DV-49): places the same travellers experienced", status: "built", attribution: "graph_related",
    dataSource: "compass_graph_edges at_place / experienced (public Memories only, per the graph builder)",
    decision: "D-W10-R3-5",
  },
};

/** The eleven `06` §2 sources, in the spec's order. */
export const SPEC_06_CANDIDATE_SOURCES = [
  "followed_creators", "nearby_places", "current_trail", "related_trails", "trip_destination",
  "saved_similar", "trending_local", "emerging_discoveries", "social_circle", "editorial_curated",
  "exploration_pool",
] as const;
