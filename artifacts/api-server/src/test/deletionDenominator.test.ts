/**
 * The deletion DENOMINATOR — who is in the universe a legal-surface guard
 * governs, and whether the rule that decides it actually bites.
 *
 * ── WHAT WOULD MAKE THIS SUITE PASS WITHOUT MEANING ANYTHING ────────────────
 *   * Testing the WIRING instead of the RULE. "classifyUserLinks returns a Map"
 *     is true of a function that returns an empty Map. So every mutation below
 *     changes ONE fact in a fixture schema and asserts the classification moves
 *     the way the documented rule says it must — and the negative controls
 *     (drop the FK, an unrelated uuid) assert it moves BACK.
 *   * A denominator that shrank. Every "no table violates X" assertion is
 *     vacuously true over an empty set, so this suite asserts FLOORS against the
 *     committed baseline: the measured universe must be a strict SUPERSET of the
 *     248 tables the column-name heuristic it replaced could find.
 *   * A rule that lives only in a comment. `stripComments` is applied to
 *     userLink.ts before asserting the indirect-ownership rule is stated there,
 *     so a rule deleted from the code cannot be kept alive by its documentation.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/deletionDenominator.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  classifyUserLinks,
  userLinkCounts,
  isOwnershipPreserving,
  INDIRECT_OWNERSHIP_RULE,
  USER_NAME_HINT_RE,
} from "../lib/deletion/userLink.js";
import { parseSchemaFacts } from "../lib/deletion/schemaFacts.js";
import { deletionGraph, baselineUserLinks, baselineUserLinkCounts, assertDenominatorNotShrunk, REPO_ROOT, BASELINE_SQL_PATH } from "../lib/deletion/index.js";
import { stripComments } from "../scripts/lib/stripComments.js";
import {
  userKeyedTablesFromBaseline,
  computeProblems,
  denominatorProblems,
  NAME_HEURISTIC_FLOOR,
  GOVERNED_FLOOR,
} from "../scripts/checkDeletionCoverage.js";
import { USER_IDENTIFYING_COLUMNS, DENOMINATOR_CORRECTION_BACKLOG } from "../lib/deletionDispositions.js";

// ── Fixture schema construction ────────────────────────────────────────────
// Deliberately hand-built pg_dump-shaped text, so a mutation is one edited
// string and not a rebuilt world.

interface Col { name: string; type: string }
interface Fk { name: string; cols: string[]; ref: string; onDelete?: string }

function table(name: string, cols: Col[]): string {
  return `CREATE TABLE public.${name} (\n${cols.map((c) => `    ${c.name} ${c.type}`).join(",\n")}\n);\n\n`;
}
function fk(onTable: string, f: Fk): string {
  return (
    `ALTER TABLE ONLY public.${onTable}\n` +
    `    ADD CONSTRAINT ${f.name} FOREIGN KEY (${f.cols.join(", ")}) REFERENCES ${f.ref}(id)` +
    `${f.onDelete ? ` ON DELETE ${f.onDelete}` : ""};\n\n`
  );
}
/** Every fixture carries the user root, because a schema without one is a different failure. */
const PROFILES = table("profiles", [
  { name: "id", type: "uuid NOT NULL" },
  { name: "display_name", type: "text" },
]);

/** Fixtures never inherit the live manifest: a registration would mask the rule. */
const NO_REGISTRATIONS = new Map<string, string>();
const classify = (sql: string, registrations = NO_REGISTRATIONS) =>
  classifyUserLinks({ sql, registrations });
const classOf = (sql: string, t: string, registrations = NO_REGISTRATIONS) =>
  classify(sql, registrations).get(t)!.linkClass;

