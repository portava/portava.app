/**
 * tripStatus — single source of truth for trip status badge color/label.
 *
 * Server-computed statuses (see computeTripStatus in api-server/src/routes/trips.ts):
 *   draft | planning | upcoming | active | completed | cancelled | archived
 *
 * Previously TripCard.tsx and TripsTab.tsx each kept their own partial
 * STATUS_COLOR/STATUS_LABEL maps that omitted different statuses (e.g. one
 * had no entry for "upcoming", the other no entry for "draft"/"archived"),
 * so the same trip could show a styled badge on one screen and raw
 * unstyled text on another. Both now import from here.
 */
import { color } from '../theme/tokens.ts';

export const TRIP_STATUS_COLOR: Record<string, string> = {
  draft: color.faint,
  planning: color.mute,
  upcoming: color.deep,
  active: color.success,
  completed: color.signal,
  cancelled: '#DC2626',
  archived: color.faint,
};

export const TRIP_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  planning: 'Planning',
  upcoming: 'Upcoming',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

export function tripStatusColor(status: string): string {
  return TRIP_STATUS_COLOR[status] ?? color.mute;
}

export function tripStatusLabel(status: string): string {
  return TRIP_STATUS_LABEL[status] ?? status.replace('_', ' ');
}

/**
 * Derive the status actually shown to the user from the trip's end date,
 * rather than trusting a possibly-stale stored `status` column.
 *
 * The stored status is computed server-side on writes (see computeTripStatus
 * in api-server/src/routes/trips.ts) but is never re-derived on read, so a
 * trip whose end date has since passed can keep showing "active" until the
 * next write touches it. `cancelled`/`archived`/`draft` are terminal states
 * unrelated to dates and are passed through unchanged.
 */
export function deriveTripDisplayStatus(status: string, endDate?: string | null): string {
  if (status === 'cancelled' || status === 'archived' || status === 'draft') return status;
  if (!endDate) return status;
  const end = new Date(endDate + 'T23:59:59Z');
  if (Number.isNaN(end.getTime())) return status;
  if (end.getTime() < Date.now()) return 'completed';
  return status;
}
