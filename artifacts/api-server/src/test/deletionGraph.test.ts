/**
 * The deletion dependency graph - measured, not asserted.
 *
 * WHAT WOULD MAKE THIS SUITE PASS WITHOUT MEANING ANYTHING, and what stops it:
 *
 *   * A graph over ZERO tables. Every "no table violates X" assertion is
 *     vacuously true over an empty set, so the first tests here assert FLOORS
 *     (the parser must find hundreds of tables, the graph must cover at least
 *     the 248 the coverage gate counts) and the builder itself THROWS on an
 *     empty schema rather than returning [].
 *   * A parser that silently skips statements it cannot match. So the coverage
 *     test re-scans the dump independently and asserts that ZERO public-schema
 *     CREATE POLICY / FOREIGN KEY statements were dropped - not that "most"
 *     were captured.
 *   * A classifier that makes the OWNER_REQUIRED count look good by promoting
 *     undecided tables into confident classes. So there is a FLOOR on
 *     OWNER_REQUIRED and structural invariants that no confident class may
 *     violate (nothing naming a counterparty may be a DELETE_CANDIDATE).
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/deletionGraph.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseSchemaFacts, statements } from "../lib/deletion/schemaFacts.js";
import { buildDeletionGraph, candidateCounts } from "../lib/deletion/graph.js";
import { deletionGraph, BASELINE_SQL_PATH, FIELD_PROVENANCE } from "../lib/deletion/index.js";
import { snapshotNode, SNAPSHOT_PATH } from "../lib/deletion/writeSnapshot.js";
import { classifyCandidate } from "../lib/deletion/candidateClass.js";
import {
  ERASED_BY_CASCADE, UNCLASSIFIED_BACKLOG, ANONYMISED_FK_NULLED, DELETION_FLOW_TABLES,
  DENOMINATOR_CORRECTION_BACKLOG,
} from "../lib/deletionDispositions.js";

const SQL = readFileSync(BASELINE_SQL_PATH, "utf8");

describe("schemaFacts: the parser measures the whole public schema", () => {
  const facts = parseSchemaFacts(SQL);

  it("finds a plausible number of tables, policies and foreign keys", () => {
    assert.ok(facts.size >= 380, `expected >= 380 tables, got ${facts.size}`);
    let fks = 0, policies = 0, rls = 0;
    for (const t of facts.values()) {
      fks += t.foreignKeys.length;
      policies += t.policies.length;
      if (t.rlsEnabled) rls += 1;
    }
    assert.ok(fks >= 600, `expected >= 600 foreign keys, got ${fks}`);
    assert.ok(policies >= 700, `expected >= 700 policies, got ${policies}`);
    assert.ok(rls >= 380, `expected >= 380 tables with RLS enabled, got ${rls}`);
  });

  it("drops NO public-schema policy or foreign key (a silent skip would fake coverage)", () => {
    const seenPolicies = new Set<string>();
    const seenFks = new Set<string>();
    for (const t of facts.values()) {
      for (const p of t.policies) seenPolicies.add(`${t.table}|${p.name}`);
      for (const k of t.foreignKeys) seenFks.add(k.constraint);
    }
    const missedPolicies: string[] = [];
    const missedFks: string[] = [];
    for (const s of statements(SQL)) {
      if (s.startsWith("CREATE POLICY")) {
        const m = /^CREATE POLICY\s+(?:"([^"]+)"|([A-Za-z0-9_]+))\s+ON public\.([A-Za-z0-9_]+)/.exec(s);
        if (!m) continue; // a non-public policy (storage.objects) is out of scope
        if (!seenPolicies.has(`${m[3]}|${m[1] ?? m[2]}`)) missedPolicies.push(s.slice(0, 90));
      }
      if (s.includes("FOREIGN KEY") && /ALTER TABLE (?:ONLY )?public\./.test(s)) {
        const m = /ADD CONSTRAINT ([A-Za-z0-9_]+) FOREIGN KEY/.exec(s);
        if (m && !seenFks.has(m[1])) missedFks.push(m[1]);
      }
    }
    assert.deepEqual(missedPolicies, [], "policies the parser did not capture");
    assert.deepEqual(missedFks, [], "foreign keys the parser did not capture");
  });

  it("reads referential actions and NOT NULL, which the propagation plans depend on", () => {
    const posts = facts.get("posts");
    assert.ok(posts, "posts must be in the baseline");
    const authorFk = posts!.foreignKeys.find((k) => k.columns[0] === "author_id");
    assert.equal(authorFk?.references, "public.profiles");
    assert.equal(authorFk?.onDelete, "CASCADE");
    const createdBy = posts!.foreignKeys.find((k) => k.columns[0] === "created_by");
    assert.equal(createdBy?.onDelete, "NO ACTION", "the NO ACTION references are what block a profiles delete");
  });
});

describe("buildDeletionGraph: vacuity is a failure, not a pass", () => {
  it("THROWS on a schema with no user-keyed tables rather than returning an empty graph", () => {
    assert.throws(
      () => buildDeletionGraph({ sql: "CREATE TABLE public.nothing (\n    id uuid NOT NULL\n);\n" }),
      /ZERO user-keyed tables/,
    );
  });

  it("throws on empty input", () => {
    assert.throws(() => buildDeletionGraph({ sql: "" }), /ZERO user-keyed tables/);
  });
});

describe("the graph over the committed baseline", () => {
  const nodes = deletionGraph();
  const byTable = new Map(nodes.map((n) => [n.table, n]));

  it("covers at least every table the coverage gate counts", () => {
    // 248 was the column-name denominator; the measured one is a superset.
    assert.ok(nodes.length >= 360, `expected >= 360 nodes, got ${nodes.length}`);
    for (const t of [...ERASED_BY_CASCADE, ...ANONYMISED_FK_NULLED, ...DELETION_FLOW_TABLES, ...UNCLASSIFIED_BACKLOG, ...DENOMINATOR_CORRECTION_BACKLOG]) {
      assert.ok(byTable.has(t), `graph is missing manifest table ${t}`);
    }
  });

  it("reproduces the manifest's own counts", () => {
    const fates: Record<string, number> = {};
    for (const n of nodes) fates[n.statedFate] = (fates[n.statedFate] ?? 0) + 1;
    assert.equal(fates.ERASED_BY_CASCADE, ERASED_BY_CASCADE.length);
    // Both backlogs report the same FATE: the rows survive and nobody has ruled.
    // They are separate lists for provenance, not for a different outcome.
    assert.equal(fates.UNCLASSIFIED_BACKLOG, UNCLASSIFIED_BACKLOG.length + DENOMINATOR_CORRECTION_BACKLOG.length);
    assert.equal(fates.NOT_IN_MANIFEST ?? 0, 0,
      "every table in the corrected denominator must be named by some bucket of the manifest");
    assert.equal(fates.ANONYMISED_FK_NULLED, ANONYMISED_FK_NULLED.length);
    assert.equal(fates.DELETION_FLOW, DELETION_FLOW_TABLES.length);
  });

  it("finds the tables the coverage gate cannot see: an FK to a user, no name-listed column", () => {
    const gap = nodes.filter((n) => n.manifestCoverageGap).map((n) => n.table);
    assert.ok(gap.length >= 50, `expected >= 50 coverage-gap tables, got ${gap.length}`);
    // Spot checks with consequences: three of these hold safety or identity
    // evidence and one of them is the tombstone profile itself.
    for (const t of ["blocks", "appeals", "moderation_actions", "reviews", "media_assets", "profiles"]) {
      assert.ok(gap.includes(t), `${t} carries a user FK but no USER_IDENTIFYING_COLUMNS column - expected it in the gap set`);
    }
  });

  it("declares a provenance for every field it emits", () => {
    const declared = new Set(FIELD_PROVENANCE.map((f) => f.field));
    const emitted = new Set<string>();
    for (const n of nodes) for (const k of Object.keys(n)) emitted.add(k);
    const undeclared = [...emitted].filter((k) => !declared.has(k)).sort();
    assert.deepEqual(undeclared, [], "every graph field must declare MEASURED / RULE_DERIVED / HAND");
  });

  it("keeps the propagation mechanism consistent with the measured foreign keys", () => {
    for (const n of nodes) {
      const authCascade = n.userColumns.some((c) => c.references === "auth.users" && c.onDelete === "CASCADE");
      const guarded = n.guardTriggers.length > 0;
      if (guarded) {
        assert.equal(n.propagation.DELETE.mechanism, "REQUIRES_DECLARED_ERASURE", n.table);
      } else if (authCascade) {
        assert.equal(n.propagation.DELETE.mechanism, "AUTH_USER_CASCADE", n.table);
      } else {
        assert.equal(n.propagation.DELETE.mechanism, "EXPLICIT_SCOPED_DELETE", n.table);
      }
    }
  });

  it("says a profiles-CASCADE table still needs an explicit delete (the tombstone defeats the cascade)", () => {
    const messages = byTable.get("messages");
    assert.ok(messages);
    assert.equal(messages!.propagation.DELETE.mechanism, "EXPLICIT_SCOPED_DELETE");
    assert.match(messages!.propagation.DELETE.detail, /TOMBSTONE profile, so that cascade never fires/);
  });

  it("reports NOT NULL as an obstacle to anonymisation instead of pretending a NULL would work", () => {
    const messages = byTable.get("messages")!;
    assert.equal(messages.propagation.ANONYMIZE.mechanism, "SCHEMA_CHANGE_REQUIRED");
    assert.ok(messages.propagation.ANONYMIZE.obstacles.some((o) => /sender_id is NOT NULL/.test(o)));
    assert.ok(
      messages.propagation.ANONYMIZE.obstacles.some((o) => /does not anonymise the row/.test(o)),
      "a message body left beside a nulled sender is not anonymous",
    );
  });

  it("names indefinite retention as an obstacle when nothing else bounds the rows", () => {
    for (const n of nodes) {
      if (!n.retention.governedElsewhere) {
        assert.ok(
          n.propagation.RETAIN.obstacles.some((o) => /INDEFINITE retention/.test(o)),
          `${n.table} retains forever but does not say so`,
        );
      }
    }
  });
});

describe("candidate classes are observations, and OWNER_REQUIRED is not minimised", () => {
  const nodes = deletionGraph();
  const counts = candidateCounts(nodes);

  it("leaves a large, honest OWNER_REQUIRED set", () => {
    assert.ok(counts.OWNER_REQUIRED >= 100, `OWNER_REQUIRED collapsed to ${counts.OWNER_REQUIRED} - the rules have been loosened`);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, nodes.length);
    assert.ok(counts.OWNER_REQUIRED / total >= 0.3, "fewer than 30% undecided would mean the classifier is deciding D6");
  });

  it("never calls a table naming a counterparty a DELETE_CANDIDATE", () => {
    for (const n of nodes) {
      if (n.candidate === "DELETE_CANDIDATE" && n.statedFate !== "ERASED_BY_CASCADE") {
        assert.equal(n.counterpartyColumns.length, 0, `${n.table} names ${n.counterpartyColumns.join(",")}`);
        assert.equal(n.staffColumns.length, 0, `${n.table} names staff ${n.staffColumns.join(",")}`);
        assert.equal(n.ambiguousColumns.length, 0, `${n.table} has ambiguous columns ${n.ambiguousColumns.join(",")}`);
      }
    }
  });

  it("never calls a table with a financial, safety or legal signal a DELETE_CANDIDATE on its own", () => {
    for (const n of nodes) {
      if (n.candidate === "DELETE_CANDIDATE" && n.statedFate !== "ERASED_BY_CASCADE") {
        const blocking = n.signals.filter((s) => ["financial", "moderationSafety", "legalEvidence"].includes(s.key));
        assert.deepEqual(blocking.map((b) => b.key), [], `${n.table}`);
      }
    }
  });

  it("gives every candidate class its evidence", () => {
    for (const n of nodes) assert.ok(n.candidateEvidence.length > 0, `${n.table} has a class with no evidence`);
  });

  it("falls back to OWNER_REQUIRED when the evidence is stripped away", () => {
    const bare = {
      ...nodes[0],
      statedFate: "UNCLASSIFIED_BACKLOG" as const,
      userColumns: [], subjectColumns: [], counterpartyColumns: [], staffColumns: [], ambiguousColumns: [],
      signals: [],
      derivative: { nameSuggestsDerived: false, writtenOnlyByBackground: false, parents: [], derivedFrom: null, staleProjections: [] },
    };
    assert.equal(classifyCandidate(bare).candidate, "OWNER_REQUIRED");
  });

  it("does not turn a cache holding personal data into DERIVED_REBUILDABLE", () => {
    for (const n of nodes) {
      if (n.candidate === "DERIVED_REBUILDABLE") {
        const personal = n.signals.filter((s) =>
          ["preciseLocation", "contact", "identity", "messageContent", "media"].includes(s.key));
        assert.deepEqual(personal.map((p) => p.key), [], `${n.table} is not rebuildable: it holds ${personal.map((p) => p.key).join(",")}`);
        assert.ok(n.derivative.derivedFrom, `${n.table} must name what it is derived from`);
      }
    }
  });
});

describe("the committed snapshot matches the code that produced it", () => {
  it("has the same tables and the same content, table by table", () => {
    const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as { tableCount: number; nodes: Array<{ table: string }> };
    const live = deletionGraph();
    assert.ok(committed.nodes.length >= 248, "the committed snapshot itself must not be vacuous");
    assert.equal(committed.tableCount, committed.nodes.length);
    assert.deepEqual(
      committed.nodes.map((n) => n.table).sort(),
      live.map((n) => n.table).sort(),
      "snapshot is stale - regenerate with: node --import tsx/esm src/lib/deletion/writeSnapshot.ts",
    );
    const committedByTable = new Map(committed.nodes.map((n) => [n.table, n]));
    for (const n of live) {
      assert.deepEqual(
        committedByTable.get(n.table),
        JSON.parse(JSON.stringify(snapshotNode(n))),
        `snapshot drifted for ${n.table} - regenerate with: node --import tsx/esm src/lib/deletion/writeSnapshot.ts`,
      );
    }
  });
});
