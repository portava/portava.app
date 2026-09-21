/**
 * The deletion planner, dry run, boundary and planned executor.
 *
 * THE ASSERTION THAT MATTERS: the executor REFUSES a plan containing an
 * unresolved OWNER_REQUIRED table and writes NOTHING. Not "skips it", not
 * "warns" - refuses, with the blocking tables named. A deletion that quietly
 * leaves rows behind while reporting success is the defect class this whole
 * directory exists to make unreachable, so the refusal is proved twice: once
 * against the real graph (where 200+ tables are undecided) and once against a
 * synthetic graph where EXACTLY ONE table is undecided and everything else is
 * resolved, which is the case a "mostly works" implementation would pass.
 *
 * WHAT ELSE COULD MAKE THESE PASS, and what stops it:
 *   * an empty plan - the planner throws on an empty graph and the tests assert
 *     a floor of 248 actions against the real one;
 *   * a dry run that reads nothing because the client failed - supabase-js
 *     RESOLVES on a database error, so the fail-closed tests inject exactly
 *     that shape (via helpers/failClosedSupabase) and assert the table comes
 *     back UNREADABLE rather than "0 rows";
 *   * a client that answers neither a count nor an error - asserted separately,
 *     because `count ?? 0` is the permissive zero this repo keeps finding;
 *   * a verification that passes over residual rows - asserted with rows left
 *     behind after a DELETE-fated action.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/deletionPlanner.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildDeletionGraph } from "../lib/deletion/graph.js";
import { deletionGraph } from "../lib/deletion/index.js";
import type { DeletionGraphNode } from "../lib/deletion/types.js";
import { buildDeletionPlan, orderTables, formatPlan } from "../services/accountDeletion/DeletionPlanner.js";
import { UNSET_POLICY, type DeletionPolicy } from "../services/accountDeletion/policy.js";
import { executePlannedDeletion, planRefusals } from "../services/accountDeletion/DeletionExecutor.js";
import { dryRunDeletion, formatDryRun } from "../services/accountDeletion/DeletionDryRun.js";
import { verifyDeletion } from "../services/accountDeletion/verification.js";
import { registerStorageCleanupHook, _resetHooks } from "../services/accountDeletion/hooks.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

const USER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

/**
 * A miniature schema in the dump's own shape, so the tests exercise the REAL
 * parser rather than a hand-built node object that could drift from it.
 *
 *   fx_notes         one owner, free text                -> plain content
 *   fx_note_scores   a derivative of fx_notes            -> must be visited first
 *   fx_audit         NO ACTION reference to fx_notes     -> must be visited first
 *   fx_reports       a safety record with a counterparty -> retention-shaped
 *   fx_media         holds a storage reference           -> needs a storage hook
 */
const FIXTURE_SQL = `
CREATE TABLE public.fx_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.fx_note_scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    note_id uuid NOT NULL,
    score numeric
);
CREATE TABLE public.fx_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    note_id uuid NOT NULL,
    action text
);
CREATE TABLE public.fx_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    report_reason text
);
CREATE TABLE public.fx_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    media_url text
);
ALTER TABLE ONLY public.fx_notes
    ADD CONSTRAINT fx_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fx_note_scores
    ADD CONSTRAINT fx_note_scores_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.fx_notes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fx_audit
    ADD CONSTRAINT fx_audit_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.fx_notes(id) ON DELETE NO ACTION;
ALTER TABLE ONLY public.fx_reports
    ADD CONSTRAINT fx_reports_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.fx_media
    ADD CONSTRAINT fx_media_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
`;

const fixtureGraph = (): DeletionGraphNode[] => buildDeletionGraph({ sql: FIXTURE_SQL });

const policy = (entries: DeletionPolicy["entries"]): DeletionPolicy => ({ version: "test-policy", entries });

/** Every fixture table resolved, so only the named exclusions stay open. */
function fullFixturePolicy(except: string[] = []): DeletionPolicy {
  const all = [
    { table: "fx_notes", fate: "DELETE" as const, authority: "test ruling 2026-09-08" },
    { table: "fx_note_scores", fate: "DELETE" as const, authority: "test ruling 2026-09-08" },
    { table: "fx_audit", fate: "RETAIN" as const, authority: "test ruling 2026-09-08" },
    { table: "fx_reports", fate: "RETAIN" as const, authority: "test ruling 2026-09-08" },
    { table: "fx_media", fate: "DELETE" as const, authority: "test ruling 2026-09-08" },
  ];
  return policy(all.filter((e) => !except.includes(e.table)));
}