describe("MUTATION: the rule follows the FOREIGN KEY, not the column name", () => {
  // The bug this whole change exists to fix: the old denominator matched 18
  // recognised column names, so renaming the column hid the table from a
  // legal-surface guard while the link to the account was untouched.
  const withUserId =
    PROFILES +
    table("audit_rows", [{ name: "id", type: "uuid NOT NULL" }, { name: "user_id", type: "uuid NOT NULL" }]) +
    fk("audit_rows", { name: "audit_rows_user_id_fkey", cols: ["user_id"], ref: "public.profiles", onDelete: "CASCADE" });

  const renamed =
    PROFILES +
    table("audit_rows", [{ name: "id", type: "uuid NOT NULL" }, { name: "actor_ref", type: "uuid NOT NULL" }]) +
    fk("audit_rows", { name: "audit_rows_user_id_fkey", cols: ["actor_ref"], ref: "public.profiles", onDelete: "CASCADE" });

  it("the renamed column is genuinely invisible to the name list (or the mutation proves nothing)", () => {
    assert.ok(USER_IDENTIFYING_COLUMNS.includes("user_id"), "user_id must be a recognised name");
    assert.ok(
      !USER_IDENTIFYING_COLUMNS.includes("actor_ref"),
      "actor_ref must NOT be a recognised name, or this test would pass through the name rule",
    );
  });

  it("user_id -> actor_ref, FK unchanged: STILL DIRECT_USER_LINKED", () => {
    assert.equal(classOf(withUserId, "audit_rows"), "DIRECT_USER_LINKED");
    assert.equal(classOf(renamed, "audit_rows"), "DIRECT_USER_LINKED", "a rename hid a user-linked table from the denominator");
  });

  it("and the reason names the constraint, so a reviewer can check it against the dump", () => {
    const why = classify(renamed).get("audit_rows")!.reasons.join(" ");
    assert.match(why, /FOREIGN KEY audit_rows_user_id_fkey \(actor_ref\) REFERENCES public\.profiles ON DELETE CASCADE/);
  });

  it("the OLD column-name rule misses it — which is the bug, restated as a measurement", () => {
    const facts = parseSchemaFacts(renamed);
    const names = new Set(USER_IDENTIFYING_COLUMNS);
    const nameRuleFinds = facts.get("audit_rows")!.columns.some((c) => names.has(c.name));
    assert.equal(nameRuleFinds, false, "if the name rule can see it, this fixture no longer reproduces the bug");
  });
});

describe("MUTATION: an unrelated uuid with no foreign key is NOT detected", () => {
  // The other direction of the same rule. A denominator that swept in every
  // uuid column would be useless in a different way: nobody would believe it.
  const sql =
    PROFILES +
    table("weather_cache", [
      { name: "id", type: "uuid NOT NULL" },
      { name: "entity_id", type: "uuid" },
      { name: "payload_id", type: "uuid" },
      { name: "temperature_c", type: "numeric" },
    ]);

  it("classifies it NOT_USER_LINKED", () => {
    assert.equal(classOf(sql, "weather_cache"), "NOT_USER_LINKED");
  });

  it("states the reason rather than staying silent about it", () => {
    const why = classify(sql).get("weather_cache")!.reasons;
    assert.ok(why.length > 0, "a NOT_USER_LINKED verdict with no reason cannot be checked");
    assert.match(why.join(" "), /no foreign key to public\.profiles or auth\.users/);
  });

  it("the name-hint rule does not fire on non-person uuid names", () => {
    for (const name of ["entity_id", "payload_id", "id", "item_id", "catalog_id", "trip_id", "post_id"]) {
      assert.equal(USER_NAME_HINT_RE.test(name), false, `${name} must not read as a person reference`);
    }
    for (const name of ["user_a", "subject_user_id", "admin_id", "verified_by", "owner_user_id"]) {
      assert.equal(USER_NAME_HINT_RE.test(name), true, `${name} must read as a person reference`);
    }
  });

  it("a person-named uuid with NO foreign key is AMBIGUOUS, never confidently linked and never dropped", () => {
    const hinted =
      PROFILES +
      table("shadow_ledger", [{ name: "id", type: "uuid NOT NULL" }, { name: "subject_user_id", type: "uuid" }]);
    const f = classify(hinted).get("shadow_ledger")!;
    assert.equal(f.linkClass, "AMBIGUOUS");
    assert.equal(f.governed, true, "AMBIGUOUS must stay inside the denominator: 'we cannot tell' is not 'no'");
    assert.match(f.reasons.join(" "), /named like a person reference but declare no foreign key/);
  });
});

