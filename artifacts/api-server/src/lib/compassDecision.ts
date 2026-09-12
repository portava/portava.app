/**
 * compassDecision — Sensing §10's decision, as a PURE engine:
 *
 *   USER CONTEXT + WORLD STATE + EXPERIENCE STATE + FORECAST + TIME / FRICTION
 *   + SAFETY + CURRENT EXPERIENCE  →  GO NOW · GO SOON · WAIT · STAY · SWITCH ·
 *   SKIP · RETURN
 *
 * and the two rules §10 and §11 attach to it: "Current Experience value
 * introduces switching cost so Compass does not constantly tell users to
 * abandon a good experience", and "peak interception: can the user reach the
 * experience before its useful window decays?".
 *
 * ── WHAT IT CONSUMES, AND THROUGH WHICH SEAM ─────────────────────────────────
 * Live intelligence reaches this engine ONLY as `LiveClaimEnvelope`s from
 * lib/liveClaimRead — the client-facing, decision-exposure shape that carries
 * no contributor id, no coordinate and no cohort count (Sensing §5 "product
 * surfaces consume projections; they do not reimplement the logic"). The
 * Live-qualification rule is lib/compass/CompassLiveConstraints' own
 * `isLiveConstraintEligible` / `isEmergingInfluenceEligible`, reused rather
 * than restated, so this engine cannot count as a hard fact anything Compass's
 * ranking would not. The truth block on every decision is composed by
 * lib/experienceTruth from the Wall's §5.1 derivation — weakest on every axis.
 *
 * ── THE RULES, IN THE ORDER THEY RUN ─────────────────────────────────────────
 *   1. SAFETY OUTRANKS OPPORTUNITY (§7, §20). A Live-qualified `unsafe_density`
 *      on the candidate is SKIP, whatever else is true, for every viewer.
 *   2. Already at the candidate → STAY.
 *   3. NO LIVE EVIDENCE is not "quiet" (§20). A READING is a Live-qualified
 *      claim whose §5.1 truth class is an OBSERVATION (observed / corroborated):
 *      a sponsored claim is `inferred` and a materially conflicting one is
 *      `conflicting`, and neither may back a decision to go (§2 "promotional
 *      claim ≠ observed reality"; §10 reports differ ≠ live). Without a
 *      reading the engine cannot say GO: an emerging, building candidate is
 *      GO SOON (labelled below the live floor); live-but-not-observational
 *      evidence is WAIT with its own reason; anything else is WAIT — and a
 *      read the gates refused is WAIT with a DIFFERENT reason from "nothing
 *      observed", because "we could not look" ≠ "we looked and saw nothing".
 *   4. FRICTION: a walk-in refused is SKIP; a queue past the viewer's tolerance
 *      is WAIT.
 *   5. INTENT COMPATIBILITY: a candidate whose intent-relative value is at the
 *      floor (packed, for a viewer who wants quiet) is SKIP.
 *   6. PEAK INTERCEPTION (§11): arrival after the earliest horizon of the
 *      claims that qualified is WAIT — the window may have decayed. Horizon =
 *      min(validUntil, observedAt + the claim family's TTL), the same rule
 *      Compass's arrival forecast uses. An unknown ETA is an unknown
 *      interception, stated, never assumed reachable.
 *   7. RETURN: the candidate is a place the viewer left earlier in this session
 *      and is favourable now.
 *   8. SWITCHING COST (§10): with a current experience whose value is known,
 *      the candidate must beat it by more than SWITCHING_COST to be SWITCH;
 *      otherwise STAY. With a current experience whose value is UNKNOWN the
 *      engine has no basis to tell the viewer to leave, and says STAY for
 *      that reason — it does not invent a cost, and it does not invent a
 *      preference.
 *   9. Otherwise GO NOW.
 *
 * ── EXPERIENCE VALUE IS INTENT-RELATIVE, NEVER "BUSY = GOOD" (§2) ────────────
 * A place's value to a viewer who wants quiet falls as the crowd rises; to a
 * viewer who wants high energy it rises. With no declared intent the value is
 * UNKNOWN (null) — the engine does not guess what a person wants from what a
 * crowd is doing. Dwell at the current place is revealed preference and can
 * only raise a KNOWN value, bounded, never create one.
 *
 * ── LANGUAGE IS GROUNDED IN STRUCTURED TRUTH (§10) ───────────────────────────
 * `summariseDecision` builds its sentence from templates keyed on the truth
 * block and the claim values, and the truth class is always in the sentence.
 * A vibe tap is described only when it is Live-qualified and only as
 * "reported as …" — never as a fact about what everyone is doing. This grounds
 * the DECISION surface; the conversational `/compass/ask` model path is
 * outside this module and is still constrained only by a shape sanitizer.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no identity.
 */
