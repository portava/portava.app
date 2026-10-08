/**
 * candidateWorld — one controlled Miami corpus for census-discovery §85's
 * suites (lane W10-R3). CONTROLLED DATA: every row is invented; nothing here
 * is, or stands for, production evidence.
 *
 * Every row exists to make ONE retrieval or ONE eligibility rule observable;
 * the comment on each says which.
 */
import type { PdePlace, PdeViewer } from "../../lib/discoveryPde.js";
import type { Row } from "./fakeCandidateDb.js";

export const NOW = Date.parse("2026-09-28T09:30:00Z");
const DAY = 86_400_000;
export const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
export const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const VIEWER = "11111111-1111-4111-8111-111111111111";
export const AUTHOR_FOLLOWED = "22222222-2222-4222-8222-222222222201";
export const AUTHOR_BLOCKED = "22222222-2222-4222-8222-222222222202";
export const AUTHOR_INACTIVE = "22222222-2222-4222-8222-222222222203";
export const AUTHOR_NEW = "22222222-2222-4222-8222-222222222204";
export const PERSON_1 = "33333333-3333-4333-8333-333333333301";
export const PERSON_2 = "33333333-3333-4333-8333-333333333302";
export const TRAIL_FOLLOWED = "44444444-4444-4444-8444-444444444401";
export const TRAIL_RELATED = "44444444-4444-4444-8444-444444444402";
export const TRAIL_ARCHIVED = "44444444-4444-4444-8444-444444444403";

/** Place ids, by what each one proves. */
export const P = {
  POOL_DB:        u(1),   // in the caller's pool, authored by the followed author → CLAIMED, not added
  FOLLOWED:       u(2),   // followed author, Miami, active → followed_creators
  BLOCKED:        u(3),   // followed author the viewer blocked → refused (blocked)
  INACTIVE:       u(4),   // followed author not in good standing → refused (standing)
  OTHER_CITY:     u(5),   // followed author, Lisbon → never read (city)
  DEMO:           u(6),   // followed author, demo source → refused (demo)
  NEW_PLACE:      u(7),   // created 3 days ago, no author → exploration_pool
  SAVED:          u(8),   // the viewer saved it (food) → a saved-similar SEED, never a candidate of its own source
  SIMILAR:        u(9),   // food, not saved → saved_similar
  TRAIL_MEMBER:   u(10),  // member of the followed Trail → current_trail
  RELATED_MEMBER: u(11),  // member of the related Trail → related_trails
  ARCHIVED_MEMBER: u(12), // member of an archived Trail → never
  TRIP_IDEA:      u(13),  // saved to the viewer's trip → trip_destination
  TRENDING:       u(14),  // latest momentum run: trending → trending_local
  EMERGING:       u(15),  // latest momentum run: emerging → emerging_discoveries
  STALE_RUN:      u(16),  // trending in an OLDER run only → never
  GRAPH_SEED:     u(17),  // the viewer viewed it → the graph's seed
  GRAPH_TWO:      u(18),  // canonical `places` row two travellers experienced → graph_related (materialised from `places`)
  GRAPH_ONE:      u(19),  // one traveller only → never (D-W10-R3-5)
  NIGHTLIFE:      u(20),  // followed author, nightlife → refused on a food tab
  NEW_CREATOR_ROW: u(21), // first submission of a brand-new author → DV-53 new_creator
} as const;

function dp(id: string, over: Row = {}): Row {
  return {
    id, city: "Miami", name: `place ${id.slice(-4)}`, place_type: "restaurant", category: "food", primary_category: "food",
    secondary_categories: null, neighborhood: null, blurb: `blurb ${id.slice(-4)}`, image_url: null, header_image_source: null,
    image_source_type: null, image_accuracy_status: null, rating: 4.1, saved_count: 3, lat: 25.77, lng: -80.19,
    tag: null, verified: false, created_at: iso(200 * DAY), source: "traveler", status: "active", submitted_by: null,
    ...over,
  };
}

