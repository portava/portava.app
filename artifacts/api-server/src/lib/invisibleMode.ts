/**
 * invisibleMode — Telegraph §4.4: "Invisible mode suppresses Nearby / Bump /
 * public availability WHILE ALLOWING PRIVATE MAP USE."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE SECOND HALF IS THE REQUIREMENT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * A switch that turns everything off satisfies the first clause and breaks the
 * feature: the traveller who goes invisible precisely because they are in a
 * strange city still needs their own map. So this module expresses invisible
 * mode as TWO disjoint sets rather than one boolean sprinkled through call
 * sites, and `permitsPrivateMapUse` is typed to return the literal `true` — a
 * future edit that makes invisible mode suppress the private map does not fail
 * a test, it fails to compile.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY IT IS DERIVED FROM LOCATION CONSENT AND NOT FROM "ONLINE"
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * §4.1 is explicit that AVAILABLE, ONLINE, NEARBY and SHARING LOCATION are four
 * separate permissions that must never be collapsed into one. `show_online_status`
 * (user_privacy_settings) is the ONLINE control and is deliberately NOT an input
 * here: deriving invisibility from it would make one switch answer for two
 * permissions, which is the collapse the section forbids. The test
 * `invisible mode is NOT derived from show_online_status` pins that.
 *
 * The inputs are the three live location-consent columns, all of which already
 * exist in production on `location_preferences`:
 *
 *   location_mode = 'off'              the person is not sharing location at all
 *   sharing_paused = true              sharing is temporarily suspended
 *   discovery_visibility ∈ nobody /    the person is not discoverable on a
 *     no_location                      people surface
 *
 * Any one of them engages invisible mode for the OUTBOUND surfaces. None of them
 * is consulted by a private-map read, which is why the second clause holds
 * structurally rather than by promise.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * UNREADABLE STATE ENGAGES INVISIBILITY
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * supabase-js RESOLVES a failed read as `{ data: null, error }`. Read through
 * `?? {}` that becomes "this person has no preferences", which defaults to
 * discoverable — publishing presence for someone whose consent could not be
 * established. So `resolveInvisibleMode` takes the error explicitly and an
 * unreadable row engages invisible mode with the reason `prefs_unreadable`.
 * Absent consent fails CLOSED; it does not fail to a default.
 */

// ── Surfaces ──────────────────────────────────────────────────────────────────

/** Outbound surfaces that publish a person to other people. */
export const INVISIBLE_SUPPRESSED_SURFACES = [
  "nearby",
  "bump",
  "public_availability",
] as const;
export type SuppressedSurface = (typeof INVISIBLE_SUPPRESSED_SURFACES)[number];

/** Inbound surfaces the person uses themselves. Invisible mode never touches these. */
export const INVISIBLE_PERMITTED_SURFACES = [
  "private_map",
  "self_location_state",
  "own_trip_crew_map",
] as const;
export type PermittedSurface = (typeof INVISIBLE_PERMITTED_SURFACES)[number];

/**
 * Sets, not object literals. An object-literal lookup answers TRUTHY for keys
 * it never declared (`constructor`, `toString`), so a membership gate written
 * that way cannot be shown to refuse anything — and a mutation test against it
 * comes back "no change", which is how a real gate in this repo got deleted for
 * being "redundant".
 */
const SUPPRESSED = new Set<string>(INVISIBLE_SUPPRESSED_SURFACES);
const PERMITTED = new Set<string>(INVISIBLE_PERMITTED_SURFACES);

// ── State ─────────────────────────────────────────────────────────────────────

export const INVISIBLE_REASONS = [
  "location_mode_off",
  "sharing_paused",
  "discovery_visibility_nobody",
  "prefs_unreadable",
] as const;
export type InvisibleReason = (typeof INVISIBLE_REASONS)[number];

export interface InvisibleModeState {
  /** True when the outbound surfaces are suppressed. */
  readonly invisible: boolean;
  /** Every reason that applies, for observability. Never contains a coordinate. */
  readonly reasons: readonly InvisibleReason[];
  /**
   * True when invisibility was inferred from a FAILED read rather than from a
   * stored choice. Callers that describe the state to a person use it to avoid
   * asserting a preference nobody expressed.
   */
  readonly degraded: boolean;
}

/** The subset of `location_preferences` invisible mode reads. */
export interface InvisibleModeInputs {
  readonly prefs: {
    location_mode?: string | null;
    sharing_paused?: boolean | null;
    discovery_visibility?: string | null;
  } | null | undefined;
  /**
   * The `error` from the read that produced `prefs`. REQUIRED, and required to
   * be passed explicitly, because the whole defect class here is a caller that
   * never looked at it.
   */
  readonly prefsError: unknown;
}

const HIDDEN_DISCOVERY_VALUES = new Set<string>(["nobody", "no_location", "none"]);

/**
 * Resolve invisible mode for one person.
 *
 * Fail-closed: an unreadable preferences row yields `invisible: true`.
 */
export function resolveInvisibleMode(input: InvisibleModeInputs): InvisibleModeState {
  if (input.prefsError) {
    return { invisible: true, reasons: ["prefs_unreadable"], degraded: true };
  }
  const reasons: InvisibleReason[] = [];
  const prefs = input.prefs ?? null;
  const mode = prefs?.location_mode ?? null;
  if (mode === "off") reasons.push("location_mode_off");
  if (prefs?.sharing_paused === true) reasons.push("sharing_paused");
  const vis = prefs?.discovery_visibility ?? null;
  if (typeof vis === "string" && HIDDEN_DISCOVERY_VALUES.has(vis)) {
    reasons.push("discovery_visibility_nobody");
  }
  return { invisible: reasons.length > 0, reasons, degraded: false };
}

/** The visible state, for the common "nothing is suppressed" case. */
export const VISIBLE: InvisibleModeState = { invisible: false, reasons: [], degraded: false };

// ── The two halves ────────────────────────────────────────────────────────────

/**
 * Does invisible mode suppress this outbound surface?
 *
 * Unknown surface names are REFUSED rather than allowed: a surface this module
 * has not been taught about is not a surface it can promise to publish.
 */
export function suppressesSurface(state: InvisibleModeState, surface: string): boolean {
  if (!SUPPRESSED.has(surface)) {
    if (PERMITTED.has(surface)) return false;
    return state.invisible; // unknown surface → treated as outbound, fail closed
  }
  return state.invisible;
}

/**
 * The second half of §4.4, as a type.
 *
 * The return type is the literal `true`, so this function cannot be changed to
 * suppress the private map without a compile error at every call site. Invisible
 * mode hides a person FROM other people; it does not hide the world from them.
 */
export function permitsPrivateMapUse(_state: InvisibleModeState): true {
  return true;
}

/** True when `surface` is one invisible mode must never take away. */
export function isPrivateSurface(surface: string): boolean {
  return PERMITTED.has(surface);
}

/**
 * One-line, coordinate-free summary for logs and envelopes.
 * Deliberately returns no position, no city and no distance.
 */
export function invisibleModeTelemetry(state: InvisibleModeState): {
  invisible: boolean;
  reasons: readonly string[];
  degraded: boolean;
} {
  return { invisible: state.invisible, reasons: state.reasons, degraded: state.degraded };
}
