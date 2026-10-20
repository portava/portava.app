import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { readLayoverLive } from "../services/airport/LayoverRecommendationService.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";

const session = { id: "live-read-session", vibeChips: ["quiet"] };
const now = Date.parse("2026-10-19T12:00:00Z");
const candidates = [{ key: "place:a", subjectId: "subject-a", travelTimeMin: 10, activityTimeMin: 30 }];
const flags = ["layover_live_intersection_enabled", "intel_live_label_crowd", "intel_claim_projection_crowd", "intel_capture_quick_signal", "intel_limited_live"].map(flag => ({ flag, enabled: true }));
const tables = () => ({ feature_flags: flags, intel_live_promoted_scopes: [{ scope_key: "|queue.wait" }], intel_state_snapshots: [] });
const db = (data = tables(), failures: Record<string, { message: string }> = {}) => makeLayoverDb(data, { failures }) as unknown as SupabaseClient;

describe("L294 live recommendation evidence carries failed reads explicitly", () => {
  beforeEach(_clearPromotedScopeCache);
  it("successful empty evidence remains an ordinary read, with no invented queue", async () => {
    const r = await readLayoverLive(db(), session, candidates, now);
    assert.equal(r.kind, "read"); if (r.kind !== "read") return;
    assert.equal(r.value.byKey.get("place:a")?.evidence, "none");
    assert.equal(r.value.byKey.get("place:a")?.adjustedActivityMin, 30);
  });
  it("an unresolved PostgREST error is degraded, not no observations", async () => {
    const r = await readLayoverLive(db(tables(), { "intel_state_snapshots:select": { message: "forced unavailable" } }), session, candidates, now);
    assert.equal(r.kind, "degraded"); if (r.kind !== "degraded") return;
    assert.deepEqual(r.reasons, ["live_claim_read_failed"]);
    assert.equal(r.fallback.byKey.get("place:a")?.evidence, "unreadable");
    assert.equal(r.fallback.byKey.get("place:a")?.drop, false);
  });
  it("an unreadable promotion allowlist also carries the upstream failure marker", async () => {
    const r = await readLayoverLive(db(tables(), { "intel_live_promoted_scopes:select": { message: "forced unavailable" } }), session, candidates, now);
    assert.equal(r.kind, "degraded"); if (r.kind === "degraded") assert.deepEqual(r.reasons, ["live_claim_read_failed"]);
  });
  it("unreadable flag differs from an intentionally disabled pass", async () => {
    const failed = await readLayoverLive(db(tables(), { "feature_flags:select": { message: "forced unavailable" } }), session, candidates, now);
    assert.equal(failed.kind, "degraded"); if (failed.kind === "degraded") assert.deepEqual(failed.reasons, ["live_flag_unreadable"]);
    const disabled = await readLayoverLive(db({ ...tables(), feature_flags: [] }), session, candidates, now);
    assert.equal(disabled.kind, "read"); if (disabled.kind === "read") assert.equal(disabled.value.applied, false);
  });
  it("closed live gates disclose that claims could not be used", async () => {
    const r = await readLayoverLive(db({ ...tables(), feature_flags: [{ flag: "layover_live_intersection_enabled", enabled: true }] }), session, candidates, now);
    assert.equal(r.kind, "degraded"); if (r.kind === "degraded") assert.deepEqual(r.reasons, ["live_gates_closed_or_unreadable"]);
  });
});
