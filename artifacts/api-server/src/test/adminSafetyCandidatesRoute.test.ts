/**
 * Sensing §16 through the REAL routes — POST /api/admin/intel/safety-
 * candidates/scan and GET /api/admin/intel/safety-candidates behind
 * `intel_safety_candidates_enabled` (migration 2803, seeded FALSE) and
 * requireAdmin, over the fake PostgREST double the Map gateway suites use.
 *
 * OFF is the load-bearing case: with the flag absent or false both routes
 * answer feature_disabled and write nothing. ON: a non-admin is forbidden
 * before anything is read; a scan files ONE moderation_reports row per new
 * candidate — place, safety_concern, no reporter, details the candidate —
 * and files nothing for a candidate already before a reviewer; live
 * intelligence not servable is a refusal; a history that cannot be read is
 * a per-subject refusal, never "no candidate"; the sweep looks only at
 * places served as packed; the list serves the detector's own rows and not
 * a person's report.
 *
 * fakeMapDb refuses writes by design; the scan cases wrap its client so
 * `moderation_reports` records the insert and answers RETURNING.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import adminSafetyCandidatesRouter from "../routes/adminSafetyCandidates.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _setTestClient } from "../lib/http.js";
import { SAFETY_CANDIDATE_DETAILS_PREFIX, parseCandidateDetails } from "../lib/safetyCandidate.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const ADMIN = "77777777-aaaa-4aaa-8aaa-777777777777";
const MEMBER = "66666666-aaaa-4aaa-8aaa-666666666666";
const TOKEN = "safety-candidates-token";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";
const QUIET_ID = "99999999-cccc-4ccc-8ccc-999999999999";
const REPORT_ID = "33333333-eeee-4eee-8eee-333333333333";
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const ON = { flag: "intel_safety_candidates_enabled", enabled: true };
const OFF = { flag: "intel_safety_candidates_enabled", enabled: false };

function snapshot(subject: string, claimType: string, value: unknown, over: Record<string, unknown> = {}) {
  return {
    id: `snap-${subject.slice(0, 4)}-${claimType}`,
    subject_id: subject,
    zone_id: null,
    claim_type: claimType,
    value,
    confidence: 0.85,
    source_count: 30,
    observed_at: iso(-3),
    expires_at: iso(27),
    privacy_eligible: true,
    conflict_state: "none",
    source_class: "firsthand_unverified",
    computed_at: iso(-3),
    ...over,
  };
}
function version(subject: string, level: string, generatedMinutes: number) {
  return {
    id: `ver-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: subject,
    zone_id: "",
    claim_type: "crowd.level",
    value: { level },
    privacy_eligible: true,
    observed_at: iso(generatedMinutes - 1),
    generated_at: iso(generatedMinutes),
  };
}

function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    profiles: [
      { id: ADMIN, role: "admin", handle: "ops" },
      { id: MEMBER, role: "member", handle: "someone" },
    ],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }],
    intel_state_snapshots: [
      snapshot(PLACE_ID, "crowd.level", { level: "packed" }),
      snapshot(PLACE_ID, "crowd.trajectory", { trajectory: "building" }),
      snapshot(QUIET_ID, "crowd.level", { level: "quiet" }),
    ],
    intel_state_snapshot_versions: [version(PLACE_ID, "quiet", -20)],
    moderation_reports: [],
    ...over,
  };
}

interface Inserted {
  rows: Array<Record<string, unknown>>;
}

function writableReports(app: ProjectionApp, inserted: Inserted, opts: { failInsert?: boolean } = {}) {
  const base = app.client;
  const wrapped = {
    ...base,
    from(table: string) {
      const q = base.from(table);
      if (table !== "moderation_reports") return q;
      return {
        ...q,
        insert(row: Record<string, unknown>) {
          return {
            select() {
              return {
                single: async () => {
                  if (opts.failInsert) return { data: null, error: { code: "42501", message: "denied" } };
                  const stored = { id: `${REPORT_ID.slice(0, -1)}${inserted.rows.length}`, created_at: iso(0), ...row };
                  inserted.rows.push(stored);
                  return { data: { id: stored.id }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  _setTestClient(wrapped, true);
}

function candidateReport(subject: string, reason: string, over: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    reporter_id: null,
    subject_type: "place",
    subject_id: subject,
    subject_user_id: null,
    category: "safety_concern",
    details: `${SAFETY_CANDIDATE_DETAILS_PREFIX}${JSON.stringify({
      version: 1,
      reason,
      evidence: { claimRefs: ["snap-x"], crowdLevel: "packed", trajectory: "building", conflictState: "none", previousLevel: null, previousGeneratedAt: null, observedAt: iso(-30) },
      truth: { truthClass: "corroborated", confidence: "live", freshness: "live", coverage: "many", provenance: [] },
      detectedAt: iso(-25),
      expiresAt: iso(5),
    })}`,
    status: "open",
    created_at: iso(-25),
    ...over,
  };
}

interface ScanBody {
  ok?: boolean;
  error?: string;
  refusal?: string;
  sweep?: boolean;
  filed?: number;
  subjects?: Array<{ subjectId: string; detected: string[]; filed: Array<{ reason: string; reportId: string }>; alreadyOpen: string[]; refusal: string | null }>;
}
interface ListBody {
  ok?: boolean;
  error?: string;
  candidates?: Array<{ reportId: string; subjectId: string; status: string; candidate: { reason: string } }>;
}

describe("Safety candidates — the routes", () => {
  let app: ProjectionApp | null = null;
  afterEach(async () => {
    _clearPromotedScopeCache();
    if (app) await app.close();
    app = null;
  });

  async function scan(body: unknown, token = TOKEN) {
    const r = await fetch(`${app!.baseUrl}/api/admin/intel/safety-candidates/scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as ScanBody };
  }
  async function list(token = TOKEN) {
    const r = await fetch(`${app!.baseUrl}/api/admin/intel/safety-candidates`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as ListBody };
  }

  it("OFF: flag absent → both routes answer feature_disabled and write nothing", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(adminSafetyCandidatesRouter, world([]), { token: TOKEN, userId: ADMIN });
    writableReports(app, inserted);
    const s = await scan({});
    assert.equal(s.status, 404);
    assert.equal(s.body.error, "feature_disabled");
    const l = await list();
    assert.equal(l.status, 404);
    assert.equal(l.body.error, "feature_disabled");
    assert.equal(inserted.rows.length, 0);
  });

  it("OFF: flag false → the same", async () => {
    app = await startRouterApp(adminSafetyCandidatesRouter, world([OFF]), { token: TOKEN, userId: ADMIN });
    assert.equal((await scan({})).body.error, "feature_disabled");
  });

  it("a non-admin is forbidden before the flag is read; unauthenticated is 401", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(adminSafetyCandidatesRouter, world([ON]), { token: TOKEN, userId: MEMBER });
    writableReports(app, inserted);
    const s = await scan({});
    assert.equal(s.status, 403);
    assert.equal(inserted.rows.length, 0);
    assert.equal((await list()).status, 403);
    assert.equal((await scan({}, "wrong")).status, 401);
  });

  it("ON: a scan files ONE report per new candidate — place, safety_concern, no reporter, the candidate in details", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(adminSafetyCandidatesRouter, world([ON]), { token: TOKEN, userId: ADMIN });
    writableReports(app, inserted);
    const s = await scan({ subjectIds: [PLACE_ID] });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.ok, true);
    assert.equal(s.body.sweep, false);
    assert.equal(s.body.filed, 2);
    const subject = s.body.subjects![0]!;
    assert.deepEqual(subject.detected, ["density_rising_past_capacity", "rapid_density_rise"]);
    assert.equal(subject.filed.length, 2);
    assert.equal(subject.refusal, null);
    assert.equal(inserted.rows.length, 2);
    for (const row of inserted.rows) {
      assert.equal(row.reporter_id, null);
      assert.equal(row.subject_type, "place");
      assert.equal(row.subject_id, PLACE_ID);
      assert.equal(row.subject_user_id, null);
      assert.equal(row.category, "safety_concern");
      assert.equal(row.status, "open");
      const parsed = parseCandidateDetails(row.details);
      assert.ok(parsed, "the details are the detector's");
      assert.equal(parsed.evidence.crowdLevel, "packed");
      for (const forbidden of ["distinct_actors", "source_count", "sourceCountBucket", "contributor", "actor", "user_id", "count"]) {
        assert.equal(String(row.details).includes(`"${forbidden}"`), false, `details must not carry ${forbidden}`);
      }
    }
    assert.deepEqual(
      inserted.rows.map((r) => parseCandidateDetails(r.details)!.reason),
      ["density_rising_past_capacity", "rapid_density_rise"],
    );
  });

  it("ON: a candidate already before a reviewer is not filed again; a different reason still is", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(
      adminSafetyCandidatesRouter,
      world([ON], { moderation_reports: [candidateReport(PLACE_ID, "density_rising_past_capacity")] }),
      { token: TOKEN, userId: ADMIN },
    );
    writableReports(app, inserted);
    const s = await scan({ subjectIds: [PLACE_ID] });
    const subject = s.body.subjects![0]!;
    assert.deepEqual(subject.alreadyOpen, ["density_rising_past_capacity"]);
    assert.deepEqual(subject.filed.map((f) => f.reason), ["rapid_density_rise"]);
    assert.equal(inserted.rows.length, 1);
  });

  it("ON: a reviewer's DISMISSED or ACTIONED row does not block a fresh candidate; a person's own open report does not either", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(
      adminSafetyCandidatesRouter,
      world([ON], {
        moderation_reports: [
          candidateReport(PLACE_ID, "density_rising_past_capacity", { status: "dismissed" }),
          candidateReport(PLACE_ID, "rapid_density_rise", { id: "22222222-eeee-4eee-8eee-222222222222", status: "actioned" }),
          { id: "11111111-eeee-4eee-8eee-111111111111", reporter_id: MEMBER, subject_type: "place", subject_id: PLACE_ID, category: "safety_concern", details: "it was scary in there", status: "open", created_at: iso(-5) },
        ],
      }),
      { token: TOKEN, userId: ADMIN },
    );
    writableReports(app, inserted);
    const s = await scan({ subjectIds: [PLACE_ID] });
    assert.equal(s.body.filed, 2, JSON.stringify(s.body));
    assert.equal(inserted.rows.length, 2);
  });

  it("ON: a place with no packed crowd yields no candidate and writes nothing", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(adminSafetyCandidatesRouter, world([ON]), { token: TOKEN, userId: ADMIN });
    writableReports(app, inserted);
    const s = await scan({ subjectIds: [QUIET_ID] });
    assert.deepEqual(s.body.subjects![0]!.detected, []);
    assert.equal(s.body.filed, 0);
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: the sweep looks only at places served as packed", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(adminSafetyCandidatesRouter, world([ON]), { token: TOKEN, userId: ADMIN });
    writableReports(app, inserted);
    const s = await scan({});
    assert.equal(s.body.sweep, true);
    assert.deepEqual(s.body.subjects!.map((x) => x.subjectId), [PLACE_ID]);
    assert.equal(s.body.filed, 2);
  });

  it("ON: live intelligence not servable → a refusal, nothing read, nothing filed", async () => {
    const inserted: Inserted = { rows: [] };
    const closed = world([ON]);
    closed.feature_flags = [ON, { flag: "intel_live_label_crowd", enabled: false }];
    app = await startRouterApp(adminSafetyCandidatesRouter, closed, { token: TOKEN, userId: ADMIN });
    writableReports(app, inserted);
    const s = await scan({ subjectIds: [PLACE_ID] });
    assert.equal(s.status, 200);
    assert.equal(s.body.ok, false);
    assert.equal(s.body.refusal, "live_intelligence_unavailable");
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: a history that cannot be read is a per-subject REFUSAL, never 'no candidate'", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(
      adminSafetyCandidatesRouter,
      world([ON], { intel_state_snapshot_versions: { rows: [], error: { message: 'relation "intel_state_snapshot_versions" does not exist' } } }),
      { token: TOKEN, userId: ADMIN },
    );
    writableReports(app, inserted);
    const s = await scan({ subjectIds: [PLACE_ID] });
    const subject = s.body.subjects![0]!;
    assert.equal(subject.refusal, "versions_unavailable");
    assert.deepEqual(subject.detected, []);
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: a queue that refuses the write is a per-subject refusal, and the answer says so", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(adminSafetyCandidatesRouter, world([ON]), { token: TOKEN, userId: ADMIN });
    writableReports(app, inserted, { failInsert: true });
    const s = await scan({ subjectIds: [PLACE_ID] });
    assert.equal(s.body.subjects![0]!.refusal, "queue_write_failed");
    assert.equal(s.body.filed, 0);
  });

  it("ON: the list serves the detector's open rows, parsed, and not a person's report", async () => {
    app = await startRouterApp(
      adminSafetyCandidatesRouter,
      world([ON], {
        moderation_reports: [
          candidateReport(PLACE_ID, "material_conflict_at_capacity"),
          candidateReport(QUIET_ID, "rapid_density_rise", { id: "22222222-eeee-4eee-8eee-222222222222", status: "dismissed" }),
          { id: "11111111-eeee-4eee-8eee-111111111111", reporter_id: MEMBER, subject_type: "place", subject_id: PLACE_ID, category: "safety_concern", details: "it was scary in there", status: "open", created_at: iso(-5) },
        ],
      }),
      { token: TOKEN, userId: ADMIN },
    );
    const l = await list();
    assert.equal(l.status, 200, JSON.stringify(l.body));
    assert.deepEqual(
      l.body.candidates!.map((c) => [c.reportId, c.subjectId, c.status, c.candidate.reason]),
      [[REPORT_ID, PLACE_ID, "open", "material_conflict_at_capacity"]],
    );
  });

  it("invalid subject ids are invalid_payload", async () => {
    app = await startRouterApp(adminSafetyCandidatesRouter, world([ON]), { token: TOKEN, userId: ADMIN });
    const s = await scan({ subjectIds: ["not-a-uuid"] });
    assert.equal(s.status, 400);
    assert.equal(s.body.error, "invalid_payload");
  });
});
