/**
 * census-layover L75 — spec §9 `ExperiencePrimitive`, on every layover card.
 *
 *   ExperiencePrimitive {
 *     type: EAT | SEE | MEET | DRINK | SHOP | WALK | REST | PHOTO |
 *           EXPLORE | PLAY | LEARN | NIGHTLIFE | TRANSIT
 *     minDuration, idealDuration, compressibility, interruptibility,
 *     reversibility, costRange, energyCost, weatherCompatibility,
 *     reservationRequirement
 *   }
 *
 * ── THE TRIPS PRIMITIVE, NOT A SECOND ONE ────────────────────────────────────
 * The thirteen types and the per-type defaults already exist, in the Trips
 * experience compiler (`domain/trips/services/TripExperienceCompiler.ts`:
 * `ACTIVITY_PRIMITIVES`, `PRIMITIVE_DEFAULTS`, `primitiveFor`,
 * `OPEN_AIR_PRIMITIVES`), graded C ×10 by census-trips §43 (TR233–TR243).
 * Spec §2.1 forbids a second copy of a rule, so this module IMPORTS them and
 * adds only what Trips cannot know: which LAYOVER card is which type. Nothing
 * here re-states a duration, an energy cost or a cost band.
 *
 * ── A DESCRIPTOR, NEVER AN INPUT TO THE SAFETY MATH (census §16 / L293) ──────
 * Every number below is the TYPICAL value for the card's type — what a meal or
 * a museum usually takes — and never a measurement of the place on the card.
 * census L293 deleted exactly this kind of category default
 * (`estimateActivityTime`: 30 / 90 / 60 by category) from the safety path,
 * because it drove the rating a traveller acts on by leaving an airport. So:
 *
 *   * the descriptor is attached AFTER the card is rated, sanitised and
 *     banded, at the two places a card is served, and it is computed from the
 *     served card alone (`recType`, `insideAirport`, `title`);
 *   * it is NOT stored — no column, no row key, no event metadata;
 *   * nothing on the safety path imports this module: not `assess`, not
 *     `rankActivities`, not plan fit, not the certified record. A card's
 *     `activityTimeMin` stays what it was — `null` for a discovery place,
 *     because nobody stated how long it takes. `src/test/layoverExperiencePrimitive.test.ts`
 *     pins all three, and that the ratings are byte-identical whatever the
 *     defaults say.
 *
 * `source: "category_default"` says so on the wire, and the app renders it
 * as "Typical for …", never as the card's own duration.
 *
 * ── WHICH CARD IS WHICH TYPE ─────────────────────────────────────────────────
 * Derived from the SERVED card, so the generate path and the stored read path
 * (`getRecommendations`) give the same card the same type. `place_type` is
 * not on a stored row (`layover_recommendations` keeps only the nine-value
 * `rec_type`, 0127), so reading it on one path would make the two disagree.
 *
 *   1. A `rec_type` that NAMES an activity (`food`, `rest`, `nightlife`,
 *      `meetup`) is compiled by Trips' own place-type table, `primitiveFor` —
 *      the same answer a Trips candidate of that type gets.
 *   2. A `rec_type` that names an activity Trips' table does not know is
 *      mapped here: `activity` (an unspecified thing to do), `hidden_gem` and
 *      `quick_city_escape` ("a short exploration of the city") are EXPLORE.
 *      They are NOT passed to `primitiveFor`: its PLAY pattern matches the
 *      "escape" in `quick_city_escape`.
 *   3. `inside_airport` and `near_airport` name a LOCATION, not an activity
 *      (and `primitiveFor` would call both TRANSIT, from "airport"). An airside
 *      card's type comes from its title, which is its identity on this path
 *      already (`recommendationKey`: `inside:<rec_type>:<slug(title)>`), and
 *      only for the airside catalogue `insideAirportCandidates` writes.
 *   4. Anything else is EXPLORE, Trips' own answer for an unknown type, and
 *      says so: `typeBasis: "unmapped"`.
 *
 * ── WEATHER ──────────────────────────────────────────────────────────────────
 * Trips has no `weatherCompatibility` field; it has a RULE —
 * `compileExperiences` invalidates an `OPEN_AIR_PRIMITIVES` candidate on rain,
 * except TRANSIT and MEET. `rainExposed` is that rule, and the test runs the
 * real compiler for all thirteen types so the two cannot drift. An airside
 * card is under the terminal roof whatever its type: `all_weather`, with
 * `weatherBasis: "inside_airport"` — a fact about the card, not a default.
 *
 * `unknown` FOR REST AND EXPLORE (verification of PR #713). Those are the only
 * two rain-exposed types a landside layover card can have, and on a layover
 * card neither names a venue: EXPLORE is every museum, mall, temple and park the
 * producer writes as `activity`; REST is a spa or a day hotel. Trips' rule
 * called all of them open-air, so the card told a traveller a museum was
 * "weather-dependent". The TYPE does not decide it, the venue does, and the
 * venue is not known: `unknown`, `weatherBasis: "venue_dependent"`, and the
 * app says nothing. WALK and PHOTO keep Trips' rule — rain exposure is what
 * those types are.
 */
