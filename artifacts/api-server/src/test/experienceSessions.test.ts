import test from "node:test";
import assert from "node:assert/strict";
import {
  startExperienceSession,
  recordExperienceOutcome,
  computeExperienceCalibration,
  EXPERIENCE_SESSION_VERSION,
} from "../services/experience/ExperienceSessionService.ts";

function dbFor(table: string, rows: any[] = []) {
  return {
    from(name: string) {
      assert.equal(name, table);
      return {
        select() { return this; }, eq() { return this; }, gte() { return this; },
        async maybeSingle() { return { data: rows[0] ?? null, error: null }; },
        async single() { return { data: rows[0] ?? null, error: null }; },
        async insert() { return { data: rows[0] ?? { id: "new" }, error: null }; },
      };
    },
  } as any;
}

test("session start rejects recommendations not served to the owner", async () => {
  const result = await startExperienceSession(dbFor("compass_served_recommendations"), "user-a", { recommendationId: "rec-a" });
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("outcomes cannot mutate another owner's or closed session", async () => {
  const result = await recordExperienceOutcome(dbFor("experience_sessions", [{
    id: "s", user_id: "owner-a", status: "completed", expires_at: new Date(Date.now() + 10000).toISOString(),
  }]), "owner-a", { sessionId: "s", outcome: "returned", confirmMemory: true });
  assert.equal(result.reason, "not_found");
});

test("calibration ignores invalid lineage and reports only canonical outcomes", async () => {
  const result = await computeExperienceCalibration({
    from() {
      return {
        select() { return this; }, gte: async () => ({
          data: [
            { outcome: "returned", memory_eligible: true, significance: "significant", calibration_version: "calibration-v1", projection_version: EXPERIENCE_SESSION_VERSION },
            { outcome: "bogus", memory_eligible: true, significance: "significant", calibration_version: "calibration-v1", projection_version: EXPERIENCE_SESSION_VERSION },
          ], error: null,
        }),
      };
    },
  } as any);
  assert.equal(result.outcomes, 1);
  assert.equal(result.eligibleOutcomes, 1);
});