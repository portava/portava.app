/**
 * Presence fusion — the CLOSED REGISTER of presence sources (spec §17, §19).
 *
 * ── WHY A CLOSED UNION AND NOT A `register()` FUNCTION ───────────────────────
 * Sensing §1 forbids "a second social presence model". Four of them shipped
 * anyway, because nothing in the code made a fifth harder to add than a fourth.
 * A registry with an `add`/`register` entry point would not fix that: it makes a
 * fifth model a one-line call at runtime, invisible to review.
 *
 * So the set of presence sources is a UNION TYPE, not a mutable map. Adding a
 * source means editing this file — a reviewed diff that shows up in a census
 * scope — and the write capabilities in `store.ts` are minted once, at module
 * load, one per member of that union. There is no factory anywhere that can
 * produce a capability for a name this file does not list, and there is no
 * `PresenceFusionStore.register`. That is the whole mechanism behind "a second
 * presence write path is unrepresentable": it is not a lint rule, it is the
 * absence of a callable.
 *
 * ── THE FOUR, NAMED AS THE CENSUS NAMES THEM ─────────────────────────────────
 * `circle_presence`, `trip_crew_location_sessions`, `locateFriendsSession` and
 * the map's `social_zone`/`buddy_zone`/`crew_member` kinds. The ids below are
 * those four, spelled to match the tables/modules they are a model OF, so a
 * reader can check the register against the census without a translation table.
 *
 * ── `readsThrough` IS A CLAIM WITH A TEST BEHIND IT ──────────────────────────
 * Each contract states the module that consumes the fusion store for that
 * source, or `null` plus a NON-EMPTY `blockedBy`. `presenceFusionWiring.test.ts`
 * reads the named file and asserts it actually imports the store — and asserts
 * the converse for a `null`, so a source cannot be quietly marked wired, and a
 * source that HAS been wired cannot keep an out-of-date excuse. The honest
 * state of a partial migration is data here, not prose in a commit message.
 */
import { FEATURE_PRECISION_CEILING, type LocationPrecision } from "../domain/types.js";

/**
 * The four presence models, closed. Order is not load-bearing; membership is.
 */
export const PRESENCE_SOURCES = [
  "circle_presence",
  "trip_crew_location_sessions",
  "locate_friends_session",
  "map_social_presence",
] as const;

export type PresenceSourceId = (typeof PRESENCE_SOURCES)[number];

export function isPresenceSourceId(v: unknown): v is PresenceSourceId {
  return typeof v === "string" && (PRESENCE_SOURCES as readonly string[]).includes(v);
}

/**
 * §17's privacy CLASSES, which the spec requires stay distinct even though the
 * architecture is shared: "private device presence, aggregate intelligence
 * presence, social presence, Trip crew, Buddy, public discovery".
 *
 * A class is not a precision. Two sources may share a ceiling and still be
 * different classes — that is exactly why §17 says "reuse low-level
 * sensor/proximity infrastructure where possible, NOT consent/policy
 * semantics". The store keys retention per (source, subject), never per class,
 * so a class can never inherit another class's consent by sharing a rung.
 */
export const PRESENCE_CLASSES = [
  "private_device",
  "aggregate_intelligence",
  "social",
  "trip_crew",
  "buddy",
  "public_discovery",
] as const;
export type PresenceClass = (typeof PRESENCE_CLASSES)[number];

export interface PresenceSourceContract {
  readonly id: PresenceSourceId;
  /** §17 class. Distinct classes may not be fused into one another. */
  readonly presenceClass: PresenceClass;
  /**
   * §52 ceiling for this source. The store folds it into every claim, so a
   * source cannot ask for more than its class allows even by mistake.
   */
  readonly ceiling: LocationPrecision;
  /** The tables/modules this model is built on, for the census to check against. */
  readonly backing: readonly string[];
  /**
   * The module that reads presence through the fusion store for this source,
   * relative to `artifacts/api-server/`. `null` means NOTHING does yet.
   */
  readonly readsThrough: string | null;
  /** Required and non-empty exactly when `readsThrough` is null. */
  readonly blockedBy: string | null;
}

