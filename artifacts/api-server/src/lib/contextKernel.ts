/**
 * contextKernel — Sensing §6's CONTEXT KERNEL and §18.1's nine contexts, as one
 * shared platform object:
 *
 *   CANONICAL ENTITIES + WORLD / EXPERIENCE STATE + USER / TRIP / SOCIAL
 *   CONTEXT + SAFETY / POLICY   →   CONTEXT KERNEL   →   OPPORTUNITY ENGINE
 *   →   FEATURE-SPECIFIC PROJECTIONS
 *
 * Census S55 found `compass/CompassContextEngine.ts` — an 11-state machine that
 * "is Compass-local, is not consumed by Map, Wall or Discovery, and has no
 * World, Experience or Attention context". This module is the platform one:
 * §18.1's nine contexts verbatim (User · Temporal · Spatial · Trip · Social ·
 * Experience · World · Safety · Attention), built once per request and handed
 * to lib/opportunityEngine. It does not replace the Compass machine and does
 * not touch it — that surface keeps working exactly as it does (§1 "existing
 * surfaces keep functioning").
 *
 * ── PURE ASSEMBLY, NOT A READER ──────────────────────────────────────────────
 * Every input arrives already read, through the seams that already exist
 * (lib/contextKernelRead does the I/O for the route). The kernel therefore
 * cannot open a read path of its own, cannot widen one, and cannot fabricate a
 * context it was not given: a context nobody supplied is `null`, and `null`
 * means UNKNOWN — never "no trip", never "alone", never "safe".
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 * · No viewer id, no profile, no account handle. Nothing downstream needs one:
 *   relevance arrives as a LABEL the caller already resolved (saved / trip_stop
 *   / followed / nearby / none), and an opportunity is computed for the request,
 *   not for a stored person (§3, §20 "Anonymous intelligence may not be
 *   reverse-linked to a Portava account").
 * · No coordinates. SpatialContext carries whether a position was supplied and
 *   the ETA it produced — a scalar per subject — never the point itself (§4.3
 *   "Do not put precise GPS in canonical event payloads … use canonical IDs,
 *   coarse references and privacy-reduced derivatives").
 * · No preference model, no taste vector, no history. §5's Experience row:
 *   "must not treat personal preference as world truth"; the only user signal
 *   the kernel carries is a DECLARED intent for this request.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no identity.
 */
import type { AttentionRelevance } from "./attentionEngine.js";
import type { CrowdState } from "./crowdState.js";
import type { ForecastRefused, ForecastState } from "./forecastState.js";
import type { DecisionIntent } from "./compassDecision.js";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";
import type { TemporalEnvelope, TruthMetadata } from "./experienceTruth.js";

/** §18.1's nine, verbatim and in the spec's order. */
export const KERNEL_CONTEXTS = [
  "user",
  "temporal",
  "spatial",
  "trip",
  "social",
  "experience",
  "world",
  "safety",
  "attention",
] as const;
export type KernelContextName = (typeof KERNEL_CONTEXTS)[number];

/** Parts of the day. `null` when the viewer's offset is unknown — UTC is not a guess. */
export const DAY_PARTS = ["early_morning", "morning", "afternoon", "evening", "night"] as const;
export type DayPart = (typeof DAY_PARTS)[number];

export interface UserContext {
  /** Declared for THIS request, never inferred from behaviour. Null ⇒ unknown. */
  intent: DecisionIntent | null;
  queueToleranceMinutes: number | null;
  /** How this viewer already relates to the subjects, as the caller resolved it. */
  relevance: AttentionRelevance;
}

export interface TemporalContext {
  nowIso: string;
  /** Local hour 0..23, or null when the offset is unknown. */
  localHour: number | null;
  dayPart: DayPart | null;
  /** Minutes east of UTC, as the client declared it. Null ⇒ unknown. */
  utcOffsetMinutes: number | null;
}

export interface SpatialContext {
  /** Whether the caller supplied a position at all. The position itself never enters the kernel. */
  viewerPositionKnown: boolean;
  /** subjectId → minutes to reach, or null when unknown. A scalar, not a route. */
  etaMinutesBySubject: Readonly<Record<string, number | null>>;
}

export interface TripContext {
  onTrip: boolean;
  dayIndex: number | null;
  totalDays: number | null;
  /** The trip's next stop, when the caller knows one. A canonical id, never a plan. */
  nextStopSubjectId: string | null;
}

export interface SocialContext {
  /** Companions present, when the caller knows. Never a list of people. */
  partySize: number | null;
  crewPresent: boolean | null;
}

/** One subject's world reading — the Crowd engine's state and the Forecast engine's. */
export interface SubjectWorldContext {
  subjectId: string;
  /**
   * Whether the live read was ALLOWED to look. False ⇒ an empty reading means
   * "could not look", never "nothing is happening" (§20).
   */
  readable: boolean;
  crowd: CrowdState;
  forecast: ForecastState | null;
  forecastRefused: ForecastRefused | null;
  /** The envelopes the states were folded from, for engines that need the raw claim. */
  envelopes: readonly LiveClaimEnvelope[];
  /**
   * §5.1 over the evidence a surface may USE for this subject — live-qualified
   * or emerging-eligible, by Compass's own two predicates. The floor when
   * there is none; never a confident emptiness.
   */
  truth: TruthMetadata;
  /** §18.2 over that same evidence: when it was observed and when it stops being true. */
  evidenceWindow: TemporalEnvelope;
}

