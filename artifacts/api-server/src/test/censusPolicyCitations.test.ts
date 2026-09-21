/**
 * A census citation to a policy must point at the definition in force.
 *
 * THE FAILURE, TWICE IN ONE SITTING
 * =================================
 * census-trips TR261 and TR437 said `route_plans` is "owner-only by RLS",
 * citing `0058_trip_flow.sql:29`. Line 29 said exactly that. Line 32, three
 * lines below it in the same file, is `route_plans_member_select`. RLS policies
 * are a UNION — any permissive policy that passes grants the row — so citing
 * the first and stopping is an INVERTED reading, not a partial one. That claim
 * reached shipped code as the reason string on a projection layer served as
 * `no_source`, which is the strongest claim that projection makes about a
 * layer: that nothing in the system produces it.
 *
 * The correction then made the sibling mistake. It re-read the same 2016-era
 * file properly, found that the member policies gate on `role` without
 * checking `status`, and reported that as the present — never opening
 * `2334_route_plan_crew_visibility.sql`, which DROPs and re-CREATEs all three
 * over `authz.is_trip_crew`, a helper that checks acceptance and knows
 * `co_host` and `viewer`.
 *
 * So this guard checks the mechanical precondition for a human to verify a
 * policy claim: the citation names the file that currently defines it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { citedPolicies, judgeCitation } from "../scripts/lib/policyCitations.js";

describe("citedPolicies — conservative on purpose", () => {
  it("finds policy-shaped names in backticks, with the verb ANYWHERE in the name", () => {
    // THE BUG THIS TEST FOUND ON ITS FIRST RUN. The first version of the
    // pattern required the name to END in a policy verb — the 0058-era
    // convention. Every policy migrations 2760-2777 create is named
    // `<table>_select_crew`, with the verb in the middle, so a guard written to
    // catch a census citing a superseded policy would have missed every policy
    // the session that wrote it had created.
    assert.deepEqual(
      citedPolicies("the `route_plans_member_select` and `trip_stages_select_crew` policies"),
      ["route_plans_member_select", "trip_stages_select_crew"],
    );
  });

  it("de-duplicates and lower-cases", () => {
    assert.deepEqual(citedPolicies("`Foo_Select` then `foo_select` again"), ["foo_select"]);
  });

  it("ignores names that are not policy-shaped", () => {
    // A broader pattern sweeps in tables and functions and turns the guard into
    // noise — and a guard that cries wolf gets switched off, after which the
    // real finding comes back. The verb must be a `_`-delimited segment, which
    // is what keeps `trip_plan_items` and `is_trip_crew` out while letting
    // `trip_stages_select_crew` in.
    assert.deepEqual(citedPolicies("`trip_plan_items` and `authz.is_trip_crew` and `route_plans`"), []);
  });

  it("the widened pattern still excludes a name whose verb is not a whole segment", () => {
    // `selection` and `deleted` contain a verb as a SUBSTRING, not a segment.
    assert.deepEqual(citedPolicies("`user_selection_log` and `posts_deleted_at`"), []);
  });

  it("ignores a name that is not in backticks", () => {
    assert.deepEqual(citedPolicies("route_plans_member_select, mentioned in prose"), []);
  });
});

describe("judgeCitation", () => {
  it("a policy created ONCE is not applicable — there is nothing later to miss", () => {
    // The guard's job is not to demand a citation; it is to catch one that has
    // been overtaken.
    assert.deepEqual(judgeCitation("some census text", ["0058_trip_flow.sql"]), { kind: "not_applicable" });
    assert.deepEqual(judgeCitation("some census text", []), { kind: "not_applicable" });
  });

  it("THE ACTUAL DEFECT: superseded, and only the first file is cited", () => {
    const census = "the RLS policy is owner-only (`0058_trip_flow.sql:29`), so the crew cannot read it";
    const v = judgeCitation(census, ["0058_trip_flow.sql", "2334_route_plan_crew_visibility.sql"]);
    assert.equal(v.kind, "stale");
    assert.equal((v as any).last, "2334_route_plan_crew_visibility.sql");
    assert.deepEqual((v as any).chain, ["0058_trip_flow.sql", "2334_route_plan_crew_visibility.sql"]);
  });

  it("superseded, and the CURRENT file is cited, passes", () => {
    const census = "created by `0058_trip_flow.sql` and replaced by 2334_route_plan_crew_visibility.sql";
    assert.deepEqual(
      judgeCitation(census, ["0058_trip_flow.sql", "2334_route_plan_crew_visibility.sql"]),
      { kind: "current", last: "2334_route_plan_crew_visibility.sql" },
    );
  });

  it("it is the LAST creator that must be cited, not any of them", () => {
    // Citing the middle of a three-migration chain is the same defect one step
    // further along.
    const census = "see b.sql";
    const v = judgeCitation(census, ["a.sql", "b.sql", "c.sql"]);
    assert.equal(v.kind, "stale");
    assert.equal((v as any).last, "c.sql");
  });
});

describe("the real corpus — the three citations this guard was written for", () => {
  const census = readFileSync(
    new URL("../../../../docs/architecture/census-trips.md", import.meta.url), "utf8",
  );

  it("census-trips cites the three route policies, and names 2334", () => {
    const cited = citedPolicies(census);
    for (const name of ["route_plans_member_select", "route_stops_member_select", "route_legs_member_select"]) {
      assert.ok(cited.includes(name), `${name} is no longer cited — the corrections were removed`);
      assert.deepEqual(
        judgeCitation(census, ["0058_trip_flow.sql", "2334_route_plan_crew_visibility.sql"]),
        { kind: "current", last: "2334_route_plan_crew_visibility.sql" },
      );
    }
  });

  it("the struck claim is struck, not merely contradicted elsewhere", () => {
    // A correction that leaves the original sentence readable as present tense
    // is not a correction. Both rows carry the strike and the pointer.
    assert.match(census, /~~the RLS policy is owner-only[\s\S]{0,200}~~ — \*\*STRUCK, see §32\*\*/);
    assert.match(census, /~~A trip's crew cannot read the trip's own route plan\.~~ \*\*STRUCK, see §32\*\*/);
  });

  it("§32.5 is withdrawn rather than deleted, because how it was produced is the finding", () => {
    assert.match(census, /### 32\.5 ~~Two things that ARE true about those policies~~ — WITHDRAWN/);
    assert.match(census, /### 32\.6 The correction to the correction/);
  });
});
