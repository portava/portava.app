/**
 * Canonical read boundary for World Experience Intelligence.
 *
 * Consumers must not infer world truth from raw observations, movement, social
 * presence, or client-side heuristics. This adapter reads only server-built
 * projections and degrades to an explicit unknown state when the projection
 * store is absent, stale, partial, or unreadable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorldTruthClass as ContractTruthClass } from "../../lib/worldExperienceContracts.js";
import { searchKey } from "../../lib/canonicalLocations.js";

/** Contract truth classes plus read-side states represented as non-claims. */
export type WorldTruthClass = ContractTruthClass | "unknown" | "conflicting";
export type WorldCoverage = "covered" | "partial" | "no_coverage";
export type WorldFreshness = "fresh" | "stale" | "unknown";
export type WorldTemporalSemantics = "now" | "window" | "historical" | "forecast";
export type WorldSubjectKind = "place" | "locality";
export interface WorldSubjectIdentity { subjectId: string; subjectKind: WorldSubjectKind; }

export interface WorldProvenance {
  source: string;
  method: string;
  modelVersion: string;
  projectionVersion: string;
}

export interface WorldExperienceProjection {
  subjectId: string;
  zoneId: string | null;
  vibe: string | null;
  experienceState: string | null;
  worldMoment: string | null;
  forecast: string | null;
  opportunity: string | null;
  truthClass: WorldTruthClass;
  confidence: number | null;
  coverage: WorldCoverage;
  freshness: WorldFreshness;
  temporalSemantics: WorldTemporalSemantics;
  observedAt: string | null;
  validUntil: string | null;
  provenance: WorldProvenance;
  safetyLevel: "clear" | "caution" | "blocked" | "unknown";
  switchingCost: number;
  projectionId: string | null;
  projectionVersion: string;
  currentLabel: string | null;
  perKind: Record<string, {
    value: Record<string, any>;
    id: string; truthClass: WorldTruthClass; state: string; confidence: number | null;
    coverage: WorldCoverage; freshness: WorldFreshness; observedAt: string | null;
    validUntil: string | null; temporalKind: string; provenance: WorldProvenance;
    shadow: boolean; projectionVersion: string;
  }>;
}

const UNKNOWN_PROVENANCE: WorldProvenance = {
  source: "none",
  method: "no_projection",
  modelVersion: "none",
  projectionVersion: "world-v1",
};
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function unknownWorldProjection(subjectId: string, zoneId: string | null = null): WorldExperienceProjection {
  return {
    subjectId, zoneId, vibe: null, experienceState: null, worldMoment: null,
    forecast: null, opportunity: null, truthClass: "unknown", confidence: null,
    coverage: "no_coverage", freshness: "unknown", temporalSemantics: "now",
    observedAt: null, validUntil: null, provenance: UNKNOWN_PROVENANCE,
    safetyLevel: "unknown", switchingCost: 0,
    projectionId: null, projectionVersion: "world-v1",
    currentLabel: null,
    perKind: {},
  };
}

function boundedConfidence(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function parseJson(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") return parsed; } catch { /* malformed lineage */ }
  }
  return {};
}