import type { TruthMetadata } from "./experienceTruth.js";
import { envelopeIsObservational, truthOfEnvelope, truthOfEnvelopes } from "./liveEnvelopeTruth.js";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";
import { isEmergingInfluenceEligible, isLiveConstraintEligible } from "../compass/CompassLiveConstraints.js";

/** §10's seven decisions, verbatim. */
export const COMPASS_DECISIONS = ["GO_NOW", "GO_SOON", "WAIT", "STAY", "SWITCH", "SKIP", "RETURN"] as const;
export type CompassDecision = (typeof COMPASS_DECISIONS)[number];

export const DECISION_INTENTS = ["quiet", "social", "high_energy", "explore"] as const;
export type DecisionIntent = (typeof DECISION_INTENTS)[number];

/**
 * How much better (0..1) a candidate must be than the current experience
 * before Compass says SWITCH. A tunable, documented as the §10 knob and not an
 * owner ruling; the SHAPE (a cost that must be exceeded) is the requirement.
 */
export const SWITCHING_COST = 0.25;
/** Queue wait past which a live candidate is WAIT rather than GO. */
export const DEFAULT_QUEUE_TOLERANCE_MINUTES = 30;
/** Dwell (minutes) at which revealed preference reaches its full weight. */
export const DWELL_FULL_WEIGHT_MINUTES = 60;
/** Intent-relative value at or below which a candidate conflicts with the intent. */
export const INTENT_CONFLICT_FLOOR = 0.2;
/** Value at or above which a left-earlier place counts as favourable again. */
export const RETURN_FAVOURABLE_VALUE = 0.5;

export type DecisionReason =
  | "safety_outranks_opportunity"
  | "already_here"
  | "live_intelligence_unavailable"
  | "no_live_evidence"
  | "evidence_not_observational"
  | "building_not_yet_live"
  | "walk_in_refused"
  | "queue_exceeds_tolerance"
  | "intent_conflict"
  | "window_may_decay_before_arrival"
  | "interception_unknown"
  | "left_earlier_now_favourable"
  | "switching_cost_not_exceeded"
  | "better_by_more_than_switching_cost"
  | "current_value_unknown"
  | "live_reachable_compatible";

export interface DecisionSubject {
  subjectId: string;
  envelopes: readonly LiveClaimEnvelope[];
  /**
   * Whether the live read was ALLOWED to look. False when the Live gates are
   * closed or the read was refused; then an empty `envelopes` means "could not
   * look", not "saw nothing".
   */
  readable: boolean;
}

export interface CurrentExperience extends DecisionSubject {
  /** Minutes the viewer has been at this subject, when known. */
  sinceMinutes: number | null;
}

export interface DecisionInput {
  candidate: DecisionSubject;
  current?: CurrentExperience | null;
  /** A subject the viewer left earlier in this session, if the client knows one. */
  returnSubjectId?: string | null;
  intent?: DecisionIntent | null;
  /** Minutes to reach the candidate; null when unknown. */
  etaMinutes: number | null;
  queueToleranceMinutes?: number | null;
  /** The claim family's TTL, for the horizon; null ⇒ validUntil alone. */
  ttlSecondsFor?: (claimType: string) => number | null;
}