describe("MUTATION: a profiles FK two hops away, through another owned row", () => {
  // The documented graph rule, stated in INDIRECT_OWNERSHIP_RULE and applied
  // mechanically: ownership travels down edges the child cannot outlive.
  const twoHops =
    PROFILES +
    table("trips", [{ name: "id", type: "uuid NOT NULL" }, { name: "owner", type: "uuid NOT NULL" }]) +
    table("trip_stops", [{ name: "id", type: "uuid NOT NULL" }, { name: "trip_id", type: "uuid NOT NULL" }]) +
    table("trip_stop_notes", [{ name: "id", type: "uuid NOT NULL" }, { name: "stop_id", type: "uuid NOT NULL" }]) +
    fk("trips", { name: "trips_owner_fkey", cols: ["owner"], ref: "public.profiles", onDelete: "CASCADE" }) +
    fk("trip_stops", { name: "trip_stops_trip_id_fkey", cols: ["trip_id"], ref: "public.trips", onDelete: "CASCADE" }) +
    fk("trip_stop_notes", { name: "notes_stop_id_fkey", cols: ["stop_id"], ref: "public.trip_stops", onDelete: "CASCADE" });

  it("is INDIRECT_USER_LINKED at hops = 2, with the path it travelled", () => {
    const links = classify(twoHops);
    assert.equal(links.get("trips")!.linkClass, "DIRECT_USER_LINKED");
    assert.equal(links.get("trip_stops")!.linkClass, "INDIRECT_USER_LINKED");
    const notes = links.get("trip_stop_notes")!;
    assert.equal(notes.linkClass, "INDIRECT_USER_LINKED");
    assert.equal(notes.hops, 2, "two ownership hops must be reported as two");
    assert.deepEqual(notes.path, ["trip_stop_notes", "trip_stops", "trips", "public.profiles"]);
    assert.match(notes.reasons.join(" "), /ownership-preserving FOREIGN KEY notes_stop_id_fkey/);
  });

  it("the rule that produced it is stated IN THE SOURCE, not only in a comment", () => {
    const source = readFileSync(resolve(REPO_ROOT, "src/lib/deletion/userLink.ts"), "utf8");
    const code = stripComments(source);
    assert.match(code, /INDIRECT_OWNERSHIP_RULE/, "the rule must exist as code");
    for (const phrase of [
      "ownership-preserving foreign key",
      "cannot exist without the parent row",
      "ON DELETE CASCADE",
      "NOT NULL",
      "hops = 2",
    ]) {
      assert.ok(code.includes(phrase), `the stated rule lost the phrase "${phrase}" once comments were stripped`);
    }
    assert.ok(INDIRECT_OWNERSHIP_RULE.length > 200, "a one-line rule is not a stated rule");
  });

  it("MUTATION: make the middle edge NULLABLE and non-cascading — ownership stops travelling", () => {
    // Same three tables, same shape, one fact changed: trip_stops.trip_id is now
    // optional, so some stops belong to nobody and the parent's owner cannot be
    // said to own them. The rule says AMBIGUOUS, not INDIRECT.
    const loosened =
      PROFILES +
      table("trips", [{ name: "id", type: "uuid NOT NULL" }, { name: "owner", type: "uuid NOT NULL" }]) +
      table("trip_stops", [{ name: "id", type: "uuid NOT NULL" }, { name: "trip_id", type: "uuid" }]) +
      fk("trips", { name: "trips_owner_fkey", cols: ["owner"], ref: "public.profiles", onDelete: "CASCADE" }) +
      fk("trip_stops", { name: "trip_stops_trip_id_fkey", cols: ["trip_id"], ref: "public.trips" });
    const f = classify(loosened).get("trip_stops")!;
    assert.equal(f.linkClass, "AMBIGUOUS");
    assert.equal(f.governed, true, "an unowned-but-reachable table still needs a stated fate");
    assert.match(f.reasons.join(" "), /only\s+through NULLABLE non-cascading foreign key/);
  });

  it("isOwnershipPreserving: CASCADE or NOT NULL, and nothing else", () => {
    const facts = parseSchemaFacts(
      PROFILES +
        table("child", [{ name: "id", type: "uuid NOT NULL" }, { name: "hard", type: "uuid NOT NULL" }, { name: "soft", type: "uuid" }]) +
        fk("child", { name: "child_hard_fkey", cols: ["hard"], ref: "public.profiles" }) +
        fk("child", { name: "child_soft_fkey", cols: ["soft"], ref: "public.profiles" }),
    );
    const child = facts.get("child")!;
    const hard = child.foreignKeys.find((k) => k.constraint === "child_hard_fkey")!;
    const soft = child.foreignKeys.find((k) => k.constraint === "child_soft_fkey")!;
    assert.equal(isOwnershipPreserving(child, hard), true, "NOT NULL means the child cannot outlive the parent");
    assert.equal(isOwnershipPreserving(child, soft), false, "a nullable NO ACTION reference is not ownership");
    assert.equal(isOwnershipPreserving(child, { ...soft, onDelete: "CASCADE" }), true, "CASCADE means the child goes with the parent");
  });
});

