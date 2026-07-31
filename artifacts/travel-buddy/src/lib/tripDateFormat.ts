/**
 * formatTripDateRange — human-readable trip date range for cards/lists.
 *
 * Examples:
 *   Dec 22 – 26, 2024      (same month & year)
 *   Dec 29, 2024 – Jan 3, 2025  (crosses month/year)
 *   Dec 22, 2024           (single date, no end date)
 *   Dates TBD              (no start date, or unparsable input)
 */
export function formatTripDateRange(
  startDate?: string | null,
  endDate?: string | null,
): string {
  if (!startDate) return 'Dates TBD';

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return 'Dates TBD';

  const end = endDate ? new Date(endDate) : null;
  const endValid = end && !Number.isNaN(end.getTime());

  if (!endValid) {
    return start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const sameYear = start.getFullYear() === end!.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end!.getMonth();

  if (sameMonth) {
    const month = start.toLocaleDateString(undefined, { month: 'short' });
    return `${month} ${start.getDate()} – ${end!.getDate()}, ${start.getFullYear()}`;
  }

  const startLabel = start.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  );
  const endLabel = end!.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startLabel} – ${endLabel}`;
}