export interface PeakInterception {
  /** True when arrival precedes the window's earliest horizon; null when unknowable. */
  reachable: boolean | null;
  etaMinutes: number | null;
  arrivalAt: string | null;
  horizonAt: string | null;
  /** Minutes of window left at arrival (negative = missed); null when unknowable. */
  marginMinutes: number | null;
}

export interface SwitchingCostReport {
  applied: boolean;
  cost: number;
  currentValue: number | null;
  candidateValue: number | null;
}

export interface LiveStateSummary {
  /** At least one READING: Live-qualified AND an observation truth class. */
  live: boolean;
  /** Live-qualified claims exist but none is an observation (sponsored, conflicting). */
  liveNonObservational: boolean;
  emerging: boolean;
  unsafe: boolean;
  crowdLevel: string | null;
  trajectory: string | null;
  vibe: string | null;
  walkIn: boolean | null;
  queueMinMinutes: number | null;
  horizonAt: string | null;
  truth: TruthMetadata;
  claimRefs: string[];
}

export interface CompassDecisionResult {
  decision: CompassDecision;
  reasons: DecisionReason[];
  /** §5.1 metadata of the evidence the decision rests on — weakest on every axis. */
  grounding: TruthMetadata;
  candidate: LiveStateSummary;
  current: LiveStateSummary | null;
  interception: PeakInterception;
  switchingCost: SwitchingCostReport;
  /** A sentence built from templates over the structured truth; never a model's. */
  summary: string;
}

// ── Claim reading (the value vocabularies are the contracts', never re-spelt) ─

function scalar(value: unknown, key: string): unknown {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return (value as Record<string, unknown>)[key];
  return undefined;
}

function stringScalar(value: unknown, key: string): string | null {
  const v = scalar(value, key);
  return typeof v === "string" ? v : null;
}

const CROWD_LEVEL_TYPES = new Set(["crowd.level", "crowd"]);

function firstReading(readings: readonly LiveClaimEnvelope[], types: ReadonlySet<string>): LiveClaimEnvelope | undefined {
  return readings.find((e) => types.has(e.claimType));
}

/** Weakest-on-every-axis truth over the envelopes a decision may use (lib/liveEnvelopeTruth). */
export function truthOf(envelopes: readonly LiveClaimEnvelope[], nowMs: number): TruthMetadata {
  return truthOfEnvelopes(envelopes, nowMs);
}

/**
 * A READING: Live-qualified by Compass's own rule AND an observation by the
 * Wall's §5.1 derivation (lib/liveEnvelopeTruth). A sponsored "busy" is
 * Live-qualified and `inferred`; it is not a reading and cannot back GO.
 */
export function isReading(e: LiveClaimEnvelope, nowMs: number): boolean {
  return isLiveConstraintEligible(e, nowMs) && envelopeIsObservational(e, nowMs);
}

export { truthOfEnvelope };

