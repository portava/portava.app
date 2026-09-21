/**
 * creatorTypes — the SIX creator value types of `07` §2, as a closed vocabulary.
 * PURE. It reaches no database and moves no money.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `docs/specs/discovery-v1/07_Creator_Economy.md` §2 names six types under six
 * headings. Before this file, a whole-tree grep for "Discovery Creator",
 * "Trail Builder", "Local Expert", "Itinerary Creator", "Experience Host" or
 * "Travel Partner" matched NOTHING — no constant, no column, no comment. The
 * creator-type dimension did not exist anywhere in the tree.
 *
 * The consequence is the one that matters for `07` §10. Earnings were recorded
 * against a SUBSYSTEM, never against a creator type:
 *
 *   public.intel_reward_ledger      (2170)  — an intel contributor's credit
 *   public.rent_buddy_earnings_entries (2901) — a Rent-a-Buddy booking's entries
 *
 * Both are per-subsystem by construction and neither can be widened.
 * `rent_buddy_earnings_entries.booking_id` is `NOT NULL REFERENCES
 * public.rent_buddy_bookings(id)` and its `attribution_kind` CHECK admits the
 * single value `'booking'` (2901); `intel_attributions` (2277) is pinned to
 * `claim_id` + `observation_id` + Table 22's five `touch` labels. A Trail
 * Builder's contribution is not expressible in either, and neither is an
 * Itinerary Creator's or an Experience Host's.
 *
 * So the five §10 properties held for AT MOST TWO of the six types, and the
 * intel ledger does not even distinguish its two — a Discovery Creator ("finds
 * valuable places early") and a Local Expert ("consistently contributes
 * accurate destination knowledge") both collapse to `intel_observations.actor_id`.
 *
 * ── THE HONEST PART: AN OBJECT IS NOT A VALUE EVENT ─────────────────────────
 * Each type below declares TWO different things, and conflating them is the
 * defect this file is written to prevent:
 *
 *   subjectTable        the OBJECT a contribution is attributed AGAINST.
 *                       Five of six have one. `itinerary_creator` does not:
 *                       there is no published-itinerary object in this tree.
 *                       `trips` are private plans, not adoptable artifacts, and
 *                       `content_trails.source_type` admits the string
 *                       `'itinerary'` (2910) while no itineraries table exists.
 *
 *   valueEventProducer  the SHIPPING code that records the §3 Traveler Impact
 *                       outcome this type earns from. Only TWO of six have one.
 *
 * A type with a subject but no producer gets a REAL, FK-addressable attribution
 * seam and no earnings, and says so in `noProducerReason`. That is a seam with
 * no producer: it closes nothing, and claiming otherwise would be the defect.
 * `07` §1 constrains what may ever fill those seams — "views, likes, follower
 * count, raw comments" are named as things not to pay for, which is why
 * `trail_follows` (2910) is NOT recorded here as a Trail Builder value event
 * even though it is a real, populated, timestamped table.
 *
 * ── VERIFICATION, NOT INHERITANCE ───────────────────────────────────────────
 * Every claim above was re-derived for this file: the six §2 headings were read
 * from the spec (and `src/test/creatorTypeVocabulary.test.ts` re-reads them on
 * every run, so this vocabulary cannot drift from §2 silently); the subject
 * tables were confirmed present on the rehearsal project; and the producer
 * column was confirmed by reading the writers, not by trusting a prior report.
 *
 * RUNTIME EFFECT: NONE on its own.
 */

// ── The six types ───────────────────────────────────────────────────────────

/** `07` §2, in the spec's own order. A CLOSED set. */
export type CreatorType =
  | "discovery_creator"
  | "trail_builder"
  | "local_expert"
  | "itinerary_creator"
  | "experience_host"
  | "travel_partner";

export const CREATOR_TYPES: readonly CreatorType[] = [
  "discovery_creator",
  "trail_builder",
  "local_expert",
  "itinerary_creator",
  "experience_host",
  "travel_partner",
] as const;

/** The object a contribution of a given type is attributed against. */
export type CreatorSubjectKind =
  | "place"
  | "trail"
  | "intel_claim"
  | "itinerary"
  | "experience"
  | "booking";

export const CREATOR_SUBJECT_KINDS: readonly CreatorSubjectKind[] = [
  "place", "trail", "intel_claim", "itinerary", "experience", "booking",
] as const;

