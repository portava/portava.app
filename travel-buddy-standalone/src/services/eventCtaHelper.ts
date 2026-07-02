/**
 * Pure CTA helper — no external imports.
 *
 * Isolated so it can be imported in node:test without triggering the
 * supabase / native-module resolution that events.ts carries at the
 * top level.  The types below mirror their counterparts in events.ts;
 * keep them in sync if EventSummary or the RAB types change.
 */

export type EventState =
  | 'draft' | 'open' | 'full' | 'waitlist' | 'started'
  | 'completed' | 'cancelled' | 'archived';

export type EventVisibility =
  | 'public' | 'friends_only' | 'invite_only' | 'circle' | 'trip';

export type EventRsvpStatus = 'going' | 'maybe' | 'interested' | 'cant_go';

export interface RentBuddySearchParams {
  city: string;
  category: string;
  bookingDate: string | null;
}

export interface RentBuddyCtaEvent {
  state: EventState;
  visibility: EventVisibility;
  city: string | null;
  category: string | null;
  startsAt: string | null;
  myRsvp?: EventRsvpStatus | null;
}

function mapEventCategoryToBuddyCategory(eventCategory: string | null): string {
  if (!eventCategory) return 'city';
  const lower = eventCategory.toLowerCase();
  if (/nightlife|club|bar|party|dance/.test(lower))                    return 'nightlife';
  if (/food|dining|restaurant|brunch|lunch|dinner|eat/.test(lower))    return 'food';
  if (/culture|art|museum|gallery|history|heritage/.test(lower))       return 'culture';
  if (/nature|outdoor|hik|park|beach|lake|trail/.test(lower))          return 'nature';
  if (/adventure|sport|extreme|surf|ski|climb|bike/.test(lower))       return 'adventure';
  if (/shop|market|mall/.test(lower))                                   return 'shopping';
  if (/wellness|yoga|fitness|spa|meditation|pilates/.test(lower))       return 'wellness';
  return 'city';
}

/**
 * Maps event fields to Rent-a-Buddy search params.
 * Returns null when the event has no city (can't do a city-based buddy search).
 */
export function buildRentBuddyParamsFromEvent(
  event: RentBuddyCtaEvent,
): RentBuddySearchParams | null {
  if (!event.city) return null;
  return {
    city:        event.city,
    category:    mapEventCategoryToBuddyCategory(event.category),
    bookingDate: event.startsAt ? event.startsAt.slice(0, 10) : null,
  };
}

/**
 * Builds the full navigation URL for the "Find a Travel Buddy" CTA press.
 * Returns null when the event has no city (button should be a no-op).
 *
 * The returned URL is passed directly to router.push in the component so
 * tests can assert the exact navigation target without rendering.
 */
export function buildRentBuddyCtaUrl(event: RentBuddyCtaEvent): string | null {
  const p = buildRentBuddyParamsFromEvent(event);
  if (!p) return null;
  const qs = new URLSearchParams({ city: p.city, category: p.category });
  if (p.bookingDate) qs.set('bookingDate', p.bookingDate);
  return `/(rent-a-buddy)/search?${qs.toString()}`;
}

/**
 * Returns true when the "Find a Travel Buddy" CTA should be shown.
 *
 * Mirrors the JSX render condition in app/event/[id].tsx so the logic
 * is testable as a pure function without a React render:
 *
 *   rentBuddyEnabled && buddyCityAvailable === true
 *   && event.state not in ['draft','cancelled','archived']
 *   && (public visibility OR viewer is going)
 *
 * Note: in the component, rentBuddyEnabled=false causes the useEffect
 * to set buddyCityAvailable=false, so both checks are redundant at
 * runtime — both are included here to keep the helper self-contained.
 */
export function shouldShowRentBuddyCta(
  event: Pick<RentBuddyCtaEvent, 'state' | 'visibility'> & { myRsvp?: EventRsvpStatus | null },
  rentBuddyEnabled: boolean,
  buddyCityAvailable: boolean | null,
): boolean {
  if (!rentBuddyEnabled) return false;
  if (buddyCityAvailable !== true) return false;
  if (['draft', 'cancelled', 'archived'].includes(event.state)) return false;
  return event.visibility === 'public' || event.myRsvp === 'going';
}