/**
 * ── CEILINGS, EACH WITH ITS REASON ───────────────────────────────────────────
 *
 * circle_presence              `venue`. migration 0117 gives it no coordinate
 *                              columns at all (lib/circleResponseShaper.ts:137
 *                              — "V1: no coordinate columns in circle_presence
 *                              — always null"); what it carries is a status and
 *                              a venue/area LABEL. `venue` is the rung a label
 *                              occupies. Anything above it would be a ceiling
 *                              for data this source cannot hold.
 * trip_crew_location_sessions  `crew`, i.e. `precise`. §23 puts Trip Crew at
 *                              "approximate or permitted temporary precise";
 *                              the permitted-precise case is real here, so the
 *                              CEILING is precise and the per-session grant
 *                              does the narrowing.
 * locate_friends_session       `crew`, for §23's reason that it names Trip Crew
 *                              and Locate My Friends in the same sentence.
 *                              lib/locateFriendsSession.ts already derives
 *                              LOCATE_FRIENDS_FEATURE_CEILING from exactly this
 *                              row and a test pins the agreement.
 * map_social_presence          `crew`/`precise` as the SOURCE ceiling, because
 *                              one of its three kinds (`crew_member`) can carry
 *                              a permitted temporary precise crew pin. The real
 *                              narrowing is per KIND — see
 *                              MAP_PRESENCE_KIND_CEILING below — and the map
 *                              hands those in as claim ceilings.
 */
export const PRESENCE_SOURCE_CONTRACTS: Readonly<Record<PresenceSourceId, PresenceSourceContract>> =
  Object.freeze({
    circle_presence: Object.freeze({
      id: "circle_presence",
      presenceClass: "social",
      ceiling: "venue",
      backing: [
        "src/migrations/0108_circle_schema_tracked.sql:147 — one row per (user, context)",
        "migrations/0117_circle_presence.sql — the table itself",
        "src/routes/circle.ts — the only writer and reader",
        "src/lib/circleResponseShaper.ts — the response shape",
      ],
      readsThrough: null,
      blockedBy:
        "Every read and write of circle_presence lives in src/routes/circle.ts and " +
        "src/lib/circleResponseShaper.ts. Neither file is in this lane's ownership, so the " +
        "source is REGISTERED and CEILINGED here but nothing reads its estimates through the " +
        "store yet. Wiring it is a one-call change in circleResponseShaper.shapePresence once that " +
        "file is editable: build a claim from the row, admit it, take the rung from the estimate.",
    }),
    trip_crew_location_sessions: Object.freeze({
      id: "trip_crew_location_sessions",
      presenceClass: "trip_crew",
      ceiling: FEATURE_PRECISION_CEILING.crew,
      backing: [
        "src/migrations/0041_trip_crew_location.sql",
        "src/domain/trips/services/TripCrewLocationService.ts — the reader",
        "src/domain/trips/projections/TripMapProjection.ts:284 — its crew_member pins",
      ],
      readsThrough: null,
      blockedBy:
        "src/domain/trips/services/TripCrewLocationService.ts owns the read and is not in " +
        "this lane's ownership (the lane brief scopes services/tripCrew/**, which does not " +
        "exist — the service lives under domain/trips/services/). Its MAP half does reach " +
        "the store: TripMapProjection emits kind 'crew_member', and every crew_member served " +
        "through routes/mapProjection passes aggregateForViewport's presence gate.",
    }),
    locate_friends_session: Object.freeze({
      id: "locate_friends_session",
      presenceClass: "social",
      ceiling: FEATURE_PRECISION_CEILING.crew,
      backing: [
        "src/migrations/2219_locate_friends_sessions.sql — sessions, members, positions",
        "src/lib/locateFriendsSession.ts — the whole policy half",
      ],
      readsThrough: "src/lib/locateFriendsSession.ts",
      blockedBy: null,
    }),
    map_social_presence: Object.freeze({
      id: "map_social_presence",
      presenceClass: "public_discovery",
      ceiling: FEATURE_PRECISION_CEILING.crew,
      backing: [
        "src/lib/mapProjection.ts:130 projectTraveler — social_zone",
        "src/lib/mapProjection.ts:304 projectCircleMember — crew_member",
        "src/lib/mapProjection.ts:404 projectBuddy — buddy_zone",
        "src/domain/trips/projections/TripMapProjection.ts:284 — crew_member",
      ],
      readsThrough: "src/lib/mapAggregation.ts",
      blockedBy: null,
    }),
  } as const satisfies Record<PresenceSourceId, PresenceSourceContract>);

