/**
 * The twelve canonical certification fixtures.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 "Canonical certification fixtures" (:643-655). The twelve names
 *       below are that list, verbatim and in the spec's order, and
 *       `certificationFixtures.test.ts` asserts the two lists are equal so a
 *       renamed or dropped fixture cannot pass unnoticed.
 *
 * CENSUS: H224-H235, all NOT-BUILT before this file
 *         (docs/architecture/census-highlights-memories.md §B).
 *
 * WHAT A FIXTURE IS FOR, AND THE FAILURE IT IS BUILT AGAINST
 * =========================================================
 * A fixture that only contains the thing under test proves nothing: a gate that
 * says "no" to everything passes every rejection fixture ever written. So every
 * fixture whose point is a REFUSAL carries a paired positive control inside the
 * same world — the same shape with the one field that should change the answer
 * changed. `WALK_PAST_NOT_VISIT` contains a genuine visit at the same venue on
 * the same day; `SCREENSHOT_NOT_EXPERIENCED` contains a camera capture; the
 * eligibility invariant asserts both answers, not one.
 *
 * The second failure these are built against is a fixture that drifts into
 * agreement with the implementation. Every fixture is DATA — no calls into the
 * modules under certification appear in this file — so a change to an engine
 * cannot quietly change what it is being tested with.
 */

import {
  CERT_BLOCKED,
  CERT_CREW_MATE,
  CERT_OWNER,
  CERT_STRANGER,
  CERT_TRIP,
  certHighlight,
  certMemory,
  certWorld,
  type CertificationWorld,
} from "./world.js";

/** §25's twelve fixture names, in spec order. */
export const CERTIFICATION_FIXTURE_IDS = [
  "SOLO_TRIP_EXPLICIT_REMEMBER",
  "CREW_TRIP_SHARED_AND_PRIVATE",
  "LATE_MEDIA_UPLOAD",
  "INCORRECT_GPS_PLACE_CORRECTION",
  "MERGE_THEN_SPLIT",
  "BLOCKED_PARTICIPANT_AFTER_SHARED",
  "PUBLIC_TO_PRIVATE_REVOCATION",
  "DELETE_WITH_DERIVATIVES",
  "IMPORTED_HISTORICAL_TRIP",
  "NO_PHOTO_VOICE_NOTE_PLAN",
  "WALK_PAST_NOT_VISIT",
  "SCREENSHOT_NOT_EXPERIENCED",
] as const;
export type CertificationFixtureId = (typeof CERTIFICATION_FIXTURE_IDS)[number];

export interface CertificationFixture {
  readonly id: CertificationFixtureId;
  /** The census requirement this fixture IS. */
  readonly census_id: string;
  /** Line in the spec .txt where §25 names it. */
  readonly spec_line: number;
  /** The spec's own words. */
  readonly spec_text: string;
  /** What the world models, in one sentence, for a report reader. */
  readonly summary: string;
  readonly world: CertificationWorld;
}

const M = {
  soloA: "m0000000-0000-4000-8000-00000000a001",
  soloB: "m0000000-0000-4000-8000-00000000a002",
  crewShared: "m0000000-0000-4000-8000-00000000b001",
  crewPrivate: "m0000000-0000-4000-8000-00000000b002",
  late: "m0000000-0000-4000-8000-00000000c001",
  gps: "m0000000-0000-4000-8000-00000000d001",
  mergeA: "m0000000-0000-4000-8000-00000000e001",
  mergeB: "m0000000-0000-4000-8000-00000000e002",
  blocked: "m0000000-0000-4000-8000-00000000f001",
  published: "m0000000-0000-4000-8000-000000010001",
  deleted: "m0000000-0000-4000-8000-000000011001",
  survivor: "m0000000-0000-4000-8000-000000011002",
  imported: "m0000000-0000-4000-8000-000000012001",
  voice: "m0000000-0000-4000-8000-000000013001",
  walkPast: "m0000000-0000-4000-8000-000000014001",
  realVisit: "m0000000-0000-4000-8000-000000014002",
  screenshot: "m0000000-0000-4000-8000-000000015001",
} as const;

export const MEMORY_IDS = M;