/** Summarise one subject's envelopes. Only Live-qualified claims populate the fields. */
export function summariseLiveState(
  subject: DecisionSubject,
  nowMs: number,
  ttlSecondsFor?: (claimType: string) => number | null,
): LiveStateSummary {
  const env = subject.envelopes ?? [];
  const eligible = env.filter((e) => isLiveConstraintEligible(e, nowMs));
  const qualified = eligible.filter((e) => isReading(e, nowMs));
  const emerging = env.some((e) => isEmergingInfluenceEligible(e, nowMs));
  const crowd = firstReading(qualified, CROWD_LEVEL_TYPES);
  const crowdLevel = crowd ? stringScalar(crowd.value, "level") : null;
  const traj = firstReading(qualified, new Set(["crowd.trajectory"]));
  const vibeEnv = firstReading(qualified, new Set(["vibe.state"]));
  const walkInEnv = firstReading(qualified, new Set(["access.walk_in"]));
  const walkInRaw = walkInEnv ? scalar(walkInEnv.value, "accepted") : undefined;
  const queueEnv = firstReading(qualified, new Set(["queue.wait"]));
  const queueMin = queueEnv ? scalar(queueEnv.value, "minMinutes") : undefined;

  // The earliest horizon among the claims that qualified: min(validUntil,
  // observedAt + TTL). Never the latest — the window closes when its first
  // supporting claim does.
  let horizonMs = Number.POSITIVE_INFINITY;
  for (const e of qualified) {
    let h = Date.parse(e.validUntil);
    const ttl = ttlSecondsFor ? ttlSecondsFor(e.claimType) : null;
    const observed = Date.parse(e.observedAt);
    if (ttl !== null && Number.isFinite(ttl) && ttl >= 0 && Number.isFinite(observed)) h = Math.min(h, observed + ttl * 1000);
    if (Number.isFinite(h) && h < horizonMs) horizonMs = h;
  }

  // Grounding: the readings when any exist; otherwise everything that was
  // served (so an emerging-only or sponsored-only candidate still shows what
  // it rests on, and its class says why it is not a reading).
  const basis = qualified.length > 0 ? qualified : env;
  return {
    live: qualified.length > 0,
    liveNonObservational: qualified.length === 0 && eligible.length > 0,
    emerging,
    unsafe: crowdLevel === "unsafe_density",
    crowdLevel,
    trajectory: traj ? stringScalar(traj.value, "trajectory") : null,
    vibe: vibeEnv ? stringScalar(vibeEnv.value, "state") : null,
    walkIn: typeof walkInRaw === "boolean" ? walkInRaw : null,
    queueMinMinutes: typeof queueMin === "number" && Number.isFinite(queueMin) && queueMin >= 0 ? queueMin : null,
    horizonAt: Number.isFinite(horizonMs) ? new Date(horizonMs).toISOString() : null,
    truth: truthOf(basis, nowMs),
    claimRefs: basis.map((e) => e.id),
  };
}

// ── Experience value — intent-relative, never busy = good ────────────────────

const VALUE_BY_INTENT: Readonly<Record<Exclude<DecisionIntent, "explore">, Readonly<Record<string, number>>>> = {
  quiet: { dead: 0.6, quiet: 1.0, moderate: 0.6, busy: 0.2, packed: 0.0, unsafe_density: 0.0 },
  social: { dead: 0.0, quiet: 0.3, moderate: 0.7, busy: 1.0, packed: 0.6, unsafe_density: 0.0 },
  high_energy: { dead: 0.0, quiet: 0.1, moderate: 0.5, busy: 0.8, packed: 1.0, unsafe_density: 0.0 },
};

/**
 * The value of a state TO THIS VIEWER, 0..1, or null when it cannot be known:
 * no declared intent, an "explore" intent (which has no crowd preference), or
 * no Live-qualified crowd reading. A vibe tap may nudge a KNOWN value by at
 * most 0.1 when Live-qualified. Nothing here reads "busy" as "good".
 */
export function experienceValue(state: LiveStateSummary, intent: DecisionIntent | null | undefined): number | null {
  if (!intent || intent === "explore") return null;
  if (!state.live || state.crowdLevel === null) return null;
  const table = VALUE_BY_INTENT[intent];
  const base = Object.prototype.hasOwnProperty.call(table, state.crowdLevel) ? table[state.crowdLevel]! : null;
  if (base === null) return null;
  let v = base;
  if (state.vibe === "going_off" && intent === "high_energy") v += 0.1;
  if (state.vibe === "dead" && intent !== "quiet") v -= 0.1;
  return Math.min(1, Math.max(0, v));
}

/** Revealed preference: dwell can raise a KNOWN current value, bounded; it creates none. */
export function currentExperienceValue(state: LiveStateSummary, intent: DecisionIntent | null | undefined, sinceMinutes: number | null): number | null {
  const base = experienceValue(state, intent);
  if (base === null) return null;
  if (sinceMinutes === null || !Number.isFinite(sinceMinutes) || sinceMinutes <= 0) return base;
  const dwell = Math.min(1, sinceMinutes / DWELL_FULL_WEIGHT_MINUTES);
  return Math.min(1, base + (1 - base) * 0.3 * dwell);
}

// ── Peak interception (§11) ──────────────────────────────────────────────────