function normalizeRows(rows: any[], subjectId: string, zoneId: string | null, now: Date): WorldExperienceProjection {
  if (!rows.length) return unknownWorldProjection(subjectId, zoneId);
  const first = rows[0];
  const values: Record<string, any> = {};
  const normalizedByKind = new Map<string, any>();
  let truthClass: WorldTruthClass = "unknown";
  let currentTruth: WorldTruthClass = "unknown";
  let state: string = "unknown";
  let coverage: WorldCoverage = "no_coverage";
  let validUntil: string | null = null;
  let observedAt: string | null = null;
  let temporalSemantics: WorldTemporalSemantics = "now";
  let provenance: WorldProvenance = UNKNOWN_PROVENANCE;
  let switchingCost = 0;
  for (const row of rows) {
    const rawValue = row.value;
    const value = parseJson(rawValue);
    const kind = String(row.projection_kind ?? "");
    const p = parseJson(row.provenance);
    const l = parseJson(row.lineage);
    const envelope = {
      row, value: Object.keys(value).length > 0 ? value : (rawValue == null ? {} : { label: String(rawValue) }),
      truthClass: (["observation", "inference", "prediction", "constraint"].includes(row.truth_class) ? row.truth_class : "unknown") as WorldTruthClass,
      state: row.state ?? "unknown", coverage: row.coverage ?? "no_coverage",
      validUntil: row.valid_until ?? null, observedAt: row.observed_at ?? null,
      temporalKind: row.temporal_kind ?? "current", confidence: boundedConfidence(row.confidence),
      provenance: {
        source: String(p.sourceClass ?? p.source ?? "world_projection"),
        method: String(p.method ?? "server_projection"),
        modelVersion: String(l.modelVersion ?? "unknown"),
        projectionVersion: String(l.contractVersion ?? "world-v1"),
      },
      freshness: row.state === "stale" || !row.valid_until || Date.parse(row.valid_until) <= now.getTime() ? "stale" : "fresh",
      shadow: row.shadow === true || row.state === "shadow",
    };
    if (kind) {
      values[kind] = envelope.value;
      normalizedByKind.set(kind, envelope);
    }
    if (["observation", "inference", "prediction", "constraint"].includes(row.truth_class)) {
      truthClass = row.truth_class;
      if (row.projection_kind !== "forecast") currentTruth = row.truth_class;
    }
    if (["unknown", "conflicting", "stale", "known"].includes(row.state)) state = row.state;
    if (row.coverage === "covered" || row.coverage === "partial" || row.coverage === "no_coverage") {
      coverage = row.coverage;
    }
    validUntil = validUntil ?? row.valid_until ?? null;
    observedAt = observedAt ?? row.observed_at ?? null;
    if (["current", "window", "historical", "forecast"].includes(row.temporal_kind)) temporalSemantics = row.temporal_kind;
    provenance = {
      source: String(p.sourceClass ?? p.source ?? "world_projection"),
      method: String(p.method ?? "server_projection"),
      modelVersion: String(l.modelVersion ?? "unknown"),
      projectionVersion: String(l.contractVersion ?? "world-v1"),
    };
    switchingCost = Math.max(switchingCost, Math.min(1, Number(value.friction ?? value.switchingCost ?? 0) || 0));
  }
  const currentRows = rows.filter((r) => r.projection_kind !== "forecast");
  const currentEligible = (kind: string) => {
    const e = normalizedByKind.get(kind);
    return e && e.freshness === "fresh" && !e.shadow && ["known"].includes(e.state) && ["covered", "partial"].includes(e.coverage) &&
      e.truthClass !== "conflicting" && e.truthClass !== "prediction" &&
      e.validUntil;
  };
  const currentKind = ["vibe", "experience_state", "world_moment"].find(currentEligible);
  const currentEnvelope = currentKind ? normalizedByKind.get(currentKind) : null;
  const perKind = Object.fromEntries(rows.map((r) => {
    const p = parseJson(r.provenance); const l = parseJson(r.lineage);
    return [String(r.projection_kind), {
      value: parseJson(r.value),
      id: String(r.id ?? ""), truthClass: r.truth_class ?? "unknown", state: r.state ?? "unknown",
      confidence: boundedConfidence(r.confidence), coverage: r.coverage ?? "no_coverage",
      freshness: (r.state === "stale" || !r.valid_until || Date.parse(r.valid_until) <= now.getTime() ? "stale" : "fresh") as WorldFreshness,
      observedAt: r.observed_at ?? null, validUntil: r.valid_until ?? null,
      temporalKind: r.temporal_kind ?? "current",
      provenance: { source: String(p.sourceClass ?? p.source ?? "world_projection"), method: String(p.method ?? "server_projection"), modelVersion: String(l.modelVersion ?? "unknown"), projectionVersion: String(l.contractVersion ?? "world-v1") },
      shadow: r.shadow === true || r.state === "shadow", projectionVersion: String(l.contractVersion ?? "world-v1"),
    }];
  }));
  const chosenCurrent = currentEnvelope?.row ?? null;
  const currentValidUntil = currentEnvelope?.validUntil ?? null;
  const currentStale = !currentEnvelope;
  const stateTruth: WorldTruthClass = currentEnvelope?.truthClass ?? "unknown";
  const vibeEnvelope = normalizedByKind.get("vibe");
  const experienceEnvelope = normalizedByKind.get("experience_state");
  const momentEnvelope = normalizedByKind.get("world_moment");
  const forecastEnvelope = normalizedByKind.get("forecast");
  const opportunityEnvelope = normalizedByKind.get("opportunity");
  const eligibleEnvelope = (e: any) => e && e.freshness === "fresh" && !e.shadow &&
    e.state === "known" && ["covered", "partial"].includes(e.coverage) &&
    e.truthClass !== "conflicting" && e.truthClass !== "unknown" && e.truthClass !== "prediction";
  const experience = eligibleEnvelope(experienceEnvelope) ? experienceEnvelope.value : {};
  const independentEligible = (e: any) => e && e.freshness === "fresh" && !e.shadow &&
    e.state === "known" && ["covered", "partial"].includes(e.coverage) && e.truthClass !== "conflicting";
  const forecast = independentEligible(forecastEnvelope) ? forecastEnvelope.value : {};
  const opportunity = independentEligible(opportunityEnvelope) ? opportunityEnvelope.value : {};
  const currentValue = currentEnvelope?.value ?? {};
  return {
    subjectId: String(first.subject_id ?? subjectId),
    zoneId: first.zone_id ?? zoneId,
    vibe: eligibleEnvelope(vibeEnvelope) ? (vibeEnvelope.value.label ?? vibeEnvelope.value.vibe ?? null) : null,
    experienceState: eligibleEnvelope(experienceEnvelope) ? (experience.crowd ?? experience.label ?? null) : null,
    worldMoment: eligibleEnvelope(momentEnvelope) ? (momentEnvelope.value.label ?? null) : null,
    forecast: forecast.expected ?? null,
    opportunity: [opportunity.action, opportunity.reason, opportunity.category]
      .filter((v) => typeof v === "string" && v.length > 0).join(" ") || null,
    truthClass: stateTruth,
    confidence: currentEnvelope?.confidence ?? null,
    coverage: currentEnvelope?.coverage ?? "no_coverage",
    freshness: currentStale ? "stale" : "fresh",
    temporalSemantics: currentEnvelope?.temporalKind ?? "now",
    observedAt: currentEnvelope?.observedAt ?? null,
    validUntil: currentValidUntil,
    provenance: currentEnvelope?.provenance ?? UNKNOWN_PROVENANCE,
    safetyLevel: eligibleEnvelope(experienceEnvelope)
      ? (experience.safety === "normal" || experience.safety === "clear" ? "clear"
        : experience.safety === "constrained" ? "caution" : "unknown")
      : "unknown",
    switchingCost: eligibleEnvelope(opportunityEnvelope)
      ? Math.max(0, Math.min(1, Number(opportunity.friction ?? opportunity.switchingCost ?? 0) || 0)) : 0,
    projectionId: chosenCurrent ? String(chosenCurrent.id ?? "") || null : null,
    projectionVersion: currentEnvelope?.provenance.projectionVersion ?? "unknown",
    currentLabel: currentEnvelope
      ? (currentValue.label ?? currentValue.crowd ?? null)
      : null,
    perKind,
  };
}

