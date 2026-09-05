/**
 * Guard for the `.select()` projection shared by the in-memory Supabase doubles.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The doubles used to return the WHOLE seeded fixture row whatever the caller
 * selected, so production code could read a column its own `.select()` never
 * requested: `undefined` against the real database, but green in tests because
 * the fixture supplied it. Measured across the 24 suites that use these doubles,
 * 2,430 of 3,051 returned rows (79%) were carrying columns the caller had not
 * asked for — and not one test noticed.
 *
 * Two properties have to hold together, and the second is the one that keeps
 * this landable:
 *   1. a parseable select really does narrow the row;
 *   2. anything this parser cannot read with certainty falls back to the whole
 *      row. A WRONG projection turns green suites red for no reason, which is
 *      strictly worse than the leak it replaces.
 *
 * The bail cases below are therefore assertions, not omissions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectionKeys, projectRow, applyProjection } from "./helpers/selectProjection.js";

const ROW = {
  id: "p1",
  title: "Sunset",
  join_policy: "approval_required",
  awarded_at: "2026-01-01",
  secret_note: "SECRET hotel room 402",
};

describe("selectProjection — narrows to the selected columns", () => {
  it("keeps only the named columns, and drops everything else", () => {
    const pairs = projectionKeys("id, title");
    assert.notEqual(pairs, null, "a plain comma list must be projectable");
    const out = projectRow(ROW, pairs!);
    assert.deepEqual(out, { id: "p1", title: "Sunset" });
    assert.ok(!("join_policy" in out), "an unselected column must not be present");
    assert.ok(!("secret_note" in out), "an unselected column must not leak through");
  });

  it("tolerates whitespace and newlines the way PostgREST does", () => {
    const out = projectRow(ROW, projectionKeys("  id ,\n   title  ")!);
    assert.deepEqual(out, { id: "p1", title: "Sunset" });
  });

  it("keys an alias by the ALIAS, not the source column", () => {
    // PostgREST returns `earned_at`, never `awarded_at`, for `earned_at:awarded_at`.
    const out = projectRow(ROW, projectionKeys("id, earned_at:awarded_at")!);
    assert.deepEqual(out, { id: "p1", earned_at: "2026-01-01" });
    assert.ok(!("awarded_at" in out), "the source column name must not survive an alias");
  });

  it("leaves a column the row does not carry ABSENT, not undefined", () => {
    // So a deepStrictEqual against a fixture compares the shape it always did.
    const out = projectRow(ROW, projectionKeys("id, nonexistent_column")!);
    assert.deepEqual(out, { id: "p1" });
    assert.ok(!("nonexistent_column" in out));
  });

  it("is the mechanism that would catch a read of an unselected column", () => {
    // The defect this exists for: code selects without `join_policy`, then reads
    // `row.join_policy`. Before projection the fixture supplied it and the bug
    // was invisible; after, it is undefined and the assertion can fail.
    const leaked = ROW; // what the doubles used to return
    assert.equal(leaked.join_policy, "approval_required");
    const projected = projectRow(ROW, projectionKeys("id, title, status")!);
    assert.equal(
      (projected as Record<string, unknown>).join_policy, undefined,
      "a column that was not selected must read as undefined, exactly as PostgREST would",
    );
  });
});

describe("selectProjection — bails to the whole row when it cannot be certain", () => {
  // Each of these MUST return null. A null means "do not project", which is the
  // historical behaviour; guessing here is what would break unrelated suites.
  const bails: Array<[string, string | undefined | null]> = [
    ["star", "*"],
    ["padded star", "   *   "],
    ["no argument", undefined],
    ["null", null],
    ["empty string", ""],
    ["embedded resource", "id, related(a,b)"],
    ["inner join embed", "id, posts!inner(id)"],
    ["aggregate embed", "id, related(count)"],
    ["embed with star", "id, media(*)"],
    ["star inside a list", "id, *"],
    ["quoted identifier", 'id, "weird col"'],
    ["cast", "id, count::int"],
    ["unbalanced parens", "id, related(a,b"],
    ["stray close paren", "id, a)"],
    ["empty element", "id,,title"],
  ];
  for (const [name, select] of bails) {
    it(`${name} → do not project`, () => {
      assert.equal(
        projectionKeys(select as string | undefined), null,
        `${JSON.stringify(select)} must fall back to the whole row rather than be guessed at`,
      );
    });
  }

  it("applyProjection passes rows through untouched when there is no projection", () => {
    const rows = [{ ...ROW }];
    const out = applyProjection(rows, projectionKeys("*"));
    assert.deepEqual(out, rows, "a bail must return the rows exactly as they were");
    assert.equal((out[0] as Record<string, unknown>).secret_note, "SECRET hotel room 402");
  });
});
