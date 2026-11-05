/**
 * What a Compass reply's "View place" / "View event" button opens.
 *
 * The buttons used to open the Discovery or Events tab whatever the reply was
 * about. A quick action's `params` are written by the model and passed through
 * unchecked (routes/compass.ts parseAskResponse), so they are never opened.
 * The reply's uiBlocks are different: the server drops any id its tools did not
 * return. When those blocks show exactly one place (or one event), that is what
 * the button means, so it opens it; otherwise the tab, as before.
 */
import type { CompassUiBlock, CompassUiEvent, CompassUiPlace } from '../services/compass.ts';

function sole<T extends { id: string }>(items: T[]): T | null {
  const byId = new Map<string, T>();
  for (const it of items) if (it && typeof it.id === 'string' && it.id) byId.set(it.id, it);
  return byId.size === 1 ? [...byId.values()][0]! : null;
}

/** The one place the reply's place cards, map or comparison show, or null. */
export function solePlaceCard(blocks: CompassUiBlock[] | null | undefined): CompassUiPlace | null {
  const places: CompassUiPlace[] = [];
  for (const b of blocks ?? []) {
    if (b.type === 'place_cards' || b.type === 'map') places.push(...(b.places ?? []));
    else if (b.type === 'comparison') for (const r of b.rows ?? []) if (r.kind === 'place' && r.place) places.push(r.place);
  }
  return sole(places);
}

/** The one event the reply's event cards or comparison show, or null. */
export function soleEventCard(blocks: CompassUiBlock[] | null | undefined): CompassUiEvent | null {
  const events: CompassUiEvent[] = [];
  for (const b of blocks ?? []) {
    if (b.type === 'event_cards') events.push(...(b.events ?? []));
    else if (b.type === 'comparison') for (const r of b.rows ?? []) if (r.kind === 'event' && r.event) events.push(r.event);
  }
  return sole(events);
}