const H = {
  precise: "h0000000-0000-4000-8000-000000020001",
  unpoliced: "h0000000-0000-4000-8000-000000020002",
} as const;

export const HIGHLIGHT_IDS = H;

const FIXTURES: readonly CertificationFixture[] = Object.freeze([
  {
    id: "SOLO_TRIP_EXPLICIT_REMEMBER",
    census_id: "H224",
    spec_line: 644,
    spec_text: "Solo Trip with photos and explicit Remember action.",
    summary:
      "One traveller, one trip, two camera captures and an explicit Remember. The strongest evidence shape there is: it must be eligible, and it must be eligible for the RIGHT reason.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.soloA, trip_id: CERT_TRIP, visibility: "public", state: "published",
          title: "Ferry across the strait", place_id: "place-ferry",
          location_city: "Split", location_country: "Croatia",
          starts_at: "2026-04-02T09:00:00.000Z", location_lat: 43.508, location_lng: 16.44,
        }),
        certMemory({
          id: M.soloB, trip_id: CERT_TRIP, visibility: "only_me", state: "published",
          title: "The notebook entry", starts_at: "2026-04-02T21:00:00.000Z",
        }),
      ],
      items: [
        { memory_id: M.soloA, media_url: "https://cdn.example/ferry-1.jpg", media_type: "image", position: 0 },
        { memory_id: M.soloA, media_url: "https://cdn.example/ferry-2.jpg", media_type: "image", position: 1 },
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "EXPLICIT_REMEMBER", source_id: "remember-solo-1",
          assertion_type: "OCCURRED", observed_at: "2026-04-02T09:05:00.000Z",
          assertion_json: { place_id: "place-ferry" },
        },
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-ferry-1",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-02T09:12:00.000Z",
          assertion_json: { place_id: "place-ferry", capture_provenance: "camera" },
        },
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-ferry-2",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-02T09:41:00.000Z",
          assertion_json: { place_id: "place-ferry", capture_provenance: "camera" },
        },
      ],
    }),
  },
  {
    id: "CREW_TRIP_SHARED_AND_PRIVATE",
    census_id: "H225",
    spec_line: 645,
    spec_text: "Crew Trip with shared and private assets.",
    summary:
      "Two Memories on one trip: one the crew may read, one the owner keeps. The crew mate's approved tag is what makes the shared one shared; it confers no ownership (§10, H83).",
    world: certWorld({
      viewer_id: CERT_CREW_MATE,
      memories: [
        certMemory({
          id: M.crewShared, trip_id: CERT_TRIP, visibility: "trip_crew", state: "published",
          title: "The long table", place_id: "place-taverna",
          location_city: "Hvar", location_country: "Croatia",
          starts_at: "2026-04-04T18:00:00.000Z",
        }),
        certMemory({
          id: M.crewPrivate, trip_id: CERT_TRIP, visibility: "only_me", state: "published",
          title: "What I actually thought of it", starts_at: "2026-04-04T23:30:00.000Z",
        }),
      ],
      tags: [
        { memory_id: M.crewShared, tagged_user_id: CERT_CREW_MATE, status: "approved" },
        { memory_id: M.crewPrivate, tagged_user_id: CERT_CREW_MATE, status: "pending" },
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CREW_OVERLAP", source_id: "crew-1",
          assertion_type: "CO_PRESENT", observed_at: "2026-04-04T18:20:00.000Z",
          assertion_json: { place_id: "place-taverna", person_id: CERT_CREW_MATE },
        },
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-taverna",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-04T18:25:00.000Z",
          assertion_json: { place_id: "place-taverna", capture_provenance: "camera" },
        },
      ],
    }),
  },
  {
    id: "LATE_MEDIA_UPLOAD",
    census_id: "H226",
    spec_line: 646,
    spec_text: "Late media upload after Trip ends.",
    summary:
      "A photo taken during the trip arrives six days after it ended. §19: the Memory exists before the media; the late arrival must attach to the occurrence time, never to the upload time.",
    world: certWorld({
      now: "2026-04-16T00:00:00.000Z",
      memories: [
        certMemory({
          id: M.late, trip_id: CERT_TRIP, visibility: "public", state: "published",
          title: "Last morning", place_id: "place-harbour",
          location_city: "Split", location_country: "Croatia",
          starts_at: "2026-04-08T07:00:00.000Z", ends_at: "2026-04-08T09:00:00.000Z",
          created_at: "2026-04-08T07:30:00.000Z", updated_at: "2026-04-14T11:00:00.000Z",
        }),
      ],
      items: [
        { memory_id: M.late, media_url: "https://cdn.example/harbour-late.jpg", media_type: "image", position: 0 },
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-harbour-late",
          // Captured on the trip; uploaded on the 14th. observed_at is the CAPTURE.
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-08T07:41:00.000Z",
          assertion_json: { place_id: "place-harbour", capture_provenance: "camera", uploaded_at: "2026-04-14T11:00:00.000Z" },
        },
      ],
    }),
  },
  {
    id: "INCORRECT_GPS_PLACE_CORRECTION",
    census_id: "H227",
    spec_line: 647,
    spec_text: "Incorrect GPS and explicit place correction.",
    summary:
      "GPS put the Memory at the wrong venue and the owner corrected it. §4's precedence: the correction outranks the inference no matter which arrived later or scored higher.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.gps, visibility: "public", state: "published", title: "Coffee, eventually",
          place_id: "place-correct-cafe", canonical_location_id: "canon-correct-cafe",
          location_city: "Lisbon", location_country: "Portugal",
          starts_at: "2026-03-11T10:00:00.000Z",
        }),
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "GPS_PROXIMITY", source_id: "gps-wrong",
          assertion_type: "OCCURRED", observed_at: "2026-03-11T10:05:00.000Z",
          confidence: 0.35,
          assertion_json: { place_id: "place-wrong-cafe", dwell_seconds: 2400 },
        },
        {
          owner_id: CERT_OWNER, source_type: "USER_CORRECTION", source_id: "correction-1",
          assertion_type: "CORRECTION", observed_at: "2026-03-11T18:00:00.000Z",
          // DELIBERATELY the lowest confidence in the fixture. §4 orders by
          // PRECEDENCE, not by score, and a correction that only won because it
          // scored highest would prove the wrong rule.
          confidence: 0.5,
          assertion_json: { place_id: "place-correct-cafe", corrects: "place-wrong-cafe" },
        },
        {
          // A later, higher-confidence inference that must NOT win.
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-ambiguous",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-03-12T08:00:00.000Z",
          confidence: 0.7,
          assertion_json: { place_id: "place-wrong-cafe", capture_provenance: "camera" },
        },
      ],
    }),
  },
  {
    id: "MERGE_THEN_SPLIT",
    census_id: "H228",
    spec_line: 648,
    spec_text: "Merge two Memories then split differently.",
    summary:
      "Two Memories of one afternoon that a detector would group, then a boundary the owner draws elsewhere. The world exists; the MERGE_MEMORY and SPLIT_MEMORY commands do not, and the invariant that needs them says so rather than passing.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.mergeA, visibility: "public", state: "published", title: "Market, first pass",
          place_id: "place-market", location_city: "Porto", location_country: "Portugal",
          location_lat: 41.147, location_lng: -8.61,
          starts_at: "2026-02-20T11:00:00.000Z",
        }),
        certMemory({
          id: M.mergeB, visibility: "public", state: "published", title: "Market, second pass",
          place_id: "place-market", location_city: "Porto", location_country: "Portugal",
          location_lat: 41.148, location_lng: -8.611,
          starts_at: "2026-02-20T11:40:00.000Z",
        }),
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-market-1",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-02-20T11:05:00.000Z",
          assertion_json: { place_id: "place-market", capture_provenance: "camera", lat: 41.147, lng: -8.61 },
        },
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-market-2",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-02-20T11:44:00.000Z",
          assertion_json: { place_id: "place-market", capture_provenance: "camera", lat: 41.148, lng: -8.611 },
        },
      ],
    }),
  },
  {
    id: "BLOCKED_PARTICIPANT_AFTER_SHARED",
    census_id: "H229",
    spec_line: 649,
    spec_text: "Blocked participant after shared experience.",
    summary:
      "A shared Memory whose participant the owner has since blocked. The history is real and stays; §10 forbids only NEW social resurfacing through it.",
    world: certWorld({
      viewer_id: CERT_BLOCKED,
      memories: [
        certMemory({
          id: M.blocked, visibility: "public", state: "published", title: "The night bus",
          place_id: "place-station", location_city: "Belgrade", location_country: "Serbia",
          starts_at: "2026-01-18T22:00:00.000Z",
        }),
      ],
      tags: [{ memory_id: M.blocked, tagged_user_id: CERT_BLOCKED, status: "approved" }],
      blocks: [[CERT_OWNER, CERT_BLOCKED]],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CREW_OVERLAP", source_id: "crew-blocked",
          assertion_type: "CO_PRESENT", observed_at: "2026-01-18T22:10:00.000Z",
          assertion_json: { person_id: CERT_BLOCKED, place_id: "place-station" },
        },
      ],
    }),
  },
  {
    id: "PUBLIC_TO_PRIVATE_REVOCATION",
    census_id: "H230",
    spec_line: 650,
    spec_text: "Public-to-private revocation.",
    summary:
      "A Memory that was public, is registered in a public derivative, and has just been made private. §21: the derivative must be revoked, not merely rebuilt smaller.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.published, visibility: "public", state: "published", title: "The rooftop",
          caption: "the one everyone asks about", place_id: "place-roof",
          location_city: "Bangkok", location_country: "Thailand",
          starts_at: "2026-03-02T17:00:00.000Z",
        }),
      ],
      items: [{ memory_id: M.published, media_url: "https://cdn.example/roof.jpg", media_type: "image", position: 0 }],
    }),
  },
  {
    id: "DELETE_WITH_DERIVATIVES",
    census_id: "H231",
    spec_line: 651,
    spec_text: "Memory deletion with embeddings and Highlight derivatives.",
    summary:
      "Two public Memories, one of which is about to be deleted. The cleanup graph must revoke exactly the derivatives that carried it and leave the survivor's alone.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.deleted, visibility: "public", state: "published", title: "Doomed",
          place_id: "place-doomed", location_city: "Osaka", location_country: "Japan",
          starts_at: "2026-02-01T10:00:00.000Z",
        }),
        certMemory({
          id: M.survivor, visibility: "public", state: "published", title: "Survivor",
          place_id: "place-survivor", location_city: "Osaka", location_country: "Japan",
          starts_at: "2026-02-02T10:00:00.000Z",
        }),
      ],
    }),
  },
  {
    id: "IMPORTED_HISTORICAL_TRIP",
    census_id: "H232",
    spec_line: 652,
    spec_text: "Imported historical trip with weak metadata.",
    summary:
      "A backfilled trip: media with no capture provenance, no place id, a year-old timestamp. §22 forbids fabricating what the import does not carry.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.imported, visibility: "only_me", state: "published", title: "Somewhere in 2019",
          place_id: null, canonical_location_id: null, location_city: null, location_country: null,
          starts_at: "2019-07-14T00:00:00.000Z", created_at: "2026-05-20T09:00:00.000Z",
        }),
      ],
      items: [{ memory_id: M.imported, media_url: "https://cdn.example/scan-01.jpg", media_type: "image", position: 0 }],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "import-scan-01",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2019-07-14T00:00:00.000Z",
          assertion_json: { capture_provenance: "imported_without_capture" },
        },
      ],
    }),
  },
  {
    id: "NO_PHOTO_VOICE_NOTE_PLAN",
    census_id: "H233",
    spec_line: 653,
    spec_text: "No-photo Memory from voice note + completed plan.",
    summary:
      "No media at all: a completed plan plus the owner's own note. Two independent sources, neither of them a photo — the case a media-shaped pipeline drops.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.voice, visibility: "only_me", state: "published",
          title: "Talked it through on the walk back", place_id: "place-park",
          starts_at: "2026-05-06T19:00:00.000Z",
        }),
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "TRIP_OUTCOME", source_id: "plan-completed-1",
          assertion_type: "OCCURRED", observed_at: "2026-05-06T19:30:00.000Z",
          assertion_json: { place_id: "place-park", plan_id: "plan-1" },
        },
        {
          owner_id: CERT_OWNER, source_type: "EXPLICIT_REMEMBER", source_id: "voice-note-1",
          assertion_type: "OCCURRED", observed_at: "2026-05-06T19:35:00.000Z",
          assertion_json: { place_id: "place-park", medium: "voice_note" },
        },
      ],
    }),
  },
  {
    id: "WALK_PAST_NOT_VISIT",
    census_id: "H234",
    spec_line: 654,
    spec_text: "Walk-past venue that must not become a visit.",
    summary:
      "Ninety seconds of GPS proximity and nothing else. Paired with a genuine two-hour visit to the SAME venue so a blanket-reject gate fails this fixture too.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.realVisit, visibility: "public", state: "published", title: "Actually went in",
          place_id: "place-gallery", starts_at: "2026-05-09T14:00:00.000Z",
        }),
        certMemory({
          id: M.walkPast, visibility: "only_me", state: "draft", title: "(candidate) walked past",
          place_id: "place-gallery", starts_at: "2026-05-09T09:00:00.000Z",
        }),
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "GPS_PROXIMITY", source_id: "gps-walkpast",
          assertion_type: "NEARBY", observed_at: "2026-05-09T09:00:00.000Z",
          assertion_json: { place_id: "place-gallery", dwell_seconds: 90 },
        },
        {
          owner_id: CERT_OWNER, source_type: "EVENT_TICKET_CHECKIN", source_id: "ticket-gallery",
          assertion_type: "OCCURRED", observed_at: "2026-05-09T14:00:00.000Z",
          assertion_json: { place_id: "place-gallery", event_id: "event-gallery" },
        },
      ],
    }),
  },
  {
    id: "SCREENSHOT_NOT_EXPERIENCED",
    census_id: "H235",
    spec_line: 655,
    spec_text: "Downloaded screenshot that must not become experienced content.",
    summary:
      "A screenshot saved from someone else's post. Its paired control is the SAME signal with capture_provenance 'camera', so the gate has to read provenance rather than count media.",
    world: certWorld({
      memories: [
        certMemory({
          id: M.screenshot, visibility: "only_me", state: "draft", title: "(candidate) saved image",
          place_id: "place-viewpoint", starts_at: "2026-05-12T08:00:00.000Z",
        }),
      ],
      items: [
        { memory_id: M.screenshot, media_url: "https://cdn.example/saved-shot.png", media_type: "image", position: 0 },
      ],
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "screenshot-1",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-05-12T08:00:00.000Z",
          assertion_json: { place_id: "place-viewpoint", capture_provenance: "screenshot" },
        },
      ],
    }),
  },
]);