import {
  ACTIVITY_PRIMITIVES,
  OPEN_AIR_PRIMITIVES,
  PRIMITIVE_DEFAULTS,
  primitiveFor,
  type ActivityPrimitive,
  type CandidateProperties,
} from "../../domain/trips/services/TripExperienceCompiler.js";

/** The spec's thirteen types — Trips' vocabulary, re-exported, not re-listed. */
export const LAYOVER_EXPERIENCE_TYPES: readonly ActivityPrimitive[] = ACTIVITY_PRIMITIVES;

/** `unknown`: the card's type does not decide its rain exposure (see the header). Never rendered. */
export const WEATHER_COMPATIBILITIES = ["all_weather", "fair_weather", "unknown"] as const;
export type WeatherCompatibility = (typeof WEATHER_COMPATIBILITIES)[number];

/** `unknown` is Trips' `reservationRequired: null` — not known, which is not "no". */
export const RESERVATION_REQUIREMENTS = ["required", "not_required", "unknown"] as const;
export type ReservationRequirement = (typeof RESERVATION_REQUIREMENTS)[number];

export type ExperienceTypeBasis = "rec_type" | "airside_card" | "unmapped";

/** The spec's ten members, plus where they came from. */
export interface LayoverExperience {
  type: ActivityPrimitive;
  /** Minutes. Typical for `type`, never this place's. */
  minDuration: number;
  /** Minutes. Typical for `type`, never this place's. */
  idealDuration: number;
  /** 0 = only the ideal works; 1 = anything down to the minimum is as good (Trips' definition). */
  compressibility: number;
  interruptibility: CandidateProperties["interruptibility"];
  reversibility: CandidateProperties["reversibility"];
  /** A band for the TYPE (free … high), never a venue's price; `null` = unknown. */
  costRange: CandidateProperties["costBand"];
  energyCost: CandidateProperties["energyCost"];
  weatherCompatibility: WeatherCompatibility;
  reservationRequirement: ReservationRequirement;
  /** Every member above is the default for `type`, except an airside card's weather (see `weatherBasis`). */
  source: "category_default";
  typeBasis: ExperienceTypeBasis;
  weatherBasis: "inside_airport" | "category_default" | "venue_dependent";
}

/** The fields of a served card this reads. Nothing else — see the header. */
export interface ExperienceCardFacts {
  recType: string;
  title: string;
  insideAirport: boolean;
}

/** Rule 1: rec_types that name an activity Trips' place-type table compiles. */
const REC_TYPES_TRIPS_COMPILES: ReadonlySet<string> = new Set(["food", "rest", "nightlife", "meetup"]);

/** Rule 2: rec_types that name an activity Trips' table does not know. */
const REC_TYPES_MAPPED_HERE: Readonly<Record<string, ActivityPrimitive>> = {
  activity: "EXPLORE",
  hidden_gem: "EXPLORE",
  quick_city_escape: "EXPLORE",
};

