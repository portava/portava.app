/**
 * Intelligence Gathering — Quick Signal contract (IG-03).
 *
 * Encodes spec §6 as DATA: the contextual prompts, their option lists, and the
 * OPTION -> canonical claim mapping, plus per-claim value validators for the
 * Phase-1 cut (§29 Included: crowd.level, crowd.trajectory, queue.wait,
 * access.walk_in) and for the four §22 map-contribution claim types added
 * alongside them (vibe.state, event.status, closure.state, crowd.direction —
 * see MAP_CONTRIBUTION_CLAIM_TYPES in lib/intelContracts and migration 2220).
 * The mobile Quick Signal composer presents the option lists;
 * the server maps a chosen option to a canonical claim_type + value here, so the
 * client never invents canonical vocabulary.
 *
 * RUNTIME EFFECT: NONE on its own. Pure declarations + pure functions. No client,
 * no environment, no route. IntelCaptureService consumes it behind the
 * `intel_capture_quick_signal` flag.
 *
 * Owner decision (§30 'Crowd labels', recommended default) is baked into the one
 * non-obvious mapping: the Arrival option "good energy" is the canonical
 * crowd_level `moderate` (the option copy is friendlier than the enum value).
 * unsafe_density is NEVER an ordinary Quick Signal option (§Appendix-A /
 * SPECIALIST_ONLY_CROWD_LEVELS) — the composer cannot emit it.
 */
import {
  CLOSURE_STATES,
  CROWD_DIRECTIONS,
  CROWD_LEVELS,
  CROWD_MIX_CATEGORIES,
  EVENT_STATUS_STATES,
  INVENTORY_STATUSES,
  MUSIC_GENRES,
  RESERVATION_STATES,
  SPECIALIST_ONLY_CROWD_LEVELS,
  TRAJECTORIES,
  TRANSIT_CONDITIONS,
  VIBE_STATES,
  type CrowdLevel,
  type MusicGenre,
  type Trajectory,
} from "./intelContracts.js";
import { mapTrailSignal, validateTrailClaimValue } from "./trailFollowup.js";

// ── Quick Signal contexts (§6) ───────────────────────────────────────────────
export const QUICK_SIGNAL_CONTEXTS = ["arrival", "inside", "entrance", "exit", "movement"] as const;
export type QuickSignalContext = (typeof QUICK_SIGNAL_CONTEXTS)[number];

/** The prompt copy + the option strings the composer shows for each context (§6). */
export const QUICK_SIGNAL_PROMPTS: Record<QuickSignalContext, { prompt: string; options: readonly string[] }> = {
  arrival:  { prompt: "How is it right now?", options: ["dead", "quiet", "good energy", "busy", "packed"] },
  inside:   { prompt: "What is changing?",    options: ["building", "stable", "peaking", "declining"] },
  entrance: { prompt: "How long is the line?", options: ["none", "<10", "10-20", "20-40", "40+"] },
  exit:     { prompt: "Why are you leaving?", options: ["planned", "declining", "too crowded", "denied", "slow", "unsafe", "better option"] },
  movement: { prompt: "Where next?",          options: [] }, // free destination selection; handled by IG-06 Trail follow-up.
};

// ── Venue-specific prompt sets (§6) — data for the composer, not claim logic ──
export const VENUE_PROMPTS: Record<string, { arrivalInside: readonly string[]; exitFollowup: readonly string[] }> = {
  nightlife:  { arrivalInside: ["energy", "line", "music", "crowd mix", "cover", "walk-in", "dress"], exitFollowup: ["worth it", "stayed", "why leave", "where next", "entry success"] },
  restaurant: { arrivalInside: ["wait", "tables", "sold-out items", "noise", "service pace"], exitFollowup: ["actual wait", "bill accuracy", "reservation need"] },
  event:      { arrivalInside: ["entry", "start status", "capacity", "schedule", "water/access"], exitFollowup: ["exit congestion", "transport", "after-event move"] },
  transit:    { arrivalInside: ["operational", "queue", "platform/pickup", "fare"], exitFollowup: ["actual journey", "delay", "correct entrance/exit"] },
  hotel:      { arrivalInside: ["check-in wait", "construction", "pool", "breakfast", "pickup"], exitFollowup: ["expectation match", "operational correction"] },
};

// ── OPTION -> canonical claim mapping (the load-bearing part) ─────────────────
export interface MappedClaim {
  claimType: string;
  value: Record<string, unknown>;
}

