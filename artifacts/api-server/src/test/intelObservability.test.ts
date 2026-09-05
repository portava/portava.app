/**
 * §24 / Table-32 observability report + its internal read.
 *
 * The property under test is the one the dashboards depend on: A NUMBER ON THE
 * SCREEN CARRIES ITS INSTRUMENTATION STATUS, and a metric this system does not
 * measure is ABSENT, never zero. So the suite proves, structurally rather than
 * example-by-example, that no UNINSTRUMENTED metric or distribution can ever
 * carry a value — including over an all-empty input, which is exactly the state
 * that tempts a report into printing zeros it has not earned.
 *
 * Also covered: each section's arithmetic against inputs whose right answer is
 * known by hand; the Table-32 metric list per section; the fail-closed density
 * gate; and the route's admin gate, window validation and DB-error handling.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/intelObservability.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import {
  buildObservabilityReport,
  type ObservabilityMetric,
  type ObservabilityReport,
  type ObservabilityRows,
} from "../lib/intelObservabilityReport.js";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 60 * 60_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 60 * 60_000).toISOString();
const ADMIN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const PLACE_A = "11111111-1111-4111-8111-111111111111";
const PLACE_B = "22222222-2222-4222-8222-222222222222";

const EMPTY: ObservabilityRows = { observations: [], claims: [], snapshots: [], confirmations: [] };

function build(rows: Partial<ObservabilityRows> = {}): ObservabilityReport {
  return buildObservabilityReport({ ...EMPTY, ...rows }, { now: NOW, windowDays: 7 });
}

function allMetrics(r: ObservabilityReport): ObservabilityMetric[] {
  return r.sections.flatMap((s) => s.metrics);
}

function metric(r: ObservabilityReport, key: string): ObservabilityMetric {
  const m = allMetrics(r).find((x) => x.key === key);
  assert.ok(m, `metric ${key} must exist`);
  return m;
}

function bucket(r: ObservabilityReport, distKey: string, bucketKey: string): number {
  const d = r.sections.flatMap((s) => s.distributions).find((x) => x.key === distKey);
  assert.ok(d, `distribution ${distKey} must exist`);
  assert.ok(d.buckets, `distribution ${distKey} must have buckets`);
  const b = d.buckets.find((x) => x.key === bucketKey);
  assert.ok(b, `bucket ${bucketKey} must exist in ${distKey}`);
  return b.count;
}

// ── The invariant, asserted structurally ─────────────────────────────────────

describe("§24 observability — an unmeasured metric is ABSENT, never zero", () => {
  it("no UNINSTRUMENTED metric or distribution carries a value, over an EMPTY input", () => {
    const r = build();
    const uninstrumentedMetrics = allMetrics(r).filter((m) => m.status === "UNINSTRUMENTED");
    assert.ok(uninstrumentedMetrics.length > 0, "the fixture must exercise real uninstrumented metrics");
    for (const m of uninstrumentedMetrics) {
      assert.equal(m.value, null, `${m.key} must have no value`);
      assert.equal(m.denominator, null, `${m.key} must have no denominator`);
      assert.ok(m.note && m.note.length > 0, `${m.key} must say why it is absent`);
    }
    for (const d of r.sections.flatMap((s) => s.distributions).filter((x) => x.status === "UNINSTRUMENTED")) {
      assert.equal(d.buckets, null, `${d.key} must have no buckets`);
      assert.ok(d.note && d.note.length > 0, `${d.key} must say why it is absent`);
    }
  });

  it("no UNINSTRUMENTED metric carries a value with a FULL input either", () => {
    const r = build({
      observations: [{ actor_id: "a", subject_id: PLACE_A, claim_type: "crowd.level", moderation_state: "allowed", observed_at: PAST, expires_at: FUTURE, source_class: "firsthand_unverified", group_key: "g1" }],
      claims: [{ subject_id: PLACE_A, claim_type: "crowd.level", status: "active", observed_at: PAST }],
      snapshots: [{ privacy_eligible: true, confidence_band: "live", expires_at: FUTURE, conflict_state: "none" }],
      confirmations: [{ stance: "agree" }],
      outcomes: [{ subject_id: PLACE_A, snapshot_id: "s1", outcome: "same", occurred_at: PAST, confidence: 0.8 }],
      rewards: [{ qiu: 1.5, earned_units: 3, cash_amount: 0 }],
      attributions: [{ outcome: "same", counterfactual: false, contradiction: false }],
    });
    for (const m of allMetrics(r).filter((x) => x.status === "UNINSTRUMENTED")) {
      assert.equal(m.value, null, `${m.key} must stay absent even with data present`);
    }
  });

  it("every MEASURED / UPPER_BOUND metric DOES carry a number (an absent status is not a hiding place)", () => {
    const r = build();
    for (const m of allMetrics(r).filter((x) => x.status !== "UNINSTRUMENTED")) {
      assert.equal(typeof m.value, "number", `${m.key} must report a figure`);
      assert.ok(Number.isFinite(m.value as number), `${m.key} must be finite`);
    }
  });

  it("every non-MEASURED metric explains itself", () => {
    const r = build();
    for (const m of allMetrics(r).filter((x) => x.status !== "MEASURED")) {
      assert.ok(m.note && m.note.length > 0, `${m.key} must carry a note`);
    }
  });
});

// ── Table-32 coverage ────────────────────────────────────────────────────────

describe("§24 observability — the four Table-32 dashboards", () => {
  it("returns exactly the four sections, each quoting its Table-32 requirement", () => {
    const r = build();
    assert.deepEqual(r.sections.map((s) => s.key), ["truth_health", "calibration", "decision", "economy"]);
    for (const s of r.sections) {
      assert.ok(s.requiredMetrics.length > 0, `${s.key} must quote Table 32`);
      assert.ok(s.metrics.length > 0, `${s.key} must have metrics`);
    }
  });

  it("Truth health covers all five Table-32 metrics", () => {
    const r = build();
    for (const k of ["servableLiveSnapshots", "materialConflictSnapshots", "expiryLatencySeconds", "sourceClassesRepresented", "correctionsAccepted"]) {
      metric(r, k);
    }
  });

  it("Calibration names every Table-32 breakdown dimension, instrumented or not", () => {
    const r = build();
    const dists = r.sections.find((s) => s.key === "calibration")!.distributions.map((d) => d.key);
    for (const k of ["accuracyByConfidenceBand", "accuracyByClaimFamily", "accuracyByCity", "accuracyByZone", "accuracyByHour", "accuracyBySourceClass"]) {
      assert.ok(dists.includes(k), `calibration must name ${k}`);
    }
  });

  it("Decision covers all five Table-32 metrics", () => {
    const r = build();
    for (const k of ["arrivalSuccess", "entrySuccess", "outcomesReported", "rerouteRecovery", "regretFeedbackAnswers"]) {
      metric(r, k);
    }
  });

  it("Economy covers all five Table-32 metrics", () => {
    const r = build();
    for (const k of ["qiuShadowTotal", "fundedCashPayouts", "fraudSignals", "apiAttributedRevenue", "apiMargin"]) {
      metric(r, k);
    }
  });
});

// ── Arithmetic ───────────────────────────────────────────────────────────────

describe("§24 observability — truth health arithmetic", () => {
  it("counts material conflicts against all snapshots, and never averages them away", () => {
    const r = build({
      snapshots: [
        { privacy_eligible: true, confidence_band: "live", expires_at: FUTURE, conflict_state: "material" },
        { privacy_eligible: true, confidence_band: "live", expires_at: FUTURE, conflict_state: "none" },
        { privacy_eligible: false, confidence_band: "provisional", expires_at: FUTURE, conflict_state: "material" },
      ],
    });
    const m = metric(r, "materialConflictSnapshots");
    assert.equal(m.value, 2);
    assert.equal(m.denominator, 3);
    assert.equal(bucket(r, "snapshotConflictState", "material"), 2);
    assert.equal(bucket(r, "snapshotConflictState", "none"), 1);
  });

  it("reads source diversity as the number of DISTINCT Appendix-A classes present", () => {
    const one = build({
      observations: [
        { actor_id: "a", subject_id: PLACE_A, claim_type: "c", moderation_state: "allowed", observed_at: PAST, source_class: "firsthand_unverified" },
        { actor_id: "b", subject_id: PLACE_A, claim_type: "c", moderation_state: "allowed", observed_at: PAST, source_class: "firsthand_unverified" },
      ],
    });
    assert.equal(metric(one, "sourceClassesRepresented").value, 1, "two rows of one class is still one class");

    const two = build({
      observations: [
        { actor_id: "a", subject_id: PLACE_A, claim_type: "c", moderation_state: "allowed", observed_at: PAST, source_class: "firsthand_unverified" },
        { actor_id: "b", subject_id: PLACE_A, claim_type: "c", moderation_state: "allowed", observed_at: PAST, source_class: "official_signed" },
      ],
    });
    assert.equal(metric(two, "sourceClassesRepresented").value, 2);
  });

  it("counts an accepted correction from either the superseded status or the supersession link", () => {
    const r = build({
      claims: [
        { subject_id: PLACE_A, claim_type: "c", status: "superseded", observed_at: PAST },
        { subject_id: PLACE_B, claim_type: "c", status: "active", observed_at: PAST, superseded_by: "later-claim" },
        { subject_id: PLACE_B, claim_type: "c", status: "active", observed_at: PAST },
      ],
    });
    assert.equal(metric(r, "correctionsAccepted").value, 2);
  });

  it("surfaces a source_class this build has never heard of instead of folding it into a real bucket", () => {
    const r = build({
      observations: [{ actor_id: "a", subject_id: PLACE_A, claim_type: "c", moderation_state: "allowed", observed_at: PAST, source_class: "telepathy" }],
    });
    const d = r.sections.flatMap((s) => s.distributions).find((x) => x.key === "observationSourceClass")!;
    assert.deepEqual(d.unknownValues, ["telepathy"]);
    assert.equal(metric(r, "sourceClassesRepresented").value, 0, "an unrecognised label proves no known diversity");
  });
});

describe("§24 observability — decision arithmetic", () => {
  const outcomes = [
    { subject_id: PLACE_A, snapshot_id: "s1", outcome: "same", occurred_at: PAST, confidence: 0.8 },
    { subject_id: PLACE_A, snapshot_id: "s2", outcome: "better", occurred_at: PAST, confidence: 0.8 },
    { subject_id: PLACE_A, snapshot_id: "s3", outcome: "did_not_go", occurred_at: PAST, confidence: 0.6 },
    { subject_id: PLACE_A, snapshot_id: "s4", outcome: "could_not_enter", occurred_at: PAST, confidence: 0.6 },
  ];

  it("arrival excludes only 'did_not_go'; entry is measured against arrivals, not all outcomes", () => {
    const r = build({ outcomes });
    assert.equal(metric(r, "outcomesReported").value, 4);
    const arrival = metric(r, "arrivalSuccess");
    assert.equal(arrival.value, 3);
    assert.equal(arrival.denominator, 4);
    const entry = metric(r, "entrySuccess");
    assert.equal(entry.value, 2, "one of the three arrivals could not enter");
    assert.equal(entry.denominator, 3, "entry can only fail after arriving");
  });

  it("distributes outcomes over the Appendix-A enum", () => {
    const r = build({ outcomes });
    assert.equal(bucket(r, "outcomeDistribution", "same"), 1);
    assert.equal(bucket(r, "outcomeDistribution", "did_not_go"), 1);
    assert.equal(bucket(r, "outcomeDistribution", "worse"), 0);
  });

  it("reports regret feedback from the attribution ledger without touching any claim", () => {
    const r = build({
      attributions: [
        { outcome: "same", counterfactual: true, contradiction: false },
        { outcome: "worse", counterfactual: false, contradiction: true },
        { outcome: "same", counterfactual: false, contradiction: false },
      ],
    });
    assert.equal(metric(r, "regretFeedbackAnswers").value, 3);
    assert.equal(metric(r, "counterfactualSameChoice").value, 1);
    assert.equal(metric(r, "contradictingOutcomes").value, 1);
  });
});

describe("§24 observability — calibration keeps the §37 truth boundary", () => {
  it("groups reported outcomes by SERVED band and refuses to call it accuracy", () => {
    const r = build({
      outcomes: [
        { subject_id: PLACE_A, snapshot_id: "s1", outcome: "same", occurred_at: PAST, confidence: 0.8 },   // live
        { subject_id: PLACE_A, snapshot_id: "s2", outcome: "worse", occurred_at: PAST, confidence: 0.6 },  // likely_current
        { subject_id: PLACE_A, snapshot_id: "s3", outcome: "same", occurred_at: PAST, confidence: null },  // unrecorded
      ],
    });
    assert.equal(bucket(r, "outcomesByServedConfidenceBand", "live"), 1);
    assert.equal(bucket(r, "outcomesByServedConfidenceBand", "likely_current"), 1);
    assert.equal(bucket(r, "outcomesByServedConfidenceBand", "(null)"), 1);
    // The accuracy figure itself stays absent — a satisfaction judgment is not
    // the crowd after-proof value, so it may not be presented as calibration.
    assert.equal(metric(r, "crowdCalibrationAccuracy").status, "UNINSTRUMENTED");
    assert.equal(metric(r, "crowdCalibrationAccuracy").value, null);
  });

  it("keeps the density gate fail-closed: never certifiable while an input is uninstrumented", () => {
    const r = build();
    assert.equal(r.densityGate.certifiable, false);
    assert.ok(r.densityGate.uninstrumented.length > 0);
    assert.ok(r.densityGate.failures.length > 0, "an empty pipeline clears nothing");
  });

  it("marks contributor counts as an UPPER_BOUND — reliability is not modelled", () => {
    const r = build({
      observations: [
        { actor_id: "a", subject_id: PLACE_A, zone_id: "z1", claim_type: "c", moderation_state: "allowed", observed_at: PAST },
        { actor_id: "b", subject_id: PLACE_A, zone_id: "z1", claim_type: "c", moderation_state: "allowed", observed_at: PAST },
      ],
    });
    const m = metric(r, "activeContributorsCitywide");
    assert.equal(m.status, "UPPER_BOUND");
    assert.equal(m.value, 2);
  });
});

describe("§24 observability — economy", () => {
  it("sums the shadow ledger and reports the structural cash-zero as measured", () => {
    const r = build({ rewards: [{ qiu: 1.25, earned_units: 2, cash_amount: 0 }, { qiu: 0.75, earned_units: 1, cash_amount: 0 }] });
    assert.equal(metric(r, "ledgerEntries").value, 2);
    assert.equal(metric(r, "qiuShadowTotal").value, 2);
    assert.equal(metric(r, "earnedUnitsTotal").value, 3);
    const cash = metric(r, "fundedCashPayouts");
    assert.equal(cash.status, "MEASURED", "the cash zero is a schema property, not an unmeasured metric");
    assert.equal(cash.value, 0);
    assert.match(cash.note ?? "", /cash_amount = 0/);
  });

  it("tolerates numeric columns arriving as strings (PostgREST numeric)", () => {
    const r = build({ rewards: [{ qiu: "1.5" as unknown as number, earned_units: "2" as unknown as number, cash_amount: "0" as unknown as number }] });
    assert.equal(metric(r, "qiuShadowTotal").value, 1.5);
    assert.equal(metric(r, "earnedUnitsTotal").value, 2);
  });
});

// ── The route ────────────────────────────────────────────────────────────────

interface RouteOpts { role?: string; fail?: string }

function makeClient(opts: RouteOpts = {}) {
  const tables: Record<string, any[]> = {
    intel_observations: [{ actor_id: "a", subject_id: PLACE_A, zone_id: "z1", claim_type: "crowd.level", moderation_state: "allowed", observed_at: PAST, expires_at: FUTURE, group_key: "g1", party_size_bucket: "solo", source_class: "firsthand_unverified" }],
    intel_claims: [{ subject_id: PLACE_A, claim_type: "crowd.level", status: "active", observed_at: PAST, superseded_by: null }],
    intel_state_snapshots: [{ privacy_eligible: true, confidence_band: "live", expires_at: FUTURE, conflict_state: "none" }],
    intel_confirmations: [{ stance: "agree" }],
    // ONE real outcome event (verb 'completion', the 'same' outcome) plus the
    // three NON-outcome intel domain events lib/intelDomainEvents emits. All
    // four carry a payload.intel envelope, so a reader that filters only on
    // `payload->intel is not null` counts the system transitions as outcomes.
    canonical_events: [
      { verb: "completion", subject_id: PLACE_A, occurred_at: PAST, confidence: 0.8, payload: { intel: { snapshot_id: "s1", outcome: "same", subject_id: PLACE_A } } },
      { verb: "intel.observation.recorded", subject_id: PLACE_A, occurred_at: PAST, confidence: null, payload: { intel: { observation_id: "o1", subject_id: PLACE_A, claim_type: "crowd.level", actor_id: "a" } } },
      { verb: "intel.claim.promoted", subject_id: PLACE_A, occurred_at: PAST, confidence: 0.8, payload: { intel: { claim_id: "c1", subject_id: PLACE_A, claim_type: "crowd.level", promotion_source: "system" } } },
      { verb: "intel.state.changed", subject_id: PLACE_A, occurred_at: PAST, confidence: 0.8, payload: { intel: { snapshot_id: "s9", subject_id: PLACE_A, transition: "appeared" } } },
    ],
    intel_reward_ledger: [{ qiu: 2, earned_units: 4, cash_amount: 0 }],
    intel_attributions: [{ outcome: "same", counterfactual: true, contradiction: false }],
  };
  return {
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async getUser(token: string) {
        if (token === "valid-token") return { data: { user: { id: ADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "bad token" } };
      },
    },
    from(table: string) {
      if (table === "profiles") {
        const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { account_status: "active", role: opts.role ?? "admin" }, error: null }) };
        return q;
      }
      // `.in()` is applied for real, not swallowed: a passthrough fake would let
      // a reader that forgot its verb filter still look correct here.
      const ins: [string, readonly unknown[]][] = [];
      const q: any = {
        select: () => q, eq: () => q, gte: () => q, gt: () => q, or: () => q, not: () => q, order: () => q,
        in: (col: string, vals: readonly unknown[]) => { ins.push([col, vals]); return q; },
      };
      q.limit = () => Promise.resolve(
        opts.fail === table
          ? { data: null, error: { message: "boom" } }
          : { data: (tables[table] ?? []).filter((r) => ins.every(([c, vs]) => vs.includes((r as any)[c]))), error: null },
      );
      return q;
    },
  };
}

async function makeApp(): Promise<Express> {
  const { default: observabilityRouter } = await import("../routes/intelObservability.js");
  const app = express();
  app.use(express.json());
  app.use("/api", observabilityRouter);
  return app;
}

async function req(app: Express, path: string, token = "valid-token"): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const PATH = "/api/v1/internal/intel/observability";
let app: Express;

describe("GET /v1/internal/intel/observability — internal, admin-only", () => {
  before(async () => { app = await makeApp(); });
  after(() => { _setTestClient(null, false); });

  it("401s without a token", async () => {
    _setTestClient(makeClient(), true);
    assert.equal((await req(app, PATH, "")).status, 401);
  });

  it("403s a non-admin — this is never a client-facing surface", async () => {
    _setTestClient(makeClient({ role: "user" }), true);
    assert.equal((await req(app, PATH)).status, 403);
  });

  it("serves the four sections and the fail-closed density gate to an admin", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await req(app, PATH);
    assert.equal(status, 200);
    assert.deepEqual(body.sections.map((s: any) => s.key), ["truth_health", "calibration", "decision", "economy"]);
    assert.equal(body.densityGate.certifiable, false);
    assert.equal(body.windowDays, 7);
    assert.equal(body.schemaVersion, 1);
  });

  it("carries the fetched rows into the report (the reads are wired, not decorative)", async () => {
    _setTestClient(makeClient(), true);
    const { body } = await req(app, PATH);
    const find = (k: string) => body.sections.flatMap((s: any) => s.metrics).find((m: any) => m.key === k);
    assert.equal(find("qiuShadowTotal").value, 2, "reward ledger read");
    assert.equal(find("counterfactualSameChoice").value, 1, "attribution ledger read");
    assert.equal(find("outcomesReported").value, 1, "outcome events read");
    assert.equal(find("sourceClassesRepresented").value, 1, "observation source_class read");
  });

  it("counts ONLY outcome-verb events — an intel domain event is not a reported outcome", async () => {
    // Regression: `payload->intel is not null` alone matches every intel domain
    // event. The fixture holds 1 real outcome + 3 system transitions
    // (intel.observation.recorded / intel.claim.promoted / intel.state.changed).
    // Without the OUTCOME_VERBS filter this read returned 4 outcomes, and since
    // decisionSection derives arrival as total − did_not_go, all 3 transitions
    // were reported as travelers who successfully arrived.
    _setTestClient(makeClient(), true);
    const { body } = await req(app, PATH);
    const find = (k: string) => body.sections.flatMap((s: any) => s.metrics).find((m: any) => m.key === k);
    const dist = (k: string) => body.sections.flatMap((s: any) => s.distributions ?? []).find((d: any) => d.key === k);

    assert.equal(find("outcomesReported").value, 1, "3 non-outcome intel events must not be counted as outcomes");
    assert.equal(find("arrivalSuccess").value, 1);
    assert.equal(find("arrivalSuccess").denominator, 1, "denominator is outcomes, not all intel events");
    assert.equal(find("entrySuccess").value, 1);
    assert.equal(find("entrySuccess").denominator, 1);

    // The served-band and outcome distributions must not carry the transitions
    // either — a promoted claim has no `outcome`, so it would land in a null
    // bucket and look like an unclassifiable traveler report.
    const byBand = dist("outcomesByServedConfidenceBand");
    assert.equal(byBand.buckets.reduce((n: number, b: any) => n + b.count, 0), 1);
    const byOutcome = dist("outcomeDistribution");
    assert.equal(byOutcome.buckets.reduce((n: number, b: any) => n + b.count, 0), 1);
    assert.equal(byOutcome.buckets.find((b: any) => b.key === "same").count, 1);
    assert.deepEqual(byOutcome.unknownValues ?? [], [], "no unclassifiable outcome values survive the verb filter");
  });

  it("still returns 'not instrumented' (never zero) over the wire", async () => {
    _setTestClient(makeClient(), true);
    const { body } = await req(app, PATH);
    const uninstrumented = body.sections.flatMap((s: any) => s.metrics).filter((m: any) => m.status === "UNINSTRUMENTED");
    assert.ok(uninstrumented.length > 0);
    for (const m of uninstrumented) assert.equal(m.value, null, `${m.key} must survive JSON as null`);
  });

  it("rejects an out-of-range window rather than silently clamping it", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await req(app, `${PATH}?windowDays=900`);
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("fails closed on a read error instead of reporting an empty pipeline", async () => {
    _setTestClient(makeClient({ fail: "intel_reward_ledger" }), true);
    const { status, body } = await req(app, PATH);
    assert.equal(status, 500);
    assert.equal(body.error, "db_error");
  });
});