/**
 * `07` §3's Traveler Impact outcomes. §3 is explicit that these are an INTERNAL
 * concept and that no single raw public score may be exposed — so this is a
 * vocabulary for attribution rows, never a number for a profile.
 */
export type TravelerImpactOutcome =
  | "save_to_trip"
  | "itinerary_adoption"
  | "verified_booking"
  | "verified_visit"
  | "route_completion"
  | "repeat_use"
  | "post_visit_confirmation";

export const TRAVELER_IMPACT_OUTCOMES: readonly TravelerImpactOutcome[] = [
  "save_to_trip", "itinerary_adoption", "verified_booking", "verified_visit",
  "route_completion", "repeat_use", "post_visit_confirmation",
] as const;

/**
 * The §3 bullet each outcome is a transliteration of, VERBATIM. Kept beside the
 * identifiers rather than derived from them by a regex: "save-to-trip" and
 * "post-visit confirmation" hyphenate where "itinerary adoption" does not, so
 * any mechanical de-underscoring would be wrong for some member and the test
 * would be checking the regex rather than the spec.
 */
export const TRAVELER_IMPACT_SPEC_LABELS: Readonly<Record<TravelerImpactOutcome, string>> = {
  save_to_trip: "save-to-trip",
  itinerary_adoption: "itinerary adoption",
  verified_booking: "verified booking",
  verified_visit: "verified visit",
  route_completion: "route completion",
  repeat_use: "repeat use",
  post_visit_confirmation: "post-visit confirmation",
} as const;

// ── Per-type facts ──────────────────────────────────────────────────────────

export interface CreatorTypeFacts {
  type: CreatorType;
  /** The §2 heading, verbatim. */
  specName: string;
  /** 1-indexed line of that heading in docs/specs/discovery-v1/07_Creator_Economy.md. */
  specLine: number;
  /** The single line under the heading, verbatim. */
  specDefinition: string;
  /** The object this type's contributions are attributed against. */
  subjectKind: CreatorSubjectKind;
  /** Where that object lives, or null when NO object exists in this tree yet. */
  subjectTable: string | null;
  /** The §3 outcome this type earns from. */
  valueEvent: TravelerImpactOutcome;
  /** Shipping code that records that outcome, or null — a seam with no producer. */
  valueEventProducer: string | null;
  /** Why there is no producer. Empty exactly when there IS one. */
  noProducerReason: string;
  /**
   * `07` §10 "rules are versioned", read per type. Distinct per type on purpose:
   * one shared version would mean re-pricing Trails silently re-prices intel.
   * The PERCENTAGES stay configurable in `public.creator_rule_versions` (2920)
   * — §8 — and this only names the generation an entry was computed under.
   */
  defaultRuleVersion: string;
}

