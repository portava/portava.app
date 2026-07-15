/**
 * Pulse recommendation filter — SIMPLE & DETERMINISTIC (this pass).
 *
 * Rules (in order), per the product spec:
 *   1. Current-city events first.
 *   2. Inside-availability events first; outside -> "flexible" bucket.
 *   3. Match interests when category tags exist (soft sort, not a score).
 *   4. Items with unknown availability stay visible (openNearby), not penalized.
 *
 * NO ranking score is computed or faked. The RecommendationScore contract
 * exists on CityEvent for a future backend; we leave it null here.
 */
import type { Availability, CityEvent, Interest, PulseBuckets, PulseFeedItem, PulseFilter } from '../types/models';
import { isWithinAvailability } from './availability';

export function filterPulse(
  events: CityEvent[],
  opts: {
    availability: Availability | null;
    currentCitySlug?: string;
    interests?: Interest[];
  }
): PulseBuckets {
  const { availability, currentCitySlug, interests = [] } = opts;

  // 1. City scope: current city first. Other cities still allowed but after.
  const inCity = (e: CityEvent) => !currentCitySlug || e.citySlug === currentCitySlug;

  // soft interest affinity: 1 if category matches a user interest, else 0.
  const interestMatch = (e: CityEvent) => (interests.includes(e.category) ? 1 : 0);

  const fitsAvailability: CityEvent[] = [];
  const openNearby: CityEvent[] = [];
  const flexible: CityEvent[] = [];

  for (const e of events) {
    const within = isWithinAvailability(availability, e);
    if (within === true) fitsAvailability.push(e);
    else if (within === false) flexible.push(e);
    else openNearby.push(e); // unknown availability -> keep visible
  }

  // deterministic sort: in-city first, then interest match, then soonest start.
  const sorter = (a: CityEvent, b: CityEvent) => {
    const city = Number(inCity(b)) - Number(inCity(a));
    if (city !== 0) return city;
    const interest = interestMatch(b) - interestMatch(a);
    if (interest !== 0) return interest;
    return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
  };

  fitsAvailability.sort(sorter);
  openNearby.sort(sorter);
  flexible.sort(sorter);

  return { fitsAvailability, openNearby, flexible };
}

/** Honest reason string — only states what the simple filter actually proved. */
export function plainReason(e: CityEvent, interests: Interest[] = [], currentCitySlug?: string): string {
  const bits: string[] = [];
  if (currentCitySlug && e.citySlug === currentCitySlug) bits.push('in your city');
  if (interests.includes(e.category)) bits.push(`matches ${e.category}`);
  return bits.length ? `Shown because it’s ${bits.join(' and ')}.` : 'Open plan near you.';
}

/* ───────────────────────────────────────────────────────────────────────
 * Pulse Wall feed filtering + ordering. Deterministic, no fake scores.
 * Availability-first, then recency. Filters narrow the mixed feed by type/tag.
 * ─────────────────────────────────────────────────────────────────────── */

const TYPE_FOR_FILTER: Partial<Record<PulseFilter, PulseFeedItem['type']>> = {
  Posts: 'post', Questions: 'question', Plans: 'plan',
  'Hidden Gems': 'hidden_gem', Itineraries: 'itinerary', Circle: 'circle_activity',
};

const CATEGORY_FILTERS: PulseFilter[] = ['Food', 'Nightlife', 'Beach', 'Culture'];

/** Filter the mixed feed by active filters (AND across filter groups). */
export function filterPulseFeed(items: PulseFeedItem[], active: PulseFilter[]): PulseFeedItem[] {
  if (!active.length || active.includes('All')) return orderPulseFeed(items);
  let out = items;

  // type filters (OR within type group)
  const typeFilters = active.filter((f) => TYPE_FOR_FILTER[f]);
  if (typeFilters.length) {
    const types = new Set(typeFilters.map((f) => TYPE_FOR_FILTER[f]));
    out = out.filter((it) => types.has(it.type));
  }
  // category tag filters (OR within category group)
  const catFilters = active.filter((f) => CATEGORY_FILTERS.includes(f));
  if (catFilters.length) {
    const tags = catFilters.map((f) => f.toLowerCase());
    out = out.filter((it) => it.tags.some((tg) => tags.includes(tg.toLowerCase())));
  }
  // availability filters
  if (active.includes('Fits My Time') || active.includes('Open Now')) {
    out = out.filter((it) => it.availabilityMatch);
  }
  return orderPulseFeed(out);
}

/** Order: availability-match first, then most recent. No fabricated score. */
export function orderPulseFeed(items: PulseFeedItem[]): PulseFeedItem[] {
  return [...items].sort((a, b) => {
    const am = a.availabilityMatch ? 1 : 0;
    const bm = b.availabilityMatch ? 1 : 0;
    if (am !== bm) return bm - am;                       // availability first
    // editorial/provisional sink lower
    const ap = a.isEditorial || a.isProvisional ? 1 : 0;
    const bp = b.isEditorial || b.isProvisional ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); // recency
  });
}
