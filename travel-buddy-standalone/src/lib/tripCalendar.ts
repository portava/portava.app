/** A trip ends after its entire last calendar date in its destination timezone.
 * Old trips without a usable zone follow the server's UTC fallback. */
const formats = new Map<string, Intl.DateTimeFormat>();
function calendarDay(timezone: string | null | undefined, now: number): string {
  const zone = timezone || 'UTC';
  let format = formats.get(zone);
  if (!format) {
    try { format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { return new Date(now).toISOString().slice(0, 10); }
    if (formats.size >= 64) formats.clear();
    formats.set(zone, format);
  }
  const parts = format.formatToParts(now);
  const field = (name: string) => parts.find(part => part.type === name)?.value;
  return [field('year'), field('month'), field('day')].join('-');
}

export interface TripWindow { expiresAt?: string | null; status?: string | null; endDate?: string | null; timezone?: string | null }

export function tripWindowEnded(trip: TripWindow, now = Date.now()): boolean {
  if (trip.expiresAt && Date.parse(trip.expiresAt) <= now) return true;
  if (trip.expiresAt && Number.isFinite(Date.parse(trip.expiresAt))) return Boolean(trip.status && ['completed', 'cancelled', 'archived'].includes(trip.status));
  if (trip.status && ['completed', 'cancelled', 'archived'].includes(trip.status)) return true;
  return Boolean(trip.endDate && /^\d{4}-\d{2}-\d{2}$/.test(trip.endDate) && trip.endDate < calendarDay(trip.timezone, now));
}

/** First instant past the destination's last date, including DST transitions. */
export function tripExpiryTime(trip: TripWindow): number | null {
  if (trip.expiresAt && Number.isFinite(Date.parse(trip.expiresAt))) return Date.parse(trip.expiresAt);
  if (!trip.endDate || !/^\d{4}-\d{2}-\d{2}$/.test(trip.endDate)) return null;
  const midnight = Date.parse(trip.endDate + 'T00:00:00Z');
  if (!Number.isFinite(midnight)) return null;
  if (!trip.timezone || trip.timezone === 'UTC') return midnight + 86_400_000;
  let lo = midnight - 86_400_000;
  let hi = midnight + 2 * 86_400_000;
  while (hi - lo > 1) {
    const mid = Math.floor((hi + lo) / 2);
    if (calendarDay(trip.timezone, mid) > trip.endDate) hi = mid; else lo = mid;
  }
  return hi;
}
