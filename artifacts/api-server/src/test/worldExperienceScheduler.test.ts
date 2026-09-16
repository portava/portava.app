import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runWorldExperiencePass } from "../lib/worldExperienceScheduler.js";

test("producer is inert without a client", async () => {
  const result = await runWorldExperiencePass({ client: null });
  assert.equal(result.reason, "no_client");
  assert.equal(result.written, 0);
});

test("producer is fail-closed when rollout flag is unreadable/off", async () => {
  const db = {
    from() {
      const q: any = {
        select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: null, error: null }),
      };
      return q;
    },
  };
  const result = await runWorldExperiencePass({ client: db });
  assert.equal(result.reason, "disabled");
  assert.equal(result.written, 0);
});

test("producer upserts all five projection kinds from privacy-safe snapshots", async () => {
  const writes: any[] = [];
  const db = {
    from(table: string) {
      let flag = "";
      const q: any = {
        select() { return q; }, eq(column: string, value: unknown) { if (column === "flag") flag = String(value); return q; }, gt() { return q; }, limit() { return q; },
        in() { return q; }, upsert(row: any) { writes.push({ table, row }); return Promise.resolve({ error: null }); },
        maybeSingle: async () => table === "feature_flags"
          ? { data: { enabled: flag === "intel_world_experience" }, error: null } : { data: null, error: null },
        then(resolve: (v: any) => unknown) {
          if (table === "intel_state_snapshots") return resolve({
            data: [{ id: "s1", subject_id: "p1", zone_id: "terminal-a", claim_type: "crowd.level", value: { level: "busy" }, confidence: .8, observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T01:00:00Z" },
              { id: "s2", subject_id: "p1", zone_id: "terminal-a", claim_type: "crowd.trajectory", value: { trajectory: "peaking" }, confidence: .8, observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T01:00:00Z" },
              { id: "s3", subject_id: "p1", zone_id: "terminal-a", claim_type: "safety.constraint", value: { constrained: true, provenance: { sourceClass: "official_signed" } }, confidence: 1, observed_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T01:00:00Z" }], error: null,
          });
          if (table === "places") return resolve({ data: [{ id: "p1", status: "active", merged_into_place_id: null }], error: null });
          return resolve({ data: [], error: null });
        },
      };
      return q;
    },
  };
  const result = await runWorldExperiencePass({ client: db, now: new Date("2026-01-01T00:10:00Z") });
  assert.equal(result.written, 5);
  assert.deepEqual(writes.map((w) => w.row.projection_kind).sort(),
    ["experience_state", "forecast", "opportunity", "vibe", "world_moment"]);
  assert.equal(writes.find((w) => w.row.projection_kind === "experience_state").row.value.safety, "unknown");
  assert.equal(writes.find((w) => w.row.projection_kind === "forecast").row.state, "unknown");
  assert.equal(writes.find((w) => w.row.projection_kind === "opportunity").row.valid_until, "2026-01-01T01:00:00.000Z");
});

test("projection migration is service-role-only and has a deterministic key", async () => {
  const sql = await readFile(resolve(process.cwd(), "src/migrations/2264_world_experience_intelligence.sql"), "utf8");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /zone_id TEXT/);
  assert.match(sql, /REVOKE ALL ON public\.world_experience_projections FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /TO service_role/);
  assert.match(sql, /world_experience_upsert_key/);
  assert.match(sql, /subject_kind, subject_id, zone_key, projection_kind/);
  assert.match(sql, /world_experience_subject_kind_check/);
  assert.match(sql, /'place','locality'/);
  assert.match(sql, /world_safety_constraints/);
  assert.match(sql, /REVOKE ALL ON public\.world_safety_constraints FROM PUBLIC, anon, authenticated/);
});

test("world producer never promotes user-owned layover recommendations to safety", async () => {
  const source = await readFile(resolve(process.cwd(), "src/lib/worldExperienceScheduler.ts"), "utf8");
  assert.doesNotMatch(source, /layover_recommendations|LayoverSafetyEngine/);
  assert.match(source, /safety\.constraint/);
});

test("admin safety writes require the shared admin guard and service client", async () => {
  const source = await readFile(resolve(process.cwd(), "src/routes/worldSafety.ts"), "utf8");
  assert.match(source, /requireAdmin/);
  assert.match(source, /getServiceClient/);
  assert.match(source, /validUntil/);
  assert.match(source, /typeof constrained !== "boolean"/);
});