describe("the fixture graph is itself non-vacuous", () => {
  it("parses five tables with the relationships the ordering tests depend on", () => {
    const g = fixtureGraph();
    assert.equal(g.length, 5);
    const scores = g.find((n) => n.table === "fx_note_scores")!;
    assert.equal(scores.derivative.derivedFrom, "fx_notes", "a _scores table must be recognised as a derivative");
    const notes = g.find((n) => n.table === "fx_notes")!;
    assert.ok(notes.propagation.DELETE.blockingChildren.includes("fx_audit"), "a NO ACTION child must be reported as blocking");
    const media = g.find((n) => n.table === "fx_media")!;
    assert.deepEqual(media.propagation.DELETE.storageColumns, ["media_url"]);
  });
});

describe("the planner orders by dependency and is deterministic", () => {
  it("produces a plan over the real graph with a plausible floor of actions", () => {
    const plan = buildDeletionPlan({ userId: USER, policy: UNSET_POLICY });
    assert.ok(plan.actions.length >= 248, `expected >= 248 actions, got ${plan.actions.length}`);
    assert.equal(plan.actions.length, plan.graphTableCount);
    plan.actions.forEach((a, i) => assert.equal(a.order, i, "order indexes must match position"));
  });

  it("gives byte-identical plans for the same graph and policy", () => {
    const a = buildDeletionPlan({ userId: USER, policy: UNSET_POLICY });
    const b = buildDeletionPlan({ userId: USER, policy: UNSET_POLICY });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  it("visits every derivative before the record it is derived from", () => {
    const plan = buildDeletionPlan({ userId: USER, policy: UNSET_POLICY });
    const index = new Map(plan.actions.map((a, i) => [a.table, i]));
    const nodes = deletionGraph();
    let checked = 0;
    for (const n of nodes) {
      const src = n.derivative.derivedFrom;
      if (!src || !index.has(src)) continue;
      checked += 1;
      assert.ok(index.get(n.table)! < index.get(src)!, `${n.table} must precede its source ${src}`);
    }
    assert.ok(checked > 0, "no derivative edges were checked - the invariant would be vacuous");
  });

  it("visits every blocking child before its parent", () => {
    const plan = buildDeletionPlan({ userId: USER, policy: UNSET_POLICY });
    const index = new Map(plan.actions.map((a, i) => [a.table, i]));
    let checked = 0;
    for (const n of deletionGraph()) {
      for (const child of n.propagation.DELETE.blockingChildren) {
        if (!index.has(child)) continue;
        checked += 1;
        assert.ok(index.get(child)! < index.get(n.table)!, `${child} must precede ${n.table}`);
      }
    }
    assert.ok(checked > 0, "no blocking-child edges were checked - the invariant would be vacuous");
  });

  it("orders the fixture derivative and the blocking child ahead of fx_notes", () => {
    const plan = buildDeletionPlan({ userId: USER, policy: fullFixturePolicy(), graph: fixtureGraph() });
    const index = new Map(plan.actions.map((a, i) => [a.table, i]));
    assert.ok(index.get("fx_note_scores")! < index.get("fx_notes")!);
    assert.ok(index.get("fx_audit")! < index.get("fx_notes")!);
    assert.ok(plan.actions.find((a) => a.table === "fx_note_scores")!.orderReasons.some((r) => /derivative/.test(r)));
    assert.ok(plan.actions.find((a) => a.table === "fx_audit")!.orderReasons.some((r) => /NO ACTION\/RESTRICT/.test(r)));
  });

  it("reports a dependency cycle instead of dropping its members from the plan", () => {
    const { order, cycles } = orderTables(["a", "b", "c"], [
      { before: "a", after: "b" },
      { before: "b", after: "a" },
    ]);
    assert.deepEqual(order.sort(), ["a", "b", "c"], "no table may vanish from the order");
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0], ["a", "b"]);
  });

  it("throws rather than planning over an empty graph", () => {
    assert.throws(() => buildDeletionPlan({ userId: USER, policy: UNSET_POLICY, graph: [] }), /EMPTY/);
  });

  it("rejects a policy entry with no authority", () => {
    const plan = buildDeletionPlan({
      userId: USER,
      graph: fixtureGraph(),
      policy: policy([{ table: "fx_notes", fate: "DELETE", authority: "" }]),
    });
    assert.ok(plan.policyProblems.some((p) => /no authority/.test(p.problem)));
  });

  it("formats a plan a reviewer can read", () => {
    const text = formatPlan(buildDeletionPlan({ userId: USER, policy: UNSET_POLICY }), { limit: 3 });
    assert.match(text, /UNRESOLVED: \d+ \(of which OWNER_REQUIRED by the graph: \d+\)/);
  });
});

