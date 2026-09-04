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
    // Updated deliberately (IG unit I1, migration 2273): the ONE decided
    // retention is the append-only projection history, which carries no actor
    // column at all — it is retained because nothing in it is a person's row,
    // not because a person's row was ruled kept. Any further entry here must
    // come with the same kind of written reason.
    assert.equal(RETAINED_WITH_REASON.length, 1,
      "once retentions are decided, update this expectation deliberately");
    assert.equal(RETAINED_WITH_REASON[0].table, "intel_state_snapshot_versions");
    assert.ok(RETAINED_WITH_REASON[0].reason.length > 40, "a retention needs a reason a user could be shown");
    assert.match(RETAINED_WITH_REASON[0].reason, /no actor column/);
  });
});
