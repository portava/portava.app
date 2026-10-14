/**
 * Layover experience facts — the one sentence a card may say about the
 * spec §9 `ExperiencePrimitive` the server attaches to it (census-layover L75).
 *
 * ── WHAT THE DESCRIPTOR IS, AND WHAT THIS MAY NOT MAKE IT ────────────────────
 * The server's `experience` is the TYPICAL profile of the card's kind — what a
 * meal or a walk usually takes, from the Trips experience primitives — and says
 * so (`source: "category_default"`). It is not a measurement of the place on
 * the card. census-layover L293 deleted exactly these category numbers from the
 * safety path because a traveller acts on them by leaving an airport, so this
 * file renders them only as "Typical for …", on their own line, and never:
 *
 *   * as the card's own time there (`activityTimeMin`, the "45m there" stamp,
 *     which stays absent when nobody stated one);
 *   * as a travel time (the "travel time not measured" line is untouched);
 *   * as reassurance. Beside the kind and its typical length, only CAUTIONARY
 *     traits are said — high energy, hard to leave partway, usually needs
 *     booking, weather-dependent. "Low energy", "easy to leave early" or "free"
 *     would be a default speaking as if it knew this place.
 *   * as a weather claim the type cannot make. "weather-dependent" is said only
 *     for `fair_weather`; the server sends `unknown` for REST and EXPLORE (a
 *     spa, a museum, a mall, a park), and `unknown` says nothing.
 *
 * Not rendered, on purpose: `costRange` (a band for the TYPE — "free" next to an
 * airport lounge is a default claiming a price it does not know),
 * `compressibility` and `reversibility` (planner inputs with no traveller
 * sentence; no layover card is TRANSIT, the only irreversible type). They are
 * on the wire for the server's own consumers.
 *
 * A descriptor this build cannot read — an older server sends none, a newer one
 * may send a type this build does not know, `typeBasis: "unmapped"` means the
 * server did not know the card's kind — renders NOTHING. A typical profile for
 * an unknown kind is not a fact about anything.
 *
 * Pure, so `pnpm test` (node:test) exercises it without react-native.
 */
import { fmtDur } from './layoverDuration.ts'; // pure: the api-server's suite loads this file, and layoverFormat.ts carries react-native types

/** The server's `experience`, as much of it as this reads. Every member is checked, not trusted. */
export interface ExperienceWire {
  type?: unknown;
  minDuration?: unknown;
  idealDuration?: unknown;
  interruptibility?: unknown;
  energyCost?: unknown;
  weatherCompatibility?: unknown;
  reservationRequirement?: unknown;
  source?: unknown;
  typeBasis?: unknown;
}

/** The thirteen §9 types, and how a card names one. */
export const EXPERIENCE_KIND: Readonly<Record<string, string>> = {
  EAT: 'a meal',
  SEE: 'sightseeing',
  MEET: 'a meetup',
  DRINK: 'a drink',
  SHOP: 'shopping',
  WALK: 'a walk',
  REST: 'resting',
  PHOTO: 'a photo stop',
  EXPLORE: 'exploring',
  PLAY: 'entertainment',
  LEARN: 'a class or tour',
  NIGHTLIFE: 'a night out',
  TRANSIT: 'a transit leg',
};

export const TRAIT_HARD_TO_LEAVE = 'hard to leave partway';
export const TRAIT_BOOKING = 'usually needs booking';
export const TRAIT_WEATHER = 'weather-dependent';
export const TRAIT_HIGH_ENERGY = 'high energy';

function minutes(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * "Typical for a meal: 45m–1h 30m · hard to leave partway", or
 * `null` when there is nothing this build may honestly say.
 */
export function typicalExperienceLine(e: ExperienceWire | null | undefined): string | null {
  if (!e || typeof e !== 'object') return null;
  if (e.source !== 'category_default') return null;
  if (e.typeBasis === 'unmapped') return null;
  const kind = typeof e.type === 'string' ? EXPERIENCE_KIND[e.type] : undefined;
  if (!kind) return null;
  const min = minutes(e.minDuration);
  const ideal = minutes(e.idealDuration);
  if (min === null || ideal === null || min > ideal) return null;

  const parts = [min === ideal ? fmtDur(min) : `${fmtDur(min)}–${fmtDur(ideal)}`];
  if (e.energyCost === 'high') parts.push(TRAIT_HIGH_ENERGY);
  if (e.interruptibility === 'low') parts.push(TRAIT_HARD_TO_LEAVE);
  if (e.reservationRequirement === 'required') parts.push(TRAIT_BOOKING);
  if (e.weatherCompatibility === 'fair_weather') parts.push(TRAIT_WEATHER);
  return `Typical for ${kind}: ${parts.join(' · ')}`;
}

/** What a screen reader hears: the same line, with the caveat the eye gets from "Typical". */
export function typicalExperienceA11y(line: string): string {
  return `${line}. Typical for this kind of place, not measured for this one.`;
}