const ARRIVAL_TO_CROWD: Record<string, CrowdLevel> = {
  dead: "dead",
  quiet: "quiet",
  "good energy": "moderate",
  busy: "busy",
  packed: "packed",
};

const INSIDE_TO_TRAJECTORY: Record<string, Trajectory> = {
  building: "building",
  stable: "stable",
  peaking: "peaking",
  declining: "declining",
};

const ENTRANCE_TO_QUEUE: Record<string, { minMinutes: number; maxMinutes: number | null }> = {
  none:    { minMinutes: 0, maxMinutes: 0 },
  "<10":   { minMinutes: 0, maxMinutes: 10 },
  "10-20": { minMinutes: 10, maxMinutes: 20 },
  "20-40": { minMinutes: 20, maxMinutes: 40 },
  "40+":   { minMinutes: 40, maxMinutes: null },
};

/**
 * Map a (context, option) selection to a canonical claim_type + value.
 * Returns null for an unrecognised option — the caller rejects a null
 * (fail-closed), never invents a claim.
 *
 * This maps VOCABULARY only. Which capture SURFACE may store the mapped claim is
 * decided by IntelCaptureService's SURFACE_CLAIMS (quick_signal →
 * PHASE1_CAPTURE_CLAIM_TYPES below; trail → PHASE1_TRAIL_CAPTURE_CLAIM_TYPES in
 * lib/trailFollowup), so a mapping here never widens a surface on its own.
 */
export function mapQuickSignal(context: QuickSignalContext, option: string): MappedClaim | null {
  switch (context) {
    case "arrival": {
      const level = ARRIVAL_TO_CROWD[option];
      if (!level) return null;
      // Defence in depth: a specialist-only level can never arrive from this surface.
      if (SPECIALIST_ONLY_CROWD_LEVELS.includes(level)) return null;
      return { claimType: "crowd.level", value: { level } };
    }
    case "inside": {
      const trajectory = INSIDE_TO_TRAJECTORY[option];
      if (!trajectory) return null;
      return { claimType: "crowd.trajectory", value: { trajectory } };
    }
    case "entrance": {
      const wait = ENTRANCE_TO_QUEUE[option];
      if (!wait) return null;
      return { claimType: "queue.wait", value: { ...wait } };
    }
    // exit / movement are the IG-06 Trail follow-up contexts (§6 Exit /
    // Movement). ONE mapping owns them — lib/trailFollowup.mapTrailSignal — so
    // the route never has to know which module answers a context:
    //   movement → experience.next_move  (§4 registry, §13 going-next signal;
    //              TTL row in 2128; stored only on the `trail` surface)
    //   exit     → experience.exit_reason (§6 vocabulary, NOT a §4 claim; no
    //              TTL row; refused by every surface until contracted)
    // Before 2026-09-04 both returned null here, which is why the Trail sheet
    // was unreachable over HTTP.
    case "exit":
    case "movement":
      return mapTrailSignal(context, option);
    default:
      return null;
  }
}

