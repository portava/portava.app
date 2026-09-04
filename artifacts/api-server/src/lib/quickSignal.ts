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
  EVENT_STATUS_STATES,
  SPECIALIST_ONLY_CROWD_LEVELS,
  TRAJECTORIES,
  VIBE_STATES,
  type CrowdLevel,
  type Trajectory,
} from "./intelContracts.js";

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
 * Returns null for an option that is not in the Phase-1 cut or is unrecognised —
 * the caller rejects a null (fail-closed), never invents a claim.
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
    // exit / movement feed IG-06 Trail follow-up, not the Phase-1 capture cut.
    default:
      return null;
  }
}

// ── Per-claim value validators ───────────────────────────────────────────────
//
// This registry is load-bearing twice over: it validates a value AND, through
// PHASE1_CAPTURE_CLAIM_TYPES below, it DEFINES which claim types the
// `quick_signal` capture surface may emit at all (IntelCaptureService's
// SURFACE_CLAIMS). Adding an entry therefore widens the surface, so an entry is
// only added once the claim type has a TTL in lib/intelContracts and a
// freshness_policies row in a migration — otherwise the capture would succeed
// and the claim would silently get no expiry.
//
// Note what adding the four §22 types does and does not do: the shared
// quick_signal surface now ACCEPTS them from any caller that clears the same
// gates (flag, consent, subject, idempotency), but mapQuickSignal() above still
// emits none of them — the §6 composer's contexts have no prompt for vibe,
// closure, event status or crowd direction. The producer for these is the map
// capture sheet, via routes/mapObservations.ts.
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
};

/** True iff value_json is well-formed for this claim_type in the Phase-1 cut. */
export function validateClaimValue(claimType: string, value: unknown): boolean {
  const validator = VALUE_VALIDATORS[claimType];
  return validator ? validator(value) : false;
}

/**
 * The claim types this capture surface may produce. (Name kept for its callers;
 * it is now the Phase-1 cut PLUS the four §22 map-contribution types.)
 */
export const PHASE1_CAPTURE_CLAIM_TYPES = Object.keys(VALUE_VALIDATORS);