export interface WorldContext {
  subjects: readonly SubjectWorldContext[];
}

export interface ExperienceContext {
  /** The subject the viewer is at right now, when the caller knows one. */
  currentSubjectId: string | null;
  /** Minutes at it. Null ⇒ unknown; never assumed zero. */
  currentSinceMinutes: number | null;
  /** A subject the viewer left earlier in this session, if the client knows one. */
  leftSubjectId: string | null;
}

export interface SafetyContext {
  /**
   * Subjects a safety reading suppresses. An opportunity is never PROMOTED for
   * one of these, on any surface (§20 "Safety suppression/constraint must win
   * over opportunity promotion").
   */
  suppressedSubjectIds: readonly string[];
  /** Why each is suppressed, so a caller can tell a notice from a density claim. */
  reasonBySubject: Readonly<Record<string, "unsafe_density_reading">>;
}

export interface AttentionContext {
  /** False in quiet hours or with push off; NULL when the preference could not be read. */
  available: boolean | null;
  /** Notifications already delivered in the window, or null when unreadable. */
  deliveredInWindow: number | null;
  budgetPerWindow: number;
  /** Ids the client says it has already shown this viewer. Novelty, not a history. */
  seenIds: readonly string[];
}

/** §6's kernel. Every context but temporal/spatial/world/safety/attention may be null (unknown). */
export interface ContextKernel {
  user: UserContext;
  temporal: TemporalContext;
  spatial: SpatialContext;
  trip: TripContext | null;
  social: SocialContext | null;
  experience: ExperienceContext | null;
  world: WorldContext;
  safety: SafetyContext;
  attention: AttentionContext;
}

export interface AssembleKernelInput {
  user: UserContext;
  utcOffsetMinutes?: number | null;
  spatial: SpatialContext;
  trip?: TripContext | null;
  social?: SocialContext | null;
  experience?: ExperienceContext | null;
  subjects: readonly SubjectWorldContext[];
  attention: AttentionContext;
}

/** Local hour from a declared offset. Null in, null out — never the server's clock. */
export function localHourFrom(nowMs: number, utcOffsetMinutes: number | null | undefined): number | null {
  if (typeof utcOffsetMinutes !== "number" || !Number.isFinite(utcOffsetMinutes)) return null;
  if (Math.abs(utcOffsetMinutes) > 14 * 60) return null;
  const shifted = new Date(nowMs + utcOffsetMinutes * 60_000);
  return shifted.getUTCHours();
}

/** Hour → part of day. Null hour ⇒ null part: the kernel does not guess what time it is for a viewer. */
export function dayPartOf(localHour: number | null): DayPart | null {
  if (localHour === null) return null;
  if (localHour < 5) return "night";
  if (localHour < 9) return "early_morning";
  if (localHour < 12) return "morning";
  if (localHour < 17) return "afternoon";
  if (localHour < 22) return "evening";
  return "night";
}

/**
 * The SafetyContext is DERIVED, never declared: a subject is suppressed exactly
 * when its crowd fold refused a level as a safety claim. A caller cannot mark a
 * subject safe, and cannot unmark one.
 */
export function deriveSafetyContext(subjects: readonly SubjectWorldContext[]): SafetyContext {
  const suppressed: string[] = [];
  const reasonBySubject: Record<string, "unsafe_density_reading"> = {};
  for (const s of subjects) {
    if (s.crowd.refusals.includes("unsafe_density_is_a_safety_claim")) {
      suppressed.push(s.subjectId);
      reasonBySubject[s.subjectId] = "unsafe_density_reading";
    }
  }
  return { suppressedSubjectIds: suppressed, reasonBySubject };
}

/** Assemble the nine. Total: every context is present as a value or an explicit null. */
export function assembleContextKernel(input: AssembleKernelInput, nowMs: number): ContextKernel {
  const utcOffsetMinutes = input.utcOffsetMinutes ?? null;
  const localHour = localHourFrom(nowMs, utcOffsetMinutes);
  return {
    user: input.user,
    temporal: {
      nowIso: new Date(nowMs).toISOString(),
      localHour,
      dayPart: dayPartOf(localHour),
      utcOffsetMinutes,
    },
    spatial: input.spatial,
    trip: input.trip ?? null,
    social: input.social ?? null,
    experience: input.experience ?? null,
    world: { subjects: input.subjects },
    safety: deriveSafetyContext(input.subjects),
    attention: input.attention,
  };
}

/** The contexts that are UNKNOWN in this kernel. A reader should never read one as its empty value. */
export function unknownContexts(kernel: ContextKernel): KernelContextName[] {
  const out: KernelContextName[] = [];
  if (kernel.trip === null) out.push("trip");
  if (kernel.social === null) out.push("social");
  if (kernel.experience === null) out.push("experience");
  return out;
}