describe("MUTATION: drop the foreign key and the classification changes", () => {
  const cols = [{ name: "id", type: "uuid NOT NULL" }, { name: "actor_ref", type: "uuid NOT NULL" }];
  const withFk =
    PROFILES + table("audit_rows", cols) +
    fk("audit_rows", { name: "audit_rows_actor_fkey", cols: ["actor_ref"], ref: "public.profiles", onDelete: "CASCADE" });
  const withoutFk = PROFILES + table("audit_rows", cols);

  it("DIRECT with the constraint, and NOT DIRECT without it", () => {
    assert.equal(classOf(withFk, "audit_rows"), "DIRECT_USER_LINKED");
    const after = classOf(withoutFk, "audit_rows");
    assert.notEqual(after, "DIRECT_USER_LINKED", "the class did not react to the constraint disappearing");
    assert.notEqual(after, "INDIRECT_USER_LINKED");
  });

  it("dropping the FK on an INDIRECT child removes it from the denominator entirely", () => {
    const owned =
      PROFILES +
      table("trips", [{ name: "id", type: "uuid NOT NULL" }, { name: "owner", type: "uuid NOT NULL" }]) +
      table("trip_stops", [{ name: "id", type: "uuid NOT NULL" }, { name: "trip_id", type: "uuid NOT NULL" }]) +
      fk("trips", { name: "trips_owner_fkey", cols: ["owner"], ref: "public.profiles", onDelete: "CASCADE" }) +
      fk("trip_stops", { name: "trip_stops_trip_id_fkey", cols: ["trip_id"], ref: "public.trips", onDelete: "CASCADE" });
    const orphaned =
      PROFILES +
      table("trips", [{ name: "id", type: "uuid NOT NULL" }, { name: "owner", type: "uuid NOT NULL" }]) +
      table("trip_stops", [{ name: "id", type: "uuid NOT NULL" }, { name: "trip_id", type: "uuid NOT NULL" }]) +
      fk("trips", { name: "trips_owner_fkey", cols: ["owner"], ref: "public.profiles", onDelete: "CASCADE" });

    assert.equal(classify(owned).get("trip_stops")!.governed, true);
    const after = classify(orphaned).get("trip_stops")!;
    assert.equal(after.linkClass, "NOT_USER_LINKED");
    assert.equal(after.governed, false, "with no constraint and no name evidence the schema says nothing — and says so");
  });
});

