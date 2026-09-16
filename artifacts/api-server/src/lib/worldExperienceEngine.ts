/**
 * Deterministic World Experience inference.  Pure functions only: DB adapters
 * can persist these envelopes, while tests and consumers share identical rules.
 */
import type { SourceClass } from "./intelContracts.js";
import {
  type ExperienceRef, type WorldEnvelope, type VibeProjection, type ExperienceStateProjection,
  type ForecastProjection, type OpportunityProjection, type VibeValue, type ExperienceStateValue,
  type ForecastValue, type OpportunityValue, type WorldMomentProjection, type WorldMomentValue, unknownProjection,
} from "./worldExperienceContracts.js";

const clamp = (n: number) => Number.isFinite(n)
  ? Math.round(Math.max(0, Math.min(1, n)) * 1_000_000) / 1_000_000
  : 0;
const idFor = (kind: string, subject: ExperienceRef, version: string) =>
  `${kind}:${subject.subjectKind}:${subject.subjectId}:${subject.zoneId ?? ""}:${version}`;
const lineage = (now: Date, version: string, parents: string[]) => ({
  contractVersion: "world-experience/v1", modelVersion: version,
  generatedAt: now.toISOString(), parentIds: parents.slice().sort(),
});
const freshness = (observedAt: string | null, validUntil: string | null, now: Date) => ({
  observedAt, validUntil,
  ageSeconds: observedAt ? Math.max(0, (now.getTime() - Date.parse(observedAt)) / 1000) : null,
});
const provenance = (sourceClass: SourceClass, sourceIds: string[], method: string, details?: Record<string, unknown>) => ({
  sourceClass, sourceIds: [...new Set(sourceIds)].sort(), method, ...(details ? { details } : {}),
});

export interface WorldSignals {
  subject: ExperienceRef;
  observedAt?: string;
  validUntil?: string;
  sourceIds?: string[];
  sourceClass?: SourceClass;
  coverage?: "covered" | "partial" | "no_coverage";
  crowd?: ExperienceStateValue["crowd"];
  trajectory?: "emerging" | "building" | "peaking" | "stable" | "fragmenting" | "relocating" | "declining" | "ending";
  crowdConfidence?: number;
  anomaly?: boolean;
  accessibility?: ExperienceStateValue["accessibility"];
  /** null means no authoritative safety input; it is never treated as clear. */
  safetyConstraint?: boolean | null;
  safetyProvenance?: Record<string, unknown>;
}

/** Movement/relocation is intentionally only a trajectory, never a behavior label. */
export function inferVibe(input: WorldSignals, now = new Date()): VibeProjection {
  const coverage = input.coverage ?? "no_coverage";
  if (coverage === "no_coverage" || !input.crowd) return unknownProjection<VibeValue>(idFor("vibe", input.subject, "v1"), input.subject, now);
  const label: VibeValue["label"] =
    input.crowd === "packed" || input.crowd === "busy" ? "social" :
    input.crowd === "quiet" || input.crowd === "dead" ? "quiet" : "mixed";
  const trajectory = input.trajectory === "relocating" ? "emerging" :
    input.trajectory === "declining" || input.trajectory === "ending" ? "declining" :
    input.trajectory === "stable" ? "stable" : "emerging";
  return {
    id: idFor("vibe", input.subject, "v1"), subject: input.subject,
    value: { label, intensity: clamp(input.crowdConfidence ?? 0), trajectory },
    truthClass: "inference", state: input.anomaly ? "conflicting" : "known",
    confidence: clamp(input.crowdConfidence ?? 0), coverage,
    freshness: freshness(input.observedAt ?? null, input.validUntil ?? null, now),
    temporal: { kind: "current", startsAt: input.observedAt ?? null, endsAt: input.validUntil ?? null },
    provenance: provenance(input.sourceClass ?? "firsthand_unverified", input.sourceIds ?? [], "vibe-v1"),
    lineage: lineage(now, "vibe-v1", input.sourceIds ?? []),
  };
}

export function inferExperienceState(input: WorldSignals, now = new Date()): ExperienceStateProjection {
  const coverage = input.coverage ?? "no_coverage";
  if (coverage === "no_coverage" || !input.crowd) {
    const p = unknownProjection<ExperienceStateValue>(idFor("state", input.subject, "v1"), input.subject, now);
    if (input.safetyProvenance) {
      p.provenance = provenance("official_signed", input.sourceIds ?? [], "experience-state-safety-v1", input.safetyProvenance);
      p.freshness.validUntil = input.validUntil ?? null;
      p.temporal.endsAt = input.validUntil ?? null;
    }
    return p;
  }
  return {
    id: idFor("state", input.subject, "v1"), subject: input.subject,
    value: {
      crowd: input.crowd,
      accessibility: input.accessibility ?? "unknown",
      // An anomaly is not safety evidence. Only an explicit safety constraint
      // may produce a constrained safety state.
      safety: input.safetyConstraint === true ? "constrained"
        : input.safetyConstraint === false ? "clear" : "unknown",
    },
    truthClass: input.safetyConstraint ? "constraint" : "observation",
    state: input.anomaly ? "conflicting" : "known",
    confidence: clamp(input.crowdConfidence ?? 0), coverage,
    freshness: freshness(input.observedAt ?? null, input.validUntil ?? null, now),
    temporal: { kind: "current", startsAt: input.observedAt ?? null, endsAt: input.validUntil ?? null },
    provenance: provenance(input.sourceClass ?? "firsthand_unverified", input.sourceIds ?? [], "experience-state-v1", input.safetyProvenance),
    lineage: lineage(now, "experience-state-v1", input.sourceIds ?? []),
  };
}