export function interceptPeak(etaMinutes: number | null, horizonAt: string | null, nowMs: number): PeakInterception {
  const eta = etaMinutes !== null && Number.isFinite(etaMinutes) && etaMinutes >= 0 ? Math.ceil(etaMinutes) : null;
  const horizonMs = horizonAt ? Date.parse(horizonAt) : NaN;
  if (eta === null || !Number.isFinite(horizonMs)) {
    return { reachable: null, etaMinutes: eta, arrivalAt: eta === null ? null : new Date(nowMs + eta * 60_000).toISOString(), horizonAt: Number.isFinite(horizonMs) ? horizonAt : null, marginMinutes: null };
  }
  const arrivalMs = nowMs + eta * 60_000;
  const margin = Math.round((horizonMs - arrivalMs) / 60_000);
  return {
    reachable: arrivalMs < horizonMs,
    etaMinutes: eta,
    arrivalAt: new Date(arrivalMs).toISOString(),
    horizonAt: new Date(horizonMs).toISOString(),
    marginMinutes: margin,
  };
}

// ── The decision ─────────────────────────────────────────────────────────────

export function decideCompass(input: DecisionInput, nowMs: number): CompassDecisionResult {
  if (!input || !input.candidate || !Number.isFinite(nowMs)) throw new Error("decideCompass: candidate and nowMs are required");
  const intent = input.intent ?? null;
  const candidate = summariseLiveState(input.candidate, nowMs, input.ttlSecondsFor);
  const current = input.current ? summariseLiveState(input.current, nowMs, input.ttlSecondsFor) : null;
  const candidateValue = experienceValue(candidate, intent);
  const currentValue = current ? currentExperienceValue(current, intent, input.current?.sinceMinutes ?? null) : null;
  const interception = interceptPeak(input.etaMinutes, candidate.horizonAt, nowMs);
  const switching: SwitchingCostReport = { applied: false, cost: SWITCHING_COST, currentValue, candidateValue };
  const reasons: DecisionReason[] = [];

  const finish = (decision: CompassDecision): CompassDecisionResult => ({
    decision,
    reasons,
    grounding: candidate.truth,
    candidate,
    current,
    interception,
    switchingCost: switching,
    summary: summariseDecision(decision, reasons, candidate, interception),
  });

  // 1. Safety outranks opportunity.
  if (candidate.unsafe) { reasons.push("safety_outranks_opportunity"); return finish("SKIP"); }
  // 2. Already here.
  if (current && current.claimRefs !== undefined && input.current!.subjectId === input.candidate.subjectId) {
    reasons.push("already_here"); return finish("STAY");
  }
  // 3. No live evidence ≠ quiet.
  if (!candidate.live) {
    if (!input.candidate.readable) { reasons.push("live_intelligence_unavailable"); return finish("WAIT"); }
    if (candidate.liveNonObservational) { reasons.push("evidence_not_observational"); return finish("WAIT"); }
    if (candidate.emerging && (candidate.trajectory === null ? emergingTrajectory(input.candidate.envelopes) : ["emerging", "building"].includes(candidate.trajectory))) {
      reasons.push("building_not_yet_live"); return finish("GO_SOON");
    }
    reasons.push("no_live_evidence"); return finish("WAIT");
  }
  // 4. Friction.
  if (candidate.walkIn === false) { reasons.push("walk_in_refused"); return finish("SKIP"); }
  const tolerance = input.queueToleranceMinutes ?? DEFAULT_QUEUE_TOLERANCE_MINUTES;
  if (candidate.queueMinMinutes !== null && candidate.queueMinMinutes > tolerance) { reasons.push("queue_exceeds_tolerance"); return finish("WAIT"); }
  // 5. Intent compatibility.
  if (candidateValue !== null && candidateValue <= INTENT_CONFLICT_FLOOR) { reasons.push("intent_conflict"); return finish("SKIP"); }
  // 6. Peak interception.
  if (interception.reachable === false) { reasons.push("window_may_decay_before_arrival"); return finish("WAIT"); }
  if (interception.reachable === null) reasons.push("interception_unknown");
  // 7. Return.
  if (input.returnSubjectId && input.returnSubjectId === input.candidate.subjectId && (candidateValue === null || candidateValue >= RETURN_FAVOURABLE_VALUE)) {
    reasons.push("left_earlier_now_favourable"); return finish("RETURN");
  }
  // 8. Switching cost.
  if (current) {
    if (currentValue === null || candidateValue === null) { reasons.push("current_value_unknown"); return finish("STAY"); }
    switching.applied = true;
    if (candidateValue - currentValue > SWITCHING_COST) { reasons.push("better_by_more_than_switching_cost"); return finish("SWITCH"); }
    reasons.push("switching_cost_not_exceeded"); return finish("STAY");
  }
  // 9. Go.
  reasons.push("live_reachable_compatible");
  return finish("GO_NOW");
}