describe("MUTATION: a hand-registered table stays in the universe", () => {
  // A legal-retention row somebody wrote down must not fall out of scope because
  // the schema stopped mentioning it, or the manifest could be emptied by a
  // migration nobody read.
  const bare =
    PROFILES + table("legal_holds", [{ name: "id", type: "uuid NOT NULL" }, { name: "case_ref", type: "text" }]);

  it("without the registration it is NOT_USER_LINKED", () => {
    assert.equal(classOf(bare, "legal_holds"), "NOT_USER_LINKED");
  });

  it("with a RETAINED_WITH_REASON registration it is DERIVED_USER_LINKED and governed", () => {
    const registered = new Map([["legal_holds", "RETAINED_WITH_REASON"]]);
    const f = classify(bare, registered).get("legal_holds")!;
    assert.equal(f.linkClass, "DERIVED_USER_LINKED");
    assert.equal(f.governed, true);
    assert.match(f.reasons.join(" "), /registered by hand in deletionDispositions\.RETAINED_WITH_REASON/);
  });

  it("a post-baseline registration survives even when the table is absent from the dump entirely", () => {
    const links = classifyUserLinks({
      sql: bare,
      extraTables: ["journey_observations"],
      registrations: new Map([["journey_observations", "UNCLASSIFIED_BACKLOG"]]),
    });
    const f = links.get("journey_observations")!;
    assert.equal(f.governed, true, "a live table the dump predates must not vanish from the denominator");
    assert.equal(f.inBaseline, false);
    assert.equal(f.linkClass, "DERIVED_USER_LINKED");
  });

  it("a registration NEVER masks what the schema says: an AMBIGUOUS table stays AMBIGUOUS", () => {
    // Otherwise the class whose job is to keep unconfirmed ownership visible
    // would be emptied by the act of writing the table down.
    const hinted =
      PROFILES + table("shadow_ledger", [{ name: "id", type: "uuid NOT NULL" }, { name: "admin_id", type: "uuid" }]);
    const f = classify(hinted, new Map([["shadow_ledger", "UNCLASSIFIED_BACKLOG"]])).get("shadow_ledger")!;
    assert.equal(f.linkClass, "AMBIGUOUS", "a hand registration promoted an unconfirmed link to a confident class");
    assert.match(f.reasons.join(" "), /registered by hand/);
  });
});

describe("MUTATION: the name and the constraint disagree", () => {
  // A column called `user_id` whose foreign key points at a TRIP is not evidence
  // of an account, and it is not evidence of no account either. The old
  // column-name denominator counted this table; a corrected denominator that
  // dropped it would be a regression wearing the costume of an improvement.
  const sql =
    PROFILES +
    table("trips", [{ name: "id", type: "uuid NOT NULL" }, { name: "owner", type: "uuid NOT NULL" }]) +
    table("odd_rows", [{ name: "id", type: "uuid NOT NULL" }, { name: "user_id", type: "uuid" }]) +
    fk("trips", { name: "trips_owner_fkey", cols: ["owner"], ref: "public.profiles", onDelete: "CASCADE" }) +
    fk("odd_rows", { name: "odd_rows_user_id_fkey", cols: ["user_id"], ref: "public.trips" });

  it("is AMBIGUOUS and stays in the denominator", () => {
    const f = classify(sql).get("odd_rows")!;
    assert.equal(f.linkClass, "AMBIGUOUS");
    assert.equal(f.governed, true, "a table the OLD heuristic counted must never fall out of the new denominator");
    assert.match(f.reasons.join(" "), /the name and the\s+constraint disagree/);
  });

  it("the old heuristic really would have counted it (or the fixture proves nothing)", () => {
    const names = new Set(USER_IDENTIFYING_COLUMNS);
    const cols = parseSchemaFacts(sql).get("odd_rows")!.columns;
    assert.ok(cols.some((c) => names.has(c.name)), "the fixture must carry a recognised column name");
  });
});

