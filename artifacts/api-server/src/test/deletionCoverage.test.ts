/**
 * check:deletion-coverage — proves the guard actually bites.
 *
 * The property that matters is not "the manifest parses". It is that a NEW
 * user-keyed table cannot be added without someone stating what happens to it on
 * account deletion — and that the pre-existing backlog is never a hiding place
 * for one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";
import {
  userKeyedTablesFromBaseline,
  computeProblems,
} from "../scripts/checkDeletionCoverage.js";
import {
  ERASED_BY_CASCADE,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  UNCLASSIFIED_BACKLOG,
  POST_BASELINE_TABLES,
} from "../lib/deletionDispositions.js";

const BASELINE = readFileSync(BASELINE_PATH, "utf8");

describe("deletion coverage — the manifest matches the baseline", () => {
  it("parses a non-empty set of user-keyed tables", () => {
    const t = userKeyedTablesFromBaseline(BASELINE);
    assert.ok(t.size > 200, `expected the baseline to carry many user-keyed tables, got ${t.size}`);
  });

  it("is currently clean — every baseline table is classified exactly once", () => {
    const problems = computeProblems(userKeyedTablesFromBaseline(BASELINE));
    assert.deepEqual(problems, [], `manifest is out of sync:\n${problems.map((p) => `${p.kind}: ${p.table}`).join("\n")}`);
  });

  it("no table appears in two buckets", () => {
    const seen = new Map<string, string>();
    const add = (name: string, bucket: string) => {
      assert.ok(!seen.has(name), `${name} is in both ${seen.get(name)} and ${bucket}`);
      seen.set(name, bucket);
    };
    for (const t of ERASED_BY_CASCADE) add(t, "ERASED_BY_CASCADE");
    for (const t of DELETION_FLOW_TABLES) add(t, "DELETION_FLOW_TABLES");
    for (const r of RETAINED_WITH_REASON) add(r.table, "RETAINED_WITH_REASON");
    for (const t of UNCLASSIFIED_BACKLOG) add(t, "UNCLASSIFIED_BACKLOG");
  });
});

describe("deletion coverage — the guard bites", () => {
  it("FAILS when a new user-keyed table is added and left unclassified", () => {
    const withNew = new Map(userKeyedTablesFromBaseline(BASELINE));
    // A name that is deliberately in NO bucket. (intel_observations was used
    // here until IG-02 classified it — which is the guard working, not failing.)
    withNew.set("future_unclassified_table", ["actor_id"]);
    const problems = computeProblems(withNew);
    const hit = problems.find((p) => p.table === "future_unclassified_table");
    assert.ok(hit, "a new user-keyed table passed unclassified — the guard does not bite");
    assert.equal(hit!.kind, "UNCLASSIFIED NEW TABLE");
    assert.match(hit!.detail, /Do NOT add it to UNCLASSIFIED_BACKLOG/,
      "the failure must steer a new table away from the pre-existing-debt list");
  });

  it("FLAGS a stale entry when a listed table leaves the baseline", () => {
    const shrunk = new Map(userKeyedTablesFromBaseline(BASELINE));
    // Must be an entry that IS in the baseline — post-baseline tables are
    // deliberately exempt from the stale check until recapture.
    const victim = ERASED_BY_CASCADE.find((t) => !POST_BASELINE_TABLES.includes(t))!;
    assert.ok(victim, "expected at least one baseline-resident erased table");
    shrunk.delete(victim);
    const problems = computeProblems(shrunk);
    assert.ok(problems.some((p) => p.table === victim && p.kind === "STALE ENTRY"),
      "a manifest entry for a table that no longer exists went unreported");
  });

  it("the backlog is a dated record of debt, not a decision", () => {
    // If this ever reaches zero the program is done with D6; until then the
    // number is the honest measure of how much survives account deletion.
    assert.ok(UNCLASSIFIED_BACKLOG.length > 0);
    // Updated deliberately TWICE, and each decision is named here so a third
    // entry cannot arrive as a silent count bump:
    //
    //   1 (IG unit I1, migration 2273) intel_state_snapshot_versions — the
    //     append-only projection history, which carries no actor column at all.
    //     It is retained because nothing in it is a person's row, not because a
    //     person's row was ruled kept.
    //   4 (owner decision C-11 / W10D-B0, 2026-10-04, migration 3513) the
    //     creator / Rent-a-Buddy ledgers — the FIRST retentions where a
    //     person's own rows are ruled KEPT. They are a different kind of claim
    //     and so carry a different burden of proof: each reason must name the
    //     lawful basis AND say that the person is removed from the row the row
    //     is kept, because "retained" alone would read as "the account's
    //     financial history survives with them in it", which is not what was
    //     decided.
    assert.equal(RETAINED_WITH_REASON.length, 5,
      "once retentions are decided, update this expectation deliberately");
    for (const r of RETAINED_WITH_REASON) {
      assert.ok(r.reason.length > 40, `${r.table}: a retention needs a reason a user could be shown`);
    }
    const byTable = new Map(RETAINED_WITH_REASON.map((r) => [r.table, r.reason]));
    assert.match(byTable.get("intel_state_snapshot_versions")!, /no actor column/);
    for (const t of [
      "rent_buddy_earnings_entries",
      "creator_attributions",
      "creator_earning_entries",
      "creator_ledger_audit_events",
    ]) {
      const reason = byTable.get(t);
      assert.ok(reason, `${t}: C-11 ruled this ledger retained; the manifest must say so`);
      assert.match(reason!, /GDPR Art\. 17\(3\)\(b\)\/\(e\)/, `${t}: the lawful basis for keeping it must be named`);
      assert.match(reason!, /severed/, `${t}: the reason must say the identity link is removed, not just that rows are kept`);
      assert.match(reason!, /pseudonym/, `${t}: the reason must say what replaces the identity`);
      assert.match(reason!, /pending legal review \(Q11\(a\)\)/,
        `${t}: the decision requires a defined retention period and there is none yet — the entry must not imply otherwise`);
      assert.ok(POST_BASELINE_TABLES.includes(t),
        `${t} is post-baseline, so the coverage gate only governs it through a hand registration`);
    }
  });
});