describe("the executor REFUSES an unresolved plan and writes nothing", () => {
  beforeEach(() => {
    _resetHooks();
    // fx_media holds a storage reference; without a hook it blocks every run on
    // its own, which would mask the single-unresolved-table cases below. The
    // hook gate gets its own test, which drops this registration first.
    registerStorageCleanupHook({ id: "fx_media_objects", tables: ["fx_media"], columns: ["media_url"], implementedBy: "test" });
  });

  it("refuses the real graph under the unset policy, without calling the deletion service", async () => {
    let called = 0;
    const res = await executePlannedDeletion({} as any, {
      userId: USER,
      policy: UNSET_POLICY,
      actorId: null,
      execute: (async () => { called += 1; throw new Error("must not run"); }) as any,
    });
    assert.equal(res.refused, true);
    assert.equal(res.ok, false);
    assert.equal(called, 0, "the deletion service must not be called for an unresolved plan");
    assert.equal(res.outcome, undefined);
    assert.ok(res.blockingTables.length >= 100);
    assert.ok(res.refusalReasons.some((r) => /OWNER_REQUIRED/.test(r)));
    assert.ok(res.plan.summary.ownerRequiredUnresolved > 0);
  });

  it("refuses when EXACTLY ONE table is undecided and everything else is resolved", async () => {
    let called = 0;
    const graph = fixtureGraph();
    const res = await executePlannedDeletion({} as any, {
      userId: USER,
      policy: fullFixturePolicy(["fx_note_scores"]),
      actorId: null,
      graph,
      execute: (async () => { called += 1; throw new Error("must not run"); }) as any,
    });
    assert.equal(res.refused, true);
    assert.equal(called, 0);
    assert.deepEqual(res.blockingTables.map((b) => b.table), ["fx_note_scores"]);
    assert.match(res.refusalReasons.join(" "), /NO DECIDED FATE/);
  });

  it("still refuses when the single undecided table has a confident candidate class", async () => {
    // fx_reports is SAFETY_RETENTION_CANDIDATE, not OWNER_REQUIRED. A candidate
    // class is an observation, never a decision, so it must not unblock a run.
    const graph = fixtureGraph();
    assert.equal(graph.find((n) => n.table === "fx_reports")!.candidate, "SAFETY_RETENTION_CANDIDATE");
    let called = 0;
    const res = await executePlannedDeletion({} as any, {
      userId: USER,
      policy: fullFixturePolicy(["fx_reports"]),
      actorId: null,
      graph,
      execute: (async () => { called += 1; throw new Error("must not run"); }) as any,
    });
    assert.equal(res.refused, true);
    assert.equal(called, 0);
    assert.deepEqual(res.blockingTables.map((b) => b.table), ["fx_reports"]);
    assert.equal(res.blockingTables[0].ownerRequired, false, "it is not OWNER_REQUIRED, and it still blocks");
  });

  it("refuses a DELETE whose storage references no hook covers", async () => {
    _resetHooks(); // drop the fx_media hook registered above
    let called = 0;
    const res = await executePlannedDeletion({} as any, {
      userId: USER, policy: fullFixturePolicy(), actorId: null, graph: fixtureGraph(),
      execute: (async () => { called += 1; throw new Error("must not run"); }) as any,
    });
    assert.equal(res.refused, true);
    assert.equal(called, 0);
    assert.ok(res.refusalReasons.some((r) => /fx_media .*storage reference/.test(r)), res.refusalReasons.join("|"));
  });

  it("runs once every table is resolved and every storage hook is registered", async () => {
    let called = 0;
    const res = await executePlannedDeletion({} as any, {
      userId: USER, policy: fullFixturePolicy(), actorId: null, graph: fixtureGraph(),
      execute: (async () => { called += 1; return { ok: true, userId: USER, executedAt: "now", steps: [], warnings: [], deletedCounts: {}, tombstonedCounts: {} }; }) as any,
      verify: (async () => ({ ok: true, userId: USER, policyVersion: "test-policy", verifiedAt: "now", tables: [], totals: { checked: 1, clean: 1, residual: 0, retained: 0, unverified: 0, residualRows: 0 }, failures: [] })) as any,
    });
    assert.equal(res.refused, false, res.refusalReasons.join("|"));
    assert.equal(called, 1);
    assert.equal(res.ok, true);
  });

  it("fails the run when the post-execution verification finds residual rows", async () => {
    const res = await executePlannedDeletion({} as any, {
      userId: USER, policy: fullFixturePolicy(), actorId: null, graph: fixtureGraph(),
      execute: (async () => ({ ok: true, userId: USER, executedAt: "now", steps: [], warnings: [], deletedCounts: {}, tombstonedCounts: {} })) as any,
      verify: (async () => ({
        ok: false, userId: USER, policyVersion: "test-policy", verifiedAt: "now", tables: [],
        totals: { checked: 1, clean: 0, residual: 1, retained: 0, unverified: 0, residualRows: 4 },
        failures: ["fx_notes: 4 row(s) still name the user after a DELETE-fated action"],
      })) as any,
    });
    assert.equal(res.ok, false, "an execution whose verification failed is not a success");
    assert.deepEqual(res.refusalReasons, ["fx_notes: 4 row(s) still name the user after a DELETE-fated action"]);
  });

  it("refuses a policy that crosses the legal-retention boundary without acknowledging it", async () => {
    const graph = fixtureGraph();
    const p = policy([
      ...fullFixturePolicy(["fx_reports"]).entries,
      { table: "fx_reports", fate: "DELETE", authority: "test ruling" },
    ]);
    const refused = planRefusals(buildDeletionPlan({ userId: USER, policy: p, graph }));
    assert.ok(refused.reasons.some((r) => /legal-retention boundary: fx_reports/.test(r)), refused.reasons.join("|"));

    const acknowledged = policy([
      ...fullFixturePolicy(["fx_reports"]).entries,
      { table: "fx_reports", fate: "DELETE", authority: "test ruling", overridesRetentionSignal: true },
    ]);
    const ok = planRefusals(buildDeletionPlan({ userId: USER, policy: acknowledged, graph }));
    assert.equal(ok.reasons.filter((r) => /legal-retention boundary/.test(r)).length, 0);
  });
});