// ── Per-claim value validators ───────────────────────────────────────────────
//
// VALIDATION REGISTRY vs CAPTURE SURFACE — these are now TWO different things.
//
// VALUE_VALIDATORS is the full §4 Table-6 validation registry: it says whether a
// value is well-formed for a claim type, independent of any surface. It is what
// validateClaimValue() consults, and it now covers every Phase-1 registry type so
// a direct-form {claimType,value} write or a correction is checked against the
// exact Table-5/6 value space — a value outside it is refused, never stored under
// a vocabulary nothing downstream can read.
//
// PHASE1_CAPTURE_CLAIM_TYPES (below) is the SMALLER, EXPLICIT list of what the
// `quick_signal` capture surface may actually STORE (IntelCaptureService
// SURFACE_CLAIMS.quick_signal). It is deliberately NOT Object.keys(VALUE_VALIDATORS)
// any more: deriving it that way would silently widen the surface every time a
// validator is added, and — the invariant #361 pinned — would let
// experience.next_move (trail-only) and every not-yet-producible family be stored
// on quick_signal. Membership there requires (a) a TTL + freshness_policies row
// (all Table-6 types have one, migration 2128) AND (b) a real no-free-text
// producer on this surface. §29 Included governs which families qualify.
//
// So a type can have a validator here yet not be capturable on quick_signal:
// access.reservation, access.dress, price.cover, crowd.mix, service.wait,
// inventory.status, transit.condition and experience.next_move all validate, but
// none is in PHASE1_CAPTURE_CLAIM_TYPES (see its docstring for why each is held).
type Validator = (v: unknown) => boolean;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const VALUE_VALIDATORS: Record<string, Validator> = {
  "crowd.level": (v) => isObj(v) && typeof v.level === "string" && (CROWD_LEVELS as readonly string[]).includes(v.level) && !SPECIALIST_ONLY_CROWD_LEVELS.includes(v.level as CrowdLevel),
  "crowd.trajectory": (v) => isObj(v) && typeof v.trajectory === "string" && (TRAJECTORIES as readonly string[]).includes(v.trajectory),
  "queue.wait": (v) =>
    isObj(v) &&
    typeof v.minMinutes === "number" && Number.isFinite(v.minMinutes) && v.minMinutes >= 0 &&
    (v.maxMinutes === null || (typeof v.maxMinutes === "number" && Number.isFinite(v.maxMinutes) && v.maxMinutes >= v.minMinutes)),
  "access.walk_in": (v) => isObj(v) && typeof v.accepted === "boolean",

  // ── §22 map-contribution claim types ───────────────────────────────────────
  // Each of these validates against the SAME array the client's liveTruth.ts
  // enumerates (both now import it from lib/intelContracts), so the round trip
  // is exact by construction: the server accepts precisely the options the
  // capture sheet can offer, and a value outside them is a refusal rather than
  // a row stored under a vocabulary nothing downstream can read.
  //
  // Each carries exactly ONE key, and the key names the fact. That matters for
  // crowd.direction in particular: `{ direction }` cannot be mistaken for
  // crowd.trajectory's `{ trajectory }` by a reader, a query, or a projection —
  // the two claims do not even share a value shape, so conflating them requires
  // a deliberate edit rather than a plausible-looking accident.
  "vibe.state": (v) => isObj(v) && typeof v.state === "string" && (VIBE_STATES as readonly string[]).includes(v.state),
  "event.status": (v) => isObj(v) && typeof v.status === "string" && (EVENT_STATUS_STATES as readonly string[]).includes(v.status),
  "closure.state": (v) => isObj(v) && typeof v.state === "string" && (CLOSURE_STATES as readonly string[]).includes(v.state),
  "crowd.direction": (v) => isObj(v) && typeof v.direction === "string" && (CROWD_DIRECTIONS as readonly string[]).includes(v.direction),

  // ── Remaining §4 Table-6 registry types (validation only; see header) ───────
  // access.reservation (Table 6: required/recommended/not_needed/unknown).
  "access.reservation": (v) =>
    isObj(v) && typeof v.reservation === "string" && (RESERVATION_STATES as readonly string[]).includes(v.reservation),
  // access.dress (Table 6: "policy + enforced boolean + qualifiers"). policy is a
  // bounded label and qualifiers an optional bounded string array — this family is
  // validator-only (not on the composer surface), so the "no free text" composer
  // rule does not apply; the shape is the spec's literal one.
  "access.dress": (v) =>
    isObj(v) &&
    typeof v.policy === "string" && v.policy.length > 0 && v.policy.length <= 60 &&
    typeof v.enforced === "boolean" &&
    (v.qualifiers === undefined ||
      (Array.isArray(v.qualifiers) &&
        v.qualifiers.length <= 8 &&
        v.qualifiers.every((q) => typeof q === "string" && q.length > 0 && q.length <= 40))),
  // price.cover (Table 6: "amount, currency, access_type"). amount ≥ 0, currency a
  // 3-letter ISO-4217-shaped code, accessType a bounded label (e.g. general/vip).
  "price.cover": (v) =>
    isObj(v) &&
    typeof v.amount === "number" && Number.isFinite(v.amount) && v.amount >= 0 &&
    typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) &&
    typeof v.accessType === "string" && v.accessType.length > 0 && v.accessType.length <= 40,
  // crowd.mix (Table 6: "local/traveler/expat/mixed distribution bands"). Phase-1
  // stores the dominant composition as one controlled descriptor — no identity
  // inference, only the room's overall read.
  "crowd.mix": (v) =>
    isObj(v) && typeof v.mix === "string" && (CROWD_MIX_CATEGORIES as readonly string[]).includes(v.mix),
  // music.current (Table 6: "controlled genre set + confidence … copyright-safe
  // metadata only"). genre from the closed vocabulary; optional confidence 0..1.
  // NEVER a track/artist/lyric — the value has no free-text field.
  "music.current": (v) =>
    isObj(v) &&
    typeof v.genre === "string" && (MUSIC_GENRES as readonly string[]).includes(v.genre) &&
    (v.confidence === undefined ||
      (typeof v.confidence === "number" && Number.isFinite(v.confidence) && v.confidence >= 0 && v.confidence <= 1)),
  // inventory.status (Table 6: "item/service + available/limited/sold_out").
  "inventory.status": (v) =>
    isObj(v) &&
    typeof v.item === "string" && v.item.length > 0 && v.item.length <= 80 &&
    typeof v.status === "string" && (INVENTORY_STATUSES as readonly string[]).includes(v.status),
  // service.wait (Table 6: "service_type + min/max minutes"). Same minute contract
  // as queue.wait; maxMinutes null means open-ended.
  "service.wait": (v) =>
    isObj(v) &&
    typeof v.serviceType === "string" && v.serviceType.length > 0 && v.serviceType.length <= 40 &&
    typeof v.minMinutes === "number" && Number.isFinite(v.minMinutes) && v.minMinutes >= 0 &&
    (v.maxMinutes === null || (typeof v.maxMinutes === "number" && Number.isFinite(v.maxMinutes) && v.maxMinutes >= v.minMinutes)),
  // transit.condition (Table 6: "route/mode + normal/delayed/disrupted/closed").
  "transit.condition": (v) =>
    isObj(v) &&
    typeof v.routeOrMode === "string" && v.routeOrMode.length > 0 && v.routeOrMode.length <= 80 &&
    typeof v.condition === "string" && (TRANSIT_CONDITIONS as readonly string[]).includes(v.condition),
  // experience.next_move — the ONE mapping owner is lib/trailFollowup (it is the
  // trail surface's claim), so delegate to its validator rather than restate the
  // value space. Present here purely for registry completeness; it is NOT in
  // PHASE1_CAPTURE_CLAIM_TYPES, so the quick_signal surface still refuses it and
  // #361's "surfaces cannot emit each other's claims" invariant holds.
  "experience.next_move": (v) => validateTrailClaimValue("experience.next_move", v),
};

