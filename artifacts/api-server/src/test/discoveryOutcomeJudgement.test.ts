/**
 * census-discovery §82 (lane W10-O) — DV-19 / D-3: what "improves" means, and
 * the `01` §12 items whose input exists, measured.
 *
 * Decisions (docs/architecture/discovery-decision-register.md):
 *   D-W10-O-10  "improves": per serve point, both arms at or above
 *               OUTCOME_MIN_SAMPLE_PER_ARM on the metric's own denominator; a
 *               two-proportion z at or beyond OUTCOME_Z_CRITICAL on BOTH funnel
 *               bounds, with at least OUTCOME_MIN_RELATIVE_CHANGE; creator HHI
 *               by a relative margin. PDE "improves" only when an INTENT metric
 *               (useful saves or itinerary additions) improves somewhere and NO
 *               measured metric worsens anywhere. Place opens alone never
 *               suffice (`01` §12: raw engagement is not the sole criterion).
 *               "New-creator" = new to the PLATFORM (`01` §1, §10).
 *   D-W10-O-11  §12's "low regret/hide/report rates" are three rates: hide =
 *               the "Not interested" dismiss rate (D-W10-O-6), report = the
 *               viewer's place report within 7 days of the exposure, regret = a
 *               positive outcome followed by the same viewer dismissing the same
 *               item on a later exposure within 30 days.
 *
 *   J1  the registry: all eleven §12 items; five unmeasured (no possible
 *       input), each naming what is missing; four read from the enrichment.
 *   J2  enrichment not read ⇒ the four are UNOBSERVED — never 0, never
 *       "unmeasured".
 *   J3  the four figures over a controlled enrichment: regret, report, creator
 *       HHI and coverage, new-creator share.
 *   J4  the judgement: improves / does_not_improve / insufficient_sample, and
 *       the two rules that stop engagement alone from counting.
 *   J5  every threshold is a named value.
 *   J6  the enrichment SQL is reads only, and no user id leaves the database.
 *   J7  the judgement says what it does NOT cover, and what evidence it is.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryOutcomeJudgement.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOME_METRICS,
  buildOutcomeReport,
  judgeOutcomeImprovement,
  renderOutcomeJudgement,
  OUTCOME_ENRICHMENT_SQL,
  OUTCOME_MIN_SAMPLE_PER_ARM,
  OUTCOME_Z_CRITICAL,
  OUTCOME_MIN_RELATIVE_CHANGE,
  CREATOR_HHI_MIN_RELATIVE_CHANGE,
  NEW_CREATOR_WINDOW_DAYS,
  REPORT_ATTRIBUTION_WINDOW_DAYS,
  REGRET_WINDOW_DAYS,
  twoProportionZ,
  type ExposureEnrichment,
} from "../lib/discoveryOutcomeReport.js";
import { WRITE_KEYWORDS } from "../lib/discoveryTraceRead.js";
import { DISCOVERY_MODEL_VERSION, DISCOVERY_PDE_MODEL_VERSION } from "../lib/discoveryRankProvenance.js";

const SP = 1;
let seq = 0;
/** A served exposure row as the trace read returns it. */
function ex(arm: "pde" | "legacy", outcome: string, sp = SP, servedAt = "2026-09-20T10:00:00.000Z") {
  seq += 1;
  return {
    id: `x${seq}`, surface: "discovery", event_type: null, outcome, item_id: `db/${seq}`, served_at: servedAt,
    features: { modelVersion: arm === "pde" ? DISCOVERY_PDE_MODEL_VERSION : DISCOVERY_MODEL_VERSION, servePoint: sp },
  };
}
/** n exposures of one arm: `counts` of each outcome, the rest impressions. */
function arm(a: "pde" | "legacy", n: number, counts: Record<string, number>, sp = SP) {
  const out: ReturnType<typeof ex>[] = [];
  for (const [o, k] of Object.entries(counts)) for (let i = 0; i < k; i++) out.push(ex(a, o, sp));
  while (out.length < n) out.push(ex(a, "impression", sp));
  return out;
}

