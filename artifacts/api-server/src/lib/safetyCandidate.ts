/**
 * safetyCandidate — Sensing §16's missing first stages: world-intelligence
 * evidence / anomaly → SAFETY CANDIDATE → the EXISTING safety review → the
 * canonical safety assertion.
 *
 * The last two stages exist and are not touched: the specialist-reviewed
 * `crowd.level = unsafe_density` claim is the one canonical safety assertion
 * (lib/intelContracts SPECIALIST_ONLY_CROWD_LEVELS), projected by
 * lib/mapProducers/safetyNoticeProducer and unreachable from every
 * contributor surface. What was missing is anything that ENTERS the pipeline:
 * no detector read the served state for the shape of a crush forming, and no
 * candidate reached a reviewer. This module is the detector; the candidate
 * is filed into the review queue the platform already has — a
 * `moderation_reports` row, subject_type `place`, category `safety_concern`,
 * no reporter (system-originated), read by GET /admin/moderation/reports —
 * rather than into a parallel queue of its own. A candidate is a question
 * for a specialist. It asserts nothing, projects nothing and is never
 * rendered as a safety notice.
 *
 * ── WHAT IS AN ANOMALY, HERE ─────────────────────────────────────────────────
 * Three shapes, each over SERVED envelopes (lib/liveClaimRead, the one gated
 * path) and the projection's own previous readings, never over raw
 * observations or contributor rows:
 *
 *   density_rising_past_capacity   crowd.level = packed AND crowd.trajectory ∈
 *                                  {building, peaking}: the crowd is still
 *                                  growing at the top of the vocabulary.
 *   material_conflict_at_capacity  crowd.level = packed AND the cohort is in
 *                                  MATERIAL conflict: "reports differ about a
 *                                  crush" is itself safety information
 *                                  (safetyNoticeProducer's own reading of §10).
 *   rapid_density_rise             crowd.level = packed AND a previous reading
 *                                  at most `moderate` became current within
 *                                  RAPID_RISE_WINDOW_MINUTES of the current
 *                                  observation: two rungs in half an hour.
 *
 * `unsafe_density` is never a candidate: it IS the assertion the pipeline
 * ends in. An envelope whose class is not an independent observation — a
 * historical pattern, a prediction, or one party talking about itself
 * (official, sponsored, imported) — evidences nothing here: a candidate rests
 * on what independent people observed, and a cohort in MATERIAL conflict is
 * admitted on purpose. Evidence carries claim refs (snapshot ids), the values and
 * the instants; NO count, cohort, contributor or actor — the same rule the
 * safety notice keeps, because a specialist reading the queue is still a
 * reader.
 *
 * PURE. No I/O, no clock of its own.
 */
import type { LiveClaimEnvelope } from "./liveClaimRead.js";
import type { TruthMetadata } from "./experienceTruth.js";
import { truthOfEnvelopes } from "./liveEnvelopeTruth.js";
import { mayCountAsConsensus, mayRenderAsLive } from "./intelContracts.js";
import { claimScalar, type PreviousReading } from "./wallMoments.js";

export const SAFETY_CANDIDATE_REASONS = ["density_rising_past_capacity", "material_conflict_at_capacity", "rapid_density_rise"] as const;
export type SafetyCandidateReason = (typeof SAFETY_CANDIDATE_REASONS)[number];

/** The claim types the detector reads — current and previous. */
export const SAFETY_CANDIDATE_CLAIM_TYPES = ["crowd.level", "crowd.trajectory"] as const;
/** The level a candidate can rise from: the top of the contributor vocabulary. */
export const CANDIDATE_CROWD_LEVEL = "packed";
/** The assertion itself; never a candidate. */
export const ASSERTED_CROWD_LEVEL = "unsafe_density";
export const CANDIDATE_TRAJECTORIES: readonly string[] = ["building", "peaking"];
export const RAPID_RISE_FROM_LEVELS: readonly string[] = ["dead", "quiet", "moderate"];
export const RAPID_RISE_WINDOW_MINUTES = 30;

