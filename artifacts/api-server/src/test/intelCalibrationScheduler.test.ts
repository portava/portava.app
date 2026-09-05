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
    // `.in()` filters for real — a passthrough would let a reader that dropped
    // its verb filter still look correct.
    const ins: [string, readonly unknown[]][] = [];
    const b: any = {
      select: () => b, insert: () => { wrote = true; st.op = "insert"; return b; },
      eq: (k: string, v: any) => { st.flag = k === "flag" ? v : st.flag; return b; },
      in: (col: string, vals: readonly unknown[]) => { ins.push([col, vals]); return b; },
      gte: () => b, or: () => b, not: () => b, limit: () => Promise.resolve(run()),
      maybeSingle: () => Promise.resolve(run()),
      then: (res: any) => Promise.resolve(run()).then(res),
    };
    function run() {
      if (name === "feature_flags") return { data: { enabled: Boolean(cfg.flags[st.flag]) }, error: null };
      const rows = (tables[name] ?? []).filter((r) => ins.every(([c, vs]) => vs.includes((r as any)[c])));
      return { data: rows, error: null };
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

  it("counts only outcome-verb events as outcomes — an intel domain event is not one", async () => {
    // Regression: the canonical_events read matched on `payload->intel is not
    // null` alone, but lib/intelDomainEvents gives intel.observation.recorded,
    // intel.claim.promoted and intel.state.changed the SAME payload envelope.
    // Those system transitions were then tallied as "finalized intel outcome
    // events" (intelFunnelReport density.outcomeConfirmations), inflating the
    // density gate's outcome evidence with things no traveler reported.
    const db = makeDb({
      flags: { intel_calibration_report: true },
      tables: {
        canonical_events: [
          { verb: "completion", subject_id: "p1", occurred_at: "2026-09-04T12:00:00.000Z", payload: { intel: { snapshot_id: "s1", outcome: "same", subject_id: "p1" } } },
          { verb: "rejection", subject_id: "p1", occurred_at: "2026-09-04T12:00:00.000Z", payload: { intel: { snapshot_id: "s2", outcome: "did_not_go", subject_id: "p1" } } },
          { verb: "intel.observation.recorded", subject_id: "p1", occurred_at: "2026-09-04T12:00:00.000Z", payload: { intel: { observation_id: "o1", subject_id: "p1" } } },
          { verb: "intel.claim.promoted", subject_id: "p1", occurred_at: "2026-09-04T12:00:00.000Z", payload: { intel: { claim_id: "c1", subject_id: "p1" } } },
          { verb: "intel.state.changed", subject_id: "p1", occurred_at: "2026-09-04T12:00:00.000Z", payload: { intel: { snapshot_id: "s3", subject_id: "p1" } } },
        ],
      },
    });
    const r = await runCalibrationReportPass({ client: db as any, now: new Date("2026-09-04T20:00:00.000Z") });
    assert.equal(r.skipped, false);
    assert.equal(r.outcomes, 2, "5 intel-envelope events, only 2 of them outcomes");
    assert.equal(r.certifiable, false, "still fail-closed — the gate is not bought with system transitions");
  });
});
