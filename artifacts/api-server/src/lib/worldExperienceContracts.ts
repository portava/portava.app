/**
 * World Experience Intelligence contracts.
 *
 * These are deliberately transport-friendly, narrow envelopes.  A projection
 * is not a claim and a prediction is never represented as an observation.
 * Unknown/stale/conflicting are first-class values so callers do not have to
 * turn missing data into a positive assertion.
 */
import type { ExperienceRef, SourceClass } from "./intelContracts.js";
export type { ExperienceRef };

export const WORLD_TRUTH_CLASSES = ["observation", "inference", "prediction", "constraint"] as const;
export type WorldTruthClass = (typeof WORLD_TRUTH_CLASSES)[number];

export const WORLD_STATES = ["known", "unknown", "conflicting", "stale"] as const;
export type WorldState = (typeof WORLD_STATES)[number];

export const WORLD_COVERAGE = ["covered", "partial", "no_coverage"] as const;
export type WorldCoverage = (typeof WORLD_COVERAGE)[number];

export const WORLD_TEMPORAL_KINDS = ["current", "historical", "forecast", "window"] as const;
export type WorldTemporalKind = (typeof WORLD_TEMPORAL_KINDS)[number];

export interface WorldFreshness {
  observedAt: string | null;
  validUntil: string | null;
  ageSeconds: number | null;
}

export interface WorldProvenance {
  sourceClass: SourceClass;
  sourceIds: string[];
  method: string;
  /** Preserved authority/audit metadata for safety-backed projections. */
  details?: Record<string, unknown>;
}

export interface WorldLineage {
  contractVersion: string;
  modelVersion: string;
  generatedAt: string;
  parentIds: string[];
}

export interface WorldEnvelope<T> {
  id: string;
  subject: ExperienceRef;
  value: T | null;
  truthClass: WorldTruthClass;
  state: WorldState;
  confidence: number;
  coverage: WorldCoverage;
  freshness: WorldFreshness;
  temporal: {
    kind: WorldTemporalKind;
    startsAt: string | null;
    endsAt: string | null;
  };
  provenance: WorldProvenance;
  lineage: WorldLineage;
}

export type VibeLabel = "quiet" | "social" | "energetic" | "focused" | "mixed";
export interface VibeValue {
  label: VibeLabel;
  intensity: number;
  trajectory: "emerging" | "stable" | "declining" | "unknown";
}
export type VibeProjection = WorldEnvelope<VibeValue>;

export interface ExperienceStateValue {
  crowd: "dead" | "quiet" | "moderate" | "busy" | "packed" | "unknown";
  accessibility: "open" | "limited" | "closed" | "unknown";
  safety: "normal" | "clear" | "constrained" | "unknown";
}
export type ExperienceStateProjection = WorldEnvelope<ExperienceStateValue>;

export interface WorldMomentValue {
  kind: "arrival" | "peak" | "transition" | "departure" | "quiet_window";
  label: string;
}
export type WorldMomentProjection = WorldEnvelope<WorldMomentValue>;

export interface ForecastValue {
  expected: string;
  probability: number;
  basis: string;
}
export type ForecastProjection = WorldEnvelope<ForecastValue>;

export interface OpportunityValue {
  action: string;
  reason: string;
  friction: number;
  safetyCleared: boolean;
}
export type OpportunityProjection = WorldEnvelope<OpportunityValue>;

export const EXPERIENCE_SESSION_PURPOSES = ["recommendation", "world_moment", "forecast"] as const;
export type ExperienceSessionPurpose = (typeof EXPERIENCE_SESSION_PURPOSES)[number];
export const EXPERIENCE_SESSION_STATUSES = ["open", "completed", "abandoned", "expired"] as const;
export type ExperienceSessionStatus = (typeof EXPERIENCE_SESSION_STATUSES)[number];
export const EXPERIENCE_OUTCOMES = ["went", "stayed", "liked", "invited", "made_memory", "returned"] as const;
export type ExperienceOutcomeKind = (typeof EXPERIENCE_OUTCOMES)[number];
export const EXPERIENCE_OUTCOME_SIGNIFICANCES = ["routine", "significant"] as const;
export type ExperienceOutcomeSignificance = (typeof EXPERIENCE_OUTCOME_SIGNIFICANCES)[number];

export interface ExperienceSession {
  id: string;
  userId: string;
  recommendationId: string;
  itemId: string;
  itemType: string;
  purpose: ExperienceSessionPurpose;
  status: ExperienceSessionStatus;
  projectionVersion: string;
  expiresAt: string;
  closedAt: string | null;
  createdAt: string;
  /** A session is not a movement history. */
  locationTrace: null;
}

export interface ExperienceOutcome {
  id: string;
  sessionId: string;
  userId: string;
  recommendationId: string;
  itemId: string;
  itemType: string;
  outcome: ExperienceOutcomeKind;
  occurredAt: string;
  createdAt: string;
  projectionVersion: string;
  calibrationVersion: string;
  memoryEligible: boolean;
  significance: ExperienceOutcomeSignificance;
}

export function unknownProjection<T>(
  id: string,
  subject: ExperienceRef,
  now = new Date(),
  method = "world-experience-v1",
): WorldEnvelope<T> {
  return {
    id, subject, value: null, truthClass: "inference", state: "unknown",
    confidence: 0, coverage: "no_coverage",
    freshness: { observedAt: null, validUntil: null, ageSeconds: null },
    temporal: { kind: "current", startsAt: null, endsAt: null },
    provenance: { sourceClass: "portava_prediction", sourceIds: [], method },
    lineage: { contractVersion: "world-experience/v1", modelVersion: "none", generatedAt: now.toISOString(), parentIds: [] },
  };
}