describe("MUTATION: the no-shrink rule", () => {
  // Set containment, not arithmetic: a graph that drops five tables and gains
  // six is bigger and still broken.
  it("passes when every name-heuristic table is governed", () => {
    assert.doesNotThrow(() => assertDenominatorNotShrunk(["a", "b"], ["a", "b", "c"]));
  });

  it("THROWS, naming the lost tables, when one is not", () => {
    assert.throws(
      () => assertDenominatorNotShrunk(["a", "b"], ["a", "c", "d", "e"]),
      /1 table\(s\) the column-name heuristic finds are NOT in the measured user-link graph: b/,
    );
  });

  it("is not fooled by a bigger graph that lost a table", () => {
    assert.throws(() => assertDenominatorNotShrunk(["keep", "lost"], ["keep", "x", "y", "z", "w"]), /lost/);
  });

  it("holds over the committed baseline: the measured graph contains the whole old denominator", () => {
    const facts = parseSchemaFacts(readFileSync(BASELINE_SQL_PATH, "utf8"));
    const names = new Set(USER_IDENTIFYING_COLUMNS);
    const isUserFk = (r: string) => r === "public.profiles" || r === "auth.users";
    const heuristic = [...facts.values()]
      .filter((t) => t.columns.some((c) => names.has(c.name)) || t.foreignKeys.some((k) => isUserFk(k.references)))
      .map((t) => t.table);
    assert.ok(heuristic.length >= NAME_HEURISTIC_FLOOR, `the old heuristic found only ${heuristic.length}`);
    assert.doesNotThrow(() => assertDenominatorNotShrunk(heuristic, deletionGraph().map((n) => n.table)));
  });
});

describe("vacuity is a failure, not a pass", () => {
  it("THROWS on an empty schema instead of reporting an empty denominator", () => {
    assert.throws(() => classifyUserLinks({ sql: "" }), /ZERO user-keyed tables/);
  });

  it("THROWS when the schema declares no user root at all", () => {
    assert.throws(
      () => classifyUserLinks({ sql: table("places", [{ name: "id", type: "uuid NOT NULL" }]) }),
      /ZERO user-keyed tables/,
    );
  });

  it("reports a shrunken denominator as a problem rather than a clean run", () => {
    const tiny = classifyUserLinks({
      sql: PROFILES + table("audit_rows", [{ name: "id", type: "uuid NOT NULL" }, { name: "user_id", type: "uuid NOT NULL" }]) +
        fk("audit_rows", { name: "a_fk", cols: ["user_id"], ref: "public.profiles" }),
      registrations: NO_REGISTRATIONS,
    });
    const problems = denominatorProblems(tiny);
    assert.ok(problems.length >= 3, "a two-table universe must trip every floor");
    assert.ok(problems.every((p) => p.kind === "DENOMINATOR SHRANK"));
    assert.ok(
      problems.some((p) => /FEWER than the 248/.test(p.detail)),
      "the floor that matters most is the one the old heuristic already cleared",
    );
  });
});