/**
 * Read one canonical projection. The dedicated store is preferred; the
 * existing privacy-gated snapshot is a narrow observation fallback. Query
 * errors never become fabricated world state.
 */
export async function readWorldExperience(
  db: SupabaseClient | null,
  subjectId: string | null | undefined,
  opts: { zoneId?: string | null; now?: Date; subjectKind?: "place" | "locality" } = {},
): Promise<WorldExperienceProjection> {
  const id = String(subjectId ?? "");
  const zone = opts.zoneId ?? null;
  const subjectKind = opts.subjectKind ?? "place";
  if (!db || !id) return unknownWorldProjection(id, zone);
  const now = opts.now ?? new Date();
  // subject_id is UUID-backed. Resolve human location text before *any*
  // subject_id query; PostgREST rejects text values against UUID columns.
  if (!isUuid(id)) {
    const resolved = await resolveWorldSubjectId(db, id, now);
    return resolved
      ? readWorldExperience(db, resolved.subjectId, { ...opts, subjectKind: resolved.subjectKind })
      : unknownWorldProjection(id, zone);
  }
  try {
    let query = db.from("world_experience_projections")
      .select("id, subject_id, zone_id, projection_kind, truth_class, state, confidence, coverage, value, observed_at, valid_until, temporal_kind, provenance, lineage")
      .eq("subject_kind", subjectKind).eq("subject_id", id)
      .in("projection_kind", ["vibe", "experience_state", "world_moment", "forecast", "opportunity"]);
    query = zone === null ? query.is("zone_id", null) : query.eq("zone_id", zone);
    const { data, error } = await query;
    if (!error && data?.length) return normalizeRows(data as any[], id, zone, now);
    if (!error && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      const canonicalId = await resolveWorldSubjectId(db, id, now);
      if (canonicalId && canonicalId.subjectId !== id) {
        return readWorldExperience(db, canonicalId.subjectId, { ...opts, subjectKind: canonicalId.subjectKind });
      }
    }
  } catch { /* optional rollout table */ }
  try {
    let query = db.from("intel_state_snapshots")
      .select("subject_id, zone_id, claim_type, value, confidence, observed_at, expires_at, privacy_eligible")
      .eq("subject_kind", subjectKind).eq("subject_id", id).eq("privacy_eligible", true)
      .in("claim_type", ["vibe", "experience.state", "crowd.level", "world_moment"])
      .gt("expires_at", now.toISOString());
    query = zone === null ? query.is("zone_id", null) : query.eq("zone_id", zone);
    const { data, error } = await query;
    if (!error && data?.length) {
      const supported = new Set(["vibe", "experience.state", "crowd.level", "world_moment"]);
      const rows = (data as any[]).filter((r) => supported.has(String(r.claim_type))).map((r) => ({
        ...r, projection_kind: r.claim_type === "experience.state" || r.claim_type === "crowd.level"
          ? "experience_state" : r.claim_type === "world_moment" ? "world_moment" : "vibe",
        truth_class: "observation", state: "known", coverage: "covered",
        temporal_kind: "current", valid_until: r.expires_at,
        provenance: { source: "intel_state_snapshots", method: "privacy_gated_observation" },
        lineage: { modelVersion: "none", contractVersion: "world-v1" },
      }));
      if (rows.length) return normalizeRows(rows, id, zone, now);
    }
  } catch { /* fail closed */ }
  return unknownWorldProjection(id, zone);
}