/** An emerging (below-Live) trajectory claim that says building — read only for GO SOON. */
function emergingTrajectory(envelopes: readonly LiveClaimEnvelope[]): boolean {
  return envelopes.some((e) => e.claimType === "crowd.trajectory" && ["emerging", "building"].includes(stringScalar(e.value, "trajectory") ?? ""));
}

// ── Grounded language ────────────────────────────────────────────────────────

const CROWD_WORDS: Readonly<Record<string, string>> = {
  dead: "empty", quiet: "quiet", moderate: "moderately busy", busy: "busy", packed: "packed", unsafe_density: "at an unsafe density",
};
const VIBE_WORDS: Readonly<Record<string, string>> = {
  dead: "dead", chill: "chill", social: "social", high_energy: "high energy", going_off: "going off",
};
const DECISION_WORDS: Readonly<Record<CompassDecision, string>> = {
  GO_NOW: "Go now", GO_SOON: "Go soon", WAIT: "Wait", STAY: "Stay", SWITCH: "Switch", SKIP: "Skip", RETURN: "Return",
};
const TRUTH_WORDS: Readonly<Record<TruthMetadata["truthClass"], string>> = {
  observed: "observed", corroborated: "corroborated by several", inferred: "inferred", predicted: "predicted",
  conflicting: "reports differ", stale: "stale", unknown: "no current evidence",
};

/**
 * The sentence Compass may say about this decision. Every clause is a template
 * over a claim VALUE with its truth class beside it; a vibe is "reported as",
 * never a statement about what people are doing. The engine cannot produce
 * "everyone is dancing" because no template contains a behaviour verb.
 */
export function summariseDecision(
  decision: CompassDecision,
  reasons: readonly DecisionReason[],
  state: LiveStateSummary,
  interception: PeakInterception,
): string {
  const parts: string[] = [`${DECISION_WORDS[decision]}.`];
  if (state.live && state.crowdLevel && CROWD_WORDS[state.crowdLevel]) {
    parts.push(`Crowd ${CROWD_WORDS[state.crowdLevel]} (${TRUTH_WORDS[state.truth.truthClass]}, ${state.truth.freshness}).`);
  } else {
    parts.push(`No current crowd reading (${TRUTH_WORDS[state.truth.truthClass]}).`);
  }
  if (state.live && state.vibe && VIBE_WORDS[state.vibe]) parts.push(`Vibe reported as ${VIBE_WORDS[state.vibe]}.`);
  if (reasons.includes("window_may_decay_before_arrival") && interception.marginMinutes !== null) {
    parts.push(`The reading may have changed before you arrive (${Math.abs(interception.marginMinutes)} min past its horizon).`);
  }
  if (reasons.includes("safety_outranks_opportunity")) parts.push("A safety reading outranks any opportunity here.");
  if (reasons.includes("switching_cost_not_exceeded")) parts.push("Where you are is not clearly worse.");
  if (reasons.includes("current_value_unknown")) parts.push("Nothing says where you are is worse.");
  if (reasons.includes("building_not_yet_live")) parts.push("It is building, below the live floor.");
  if (reasons.includes("evidence_not_observational")) parts.push("What is served here is not an observation.");
  return parts.join(" ");
}
