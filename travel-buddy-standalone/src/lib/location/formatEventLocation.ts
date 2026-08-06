/**
 * formatEventLocation — build the one-line location label for an event.
 *
 * QA round 2, bug 7: six call sites all did `${locationName}${city ? ', ' + city : ''}`,
 * which produces "Cebu City, Philippines, Cebu City" because the place picker's
 * `displayName` ALREADY contains the city:
 *
 *   GlobalPlacePicker → { displayName: 'Cebu City, Philippines', city: 'Cebu City' }
 *
 * So the city gets appended a second time. This helper appends the city only when
 * the venue label does not already contain it as a comma-separated token.
 *
 * Comparison is on comma-separated tokens (case- and whitespace-insensitive) rather
 * than a substring test, so a real venue whose NAME happens to embed the city
 * ("Cebu Coffee House" in Cebu City) still gets its city appended — a substring
 * check would wrongly swallow it.
 */
export function formatEventLocation(
  locationName?: string | null,
  city?: string | null,
): string {
  const venue = (locationName ?? '').trim();
  const cityName = (city ?? '').trim();
  if (!venue) return cityName;
  if (!cityName) return venue;
  const tokens = venue.split(',').map((tok) => tok.trim().toLowerCase());
  if (tokens.includes(cityName.toLowerCase())) return venue;
  return `${venue}, ${cityName}`;
}
