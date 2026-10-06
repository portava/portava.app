/**
 * §24 `resurfacing_suppression_violations` ("must be zero") — counted, and
 * enforced, at the serving step of both proactive Highlight feeds.
 * census-highlights-memories H221 (lane R, 2026-10-06).
 *
 * The row read NB: "Nothing counts a violation ... a violation could not be
 * DETECTED if it happened". Two halves are proven here:
 *
 *   1. THE DETECTOR (unit). Given the same §10/§11 inputs a feed filtered with,
 *      a row a stored control suppresses is DROPPED and COUNTED; an allowed row
 *      passes and is counted as checked; the viewer's own row is neither; an
 *      absent control table (2720 not deployed) reports nothing; a
 *      recap-only control is not a violation of a proactive feed.
 *   2. THE WIRING (route). GET /highlights/active and GET
 *      /highlights/following-feed both pass their served rows through it — the
 *      checked count moves on a real request — and on a correct handler the
 *      violation count stays ZERO while a KEEP_PRIVATE_FOREVER row is still
 *      kept off the page (the earlier filter did that; the audit saw nothing to
 *      drop).
 *
 * Emitted, not aggregated (per-process counter + structured log line): §K.2's W.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  auditServedResurfacing,
  readResurfacingSuppressionAudit,
  _resetResurfacingSuppressionAudit,
  RESURFACING_SUPPRESSION_VIOLATIONS,
} from "../services/highlights/resurfacingSuppressionAudit.js";
import { suppressions } from "../services/highlights/highlightResurfacing.js";
import type { ProjectionInputs } from "../services/highlights/highlightPublicProjection.js";
import { MEMORY_METRICS_NOT_MEASURABLE } from "../services/memory/memoryKernelMetrics.js";
import {
  startApp, call, fixtureTables, listIds, feedIds,
  VIEWER, OWNER, H_PUB, H_MINE,
} from "./highlightsSpecHarness.js";

const ROW_A = { id: "50000000-0000-4000-8000-00000000000a", owner_id: OWNER };
const ROW_B = { id: "50000000-0000-4000-8000-00000000000b", owner_id: OWNER };
const MINE = { id: "50000000-0000-4000-8000-00000000000c", owner_id: VIEWER };

function inputsWith(controls: Array<{ control: any; subjectId: string }>): ProjectionInputs {
  return {
    controls: suppressions(controls),
    viewerControls: suppressions([]),
    policies: { state: "absent", reason: "test: no §10 policy table" } as any,
  };
}

function recordingLog() {
  const lines: Array<{ obj: any; msg: string }> = [];
  return { lines, log: { error: (obj: unknown, msg: string) => { lines.push({ obj, msg }); } } };
}

describe("the detector: a suppressed row at the serving step is counted AND dropped", () => {
  beforeEach(() => _resetResurfacingSuppressionAudit());

  it("drops and counts a row a stored KEEP_PRIVATE_FOREVER covers; serves the other", () => {
    const { lines, log } = recordingLog();
    const out = auditServedResurfacing(
      [ROW_A, ROW_B], VIEWER, inputsWith([{ control: "KEEP_PRIVATE_FOREVER", subjectId: ROW_A.id }]), log, "unit",
    );
    assert.deepEqual(out.map((r) => r.id), [ROW_B.id]);
    assert.deepEqual(readResurfacingSuppressionAudit(), {
      metric: RESURFACING_SUPPRESSION_VIOLATIONS, violations: 1, rowsChecked: 2,
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.obj.metric, RESURFACING_SUPPRESSION_VIOLATIONS);
    assert.equal(lines[0]!.obj.highlightId, ROW_A.id);
  });

  it("DO_NOT_RESURFACE on one Highlight drops that row and only that row", () => {
    const { log } = recordingLog();
    const out = auditServedResurfacing(
      [ROW_A, ROW_B], VIEWER, inputsWith([{ control: "DO_NOT_RESURFACE", subjectId: ROW_A.id }]), log, "unit",
    );
    // DO_NOT_RESURFACE is highlight-scoped (feedSubjectScope): ROW_B, same owner, stays.
    assert.deepEqual(out.map((r) => r.id), [ROW_B.id]);
    assert.equal(readResurfacingSuppressionAudit().violations, 1);
  });

  it("a control that does not suppress proactive feeds is not a violation", () => {
    const { lines, log } = recordingLog();
    const out = auditServedResurfacing(
      [ROW_A], VIEWER, inputsWith([{ control: "DO_NOT_INCLUDE_IN_RECAPS", subjectId: ROW_A.id }]), log, "unit",
    );
    assert.deepEqual(out.map((r) => r.id), [ROW_A.id]);
    assert.equal(readResurfacingSuppressionAudit().violations, 0);
    assert.equal(lines.length, 0);
  });

  it("the viewer's OWN row is never checked against controls about other people", () => {
    const { log } = recordingLog();
    const out = auditServedResurfacing(
      [MINE], VIEWER, inputsWith([{ control: "KEEP_PRIVATE_FOREVER", subjectId: MINE.id }]), log, "unit",
    );
    assert.deepEqual(out.map((r) => r.id), [MINE.id]);
    assert.deepEqual(readResurfacingSuppressionAudit(), {
      metric: RESURFACING_SUPPRESSION_VIOLATIONS, violations: 0, rowsChecked: 0,
    });
  });

  it("with the control table ABSENT there is nothing to violate, and nothing is invented", () => {
    const { log } = recordingLog();
    const out = auditServedResurfacing(
      [ROW_A], VIEWER,
      { controls: { state: "absent", reason: "2720 not deployed" } as any, viewerControls: { state: "absent", reason: "x" } as any, policies: { state: "absent", reason: "x" } as any },
      log, "unit",
    );
    assert.deepEqual(out.map((r) => r.id), [ROW_A.id]);
    assert.equal(readResurfacingSuppressionAudit().violations, 0);
    assert.equal(readResurfacingSuppressionAudit().rowsChecked, 1);
  });

  it("a §10 refusal at the serving step is DROPPED but is not a §11 violation", () => {
    const { lines, log } = recordingLog();
    const out = auditServedResurfacing(
      [ROW_A], VIEWER,
      { controls: suppressions([]), viewerControls: suppressions([]), policies: { state: "unreadable", reason: "test: policy read failed" } as any },
      log, "unit",
    );
    assert.deepEqual(out, [], "an unreadable §10 policy withholds at the last step too");
    assert.equal(readResurfacingSuppressionAudit().violations, 0, "not a §11 suppression");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.obj.metric, undefined, "the §11 metric name is not used for a §10 refusal");
  });

  it("the memory metrics module no longer lists the name as unmeasurable", () => {
    assert.ok(!(RESURFACING_SUPPRESSION_VIOLATIONS in MEMORY_METRICS_NOT_MEASURABLE));
  });
});

function tablesWith(rows: any[]) {
  const t = fixtureTables();
  t.highlight_resurfacing_preferences = rows;
  return t;
}

describe("the wiring: both proactive feeds pass what they serve through the audit", () => {
  beforeEach(() => _resetResurfacingSuppressionAudit());

  it("GET /highlights/active checks every non-owner row it serves; zero violations on a correct handler", async () => {
    const app = await startApp({ tables: tablesWith([]) });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(listIds(r.body).has(H_PUB));
      const s = readResurfacingSuppressionAudit();
      assert.equal(s.rowsChecked, 1, "H_PUB (OWNER's) was checked; H_MINE (the viewer's) was not");
      assert.equal(s.violations, 0);
    } finally { await app.close(); }
  });

  it("GET /highlights/following-feed is wired the same way", async () => {
    const app = await startApp({ tables: tablesWith([]) });
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(feedIds(r.body).has(H_PUB));
      assert.ok(readResurfacingSuppressionAudit().rowsChecked >= 1);
      assert.equal(readResurfacingSuppressionAudit().violations, 0);
    } finally { await app.close(); }
  });

  it("a KEEP_PRIVATE_FOREVER row stays off both feeds and the count stays ZERO (the filter, not the audit, removed it)", async () => {
    const app = await startApp({
      tables: tablesWith([
        { id: "1", owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER", subject_type: "highlight", subject_id: H_PUB },
      ]),
    });
    try {
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.ok(!listIds(active.body).has(H_PUB));
      assert.ok(listIds(active.body).has(H_MINE));
      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(!feedIds(feed.body).has(H_PUB));
      assert.equal(readResurfacingSuppressionAudit().violations, 0);
    } finally { await app.close(); }
  });
});