/**
 * The three map object kinds S3 names. Held HERE rather than in mapAggregation
 * so the ceiling decision for a presence rendering lives in the fusion layer —
 * the map supplies the kind, the fusion layer supplies the bound.
 *
 * These strings are members of lib/mapObjects.MAP_OBJECT_KINDS;
 * `presenceFusionWiring.test.ts` asserts that rather than trusting it, and the
 * fusion layer deliberately does NOT import the map's types — a presence
 * ceiling table must not drag the whole map object model into src/presence/**.
 */
export const MAP_PRESENCE_KINDS = ["social_zone", "buddy_zone", "crew_member"] as const;
export type MapPresenceKind = (typeof MAP_PRESENCE_KINDS)[number];

export function isMapPresenceKind(v: unknown): v is MapPresenceKind {
  return typeof v === "string" && (MAP_PRESENCE_KINDS as readonly string[]).includes(v);
}

/**
 * §23's rung for each presence rendering, on the SERVER's ladder.
 *
 *   social_zone   `approximate`. §6: "Group icon = Aggregate social opportunity".
 *                 lib/mapProjection.travelerPrivacyClass already caps a traveler
 *                 at §23 `approximate` (a ~2 km cell) or `aggregate_only` (a city
 *                 centroid) and fails closed to the latter. This is the same bound
 *                 restated where the store can enforce it.
 *   buddy_zone    `approximate`. A buddy pin is an area-rounded MEETUP BASE the
 *                 buddy chose, not a live position — lib/mapProjection states
 *                 `precise_temporary` "is not reachable here and must never be
 *                 claimed". Making the ceiling `approximate` is that sentence as
 *                 arithmetic.
 *   crew_member   `precise`. A consented crew/circle pin MAY be a permitted
 *                 temporary precise share (§23). The per-object grant narrows it;
 *                 the kind does not.
 */
export const MAP_PRESENCE_KIND_CEILING = {
  social_zone: "approximate",
  buddy_zone: "approximate",
  crew_member: "precise",
} as const satisfies Record<MapPresenceKind, LocationPrecision>;

/**
 * The SAME ceiling, restated on §23's PrivacyClass ladder, because the two
 * ladders disagree in one place and the map is served on the class one.
 *
 * `lib/locateFriendsSession.ts` documents the disagreement in full: the class
 * ladder ranks `place_level` ABOVE `approximate`, while `PRECISION_LADDER`
 * ranks `venue` (2) BELOW `zone` (3) and `approximate` (4). Converting a class
 * to a rung and back is therefore not the identity, and a gate that only went
 * one way could hand a buddy pin `place_level` while meaning `approximate`.
 *
 * So both bounds are declared and BOTH are applied — the rung bound to the
 * estimate, the class bound to the served object. Both only ever tighten, so
 * applying two of them cannot widen anything; the cost is one extra line here
 * and the benefit is that neither ladder's ordering has to be trusted.
 *
 * These strings are members of lib/mapObjects.PRIVACY_CLASSES;
 * `presenceFusionWiring.test.ts` asserts that rather than assuming it.
 */
export const MAP_PRESENCE_KIND_CLASS_CEILING = {
  social_zone: "approximate",
  buddy_zone: "approximate",
  crew_member: "precise_temporary",
} as const satisfies Record<MapPresenceKind, string>;
