/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; the round-16 verifier's B5): what the NOW map says about the
 * layers the gateway did not read, and about an answer that is one page of several.
 *
 * useMapEntities reports every requested layer the gateway did not name in `sources` (`unreadLayers`, safety first)
 * and whether the answer carried a `nextCursor` (`truncated`). A layer that could not be read is never "nothing here":
 * the safety layer is said first, on its own line and plainly — a failed or cut hazard read must never look like "no
 * hazards" — then the other layers, then the cut. Pure, so the wording is testable without the screen.
 */

/** The words each layer key is said by. A key not listed is said by its own name. */
export const UNREAD_LAYER_LABEL: Record<string, string> = {
  events: 'events',
  gems: 'hidden gems',
  buddies: 'buddies',
  trips: 'trips',
  friends: 'friends',
  meeting_point: 'meeting points',
  crowd_flow: 'crowd flow',
  relevant_places: 'places',
  saved: 'saved places',
  memories: 'memories',
  world_pulse: 'world pulse',
  traveler_flow: 'traveler flow',
  city_model: 'city insights',
  personal_city: 'your cities',
};

export const SAFETY_UNREAD_NOTICE = 'Safety notices couldn’t be checked here — hazards may not be shown';
export const MAP_TRUNCATED_NOTICE = 'Showing only part of this area — zoom in to see everything';

export interface UnreadLayersNotice {
  /** The lines to show, in order: safety, the other unread layers, the cut. Empty: nothing to say. */
  lines: string[];
  /** Whether the first line is the safety line (the screen says it as an alert). */
  safety: boolean;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function unreadLayersNotice(unread: readonly string[], truncated: boolean): UnreadLayersNotice {
  const safety = unread.includes('safety');
  const others = unread.filter((l) => l !== 'safety').map((l) => UNREAD_LAYER_LABEL[l] ?? l.replace(/_/g, ' '));
  const lines: string[] = [];
  if (safety) lines.push(SAFETY_UNREAD_NOTICE);
  if (others.length > 0) lines.push(`Couldn’t load ${joinLabels(others)} here`);
  if (truncated) lines.push(MAP_TRUNCATED_NOTICE);
  return { lines, safety };
}