/** Where a candidate goes: the existing review queue. */
export const SAFETY_CANDIDATE_SUBJECT_TYPE = "place";
export const SAFETY_CANDIDATE_CATEGORY = "safety_concern";
/** The details prefix that marks a report as the detector's, so the queue can tell them apart. */
export const SAFETY_CANDIDATE_DETAILS_PREFIX = "safety_candidate:";
export const SAFETY_CANDIDATE_SCHEMA_VERSION = 1;

export interface SafetyCandidateEvidence {
  /** Snapshot ids. Opaque; never a contributor. */
  claimRefs: string[];
  crowdLevel: string;
  trajectory: string | null;
  conflictState: string;
  previousLevel: string | null;
  previousGeneratedAt: string | null;
  observedAt: string;
}

export interface SafetyCandidate {
  subjectId: string;
  reason: SafetyCandidateReason;
  evidence: SafetyCandidateEvidence;
  truth: TruthMetadata;
  detectedAt: string;
  /** The evidence's own horizon: the earliest validUntil among the envelopes it rests on. */
  expiresAt: string;
}

/**
 * May this envelope evidence a candidate? Its class must be an OBSERVATION
 * (never a historical pattern or a prediction — lib/intelContracts
 * mayRenderAsLive) AND independent (never one party talking about itself —
 * mayCountAsConsensus). The truth class is deliberately NOT the test: a
 * cohort in material conflict derives a non-observational truth class, and
 * "reports differ about a crush" is exactly the second shape.
 */
export function evidenceAdmissible(e: LiveClaimEnvelope): boolean {
  return mayRenderAsLive(e.sourceClass) && mayCountAsConsensus(e.sourceClass);
}

function envelopeOf(current: readonly LiveClaimEnvelope[], claimType: string): LiveClaimEnvelope | undefined {
  return current.find((e) => e.claimType === claimType);
}