/** Resolve locality text to canonical_locations IDs, never to a venue ID. */
export async function resolveWorldSubjectId(db: SupabaseClient | null, subject: string | null | undefined, now = new Date()): Promise<WorldSubjectIdentity | null> {
  const value = String(subject ?? "").trim();
  if (!value) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return { subjectId: value, subjectKind: "place" };
  if (!db) return null;
  try {
    const key = searchKey(value);
    // A locality subject is the canonical_locations ID referenced by places,
    // not one of the matching venue IDs.
    const { data: cityRows } = await db.from("places")
      .select("id, city, neighborhood, country, canonical_location_id, status, merged_into_place_id")
      .or(`city.ilike.%${value}%,neighborhood.ilike.%${value}%`)
      .eq("status", "active").is("merged_into_place_id", null)
      .order("id", { ascending: true }).limit(200);
    const candidates = (cityRows as any[] ?? []);
    if (candidates.length) {
      const localityIds = [...new Set(candidates.map((r) => String(r.canonical_location_id ?? "")).filter(Boolean))];
      if (!localityIds.length) return null;
      const { data: localities, error: localityError } = await db.from("canonical_locations")
        .select("id, kind, normalized_name, country_code")
        .in("id", localityIds);
      if (localityError) return null;
      const allowed = new Set(["city", "town", "district", "neighborhood", "region"]);
      const matching = (localities as any[] ?? []).filter((r) =>
        allowed.has(String(r.kind).toLowerCase()) && String(r.normalized_name ?? "") === key);
      if (matching.length !== 1) return null;
      const canonicalId = String(matching[0].id);
      const { data: projections } = await db.from("world_experience_projections")
        .select("subject_id, subject_kind, valid_until, state, coverage")
        .eq("subject_kind", "locality").eq("subject_id", canonicalId)
        .eq("projection_kind", "experience_state").order("subject_id", { ascending: true });
      const nowMs = now.getTime();
      const fresh = new Set((projections as any[] ?? [])
        .filter((p) => p.subject_kind === "locality" && p.state === "known" && p.coverage !== "no_coverage" && p.valid_until && Date.parse(p.valid_until) > nowMs)
        .map((p) => String(p.subject_id)));
      return fresh.has(canonicalId) ? { subjectId: canonicalId, subjectKind: "locality" } : null;
    }
    return null;
  } catch { return null; }
}

