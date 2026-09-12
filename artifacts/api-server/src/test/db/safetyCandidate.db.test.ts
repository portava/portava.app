/**
 * Sensing §16 — the review-queue row a safety candidate is filed as,
 * EXECUTED on a real database (census-sensing §5): moderation_reports as
 * the roles the policies name, rather than read as text.
 *
 *   the row lib/safetyCandidate.candidateReportRow builds — reporter_id
 *   NULL, subject_type place, category safety_concern, status open — is
 *   accepted by the table's own CHECK constraints when the service role
 *   writes it; a reason outside the queue's vocabulary is refused by the
 *   same CHECK; no client role can read a row with no reporter (the SELECT
 *   policies are `reporter_id = auth.uid()`), so a candidate is for
 *   specialists only; the details the database holds parse back as the
 *   candidate; and 2803's flag row reads FALSE here.
 *
 * What this suite does NOT claim: that any candidate was ever filed (the
 * flag is FALSE everywhere), or anything about production's rows. Every
 * property here is a property of the schema and the module.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, asUser, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.ts";
import { candidateReportRow, detectSafetyCandidates, parseCandidateDetails, type SafetyCandidate } from "../../lib/safetyCandidate.js";
import { REPORTS_TABLE } from "../../lib/safetyCandidateStore.js";
import type { LiveClaimEnvelope } from "../../lib/liveClaimRead.js";

const SKIP = !HAVE_DB;
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const PLACE = "88888888-bbbb-4bbb-8bbb-888888888888";

function env(claimType: string, value: unknown): LiveClaimEnvelope {
  return {
    id: `snap-dbsuite-${claimType}`,
    claimType,
    value,
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "many",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
  };
}

function sql(s: string): string {
  return s.replace(/'/g, "''");
}

describe("2803 / moderation_reports — a safety candidate on a real database", { skip: SKIP }, () => {
  let viewer = "";
  let candidate: SafetyCandidate;
  let reportId = "";

  before(() => {
    viewer = seedUser("sc_viewer");
    const detected = detectSafetyCandidates(PLACE, [env("crowd.level", { level: "packed" }), env("crowd.trajectory", { trajectory: "building" })], [], NOW);
    assert.equal(detected.length, 1);
    candidate = detected[0]!;
  });

  after(() => {
    exec(`SET LOCAL ROLE service_role;\nDELETE FROM public.${REPORTS_TABLE} WHERE subject_type = 'place' AND subject_id = '${PLACE}' AND reporter_id IS NULL;`, { single: true });
    if (viewer) deleteUser(viewer);
  });

  it("2803: the flag row is seeded and reads FALSE", () => {
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'intel_safety_candidates_enabled'`), "false");
  });

  it("the queue admits the row the module builds: place, safety_concern, no reporter, open", () => {
    const row = candidateReportRow(candidate);
    reportId = scalar(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.${REPORTS_TABLE} (reporter_id, subject_type, subject_id, subject_user_id, category, details, status) VALUES (NULL, '${row.subject_type}', '${row.subject_id}', NULL, '${row.category}', '${sql(row.details)}', '${row.status}') RETURNING id;`,
    )!;
    assert.match(reportId, /^[0-9a-f-]{36}$/);
    const stored = rows<{ reporter_id: string | null; subject_type: string; category: string; status: string; details: string }>(
      `SELECT reporter_id, subject_type, category, status, details FROM public.${REPORTS_TABLE} WHERE id = '${reportId}'`,
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.reporter_id, null);
    assert.equal(stored[0]!.subject_type, "place");
    assert.equal(stored[0]!.category, "safety_concern");
    assert.equal(stored[0]!.status, "open");
    const back = parseCandidateDetails(stored[0]!.details);
    assert.ok(back);
    assert.equal(back.reason, candidate.reason);
    assert.deepEqual(back.evidence, candidate.evidence);
  });

  it("the queue's own CHECK refuses a category or subject type outside its vocabulary", () => {
    const bad = psql(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.${REPORTS_TABLE} (reporter_id, subject_type, subject_id, category, details, status) VALUES (NULL, 'place', '${PLACE}', 'safety_candidate', 'x', 'open');`,
      { single: true },
    );
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /moderation_reports_category_check|check constraint/i);
    const bad2 = psql(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.${REPORTS_TABLE} (reporter_id, subject_type, subject_id, category, details, status) VALUES (NULL, 'venue', '${PLACE}', 'safety_concern', 'x', 'open');`,
      { single: true },
    );
    assert.notEqual(bad2.status, 0);
    assert.match(bad2.stderr, /moderation_reports_subject_type_check|check constraint/i);
  });

  it("no client role reads a candidate: the SELECT policies are reporter_id = auth.uid(), and a candidate has no reporter", () => {
    assert.deepEqual(asUser(viewer, `SELECT id FROM public.${REPORTS_TABLE} WHERE id = '${reportId}';`), []);
    assert.equal(scalar(`SELECT count(*)::text FROM public.${REPORTS_TABLE} WHERE id = '${reportId}'`), "1", "the row is there for the service role");
  });

  it("a client cannot file a system-originated candidate: an authenticated INSERT with no reporter is refused", () => {
    const r = psql(
      [
        `SELECT set_config('request.jwt.claim.sub', '${viewer}', true);`,
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
        `SET LOCAL ROLE authenticated;`,
        `INSERT INTO public.${REPORTS_TABLE} (reporter_id, subject_type, subject_id, category, details, status) VALUES (NULL, 'place', '${PLACE}', 'safety_concern', 'safety_candidate:{}', 'open');`,
      ].join("\n"),
      { single: true },
    );
    assert.notEqual(r.status, 0, "the insert must be refused");
    assert.match(r.stderr, /42501|row-level security|permission denied/i);
  });
});
