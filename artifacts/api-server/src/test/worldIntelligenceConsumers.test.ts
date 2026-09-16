import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionAllowed,
  decideOpportunity,
  unifiedNowProjection,
  unknownWorldProjection,
  worldSearchLabel,
  readWorldExperience,
  readPreviousWorldExperience,
} from "../services/intelligence/worldIntelligence.js";

test("world adapter distinguishes no coverage from a quiet observation", () => {
  const unknown = unknownWorldProjection("city-a");
  assert.equal(unknown.coverage, "no_coverage");
  assert.equal(worldSearchLabel(unknown), null);
  assert.equal(attentionAllowed(unknown), false);
  const quiet = {
    ...unknown,
    coverage: "covered" as const,
    freshness: "fresh" as const,
    truthClass: "observation" as const,
    experienceState: "quiet",
    opportunity: "walk",
    safetyLevel: "clear" as const,
  };
  assert.equal(unifiedNowProjection(quiet).label, "quiet");
  assert.equal(attentionAllowed(quiet), true);
});

test("predictions do not become now labels and safety outranks opportunity", () => {
  const prediction = {
    ...unknownWorldProjection("city-a"),
    coverage: "covered" as const,
    freshness: "fresh" as const,
    truthClass: "prediction" as const,
    forecast: "busy",
  };
  assert.equal(unifiedNowProjection(prediction).isKnown, false);
  const blocked = { ...prediction, truthClass: "observation" as const, safetyLevel: "blocked" as const };
  assert.deepEqual(decideOpportunity(blocked, 1), { allowed: false, reason: "safety", score: 0 });
});

test("switching cost prevents unstable opportunity changes", () => {
  const state = {
    ...unknownWorldProjection("city-a"),
    coverage: "covered" as const,
    freshness: "fresh" as const,
    truthClass: "observation" as const,
    switchingCost: 0.9,
  };
  assert.equal(decideOpportunity(state, 1, { currentLabel: "rest", candidateLabel: "nightlife" }).reason, "switching_cost");
  assert.equal(decideOpportunity(state, 1, { currentLabel: "rest", candidateLabel: "rest" }).allowed, true);
});

test("reads migration 2264 rows by projection kind and merges them", async () => {
  const rows = [
    { subject_id: "00000000-0000-4000-8000-000000000001", zone_id: null, projection_kind: "vibe", truth_class: "observation", state: "known", confidence: 0.8, coverage: "covered", value: { label: "social" }, valid_until: "2030-01-01T00:00:00.000Z", temporal_kind: "current", provenance: { sourceClass: "verified_firsthand", method: "aggregate" }, lineage: { modelVersion: "m1", contractVersion: "world-experience/v1" } },
    { subject_id: "00000000-0000-4000-8000-000000000001", zone_id: null, projection_kind: "experience_state", truth_class: "observation", state: "known", confidence: 0.7, coverage: "covered", value: { crowd: "busy", safety: "normal" }, valid_until: "2030-01-01T00:00:00.000Z", temporal_kind: "current", provenance: { sourceClass: "verified_firsthand", method: "aggregate" }, lineage: { modelVersion: "m1", contractVersion: "world-experience/v1" } },
    { subject_id: "00000000-0000-4000-8000-000000000001", zone_id: null, projection_kind: "forecast", truth_class: "prediction", state: "known", confidence: 0.6, coverage: "covered", value: { expected: "rain" }, valid_until: "2030-01-01T00:00:00.000Z", temporal_kind: "forecast", provenance: { sourceClass: "portava_prediction", method: "forecast" }, lineage: { modelVersion: "m2", contractVersion: "world-experience/v1" } },
  ];
  const db: any = {
    from(table: string) {
      const query: any = {
        select() { return query; }, eq() { return query; }, in() { return query; },
        is() { return query; }, gt() { return query; },
        then(resolve: (v: any) => void) {
          resolve(table === "world_experience_projections" ? { data: rows, error: null } : { data: [], error: null });
        },
      };
      return query;
    },
  };
  const projection = await readWorldExperience(db, "00000000-0000-4000-8000-000000000001", { now: new Date("2029-01-01T00:00:00.000Z") });
  assert.equal(projection.vibe, "social");
  assert.equal(projection.experienceState, "busy");
  assert.equal(projection.forecast, "rain");
  assert.equal(projection.temporalSemantics, "current");
  // The forecast remains separate and does not poison the current observation.
  assert.equal(unifiedNowProjection(projection).label, "social");
});

test("unsupported snapshots are not promoted to a full world projection", async () => {
  const db: any = {
    from(table: string) {
      const query: any = {
        select() { return query; }, eq() { return query; }, in() { return query; },
        is() { return query; }, gt() { return query; },
        then(resolve: (v: any) => void) {
          resolve(table === "world_experience_projections"
            ? { data: null, error: { message: "missing" } }
            : { data: [{ subject_id: "city-a", zone_id: null, claim_type: "temperature", value: { c: 20 }, confidence: 1, observed_at: "2029-01-01T00:00:00Z", expires_at: "2030-01-01T00:00:00Z" }], error: null });
        },
      };
      return query;
    },
  };
  const projection = await readWorldExperience(db, "city-a", { now: new Date("2029-01-01T00:00:00.000Z") });
  assert.equal(projection.coverage, "no_coverage");
  assert.equal(projection.vibe, null);
  assert.equal(unifiedNowProjection(projection).isKnown, false);
});

test("previous transition state comes only from embedded ExperienceState lineage", async () => {
  const db: any = {
    from() {
      const q: any = {
        select() { return q; }, eq() { return q; }, is() { return q; },
        maybeSingle() {
          return Promise.resolve({ error: null, data: {
            id: "current", subject_id: "city-a", zone_id: null, projection_kind: "experience_state",
            state: "known", coverage: "covered", confidence: 0.8,
            valid_until: "2030-01-01T00:00:00Z", lineage: { contractVersion: "v1" },
            value: { crowd: "busy", previousCurrent: {
              id: "previous", subjectId: "city-a", zoneId: null, state: "known",
              coverage: "covered", confidence: 0.7, validUntil: "2030-01-01T00:00:00Z",
              value: { crowd: "quiet" }, truthClass: "observation",
              lineage: { contractVersion: "v1" },
            } },
          } });
        },
      };
      return q;
    },
  };
  const previous = await readPreviousWorldExperience(db, "city-a", { before: new Date("2029-01-01") });
  assert.equal(previous?.experienceState, "quiet");
  assert.equal(previous?.projectionId, "previous");
});