/**
 * The Highlight world the §10 precision invariant runs against. It is separate
 * from the twelve because §25's fixture list is about Memories and adding a
 * thirteenth entry to that list would misreport the spec.
 */
export const HIGHLIGHT_PRECISION_WORLD: CertificationWorld = certWorld({
  viewer_id: CERT_STRANGER,
  highlights: [
    certHighlight({
      id: H.precise, location_name: "Bar Alimentari", location_city: "Bologna", location_country: "Italy",
    }),
    certHighlight({
      id: H.unpoliced, location_name: "Hotel Duse", location_city: "Bologna", location_country: "Italy",
    }),
  ],
  // Only the first Highlight has an owner-selected rung. The second models the
  // deployment reality: migration 2721 is unapplied, so no rung is stored.
  highlight_precision: { [H.precise]: "CITY" },
});

/**
 * What each fixture must produce when the real engines are run over it.
 *
 * These are DERIVED FROM THE SPEC, not from a run. Every number below was
 * argued from §6's gate order, §7's thresholds and §18's builders before the
 * runner was executed once, which is the only way an expectation can catch an
 * engine change rather than record one. A fixture whose expectation was copied
 * out of last night's output asserts that nothing changed, which is a different
 * and much weaker claim.
 */
export interface FixtureExpectation {
  /**
   * The §6 verdict over ALL of the fixture's signals in AUTOMATIC mode, or null
   * when the fixture deliberately carries no evidence (it certifies a
   * derivative, not the gate).
   */
  readonly eligibility: { readonly eligible: boolean; readonly reason: string | null } | null;
  /** How many episodes §7 must find over the fixture's signals. */
  readonly episodes: number;
  /** Exactly the memory ids PublicMemoryProjection must carry, sorted. */
  readonly public_projection_memory_ids: readonly string[];
  /**
   * A one-field variation that must flip the verdict. Without it a refusal
   * fixture cannot tell a correct gate from a gate that refuses everything.
   */
  readonly paired_control?: {
    readonly description: string;
    readonly signals: readonly CertificationFixture["world"]["signals"][number][];
    readonly expect_eligible: boolean;
  };
  /** Why the numbers above are what they are, for a reader of the report. */
  readonly rationale: string;
}