describe("the corrected denominator over the committed baseline", () => {
  const links = baselineUserLinks();
  const counts = baselineUserLinkCounts();

  it("emits all six machine-readable counts, and they add up", () => {
    for (const k of ["TOTAL_APPLICATION_TABLES", "DIRECT_USER_LINKED", "INDIRECT_USER_LINKED", "DERIVED_USER_LINKED", "NOT_USER_LINKED", "AMBIGUOUS"] as const) {
      assert.equal(typeof counts[k], "number", `${k} must be reported`);
    }
    assert.equal(
      counts.DIRECT_USER_LINKED + counts.INDIRECT_USER_LINKED + counts.DERIVED_USER_LINKED + counts.AMBIGUOUS + counts.NOT_USER_LINKED,
      counts.TOTAL_APPLICATION_TABLES,
      "every application table must land in exactly one class",
    );
    assert.equal(
      counts.GOVERNED,
      counts.TOTAL_APPLICATION_TABLES - counts.NOT_USER_LINKED,
      "the denominator is every class except NOT_USER_LINKED",
    );
  });

  it("is a STRICT SUPERSET of what the column-name heuristic found (the whole point)", () => {
    assert.ok(counts.GOVERNED > NAME_HEURISTIC_FLOOR, `denominator ${counts.GOVERNED} did not grow past ${NAME_HEURISTIC_FLOOR}`);
    assert.ok(counts.GOVERNED >= GOVERNED_FLOOR, `denominator ${counts.GOVERNED} fell below its floor ${GOVERNED_FLOOR}`);
    assert.deepEqual(denominatorProblems(links), []);
  });

  it("brings the tables the old gate could not see into scope, by NAME", () => {
    // Each of these carries a person's uuid behind a foreign key and none of them
    // carries a recognised column name. Three hold safety evidence and one is
    // the tombstone profile itself.
    for (const t of ["blocks", "appeals", "moderation_actions", "reviews", "media_assets", "user_restrictions", "profiles", "user_mutes", "safe_return_contacts", "trip_documents"]) {
      const f = links.get(t);
      assert.ok(f, `${t} is missing from the user-link graph entirely`);
      assert.equal(f!.governed, true, `${t} is still outside the deletion denominator`);
      assert.ok(f!.reasons.length > 0, `${t} is in scope for no stated reason`);
    }
  });

  it("every table — in scope or out — carries a stated reason", () => {
    const silent = [...links.values()].filter((f) => f.reasons.length === 0).map((f) => f.table);
    assert.deepEqual(silent, [], "a classification with no reason cannot be reviewed");
  });

  it("column names never produce a CONFIDENT class on their own", () => {
    // DIRECT and INDIRECT must be reachable only through measured constraints.
    for (const f of links.values()) {
      if (f.linkClass !== "DIRECT_USER_LINKED" && f.linkClass !== "INDIRECT_USER_LINKED") continue;
      const measured = f.reasons.some((r) => /FOREIGN KEY|canonical user root/.test(r));
      assert.ok(measured, `${f.table} is ${f.linkClass} without a measured constraint behind it`);
    }
  });

  it("the 91 correction-backlog tables are exactly the ones the old denominator missed", () => {
    const nameKeyed = new Set<string>();
    const facts = parseSchemaFacts(readFileSync(BASELINE_SQL_PATH, "utf8"));
    const names = new Set(USER_IDENTIFYING_COLUMNS);
    const isUserFk = (r: string) => r === "public.profiles" || r === "auth.users";
    for (const t of facts.values()) {
      if (t.columns.some((c) => names.has(c.name)) || t.foreignKeys.some((k) => isUserFk(k.references))) nameKeyed.add(t.table);
    }
    for (const t of DENOMINATOR_CORRECTION_BACKLOG) {
      assert.ok(links.get(t)?.governed, `${t} is on the correction backlog but not in the denominator`);
    }
    assert.ok(DENOMINATOR_CORRECTION_BACKLOG.length >= 90, "the correction backlog collapsed");
  });

  it("the coverage gate is clean against the corrected denominator", () => {
    const tables = userKeyedTablesFromBaseline(readFileSync(BASELINE_SQL_PATH, "utf8"));
    assert.ok(tables.size >= GOVERNED_FLOOR, `the gate is only governing ${tables.size} tables`);
    assert.deepEqual(computeProblems(tables), []);
  });

  it("the gate STILL bites: a new user-linked table with no stated fate fails it", () => {
    const tables = userKeyedTablesFromBaseline(readFileSync(BASELINE_SQL_PATH, "utf8"));
    tables.set("future_unclassified_table", ["FOREIGN KEY x_fkey (actor_ref) REFERENCES public.profiles ON DELETE CASCADE"]);
    const hit = computeProblems(tables).find((p) => p.table === "future_unclassified_table");
    assert.ok(hit, "the corrected denominator stopped catching new tables");
    assert.equal(hit!.kind, "UNCLASSIFIED NEW TABLE");
    assert.match(hit!.detail, /DENOMINATOR_CORRECTION_BACKLOG either — that list is closed/,
      "the new bucket must not become a second hiding place");
  });

  it("the graph now covers the corrected denominator, and OWNER_REQUIRED grew with it", () => {
    const nodes = deletionGraph();
    assert.equal(nodes.length, counts.GOVERNED, "the graph and the gate must govern the same universe");
    for (const n of nodes) {
      assert.ok(n.userLink, `${n.table} has no user-link fact`);
      assert.equal(n.userLink.governed, true);
    }
    // 148 before the correction, over 334 nodes. Fixing the denominator can only
    // ADD undecided tables; a smaller number here would mean the classifier was
    // quietly deciding D6 for the newcomers.
    const ownerRequired = nodes.filter((n) => n.candidate === "OWNER_REQUIRED").length;
    assert.ok(ownerRequired >= 148, `OWNER_REQUIRED fell to ${ownerRequired}; correcting the denominator must not shrink it`);
  });
});
