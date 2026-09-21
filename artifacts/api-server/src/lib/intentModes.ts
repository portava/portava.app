/**
 * intentModes — Sensing §8 `:137`: "Support intent modes using the same
 * shared intelligence: Right Now, Tonight, Explore, Quiet, Social, High
 * Energy, Nearby, Trip."
 *
 * census-compass CX-02 found three intent vocabularies and none of them this
 * one — until Discovery's live ranker declared the eight
 * (lib/discoveryLiveRank DISCOVERY_INTENT_MODES) with a crowd preference per
 * mode. This module PROMOTES that declaration to the one home every surface
 * reads, and states the three total maps that were coincidences before:
 *
 *   INTENT_MODE_TO_DECISION_INTENT  mode → the crowd preference it declares to
 *                                   lib/compassDecision `experienceValue` (null
 *                                   = the mode has no crowd preference: "Right
 *                                   Now" is about reachability, "Nearby" about
 *                                   distance, "Trip" about durability, and
 *                                   "Tonight" about trajectory — inventing a
 *                                   crowd taste for them would be guessing);
 *   MAP_INTENT_TO_MODE              Map §13's nine request-scoped kinds
 *                                   (compass/CompassTemporaryIntent) → mode,
 *                                   null where the kind says what to DO rather
 *                                   than how it should feel;
 *   INTENT_MODE_TO_FEED_SECTION     mode → the Compass feed section that was
 *                                   already named after it, null where none is.
 *
 * `CompassIntentModeEngine`'s nine CONTEXT modes (explore_now, arrival_mode,
 * night_mode, …) are a different axis — a derived prompt-weighting mode, not
 * a declared intent — and are deliberately NOT collapsed into these eight.
 *
 * Dependency-free apart from a type; PURE.
 */
import type { DecisionIntent } from "./compassDecision.js";

/** The eight, in the spec's own order and wording. */
export const INTENT_MODES = [
  "right_now", "tonight", "explore", "quiet", "social", "high_energy", "nearby", "trip",
] as const;
export type IntentMode = (typeof INTENT_MODES)[number];

/** The spec's own words, for a chip or a prompt line. */
export const INTENT_MODE_LABELS: Readonly<Record<IntentMode, string>> = Object.freeze({
  right_now: "Right Now",
  tonight: "Tonight",
  explore: "Explore",
  quiet: "Quiet",
  social: "Social",
  high_energy: "High Energy",
  nearby: "Nearby",
  trip: "Trip",
});

export function isIntentMode(v: unknown): v is IntentMode {
  return typeof v === "string" && (INTENT_MODES as readonly string[]).includes(v);
}

/** Parse a caller-supplied mode. Unknown / absent ⇒ null; the caller decides the default, never a 400. */
export function parseIntentMode(raw: unknown): IntentMode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return isIntentMode(v) ? v : null;
}

/** The crowd preference a mode declares to the shared decision engine; null = none. TOTAL. */
export const INTENT_MODE_TO_DECISION_INTENT: Readonly<Record<IntentMode, DecisionIntent | null>> = Object.freeze({
  right_now: null,
  tonight: null,
  explore: "explore",
  quiet: "quiet",
  social: "social",
  high_energy: "high_energy",
  nearby: null,
  trip: null,
});

/** Map §13's nine kinds, spelled as compass/CompassTemporaryIntent declares them, onto the eight. TOTAL. */
export const MAP_INTENT_TO_MODE: Readonly<Record<
  "bored" | "eat" | "party" | "explore" | "meet_people" | "date_night" | "chill" | "local" | "surprise_me",
  IntentMode | null
>> = Object.freeze({
  bored: null,
  eat: null,
  party: "high_energy",
  explore: "explore",
  meet_people: "social",
  date_night: null,
  chill: "quiet",
  local: "nearby",
  surprise_me: null,
});

/** The Compass feed section already named after a mode (compass/CompassFeedBuilder SECTION_NAMES). TOTAL. */
export const INTENT_MODE_TO_FEED_SECTION: Readonly<Record<
  IntentMode,
  "available_now" | "tonight" | "near_your_area" | "during_your_trip" | null
>> = Object.freeze({
  right_now: "available_now",
  tonight: "tonight",
  explore: null,
  quiet: null,
  social: null,
  high_energy: null,
  nearby: "near_your_area",
  trip: "during_your_trip",
});

/** The layover vibe chips that name a mode. Chips that say what to DO (food, shopping, culture) name none. */
export const LAYOVER_CHIP_TO_MODE: Readonly<Record<string, IntentMode>> = Object.freeze({
  nightlife: "high_energy",
  quiet: "quiet",
  relax: "quiet",
  social: "social",
});
