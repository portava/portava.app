/**
 * Location-processing purpose registry.
 *
 * Implements the owner ruling of 2026-08-22:
 *
 *   "Portava will minimize persistent raw movement history. Precise location
 *    will be processed only for defined product purposes and retained according
 *    to purpose-specific limits. Long-term intelligence should preferentially
 *    retain semantic events, derived traveler state, and privacy-thresholded
 *    aggregates. Sensitive social/location capabilities require separate user
 *    controls and appropriate consent/authorization. Every location-processing
 *    purpose must have a documented lawful basis, retention policy, visibility
 *    policy and deletion behavior for applicable jurisdictions."
 *
 * That last sentence is why this file is a registry and not a comment. Each
 * purpose below carries all four required fields, and checkLocationPurposes.ts
 * fails when a table carrying coordinates maps to no declared purpose — so a new
 * location surface cannot ship without someone writing down why it may exist.
 *
 * WHAT THE RULING DECIDED, AND WHAT IT DID NOT. It did NOT authorise a
 * persistent per-person movement trajectory; it rules the other way. The spec's
 * intel_observations is compatible only because it stores SEMANTIC claims keyed
 * to a place (subject_id -> places.id) and never raw coordinates. Anything that
 * wants to keep a precise trail needs its own purpose entry here, with a
 * retention limit, and it will be visible to review rather than implicit.
 */

/** How precise the data retained for a purpose actually is. */
export const PRECISION_CLASSES = ["precise", "coarse", "derived", "aggregate"] as const;
export type PrecisionClass = (typeof PRECISION_CLASSES)[number];

/**
 * The ruling's retention preference, most-preferred last-resort ordering.
 * `precise` is the least preferred and must always carry a bounded retention.
 */
export const PRECISION_PREFERENCE: Record<PrecisionClass, number> = {
  aggregate: 0, // most preferred
  derived: 1,
  coarse: 2,
  precise: 3,   // least preferred — bounded retention REQUIRED
};

/**
 * How a purpose's retention is bounded. Typed rather than inferred from prose:
 * the first version of this file decided "is this bounded?" by regex-matching
 * retentionNote for the words session/incident, which meant any purpose could
 * become compliant by wording. A bound must be a claim, not a phrase.
 */
export const RETENTION_BOUNDS = [
  "clock",            // retentionSeconds applies
  "registry_clock",   // a clock, but the number is per-claim-type in freshness_policies
  "session",          // ends when the session/incident ends
  "content_lifetime", // lives as long as the user-authored item it belongs to
  "open_decision",    // deliberately unresolved, awaiting an owner ruling
] as const;
export type RetentionBound = (typeof RETENTION_BOUNDS)[number];

export const LAWFUL_BASES = [
  "contract",            // needed to deliver something the traveler asked for
  "consent",             // explicit, versioned, withdrawable
  "legitimate_interest", // requires a documented LIA and a right to object
  "vital_interest",      // safety-of-life
  "legal_obligation",
] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export interface LocationPurpose {
  id: string;
  /** What the processing is FOR, in words a traveler could be shown. */
  description: string;
  precision: PrecisionClass;
  lawfulBasis: LawfulBasis;
  /** How retention is bounded. A precise purpose may never be unbounded. */
  retentionBound: RetentionBound;
  /** Set when retentionBound is "clock". */
  retentionSeconds: number | null;
  retentionNote: string;
  /** Who can see it. */
  visibility: string;
  /** What happens on account deletion. */
  deletionBehavior: string;
  /** Tables that hold data for this purpose. */
  tables: readonly string[];
  /** Set when the capability needs its own user control beyond a general setting. */
  requiresSeparateControl: boolean;
  jurisdictionNote?: string;
}

const HOUR = 3600, DAY = 24 * HOUR;