/**
 * Rule 3: the airside catalogue `insideAirportCandidates` writes under
 * `rec_type = 'inside_airport'`, by title. The two airside cards with their own
 * rec_type ("Airport Dining" = food, "Rest & Sleep Pod" = rest) take rule 1.
 * A title added there and not here is `unmapped`, and the test that builds
 * every airside card fails on it.
 */
export const AIRSIDE_CARD_TYPES: Readonly<Record<string, ActivityPrimitive>> = {
  "Airport Lounge / Rest Area": "REST",
  "Duty-Free & Airport Shops": "SHOP",
  "Airport Art & Culture": "SEE",
};

/**
 * The rain-exposed types whose exposure, on a layover card, depends on a venue
 * nobody has read: REST (a spa, a day hotel) and EXPLORE (a museum, a mall, a
 * temple, a park). See the header.
 */
export const WEATHER_DECIDED_BY_VENUE: ReadonlySet<ActivityPrimitive> = new Set<ActivityPrimitive>(["REST", "EXPLORE"]);

/** Trips' rain rule, as `compileExperiences` applies it (see the header). */
export function rainExposed(type: ActivityPrimitive): boolean {
  return OPEN_AIR_PRIMITIVES.includes(type) && type !== "TRANSIT" && type !== "MEET";
}

export function experienceTypeFor(card: ExperienceCardFacts): { type: ActivityPrimitive; typeBasis: ExperienceTypeBasis } {
  if (REC_TYPES_TRIPS_COMPILES.has(card.recType)) return { type: primitiveFor(card.recType), typeBasis: "rec_type" };
  const mapped = REC_TYPES_MAPPED_HERE[card.recType];
  if (mapped) return { type: mapped, typeBasis: "rec_type" };
  if (card.insideAirport && card.recType === "inside_airport") {
    const airside = AIRSIDE_CARD_TYPES[card.title];
    if (airside) return { type: airside, typeBasis: "airside_card" };
  }
  return { type: "EXPLORE", typeBasis: "unmapped" };
}

/**
 * A card's weather, and where it came from. Airside: under the terminal roof.
 * Landside REST / EXPLORE: the venue decides and is unknown. Anything else:
 * Trips' rain rule for the type.
 */
export function weatherCompatibilityFor(type: ActivityPrimitive, insideAirport: boolean): Pick<LayoverExperience, "weatherCompatibility" | "weatherBasis"> {
  if (insideAirport) return { weatherCompatibility: "all_weather", weatherBasis: "inside_airport" };
  if (WEATHER_DECIDED_BY_VENUE.has(type)) return { weatherCompatibility: "unknown", weatherBasis: "venue_dependent" };
  return { weatherCompatibility: rainExposed(type) ? "fair_weather" : "all_weather", weatherBasis: "category_default" };
}

function reservationRequirementOf(required: boolean | null): ReservationRequirement {
  if (required === true) return "required";
  if (required === false) return "not_required";
  return "unknown";
}

/**
 * The descriptor for one served card. Pure: the same card gives the same
 * descriptor on every path. The defaults are read at call time, so the test
 * can prove a change to them reaches this descriptor and nothing else.
 */
export function layoverExperienceFor(card: ExperienceCardFacts): LayoverExperience {
  const { type, typeBasis } = experienceTypeFor(card);
  const d = PRIMITIVE_DEFAULTS[type];
  const weather = weatherCompatibilityFor(type, card.insideAirport === true);
  return {
    type,
    minDuration: d.minimumMinutes,
    idealDuration: d.idealMinutes,
    compressibility: d.compressibility,
    interruptibility: d.interruptibility,
    reversibility: d.reversibility,
    costRange: d.costBand,
    energyCost: d.energyCost,
    weatherCompatibility: weather.weatherCompatibility,
    reservationRequirement: reservationRequirementOf(d.reservationRequired),
    source: "category_default",
    typeBasis,
    weatherBasis: weather.weatherBasis,
  };
}