describe("J1–J3. the registry and the enriched figures", () => {
  it("J1. all eleven `01` §12 items; five unmeasured with the missing input named; four enriched", () => {
    const specs = new Set(OUTCOME_METRICS.map((m) => m.spec.split(" — ")[0]));
    for (const item of ["useful saves", "itinerary additions", "place opens", "completed visits", "event attendance",
      "successful trip actions", "creator diversity", "new-creator discovery", "Trail freshness", "repeat traveler satisfaction"]) {
      assert.ok(specs.has(item), `§12's "${item}" is not accounted for`);
    }
    assert.ok(OUTCOME_METRICS.some((m) => /hide rate/.test(m.spec)) && OUTCOME_METRICS.some((m) => /regret rate/.test(m.spec)) && OUTCOME_METRICS.some((m) => /report rate/.test(m.spec)),
      "low regret/hide/report is three rates");
    const r = buildOutcomeReport([], null);
    assert.deepEqual(r.unmeasured.map((u) => u.id), ["completed_visits", "event_attendance", "successful_trip_actions", "trail_freshness", "repeat_traveler_satisfaction"]);
    assert.deepEqual(OUTCOME_METRICS.filter((m) => m.status === "enriched").map((m) => m.id), ["low_regret", "report_rate", "creator_diversity", "new_creator_discovery"]);
    const hide = OUTCOME_METRICS.find((m) => m.id === "dismiss_rate")!;
    assert.match(hide.spec, /hide rate/);
    assert.match(hide.spec, /not_interested/);
  });

  it("J2. enrichment not read ⇒ the four are UNOBSERVED, never 0 and never 'unmeasured'", () => {
    const r = buildOutcomeReport([...arm("pde", 10, { save: 2 }), ...arm("legacy", 10, {})], null);
    for (const c of r.arms) {
      for (const id of ["low_regret", "report_rate", "creator_diversity", "new_creator_discovery"]) {
        assert.equal(c.enriched[id]!.status, "unobserved", `${c.arm}/${id}`);
        assert.equal("share" in c.enriched[id]!, false);
      }
    }
  });

  it("J3. the four figures over a controlled enrichment", () => {
    seq = 0;
    const rows = [ex("pde", "save"), ex("pde", "tap"), ex("pde", "impression"), ex("pde", "impression")];
    const enrich = new Map<string, ExposureEnrichment>([
      ["x1", { creator: "c1", creatorFirstAt: "2026-09-10T00:00:00Z", reportable: true, reported: false, regretted: true }],
      ["x2", { creator: "c1", creatorFirstAt: "2026-09-10T00:00:00Z", reportable: true, reported: true, regretted: false }],
      ["x3", { creator: "c2", creatorFirstAt: "2025-01-01T00:00:00Z", reportable: true, reported: false, regretted: false }],
      ["x4", { creator: null, creatorFirstAt: null, reportable: false, reported: false, regretted: false }],
    ]);
    const c = buildOutcomeReport(rows, null, enrich).arms.find((a) => a.arm === "pde")!;
    assert.deepEqual(c.enriched["low_regret"], { status: "measured", n: 2, count: 1, share: 0.5 }, "regret: of the 2 positive outcomes, 1 later dismissed");
    assert.deepEqual(c.enriched["report_rate"], { status: "measured", n: 3, count: 1, share: 1 / 3 }, "report: of the 3 reportable exposures");
    const cd = c.enriched["creator_diversity"]!;
    assert.equal(cd.status, "measured");
    if (cd.status === "measured" && "hhi" in cd) {
      assert.equal(cd.n, 3); assert.equal(cd.creators, 2);
      assert.ok(Math.abs(cd.hhi - ((2 / 3) ** 2 + (1 / 3) ** 2)) < 1e-12);
      assert.equal(cd.coverage, 3 / 4);
    } else assert.fail("creator_diversity carries an HHI");
    assert.deepEqual(c.enriched["new_creator_discovery"], { status: "measured", n: 3, count: 2, share: 2 / 3 },
      `c1 first submitted 10 days before the exposure (< ${NEW_CREATOR_WINDOW_DAYS} d): new; c2 in 2025: not`);
    const legacy = buildOutcomeReport(rows, null, enrich).arms.find((a) => a.arm === "legacy")!;
    assert.equal(legacy.enriched["low_regret"]!.status, "insufficient_sample", "an empty arm is insufficient, never 0 %");
  });
});