export async function readWorldProjectionById(
  db: SupabaseClient | null, projectionId: string | null | undefined, now = new Date(),
): Promise<WorldExperienceProjection | null> {
  if (!db || !projectionId) return null;
  try {
    const { data, error } = await db.from("world_experience_projections")
      .select("*").eq("id", projectionId).maybeSingle();
    if (error || !data) return null;
    return normalizeRows([data], String(data.subject_id), data.zone_id ?? null, now);
  } catch { return null; }
}

export async function readPreviousWorldExperience(
  db: SupabaseClient | null, subjectId: string | WorldSubjectIdentity | null,
  opts: { zoneId?: string | null; before?: Date; subjectKind?: WorldSubjectKind } = {},
): Promise<WorldExperienceProjection | null> {
  if (!db || !subjectId) return null;
  const identity = typeof subjectId === "string"
    ? { subjectId, subjectKind: opts.subjectKind ?? "place" } : subjectId;
  try {
    let q = db.from("world_experience_projections").select("*")
      .eq("subject_kind", identity.subjectKind).eq("subject_id", identity.subjectId).eq("projection_kind", "experience_state");
    q = opts.zoneId == null ? q.is("zone_id", null) : q.eq("zone_id", opts.zoneId);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    const current = parseJson((data as any).value);
    const previous = parseJson(current.previousCurrent);
    if (!previous || !previous.value) return null;
    if (previous.subjectId && previous.subjectId !== identity.subjectId) return null;
    if (previous.subjectKind && previous.subjectKind !== identity.subjectKind) return null;
    if (previous.zoneId !== undefined && (previous.zoneId ?? null) !== (opts.zoneId ?? null)) return null;
    const currentLineage = parseJson((data as any).lineage);
    const previousLineage = parseJson(previous.versionLineage ?? previous.lineage);
    if (currentLineage.contractVersion && previousLineage.contractVersion &&
      currentLineage.contractVersion !== previousLineage.contractVersion) return null;
    const priorRow = {
      ...previous, id: previous.id ?? `${data.id}:previous`, subject_kind: identity.subjectKind, subject_id: identity.subjectId,
      zone_id: opts.zoneId ?? null, projection_kind: "experience_state",
      value: previous.value, truth_class: previous.truthClass ?? previous.truth_class,
      state: previous.state, coverage: previous.coverage,
      confidence: previous.confidence, observed_at: previous.observedAt ?? previous.observed_at,
      valid_until: previous.validUntil ?? previous.valid_until,
      temporal_kind: previous.temporalKind ?? previous.temporal_kind,
      provenance: previous.provenance, lineage: previous.versionLineage,
    };
    const result = normalizeRows([priorRow], identity.subjectId, opts.zoneId ?? null, opts.before ?? new Date());
    return result.freshness === "fresh" ? result : null;
  } catch { return null; }
}

