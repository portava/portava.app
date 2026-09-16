/**
 * World Experience producer. Reads only privacy-gated derived snapshots,
 * assembles canonical place subjects, and writes deterministic projections.
 */
import { getServiceClient } from "./supabase.js";
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
import { inferExperienceState, inferVibe, inferWorldMoment, forecast, rankOpportunity, runInShadow, type WorldSignals } from "./worldExperienceEngine.js";

const FLAG = "intel_world_experience";
const LIVE_FLAG = "intel_world_experience_live";
const STARTUP_DELAY_MS = 6 * 60_000;
const INTERVAL_MS = 5 * 60_000;
let _timer: ReturnType<typeof setTimeout> | null = null;

export interface WorldExperiencePassResult {
  written: number; skipped: number; subjects: number; shadow: boolean;
  skippedRun: boolean; reason: "disabled" | "no_client" | "error" | null;
}

function subjectKey(subjectKind: "place" | "locality", subjectId: string, zoneId: string | null): string {
  return `${subjectKind}|${subjectId}|${zoneId ?? ""}`;
}

function toSignals(subjectId: string, zoneId: string | null, rows: any[], now: Date, subjectKind: "place" | "locality" = "place"): WorldSignals {
  const crowd = rows.find((r) => r.claim_type === "crowd.level");
  const trajectory = rows.find((r) => r.claim_type === "crowd.trajectory");
  // Safety is deliberately narrower than anomaly: only an explicit,
  // authoritative safety.constraint claim can constrain or clear an action.
  const sourceIds = rows.flatMap((r) => r.source_ids ?? [r.id]).map(String).filter(Boolean);
  const confidence = rows.reduce((n, r) => Math.max(n, Number(r.confidence) || 0), 0);
  const observed = rows.map((r) => Date.parse(r.observed_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const expiry = rows.map((r) => Date.parse(r.expires_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const value = (row: any, key: string) =>
    typeof row?.value === "string" ? row.value : row?.value?.[key];
  return {
    subject: { subjectKind: subjectKind as any, subjectId, zoneId },
    coverage: rows.length ? (crowd && trajectory ? "covered" : "partial") : "no_coverage",
    crowd: value(crowd, "level") ?? undefined,
    trajectory: value(trajectory, "trajectory") ?? undefined,
    crowdConfidence: confidence,
    anomaly: rows.some((r) => r.claim_type === "crowd.trajectory" && r.confidence < .35),
    observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : undefined,
    validUntil: Number.isFinite(expiry) ? new Date(expiry).toISOString() : undefined,
    sourceIds,
    safetyConstraint: (() => {
      const values = rows.filter((r) => r.authoritativeSafety).map((r) => r.value?.constrained)
        .filter((v) => typeof v === "boolean");
      return values.some((v) => v === true) ? true : values.length && values.every((v) => v === false) ? false : null;
    })(),
    safetyProvenance: rows.find((r) => r.authoritativeSafety)?.advisoryProvenance,
    sourceClass: rows.some((r) => r.authoritativeSafety) ? "official_signed" : "firsthand_unverified",
  };
}

function rowFor(p: any, kind: string, now: Date): Record<string, unknown> {
  return {
    id: p.id, subject_kind: p.subject.subjectKind, subject_id: p.subject.subjectId,
    zone_id: p.subject.zoneId, zone_key: p.subject.zoneId ?? "",
    projection_kind: kind, truth_class: p.truthClass, state: p.state,
    confidence: p.confidence, coverage: p.coverage, value: p.value,
    observed_at: p.freshness.observedAt, valid_until: p.freshness.validUntil,
    temporal_kind: p.temporal.kind, starts_at: p.temporal.startsAt, ends_at: p.temporal.endsAt,
    provenance: p.provenance, lineage: p.lineage, updated_at: now.toISOString(),
  };
}

export async function runWorldExperiencePass(opts: { client?: any; now?: Date } = {}): Promise<WorldExperiencePassResult> {
  const empty = (reason: WorldExperiencePassResult["reason"], shadow = true): WorldExperiencePassResult =>
    { return { written: 0, skipped: 0, subjects: 0, shadow, skippedRun: true, reason }; };
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return empty("no_client");
  if (!(await isFlagEnabled(db, FLAG))) return empty("disabled");
  const now = opts.now ?? new Date();
  const shadow = !(await isFlagEnabled(db, LIVE_FLAG));
  try {
    const { data, error } = await db.from("intel_state_snapshots")
      .select("id, subject_id, zone_id, claim_type, value, confidence, observed_at, expires_at")
      .eq("privacy_eligible", true).gt("expires_at", now.toISOString()).limit(10000);
    if (error) { logger.warn({ err: error }, "world experience: snapshot read failed"); return empty("error", shadow); }
    const { data: safetyRows } = await db.from("world_safety_constraints")
      .select("id, place_id, zone_id, constrained, valid_until, provenance, updated_at, updated_by")
      .gt("valid_until", now.toISOString()).limit(10000);
    const groups = new Map<string, { subjectId: string; zoneId: string | null; rows: any[]; subjectKind?: "place" | "locality" }>();
    for (const row of (data ?? []) as any[]) {
      if (!row.subject_id) continue;
      const zoneId = row.zone_id || null;
      const key = subjectKey("place", String(row.subject_id), zoneId);
      const g: { subjectId: string; zoneId: string | null; rows: any[]; subjectKind?: "place" | "locality" } =
        groups.get(key) ?? { subjectId: String(row.subject_id), zoneId, rows: [] as any[] };
      g.rows.push(row); groups.set(key, g);
    }
    // Canonical identity: a projection is about a known public place only.
    const ids = [...new Set([
      ...[...groups.values()].map((g) => g.subjectId),
      ...(safetyRows ?? []).map((r: any) => String(r.place_id)),
    ])];
    if (!ids.length) return { ...empty(null, shadow), skippedRun: false };
    const { data: places, error: placeError } = await db.from("places")
      .select("id, status, merged_into_place_id, canonical_location_id").in("id", ids);
    if (placeError) return empty("error", shadow);
    const canonical = new Set((places ?? []).filter((p: any) =>
      p.status === "active" && !p.merged_into_place_id).map((p: any) => String(p.id)));
    const localityIds = [...new Set((places ?? []).map((p: any) => p.canonical_location_id).filter(Boolean))];
    const { data: localities } = localityIds.length
      ? await db.from("canonical_locations").select("id, kind").in("id", localityIds)
      : { data: [] };
    const validLocalityIds = new Set((localities ?? []).filter((l: any) =>
      ["city", "town", "district", "neighborhood"].includes(String(l.kind).toLowerCase())).map((l: any) => String(l.id)));
    const localityByPlace = new Map<string, string>((places ?? []).filter((p: any) =>
      p.status === "active" && !p.merged_into_place_id && p.canonical_location_id &&
      validLocalityIds.has(String(p.canonical_location_id)))
      .map((p: any) => [String(p.id), String(p.canonical_location_id)]));
    // The only authoritative safety input is the service-only admin advisory
    // store. Snapshot JSON cannot self-declare authority and is ignored here.
    try {
      for (const r of (safetyRows ?? []) as any[]) {
        if (!canonical.has(String(r.place_id)) || !r.valid_until) continue;
        const exact = subjectKey("place", String(r.place_id), r.zone_id || null);
        const g: any = groups.get(exact) ?? { subjectId: String(r.place_id), zoneId: r.zone_id || null, rows: [] as any[] };
        groups.set(exact, g);
        g.rows.push({
          id: String(r.id),
          claim_type: "safety.constraint",
          value: { constrained: r.constrained, provenance: r.provenance },
          authoritativeSafety: true,
          advisoryProvenance: { ...r.provenance, advisoryId: r.id, updatedAt: r.updated_at, updatedBy: r.updated_by },
          confidence: 1, observed_at: r.updated_at ?? now.toISOString(), expires_at: r.valid_until,
        });
      }
      for (const r of (safetyRows ?? []) as any[]) {
        if (r.zone_id || !canonical.has(String(r.place_id))) continue;
        for (const g of groups.values()) {
          if (g.subjectId !== String(r.place_id) || !g.zoneId) continue;
          g.rows.push({
            id: String(r.id),
            claim_type: "safety.constraint",
            value: { constrained: r.constrained, provenance: r.provenance },
            authoritativeSafety: true,
            advisoryProvenance: { ...r.provenance, advisoryId: r.id, updatedAt: r.updated_at, updatedBy: r.updated_by },
            confidence: 1, observed_at: r.updated_at ?? now.toISOString(), expires_at: r.valid_until,
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, "world experience: safety advisory store unavailable");
    }
    // Locality projections require at least two independently covered places.
    const localityRepresented = new Map<string, any[]>();
    for (const g of groups.values()) {
      if (g.subjectKind !== "locality" && !g.zoneId && localityByPlace.has(g.subjectId)) {
        const id = localityByPlace.get(g.subjectId)!;
        const list = localityRepresented.get(id) ?? []; list.push(g); localityRepresented.set(id, list);
      }
    }
    const localityGroups = new Map<string, any[]>();
    for (const g of groups.values()) {
      if (g.subjectKind === "locality" || g.zoneId || !localityByPlace.has(g.subjectId)) continue;
      const crowd = g.rows.find((r) => r.claim_type === "crowd.level");
      const trajectory = g.rows.find((r) => r.claim_type === "crowd.trajectory");
      if (!crowd || !trajectory) continue;
      const id = localityByPlace.get(g.subjectId)!;
      const list = localityGroups.get(String(id)) ?? []; list.push(g); localityGroups.set(String(id), list);
    }
    for (const localityId of localityRepresented.keys()) {
      const members = localityGroups.get(localityId) ?? [];
      if (members.length < 2) {
        groups.set(subjectKey("locality", localityId, null), { subjectId: localityId, zoneId: null, rows: [], subjectKind: "locality" });
        continue;
      }
      const choose = (claim: string, key: string) => {
        const counts = new Map<string, { n: number; row: any }>();
        for (const m of members) {
          const r = m.rows.find((x: any) => x.claim_type === claim);
          const value = typeof r.value === "string" ? r.value : r.value?.[key];
          const item = counts.get(String(value)) ?? { n: 0, row: r }; item.n++; counts.set(String(value), item);
        }
        return [...counts.values()].sort((a, b) => b.n - a.n)[0].row;
      };
      const rows = [choose("crowd.level", "level"), choose("crowd.trajectory", "trajectory")]
        .map((r) => ({ ...r, id: `locality:${localityId}:${r.id}`,
          source_ids: members.flatMap((m) => m.rows.map((x: any) => String(x.id))) }));
      groups.set(subjectKey("locality", localityId, null), { subjectId: localityId, zoneId: null, rows, subjectKind: "locality" });
    }
    let written = 0, skipped = 0;
    for (const g of groups.values()) {
      if (g.subjectKind !== "locality" && !canonical.has(g.subjectId)) { skipped++; continue; }
      const s = toSignals(g.subjectId, g.zoneId, g.rows, now, g.subjectKind ?? "place");
      const vibe = inferVibe(s, now);
      const state = inferExperienceState(s, now);
      const moment = inferWorldMoment(s, now);
      const expected = s.crowd ?? "unknown";
      const prediction = forecast({ ...s, expected, probability: s.crowdConfidence ?? 0, startsAt: s.validUntil ?? now.toISOString() }, now);
      const opportunity = rankOpportunity({ subject: s.subject, action: "visit", reason: "current conditions", confidence: s.crowdConfidence ?? 0,
        safetyCleared: s.safetyConstraint === null ? null : !s.safetyConstraint, friction: .2, coverage: s.coverage,
        sourceIds: s.sourceIds, validUntil: s.validUntil ?? null, safetyProvenance: s.safetyProvenance, now });
      // Preserve the previous current state for transition-aware consumers.
      let previousCurrent: unknown = null;
      try {
        let priorQuery = db.from("world_experience_projections")
          .select("id, subject_id, zone_id, value, state, coverage, confidence, truth_class, temporal_kind, provenance, lineage, observed_at, valid_until")
          .eq("subject_kind", g.subjectKind ?? "place").eq("subject_id", g.subjectId)
          .eq("projection_kind", "experience_state");
        priorQuery = g.zoneId == null ? priorQuery.is("zone_id", null) : priorQuery.eq("zone_id", g.zoneId);
        const prior = await priorQuery.maybeSingle();
        if (prior?.data) {
          const r = prior.data;
          const boundedValue = r.value && typeof r.value === "object"
            ? { ...(r.value as Record<string, unknown>) } : r.value;
          if (boundedValue && typeof boundedValue === "object") {
            delete (boundedValue as Record<string, unknown>).previousCurrent;
          }
          previousCurrent = {
            value: boundedValue, state: r.state, coverage: r.coverage, confidence: r.confidence,
            truthClass: r.truth_class, temporalSemantics: r.temporal_kind,
            provenance: r.provenance, versionLineage: r.lineage,
            observedAt: r.observed_at, validUntil: r.valid_until,
            subjectId: r.subject_id, zoneId: r.zone_id, id: r.id,
          };
        }
      } catch { /* persistence remains fail-soft */ }
      if (previousCurrent && state.value) {
        state.value = { ...state.value, previousCurrent } as typeof state.value;
      }
      const projections = [
        runInShadow(vibe, false), runInShadow(state, false), runInShadow(moment, false),
        runInShadow(prediction, shadow), runInShadow(opportunity, shadow),
      ];
      for (const p of projections) {
        const kind = p.id.split(":")[0];
        const projectionKind = kind === "state" ? "experience_state" : kind === "moment" ? "world_moment" : kind;
        const { error: writeError } = await db.from("world_experience_projections")
          .upsert(rowFor(p, projectionKind, now), { onConflict: "subject_kind,subject_id,zone_key,projection_kind" });
        if (writeError) { skipped++; logger.warn({ err: writeError }, "world experience: projection upsert failed"); }
        else written++;
      }
    }
    return { written, skipped, subjects: groups.size, shadow, skippedRun: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "world experience pass threw");
    return empty("error", shadow);
  }
}

export function startWorldExperienceScheduler(): void {
  if (_timer !== null) return;
  _timer = setTimeout(function tick() {
    void runWorldExperiencePass().catch((err) => logger.warn({ err }, "world experience pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopWorldExperienceScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}