function earliestValidUntil(envelopes: readonly LiveClaimEnvelope[]): string {
  let best: number | null = null;
  for (const e of envelopes) {
    const t = Date.parse(e.validUntil);
    if (!Number.isFinite(t)) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? "" : new Date(best).toISOString();
}

/**
 * The previous reading that evidences a rapid rise: a crowd.level at most
 * `moderate` whose generated_at is within the window before the current
 * observation. The most recent such reading wins.
 */
export function rapidRiseFrom(
  crowd: LiveClaimEnvelope,
  previous: readonly PreviousReading[],
): PreviousReading | null {
  const observed = Date.parse(crowd.observedAt);
  if (!Number.isFinite(observed)) return null;
  const floor = observed - RAPID_RISE_WINDOW_MINUTES * 60_000;
  let best: PreviousReading | null = null;
  for (const p of previous) {
    if (p.claimType !== "crowd.level") continue;
    const level = claimScalar(p.claimType, p.value);
    if (level === null || !RAPID_RISE_FROM_LEVELS.includes(level)) continue;
    const at = Date.parse(p.generatedAt);
    if (!Number.isFinite(at) || at < floor || at > observed) continue;
    if (best === null || at > Date.parse(best.generatedAt)) best = p;
  }
  return best;
}

/**
 * Detect the candidates a subject's served state evidences. At most one per
 * reason. Nothing from an assertion, nothing from a non-observational
 * envelope, nothing without a `packed` crowd.
 */
export function detectSafetyCandidates(
  subjectId: string,
  current: readonly LiveClaimEnvelope[],
  previous: readonly PreviousReading[],
  nowMs: number,
): SafetyCandidate[] {
  const crowd = envelopeOf(current, "crowd.level");
  if (!crowd || !evidenceAdmissible(crowd)) return [];
  const level = claimScalar(crowd.claimType, crowd.value);
  if (level !== CANDIDATE_CROWD_LEVEL) return [];

  const trajectoryEnv = envelopeOf(current, "crowd.trajectory");
  const trajectory = trajectoryEnv && evidenceAdmissible(trajectoryEnv) ? claimScalar(trajectoryEnv.claimType, trajectoryEnv.value) : null;
  const detectedAt = new Date(nowMs).toISOString();
  const out: SafetyCandidate[] = [];

  const build = (reason: SafetyCandidateReason, envelopes: LiveClaimEnvelope[], prev: PreviousReading | null): SafetyCandidate => ({
    subjectId,
    reason,
    evidence: {
      claimRefs: envelopes.map((e) => e.id),
      crowdLevel: level,
      trajectory,
      conflictState: crowd.conflictState,
      previousLevel: prev ? claimScalar(prev.claimType, prev.value) : null,
      previousGeneratedAt: prev ? prev.generatedAt : null,
      observedAt: crowd.observedAt,
    },
    truth: truthOfEnvelopes(envelopes, nowMs),
    detectedAt,
    expiresAt: earliestValidUntil(envelopes),
  });

  if (trajectory !== null && CANDIDATE_TRAJECTORIES.includes(trajectory) && trajectoryEnv) {
    out.push(build("density_rising_past_capacity", [crowd, trajectoryEnv], null));
  }
  if (crowd.conflictState === "material") {
    out.push(build("material_conflict_at_capacity", [crowd], null));
  }
  const from = rapidRiseFrom(crowd, previous);
  if (from) {
    out.push(build("rapid_density_rise", [crowd], from));
  }
  return out;
}

// ── The review-queue row ─────────────────────────────────────────────────────

/** The keys a candidate's details must never carry, checked at write and pinned in tests. */
export const CANDIDATE_FORBIDDEN_KEYS: readonly string[] = ["distinct_actors", "distinctActors", "source_count", "sourceCount", "sourceCountBucket", "contributor", "actor", "device", "user_id", "userId", "count"];

export interface StoredCandidate {
  version: number;
  reason: SafetyCandidateReason;
  evidence: SafetyCandidateEvidence;
  truth: TruthMetadata;
  detectedAt: string;
  expiresAt: string;
}

/** `moderation_reports.details` for a candidate: the prefix and a JSON block. */
export function candidateDetails(c: SafetyCandidate): string {
  const stored: StoredCandidate = {
    version: SAFETY_CANDIDATE_SCHEMA_VERSION,
    reason: c.reason,
    evidence: c.evidence,
    truth: c.truth,
    detectedAt: c.detectedAt,
    expiresAt: c.expiresAt,
  };
  const text = JSON.stringify(stored);
  for (const k of CANDIDATE_FORBIDDEN_KEYS) {
    if (text.includes(`"${k}"`)) throw new Error(`safety candidate details must not carry ${k}`);
  }
  return `${SAFETY_CANDIDATE_DETAILS_PREFIX}${text}`;
}

/** A details string back to the candidate it stored, or null when it is not the detector's. Never throws. */
export function parseCandidateDetails(details: unknown): StoredCandidate | null {
  if (typeof details !== "string" || !details.startsWith(SAFETY_CANDIDATE_DETAILS_PREFIX)) return null;
  try {
    const obj = JSON.parse(details.slice(SAFETY_CANDIDATE_DETAILS_PREFIX.length)) as Partial<StoredCandidate>;
    if (!obj || typeof obj !== "object") return null;
    if (obj.version !== SAFETY_CANDIDATE_SCHEMA_VERSION) return null;
    if (typeof obj.reason !== "string" || !(SAFETY_CANDIDATE_REASONS as readonly string[]).includes(obj.reason)) return null;
    if (!obj.evidence || typeof obj.evidence !== "object" || !Array.isArray(obj.evidence.claimRefs)) return null;
    if (typeof obj.detectedAt !== "string" || typeof obj.expiresAt !== "string") return null;
    if (!obj.truth || typeof obj.truth !== "object") return null;
    return obj as StoredCandidate;
  } catch {
    return null;
  }
}

/** The moderation_reports row a candidate is filed as: system-originated, a question for the existing review. */
export function candidateReportRow(c: SafetyCandidate): {
  reporter_id: null;
  subject_type: typeof SAFETY_CANDIDATE_SUBJECT_TYPE;
  subject_id: string;
  subject_user_id: null;
  category: typeof SAFETY_CANDIDATE_CATEGORY;
  details: string;
  status: "open";
} {
  return {
    reporter_id: null,
    subject_type: SAFETY_CANDIDATE_SUBJECT_TYPE,
    subject_id: c.subjectId,
    subject_user_id: null,
    category: SAFETY_CANDIDATE_CATEGORY,
    details: candidateDetails(c),
    status: "open",
  };
}
