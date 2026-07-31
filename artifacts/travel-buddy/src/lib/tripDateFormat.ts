/**
 * formatTripDateRange — human-readable trip date range for cards/lists.
 *
 * Uses ISO-safe local-midnight parsing (fromISODate) so dates never shift
 * by one day in timezones behind UTC (e.g. UTC-5 reading "2024-12-22" as
 * Dec 21 with plain new Date()).
 *
 * Examples:
 *   Dec 22 – Dec 26      (start + end)
 *   Dec 22               (single date, no end date)
 *   Dates TBD            (no start date, or unparsable input)
 */
import { fromISODate } from './dateTime/formatters.ts';

const SHORT_DATE_OPTS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

export function formatTripDateRange(
  startDate?: string | null,
  endDate?: string | null,
): string {
  if (!startDate) return 'Dates TBD';

  const start = fromISODate(startDate);
  if (!start) return 'Dates TBD';

  const end = endDate ? fromISODate(endDate) : null;

  const startLabel = start.toLocaleDateString(undefined, SHORT_DATE_OPTS);
  if (!end) return startLabel;

  const endLabel = end.toLocaleDateString(undefined, SHORT_DATE_OPTS);
  return `${startLabel} – ${endLabel}`;
}