export const LOCATION_PURPOSES: readonly LocationPurpose[] = [
  {
    id: "safety_anti_spoof",
    retentionBound: "clock",
    description: "Confirm a check-in really happened where it claims, to stop spoofed presence.",
    precision: "precise",
    lawfulBasis: "legitimate_interest",
    retentionSeconds: DAY,
    retentionNote: "24h, enforced by expires_at AND an hourly purge (locationSnapshotPurgeScheduler). The purge existed as a function with no caller until 2026-08-22 — retention that nothing enforces is not retention.",
    visibility: "Never shown to any user. Server-side verification only.",
    deletionBehavior: "Deleted with the account; also expires on its own within a day.",
    tables: ["location_snapshots"],
    requiresSeparateControl: false,
  },
  {
    id: "live_session_sharing",
    retentionBound: "session",
    description: "Share your live position with a trip crew or circle while a session is running.",
    precision: "precise",
    lawfulBasis: "consent",
    retentionSeconds: null,
    retentionNote: "Bounded by the SESSION, not a clock: rows end when the session ends (ended_at/expires_at). A session that never ends is a defect, not a retention policy.",
    visibility: "Only the crew/circle the traveler shared with, at the precision they chose (circle_visibility_settings.visibility_mode: status_only | approximate_area | venue_checkin | precise_live).",
    deletionBehavior: "Deleted with the account.",
    tables: ["location_sessions", "user_locations", "trip_crew_location_sessions", "trip_crew_location_events"],
    requiresSeparateControl: true,
    jurisdictionNote: "Sharing precise location with other people is the highest-sensitivity capability here; consent is versioned (circle_visibility_settings.consent_version) and default-off.",
  },
  {
    id: "derived_traveler_state",
    retentionBound: "content_lifetime",
    description: "Keep the traveler's CURRENT coarse state (where they are now) to personalise what is shown.",
    precision: "derived",
    lawfulBasis: "contract",
    retentionSeconds: null,
    retentionNote: "Current state only — one row per traveler, overwritten. This is state, not history, which is exactly what the ruling prefers over a trail.",
    visibility: "Own row only (RLS: auth.uid() = user_id).",
    deletionBehavior: "Deleted with the account.",
    tables: ["user_location_state", "user_location_preferences", "location_preferences"],
    requiresSeparateControl: false,
  },
  {
    id: "geofence_checkin",
    retentionBound: "content_lifetime",
    description: "Register arrival at a planned stop so a trip's itinerary reflects reality.",
    precision: "coarse",
    lawfulBasis: "contract",
    retentionSeconds: null,
    retentionNote: "Kept for the life of the trip record. plan_checkins stores NO coordinates — status, timestamps and FKs only; the precise fix goes to the anti-spoof purpose above and expires there.",
    visibility: "Visible to members of the trip the geofence belongs to, and to nobody outside it.",
    deletionBehavior: "Deleted with the account.",
    tables: ["plan_checkins", "plan_geofences", "plan_attendance_events"],
    requiresSeparateControl: false,
  },
  {
    id: "presence_in_context",
    retentionBound: "session",
    description: "Show crew or event attendees that you have arrived, at the precision you chose.",
    precision: "coarse",
    lawfulBasis: "consent",
    retentionSeconds: null,
    retentionNote: "circle_presence is a TTL'd projection (stale_after_secs, expires_at) with a sweeper; circle_checkins is the append-only log behind it and stores venue/approximate labels, never coordinates.",
    visibility: "The trip or event context only, per circle_visibility_settings.",
    deletionBehavior: "Deleted with the account.",
    tables: ["circle_checkins", "circle_presence"],
    requiresSeparateControl: true,
  },
  {
    id: "safety_return",
    retentionBound: "session",
    description: "Let a chosen contact find you if a Safe Return session is not closed.",
    precision: "precise",
    lawfulBasis: "vital_interest",
    retentionSeconds: null,
    retentionNote: "Session-bounded. Safety data is deliberately NOT minimised away mid-incident.",
    visibility: "Only the emergency contacts the traveler nominated, and only while a session is active.",
    deletionBehavior: "Deleted with the account. An ACTIVE session is closed before deletion completes.",
    tables: ["safe_return_sessions", "safe_return_events", "safe_return_live_shares", "profile_emergency_contacts"],
    requiresSeparateControl: true,
    jurisdictionNote: "Vital interest is the basis only during an active session; outside one the basis reverts to consent.",
  },
  {
    id: "content_geotag",
    retentionBound: "content_lifetime",
    description: "Attach a place to something the traveler chose to post, save or pin.",
    precision: "coarse",
    lawfulBasis: "contract",
    retentionSeconds: null,
    retentionNote: "Lives as long as the content does. The traveler authored the association deliberately, so it is content, not observation.",
    visibility: "Follows the content's own visibility.",
    deletionBehavior: "Deleted with the content and with the account.",
    tables: ["posts", "map_pins", "trip_saved_places", "hidden_gems", "hidden_gem_visits",
             "delayed_post_location_events", "user_stamps"],
    requiresSeparateControl: false,
  },
  {
    id: "stamp_content",
    retentionBound: "content_lifetime",
    description: "Record where a passport stamp was earned, as part of the stamp the traveler created.",
    precision: "precise",
    lawfulBasis: "contract",
    retentionSeconds: null,
    retentionNote:
      "OWNER RULING 2026-08-23: a stamp is a POST — a permanent static item — and legitimately retains its " +
      "precise coordinates for the life of that item. This is not movement history: the ruling targets a " +
      "persistent trail derived from many involuntary observations, whereas a stamp is ONE artifact the " +
      "traveler deliberately created about one place. The bound is the life of the content, not a clock.",
    visibility: "Follows the stamp's own visibility (user_stamps).",
    deletionBehavior:
      "DELETED on account deletion, by database cascade rather than by application code. Verified against " +
      "the live schema on 2026-08-23: passport_stamps_gps.user_id REFERENCES auth.users ON DELETE CASCADE, " +
      "and AccountDeletionService step 5 calls auth.admin.deleteUser, so the coordinates go even though the " +
      "service never names the table. An earlier revision of this note claimed the opposite; it reasoned from " +
      "the absence of a reference in AccountDeletionService and from the table's presence in " +
      "deletionDispositions UNCLASSIFIED_BACKLOG, without checking the constraint. Both those things are " +
      "true and neither one means what it looked like it meant.\n" +
      "OPEN, AND THE REAL GAP IS THE OTHER WAY ROUND: the PARENT survives. passport_stamps.user_id " +
      "REFERENCES profiles, and on production profiles has NO foreign key to auth.users, so the anonymised " +
      "tombstone and every stamp attached to it outlive the account while their coordinates do not. Posts " +
      "are deleted explicitly by the service; stamps are content by the same owner ruling and are not. " +
      "Note this differs by environment — CI DOES have profiles_id_fkey -> auth.users ON DELETE CASCADE, so " +
      "CI erases the stamps and production does not. Tracked as part of D6.",
    tables: ["passport_stamps_gps"],
    requiresSeparateControl: false,
  },
  {
    id: "journey_observation",
    retentionBound: "clock",
    description: "Restricted Journey ingestion for segment/shadow evaluation.",
    precision: "precise",
    lawfulBasis: "consent",
    retentionSeconds: DAY,
    retentionNote: "24h via expires_at. Explicit per-owner opt-in (user_location_preferences.journey_observation_enabled) defaulting FALSE, re-read per batch, with consent_scope='journey_observation_v1' pinned on every row.",
    visibility: "Not shown to any user. RLS deny-default (0 policies).",
    deletionBehavior: "Deleted with the account via the journey revocation jobs.",
    tables: ["journey_observations", "journey_segment_revisions", "journey_revocation_jobs"],
    requiresSeparateControl: true,
  },
  {
    id: "intel_claim",
    retentionBound: "open_decision",
    description: "Record what a traveler reports about a PLACE (how busy, queue, access) to build live intelligence.",
    precision: "derived",
    lawfulBasis: "consent",
    retentionSeconds: null,
    retentionNote: "Stores NO coordinates: an observation is keyed to a canonical place (subject_id -> places.id) and carries a presence ATTESTATION (level, bucket, method), never a pointer to a coordinate row. This is the 'semantic event' shape the ruling prefers. Its own retention window is still an open owner decision (D6).",
    visibility: "Own rows only; published state is thresholded aggregate.",
    deletionBehavior: "Deleted with the account via erase_intel_for_actor().",
    tables: ["intel_observations", "intel_evidence", "intel_confirmations"],
    requiresSeparateControl: true,
  },
  {
    id: "aggregate_live_state",
    retentionBound: "registry_clock",
    description: "Publish how busy a place is, from many travelers' reports.",
    precision: "aggregate",
    lawfulBasis: "legitimate_interest",
    retentionSeconds: null,
    retentionNote: "TTL'd per claim type from the freshness registry; swept by intelRetentionScheduler. Recomputable, so deleting one destroys nothing.",
    visibility: "Public ONLY when the privacy gate passes (>=15 distinct actors, >=5 groups, <=20% single-group share, 10-minute delay). privacy_eligible defaults false.",
    deletionBehavior: "Not per-person data; recomputed from surviving observations after an erasure.",
    tables: ["intel_claims", "intel_state_snapshots"],
    requiresSeparateControl: false,
  },
];