describe("the dry run reads, counts, and never turns a failed read into zero", () => {
  const plan = () => buildDeletionPlan({ userId: USER, policy: fullFixturePolicy(), graph: fixtureGraph() });

  it("counts the rows a deletion would touch, per column", async () => {
    const client = makeFailClosedClient({
      rows: {
        fx_notes: [{ id: "n1", user_id: USER }, { id: "n2", user_id: USER }, { id: "n3", user_id: OTHER }],
        fx_reports: [{ id: "r1", reporter_id: USER, target_user_id: OTHER }],
      },
    });
    const report = await dryRunDeletion(client, plan());
    assert.equal(report.ok, true);
    assert.equal(report.wroteNothing, true);
    const notes = report.tables.find((t) => t.table === "fx_notes")!;
    assert.equal(notes.rowMatches, 2, "the third row belongs to another user");
    const reports = report.tables.find((t) => t.table === "fx_reports")!;
    assert.deepEqual(
      reports.counts.map((c) => [c.column, c.rows]),
      [["reporter_id", 1], ["target_user_id", 0]],
      "both sides of a two-party row are counted separately",
    );
    assert.equal(report.totals.rowMatches, 3);
    assert.match(formatDryRun(report, { onlyWithRows: true }), /fx_notes/);
  });

  it("reports a FAILED read as UNREADABLE, not as an empty table", async () => {
    const client = makeFailClosedClient({
      rows: { fx_notes: [{ id: "n1", user_id: USER }] },
      failOn: (ctx) => (ctx.table === "fx_notes" ? { message: "connection terminated unexpectedly", code: "57P01" } : null),
    });
    const report = await dryRunDeletion(client, plan());
    const notes = report.tables.find((t) => t.table === "fx_notes")!;
    assert.equal(notes.unreadable, true);
    assert.equal(notes.counts[0].rows, null, "a failed read must never be recorded as a count");
    assert.equal(report.ok, false);
    assert.equal(report.totals.unreadableTables, 1);
    assert.ok(report.refusalReasons.some((r) => /could not be read/.test(r)));
  });

  it("treats a client that answers neither a count nor an error as UNREADABLE", async () => {
    // The permissive zero: `count ?? 0`. This client resolves successfully with
    // no count at all, which is what a head:true read looks like when the
    // caller forgot to ask for one.
    const silent: any = {
      from: () => ({
        select: () => ({ eq: async () => ({ data: null, error: null }) }),
      }),
    };
    const report = await dryRunDeletion(silent, plan());
    assert.equal(report.ok, false);
    assert.equal(report.totals.unreadableTables, report.tables.filter((t) => t.counts.length > 0).length);
    assert.ok(report.refusalReasons.some((r) => /EVERY inspectable table was unreadable/.test(r)));
  });

  it("writes nothing at all", async () => {
    const verbs: string[] = [];
    const spy: any = {
      from: () => {
        const b: any = {
          select: () => b,
          insert: () => { verbs.push("insert"); return b; },
          update: () => { verbs.push("update"); return b; },
          upsert: () => { verbs.push("upsert"); return b; },
          delete: () => { verbs.push("delete"); return b; },
          eq: async () => ({ data: null, error: null, count: 0 }),
        };
        return b;
      },
    };
    const report = await dryRunDeletion(spy, plan());
    assert.deepEqual(verbs, []);
    assert.equal(report.ok, true);
  });

  it("throws rather than dry-running an empty plan", async () => {
    const empty = { ...plan(), actions: [] };
    await assert.rejects(() => dryRunDeletion({} as any, empty as any), /ZERO actions/);
  });

  it("carries the unresolved tables into the refusal reasons", async () => {
    const client = makeFailClosedClient({ rows: {} });
    const report = await dryRunDeletion(client, buildDeletionPlan({ userId: USER, policy: fullFixturePolicy(["fx_notes"]), graph: fixtureGraph() }));
    assert.ok(report.refusalReasons.some((r) => /have no fate/.test(r)));
    assert.ok(report.tables.find((t) => t.table === "fx_notes")!.notes.some((n) => /UNRESOLVED/.test(n)));
  });
});