export const CREATOR_TYPE_FACTS: Readonly<Record<CreatorType, CreatorTypeFacts>> = {
  discovery_creator: {
    type: "discovery_creator",
    specName: "Discovery Creator",
    specLine: 17,
    specDefinition: "Finds valuable places early.",
    subjectKind: "place",
    subjectTable: "public.discovery_places",
    valueEvent: "save_to_trip",
    valueEventProducer: null,
    noProducerReason:
      "Nothing records WHO surfaced a place that was later saved. public.trip_saved_places " +
      "carries trip_id, user_id and place_id and no source or author column, and public.rank_events " +
      "(0153) logs outcome='save' against item_id with no author on the served shape — the same " +
      "absence census-discovery records for DV-79/DV-82. The attribution seam below is addressable " +
      "against discovery_places today; the save event that would fill it has no producer.",
    defaultRuleVersion: "creator-rules/discovery-creator/v1",
  },
  trail_builder: {
    type: "trail_builder",
    specName: "Trail Builder",
    specLine: 20,
    specDefinition: "Creates/maintains useful Trails.",
    subjectKind: "trail",
    subjectTable: "public.trails",
    valueEvent: "route_completion",
    valueEventProducer: null,
    noProducerReason:
      "public.trails (2910) gives a Trail Builder a real object — trails.created_by and " +
      "content_trails.contributor_id both name a person — so an attribution row is FK-addressable " +
      "today. But no completion is recorded against a Trail: 2910's own COMMENT states content_trails " +
      "is 'NOT a behaviour store — no impression or outcome is ever written here (04 §2)'. " +
      "public.trail_follows is deliberately NOT treated as the value event: `07` §1 names follower " +
      "count among the things not to pay for.",
    defaultRuleVersion: "creator-rules/trail-builder/v1",
  },
  local_expert: {
    type: "local_expert",
    specName: "Local Expert",
    specLine: 23,
    specDefinition: "Consistently contributes accurate destination knowledge.",
    subjectKind: "intel_claim",
    subjectTable: "public.intel_claims",
    valueEvent: "post_visit_confirmation",
    valueEventProducer: "services/intel/RewardOracle.ts",
    noProducerReason: "",
    defaultRuleVersion: "creator-rules/local-expert/v1",
  },
  itinerary_creator: {
    type: "itinerary_creator",
    specName: "Itinerary Creator",
    specLine: 26,
    specDefinition: "Builds plans that travelers actually use.",
    subjectKind: "itinerary",
    subjectTable: null,
    valueEvent: "itinerary_adoption",
    valueEventProducer: null,
    noProducerReason:
      "There is no published-itinerary OBJECT in this tree, so this type has neither a subject nor " +
      "a producer. public.trips are private plans reached through trip_members, not artifacts a " +
      "stranger adopts, and no table records an adoption. The one place the word appears as a " +
      "first-class label is content_trails.source_type IN (...,'itinerary',...) (2910) — a string " +
      "in a CHECK with no relation behind it. The seam below therefore carries a subject_id that " +
      "nothing can yet reference; it is recorded as OPEN rather than counted as coverage.",
    defaultRuleVersion: "creator-rules/itinerary-creator/v1",
  },
  experience_host: {
    type: "experience_host",
    specName: "Experience Host",
    specLine: 29,
    specDefinition: "Hosts paid real-world experiences.",
    subjectKind: "experience",
    subjectTable: "public.events",
    valueEvent: "verified_booking",
    valueEventProducer: null,
    noProducerReason:
      "public.events gives a host a real object (events.host_id), and it even carries price_type. " +
      "But the money is OFF-PLATFORM by construction: the only paid-experience columns are " +
      "events.ticket_url and events.price_url, i.e. links away from Portava. Nothing records that a " +
      "ticket was bought, so there is no verified booking to attribute. `09` §1 'Portava moves no " +
      "money' is the reason that is a design, not a gap — but it means this type earns nothing today.",
    defaultRuleVersion: "creator-rules/experience-host/v1",
  },
  travel_partner: {
    type: "travel_partner",
    specName: "Travel Partner",
    specLine: 32,
    specDefinition: "Provides approved marketplace services.",
    subjectKind: "booking",
    subjectTable: "public.rent_buddy_bookings",
    valueEvent: "verified_booking",
    valueEventProducer: "lib/rentBuddyEarningsLedger.ts",
    noProducerReason: "",
    defaultRuleVersion: "creator-rules/travel-partner/v1",
  },
} as const;

// ── Reads ───────────────────────────────────────────────────────────────────

export function isCreatorType(v: unknown): v is CreatorType {
  return typeof v === "string" && (CREATOR_TYPES as readonly string[]).includes(v);
}

export function isCreatorSubjectKind(v: unknown): v is CreatorSubjectKind {
  return typeof v === "string" && (CREATOR_SUBJECT_KINDS as readonly string[]).includes(v);
}

export function isTravelerImpactOutcome(v: unknown): v is TravelerImpactOutcome {
  return typeof v === "string" && (TRAVELER_IMPACT_OUTCOMES as readonly string[]).includes(v);
}

/** Refuses an unknown type rather than returning undefined for a caller to ignore. */
export function creatorTypeFacts(type: CreatorType): CreatorTypeFacts {
  const f = CREATOR_TYPE_FACTS[type];
  if (!f) throw new Error(`unknown creator type: ${String(type)}`);
  return f;
}

/** The subject kind a given type's contributions must point at. */
export function subjectKindFor(type: CreatorType): CreatorSubjectKind {
  return creatorTypeFacts(type).subjectKind;
}

/** DERIVED, never restated — the honest list of types that can attribute but not earn. */
export function typesWithoutValueEventProducer(): CreatorType[] {
  return CREATOR_TYPES.filter((t) => CREATOR_TYPE_FACTS[t].valueEventProducer === null);
}

/** Types whose attribution subject does not exist as a relation at all. */
export function typesWithoutSubjectObject(): CreatorType[] {
  return CREATOR_TYPES.filter((t) => CREATOR_TYPE_FACTS[t].subjectTable === null);
}
