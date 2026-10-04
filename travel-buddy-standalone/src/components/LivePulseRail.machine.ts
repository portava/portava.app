/**
 * LivePulseRail.machine.ts — pure logic for the Live Pulse rail.
 *
 * No React Native imports. Testable with node:test.
 */
import type { LivePulseItem, LivePulseStatusLabel } from '../services/livePulse.ts';

// ── Filter chip definitions ────────────────────────────────────────────────────

export type RailFilter =
  | 'All'
  | 'Now'
  | 'Starting Soon'
  | 'Tonight'
  | 'My Trip'
  | 'Near Me'
  | 'Requests'
  | 'Buddies';

export const RAIL_FILTERS: RailFilter[] = [
  'All', 'Now', 'Starting Soon', 'Tonight', 'My Trip', 'Near Me', 'Requests', 'Buddies',
];

const NOW_LABELS: LivePulseStatusLabel[] = ['Ongoing', 'Ends Soon'];

export function filterItems(items: LivePulseItem[], chip: RailFilter): LivePulseItem[] {
  if (chip === 'All') return items;
  // 'Now' includes safe_return (always action-needed) + truly ongoing
  if (chip === 'Now') return items.filter(
    (i) => (NOW_LABELS as string[]).includes(i.status_label) || i.item_type === 'safe_return',
  );
  if (chip === 'Starting Soon') return items.filter((i) => i.status_label === 'Starting Soon');
  if (chip === 'Tonight') return items.filter((i) => i.status_label === 'Tonight');
  // 'My Trip' includes trip items AND active circle items (circles live inside trips)
  if (chip === 'My Trip') return items.filter((i) => i.item_type === 'trip' || i.item_type === 'trip_request' || i.item_type === 'circle');
  if (chip === 'Near Me') return items.filter(
    (i) => i.item_type === 'event' || i.item_type === 'hidden_gem' || i.item_type === 'compass',
  );
  if (chip === 'Requests') return items.filter(
    (i) => i.item_type === 'buddy_request' || i.status_label === 'Action Needed',
  );
  // Buddies chip: pending requests + discoverable available buddies nearby
  if (chip === 'Buddies') return items.filter(
    (i) => i.item_type === 'buddy_request' || i.item_type === 'available_buddy',
  );
  return items;
}

// ── Rail state machine ────────────────────────────────────────────────────────

export type RailState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready'; items: LivePulseItem[] };

export interface RailStateInput {
  loading: boolean;
  error: string | null;
  items: LivePulseItem[];
}

/**
 * Derives the render state for the Live Pulse rail from fetch state.
 * Priority: loading > error > empty > ready.
 */
export function computeRailState(input: RailStateInput): RailState {
  if (input.loading) return { kind: 'loading' };
  if (input.error)   return { kind: 'error', message: input.error };
  if (input.items.length === 0) return { kind: 'empty' };
  return { kind: 'ready', items: input.items };
}

export function buildSummaryText(items: LivePulseItem[]): string {
  const startingSoon = items.filter((i) => i.status_label === 'Starting Soon').length;
  const ongoing      = items.filter((i) => i.status_label === 'Ongoing' || i.status_label === 'Ends Soon').length;
  const tonight      = items.filter((i) => i.status_label === 'Tonight').length;
  const requests     = items.filter((i) => i.status_label === 'Action Needed').length;

  const parts: string[] = [];
  if (requests > 0)     parts.push(`${requests} action${requests > 1 ? 's' : ''} needed`);
  if (startingSoon > 0) parts.push(`${startingSoon} starting soon`);
  if (ongoing > 0)      parts.push(`${ongoing} ongoing`);
  if (tonight > 0)      parts.push(`${tonight} tonight`);
  return parts.join(' · ') || 'Your live plans';
}

// ── census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B46) ──────────────────────────────
//
// The collapsed header's one line. Collapsed, the rail drew `buildSummaryText(items)` whenever it had cards: "2 tonight"
// over a rail whose server answer named reads it could not make (`unread`) stated a PARTIAL read as the whole of the
// viewer's live plans, and the "Some live plans couldn't be loaded." note is only drawn expanded. With no cards and an
// unread read, the collapsed header said nothing at all, where the expanded rail says "Couldn't load live plans."
// One function decides the line, so the component and its tests cannot disagree:
//   - the latest read failed, or nothing could be drawn and a read was unread → the failure, never a summary;
//   - cards beside an unread read → the summary AND that some could not be loaded;
//   - cards and nothing unread → the summary alone (unchanged);
//   - no cards and nothing unread → no line (the empty state is drawn elsewhere).
export const LIVE_RAIL_COLLAPSED_FAILED = "Couldn't load live plans";
export const LIVE_RAIL_COLLAPSED_PARTIAL_SUFFIX = "some couldn't be loaded";

export function collapsedSummaryText(items: LivePulseItem[], unreadCount: number, failed: boolean): string | null {
  if (failed || (items.length === 0 && unreadCount > 0)) return LIVE_RAIL_COLLAPSED_FAILED;
  if (items.length === 0) return null;
  const summary = buildSummaryText(items);
  return unreadCount > 0 ? `${summary} · ${LIVE_RAIL_COLLAPSED_PARTIAL_SUFFIX}` : summary;
}
