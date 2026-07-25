/**
 * Compass formatting utilities.
 *
 * Helpers for resolving real entity names, event date/time/status, and
 * compact subtitles from Compass feed/recommendation items. All helpers are
 * defensive: they accept null/undefined values and fall back to empty strings
 * or generic labels only when no real data is present.
 */

/**
 * Minimal shape shared by every Compass payload the UI handles.
 * Concrete types (CompassFeedItem, CompassRecommendation, etc.) may have extra
 * fields, but all are assignable to this permissive interface.
 */
export interface CompassItemLike {
  data?: unknown;
  title?: string | null;
  type?: string;
  category?: string | null;
  city?: string | null;
  reason?: string | null;
}

function itemData(item: CompassItemLike): Record<string, unknown> {
  const raw = item.data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

const DEFAULT_TYPE_LABEL: Record<string, string> = {
  event: 'Event',
  place: 'Place',
  hidden_gem: 'Hidden Gem',
  traveler: 'Traveler',
  buddy: 'Buddy',
  post: 'Post',
  trip: 'Trip',
  suggestion: 'Compass Suggestion',
};

/** Resolve a human-readable title from the item and its embedded data. */
export function resolveCompassTitle(item: CompassItemLike): string {
  const d = itemData(item);
  const raw =
    item.title
    ?? d.title as string | undefined
    ?? d.name as string | undefined
    ?? d.displayName as string | undefined
    ?? (item.type && DEFAULT_TYPE_LABEL[item.type])
    ?? 'Compass Pick';
  return String(raw).trim() || 'Compass Pick';
}

/** Resolve a real category label from the item or its data. */
export function resolveCompassCategory(item: CompassItemLike): string {
  const d = itemData(item);
  const raw =
    d.category as string | undefined
    ?? item.category
    ?? (item.type && DEFAULT_TYPE_LABEL[item.type])
    ?? '';
  return String(raw).trim().replace(/[_-]/g, ' ');
}

function parseIso(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format an event date range compactly: "Mon, Jan 1 · 18:00". */
export function formatCompassEventDateRange(startsAt?: string | null, endsAt?: string | null): string {
  const start = parseIso(startsAt);
  if (!start) return 'Date TBD';
  const end = parseIso(endsAt);
  const datePart = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timePart = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (!end || end.getTime() <= start.getTime()) return `${datePart} · ${timePart}`;
  const endDatePart = end.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const endTimePart = end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (start.toDateString() === end.toDateString()) {
    return `${datePart} · ${timePart} – ${endTimePart}`;
  }
  return `${datePart} · ${timePart} – ${endDatePart} · ${endTimePart}`;
}

/** Compute a status label for an event based on its start/end times. */
export function formatCompassEventStatus(startsAt?: string | null, endsAt?: string | null): string | null {
  const start = parseIso(startsAt);
  if (!start) return null;
  const end = parseIso(endsAt) ?? start;
  const now = Date.now();
  const startMs = start.getTime();
  const endMs = end.getTime();
  const oneHour = 60 * 60 * 1000;
  if (now < startMs - oneHour) return 'Upcoming';
  if (now < startMs) return 'Starting soon';
  if (now < endMs - oneHour) return 'Ongoing';
  if (now < endMs) return 'Ends soon';
  return 'Ended';
}

/** Build a compact subtitle for a Compass item: event shows date/time + status + city; others show category + city. */
export function formatCompassSubtitle(item: CompassItemLike): string {
  const d = itemData(item);
  const type = (item.type ?? '').toLowerCase();
  const city = String(d.city ?? item.city ?? '').trim();
  const category = resolveCompassCategory(item);

  if (type === 'event') {
    const dateRange = formatCompassEventDateRange(d.startsAt as string | undefined, d.endsAt as string | undefined);
    const status = formatCompassEventStatus(d.startsAt as string | undefined, d.endsAt as string | undefined);
    const parts = [dateRange];
    if (status && status !== 'Upcoming') parts.push(status);
    if (city) parts.push(city);
    if (category && category !== 'Event') parts.push(category);
    return parts.join(' · ');
  }

  const parts = [];
  if (category && category !== 'Compass Pick') parts.push(category);
  if (city) parts.push(city);
  return parts.join(' · ');
}

/** Build a compact "why" context line from the reason and item type. */
export function formatCompassContext(item: CompassItemLike): string {
  const reason = (item.reason ?? '').trim();
  return reason || 'Recommended for you';
}

/**
 * Extract an image URL from a CompassFeedItem's data bag.
 * Checks all known image field names across item types (place, event, buddy,
 * hidden_gem) in priority order. Returns null when none are present.
 */
export function resolveCompassImageUrl(item: CompassItemLike): string | null {
  const d = itemData(item);
  const candidates = [
    d.imageUrl,
    d.headerImageUrl,
    d.image_url,
    d.coverPhotoUrl, // buddy items from /compass/recommendations
    d.coverUrl,      // alternate field name
    d.cover_url,     // snake_case variant (events raw DB column)
    d.photoUrl,      // community place photos
    d.photo_url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/** Format the event date + status for a single-line chip label. */
export function formatCompassEventChip(startsAt?: string | null, endsAt?: string | null): string {
  const start = parseIso(startsAt);
  if (!start) return 'Date TBD';
  const status = formatCompassEventStatus(startsAt, endsAt);
  const datePart = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timePart = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return status && status !== 'Upcoming' ? `${status} · ${datePart} · ${timePart}` : `${datePart} · ${timePart}`;
}