describe("J4. the judgement", () => {
  const N = OUTCOME_MIN_SAMPLE_PER_ARM;

  it("J4a. PDE significantly better on saves, nothing worse ⇒ improves", () => {
    const j = judgeOutcomeImprovement(buildOutcomeReport([...arm("pde", N, { save: 200 }), ...arm("legacy", N, { save: 100 })], null));
    assert.equal(j.verdict, "improves");
    const s = j.servePoints.find((p) => p.servePoint === SP)!;
    assert.equal(s.metrics["useful_saves"]!.result, "improves");
    assert.equal(s.metrics["dismiss_rate"]!.result, "no_difference");
  });

  it("J4b. the same saves win with the hide rate significantly worse ⇒ does_not_improve", () => {
    const j = judgeOutcomeImprovement(buildOutcomeReport([...arm("pde", N, { save: 200, dismiss: 150 }), ...arm("legacy", N, { save: 100, dismiss: 50 })], null));
    assert.equal(j.verdict, "does_not_improve");
    assert.equal(j.servePoints[0]!.metrics["dismiss_rate"]!.result, "worsens");
  });

  it("J4c. place opens alone never suffice: raw engagement is not the criterion", () => {
    const j = judgeOutcomeImprovement(buildOutcomeReport([...arm("pde", N, { tap: 400 }), ...arm("legacy", N, { tap: 100 })], null));
    assert.equal(j.servePoints[0]!.metrics["place_opens"]!.result, "improves");
    assert.equal(j.verdict, "does_not_improve");
  });

  it("J4d. below the per-arm sample at every serve point ⇒ insufficient_sample, not a verdict", () => {
    const j = judgeOutcomeImprovement(buildOutcomeReport([...arm("pde", N - 1, { save: 500 }), ...arm("legacy", N, { save: 1 })], null));
    assert.equal(j.verdict, "insufficient_sample");
    assert.equal(j.servePoints[0]!.metrics["useful_saves"]!.result, "insufficient_sample");
  });

  it("J4e. significant on one funnel bound and not the other is not an improvement", () => {
    // lower bound (save) much better; upper bound (save+trip_add+attended) equal.
    const j = judgeOutcomeImprovement(buildOutcomeReport([...arm("pde", N, { save: 200 }), ...arm("legacy", N, { save: 100, trip_add: 100 })], null));
    assert.equal(j.servePoints[0]!.metrics["useful_saves"]!.result, "no_difference");
  });

  it("J4f. a tiny relative change is not an improvement even when z clears", () => {
    const big = 400_000;
    const j = judgeOutcomeImprovement(buildOutcomeReport([...arm("pde", big, { save: 102_000 }), ...arm("legacy", big, { save: 100_000 })], null));
    assert.ok(twoProportionZ(102_000, big, 100_000, big) > OUTCOME_Z_CRITICAL, "precondition: z clears");
    assert.equal(j.servePoints[0]!.metrics["useful_saves"]!.result, "no_difference", "a 2 % relative change is below the 5 % bar");
  });

  it("J4g. serve points are judged apart, never pooled: a win at one and a loss at another is does_not_improve", () => {
    const rows = [
      ...arm("pde", N, { save: 200 }, 1), ...arm("legacy", N, { save: 100 }, 1),
      ...arm("pde", N, { save: 50 }, 2), ...arm("legacy", N, { save: 150 }, 2),
    ];
    const j = judgeOutcomeImprovement(buildOutcomeReport(rows, null));
    assert.equal(j.verdict, "does_not_improve");
  });

  it("J4h. creator concentration worsening by the relative margin blocks an improvement", () => {
    seq = 0;
    const p = arm("pde", N, { save: 200 }), l = arm("legacy", N, { save: 100 });
    const e = new Map<string, ExposureEnrichment>();
    p.forEach((r, i) => e.set(r.id, { creator: i % 2 === 0 ? "c1" : "c1", creatorFirstAt: "2020-01-01T00:00:00Z", reportable: true, reported: false, regretted: false }));
    l.forEach((r, i) => e.set(r.id, { creator: `c${i % 4}`, creatorFirstAt: "2020-01-01T00:00:00Z", reportable: true, reported: false, regretted: false }));
    const j = judgeOutcomeImprovement(buildOutcomeReport([...p, ...l], null, e));
    assert.equal(j.servePoints[0]!.metrics["creator_diversity"]!.result, "worsens");
    assert.equal(j.verdict, "does_not_improve");
  });
});

describe("J5–J7. values, the read, and what the judgement is", () => {
  it("J5. every threshold is a named value, and the register records them", () => {
    assert.deepEqual(
      [OUTCOME_MIN_SAMPLE_PER_ARM, OUTCOME_Z_CRITICAL, OUTCOME_MIN_RELATIVE_CHANGE, CREATOR_HHI_MIN_RELATIVE_CHANGE, NEW_CREATOR_WINDOW_DAYS, REPORT_ATTRIBUTION_WINDOW_DAYS, REGRET_WINDOW_DAYS],
      [1000, 1.96, 0.05, 0.10, 30, 7, 30]);
  });

  it("J6. the enrichment SQL is reads only, and no user id leaves the database", () => {
    assert.doesNotMatch(OUTCOME_ENRICHMENT_SQL, WRITE_KEYWORDS);
    const projection = OUTCOME_ENRICHMENT_SQL.slice(OUTCOME_ENRICHMENT_SQL.lastIndexOf("SELECT COALESCE"));
    assert.doesNotMatch(projection, /\b(user_id|reporter_id)\b/, "the final projection names no viewer");
    assert.match(OUTCOME_ENRICHMENT_SQL, /md5\(p\.submitted_by::text\) AS creator/, "the creator leaves only as a hash");
    assert.match(OUTCOME_ENRICHMENT_SQL, /CASE WHEN .*~\* '\^db\//, "the uuid cast is guarded by CASE, so a non-community id never reaches it");
  });

  it("J7. the judgement names what it cannot see, and says whose evidence it is", () => {
    const j = judgeOutcomeImprovement(buildOutcomeReport([...arm("pde", 10, {}), ...arm("legacy", 10, {})], null));
    assert.deepEqual(j.notCovered.map((u) => u.id), ["completed_visits", "event_attendance", "successful_trip_actions", "trail_freshness", "repeat_traveler_satisfaction"]);
    const text = renderOutcomeJudgement(j);
    assert.match(text, /6 of `01` §12's 11 items/);
    assert.match(text, /evidence only about the database it was read from/);
    assert.match(text, /completed_visits/);
  });
});