export const FIXTURE_EXPECTATIONS: Readonly<Record<CertificationFixtureId, FixtureExpectation>> = Object.freeze({
  SOLO_TRIP_EXPLICIT_REMEMBER: {
    eligibility: { eligible: true, reason: null },
    episodes: 1,
    public_projection_memory_ids: [M.soloA],
    rationale:
      "An EXPLICIT_REMEMBER and two camera captures within 36 minutes: §6's gate finds an occurrence-bearing source so nothing trips, and §7's 180-minute floor is nowhere near a 36-minute span. Only the public Memory reaches a public derivative.",
  },
  CREW_TRIP_SHARED_AND_PRIVATE: {
    eligibility: { eligible: true, reason: null },
    episodes: 1,
    public_projection_memory_ids: [],
    rationale:
      "CREW_OVERLAP cannot prove occurrence alone, but the camera capture five minutes later can, so the pair is eligible. Neither Memory is public — trip_crew and only_me — so the public derivative is EMPTY, which is the half of this fixture that matters.",
    paired_control: {
      description: "the crew overlap ALONE, with the capture removed",
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CREW_OVERLAP", source_id: "crew-1",
          assertion_type: "CO_PRESENT", observed_at: "2026-04-04T18:20:00.000Z",
          assertion_json: { place_id: "place-taverna", person_id: CERT_CREW_MATE },
        },
      ],
      expect_eligible: false,
    },
  },
  LATE_MEDIA_UPLOAD: {
    eligibility: { eligible: true, reason: null },
    episodes: 1,
    public_projection_memory_ids: [M.late],
    rationale:
      "One camera capture, observed_at set to the CAPTURE instant during the trip rather than the upload six days later. Eligible, one episode, and the public row's occurred_at follows starts_at, not created_at.",
  },
  INCORRECT_GPS_PLACE_CORRECTION: {
    eligibility: { eligible: true, reason: null },
    episodes: 3,
    public_projection_memory_ids: [M.gps],
    rationale:
      "The USER_CORRECTION proves occurrence alone, so the gate passes. §7 splits twice: 10:05 -> 18:00 is 475 minutes and 18:00 -> next-day 08:00 is 840, both past the 180-minute floor, so three episodes. The correction's precedence is asserted by the H242 invariant, not here.",
  },
  MERGE_THEN_SPLIT: {
    eligibility: { eligible: true, reason: null },
    episodes: 1,
    public_projection_memory_ids: [M.mergeA, M.mergeB].sort(),
    rationale:
      "Two captures 39 minutes apart, 100 metres apart, at one market: under §7's thresholds that is ONE episode — which is exactly why this fixture is the one a merge/split test needs. Both Memories are public.",
  },
  BLOCKED_PARTICIPANT_AFTER_SHARED: {
    eligibility: { eligible: false, reason: "INSUFFICIENT_OCCURRENCE_EVIDENCE" },
    episodes: 1,
    public_projection_memory_ids: [M.blocked],
    rationale:
      "CREW_OVERLAP is social context, not occurrence (§6: `social_context_only`), and one weak source cannot clear the corroboration floor — so being near someone is not by itself a Memory. The Memory that DOES exist is public and stays: §10 forbids new resurfacing through a blocked participant, not the history.",
    paired_control: {
      description: "the same overlap plus a camera capture at the venue",
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CREW_OVERLAP", source_id: "crew-blocked",
          assertion_type: "CO_PRESENT", observed_at: "2026-01-18T22:10:00.000Z",
          assertion_json: { person_id: CERT_BLOCKED, place_id: "place-station" },
        },
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "media-station",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-01-18T22:12:00.000Z",
          assertion_json: { place_id: "place-station", capture_provenance: "camera" },
        },
      ],
      expect_eligible: true,
    },
  },
  PUBLIC_TO_PRIVATE_REVOCATION: {
    eligibility: null,
    episodes: 0,
    public_projection_memory_ids: [M.published],
    rationale:
      "Carries no §6 evidence on purpose: what it certifies is the derivative and its revocation, which is a §18/§21 property and not a candidate-generation one.",
  },
  DELETE_WITH_DERIVATIVES: {
    eligibility: null,
    episodes: 0,
    public_projection_memory_ids: [M.deleted, M.survivor].sort(),
    rationale:
      "Two public Memories and no evidence: the point is that the cleanup graph revokes exactly the registration carrying the deleted one and leaves the survivor's alone.",
  },
  IMPORTED_HISTORICAL_TRIP: {
    eligibility: { eligible: false, reason: "MEDIA_NOT_CAPTURED" },
    episodes: 1,
    public_projection_memory_ids: [],
    rationale:
      "A scan with capture_provenance `imported_without_capture` and nothing else attesting occurrence: §22 forbids a backfill fabricating a visit, and §6's MEDIA_NOT_CAPTURED is where that is enforced. The Memory is only_me, so no public derivative carries it.",
    paired_control: {
      description: "the same import re-declared as a genuine camera capture",
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "import-scan-01",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2019-07-14T00:00:00.000Z",
          assertion_json: { capture_provenance: "camera" },
        },
      ],
      expect_eligible: true,
    },
  },
  NO_PHOTO_VOICE_NOTE_PLAN: {
    eligibility: { eligible: true, reason: null },
    episodes: 1,
    public_projection_memory_ids: [],
    rationale:
      "No media at all. A completed TRIP_OUTCOME and an EXPLICIT_REMEMBER five minutes apart both prove occurrence alone, so the gate passes without a photo — the case a media-shaped pipeline would drop.",
  },
  WALK_PAST_NOT_VISIT: {
    eligibility: { eligible: true, reason: null },
    episodes: 2,
    public_projection_memory_ids: [M.realVisit],
    rationale:
      "Taken as a whole the day contains a genuine ticketed visit, so the fixture is ELIGIBLE — the positive control. Its paired control is the 90-second proximity alone, which must be refused with PASS_BY_NOT_VISIT. Two episodes: five hours apart and either side of an event commitment.",
    paired_control: {
      description: "the 90-second proximity alone",
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "GPS_PROXIMITY", source_id: "gps-walkpast",
          assertion_type: "NEARBY", observed_at: "2026-05-09T09:00:00.000Z",
          assertion_json: { place_id: "place-gallery", dwell_seconds: 90 },
        },
      ],
      expect_eligible: false,
    },
  },
  SCREENSHOT_NOT_EXPERIENCED: {
    eligibility: { eligible: false, reason: "MEDIA_NOT_CAPTURED" },
    episodes: 1,
    public_projection_memory_ids: [],
    rationale:
      "One image whose provenance is `screenshot`. §25 names this exactly: a downloaded screenshot must not become experienced content. The paired control is the same signal with provenance `camera`, which must be eligible — so the gate is reading provenance and not counting media.",
    paired_control: {
      description: "the same image re-declared as a camera capture",
      signals: [
        {
          owner_id: CERT_OWNER, source_type: "CAMERA_CAPTURE", source_id: "screenshot-1",
          assertion_type: "CAPTURED_MEDIA", observed_at: "2026-05-12T08:00:00.000Z",
          assertion_json: { place_id: "place-viewpoint", capture_provenance: "camera" },
        },
      ],
      expect_eligible: true,
    },
  },
});

export function listFixtures(): readonly CertificationFixture[] {
  return FIXTURES;
}

export function getFixture(id: CertificationFixtureId): CertificationFixture {
  const found = FIXTURES.find((f) => f.id === id);
  if (!found) throw new Error(`unknown certification fixture: ${id}`);
  return found;
}