/** The controlled music genres a Quick Signal may carry, as canonical strings. */
export const MUSIC_GENRE_OPTIONS: readonly MusicGenre[] = MUSIC_GENRES;

/** True iff value_json is well-formed for this claim_type in the Phase-1 cut. */
export function validateClaimValue(claimType: string, value: unknown): boolean {
  const validator = VALUE_VALIDATORS[claimType];
  return validator ? validator(value) : false;
}

/**
 * The claim types the `quick_signal` capture surface may STORE
 * (IntelCaptureService SURFACE_CLAIMS.quick_signal). EXPLICIT, not derived from
 * VALUE_VALIDATORS — see the validators' header for why.
 *
 * Two things gate membership: §29 Included, and a real no-free-text producer on
 * this surface. Every entry has both:
 *   crowd.level, crowd.trajectory, queue.wait, access.walk_in
 *     — the §6 composer contexts (mapQuickSignal) and the §22 map sheet.
 *   music.current
 *     — §29 Included ("Nightlife … music.current"); produced by the composer's
 *       controlled genre picker as a direct-form claim (no free text).
 *   vibe.state, event.status, closure.state, crowd.direction
 *     — the §22 map-contribution types, produced by routes/mapObservations.ts.
 *
 * DELIBERATELY ABSENT (validator exists, no surface entry):
 *   experience.next_move — trail-only (PHASE1_TRAIL_CAPTURE_CLAIM_TYPES); listing
 *     it here would break #361's surface-isolation invariant.
 *   access.reservation, access.dress, price.cover, crowd.mix — §4 registry, not in
 *     the §29 Phase-1 cut; no composer producer yet.
 *   service.wait, inventory.status — §29 names "Restaurant wait and availability",
 *     but their Table-6 value spaces need a free-form service_type / menu-item
 *     string, which the "no free text" capture rule forbids. They wait for a
 *     controlled service-type / menu vocabulary (owner ruling) before the surface
 *     may offer them; until then only direct-form callers could reach them, and
 *     they are held off the surface rather than shipped without a safe producer.
 *
 * A value here must ALSO have a VALUE_VALIDATORS entry (guaranteed by the
 * intelContracts.test.ts pin) so nothing storable is unvalidated.
 */
export const PHASE1_CAPTURE_CLAIM_TYPES: readonly string[] = [
  "crowd.level",
  "crowd.trajectory",
  "queue.wait",
  "access.walk_in",
  "music.current",
  "vibe.state",
  "event.status",
  "closure.state",
  "crowd.direction",
];
