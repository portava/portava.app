/**
 * IG §21 daily calibration/density report scheduler.
 *
 * Proves: flag-gated (intel_calibration_report) and fail-closed — off ⇒ an inert
 * no-op; on ⇒ it tallies the funnel + density assessment and reports NOT
 * certifiable (the honest fail-closed state while inputs are uninstrumented),
 * writing nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCalibrationReportPass } from "../lib/intelCalibrationScheduler.js";

function makeDb(cfg: { flags: Record<string, boolean>; tables?: Record<string, any[]> }) {
  const tables = cfg.tables ?? {};
  let wrote = false;
  function from(name: string) {
    const st: any = { op: "select" };
    const b: any = {
      select: () => b, insert: () => { wrote = true; st.op = "insert"; return b; },
      eq: (k: string, v: any) => { st.flag = k === "flag" ? v : st.flag; return b; },
      gte: () => b, or: () => b, not: () => b, limit: () => Promise.resolve(run()),
      maybeSingle: () => Promise.resolve(run()),
      then: (res: any) => Promise.resolve(run()).then(res),
    };
    function run() {
      if (name === "feature_flags") return { data: { enabled: Boolean(cfg.flags[st.flag]) }, error: null };
      return { data: tables[name] ?? [], error: null };
    }
    return b;
  }
  return { from, _wrote: () => wrote };
}

describe("intelCalibrationScheduler — flag gating (fail-closed)", () => {
  it("is an inert no-op when the flag is off", async () => {
    const db = makeDb({ flags: { intel_calibration_report: false } });
    const r = await runCalibrationReportPass({ client: db as any });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "disabled");
    assert.equal(db._wrote(), false);
  });

  it("runs read-only and reports NOT certifiable when enabled", async () => {
    const db = makeDb({
      flags: { intel_calibration_report: true },
      tables: { intel_observations: [{ actor_id: "a1", subject_id: "p1", claim_type: "crowd.level", moderation_state: "allowed", observed_at: "2026-09-04T12:00:00.000Z", expires_at: "2999-01-01T00:00:00.000Z" }] },
    });
    const r = await runCalibrationReportPass({ client: db as any, now: new Date("2026-09-04T20:00:00.000Z") });
    assert.equal(r.skipped, false);
    assert.equal(r.certifiable, false, "never certifiable while inputs are uninstrumented");
    assert.ok(r.uninstrumented.includes("crowdCalibrationAccuracy"));
    assert.equal(db._wrote(), false, "the report is read-only");
  });
});
