/**
 * Pure presentation rules for Discovery Trails. No I/O.
 */
import type { TrailModuleItem, TrailReportReason } from './trailsApi.ts';

export const MODULE_LABEL: Record<string, string> = {
  just_arrived: 'Just arrived',
  trending_now: 'Trending now',
  evergreen: 'Always worth it',
  local_picks: 'Local picks',
  hidden_gems: 'Hidden gems',
  personalized_picks: 'Picked for you',
};

export function moduleLabel(key: string): string {
  return MODULE_LABEL[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Where tapping a Trail member goes. Null when this app has no screen for it — never a guessed route. */
export function hrefForItem(item: Pick<TrailModuleItem, 'sourceType' | 'sourceId'>): string | null {
  const id = encodeURIComponent(item.sourceId);
  switch (item.sourceType) {
    case 'place': return `/place/${id}`;
    case 'post': return `/post/${id}`;
    case 'event': return `/event/${id}`;
    case 'route': return `/route/${id}`;
    default: return null;
  }
}

export const SOURCE_LABEL: Record<string, string> = {
  place: 'Place', post: 'Post', event: 'Event', itinerary: 'Itinerary', route: 'Route',
};

export const REPORT_REASON_LABEL: Record<TrailReportReason, string> = {
  unrelated_content: 'Something here does not belong',
  duplicate_trail: 'This duplicates another Trail',
  wrong_place_link: 'A place is linked wrongly',
  stale: 'It is out of date',
  abuse: 'Abuse or harmful content',
};

export function lifecycleNote(lifecycle: string): string | null {
  switch (lifecycle) {
    case 'proposed': return 'New Trail — not yet active.';
    case 'needs_update': return 'This Trail needs an update.';
    case 'stale': return 'This Trail may be out of date.';
    default: return null;
  }
}

/** `02` §5's checks, by the names the server sends (lib/discoveryTrailObject.ts). */
export const CANONICAL_CHECK_COPY: Record<string, string> = {
  duplicate_title_similarity: 'A Trail with a very similar title already exists.',
  semantic_overlap: 'This overlaps an existing Trail.',
  destination_overlap: 'An existing Trail already covers this destination this way.',
  existing_parent_child: 'This belongs inside an existing Trail.',
  uncanonicalisable_title: 'This title cannot be made into a Trail name.',
};
export function canonicalCheckCopy(check: string): string {
  return CANONICAL_CHECK_COPY[check] ?? `Refused by the Trail rules (${check}).`;
}
