/**
 * EntityType ⇄ SearchType bridge.
 *
 * The gateway's canonical taxonomy (EntityType, §5/§8) maps 1:1 onto the 17
 * cross-entity search types already implemented in routes/discoverySearch.ts.
 * This is the ONLY place that translation lives, so candidate generation can be
 * delegated into the existing `dispatchSearch` without a parallel taxonomy.
 *
 * `neighborhood` has no dedicated search type yet (canonical neighborhoods are
 * resolved through the city path in Phase 1), so it maps to the "cities" bucket;
 * a dedicated NeighborhoodResolver is deferred to Phase 2.
 */
import type { EntityType } from './types';

// The subset of discoverySearch's SearchType we dispatch to (excludes "all").
export type DispatchSearchType =
  | 'travelers'
  | 'buddies'
  | 'events'
  | 'trips'
  | 'plans'
  | 'places'
  | 'hidden_gems'
  | 'hashtags'
  | 'posts'
  | 'circles'
  | 'stamps'
  | 'activities'
  | 'cities'
  | 'countries'
  | 'languages'
  | 'interests'
  | 'vibes';

const ENTITY_TO_SEARCH: Record<EntityType, DispatchSearchType> = {
  city: 'cities',
  country: 'countries',
  neighborhood: 'cities', // Phase 1: neighborhoods resolve through the city path
  place: 'places',
  hidden_gem: 'hidden_gems',
  user: 'travelers',
  buddy: 'buddies',
  trip: 'trips',
  event: 'events',
  plan: 'plans',
  circle: 'circles',
  post: 'posts',
  hashtag: 'hashtags',
  stamp: 'stamps',
  activity: 'activities',
  language: 'languages',
  interest: 'interests',
  vibe: 'vibes',
};

const SEARCH_TO_ENTITY: Record<DispatchSearchType, EntityType> = {
  cities: 'city',
  countries: 'country',
  places: 'place',
  hidden_gems: 'hidden_gem',
  travelers: 'user',
  buddies: 'buddy',
  trips: 'trip',
  events: 'event',
  plans: 'plan',
  circles: 'circle',
  posts: 'post',
  hashtags: 'hashtag',
  stamps: 'stamp',
  activities: 'activity',
  languages: 'language',
  interests: 'interest',
  vibes: 'vibe',
};

export function entityToSearchType(e: EntityType): DispatchSearchType {
  return ENTITY_TO_SEARCH[e];
}

export function searchTypeToEntity(t: DispatchSearchType): EntityType {
  return SEARCH_TO_ENTITY[t];
}

/**
 * Person entity classes — used by the privacy gateway: when block/age state is
 * unknown these are suppressed fail-closed (a null block-set ⇒ show nobody).
 */
export const PERSON_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'user',
  'buddy',
]);