/** The caller's pool — what the route's two reads would have handed PDE. */
export function pool(): Array<PdePlace & { name: string }> {
  return [
    { id: `db/${P.POOL_DB}`, name: "pool db", category: "food", savedCount: 9, tags: ["food"], lat: 25.7, lng: -80.2, distanceKm: 1 },
    { id: "node/5", name: "pool osm five", category: "food", savedCount: 2, tags: ["cafe"], lat: 25.71, lng: -80.21, distanceKm: 2 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `node/${100 + i}`, name: `pool osm ${i}`, category: "food", savedCount: i, tags: ["local"], lat: 25.72 + i / 100, lng: -80.22, distanceKm: 1 + i })),
  ];
}

export function viewer(over: Partial<PdeViewer> = {}): PdeViewer {
  return {
    userId: VIEWER, city: "miami",
    followedIds: new Set([AUTHOR_FOLLOWED, AUTHOR_BLOCKED, AUTHOR_INACTIVE]),
    interestTags: new Set(), categoryAffinities: { food: 1 }, seenIds: new Set(),
    placeAffinities: { [`db/${P.GRAPH_SEED}`]: 3 }, degraded: [], neighborhood: null,
    ...over,
  };
}

export function world(): Record<string, Row[]> {
  const run = iso(60_000), older = iso(2 * DAY);
  return {
    feature_flags: [],
    discovery_places: [
      dp(P.POOL_DB, { submitted_by: AUTHOR_FOLLOWED, name: "pool db", lat: 25.7, lng: -80.2 }),
      dp(P.FOLLOWED, { submitted_by: AUTHOR_FOLLOWED, created_at: iso(DAY) }),
      dp(P.BLOCKED, { submitted_by: AUTHOR_BLOCKED, created_at: iso(DAY) }),
      dp(P.INACTIVE, { submitted_by: AUTHOR_INACTIVE, created_at: iso(DAY) }),
      dp(P.OTHER_CITY, { submitted_by: AUTHOR_FOLLOWED, city: "Lisbon", created_at: iso(DAY) }),
      dp(P.DEMO, { submitted_by: AUTHOR_FOLLOWED, source: "demo", created_at: iso(DAY) }),
      dp(P.NEW_PLACE, { created_at: iso(3 * DAY), saved_count: 0 }),
      dp(P.SAVED, {}),
      dp(P.SIMILAR, { saved_count: 40 }),
      dp(P.TRAIL_MEMBER, {}),
      dp(P.RELATED_MEMBER, {}),
      dp(P.ARCHIVED_MEMBER, {}),
      dp(P.TRIP_IDEA, {}),
      dp(P.TRENDING, {}),
      dp(P.EMERGING, {}),
      dp(P.STALE_RUN, {}),
      dp(P.GRAPH_SEED, {}),
      dp(P.GRAPH_ONE, {}),
      dp(P.NIGHTLIFE, { submitted_by: AUTHOR_FOLLOWED, category: "bar", primary_category: "nightlife", created_at: iso(2 * DAY) }),
      dp(P.NEW_CREATOR_ROW, { submitted_by: AUTHOR_NEW, created_at: iso(5 * DAY) }),
      // AUTHOR_FOLLOWED's older submission: an ESTABLISHED author, so not a new creator.
      dp(u(90), { submitted_by: AUTHOR_FOLLOWED, city: "Lisbon", created_at: iso(400 * DAY) }),
    ],
    places: [
      { id: P.GRAPH_TWO, name: "graph two", city: "Miami", primary_category: "food", latitude: 25.8, longitude: -80.1, neighborhood: "Wynwood", address: null, image_source_type: null, image_accuracy_status: null, status: "active", merged_into_place_id: null },
    ],
    blocks: [{ blocker_id: VIEWER, blocked_id: AUTHOR_BLOCKED }],
    profiles: [
      { id: AUTHOR_FOLLOWED, account_status: "active" }, { id: AUTHOR_BLOCKED, account_status: "active" },
      { id: AUTHOR_INACTIVE, account_status: "suspended" }, { id: AUTHOR_NEW, account_status: "active" },
      { id: VIEWER, account_status: "active", interests: ["Rooftop", "live_music"], travel_style: "Foodie", travel_styles: ["slow"] },
    ],
    trail_follows: [{ user_id: VIEWER, trail_id: TRAIL_FOLLOWED }, { user_id: VIEWER, trail_id: TRAIL_ARCHIVED }],
    trails: [
      { id: TRAIL_FOLLOWED, review_state: "approved", lifecycle_status: "active", created_at: iso(5 * DAY) },
      { id: TRAIL_RELATED, review_state: "approved", lifecycle_status: "active", created_at: iso(300 * DAY) },
      { id: TRAIL_ARCHIVED, review_state: "approved", lifecycle_status: "archived", created_at: iso(5 * DAY) },
    ],
    trail_edges: [{ from_trail_id: TRAIL_FOLLOWED, to_trail_id: TRAIL_RELATED, edge_type: "related", strength: 0.5 }],
    content_trails: [
      { trail_id: TRAIL_FOLLOWED, source_type: "place", source_id: P.TRAIL_MEMBER, created_at: iso(DAY), relationship: "primary" },
      { trail_id: TRAIL_RELATED, source_type: "place", source_id: P.RELATED_MEMBER, created_at: iso(DAY), relationship: "primary" },
      { trail_id: TRAIL_ARCHIVED, source_type: "place", source_id: P.ARCHIVED_MEMBER, created_at: iso(DAY), relationship: "primary" },
    ],
    trip_saved_places: [
      { user_id: VIEWER, place_id: `db/${P.TRIP_IDEA}`, place_type: "Rooftop Bar", saved_at: iso(DAY) },
      { user_id: VIEWER, place_id: "node/5", place_type: "cafe", saved_at: iso(2 * DAY) },
    ],
    saved_places: [{ user_id: VIEWER, place_id: P.SAVED, saved_at: iso(DAY) }],
    place_momentum: [
      { place_id: `db/${P.TRENDING}`, trend_state: "trending", recent_rate: 9, computed_at: run },
      { place_id: `db/${P.EMERGING}`, trend_state: "emerging", recent_rate: 4, computed_at: run },
      { place_id: "node/101", trend_state: "trending", recent_rate: 3, computed_at: run },
      { place_id: `db/${P.STALE_RUN}`, trend_state: "trending", recent_rate: 50, computed_at: older },
    ],
    compass_graph_edges: [
      { id: "g1", edge_type: "at_place", src_key: "x1", dst_key: P.GRAPH_SEED, last_seen: iso(DAY) },
      { id: "g2", edge_type: "at_place", src_key: "x2", dst_key: P.GRAPH_SEED, last_seen: iso(DAY) },
      { id: "g3", edge_type: "experienced", src_key: PERSON_1, dst_key: "x1", last_seen: iso(DAY) },
      { id: "g4", edge_type: "experienced", src_key: PERSON_2, dst_key: "x2", last_seen: iso(DAY) },
      { id: "g5", edge_type: "experienced", src_key: PERSON_1, dst_key: "x3", last_seen: iso(DAY) },
      { id: "g6", edge_type: "experienced", src_key: PERSON_2, dst_key: "x4", last_seen: iso(DAY) },
      { id: "g7", edge_type: "at_place", src_key: "x3", dst_key: P.GRAPH_TWO, last_seen: iso(DAY) },
      { id: "g8", edge_type: "at_place", src_key: "x4", dst_key: P.GRAPH_TWO, last_seen: iso(DAY) },
      { id: "g9", edge_type: "experienced", src_key: PERSON_1, dst_key: "x5", last_seen: iso(DAY) },
      { id: "g10", edge_type: "at_place", src_key: "x5", dst_key: P.GRAPH_ONE, last_seen: iso(DAY) },
    ],
    circle_memberships: [{ user_id: VIEWER, other_id: PERSON_1 }, { user_id: VIEWER, other_id: PERSON_2 }],
    rank_events: [], ranking_config: [], user_activity_scores: [], content_distribution_stats: [],
  };
}