export interface UnifiedNowProjection {
  state: WorldExperienceProjection;
  label: string | null;
  isKnown: boolean;
}

export function unifiedNowProjection(state: WorldExperienceProjection): UnifiedNowProjection {
  const usable = state.coverage !== "no_coverage" && state.freshness === "fresh" &&
    state.truthClass !== "prediction" && state.truthClass !== "unknown" &&
    state.truthClass !== "conflicting";
  const label = usable ? (state.currentLabel ?? state.experienceState ?? state.vibe ?? state.worldMoment) : null;
  return { state, label, isKnown: Boolean(label) };
}

export interface OpportunityDecision {
  allowed: boolean;
  reason: "safety" | "stale" | "no_coverage" | "switching_cost" | "allowed";
  score: number;
}

/** Safety outranks opportunity; switching cost prevents unstable recommendations. */
export function decideOpportunity(
  state: WorldExperienceProjection,
  opportunityScore: number,
  opts: { currentLabel?: string | null; candidateLabel?: string | null } = {},
): OpportunityDecision {
  if (state.safetyLevel === "blocked" || state.safetyLevel === "caution") return { allowed: false, reason: "safety", score: 0 };
  if (state.coverage === "no_coverage" || state.freshness !== "fresh") return { allowed: false, reason: state.coverage === "no_coverage" ? "no_coverage" : "stale", score: 0 };
  if (opts.currentLabel && opts.candidateLabel && opts.currentLabel !== opts.candidateLabel && state.switchingCost >= 0.75) {
    return { allowed: false, reason: "switching_cost", score: 0 };
  }
  return { allowed: true, reason: "allowed", score: Math.max(0, Math.min(1, opportunityScore)) };
}

export function worldSearchLabel(state: WorldExperienceProjection): string | null {
  const now = unifiedNowProjection(state);
  return now.isKnown ? now.label : null;
}

export function meaningfulWorldTransition(
  previous: WorldExperienceProjection | null,
  next: WorldExperienceProjection,
): { changed: boolean; from: string | null; to: string | null } {
  const from = previous && unifiedNowProjection(previous).label;
  const to = unifiedNowProjection(next).label;
  return { changed: Boolean(from && to && from !== to), from: from ?? null, to: to ?? null };
}

export function canonicalLiveReference(state: WorldExperienceProjection): {
  subjectId: string; projectionId: string | null; projectionVersion: string;
  validUntil: string | null; truthClass: WorldTruthClass; label: string | null;
} {
  return {
    subjectId: state.subjectId, projectionId: state.projectionId,
    projectionVersion: state.projectionVersion, validUntil: state.validUntil,
    truthClass: state.truthClass, label: worldSearchLabel(state),
  };
}

/** Required Attention gate: unknown/stale world state never creates urgency. */
export function attentionAllowed(state: WorldExperienceProjection): boolean {
  return state.coverage === "covered" && state.freshness === "fresh" &&
    state.truthClass !== "unknown" && state.truthClass !== "conflicting" &&
    state.safetyLevel === "clear" && Boolean(state.opportunity);
}