/** Tables holding coordinates that are VENUE reference data, not personal location. */
export const REFERENCE_LOCATION_TABLES: readonly string[] = [
  "places", "discovery_places", "fsq_places", "canonical_locations", "place_profiles",
  "events", "layover_plan_stops", "trip_destinations", "trip_plan_items",
  "universal_stamp_catalog", "discovery_geocode_cache", "rent_buddy_route_stops",
  "rent_buddy_requests", "rent_buddy_waitlist", "airport_profiles", "geo_zones",
];

/** Every table any declared purpose touches. */
export function purposeTables(): Set<string> {
  const s = new Set<string>();
  for (const p of LOCATION_PURPOSES) for (const t of p.tables) s.add(t);
  return s;
}

/** Purposes retaining PRECISE location, which the ruling says to minimise. */
export function precisePurposes(): LocationPurpose[] {
  return LOCATION_PURPOSES.filter((p) => p.precision === "precise");
}

/**
 * A precise purpose is compliant only if its retention is bounded — either by a
 * clock (retentionSeconds) or explicitly by a session/incident, stated in the
 * note. An unbounded precise purpose with no stated bound is the thing the
 * ruling forbids.
 */
export function unboundedPrecisePurposes(): LocationPurpose[] {
  return precisePurposes().filter((p) => {
    if (p.retentionBound === "clock") return p.retentionSeconds === null; // clock with no number is unbounded
    if (p.retentionBound === "registry_clock") return false; // bounded, by freshness_policies
    if (p.retentionBound === "open_decision") return true; // undecided IS unbounded
    return false; // session and content_lifetime are real bounds
  });
}

/**
 * Purposes whose retention is explicitly UNDECIDED, at any precision.
 *
 * Kept separate from unboundedPrecisePurposes() on purpose. That function only
 * looks at precise purposes, so an "open_decision" bound on a derived or coarse
 * purpose — intel_claim is exactly that — was surfaced by no check at all. The
 * whole point of the open_decision bound is to make an unresolved policy VISIBLE;
 * a version of it that only shows up for one precision class is silent debt
 * wearing the label of a warning.
 */
/**
 * Open decisions that have been SEEN and accepted as outstanding. Same idiom as
 * deletionDispositions.UNCLASSIFIED_BACKLOG: known debt is allowed to exist, but
 * it cannot GROW without someone adding a line here. A new purpose that sets
 * open_decision without being listed fails the check.
 */
export const ACKNOWLEDGED_OPEN_DECISIONS: readonly string[] = [
  // Retention window for intelligence contributions — owner decision D6.
  "intel_claim",
];

export function undecidedRetentionPurposes(): LocationPurpose[] {
  return LOCATION_PURPOSES.filter((p) => p.retentionBound === "open_decision");
}