describe("the verification report is the second read that makes a green run mean something", () => {
  const plan = () => buildDeletionPlan({ userId: USER, policy: fullFixturePolicy(), graph: fixtureGraph() });

  it("passes only when the DELETE-fated tables really are empty", async () => {
    const client = makeFailClosedClient({ rows: { fx_notes: [{ id: "n1", user_id: OTHER }] } });
    const report = await verifyDeletion(client, plan());
    assert.equal(report.ok, true);
    assert.equal(report.totals.residual, 0);
    assert.ok(report.totals.clean >= 3);
  });

  it("FAILS when rows survive a DELETE-fated action", async () => {
    const client = makeFailClosedClient({ rows: { fx_notes: [{ id: "n1", user_id: USER }, { id: "n2", user_id: USER }] } });
    const report = await verifyDeletion(client, plan());
    assert.equal(report.ok, false);
    const notes = report.tables.find((t) => t.table === "fx_notes")!;
    assert.equal(notes.status, "RESIDUAL_ROWS");
    assert.equal(notes.residualRows, 2);
    assert.ok(report.failures.some((f) => /fx_notes/.test(f)));
  });

  it("marks a table it could not read UNVERIFIED rather than clean", async () => {
    const client = makeFailClosedClient({
      rows: {},
      failOn: (ctx) => (ctx.table === "fx_notes" ? { message: "permission denied", code: "42501" } : null),
    });
    const report = await verifyDeletion(client, plan());
    assert.equal(report.ok, false);
    assert.equal(report.tables.find((t) => t.table === "fx_notes")!.status, "UNVERIFIED");
    assert.equal(report.totals.unverified, 1);
  });

  it("records retained rows as retained, with the authority that kept them", async () => {
    const client = makeFailClosedClient({ rows: { fx_audit: [{ id: "a1", user_id: USER }] } });
    const report = await verifyDeletion(client, plan());
    const audit = report.tables.find((t) => t.table === "fx_audit")!;
    assert.equal(audit.status, "RETAINED_AS_PLANNED");
    assert.match(audit.detail ?? "", /retained by policy: test ruling/);
  });

  it("throws rather than verifying an empty plan", async () => {
    await assert.rejects(() => verifyDeletion({} as any, { ...plan(), actions: [] } as any), /ZERO actions/);
  });
});