/** Derives a bounded moment from current aggregate state; never from raw motion. */
export function inferWorldMoment(input: WorldSignals, now = new Date()): WorldMomentProjection {
  const coverage = input.coverage ?? "no_coverage";
  if (coverage === "no_coverage" || !input.crowd) {
    return unknownProjection<WorldMomentValue>(idFor("moment", input.subject, "v1"), input.subject, now, "world-moment-v1");
  }
  const kind: WorldMomentValue["kind"] =
    input.trajectory === "peaking" ? "peak" :
    input.trajectory === "emerging" || input.trajectory === "building" ? "arrival" :
    input.trajectory === "declining" || input.trajectory === "ending" ? "departure" :
    input.trajectory === "relocating" || input.trajectory === "fragmenting" ? "transition" : "quiet_window";
  return {
    id: idFor("moment", input.subject, "v1"), subject: input.subject,
    value: { kind, label: kind === "peak" ? "Experience is peaking" : `Current moment: ${kind}` },
    truthClass: "inference", state: input.anomaly ? "conflicting" : "known",
    confidence: clamp(input.crowdConfidence ?? 0), coverage,
    freshness: freshness(input.observedAt ?? null, input.validUntil ?? null, now),
    temporal: { kind: "current", startsAt: input.observedAt ?? null, endsAt: input.validUntil ?? null },
    provenance: provenance(input.sourceClass ?? "firsthand_unverified", input.sourceIds ?? [], "world-moment-v1"),
    lineage: lineage(now, "world-moment-v1", input.sourceIds ?? []),
  };
}

export function forecast(input: WorldSignals & { expected: string; probability: number; startsAt: string; endsAt?: string }, now = new Date()): ForecastProjection {
  const coverage = input.coverage ?? "no_coverage";
  if (coverage === "no_coverage") return unknownProjection<ForecastValue>(idFor("forecast", input.subject, "v1"), input.subject, now, "forecast-v1");
  const value = { expected: input.expected, probability: clamp(input.probability), basis: "privacy-safe aggregate" };
  return {
    id: idFor("forecast", input.subject, "v1"), subject: input.subject, value,
    truthClass: "prediction", state: input.anomaly ? "conflicting" : "known",
    confidence: clamp(input.probability), coverage,
    freshness: freshness(input.observedAt ?? null, input.validUntil ?? null, now),
    temporal: { kind: "forecast", startsAt: input.startsAt, endsAt: input.endsAt ?? null },
    provenance: provenance("portava_prediction", input.sourceIds ?? [], "forecast-v1"),
    lineage: lineage(now, "forecast-v1", input.sourceIds ?? []),
  };
}

export interface OpportunityInput {
  subject: ExperienceRef; action: string; reason: string; confidence: number;
  safetyCleared: boolean | null; friction: number; coverage?: "covered" | "partial" | "no_coverage";
  sourceIds?: string[]; sourceClass?: SourceClass; now?: Date; currentAction?: string | null;
  validUntil?: string | null;
  safetyProvenance?: Record<string, unknown>;
}

/** Safety always outranks opportunity; switching cost prevents recommendation flapping. */
export function rankOpportunity(input: OpportunityInput): OpportunityProjection {
  const now = input.now ?? new Date();
  const coverage = input.coverage ?? "no_coverage";
  if (coverage === "no_coverage" || input.safetyCleared !== true) {
    const p = unknownProjection<OpportunityValue>(idFor("opportunity", input.subject, "v1"), input.subject, now, "opportunity-v1");
    if (input.safetyCleared === false && coverage !== "no_coverage") {
      p.state = "known"; p.truthClass = "constraint"; p.coverage = coverage;
      p.value = { action: "hold", reason: "safety constraint", friction: 1, safetyCleared: false };
      p.confidence = 1; p.provenance = provenance("official_signed", input.sourceIds ?? [], "opportunity-safety-v1");
      if (input.safetyProvenance) {
        p.provenance = provenance("official_signed", input.sourceIds ?? [], "opportunity-safety-v1", input.safetyProvenance);
      }
    }
    p.freshness.validUntil = input.validUntil ?? null;
    p.temporal.endsAt = input.validUntil ?? null;
    return p;
  }
  const switchingPenalty = input.currentAction && input.currentAction !== input.action ? 0.2 : 0;
  const confidence = clamp(input.confidence - switchingPenalty);
  return {
    id: idFor("opportunity", input.subject, "v1"), subject: input.subject,
    value: { action: input.action, reason: input.reason, friction: clamp(input.friction + switchingPenalty), safetyCleared: true },
    truthClass: "inference", state: "known", confidence, coverage,
    freshness: freshness(null, input.validUntil ?? null, now),
    temporal: { kind: "current", startsAt: null, endsAt: input.validUntil ?? null },
    provenance: provenance(input.sourceClass ?? "portava_prediction", input.sourceIds ?? [], "opportunity-v1", input.safetyProvenance),
    lineage: lineage(now, "opportunity-v1", input.sourceIds ?? []),
  };
}

export function runInShadow<T extends WorldEnvelope<unknown>>(projection: T, shadow: boolean): T {
  if (!shadow) return projection;
  return { ...projection, state: "unknown", value: null, confidence: 0, coverage: "no_coverage" };
}